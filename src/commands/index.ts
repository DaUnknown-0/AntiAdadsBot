import { Env } from '../types/env';
import { DiscordInteraction, InteractionResponse, InteractionResponseType } from '../types/discord';
import { canRunCommand, getPermissionLevelName } from '../utils/permissions';
import { createErrorEmbed } from '../utils/logging';
import { MessageFlags } from '../types/discord';

// Kept command handlers
import { handlePingCommand } from './info/ping';
import { handleGlobalBan } from './moderation/globalban';
import { handleGlobalMassBan } from './moderation/globalmassban';
import { handleToggleGlobalBan } from './moderation/toggleglobalban';
import { handleSetLogChannel } from './moderation/setlogchannel';
import { handleCheckBans } from './moderation/checkbans';
import { handleListGlobalBanServers } from './moderation/listglobalbanservers';
import { handleAnnounce } from './moderation/announce';
import { handleGlobalUnban } from './moderation/globalunban';
import { handleAuditGlobalBans } from './moderation/auditglobalbans';

// Command router
export async function handleCommand(
  interaction: DiscordInteraction,
  env: Env,
  ctx: ExecutionContext
): Promise<InteractionResponse> {
  const commandName = interaction.data?.name;

  if (!commandName) {
    return {
      type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
      data: {
        embeds: [createErrorEmbed('Invalid command')],
        flags: MessageFlags.EPHEMERAL,
      },
    };
  }

  // Get guild owner ID (would normally fetch from guild data)
  const ownerId = ''; // TODO: Fetch from guild data

  // Check permissions
  const permissionCheck = await canRunCommand(env, interaction, commandName, ownerId);

  if (!permissionCheck.allowed) {
    return {
      type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
      data: {
        embeds: [
          createErrorEmbed(
            `You don't have permission to use this command.\n\n` +
              `Your level: ${getPermissionLevelName(permissionCheck.userLevel)}\n` +
              `Required level: ${getPermissionLevelName(permissionCheck.requiredLevel)}`
          ),
        ],
        flags: MessageFlags.EPHEMERAL,
      },
    };
  }

  // Route to appropriate handler
  try {
    switch (commandName) {
      case 'globalban':
        return await handleGlobalBan(interaction, env, ctx);
      case 'globalmassban':
        return await handleGlobalMassBan(interaction, env, ctx);
      case 'toggleglobalban':
        return await handleToggleGlobalBan(interaction, env, ctx);
      case 'setlogchannel':
        return await handleSetLogChannel(interaction, env, ctx);
      case 'ping':
        return await handlePingCommand(interaction, env, ctx);
      case 'checkbans':
        return await handleCheckBans(interaction, env, ctx);
      case 'listglobalbanservers':
        return await handleListGlobalBanServers(interaction, env, ctx);
      case 'announce':
        return await handleAnnounce(interaction, env, ctx);
      case 'globalunban':
        return await handleGlobalUnban(interaction, env, ctx);
      case 'auditglobalbans':
        return await handleAuditGlobalBans(interaction, env, ctx);

      default:
        return {
          type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
          data: {
            embeds: [createErrorEmbed(`Command "${commandName}" is not yet implemented.`)],
            flags: MessageFlags.EPHEMERAL,
          },
        };
    }
  } catch (error) {
    console.error(`Error handling command ${commandName}:`, error);
    return {
      type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
      data: {
        embeds: [createErrorEmbed('An error occurred while processing your command.')],
        flags: MessageFlags.EPHEMERAL,
      },
    };
  }
}

/**
 * Helper to get option value from interaction
 */
export function getOption(interaction: DiscordInteraction, name: string): any {
  return interaction.data?.options?.find((opt) => opt.name === name)?.value;
}

/**
 * Helper to get user option from interaction
 */
export function getUserOption(interaction: DiscordInteraction, name: string): string | undefined {
  const userId = getOption(interaction, name);
  return userId;
}

/**
 * Helper to get resolved user from interaction
 */
export function getResolvedUser(interaction: DiscordInteraction, userId: string): any {
  return interaction.data?.resolved?.users?.[userId];
}

/**
 * Helper to get resolved member from interaction
 */
export function getResolvedMember(interaction: DiscordInteraction, userId: string): any {
  return interaction.data?.resolved?.members?.[userId];
}
