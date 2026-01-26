import { Env } from '../../types/env';
import { DiscordInteraction, InteractionResponse, InteractionResponseType, MessageFlags, DiscordEmbed } from '../../types/discord';
import { getOption } from '../index';
import { sendMessage, sendFollowupMessage } from '../../utils/discord';
import { createErrorEmbed, createSuccessEmbed } from '../../utils/logging';
import { getGuildsWithGlobalBansEnabled } from '../../utils/databaseExtras';
import { getGuildConfig } from '../../utils/permissions';

function isSpecialUser(env: Env, userId: string): boolean {
  const raw = env.SPECIAL_USER_IDS || '1157902123888037918';
  const ids = raw.split(',').map(s => s.trim()).filter(Boolean);
  return ids.includes(userId);
}

export async function handleAnnounce(
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

  const title = getOption(interaction, 'title');
  const message = getOption(interaction, 'message');

  if (!title || !message) {
    return {
      type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
      data: {
        embeds: [createErrorEmbed('Please provide both a title and message for the announcement.')],
        flags: MessageFlags.EPHEMERAL,
      },
    };
  }

  // Return deferred response immediately
  ctx.waitUntil(
    (async () => {
      try {
        const guilds = await getGuildsWithGlobalBansEnabled(env);

        if (guilds.length === 0) {
          await sendFollowupMessage(interaction.application_id, interaction.token, {
            embeds: [createErrorEmbed('No servers have global bans enabled.')],
          });
          return;
        }

        const results: { guildId: string; success: boolean; error?: string }[] = [];

        // Create announcement embed
        const announcementEmbed: DiscordEmbed = {
          title: `📢 ${title}`,
          description: message,
          color: 0x5865F2, // Discord Blurple
          timestamp: new Date().toISOString(),
          footer: {
            text: 'System Announcement',
          },
        };

        // Send to all servers with global bans enabled
        for (const guildId of guilds) {
          try {
            const config = await getGuildConfig(env, guildId);

            if (!config || !config.mod_log_channel_id) {
              results.push({
                guildId,
                success: false,
                error: 'No log channel configured'
              });
              continue;
            }

            const response = await sendMessage(env, config.mod_log_channel_id, undefined, [announcementEmbed]);

            if (response) {
              results.push({ guildId, success: true });
            } else {
              results.push({
                guildId,
                success: false,
                error: 'Failed to send message'
              });
            }
          } catch (err: any) {
            results.push({
              guildId,
              success: false,
              error: err.message || String(err)
            });
          }
        }

        const successCount = results.filter(r => r.success).length;
        const failCount = results.length - successCount;
        const failures = results.filter(r => !r.success);

        let responseMessage = `Announcement sent to ${successCount} out of ${guilds.length} server(s).`;

        if (failures.length > 0) {
          responseMessage += `\n\n**Failed Servers (${failCount}):**`;
          failures.slice(0, 10).forEach(f => {
            responseMessage += `\n• Server ID: ${f.guildId}`;
            if (f.error) {
              responseMessage += ` - ${f.error}`;
            }
          });

          if (failures.length > 10) {
            responseMessage += `\n... and ${failures.length - 10} more`;
          }
        }

        await sendFollowupMessage(interaction.application_id, interaction.token, {
          embeds: [createSuccessEmbed(responseMessage)],
        });
      } catch (error) {
        console.error('Error during announcement:', error);
        await sendFollowupMessage(interaction.application_id, interaction.token, {
          embeds: [createErrorEmbed('An error occurred while sending announcements.')],
        });
      }
    })()
  );

  return {
    type: InteractionResponseType.DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE,
  };
}
