import { Env } from '../../types/env';
import { DiscordInteraction, InteractionResponse, InteractionResponseType, MessageFlags } from '../../types/discord';
import { createInfoEmbed } from '../../utils/logging';
import { snowflakeTimestamp } from '../../utils/discord';

export async function handlePingCommand(
  interaction: DiscordInteraction,
  _env: Env,
  _ctx: ExecutionContext
): Promise<InteractionResponse> {
  const start = Date.now();
  const interactionId = interaction.id;
  let discordLatency = 'N/A';

  if (interactionId) {
    try {
      const ts = snowflakeTimestamp(interactionId);
      discordLatency = `${Date.now() - ts}ms`;
    } catch (err) {
      // ignore
    }
  }

  const processing = Date.now() - start;

  return {
    type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
    data: {
      embeds: [createInfoEmbed('🏓 Pong!', `Discord latency: **${discordLatency}**\nProcessing time: **${processing}ms**`)],
      flags: MessageFlags.EPHEMERAL,
    },
  };
}
