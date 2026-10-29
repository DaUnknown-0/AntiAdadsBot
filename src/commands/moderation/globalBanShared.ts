import { Env } from '../../types/env';
import { DiscordInteraction, InteractionResponse, InteractionResponseType, MessageFlags } from '../../types/discord';
import { getOption } from '../index';
import { editOriginalResponse } from '../../utils/discord';
import { createErrorEmbed } from '../../utils/logging';
import { addUsersToGlobalBanList, getGuildsWithGlobalBansEnabled } from '../../utils/databaseExtras';
import { getInvokingUserId, isSpecialUser } from '../../utils/permissions';
import { startBanJob } from '../../durable-objects/BanJob';
import { validateJobSize } from '../../utils/jobLimits';

/**
 * Shared helpers for the global ban commands
 */

export function ephemeralError(message: string): InteractionResponse {
  return {
    type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
    data: {
      embeds: [createErrorEmbed(message)],
      flags: MessageFlags.EPHEMERAL,
    },
  };
}

/**
 * Returns an error response if the invoking user may not run a global command, otherwise null
 */
export function rejectUnlessSpecialUser(
  env: Env,
  interaction: DiscordInteraction,
  options: { respectWorkerSwitch?: boolean } = {}
): InteractionResponse | null {
  // Safety: allow disabling global bans on the Cloudflare Worker so a local bot can take over
  if (options.respectWorkerSwitch && (env.DISABLE_GLOBAL_BAN_WORKER === '1' || env.DISABLE_GLOBAL_BAN_WORKER === 'true')) {
    return ephemeralError('Global bans are disabled on this Worker. Start the local bot to perform this action.');
  }

  if (!isSpecialUser(env, getInvokingUserId(interaction))) {
    return ephemeralError('You are not authorized to use this command.');
  }

  return null;
}

/**
 * Read the delete_messages option (days, 0-7) as seconds. Defaults to 1 day, but an explicit 0 is respected.
 */
export function getDeleteMessageSeconds(interaction: DiscordInteraction): number {
  const raw = getOption(interaction, 'delete_messages');
  const days = raw === undefined || raw === null || raw === '' ? 1 : Number(raw);
  const clamped = Number.isFinite(days) ? Math.min(7, Math.max(0, Math.floor(days))) : 1;
  return clamped * 86400;
}

/**
 * Show an error in place of the deferred response
 */
export async function replyError(interaction: DiscordInteraction, message: string): Promise<void> {
  await editOriginalResponse(interaction.application_id, interaction.token, {
    embeds: [createErrorEmbed(message)],
    components: [],
  });
}

/**
 * Add users to the global ban list and start a job that bans them in every enabled guild.
 * Meant to run inside ctx.waitUntil after a deferred response.
 */
export async function runGlobalBan(
  env: Env,
  interaction: DiscordInteraction,
  userIds: string[],
  reason: string,
  deleteMessageSeconds: number,
  title: string
): Promise<void> {
  try {
    const moderatorId = getInvokingUserId(interaction);

    // List update and guild lookup are independent, so run them in parallel
    const guilds = await getGuildsWithGlobalBansEnabled(env);
    validateJobSize(guilds.map(() => ({ userIds })));

    const listNote = `Added ${userIds.length} user(s) to the global ban list.`;

    if (guilds.length === 0) {
      await addUsersToGlobalBanList(env, userIds, reason, moderatorId, deleteMessageSeconds);
      await replyError(interaction, `${listNote}\n\nNo servers have global bans enabled, so nobody was banned.`);
      return;
    }

    await startBanJob(env, {
      globalList: { action: 'add', userIds },
      kind: 'ban',
      title,
      targets: guilds.map(guildId => ({ guildId, userIds })),
      reason,
      deleteMessageSeconds,
      moderatorId,
      notes: [listNote],
      interaction: { applicationId: interaction.application_id, token: interaction.token },
    });
  } catch (error) {
    console.error(`Error starting ${title}:`, error);
    await replyError(interaction, error instanceof Error ? error.message : `Could not start ${title.toLowerCase()}.`);
  }
}
