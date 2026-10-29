import { Env } from '../../types/env';
import { DiscordInteraction, InteractionResponse, InteractionResponseType, MessageFlags } from '../../types/discord';
import { createErrorEmbed, createInfoEmbed } from '../../utils/logging';
import { getGuildsWithGlobalBansEnabled } from '../../utils/databaseExtras';
import { invertMissingBans } from '../../utils/banCheck';
import { getInvokingUserId, isSpecialUser } from '../../utils/permissions';
import { startBanJob } from '../../durable-objects/BanJob';
import { replyError } from './globalBanShared';

export async function handleButtonInteraction(
  interaction: DiscordInteraction,
  env: Env,
  ctx: ExecutionContext
): Promise<InteractionResponse> {
  const customId = interaction.data?.custom_id || '';

  // checkban_ comes from /checkbans, global_ban_ from /auditglobalbans. Both now store
  // {userId: [guildIds where NOT banned]} and only ban where a ban is actually missing.
  for (const prefix of ['checkban_', 'global_ban_']) {
    if (customId.startsWith(prefix)) {
      return handleEnforceBansButton(interaction, env, ctx, customId.slice(prefix.length));
    }
  }

  // Unknown button
  return {
    type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
    data: {
      embeds: [createErrorEmbed('Unknown button interaction.')],
      flags: MessageFlags.EPHEMERAL,
    },
  };
}

async function handleEnforceBansButton(
  interaction: DiscordInteraction,
  env: Env,
  ctx: ExecutionContext,
  actionId: string
): Promise<InteractionResponse> {
  const invokingId = getInvokingUserId(interaction);

  // Verify user has special permissions
  if (!isSpecialUser(env, invokingId)) {
    return {
      type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
      data: {
        embeds: [createErrorEmbed('You are not authorized to use this button.')],
        flags: MessageFlags.EPHEMERAL,
      },
    };
  }

  // Claim the pending action atomically so a double click cannot start two jobs
  const action = await env.DB.prepare(
    `UPDATE pending_ban_actions SET claim_until = ?, claim_token = ? WHERE id = ? AND expires_at > datetime('now') AND claim_until < ? RETURNING user_ids, reason, delete_messages`
  ).bind(Date.now() + 60000, interaction.id, actionId, Date.now()).first<{ user_ids: string; reason: string | null; delete_messages: number }>();

  if (!action) {
    return {
      type: InteractionResponseType.UPDATE_MESSAGE,
      data: {
        embeds: [createErrorEmbed('This action has expired or does not exist.')],
        components: [],
      },
    };
  }

  ctx.waitUntil(
    (async () => {
      try {
        const stored = JSON.parse(action.user_ids) as Record<string, string[]> | string[];

        // Older audit buttons stored a plain user list: ban those users in every enabled server
        let missingBans: Record<string, string[]>;
        if (Array.isArray(stored)) {
          const guilds = await getGuildsWithGlobalBansEnabled(env);
          missingBans = Object.fromEntries(stored.map(userId => [userId, guilds]));
        } else {
          missingBans = stored;
        }

        const byGuild = invertMissingBans(missingBans);

        await startBanJob(env, {
          requestKey: `pending:${actionId}`,
          kind: 'ban',
          title: 'Ban enforcement',
          targets: [...byGuild.entries()].map(([guildId, userIds]) => ({ guildId, userIds })),
          reason: action.reason || 'Global ban enforcement',
          deleteMessageSeconds: (action.delete_messages || 0) * 86400,
          moderatorId: invokingId,
          interaction: { applicationId: interaction.application_id, token: interaction.token },
        });
        await env.DB.prepare('DELETE FROM pending_ban_actions WHERE id = ? AND claim_token = ?').bind(actionId, interaction.id).run();
      } catch (error) {
        await env.DB.prepare('UPDATE pending_ban_actions SET claim_until = 0, claim_token = NULL WHERE id = ? AND claim_token = ?').bind(actionId, interaction.id).run();
        console.error('Error starting ban enforcement:', error);
        await replyError(interaction, error instanceof Error ? error.message : 'Could not start enforcement.');
      }
    })()
  );

  // Return immediate acknowledgment; the BanJob edits this message with progress and results
  return {
    type: InteractionResponseType.UPDATE_MESSAGE,
    data: {
      embeds: [createInfoEmbed('🔄 In progress', 'Processing bans in missing servers... This may take a moment.')],
      components: [],
    },
  };
}
