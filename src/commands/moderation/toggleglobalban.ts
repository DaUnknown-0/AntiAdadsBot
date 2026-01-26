import { Env } from '../../types/env';
import { DiscordInteraction, InteractionResponse, InteractionResponseType, MessageFlags } from '../../types/discord';
import { getOrCreateGuildConfig, updateGuildConfig } from '../../utils/permissions';
import { createErrorEmbed, createSuccessEmbed } from '../../utils/logging';

export async function handleToggleGlobalBan(
  interaction: DiscordInteraction,
  env: Env,
  _ctx: ExecutionContext
): Promise<InteractionResponse> {
  const guildId = interaction.guild_id!;

  try {
    const config = await getOrCreateGuildConfig(env, guildId);
    const current = (config.global_bans_enabled as any) || 0;
    const newValue = current ? 0 : 1;

    await updateGuildConfig(env, guildId, { global_bans_enabled: newValue });

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