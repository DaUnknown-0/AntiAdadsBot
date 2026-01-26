import { Env } from '../../types/env';
import { DiscordInteraction, InteractionResponse, InteractionResponseType, MessageFlags } from '../../types/discord';
import { isUserBanned, sendFollowupMessage } from '../../utils/discord';
import { createErrorEmbed, createSuccessEmbed } from '../../utils/logging';
import { getGuildsWithGlobalBansEnabled, getGlobalBanList } from '../../utils/databaseExtras';

function isSpecialUser(env: Env, userId: string): boolean {
  const raw = env.SPECIAL_USER_IDS || '1157902123888037918';
  const ids = raw.split(',').map(s => s.trim()).filter(Boolean);
  return ids.includes(userId);
}

export async function handleAuditGlobalBans(
  interaction: DiscordInteraction,
  env: Env,
  ctx: ExecutionContext
): Promise<InteractionResponse> {
  const invokingId = interaction.member?.user?.id || interaction.user?.id!;

  if (!isSpecialUser(env, invokingId)) {
    return {
      type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
      data: {
        embeds: [createErrorEmbed('You are not authorized to use this command.')],
        flags: MessageFlags.EPHEMERAL,
      },
    };
  }

  // Return deferred response immediately
  ctx.waitUntil(
    (async () => {
      try {
        // Get all users in global ban list
        const globalBans = await getGlobalBanList(env);

        if (globalBans.length === 0) {
          await sendFollowupMessage(interaction.application_id, interaction.token, {
            embeds: [createSuccessEmbed('No users found in the global ban list.')],
          });
          return;
        }

        // Get all servers with global bans enabled
        const guilds = await getGuildsWithGlobalBansEnabled(env);

        if (guilds.length === 0) {
          await sendFollowupMessage(interaction.application_id, interaction.token, {
            embeds: [createErrorEmbed('No servers have global bans enabled.')],
          });
          return;
        }

        const notFullyBannedUsers = new Map<string, { userId: string; bannedIn: number; missingIn: number; reason: string | null }>();

        // Cloudflare Workers has a HARD limit of ~50 subrequests per invocation
        // We need to stay well under this (leaving room for other API calls)
        const MAX_CHECKS = 40;
        const maxChecks = globalBans.length * guilds.length;

        if (maxChecks > MAX_CHECKS) {
          const maxBannedUsers = Math.floor(MAX_CHECKS / guilds.length);
          await sendFollowupMessage(interaction.application_id, interaction.token, {
            embeds: [createErrorEmbed(
              `Too many checks required (${globalBans.length} banned users × ${guilds.length} servers = ${maxChecks} API calls).\n\n` +
              `**Cloudflare Workers limit: ~50 API calls per request.**\n\n` +
              `With ${guilds.length} servers, you can audit at most **${maxBannedUsers} users** at a time.\n\n` +
              `**Use the hourly scheduled endpoint instead** - it processes users in small batches over multiple invocations:\n` +
              `\`POST /scheduled/check-global-bans\``
            )],
          });
          return;
        }

        // Check each globally banned user across all servers
        for (const ban of globalBans) {
          let bannedCount = 0;

          for (const guildId of guilds) {
            try {
              const isBanned = await isUserBanned(env, guildId, ban.user_id);
              if (isBanned) {
                bannedCount++;
              }
            } catch (err: any) {
              console.error(`Error checking ban status for ${ban.user_id} in ${guildId}:`, err);
              // Continue checking other guilds
            }
          }

          // If user is not banned in ALL servers, add to list
          if (bannedCount < guilds.length) {
            notFullyBannedUsers.set(ban.user_id, {
              userId: ban.user_id,
              bannedIn: bannedCount,
              missingIn: guilds.length - bannedCount,
              reason: ban.reason,
            });
          }
        }

        // Build response
        let message = `**Global Ban Audit Complete**\n\n`;
        message += `Checked ${globalBans.length} globally banned user(s) across ${guilds.length} server(s).\n\n`;

        let components = undefined;

        if (notFullyBannedUsers.size === 0) {
          message += `✅ All globally banned users are properly banned in all servers!`;
        } else {
          message += `⚠️ **Found ${notFullyBannedUsers.size} user(s) not fully banned:**\n\n`;

          let count = 0;
          for (const [userId, info] of notFullyBannedUsers) {
            count++;
            if (count <= 20) {
              message += `• <@${userId}> (\`${userId}\`)\n`;
              message += `  └ Banned in ${info.bannedIn}/${guilds.length} servers (missing ${info.missingIn})\n`;
              if (info.reason) {
                const shortReason = info.reason.length > 60 ? info.reason.substring(0, 60) + '...' : info.reason;
                message += `  └ Reason: ${shortReason}\n`;
              }
            }
          }

          if (notFullyBannedUsers.size > 20) {
            message += `\n... and ${notFullyBannedUsers.size - 20} more users\n`;
          }

          // Store pending action in database
          const actionId = crypto.randomUUID();
          await env.DB.prepare(
            `INSERT INTO pending_ban_actions (id, user_ids, reason, delete_messages, requested_by) VALUES (?, ?, ?, ?, ?)`
          ).bind(
            actionId,
            JSON.stringify(Array.from(notFullyBannedUsers.keys())),
            'Global ban enforcement from audit',
            0,
            invokingId
          ).run();

          message += `\n**Click the button below to enforce bans for all ${notFullyBannedUsers.size} user(s).**`;

          // Add button component
          components = [
            {
              type: 1, // Action Row
              components: [
                {
                  type: 2, // Button
                  style: 4, // Danger (red)
                  label: `Enforce Bans for ${notFullyBannedUsers.size} User${notFullyBannedUsers.size > 1 ? 's' : ''}`,
                  custom_id: `global_ban_${actionId}`,
                  emoji: {
                    name: '⚠️'
                  }
                }
              ]
            }
          ];
        }

        await sendFollowupMessage(interaction.application_id, interaction.token, {
          embeds: [notFullyBannedUsers.size === 0 ? createSuccessEmbed(message) : createErrorEmbed(message)],
          components,
        });
      } catch (error) {
        console.error('Error during global ban audit:', error);
        await sendFollowupMessage(interaction.application_id, interaction.token, {
          embeds: [createErrorEmbed('An error occurred while auditing global bans.')],
        });
      }
    })()
  );

  return {
    type: InteractionResponseType.DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE,
  };
}
