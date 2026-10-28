-- Migration 0005: Global ban list as single source of truth, plus missing indexes
--
-- global_bans stays as the task table behind the /global-bans HTTP API.
-- global_ban_list holds exactly one row per globally banned user.

CREATE TABLE IF NOT EXISTS global_ban_list (
  user_id TEXT PRIMARY KEY,
  reason TEXT,
  added_by TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_global_ban_list_created ON global_ban_list(created_at);

-- Backfill 1: everyone who was ever queued through the worker or the API
INSERT OR IGNORE INTO global_ban_list (user_id, reason, added_by, created_at)
SELECT user_id, reason, requested_by, MIN(created_at)
FROM global_bans
GROUP BY user_id;

-- Backfill 2: users banned in 2+ servers (same rule /exportglobalbans used so far,
-- covers /globalban, which never wrote to global_bans)
INSERT OR IGNORE INTO global_ban_list (user_id, reason, added_by, created_at)
SELECT user_id, reason, moderator_id, MIN(created_at)
FROM moderation_cases
WHERE action_type = 'ban'
GROUP BY user_id
HAVING COUNT(DISTINCT guild_id) >= 2;

-- Indexes for purge/export lookups and the infraction NOT EXISTS check
CREATE INDEX IF NOT EXISTS idx_moderation_cases_user_action ON moderation_cases(user_id, action_type);
CREATE INDEX IF NOT EXISTS idx_user_infractions_case ON user_infractions(case_id);
CREATE INDEX IF NOT EXISTS idx_guild_configs_global_bans ON guild_configs(global_bans_enabled);
