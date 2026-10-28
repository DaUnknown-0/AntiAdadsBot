import { Env } from '../../types/env';
import { DiscordInteraction, InteractionResponse, InteractionResponseType } from '../../types/discord';
import { getOption } from '../index';
import { getGuildsWithGlobalBansEnabled } from '../../utils/databaseExtras';
import { parseUserIds } from '../../utils/banCheck';
import { getInvokingUserId } from '../../utils/permissions';
import { startBanJob } from '../../durable-objects/BanJob';
import { ephemeralError, rejectUnlessSpecialUser, replyError } from './globalBanShared';

export async function handleCheckBans(
  interaction: DiscordInteraction,
  env: Env,
  ctx: ExecutionContext
): Promise<InteractionResponse> {
  const rejection = rejectUnlessSpecialUser(env, interaction);
  if (rejection) return rejection;

  const usersRaw = getOption(interaction, 'users');
  const fileId = getOption(interaction, 'file');
  const serverId = getOption(interaction, 'server');

  if (!usersRaw && !fileId) {
    return ephemeralError('Please provide either a comma-separated list of user IDs or upload a file.');
  }

  // Return deferred response immediately; the BanJob reads the ban lists and edits this response
  ctx.waitUntil(
    (async () => {
      try {
        let userIds: string[] = [];

        // Parse from text input or file
        if (fileId && interaction.data?.resolved?.attachments) {
          const attachment = interaction.data.resolved.attachments[fileId];
          if (attachment && attachment.url) {
            try {
              const response = await fetch(attachment.url);
              userIds = parseUserIds(await response.text());
            } catch (err) {
              console.error('Error fetching attachment:', err);
              await replyError(interaction, 'Failed to read the uploaded file.');
              return;
            }
          }
        } else if (usersRaw) {
          userIds = parseUserIds(usersRaw);
        }

        if (userIds.length === 0) {
          await replyError(interaction, 'No valid user IDs found in the provided input.');
          return;
        }

        // Get guilds to check - either single server or all with global bans enabled
        const singleServer = serverId ? String(serverId).trim() : undefined;
        const guilds = singleServer ? [singleServer] : await getGuildsWithGlobalBansEnabled(env);

        if (guilds.length === 0) {
          await replyError(interaction, 'No servers have global bans enabled.');
          return;
        }

        await startBanJob(env, {
          kind: 'check',
          title: 'Ban status check',
          targets: guilds.map(guildId => ({ guildId, userIds: [] })),
          reason: 'Ban enforcement from checkbans',
          deleteMessageSeconds: 0,
          moderatorId: getInvokingUserId(interaction),
          check: { userIds, variant: 'checkbans', onComplete: 'report', singleServer },
          interaction: { applicationId: interaction.application_id, token: interaction.token },
        });
      } catch (error) {
        console.error('Error during ban check:', error);
        await replyError(interaction, 'An error occurred while checking ban status.');
      }
    })()
  );

  return {
    type: InteractionResponseType.DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE,
  };
}
