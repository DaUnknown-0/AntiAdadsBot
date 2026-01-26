import { Env } from '../../types/env';
import { DiscordInteraction, InteractionResponse, InteractionResponseType, MessageFlags } from '../../types/discord';
import { banUser, sleep, sendFollowupMessage, getGuild } from '../../utils/discord';
import { createModerationCase } from '../../utils/database';
import { logModerationAction } from '../../utils/logging';
import { createErrorEmbed, createSuccessEmbed } from '../../utils/logging';
import { getGuildsWithGlobalBansEnabled, addUsersToGlobalBanQueue } from '../../utils/databaseExtras';
import { updateGuildConfig } from '../../utils/permissions';

function isSpecialUser(env: Env, userId: string): boolean {
  const raw = env.SPECIAL_USER_IDS || '1157902123888037918';
  const ids = raw.split(',').map(s => s.trim()).filter(Boolean);
  return ids.includes(userId);
}

export async function handleButtonInteraction(
  interaction: DiscordInteraction,
  env: Env,
  ctx: ExecutionContext
): Promise<InteractionResponse> {
  const customId = interaction.data?.custom_id || '';
  const invokingId = interaction.member?.user?.id || interaction.user?.id!;

  // Check if this is a checkban button (only ban in missing servers)
  if (customId.startsWith('checkban_')) {
    return handleCheckbanButton(interaction, env, ctx, customId, invokingId);
  }

  // Check if this is a global ban button (ban in ALL servers - from auditglobalbans)
  if (customId.startsWith('global_ban_')) {
    return handleGlobalBanButton(interaction, env, ctx, customId, invokingId);
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

/**
 * Handle checkban button - only ban users in servers where they're NOT already banned
 */
async function handleCheckbanButton(
  interaction: DiscordInteraction,
  env: Env,
  ctx: ExecutionContext,
  customId: string,
  invokingId: string
): Promise<InteractionResponse> {
  // Verify user has special permissions
  if (!isSpecialUser(env, invokingId)) {
    return {
      type: InteractionResponseType.UPDATE_MESSAGE,
      data: {
        embeds: [createErrorEmbed('You are not authorized to use this button.')],
        components: [],
        flags: MessageFlags.EPHEMERAL,
      },
    };
  }

  const actionId = customId.replace('checkban_', '');

  // Get pending action from database
  const action = await env.DB.prepare(
    `SELECT * FROM pending_ban_actions WHERE id = ? AND expires_at > datetime('now')`
  ).bind(actionId).first<{
    id: string;
    user_ids: string;
    reason: string | null;
    delete_messages: number;
    requested_by: string;
  }>();

  if (!action) {
    return {
      type: InteractionResponseType.UPDATE_MESSAGE,
      data: {
        embeds: [createErrorEmbed('This action has expired or does not exist.')],
        components: [],
      },
    };
  }

  // Verify the user who clicked is the one who requested or is special user
  if (action.requested_by !== invokingId && !isSpecialUser(env, invokingId)) {
    return {
      type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
      data: {
        embeds: [createErrorEmbed('Only the user who initiated the check or special users can execute this action.')],
        flags: MessageFlags.EPHEMERAL,
      },
    };
  }

  // Delete the pending action so button can't be clicked twice
  await env.DB.prepare('DELETE FROM pending_ban_actions WHERE id = ?').bind(actionId).run();

  // Update message to show processing
  ctx.waitUntil(
    (async () => {
      try {
        // Parse the mapping: {userId: [guildIds where NOT banned]}
        const missingBans = JSON.parse(action.user_ids) as Record<string, string[]>;
        const reason = action.reason || 'Ban enforcement from checkbans';
        const deleteMessageSeconds = action.delete_messages * 86400;
        const moderatorId = invokingId;

        const results: { userId: string; guildId: string; success: boolean; error?: string }[] = [];
        const DELAY_MS = 1500;

        // Process each user and their specific missing guilds
        for (const [userId, guildIds] of Object.entries(missingBans)) {
          for (const guildId of guildIds) {
            try {
              const success = await banUser(env, guildId, userId, reason, deleteMessageSeconds);
              if (success) {
                const caseNumber = await createModerationCase(env, {
                  guildId,
                  userId,
                  moderatorId,
                  actionType: 'ban',
                  reason,
                });

                ctx.waitUntil(logModerationAction(env, guildId, {
                  caseNumber,
                  actionType: 'ban',
                  userId,
                  moderatorId,
                  reason,
                }));

                results.push({ userId, guildId, success: true });
              } else {
                results.push({ userId, guildId, success: false, error: 'API call failed or target has higher permissions' });
              }
            } catch (err: any) {
              results.push({ userId, guildId, success: false, error: err.message || String(err) });
            }

            await sleep(DELAY_MS);
          }
        }

        const successCount = results.filter(r => r.success).length;
        const failCount = results.length - successCount;
        const failures = results.filter(r => !r.success);

        // Group failures by server
        const failuresByServer = new Map<string, { guildId: string; error: string; userIds: string[] }>();
        for (const f of failures) {
          const key = `${f.guildId}:${f.error || 'Unknown error'}`;
          if (!failuresByServer.has(key)) {
            failuresByServer.set(key, { guildId: f.guildId, error: f.error || 'Unknown error', userIds: [] });
          }
          failuresByServer.get(key)!.userIds.push(f.userId);
        }

        let message = `**Ban enforcement complete.**\nSuccesses: ${successCount}, Failures: ${failCount}`;

        if (failuresByServer.size > 0) {
          message += '\n\n**Failed Servers:**';
          failuresByServer.forEach(({ guildId, error, userIds }) => {
            const userCount = userIds.length;
            message += `\n• Server ID: ${guildId} (${userCount} user${userCount > 1 ? 's' : ''}) - ${error}`;
          });
        }

        // Update the original message with results
        await fetch(`https://discord.com/api/v10/webhooks/${interaction.application_id}/${interaction.token}/messages/@original`, {
          method: 'PATCH',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            embeds: [createSuccessEmbed(message)],
            components: [],
          }),
        });
      } catch (error) {
        console.error('Error during checkban button action:', error);
        await fetch(`https://discord.com/api/v10/webhooks/${interaction.application_id}/${interaction.token}/messages/@original`, {
          method: 'PATCH',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            embeds: [createErrorEmbed('An error occurred while performing the bans.')],
            components: [],
          }),
        });
      }
    })()
  );

  // Return immediate acknowledgment
  return {
    type: InteractionResponseType.UPDATE_MESSAGE,
    data: {
      embeds: [createSuccessEmbed('🔄 Processing bans in missing servers... This may take a moment.')],
      components: [],
    },
  };
}

/**
 * Handle global ban button - ban users in ALL servers (from auditglobalbans)
 */
async function handleGlobalBanButton(
  interaction: DiscordInteraction,
  env: Env,
  ctx: ExecutionContext,
  customId: string,
  invokingId: string
): Promise<InteractionResponse> {
  // Verify user has special permissions
  if (!isSpecialUser(env, invokingId)) {
    return {
      type: InteractionResponseType.UPDATE_MESSAGE,
      data: {
        embeds: [createErrorEmbed('You are not authorized to use this button.')],
        components: [],
        flags: MessageFlags.EPHEMERAL,
      },
    };
  }

  const actionId = customId.replace('global_ban_', '');

  // Get pending action from database
  const action = await env.DB.prepare(
    `SELECT * FROM pending_ban_actions WHERE id = ? AND expires_at > datetime('now')`
  ).bind(actionId).first<{
    id: string;
    user_ids: string;
    reason: string | null;
    delete_messages: number;
    requested_by: string;
  }>();

  if (!action) {
    return {
      type: InteractionResponseType.UPDATE_MESSAGE,
      data: {
        embeds: [createErrorEmbed('This action has expired or does not exist.')],
        components: [],
      },
    };
  }

  // Verify the user who clicked is the one who requested or is special user
  if (action.requested_by !== invokingId && !isSpecialUser(env, invokingId)) {
    return {
      type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
      data: {
        embeds: [createErrorEmbed('Only the user who initiated the check or special users can execute this action.')],
        flags: MessageFlags.EPHEMERAL,
      },
    };
  }

  // Delete the pending action so button can't be clicked twice
  await env.DB.prepare('DELETE FROM pending_ban_actions WHERE id = ?').bind(actionId).run();

  // Update message to show processing
  ctx.waitUntil(
    (async () => {
      try {
        const userIds = JSON.parse(action.user_ids) as string[];
        const reason = action.reason || 'Global ban enforcement';
        const deleteMessageSeconds = action.delete_messages * 86400;
        const moderatorId = invokingId;

        // Step 1: Add all users to the global ban list (database)
        const inserted = await addUsersToGlobalBanQueue(
          env,
          userIds,
          reason,
          moderatorId,
          deleteMessageSeconds
        );

        console.log(`Added ${inserted.length} users to global ban queue from button interaction`);

        // Step 2: Get guilds and process bans
        const guilds = await getGuildsWithGlobalBansEnabled(env);
        const results: { userId: string; guildId: string; success: boolean; error?: string }[] = [];

        const DELAY_MS = 1500;

        // Check which guilds the bot is actually in
        const validGuilds: string[] = [];
        const invalidGuilds: { guildId: string; error: string }[] = [];

        for (const guildId of guilds) {
          const guildInfo = await getGuild(env, guildId);
          if (guildInfo) {
            validGuilds.push(guildId);
          } else {
            await updateGuildConfig(env, guildId, { global_bans_enabled: 0 });
            invalidGuilds.push({ guildId, error: 'Bot not in server (global bans auto-disabled)' });
          }
        }

        // Add failures for invalid guilds
        for (const userId of userIds) {
          for (const invalid of invalidGuilds) {
            results.push({ userId, guildId: invalid.guildId, success: false, error: invalid.error });
          }
        }

        // Step 3: Iterate per user, then per guild
        for (const userId of userIds) {
          for (const guildId of validGuilds) {
            try {
              const success = await banUser(env, guildId, userId, reason, deleteMessageSeconds);
              if (success) {
                const caseNumber = await createModerationCase(env, {
                  guildId,
                  userId,
                  moderatorId,
                  actionType: 'ban',
                  reason,
                });

                ctx.waitUntil(logModerationAction(env, guildId, {
                  caseNumber,
                  actionType: 'ban',
                  userId,
                  moderatorId,
                  reason,
                }));

                results.push({ userId, guildId, success: true });
              } else {
                results.push({ userId, guildId, success: false, error: 'API call failed or target has higher permissions' });
              }
            } catch (err: any) {
              results.push({ userId, guildId, success: false, error: err.message || String(err) });
            }

            await sleep(DELAY_MS);
          }
        }

        const successCount = results.filter(r => r.success).length;
        const failCount = results.length - successCount;
        const failures = results.filter(r => !r.success);

        // Group failures by server
        const failuresByServer = new Map<string, { guildId: string; error: string; userIds: string[] }>();
        for (const f of failures) {
          const key = `${f.guildId}:${f.error || 'Unknown error'}`;
          if (!failuresByServer.has(key)) {
            failuresByServer.set(key, { guildId: f.guildId, error: f.error || 'Unknown error', userIds: [] });
          }
          failuresByServer.get(key)!.userIds.push(f.userId);
        }

        let message = `Global mass ban complete. Successes: ${successCount}, Failures: ${failCount}`;

        if (failuresByServer.size > 0) {
          message += '\n\n**Failed Servers:**';
          failuresByServer.forEach(({ guildId, error, userIds }) => {
            const userCount = userIds.length;
            message += `\n• Server ID: ${guildId} (${userCount} user${userCount > 1 ? 's' : ''}) - ${error}`;
          });
        }

        // Update the original message with results
        await fetch(`https://discord.com/api/v10/webhooks/${interaction.application_id}/${interaction.token}/messages/@original`, {
          method: 'PATCH',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            embeds: [createSuccessEmbed(message)],
            components: [],
          }),
        });
      } catch (error) {
        console.error('Error during button-triggered global ban:', error);
        await fetch(`https://discord.com/api/v10/webhooks/${interaction.application_id}/${interaction.token}/messages/@original`, {
          method: 'PATCH',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            embeds: [createErrorEmbed('An error occurred while performing the global ban.')],
            components: [],
          }),
        });
      }
    })()
  );

  // Return immediate acknowledgment
  return {
    type: InteractionResponseType.UPDATE_MESSAGE,
    data: {
      embeds: [createSuccessEmbed('🔄 Processing global bans... This may take a few minutes.')],
      components: [],
    },
  };
}
