import { Env } from '../../types/env';
import { DiscordInteraction, InteractionResponse, InteractionResponseType } from '../../types/discord';
import { editOriginalResponse } from '../../utils/discord';
import { createSuccessEmbed } from '../../utils/logging';
import { getGuildsWithGlobalBansEnabled, getGlobalBanList } from '../../utils/databaseExtras';
import { getInvokingUserId } from '../../utils/permissions';
import { startBanJob } from '../../durable-objects/BanJob';
import { rejectUnlessSpecialUser, replyError } from './globalBanShared';

export async function handleAuditGlobalBans(
  interaction: DiscordInteraction,
  env: Env,
  ctx: ExecutionContext
): Promise<InteractionResponse> {
  const rejection = rejectUnlessSpecialUser(env, interaction);
  if (rejection) return rejection;

  // Return deferred response immediately; the BanJob reads the ban lists and edits this response
  ctx.waitUntil(
    (async () => {
      try {
        const [globalBans, guilds] = await Promise.all([
          getGlobalBanList(env),
          getGuildsWithGlobalBansEnabled(env),
        ]);

        if (globalBans.length === 0) {
          await editOriginalResponse(interaction.application_id, interaction.token, {
            embeds: [createSuccessEmbed('No users found in the global ban list.')],
          });
          return;
        }

        if (guilds.length === 0) {
          await replyError(interaction, 'No servers have global bans enabled.');
          return;
        }

        // Ban lists are read page by page across alarm runs, so neither the number of
        // banned users nor the number of servers is limited by the 50-subrequest budget
        await startBanJob(env, {
          kind: 'check',
          title: 'Global ban audit',
          targets: guilds.map(guildId => ({ guildId, userIds: [] })),
          reason: 'Global ban enforcement from audit',
          deleteMessageSeconds: 0,
          moderatorId: getInvokingUserId(interaction),
          check: { userIds: globalBans.map(b => b.user_id), variant: 'audit', onComplete: 'report' },
          interaction: { applicationId: interaction.application_id, token: interaction.token },
        });
      } catch (error) {
        console.error('Error during global ban audit:', error);
        await replyError(interaction, error instanceof Error ? error.message : 'Could not start audit.');
      }
    })()
  );

  return {
    type: InteractionResponseType.DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE,
  };
}
