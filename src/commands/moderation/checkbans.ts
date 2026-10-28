import { Env } from '../../types/env';
import { DiscordInteraction, InteractionResponse, InteractionResponseType } from '../../types/discord';
import { getOption } from '../index';
import { editOriginalResponse } from '../../utils/discord';
import { appendLimited, createSuccessEmbed } from '../../utils/logging';
import { createPendingBanAction, getGuildsWithGlobalBansEnabled } from '../../utils/databaseExtras';
import { findMissingBans, MissingBansReport, parseUserIds } from '../../utils/banCheck';
import { getInvokingUserId } from '../../utils/permissions';
import { ephemeralError, rejectUnlessSpecialUser, replyError } from './globalBanShared';

// Subrequests left for ban list pages after attachment download, D1 queries and the reply
const BAN_LIST_REQUEST_BUDGET = 40;

/**
 * Build the "not fully banned" part of a report plus the confirmation button
 */
export async function buildMissingBansReply(
  env: Env,
  report: MissingBansReport,
  header: string,
  options: { reason: string; requestedBy: string; buttonPrefix: string; buttonLabel: (users: number, bans: number) => string; maxListed?: number }
): Promise<{ message: string; components?: any[] }> {
  let message = header;

  if (report.goneGuilds.length > 0) {
    message += `\n\n⚠️ Bot is no longer in ${report.goneGuilds.length} server(s); global bans were disabled there.`;
  }
  if (report.uncheckedGuilds.length > 0) {
    message += '\n\n**Not checked:**';
    message = appendLimited(message, report.uncheckedGuilds.map(u => `• Server ID: ${u.guildId} - ${u.reason}`), 1500);
  }

  if (report.missing.size === 0) {
    message += `\n\n✅ All users are banned in all checked servers.`;
    return { message };
  }

  const checked = report.checkedGuilds.length;
  const lines = [...report.missing.entries()].map(
    ([userId, guilds]) => `• <@${userId}> (\`${userId}\`): Banned in ${checked - guilds.length}/${checked} servers`
  );
  message += `\n\n⚠️ **Users not fully banned (${report.missing.size}):**`;
  message = appendLimited(message, lines, 3500);

  const missingBans = Object.fromEntries(report.missing);
  const actionId = await createPendingBanAction(env, missingBans, options.reason, options.requestedBy);

  const totalMissing = [...report.missing.values()].reduce((sum, guilds) => sum + guilds.length, 0);
  message += `\n\n**Click the button below to ban these ${report.missing.size} user(s) in the ${totalMissing} place(s) where they are not banned.**`;

  return {
    message,
    components: [
      {
        type: 1, // Action Row
        components: [
          {
            type: 2, // Button
            style: 4, // Danger (red)
            label: options.buttonLabel(report.missing.size, totalMissing).slice(0, 80),
            custom_id: `${options.buttonPrefix}${actionId}`,
            emoji: { name: '🔨' },
          },
        ],
      },
    ],
  };
}

export async function handleCheckBans(
  interaction: DiscordInteraction,
  env: Env,
  ctx: ExecutionContext
): Promise<InteractionResponse> {
  const rejection = rejectUnlessSpecialUser(env, interaction);
  if (rejection) return rejection;

  const usersRaw = getOption(interaction, 'users');
  const fileId = getOption(interaction, 'file');
  const serverId = getOption(interaction, 'server');

  if (!usersRaw && !fileId) {
    return ephemeralError('Please provide either a comma-separated list of user IDs or upload a file.');
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
              userIds = parseUserIds(await response.text());
            } catch (err) {
              console.error('Error fetching attachment:', err);
              await replyError(interaction, 'Failed to read the uploaded file.');
              return;
            }
          }
        } else if (usersRaw) {
          userIds = parseUserIds(usersRaw);
        }

        if (userIds.length === 0) {
          await replyError(interaction, 'No valid user IDs found in the provided input.');
          return;
        }

        // Get guilds to check - either single server or all with global bans enabled
        const guilds = serverId ? [String(serverId).trim()] : await getGuildsWithGlobalBansEnabled(env);

        if (guilds.length === 0) {
          await replyError(interaction, 'No servers have global bans enabled.');
          return;
        }

        // One request per server (1000 bans per page) instead of one per user and server
        const report = await findMissingBans(env, userIds, guilds, BAN_LIST_REQUEST_BUDGET);

        const header =
          `**Ban Status Check Complete**\n\n` +
          (serverId
            ? `Checked ${userIds.length} user(s) in server \`${serverId}\`.`
            : `Checked ${userIds.length} user(s) across ${report.checkedGuilds.length} server(s) with global bans enabled.`);

        const { message, components } = await buildMissingBansReply(env, report, header, {
          reason: 'Ban enforcement from checkbans',
          requestedBy: getInvokingUserId(interaction),
          buttonPrefix: 'checkban_',
          buttonLabel: (users, bans) => `Ban ${users} User${users > 1 ? 's' : ''} (${bans} bans)`,
        });

        await editOriginalResponse(interaction.application_id, interaction.token, {
          embeds: [createSuccessEmbed(message)],
          components,
        });
      } catch (error) {
        console.error('Error during ban check:', error);
        await replyError(interaction, 'An error occurred while checking ban status.');
      }
    })()
  );

  return {
    type: InteractionResponseType.DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE,
  };
}
