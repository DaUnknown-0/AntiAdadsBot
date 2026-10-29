import { Env } from '../../types/env';
import { DiscordInteraction, InteractionResponse, InteractionResponseType, MessageFlags } from '../../types/discord';
import { editOriginalResponse, getGuild, getGuildMember } from '../../utils/discord';
import { getGuildConfig } from '../../utils/permissions';
import { rejectUnlessSpecialUser, replyError } from './globalBanShared';

export async function handleJobCommand(interaction: DiscordInteraction, env: Env, ctx: ExecutionContext): Promise<InteractionResponse> {
  const rejection = rejectUnlessSpecialUser(env, interaction);
  if (rejection) return rejection;
  ctx.waitUntil((async () => {
    try {
      const name = interaction.data?.name;
      let content: string;
      if (name === 'server-health') {
        if (!interaction.guild_id) throw new Error('Run this command in a server.');
        const [config, member, guild] = await Promise.all([
          getGuildConfig(env, interaction.guild_id),
          getGuildMember(env, interaction.guild_id, env.DISCORD_APPLICATION_ID),
          getGuild(env, interaction.guild_id),
        ]);
        const rolesResponse = await fetch(`https://discord.com/api/v10/guilds/${interaction.guild_id}/roles`, { headers: { Authorization: `Bot ${env.DISCORD_BOT_TOKEN}` } });
        if (!rolesResponse.ok) { await rolesResponse.text(); throw new Error('Could not read server roles.'); }
        const roles = await rolesResponse.json() as Array<{ id: string; permissions: string }>;
        if (!member || !guild) throw new Error('Could not read bot membership.');
        const ids = new Set([interaction.guild_id, ...member.roles]);
        const permissions = roles.filter(r => ids.has(r.id)).reduce((p, r) => p | BigInt(r.permissions), 0n);
        const admin = guild.owner_id === env.DISCORD_APPLICATION_ID || (permissions & 8n) !== 0n;
        content = `Server: ${guild.name}\nGlobal bans: ${config?.global_bans_enabled ? 'enabled' : 'disabled'}\nHourly enforcement: ${config?.auto_enforce_enabled ? 'enabled' : 'disabled'}\nLog channel: ${config?.mod_log_channel_id ? `<#${config.mod_log_channel_id}> (delivery permissions not checked)` : 'not configured'}\nBan Members: ${admin || (permissions & 4n) !== 0n ? 'yes' : 'MISSING'}\nManage Server (bulk bans): ${admin || (permissions & 32n) !== 0n ? 'yes' : 'missing; single-ban fallback'}`;
      } else {
        const id = interaction.data?.options?.find(o => o.name === 'id')?.value;
        if (id !== undefined && (typeof id !== 'string' || !/^[a-f0-9]{64}$/.test(id))) throw new Error('Invalid job ID.');
        const job = id
          ? await env.DB.prepare('SELECT * FROM bot_jobs WHERE id = ?').bind(id).first<Record<string, any>>()
          : await env.DB.prepare('SELECT * FROM bot_jobs ORDER BY created_at DESC LIMIT 1').first<Record<string, any>>();
        if (!job) throw new Error('No job found.');
        if (name === 'cancel-job') {
          await env.DB.prepare("UPDATE bot_jobs SET status = 'cancel_requested', updated_at = ? WHERE id = ? AND status = 'running'").bind(Date.now(), job.id).run();
          content = `Job ${job.id}: cancellation requested if still running. The current batch may finish; completed actions remain applied.`;
        } else {
          content = `${job.title}\nID: ${job.id}\nStatus: ${job.status}${job.status === 'running' && job.lease_until < Date.now() ? ' (lease expired)' : ''}\n${job.summary || 'Waiting for first batch.'}`;
        }
      }
      await editOriginalResponse(interaction.application_id, interaction.token, { content: content.slice(0, 1950) });
    } catch (error) {
      await replyError(interaction, error instanceof Error ? error.message : 'Could not process command.');
    }
  })());
  return { type: InteractionResponseType.DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE, data: { flags: MessageFlags.EPHEMERAL } };
}
