import { Env } from '../../types/env';
import { DiscordInteraction, InteractionResponse, InteractionResponseType, MessageFlags } from '../../types/discord';
import { getCurrentUserGuilds } from '../../utils/discord';
import { createErrorEmbed, createSuccessEmbed } from '../../utils/logging';
import { getGuildsWithGlobalBansEnabled } from '../../utils/databaseExtras';
import { rejectUnlessSpecialUser } from './globalBanShared';

export async function handleListGlobalBanServers(
  interaction: DiscordInteraction,
  env: Env,
  _ctx: ExecutionContext
): Promise<InteractionResponse> {
  const rejection = rejectUnlessSpecialUser(env, interaction);
  if (rejection) return rejection;

  try {
    // Two requests in parallel instead of one sequential request per server
    const [guilds, botGuilds] = await Promise.all([
      getGuildsWithGlobalBansEnabled(env),
      getCurrentUserGuilds(env),
    ]);

    if (guilds.length === 0) {
      return {
        type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
        data: {
          embeds: [createSuccessEmbed('No servers have global bans enabled.')],
          flags: MessageFlags.EPHEMERAL,
        },
      };
    }

    const names = new Map((botGuilds || []).map(g => [g.id, g.name]));

    let message = `**Servers with Global Bans Enabled (${guilds.length})**\n\n`;

    for (const guildId of guilds) {
      const name = names.get(guildId);

      if (name) {
        const channelLink = `https://discord.com/channels/${guildId}`;
        message += `• **${name}** - [Open Server](${channelLink})\n`;
        message += `  Guild ID: \`${guildId}\`\n\n`;
      } else {
        message += `• **Unknown Server** (${botGuilds ? 'Bot not in server' : 'could not load server names'})\n`;
        message += `  Guild ID: \`${guildId}\`\n\n`;
      }
    }

    // Embed descriptions are capped at 4096 characters
    if (message.length > 3900) {
      message = message.substring(0, 3900) + '\n\n... (truncated)';
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
