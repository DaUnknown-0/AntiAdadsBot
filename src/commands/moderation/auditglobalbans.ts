import { Env } from '../../types/env';
import { DiscordInteraction, InteractionResponse, InteractionResponseType } from '../../types/discord';
import { editOriginalResponse } from '../../utils/discord';
import { createErrorEmbed, createSuccessEmbed } from '../../utils/logging';
import { getGuildsWithGlobalBansEnabled, getGlobalBanList } from '../../utils/databaseExtras';
import { findMissingBans } from '../../utils/banCheck';
import { getInvokingUserId } from '../../utils/permissions';
import { rejectUnlessSpecialUser, replyError } from './globalBanShared';
import { buildMissingBansReply } from './checkbans';

// Subrequests left for ban list pages after the D1 queries and the reply
const BAN_LIST_REQUEST_BUDGET = 42;

export async function handleAuditGlobalBans(
  interaction: DiscordInteraction,
  env: Env,
  ctx: ExecutionContext
): Promise<InteractionResponse> {
  const rejection = rejectUnlessSpecialUser(env, interaction);
  if (rejection) return rejection;

  // Return deferred response immediately
  ctx.waitUntil(
    (async () => {
      try {
        const [globalBans, guilds] = await Promise.all([
          getGlobalBanList(env),
          getGuildsWithGlobalBansEnabled(env),
        ]);

        if (globalBans.length === 0) {
          await editOriginalResponse(interaction.application_id, interaction.token, {
            embeds: [createSuccessEmbed('No users found in the global ban list.')],
          });
          return;
        }

        if (guilds.length === 0) {
          await replyError(interaction, 'No servers have global bans enabled.');
          return;
        }

        // The number of banned users no longer matters: one request per server and 1000 bans
        const report = await findMissingBans(env, globalBans.map(b => b.user_id), guilds, BAN_LIST_REQUEST_BUDGET);

        const header =
          `**Global Ban Audit Complete**\n\n` +
          `Checked ${globalBans.length} globally banned user(s) across ${report.checkedGuilds.length} server(s).`;

        const { message, components } = await buildMissingBansReply(env, report, header, {
          reason: 'Global ban enforcement from audit',
          requestedBy: getInvokingUserId(interaction),
          buttonPrefix: 'global_ban_',
          buttonLabel: (users) => `Enforce Bans for ${users} User${users > 1 ? 's' : ''}`,
        });

        await editOriginalResponse(interaction.application_id, interaction.token, {
          embeds: [report.missing.size === 0 ? createSuccessEmbed(message) : createErrorEmbed(message)],
          components,
        });
      } catch (error) {
        console.error('Error during global ban audit:', error);
        await replyError(interaction, 'An error occurred while auditing global bans.');
      }
    })()
  );

  return {
    type: InteractionResponseType.DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE,
  };
}
