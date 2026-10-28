import { Env } from '../../types/env';
import { DiscordInteraction, InteractionResponse, InteractionResponseType, MessageFlags } from '../../types/discord';
import { getOption } from '../index';
import { createErrorEmbed, createSuccessEmbed } from '../../utils/logging';
import { getInvokingUserId, isSpecialUser } from '../../utils/permissions';
import { purgeUserBanRecords } from '../../utils/databaseExtras';
import { sendFollowupMessage } from '../../utils/discord';

export async function handlePurgeGlobalBan(
  interaction: DiscordInteraction,
  env: Env,
  ctx: ExecutionContext
): Promise<InteractionResponse> {
  const invokingId = getInvokingUserId(interaction);

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

  if (!targetUserId) {
    return {
      type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
      data: {
        embeds: [createErrorEmbed('Please specify a user to purge from global-ban records.')],
        flags: MessageFlags.EPHEMERAL,
      },
    };
  }

  ctx.waitUntil(
    (async () => {
      try {
        const result = await purgeUserBanRecords(env, targetUserId);

        let message = `Purged global-ban records for <@${targetUserId}>.\n\n`;
        message += `Deleted ${result.globalBanRowsDeleted} global ban row(s), ${result.moderationCasesDeleted} ban case row(s), ${result.userInfractionsDeleted} infraction row(s), and ${result.scheduledActionsDeleted} scheduled action(s).`;
        message += '\n\nThis does not unban the user from Discord servers.';

        if (
          result.globalBanRowsDeleted === 0 &&
          result.moderationCasesDeleted === 0 &&
          result.userInfractionsDeleted === 0 &&
          result.scheduledActionsDeleted === 0
        ) {
          message = `No global-ban records were found for <@${targetUserId}>.`;
        }

        await sendFollowupMessage(interaction.application_id, interaction.token, {
          embeds: [createSuccessEmbed(message)],
          flags: MessageFlags.EPHEMERAL,
        });
      } catch (error) {
        console.error('Error purging global-ban records:', error);
        await sendFollowupMessage(interaction.application_id, interaction.token, {
          embeds: [createErrorEmbed('An error occurred while purging the user from the database.')],
          flags: MessageFlags.EPHEMERAL,
        });
      }
    })()
  );

  return {
    type: InteractionResponseType.DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE,
    data: {
      flags: MessageFlags.EPHEMERAL,
    },
  };
}