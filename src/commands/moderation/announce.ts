import { Env } from '../../types/env';
import { DiscordInteraction, InteractionResponse, InteractionResponseType, DiscordEmbed } from '../../types/discord';
import { getOption } from '../index';
import { getGuildsWithGlobalBansEnabled } from '../../utils/databaseExtras';
import { getInvokingUserId } from '../../utils/permissions';
import { startBanJob } from '../../durable-objects/BanJob';
import { ephemeralError, rejectUnlessSpecialUser, replyError } from './globalBanShared';

export async function handleAnnounce(
  interaction: DiscordInteraction,
  env: Env,
  ctx: ExecutionContext
): Promise<InteractionResponse> {
  const rejection = rejectUnlessSpecialUser(env, interaction);
  if (rejection) return rejection;

  const title = getOption(interaction, 'title');
  const message = getOption(interaction, 'message');

  if (!title || !message) {
    return ephemeralError('Please provide both a title and message for the announcement.');
  }

  // Create announcement embed
  const announcementEmbed: DiscordEmbed = {
    title: `📢 ${title}`.slice(0, 256),
    description: String(message).slice(0, 4096),
    color: 0x5865F2, // Discord Blurple
    timestamp: new Date().toISOString(),
    footer: {
      text: 'System Announcement',
    },
  };

  // Return deferred response immediately; the BanJob sends one message per server in batches
  ctx.waitUntil(
    (async () => {
      try {
        const guilds = await getGuildsWithGlobalBansEnabled(env);

        if (guilds.length === 0) {
          await replyError(interaction, 'No servers have global bans enabled.');
          return;
        }

        await startBanJob(env, {
          kind: 'announce',
          title: 'Announcement',
          targets: guilds.map(guildId => ({ guildId, userIds: [] })),
          reason: '',
          deleteMessageSeconds: 0,
          moderatorId: getInvokingUserId(interaction),
          announcement: announcementEmbed,
          interaction: { applicationId: interaction.application_id, token: interaction.token },
        });
      } catch (error) {
        console.error('Error during announcement:', error);
        await replyError(interaction, error instanceof Error ? error.message : 'Could not start announcement.');
      }
    })()
  );

  return {
    type: InteractionResponseType.DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE,
  };
}
