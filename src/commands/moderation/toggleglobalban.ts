import { Env } from '../../types/env';
import { DiscordInteraction, InteractionResponse, InteractionResponseType, MessageFlags } from '../../types/discord';
import { getInvokingUserId, getUserPermissionLevel, isSpecialUser, toggleGlobalBansEnabled } from '../../utils/permissions';
import { createErrorEmbed, createSuccessEmbed } from '../../utils/logging';
import { PermissionLevel } from '../../types/database';

export async function handleToggleGlobalBan(
  interaction: DiscordInteraction,
  env: Env,
  _ctx: ExecutionContext
): Promise<InteractionResponse> {
  const guildId = interaction.guild_id!;

  // Check if user is a special user OR has admin permissions (the latter may need one D1 query)
  const allowed =
    isSpecialUser(env, getInvokingUserId(interaction)) ||
    (await getUserPermissionLevel(env, guildId, interaction.member, '')) >= PermissionLevel.ADMIN;

  if (!allowed) {
    return {
      type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
      data: {
        embeds: [createErrorEmbed('You must be an administrator or special user to toggle global bans.')],
        flags: MessageFlags.EPHEMERAL,
      },
    };
  }

  try {
    // Single upsert that flips the flag and returns the new value
    const newValue = await toggleGlobalBansEnabled(env, guildId);

    return {
      type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
      data: {
        embeds: [createSuccessEmbed(`Global bans are now **${newValue ? 'ENABLED' : 'DISABLED'}** for this server.`)],
      },
    };
  } catch (err) {
    console.error('Error toggling global ban setting:', err);
    return {
      type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
      data: {
        embeds: [createErrorEmbed('An error occurred toggling the global ban setting.')],
        flags: MessageFlags.EPHEMERAL,
      },
    };
  }
}
