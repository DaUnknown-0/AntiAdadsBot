import { Env } from '../../types/env';
import { DiscordInteraction, InteractionResponse, InteractionResponseType, MessageFlags } from '../../types/discord';
import { getGuild } from '../../utils/discord';
import { createErrorEmbed, createSuccessEmbed } from '../../utils/logging';
import { getGuildsWithGlobalBansEnabled } from '../../utils/databaseExtras';

function isSpecialUser(env: Env, userId: string): boolean {
  const raw = env.SPECIAL_USER_IDS || '1157902123888037918';
  const ids = raw.split(',').map(s => s.trim()).filter(Boolean);
  return ids.includes(userId);
}

export async function handleListGlobalBanServers(
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

  try {
    const guilds = await getGuildsWithGlobalBansEnabled(env);

    if (guilds.length === 0) {
      return {
        type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
        data: {
          embeds: [createSuccessEmbed('No servers have global bans enabled.')],
          flags: MessageFlags.EPHEMERAL,
        },
      };
    }

    let message = `**Servers with Global Bans Enabled (${guilds.length})**\n\n`;

    for (const guildId of guilds) {
      const guildInfo = await getGuild(env, guildId);

      if (guildInfo) {
        // Get first available channel for linking
        const channelLink = `https://discord.com/channels/${guildId}`;
        message += `• **${guildInfo.name}** - [Open Server](${channelLink})\n`;
        message += `  Guild ID: \`${guildId}\`\n\n`;
      } else {
        message += `• **Unknown Server** (Bot not in server)\n`;
        message += `  Guild ID: \`${guildId}\`\n\n`;
      }
    }

    // Discord has a 2000 character limit for embeds, so split if needed
    if (message.length > 1900) {
      message = message.substring(0, 1900) + '\n\n... (truncated)';
    }

    return {
      type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
      data: {
        embeds: [createSuccessEmbed(message)],
        flags: MessageFlags.EPHEMERAL,
      },
    };
  } catch (error) {
    console.error('Error listing global ban servers:', error);
    return {
      type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
      data: {
        embeds: [createErrorEmbed('An error occurred while fetching server list.')],
        flags: MessageFlags.EPHEMERAL,
      },
    };
  }
}
