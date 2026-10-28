import { appendLimited } from './logging';

/**
 * Helpers for ban checks (/checkbans, /auditglobalbans and the hourly enforcement).
 * The checks themselves run page by page inside the BanJob Durable Object.
 */

export type BanCheckVariant = 'checkbans' | 'audit' | 'scheduled';

export interface BanCheckResult {
  variant: BanCheckVariant;
  userCount: number;
  /** Set when /checkbans was limited to one server */
  singleServer?: string;
  checkedGuilds: string[];
  /** Guilds the bot has left; global bans were disabled for them */
  goneGuilds: string[];
  /** Guilds that could not be checked (API error, ban list too long) */
  uncheckedGuilds: Array<{ guildId: string; reason: string }>;
  /** userId -> guilds where the user is NOT banned */
  missing: Map<string, string[]>;
}

/**
 * Build the result message of a ban check, with a confirmation button if bans are missing
 */
export function buildBanCheckMessage(
  result: BanCheckResult,
  actionId: string | null
): { message: string; components?: any[] } {
  const checked = result.checkedGuilds.length;

  let message =
    result.variant === 'audit'
      ? `**Global Ban Audit Complete**\n\nChecked ${result.userCount} globally banned user(s) across ${checked} server(s).`
      : `**Ban Status Check Complete**\n\n` +
        (result.singleServer
          ? `Checked ${result.userCount} user(s) in server \`${result.singleServer}\`.`
          : `Checked ${result.userCount} user(s) across ${checked} server(s) with global bans enabled.`);

  if (result.goneGuilds.length > 0) {
    message += `\n\n⚠️ Bot is no longer in ${result.goneGuilds.length} server(s); global bans were disabled there.`;
  }
  if (result.uncheckedGuilds.length > 0) {
    message += '\n\n**Not checked:**';
    message = appendLimited(message, result.uncheckedGuilds.map(u => `• Server ID: ${u.guildId} - ${u.reason}`), 1500);
  }

  if (result.missing.size === 0) {
    message += `\n\n✅ All users are banned in all checked servers.`;
    return { message };
  }

  const lines = [...result.missing.entries()].map(
    ([userId, guilds]) => `• <@${userId}> (\`${userId}\`): Banned in ${checked - guilds.length}/${checked} servers`
  );
  message += `\n\n⚠️ **Users not fully banned (${result.missing.size}):**`;
  message = appendLimited(message, lines, 3500);

  if (!actionId) {
    return { message };
  }

  const users = result.missing.size;
  const totalMissing = [...result.missing.values()].reduce((sum, guilds) => sum + guilds.length, 0);
  message += `\n\n**Click the button below to ban these ${users} user(s) in the ${totalMissing} place(s) where they are not banned.**`;

  const audit = result.variant === 'audit';
  return {
    message,
    components: [
      {
        type: 1, // Action Row
        components: [
          {
            type: 2, // Button
            style: 4, // Danger (red)
            label: (audit
              ? `Enforce Bans for ${users} User${users > 1 ? 's' : ''}`
              : `Ban ${users} User${users > 1 ? 's' : ''} (${totalMissing} bans)`).slice(0, 80),
            custom_id: `${audit ? 'global_ban_' : 'checkban_'}${actionId}`,
            emoji: { name: '🔨' },
          },
        ],
      },
    ],
  };
}

/**
 * Parse user IDs from free text (mentions, commas, spaces, newlines), deduplicated
 */
export function parseUserIds(raw: string): string[] {
  const ids = raw
    .split(/[\s,]+/)
    .map(s => s.replace(/[<@!>]/g, '').trim())
    .filter(s => /^\d{15,21}$/.test(s));
  return [...new Set(ids)];
}

/**
 * Turn {userId: [guildIds]} into {guildId: [userIds]}
 */
export function invertMissingBans(missing: Record<string, string[]>): Map<string, string[]> {
  const byGuild = new Map<string, string[]>();
  for (const [userId, guildIds] of Object.entries(missing)) {
    for (const guildId of guildIds) {
      const users = byGuild.get(guildId) || [];
      users.push(userId);
      byGuild.set(guildId, users);
    }
  }
  return byGuild;
}
