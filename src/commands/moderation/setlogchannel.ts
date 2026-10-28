import { Env } from '../../types/env';
import { DiscordInteraction, InteractionResponse, InteractionResponseType, MessageFlags } from '../../types/discord';
import { getOption } from '../index';
import { updateGuildConfig, getUserPermissionLevel, getGuildConfig, getInvokingUserId, isSpecialUser } from '../../utils/permissions';
import { createErrorEmbed, createSuccessEmbed } from '../../utils/logging';
import { PermissionLevel } from '../../types/database';

export async function handleSetLogChannel(
  interaction: DiscordInteraction,
  env: Env,
  _ctx: ExecutionContext
): Promise<InteractionResponse> {
  const guildId = interaction.guild_id!;
  const channel = getOption(interaction, 'channel');
  const clear = getOption(interaction, 'clear');

  // Check if user is a special user OR has admin permissions (the latter may need one D1 query)
  const allowed =
    isSpecialUser(env, getInvokingUserId(interaction)) ||
    (await getUserPermissionLevel(env, guildId, interaction.member, '')) >= PermissionLevel.ADMIN;

  if (!allowed) {
    return {
      type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
      data: {
        embeds: [createErrorEmbed('You must be an administrator or special user to change the log channel.')],
        flags: MessageFlags.EPHEMERAL,
      },
    };
  }

  try {
    // clear takes precedence (updateGuildConfig creates the row if needed)
    if (clear) {
      await updateGuildConfig(env, guildId, { mod_log_channel_id: undefined });
      return {
        type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
        data: {
          embeds: [createSuccessEmbed('Moderation log channel cleared.')],
        },
      };
    }

    if (!channel) {
      // Show current setting
      const config = await getGuildConfig(env, guildId);
      const current = config?.mod_log_channel_id || 'Not set';
      return {
        type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
        data: {
          embeds: [createSuccessEmbed(`Current moderation log channel: **${current}**`)],
        },
      };
    }

    // Set channel
    await updateGuildConfig(env, guildId, { mod_log_channel_id: channel });

    return {
      type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
      data: {
        embeds: [createSuccessEmbed(`Moderation log channel set. Channel: <#${channel}>`)],
      },
    };
  } catch (err: any) {
    console.error('Error setting log channel:', err);
    const errMsg = err?.message || String(err);
    return {
      type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
      data: {
        embeds: [createErrorEmbed(`An error occurred setting the log channel: ${errMsg}`)],
        flags: MessageFlags.EPHEMERAL,
      },
    };
  }
}