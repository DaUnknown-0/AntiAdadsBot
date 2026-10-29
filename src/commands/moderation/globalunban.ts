import { Env } from '../../types/env';
import { DiscordInteraction, InteractionResponse, InteractionResponseType } from '../../types/discord';
import { getOption } from '../index';
import { getGuildsWithGlobalBansEnabled, removeUserFromGlobalBanList } from '../../utils/databaseExtras';
import { getInvokingUserId } from '../../utils/permissions';
import { startBanJob } from '../../durable-objects/BanJob';
import { ephemeralError, rejectUnlessSpecialUser, replyError } from './globalBanShared';

export async function handleGlobalUnban(
  interaction: DiscordInteraction,
  env: Env,
  ctx: ExecutionContext
): Promise<InteractionResponse> {
  const rejection = rejectUnlessSpecialUser(env, interaction, { respectWorkerSwitch: true });
  if (rejection) return rejection;

  const targetUserId = getOption(interaction, 'user');
  const reason = getOption(interaction, 'reason') || 'Global unban';

  if (!targetUserId) {
    return ephemeralError('Please specify a user to globally unban.');
  }

  // Acknowledge within 3s; the BanJob Durable Object unbans in all servers and edits this response
  ctx.waitUntil(
    (async () => {
      try {
        const guilds = await getGuildsWithGlobalBansEnabled(env);

        const listNote = 'User removed from the global ban list.';

        if (guilds.length === 0) {
          await removeUserFromGlobalBanList(env, targetUserId);
          await replyError(interaction, `${listNote}\n\nNo servers have global bans enabled, so nobody was unbanned.`);
          return;
        }

        await startBanJob(env, {
          globalList: { action: 'remove', userIds: [targetUserId] },
          kind: 'unban',
          title: `Global unban for <@${targetUserId}>`,
          targets: guilds.map(guildId => ({ guildId, userIds: [targetUserId] })),
          reason,
          deleteMessageSeconds: 0,
          moderatorId: getInvokingUserId(interaction),
          notes: [listNote],
          interaction: { applicationId: interaction.application_id, token: interaction.token },
        });
      } catch (error) {
        console.error('Error during global unban:', error);
        await replyError(interaction, error instanceof Error ? error.message : 'Could not start global unban.');
      }
    })()
  );

  return {
    type: InteractionResponseType.DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE,
  };
}
