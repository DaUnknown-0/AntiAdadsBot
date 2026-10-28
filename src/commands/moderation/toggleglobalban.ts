import { Env } from '../../types/env';
import { DiscordInteraction, InteractionResponse, InteractionResponseType, MessageFlags } from '../../types/discord';
import { getOrCreateGuildConfig, updateGuildConfig, getUserPermissionLevel } from '../../utils/permissions';
import { createErrorEmbed, createSuccessEmbed } from '../../utils/logging';
import { PermissionLevel } from '../../types/database';

function isSpecialUser(env: Env, userId: string): boolean {
  const raw = env.SPECIAL_USER_IDS || '1157902123888037918';
  const ids = raw.split(',').map(s => s.trim()).filter(Boolean);
  return ids.includes(userId);
}

export async function handleToggleGlobalBan(
  interaction: DiscordInteraction,
  env: Env,
  _ctx: ExecutionContext
): Promise<InteractionResponse> {
  const guildId = interaction.guild_id!;
  const userId = interaction.member?.user?.id || interaction.user?.id!;

  // Check if user has admin permissions OR is a special user
  const userLevel = await getUserPermissionLevel(env, guildId, interaction.member, '');
  const hasAdminPerms = userLevel >= PermissionLevel.ADMIN;
  const isSpecial = isSpecialUser(env, userId);

  if (!hasAdminPerms && !isSpecial) {
    return {
      type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
      data: {
        embeds: [createErrorEmbed('You must be an administrator or special user to toggle global bans.')],
        flags: MessageFlags.EPHEMERAL,
      },
    };
  }

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