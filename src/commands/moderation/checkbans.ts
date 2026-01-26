import { Env } from '../../types/env';
import { DiscordInteraction, InteractionResponse, InteractionResponseType, MessageFlags } from '../../types/discord';
import { getOption } from '../index';
import { isUserBanned, sendFollowupMessage } from '../../utils/discord';
import { createErrorEmbed, createSuccessEmbed } from '../../utils/logging';
import { getGuildsWithGlobalBansEnabled } from '../../utils/databaseExtras';

function isSpecialUser(env: Env, userId: string): boolean {
  const raw = env.SPECIAL_USER_IDS || '1157902123888037918';
  const ids = raw.split(',').map(s => s.trim()).filter(Boolean);
  return ids.includes(userId);
}

function parseUsersList(raw: string): string[] {
  return raw
    .split(/[,\s]+/)
    .map(s => s.replace(/[<@!>]/g, '').trim())
    .filter(Boolean);
}

export async function handleCheckBans(
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

  const usersRaw = getOption(interaction, 'users');
  const fileId = getOption(interaction, 'file');
  const serverId = getOption(interaction, 'server');

  if (!usersRaw && !fileId) {
    return {
      type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
      data: {
        embeds: [createErrorEmbed('Please provide either a comma-separated list of user IDs or upload a file.')],
        flags: MessageFlags.EPHEMERAL,
      },
    };
  }

  // Return deferred response immediately
  ctx.waitUntil(
    (async () => {
      try {
        let userIds: string[] = [];

        // Parse from text input or file
        if (fileId && interaction.data?.resolved?.attachments) {
          const attachment = interaction.data.resolved.attachments[fileId];
          if (attachment && attachment.url) {
            try {
              const response = await fetch(attachment.url);
              const text = await response.text();

              // Parse file content (supports both newline and comma-separated)
              userIds = text
                .split(/[\n,\s]+/)
                .map(s => s.replace(/[<@!>]/g, '').trim())
                .filter(Boolean);
            } catch (err) {
              console.error('Error fetching attachment:', err);
              await sendFollowupMessage(interaction.application_id, interaction.token, {
                embeds: [createErrorEmbed('Failed to read the uploaded file.')],
              });
              return;
            }
          }
        } else if (usersRaw) {
          userIds = parseUsersList(usersRaw);
        }

        if (userIds.length === 0) {
          await sendFollowupMessage(interaction.application_id, interaction.token, {
            embeds: [createErrorEmbed('No valid user IDs found in the provided input.')],
          });
          return;
        }

        // Get guilds to check - either single server or all with global bans enabled
        let guilds: string[];
        let isSingleServer = false;

        if (serverId) {
          // Single server mode
          guilds = [serverId];
          isSingleServer = true;
        } else {
          guilds = await getGuildsWithGlobalBansEnabled(env);

          if (guilds.length === 0) {
            await sendFollowupMessage(interaction.application_id, interaction.token, {
              embeds: [createErrorEmbed('No servers have global bans enabled.')],
            });
            return;
          }
        }

        // Track which servers each user is NOT banned in
        const missingBans: Map<string, string[]> = new Map(); // userId -> [guildIds where NOT banned]
        const banCheckResults: { userId: string; bannedCount: number; totalServers: number; missingGuilds: string[] }[] = [];

        // Cloudflare Workers has a HARD limit of ~50 subrequests per invocation
        // We need to stay well under this (leaving room for other API calls)
        const MAX_CHECKS = 40;
        const maxChecks = userIds.length * guilds.length;

        if (maxChecks > MAX_CHECKS) {
          const maxUsers = Math.floor(MAX_CHECKS / guilds.length);
          await sendFollowupMessage(interaction.application_id, interaction.token, {
            embeds: [createErrorEmbed(
              `Too many checks required (${userIds.length} users × ${guilds.length} servers = ${maxChecks} API calls).\n\n` +
              `**Cloudflare Workers limit: ~50 API calls per request.**\n\n` +
              `With ${guilds.length} servers, you can check at most **${maxUsers} users** at a time.\n\n` +
              `For bulk checking, use \`/auditglobalbans\` which checks users already in the global ban list, or split your list into smaller batches.`
            )],
          });
          return;
        }

        // Check ban status for each user across all guilds with controlled concurrency
        for (const userId of userIds) {
          let bannedCount = 0;
          const userMissingGuilds: string[] = [];

          // Use Promise.all for parallel checks but limit concurrency to avoid timeout
          const MAX_CONCURRENT = 10;
          for (let i = 0; i < guilds.length; i += MAX_CONCURRENT) {
            const chunk = guilds.slice(i, i + MAX_CONCURRENT);
            const results = await Promise.allSettled(
              chunk.map(guildId =>
                isUserBanned(env, guildId, userId)
                  .then(isBanned => ({ guildId, isBanned }))
                  .catch(() => ({ guildId, isBanned: false }))
              )
            );

            for (const result of results) {
              if (result.status === 'fulfilled') {
                const { guildId, isBanned } = result.value;
                if (isBanned) {
                  bannedCount++;
                } else {
                  userMissingGuilds.push(guildId);
                }
              } else {
                // If promise rejected, assume not banned
                console.error('Ban check failed:', result.reason);
              }
            }
          }

          banCheckResults.push({
            userId,
            bannedCount,
            totalServers: guilds.length,
            missingGuilds: userMissingGuilds,
          });

          if (userMissingGuilds.length > 0) {
            missingBans.set(userId, userMissingGuilds);
          }
        }

        // Build response message
        let message = `**Ban Status Check Complete**\n\n`;
        if (isSingleServer) {
          message += `Checked ${userIds.length} user(s) in server \`${serverId}\`.\n\n`;
        } else {
          message += `Checked ${userIds.length} user(s) across ${guilds.length} server(s) with global bans enabled.\n\n`;
        }

        let components = undefined;

        if (missingBans.size === 0) {
          message += `✅ All users are banned in all servers.`;
        } else {
          message += `⚠️ **Users not fully banned:**\n`;
          for (const result of banCheckResults) {
            if (result.missingGuilds.length > 0) {
              message += `• <@${result.userId}> (${result.userId}): Banned in ${result.bannedCount}/${result.totalServers} servers\n`;
            }
          }

          // Store pending action in database with the mapping of users to missing guilds
          const actionId = crypto.randomUUID();
          const missingBansObj: Record<string, string[]> = {};
          missingBans.forEach((guildIds, oderId) => {
            missingBansObj[oderId] = guildIds;
          });

          await env.DB.prepare(
            `INSERT INTO pending_ban_actions (id, user_ids, reason, delete_messages, requested_by) VALUES (?, ?, ?, ?, ?)`
          ).bind(
            actionId,
            JSON.stringify(missingBansObj), // Now stores {userId: [missingGuildIds]} instead of just [userIds]
            'Ban enforcement from checkbans',
            0,
            invokingId
          ).run();

          const totalMissingBans = Array.from(missingBans.values()).reduce((sum, arr) => sum + arr.length, 0);
          message += `\n**Click the button below to ban these ${missingBans.size} user(s) in the ${totalMissingBans} server(s) where they are not banned.**`;

          // Add button component
          components = [
            {
              type: 1, // Action Row
              components: [
                {
                  type: 2, // Button
                  style: 4, // Danger (red)
                  label: `Ban ${missingBans.size} User${missingBans.size > 1 ? 's' : ''} (${totalMissingBans} bans)`,
                  custom_id: `checkban_${actionId}`,
                  emoji: {
                    name: '🔨'
                  }
                }
              ]
            }
          ];
        }

        await sendFollowupMessage(interaction.application_id, interaction.token, {
          embeds: [createSuccessEmbed(message)],
          components,
        });
      } catch (error) {
        console.error('Error during ban check:', error);
        await sendFollowupMessage(interaction.application_id, interaction.token, {
          embeds: [createErrorEmbed('An error occurred while checking ban status.')],
        });
      }
    })()
  );

  return {
    type: InteractionResponseType.DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE,
  };
}
