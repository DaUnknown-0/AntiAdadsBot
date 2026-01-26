-- Migration 0001: Initial schema
-- Create guild configurations table
CREATE TABLE IF NOT EXISTS guild_configs (
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
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
);

-- Create moderation cases table
CREATE TABLE IF NOT EXISTS moderation_cases (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    guild_id TEXT NOT NULL,
    case_number INTEGER NOT NULL,
    user_id TEXT NOT NULL,
    moderator_id TEXT NOT NULL,
    action_type TEXT NOT NULL,
    reason TEXT,
    duration INTEGER,
    expires_at TEXT,
    active INTEGER DEFAULT 1,
    message_id TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    UNIQUE(guild_id, case_number)
);

-- Create index for faster lookups
CREATE INDEX IF NOT EXISTS idx_moderation_cases_guild_user 
    ON moderation_cases(guild_id, user_id);
CREATE INDEX IF NOT EXISTS idx_moderation_cases_active 
    ON moderation_cases(guild_id, active);

-- Create user infractions table for tracking
CREATE TABLE IF NOT EXISTS user_infractions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL,
    guild_id TEXT NOT NULL,
    infraction_type TEXT NOT NULL,
    case_id INTEGER NOT NULL,
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (case_id) REFERENCES moderation_cases(id)
);

-- Create index for infraction lookups
CREATE INDEX IF NOT EXISTS idx_user_infractions_lookup 
    ON user_infractions(user_id, guild_id);

-- Create scheduled actions table
CREATE TABLE IF NOT EXISTS scheduled_actions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    guild_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    action_type TEXT NOT NULL,
    execute_at TEXT NOT NULL,
    case_id INTEGER,
    completed INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (case_id) REFERENCES moderation_cases(id)
);

-- Create index for scheduled action lookups
CREATE INDEX IF NOT EXISTS idx_scheduled_actions_pending 
    ON scheduled_actions(guild_id, execute_at, completed);
