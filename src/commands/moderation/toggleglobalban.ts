import { Env } from '../../types/env';
import { DiscordInteraction, InteractionResponse, InteractionResponseType, MessageFlags } from '../../types/discord';
import { getInvokingUserId, getUserPermissionLevel, isSpecialUser, toggleGuildFlag } from '../../utils/permissions';
import { createErrorEmbed, createSuccessEmbed } from '../../utils/logging';
import { PermissionLevel } from '../../types/database';

/**
 * Special users and server admins may change a server's global ban settings
 */
async function canChangeGuildSettings(env: Env, interaction: DiscordInteraction): Promise<boolean> {
  return (
    isSpecialUser(env, getInvokingUserId(interaction)) ||
    (await getUserPermissionLevel(env, interaction.guild_id!, interaction.member, '')) >= PermissionLevel.ADMIN
  );
}

export async function handleToggleGlobalBan(
  interaction: DiscordInteraction,
  env: Env,
  _ctx: ExecutionContext
): Promise<InteractionResponse> {
  if (!(await canChangeGuildSettings(env, interaction))) {
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
    const flags = await toggleGuildFlag(env, interaction.guild_id!, 'global_bans_enabled');

    return {
      type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
      data: {
        embeds: [createSuccessEmbed(`Global bans are now **${flags.global_bans_enabled ? 'ENABLED' : 'DISABLED'}** for this server.`)],
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

export async function handleToggleAutoEnforce(
  interaction: DiscordInteraction,
  env: Env,
  _ctx: ExecutionContext
): Promise<InteractionResponse> {
  if (!(await canChangeGuildSettings(env, interaction))) {
    return {
      type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
      data: {
        embeds: [createErrorEmbed('You must be an administrator or special user to toggle automatic enforcement.')],
        flags: MessageFlags.EPHEMERAL,
      },
    };
  }

  try {
    const flags = await toggleGuildFlag(env, interaction.guild_id!, 'auto_enforce_enabled');

    let message = flags.auto_enforce_enabled
      ? 'Automatic global ban enforcement is now **ENABLED** for this server.\n\n' +
        'Every hour the bot bans users from the global ban list who are not banned here, ' +
        'including users a moderator unbanned locally.'
      : 'Automatic global ban enforcement is now **DISABLED** for this server.\n\n' +
        'Missing bans are only applied after confirming `/auditglobalbans` or `/checkbans`.';

    if (flags.auto_enforce_enabled && !flags.global_bans_enabled) {
      message += '\n\n⚠️ Global bans are disabled on this server, so nothing happens until `/toggleglobalban` is enabled.';
    }

    return {
      type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
      data: {
        embeds: [createSuccessEmbed(message)],
      },
    };
  } catch (err) {
    console.error('Error toggling automatic enforcement:', err);
    return {
      type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
      data: {
        embeds: [createErrorEmbed('An error occurred toggling automatic enforcement.')],
        flags: MessageFlags.EPHEMERAL,
      },
    };
  }
}
