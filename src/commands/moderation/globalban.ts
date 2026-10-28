import { Env } from '../../types/env';
import { DiscordInteraction, InteractionResponse, InteractionResponseType } from '../../types/discord';
import { getOption } from '../index';
import { ephemeralError, getDeleteMessageSeconds, rejectUnlessSpecialUser, runGlobalBan } from './globalBanShared';

export async function handleGlobalBan(
  interaction: DiscordInteraction,
  env: Env,
  ctx: ExecutionContext
): Promise<InteractionResponse> {
  const rejection = rejectUnlessSpecialUser(env, interaction, { respectWorkerSwitch: true });
  if (rejection) return rejection;

  const targetUserId = getOption(interaction, 'user');
  const reason = getOption(interaction, 'reason') || 'No reason provided';

  if (!targetUserId) {
    return ephemeralError('Please specify a user to global ban.');
  }

  // Acknowledge within 3s; the BanJob Durable Object does the work and edits this response
  ctx.waitUntil(
    runGlobalBan(env, interaction, [targetUserId], reason, getDeleteMessageSeconds(interaction), 'Global ban')
  );

  return {
    type: InteractionResponseType.DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE,
  };
}
