-- Migration 0003: Ensure guild_configs has all required columns
-- This migration safely adds any missing columns without data loss

PRAGMA foreign_keys = OFF;

-- Create a new table with the complete schema
CREATE TABLE IF NOT EXISTS guild_configs_final (
    guild_id TEXT PRIMARY KEY,
    mod_log_channel_id TEXT,
    mod_role_ids TEXT DEFAULT '[]',
    helper_role_ids TEXT DEFAULT '[]',
    moderator_role_ids TEXT DEFAULT '[]',
    admin_role_ids TEXT DEFAULT '[]',
    automod_enabled INTEGER DEFAULT 0,
    automod_spam INTEGER DEFAULT 0,
    automod_caps INTEGER DEFAULT 0,
    automod_invites INTEGER DEFAULT 0,
    automod_mentions INTEGER DEFAULT 0,
    welcome_message TEXT,
    welcome_channel_id TEXT,
    leave_message TEXT,
    leave_channel_id TEXT,
    global_bans_enabled INTEGER DEFAULT 0,
    command_permissions TEXT DEFAULT '{}',
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
);

-- Copy data from existing guild_configs (selecting only available columns)
INSERT OR IGNORE INTO guild_configs_final (guild_id, mod_log_channel_id, global_bans_enabled)
SELECT
  guild_id,
  mod_log_channel_id,
  COALESCE(global_bans_enabled, 0)
FROM guild_configs;

-- Drop old table and rename
DROP TABLE guild_configs;
ALTER TABLE guild_configs_final RENAME TO guild_configs;

PRAGMA foreign_keys = ON;
