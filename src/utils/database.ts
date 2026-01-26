import { Env } from '../types/env';
import { ModerationCase } from '../types/database';

/**
 * Database utility functions for moderation cases
 */

/**
 * Get next case number for a guild
 */
export async function getNextCaseNumber(env: Env, guildId: string): Promise<number> {
  const result = await env.DB.prepare(
    'SELECT MAX(case_number) as max_case FROM moderation_cases WHERE guild_id = ?'
  ).bind(guildId).first<{ max_case: number | null }>();

  return (result?.max_case || 0) + 1;
}

/**
 * Create a new moderation case
 */
export async function createModerationCase(
  env: Env,
  data: {
    guildId: string;
    userId: string;
    moderatorId: string;
    actionType: string;
    reason?: string;
    duration?: number;
    expiresAt?: string;
  }
): Promise<number> {
  const caseNumber = await getNextCaseNumber(env, data.guildId);

  const result = await env.DB.prepare(
    `INSERT INTO moderation_cases 
    (guild_id, case_number, user_id, moderator_id, action_type, reason, duration, expires_at, active)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)`
  )
    .bind(
      data.guildId,
      caseNumber,
      data.userId,
      data.moderatorId,
      data.actionType,
      data.reason || null,
      data.duration || null,
      data.expiresAt || null
    )
    .run();

  // Create infraction record
  await env.DB.prepare(
    `INSERT INTO user_infractions (user_id, guild_id, infraction_type, case_id)
    VALUES (?, ?, ?, ?)`
  )
    .bind(data.userId, data.guildId, data.actionType, result.meta.last_row_id)
    .run();

  return caseNumber;
}

/**
 * Get a specific case
 */
export async function getModerationCase(
  env: Env,
  guildId: string,
  caseNumber: number
): Promise<ModerationCase | null> {
  const result = await env.DB.prepare(
    'SELECT * FROM moderation_cases WHERE guild_id = ? AND case_number = ?'
  ).bind(guildId, caseNumber).first<ModerationCase>();

  return result;
}

/**
 * Get user's moderation history
 */
export async function getUserHistory(
  env: Env,
  guildId: string,
  userId: string,
  limit: number = 10
): Promise<ModerationCase[]> {
  const results = await env.DB.prepare(
    `SELECT * FROM moderation_cases 
    WHERE guild_id = ? AND user_id = ? 
    ORDER BY created_at DESC 
    LIMIT ?`
  )
    .bind(guildId, userId, limit)
    .all<ModerationCase>();

  return results.results || [];
}

/**
 * Get active warnings for a user
 */
export async function getActiveWarnings(
  env: Env,
  guildId: string,
  userId: string
): Promise<ModerationCase[]> {
  const results = await env.DB.prepare(
    `SELECT * FROM moderation_cases 
    WHERE guild_id = ? AND user_id = ? AND action_type = 'warn' AND active = 1
    ORDER BY created_at DESC`
  )
    .bind(guildId, userId)
    .all<ModerationCase>();

  return results.results || [];
}

/**
 * Update case reason
 */
export async function updateCaseReason(
  env: Env,
  guildId: string,
  caseNumber: number,
  reason: string
): Promise<boolean> {
  const result = await env.DB.prepare(
    'UPDATE moderation_cases SET reason = ? WHERE guild_id = ? AND case_number = ?'
  ).bind(reason, guildId, caseNumber).run();

  return result.meta.changes > 0;
}

/**
 * Deactivate a case (for expired timeouts, unbans, etc.)
 */
export async function deactivateCase(
  env: Env,
  guildId: string,
  caseNumber: number
): Promise<void> {
  await env.DB.prepare(
    'UPDATE moderation_cases SET active = 0 WHERE guild_id = ? AND case_number = ?'
  ).bind(guildId, caseNumber).run();
}

/**
 * Update case with message ID
 */
export async function updateCaseMessageId(
  env: Env,
  guildId: string,
  caseNumber: number,
  messageId: string
): Promise<void> {
  await env.DB.prepare(
    'UPDATE moderation_cases SET message_id = ? WHERE guild_id = ? AND case_number = ?'
  ).bind(messageId, guildId, caseNumber).run();
}

/**
 * Get moderation statistics for a guild
 */
export async function getGuildModStats(
  env: Env,
  guildId: string
): Promise<Record<string, number>> {
  const results = await env.DB.prepare(
    `SELECT action_type, COUNT(*) as count 
    FROM moderation_cases 
    WHERE guild_id = ? 
    GROUP BY action_type`
  )
    .bind(guildId)
    .all<{ action_type: string; count: number }>();

  const stats: Record<string, number> = {};
  for (const row of results.results || []) {
    stats[row.action_type] = row.count;
  }

  return stats;
}

/**
 * Get total infraction count for a user
 */
export async function getUserInfractionCount(
  env: Env,
  guildId: string,
  userId: string
): Promise<number> {
  const result = await env.DB.prepare(
    'SELECT COUNT(*) as count FROM user_infractions WHERE guild_id = ? AND user_id = ?'
  ).bind(guildId, userId).first<{ count: number }>();

  return result?.count || 0;
}
