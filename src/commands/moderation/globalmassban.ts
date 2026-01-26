import { Env } from '../../types/env';
import { DiscordInteraction, InteractionResponse, InteractionResponseType, MessageFlags } from '../../types/discord';
import { getOption } from '../index';
import { banUser, sleep, sendFollowupMessage, getGuild } from '../../utils/discord';
import { createModerationCase } from '../../utils/database';
import { logModerationAction } from '../../utils/logging';
import { createErrorEmbed, createSuccessEmbed } from '../../utils/logging';
import { getGuildsWithGlobalBansEnabled } from '../../utils/databaseExtras';
import { updateGuildConfig } from '../../utils/permissions';

function parseUsersList(raw: string): string[] {
  return raw
    .split(/[ ,]+/)
    .map(s => s.replace(/[<@!>]/g, '').trim())
    .filter(Boolean);
}

function isSpecialUser(env: Env, userId: string): boolean {
  const raw = env.SPECIAL_USER_IDS || '1157902123888037918';
  const ids = raw.split(',').map(s => s.trim()).filter(Boolean);
  return ids.includes(userId);
}

export async function handleGlobalMassBan(
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

  const usersRaw = getOption(interaction, 'users');
  const reason = getOption(interaction, 'reason') || 'No reason provided';
  const deleteMessages = getOption(interaction, 'delete_messages') || '0';

  if (!usersRaw) {
    return {
      type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
      data: {
        embeds: [createErrorEmbed('Please specify at least one user to global ban.')],
        flags: MessageFlags.EPHEMERAL,
      },
    };
  }

  // Return deferred response immediately to acknowledge within 3s
  // Then process bans in background and send follow-up when complete
  ctx.waitUntil(
    (async () => {
      const userIds = parseUsersList(usersRaw);
      const deleteMessageSeconds = parseInt(deleteMessages) * 86400;
      const moderatorId = invokingId;

      // Step 1: Add all users to the global ban list (database)
      const { addUsersToGlobalBanQueue } = await import('../../utils/databaseExtras');
      const inserted = await addUsersToGlobalBanQueue(
        env,
        userIds,
        reason,
        moderatorId,
        deleteMessageSeconds
      );

      console.log(`Added ${inserted.length} users to global ban queue`);

      // Step 2: Get guilds and process bans
      const guilds = await getGuildsWithGlobalBansEnabled(env);
      const results: { userId: string; guildId: string; success: boolean; error?: string }[] = [];

      // Discord allows ~5 bans per 5 seconds per guild
      // Using 1.5s delay per ban to stay well under the limit (5 bans/5s = 1.25s minimum)
      const DELAY_MS = 1500;

      // Check which guilds the bot is actually in
      const validGuilds: string[] = [];
      const invalidGuilds: { guildId: string; error: string }[] = [];

      for (const guildId of guilds) {
        const guildInfo = await getGuild(env, guildId);
        if (guildInfo) {
          validGuilds.push(guildId);
        } else {
          // Bot is not in the guild - disable global bans
          await updateGuildConfig(env, guildId, { global_bans_enabled: 0 });
          invalidGuilds.push({ guildId, error: 'Bot not in server (global bans auto-disabled)' });
        }
      }

      // Add failures for invalid guilds (one per user)
      for (const userId of userIds) {
        for (const invalid of invalidGuilds) {
          results.push({ userId, guildId: invalid.guildId, success: false, error: invalid.error });
        }
      }

      // Step 3: Iterate per user, then per guild to limit burst traffic per guild
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

      // Send follow-up message with results
      await sendFollowupMessage(interaction.application_id, interaction.token, {
        embeds: [createSuccessEmbed(message)],
      });
    })()
  );

  // Return deferred response immediately
  return {
    type: InteractionResponseType.DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE,
  };
}