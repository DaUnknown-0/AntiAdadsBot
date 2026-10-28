import { Env } from '../../types/env';
import { DiscordInteraction, InteractionResponse, InteractionResponseType } from '../../types/discord';
import { getOption } from '../index';
import { parseUserIds } from '../../utils/banCheck';
import { ephemeralError, getDeleteMessageSeconds, rejectUnlessSpecialUser, runGlobalBan } from './globalBanShared';

export async function handleGlobalMassBan(
  interaction: DiscordInteraction,
  env: Env,
  ctx: ExecutionContext
): Promise<InteractionResponse> {
  const rejection = rejectUnlessSpecialUser(env, interaction, { respectWorkerSwitch: true });
  if (rejection) return rejection;

  const usersRaw = getOption(interaction, 'users');
  const reason = getOption(interaction, 'reason') || 'No reason provided';

  if (!usersRaw) {
    return ephemeralError('Please specify at least one user to global ban.');
  }

  const userIds = parseUserIds(usersRaw);
  if (userIds.length === 0) {
    return ephemeralError('No valid user IDs found in the provided input.');
  }

  // Acknowledge within 3s; the BanJob Durable Object bans up to 200 users per server and request
  ctx.waitUntil(
    runGlobalBan(env, interaction, userIds, reason, getDeleteMessageSeconds(interaction), 'Global mass ban')
  );

  return {
    type: InteractionResponseType.DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE,
  };
}
