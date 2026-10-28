import { Env } from '../types/env';
import { listGuildBanIds, mapWithConcurrency } from './discord';
import { setGlobalBansDisabled } from './databaseExtras';

/**
 * Compare a list of users against the ban lists of several guilds.
 *
 * Uses GET /guilds/{id}/bans (1000 bans per request), so the cost is one subrequest per guild
 * and page instead of one per user and guild. Guilds that do not fit into `requestBudget`
 * are reported as unchecked instead of blowing the 50-subrequest limit.
 */
export interface MissingBansReport {
  /** userId -> guilds where the user is NOT banned */
  missing: Map<string, string[]>;
  checkedGuilds: string[];
  /** Guilds that could not be checked (budget exhausted, API error, list too long) */
  uncheckedGuilds: Array<{ guildId: string; reason: string }>;
  /** Guilds the bot has left; global bans were disabled for them */
  goneGuilds: string[];
  requestsUsed: number;
}

const MAX_PAGES_PER_GUILD = 5; // 5000 bans per guild

export async function findMissingBans(
  env: Env,
  userIds: string[],
  guildIds: string[],
  requestBudget: number
): Promise<MissingBansReport> {
  const report: MissingBansReport = {
    missing: new Map(),
    checkedGuilds: [],
    uncheckedGuilds: [],
    goneGuilds: [],
    requestsUsed: 0,
  };

  // Reserve one page per guild up front; pagination beyond that draws from what is left
  const toCheck = guildIds.slice(0, Math.max(0, requestBudget));
  for (const guildId of guildIds.slice(toCheck.length)) {
    report.uncheckedGuilds.push({ guildId, reason: 'Not checked (Cloudflare subrequest limit)' });
  }

  let spare = requestBudget - toCheck.length;

  const lists = await mapWithConcurrency(toCheck, 6, async (guildId) => {
    const extraPages = Math.min(MAX_PAGES_PER_GUILD - 1, Math.max(0, spare));
    const list = await listGuildBanIds(env, guildId, 1 + extraPages);
    spare -= list.requests - 1;
    return { guildId, list };
  });

  for (const { guildId, list } of lists) {
    report.requestsUsed += list.requests;

    if (list.guildGone) {
      report.goneGuilds.push(guildId);
      await setGlobalBansDisabled(env, guildId);
      continue;
    }
    if (list.error) {
      report.uncheckedGuilds.push({ guildId, reason: list.error });
      continue;
    }
    if (!list.complete) {
      report.uncheckedGuilds.push({ guildId, reason: 'Ban list too long to check in one run' });
      continue;
    }

    report.checkedGuilds.push(guildId);
    for (const userId of userIds) {
      if (!list.ids.has(userId)) {
        const guilds = report.missing.get(userId) || [];
        guilds.push(guildId);
        report.missing.set(userId, guilds);
      }
    }
  }

  return report;
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
