import { Env } from '../../types/env';
import { DiscordInteraction, InteractionResponse, InteractionResponseType, MessageFlags } from '../../types/discord';
import { editOriginalResponse, getCurrentUserGuilds } from '../../utils/discord';
import { createErrorEmbed, createSuccessEmbed } from '../../utils/logging';
import { getGuildsWithAutoEnforceEnabled, getGuildsWithGlobalBansEnabled } from '../../utils/databaseExtras';
import { rejectUnlessSpecialUser } from './globalBanShared';

export async function handleListGlobalBanServers(
  interaction: DiscordInteraction,
  env: Env,
  ctx: ExecutionContext
): Promise<InteractionResponse> {
  const rejection = rejectUnlessSpecialUser(env, interaction);
  if (rejection) return rejection;
  ctx.waitUntil((async () => {
    const result = await buildServerList(interaction, env);
    await editOriginalResponse(interaction.application_id, interaction.token, { embeds: result.data?.embeds });
  })());
  return { type: InteractionResponseType.DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE, data: { flags: MessageFlags.EPHEMERAL } };
}

async function buildServerList(
  interaction: DiscordInteraction,
  env: Env
): Promise<InteractionResponse> {
  const rejection = rejectUnlessSpecialUser(env, interaction);
  if (rejection) return rejection;

  try {
    // Three requests in parallel instead of one sequential request per server
    const [guilds, autoEnforce, botGuilds] = await Promise.all([
      getGuildsWithGlobalBansEnabled(env),
      getGuildsWithAutoEnforceEnabled(env),
      getCurrentUserGuilds(env),
    ]);
    const autoEnforceSet = new Set(autoEnforce);

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

    let message = `**Servers with Global Bans Enabled (${guilds.length})**\n`;
    message += `⏰ = automatic hourly re-ban enabled (${autoEnforceSet.size})\n\n`;

    for (const guildId of guilds) {
      const name = names.get(guildId);
      const marker = autoEnforceSet.has(guildId) ? ' ⏰' : '';

      if (name) {
        const channelLink = `https://discord.com/channels/${guildId}`;
        message += `• **${name}**${marker} - [Open Server](${channelLink})\n`;
        message += `  Guild ID: \`${guildId}\`\n\n`;
      } else {
        message += `• **Unknown Server**${marker} (${botGuilds ? 'Bot not in server' : 'could not load server names'})\n`;
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
