import { Env } from '../types/env';

export async function getGuildsWithGlobalBansEnabled(env: Env): Promise<string[]> {
  const results = await env.DB.prepare(
    'SELECT guild_id FROM guild_configs WHERE global_bans_enabled = 1'
  ).all<{ guild_id: string }>();

  return (results.results || []).map(r => r.guild_id);
}

/**
 * Guilds that take part in global bans AND opted into the hourly automatic re-ban
 */
export async function getGuildsWithAutoEnforceEnabled(env: Env): Promise<string[]> {
  const results = await env.DB.prepare(
    'SELECT guild_id FROM guild_configs WHERE global_bans_enabled = 1 AND auto_enforce_enabled = 1'
  ).all<{ guild_id: string }>();

  return (results.results || []).map(r => r.guild_id);
}

/**
 * Guilds with global bans enabled, together with their log channel (one query for both)
 */
export async function getGlobalBanGuildTargets(
  env: Env,
  guildIds?: string[]
): Promise<Array<{ guildId: string; logChannelId: string | null }>> {
  const stmt = guildIds
    ? env.DB.prepare(
        'SELECT guild_id, mod_log_channel_id FROM guild_configs WHERE guild_id IN (SELECT value FROM json_each(?))'
      ).bind(JSON.stringify(guildIds))
    : env.DB.prepare('SELECT guild_id, mod_log_channel_id FROM guild_configs WHERE global_bans_enabled = 1');

  const results = await stmt.all<{ guild_id: string; mod_log_channel_id: string | null }>();
  return (results.results || []).map(r => ({ guildId: r.guild_id, logChannelId: r.mod_log_channel_id || null }));
}

export async function setGlobalBansDisabled(env: Env, guildId: string): Promise<void> {
  await env.DB.prepare(
    "UPDATE guild_configs SET global_bans_enabled = 0, updated_at = datetime('now') WHERE guild_id = ?"
  ).bind(guildId).run();
}

/**
 * The global ban list: one row per user, the single source of truth for audits and exports
 */
export async function getGlobalBanList(env: Env): Promise<Array<{ user_id: string; reason: string | null }>> {
  const results = await env.DB.prepare(
    'SELECT user_id, reason FROM global_ban_list ORDER BY created_at DESC'
  ).all<{ user_id: string; reason: string | null }>();

  return results.results || [];
}

/**
 * Statement that adds users to the global ban list (or refreshes reason/moderator if present)
 */
export function addToGlobalBanListStatement(
  env: Env,
  userIds: string[],
  reason: string | null,
  addedBy: string | null
): D1PreparedStatement {
  // "WHERE true" is required by SQLite to parse an upsert that follows INSERT ... SELECT
  return env.DB.prepare(
    `INSERT INTO global_ban_list (user_id, reason, added_by)
     SELECT value, ?2, ?3 FROM json_each(?1) WHERE true
     ON CONFLICT(user_id) DO UPDATE SET
       reason = COALESCE(excluded.reason, global_ban_list.reason),
       added_by = COALESCE(excluded.added_by, global_ban_list.added_by),
       updated_at = datetime('now')`
  ).bind(JSON.stringify(userIds), reason, addedBy);
}

/**
 * Statement that records global ban tasks for the third-party /global-bans API
 */
function globalBanTasksStatement(
  env: Env,
  userIds: string[],
  reason: string,
  requestedBy: string | null,
  deleteMessages: number
): D1PreparedStatement {
  const created = new Date().toISOString();
  return env.DB.prepare(
    `INSERT INTO global_bans (id, user_id, requested_by, reason, delete_messages, status, attempts, last_error, created_at, updated_at)
     SELECT lower(hex(randomblob(16))), value, ?2, ?3, ?4, 'pending', 0, NULL, ?5, ?5 FROM json_each(?1)`
  ).bind(JSON.stringify(userIds), requestedBy, reason, deleteMessages, created);
}

/**
 * Add users to the global ban list and record the matching API tasks (one D1 query)
 */
export async function addUsersToGlobalBanList(
  env: Env,
  userIds: string[],
  reason: string,
  requestedBy: string | null,
  deleteMessages: number
): Promise<void> {
  if (userIds.length === 0) return;

  await env.DB.batch([
    addToGlobalBanListStatement(env, userIds, reason, requestedBy),
    globalBanTasksStatement(env, userIds, reason, requestedBy, deleteMessages),
  ]);
}

/**
 * Remove a user from the global ban list and the task table (one D1 query)
 */
export async function removeUserFromGlobalBanList(env: Env, userId: string): Promise<number> {
  const [listResult, tasksResult] = await env.DB.batch([
    env.DB.prepare('DELETE FROM global_ban_list WHERE user_id = ?').bind(userId),
    env.DB.prepare('DELETE FROM global_bans WHERE user_id = ?').bind(userId),
  ]);

  return listResult.meta.changes + tasksResult.meta.changes;
}

export async function purgeUserBanRecords(
  env: Env,
  userId: string
): Promise<{
  scheduledActionsDeleted: number;
  userInfractionsDeleted: number;
  moderationCasesDeleted: number;
  globalBanRowsDeleted: number;
}> {
  const [scheduledActionsResult, userInfractionsResult, moderationCasesResult, globalBanRowsResult, globalBanListResult] = await env.DB.batch([
    env.DB.prepare(
      `DELETE FROM scheduled_actions
       WHERE case_id IN (
         SELECT id FROM moderation_cases WHERE user_id = ? AND action_type = 'ban'
       )`
    ).bind(userId),
    env.DB.prepare(
      `DELETE FROM user_infractions
       WHERE case_id IN (
         SELECT id FROM moderation_cases WHERE user_id = ? AND action_type = 'ban'
       )`
    ).bind(userId),
    env.DB.prepare(
      `DELETE FROM moderation_cases
       WHERE user_id = ? AND action_type = 'ban'`
    ).bind(userId),
    env.DB.prepare(
      'DELETE FROM global_bans WHERE user_id = ?'
    ).bind(userId),
    env.DB.prepare(
      'DELETE FROM global_ban_list WHERE user_id = ?'
    ).bind(userId),
  ]);

  return {
    scheduledActionsDeleted: scheduledActionsResult.meta.changes,
    userInfractionsDeleted: userInfractionsResult.meta.changes,
    moderationCasesDeleted: moderationCasesResult.meta.changes,
    globalBanRowsDeleted: globalBanRowsResult.meta.changes + globalBanListResult.meta.changes,
  };
}

/**
 * Store a "missing bans" mapping behind a confirmation button (expires after 1 hour)
 */
export async function createPendingBanAction(
  env: Env,
  missingBans: Record<string, string[]>,
  reason: string,
  requestedBy: string
): Promise<string> {
  const actionId = crypto.randomUUID();
  await env.DB.prepare(
    'INSERT INTO pending_ban_actions (id, user_ids, reason, delete_messages, requested_by) VALUES (?, ?, ?, ?, ?)'
  ).bind(actionId, JSON.stringify(missingBans), reason, 0, requestedBy).run();
  return actionId;
}
