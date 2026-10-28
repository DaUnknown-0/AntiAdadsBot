import { Env } from '../types/env';

export async function getGuildsWithGlobalBansEnabled(env: Env): Promise<string[]> {
  const results = await env.DB.prepare(
    'SELECT guild_id FROM guild_configs WHERE global_bans_enabled = 1'
  ).all<{ guild_id: string }>();

  return (results.results || []).map(r => r.guild_id);
}

export async function getGlobalBanList(env: Env): Promise<Array<{ user_id: string; reason: string | null }>> {
  const results = await env.DB.prepare(
    'SELECT DISTINCT user_id, reason FROM global_bans WHERE status = "completed" ORDER BY created_at DESC'
  ).all<{ user_id: string; reason: string | null }>();

  return results.results || [];
}

export async function addUsersToGlobalBanQueue(
  env: Env,
  userIds: string[],
  reason: string,
  requestedBy: string | null,
  deleteMessages: number
): Promise<Array<{ id: string; user_id: string }>> {
  const created = new Date().toISOString();
  const inserted: Array<{ id: string; user_id: string }> = [];

  for (const userId of userIds) {
    const id = crypto.randomUUID();
    const sql = `INSERT INTO global_bans (id, user_id, requested_by, reason, delete_messages, status, attempts, last_error, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'pending', 0, NULL, ?, ?)`;
    await env.DB.prepare(sql).bind(id, userId, requestedBy, reason, deleteMessages, created, created).run();
    inserted.push({ id, user_id: userId });
  }

  return inserted;
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
  const [scheduledActionsResult, userInfractionsResult, moderationCasesResult, globalBanRowsResult] = await env.DB.batch([
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
  ]);

  return {
    scheduledActionsDeleted: scheduledActionsResult.meta.changes,
    userInfractionsDeleted: userInfractionsResult.meta.changes,
    moderationCasesDeleted: moderationCasesResult.meta.changes,
    globalBanRowsDeleted: globalBanRowsResult.meta.changes,
  };
}