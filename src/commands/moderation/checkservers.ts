import { Env } from '../../types/env';
import { DiscordInteraction, InteractionResponse, InteractionResponseType, MessageFlags } from '../../types/discord';
import { editOriginalResponse, getCurrentUserGuilds } from '../../utils/discord';
import { getGuildsWithGlobalBansEnabled } from '../../utils/databaseExtras';
import { rejectUnlessSpecialUser, replyError } from './globalBanShared';

export async function handleCheckServers(
  interaction: DiscordInteraction,
  env: Env,
  ctx: ExecutionContext
): Promise<InteractionResponse> {
  const rejection = rejectUnlessSpecialUser(env, interaction);
  if (rejection) return rejection;

  ctx.waitUntil((async () => {
    try {
      const [guilds, enabledIds] = await Promise.all([
        getCurrentUserGuilds(env),
        getGuildsWithGlobalBansEnabled(env),
      ]);
      if (!guilds) throw new Error('Could not load the complete bot guild list');
      const enabled = new Set(enabledIds);
      const inactive = guilds.filter(guild => !enabled.has(guild.id))
        .sort((a, b) => a.name.localeCompare(b.name));
      const summary = `Checked ${guilds.length} servers: ${guilds.length - inactive.length} with global bans enabled, ${inactive.length} disabled.`;
      // A file preserves the complete result without message/embed truncation or many follow-ups.
      if (inactive.length === 0) {
        await editOriginalResponse(interaction.application_id, interaction.token, {
          content: `${summary}\nAll servers have global bans enabled.`,
        });
        return;
      }
      const lines = inactive.map(guild => `${guild.name.replace(/[\r\n]/g, ' ')} | ${guild.id} | https://discord.com/channels/${guild.id}`);
      const report = `Servers with global bans disabled (including servers without configuration)\n${summary}\n\n${lines.join('\n')}`;
      if (report.length <= 1900) {
        await editOriginalResponse(interaction.application_id, interaction.token, { content: report });
      } else {
        await editOriginalResponse(interaction.application_id, interaction.token, {
          content: `${summary}\nThe complete list follows as a text file.`,
        });
        const form = new FormData();
        form.append('payload_json', JSON.stringify({ flags: MessageFlags.EPHEMERAL, attachments: [{ id: 0, filename: 'inactive-global-ban-servers.txt' }] }));
        form.append('files[0]', new Blob([report], { type: 'text/plain;charset=utf-8' }), 'inactive-global-ban-servers.txt');
        const response = await fetch(`https://discord.com/api/v10/webhooks/${interaction.application_id}/${interaction.token}`, { method: 'POST', body: form });
        const ok = response.ok;
        await response.text();
        if (!ok) throw new Error('Could not upload server report');
      }
    } catch (error) {
      console.error('Error checking servers:', error);
      await replyError(interaction, 'Could not complete the server check. Please try again.');
    }
  })());
  return {
    type: InteractionResponseType.DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE,
    data: { flags: MessageFlags.EPHEMERAL },
  };
}
