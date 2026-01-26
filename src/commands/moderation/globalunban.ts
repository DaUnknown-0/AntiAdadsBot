import { Env } from '../../types/env';
import { DiscordInteraction, InteractionResponse, InteractionResponseType, MessageFlags } from '../../types/discord';
import { getOption } from '../index';
import { unbanUser, sleep, sendFollowupMessage, getGuild } from '../../utils/discord';
import { createErrorEmbed, createSuccessEmbed } from '../../utils/logging';
import { getGuildsWithGlobalBansEnabled } from '../../utils/databaseExtras';
import { updateGuildConfig } from '../../utils/permissions';

function isSpecialUser(env: Env, userId: string): boolean {
  const raw = env.SPECIAL_USER_IDS || '1157902123888037918';
  const ids = raw.split(',').map(s => s.trim()).filter(Boolean);
  return ids.includes(userId);
}

export async function handleGlobalUnban(
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
  const reason = getOption(interaction, 'reason') || 'Global unban';

  if (!targetUserId) {
    return {
      type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
      data: {
        embeds: [createErrorEmbed('Please specify a user to globally unban.')],
        flags: MessageFlags.EPHEMERAL,
      },
    };
  }

  // Return deferred response immediately to acknowledge within 3s
  // Then process unbans in background and send follow-up when complete
  ctx.waitUntil(
    (async () => {
      try {
        const moderatorId = invokingId;

        // Step 1: Remove user from global ban list
        const deleteResult = await env.DB.prepare(
          'DELETE FROM global_bans WHERE user_id = ?'
        ).bind(targetUserId).run();

        const removedCount = deleteResult.meta.changes;

        // Step 2: Get all guilds with global bans enabled and unban the user
        const guilds = await getGuildsWithGlobalBansEnabled(env);
        const results: { guildId: string; success: boolean; error?: string }[] = [];

        const DELAY_MS = 1500; // Discord allows ~5 unbans per 5 seconds per guild

        for (const guildId of guilds) {
          try {
            // Check if bot is in the server first
            const guildInfo = await getGuild(env, guildId);

            if (!guildInfo) {
              // Bot is not in the guild - disable global bans for this server
              await updateGuildConfig(env, guildId, { global_bans_enabled: 0 });
              results.push({ guildId, success: false, error: 'Bot not in server (global bans auto-disabled)' });
            } else {
              const success = await unbanUser(env, guildId, targetUserId, reason);
              if (success) {
                results.push({ guildId, success: true });
              } else {
                // User might not have been banned in this server, which is fine
                results.push({ guildId, success: false, error: 'User was not banned or unban failed' });
              }
            }
          } catch (err: any) {
            results.push({ guildId, success: false, error: err.message || String(err) });
          }

          // Wait a bit between guild unbans to avoid hitting rate limits
          await sleep(DELAY_MS);
        }

        const successCount = results.filter(r => r.success).length;
        const failCount = results.length - successCount;
        const failures = results.filter(r => !r.success);

        let message = `Global unban complete for user <@${targetUserId}>.\n\n`;
        message += `Removed ${removedCount} record(s) from global ban list.\n`;
        message += `Unbanned from ${successCount} server(s), Failed: ${failCount}`;

        if (failures.length > 0 && failures.length <= 10) {
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
        console.error('Error during global unban:', error);
        // Send error as follow-up
        await sendFollowupMessage(interaction.application_id, interaction.token, {
          embeds: [createErrorEmbed('An error occurred while performing the global unban.')],
        });
      }
    })()
  );

  // Return deferred response immediately
  return {
    type: InteractionResponseType.DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE,
  };
}
