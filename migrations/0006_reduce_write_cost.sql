-- Migration 0006: Opt-in automatic enforcement, and fewer rows written per ban

-- Hourly automatic re-ban (Cron Trigger) only runs in servers that enabled it via /toggleautoenforce
ALTER TABLE guild_configs ADD COLUMN auto_enforce_enabled INTEGER DEFAULT 0;

-- D1 free plan: 100,000 written rows per day, and every index entry counts as an extra written row.
-- A ban used to write about 8 rows (case + 4 indexes, infraction + 2 indexes). Nothing reads these
-- two indexes, and the worker no longer writes user_infractions, so a ban now writes 3 rows:
-- the case, the UNIQUE(guild_id, case_number) index and idx_moderation_cases_user_action.
DROP INDEX IF EXISTS idx_moderation_cases_guild_user;
DROP INDEX IF EXISTS idx_moderation_cases_active;
