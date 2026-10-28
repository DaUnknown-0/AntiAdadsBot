import { Env } from '../../types/env';
import { DiscordInteraction, InteractionResponse, InteractionResponseType, MessageFlags } from '../../types/discord';
import { getOption } from '../index';
import { banUser, mapWithConcurrency, sendFollowupMessage, getGuild } from '../../utils/discord';
import { createModerationCase } from '../../utils/database';
import { logModerationAction } from '../../utils/logging';
import { createErrorEmbed, createSuccessEmbed } from '../../utils/logging';
import { getGuildsWithGlobalBansEnabled } from '../../utils/databaseExtras';
import { updateGuildConfig } from '../../utils/permissions';

function isSpecialUser(env: Env, userId: string): boolean {
  const raw = env.SPECIAL_USER_IDS || '1157902123888037918';
  const ids = raw.split(',').map(s => s.trim()).filter(Boolean);
  return ids.includes(userId);
}

export async function handleGlobalBan(
  interaction: DiscordInteraction,
  env: Env,
  ctx: ExecutionContext
): Promise<InteractionResponse> {
  const invokingId = interaction.member?.user?.id || interaction.user?.id!;

  // Safety: allow disabling global bans on the Cloudflare Worker so a local bot can take over
  if (env.DISABLE_GLOBAL_BAN_WORKER === '1' || env.DISABLE_GLOBAL_BAN_WORKER === 'true') {
    return {
      type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
      data: {
        embeds: [createErrorEmbed('Global bans are disabled on this Worker. Start the local bot to perform this action.')],
        flags: MessageFlags.EPHEMERAL,
      },
    };
  }

  if (!isSpecialUser(env, invokingId)) {
    return {
      type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
      data: {
        embeds: [createErrorEmbed('You are not authorized to use this command.')],
        flags: MessageFlags.EPHEMERAL,
      },
    };
  }

  const targetUserId = getOption(interaction, 'user');
  const reason = getOption(interaction, 'reason') || 'No reason provided';
  const deleteMessages = getOption(interaction, 'delete_messages') || '1';

  if (!targetUserId) {
    return {
      type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
      data: {
        embeds: [createErrorEmbed('Please specify a user to global ban.')],
        flags: MessageFlags.EPHEMERAL,
      },
    };
  }

  // Return deferred response immediately to acknowledge within 3s
  // Then process bans in background and send follow-up when complete
  ctx.waitUntil(
    (async () => {
      try {
        const deleteMessageSeconds = parseInt(deleteMessages) * 86400;
        const moderatorId = invokingId;
        const guilds = await getGuildsWithGlobalBansEnabled(env);

        // The ban endpoint is rate limited per guild, so banning one user across many
        // different guilds hits a separate bucket per request. Only the global ~50 req/s
        // limit applies, so we fan out concurrently. discordRequestWithRetry handles any 429s.
        const CONCURRENCY = 15;

        const results = await mapWithConcurrency<string, { guildId: string; success: boolean; error?: string }>(guilds, CONCURRENCY, async (guildId) => {
          try {
            // Check if bot is in the server first
            const guildInfo = await getGuild(env, guildId);

            if (!guildInfo) {
              // Bot is not in the guild - disable global bans for this server
              await updateGuildConfig(env, guildId, { global_bans_enabled: 0 });
              return { guildId, success: false, error: 'Bot not in server (global bans auto-disabled)' };
            }

            const success = await banUser(env, guildId, targetUserId, reason, deleteMessageSeconds);
            if (success) {
              const caseNumber = await createModerationCase(env, {
                guildId,
                userId: targetUserId,
                moderatorId,
                actionType: 'ban',
                reason,
              });

              ctx.waitUntil(logModerationAction(env, guildId, {
                caseNumber,
                actionType: 'ban',
                userId: targetUserId,
                moderatorId,
                reason,
              }));

              return { guildId, success: true };
            }

            return { guildId, success: false, error: 'API call failed or target has higher permissions' };
          } catch (err: any) {
            return { guildId, success: false, error: err.message || String(err) };
          }
        });

        const successCount = results.filter(r => r.success).length;
        const failCount = results.length - successCount;
        const failures = results.filter(r => !r.success);

        let message = `Global ban complete. Successes: ${successCount}, Failures: ${failCount}`;

        if (failures.length > 0) {
          message += '\n\n**Failed Servers:**';
          failures.forEach(f => {
            message += `\n• Server ID: ${f.guildId}`;
            if (f.error) {
              message += ` - ${f.error}`;
            }
          });
        }

        // Send follow-up message with results
        await sendFollowupMessage(interaction.application_id, interaction.token, {
          embeds: [createSuccessEmbed(message)],
        });
      } catch (error) {
        console.error('Error during global ban:', error);
        // Send error as follow-up
        await sendFollowupMessage(interaction.application_id, interaction.token, {
          embeds: [createErrorEmbed('An error occurred while performing the global ban.')],
        });
      }
    })()
  );

  // Return deferred response immediately
  return {
    type: InteractionResponseType.DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE,
  };
}