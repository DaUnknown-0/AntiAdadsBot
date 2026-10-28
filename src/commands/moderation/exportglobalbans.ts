import { Env } from '../../types/env';
import { DiscordInteraction, InteractionResponse, InteractionResponseType, MessageFlags } from '../../types/discord';
import { createErrorEmbed, createSuccessEmbed } from '../../utils/logging';
import { getInvokingUserId, isSpecialUser } from '../../utils/permissions';

const DISCORD_API_BASE = 'https://discord.com/api/v10';

/**
 * Send a followup message that contains a plain-text file attachment.
 * Uses multipart/form-data so the content isn't limited to 2000 characters.
 */
async function sendFollowupFile(
  applicationId: string,
  token: string,
  filename: string,
  fileContent: string,
  caption: string
): Promise<void> {
  const url = `${DISCORD_API_BASE}/webhooks/${applicationId}/${token}`;

  const payload = JSON.stringify({
    content: caption,
    attachments: [{ id: '0', filename }],
  });

  const formData = new FormData();
  formData.append('payload_json', payload);
  formData.append('files[0]', new Blob([fileContent], { type: 'text/plain' }), filename);

  await fetch(url, { method: 'POST', body: formData });
}

/**
 * Send a followup message with a plain embed (no file).
 */
async function sendFollowupEmbed(
  applicationId: string,
  token: string,
  embed: object
): Promise<void> {
  const url = `${DISCORD_API_BASE}/webhooks/${applicationId}/${token}`;
  await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ embeds: [embed] }),
  });
}

export async function handleExportGlobalBans(
  interaction: DiscordInteraction,
  env: Env,
  ctx: ExecutionContext
): Promise<InteractionResponse> {
  const invokingId = getInvokingUserId(interaction);

  if (!isSpecialUser(env, invokingId)) {
    return {
      type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
      data: {
        embeds: [createErrorEmbed('You are not authorized to use this command.')],
        flags: MessageFlags.EPHEMERAL,
      },
    };
  }

  // Defer to avoid the 3-second timeout while querying the DB
  ctx.waitUntil(
    (async () => {
      try {
        // The global ban list holds exactly one row per globally banned user
        const results = await env.DB.prepare(
          'SELECT user_id FROM global_ban_list ORDER BY created_at DESC'
        ).all<{ user_id: string }>();

        const rows = results.results || [];

        if (rows.length === 0) {
          await sendFollowupEmbed(
            interaction.application_id,
            interaction.token,
            createSuccessEmbed('No completed global bans found.')
          );
          return;
        }

        const idList = rows.map(r => r.user_id).join(', ');
        const filename = 'banned_ids.txt';
        const caption = `Exported **${rows.length}** globally banned user ID${rows.length === 1 ? '' : 's'}.`;

        // Discord message limit is 2000 chars; send as file if the list is too long
        if (idList.length <= 1900) {
          const url = `${DISCORD_API_BASE}/webhooks/${interaction.application_id}/${interaction.token}`;
          await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              content: `${caption}\n\`\`\`\n${idList}\n\`\`\``,
              flags: MessageFlags.EPHEMERAL,
            }),
          });
        } else {
          await sendFollowupFile(
            interaction.application_id,
            interaction.token,
            filename,
            idList,
            caption
          );
        }
      } catch (error) {
        console.error('Error exporting global bans:', error);
        await sendFollowupEmbed(
          interaction.application_id,
          interaction.token,
          createErrorEmbed('An error occurred while exporting global bans.')
        );
      }
    })()
  );

  // Acknowledge immediately (deferred)
  return {
    type: InteractionResponseType.DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE,
    data: { flags: MessageFlags.EPHEMERAL },
  };
}
