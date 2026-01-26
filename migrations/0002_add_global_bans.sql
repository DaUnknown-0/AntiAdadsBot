-- Migration 0002: Add global_bans table for tracking global bans
-- This migration already ran, keeping only the global_bans table creation for reference
CREATE TABLE IF NOT EXISTS global_bans (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  requested_by TEXT,
  reason TEXT,
  delete_messages INTEGER DEFAULT 0,
  status TEXT DEFAULT 'pending',
  attempts INTEGER DEFAULT 0,
  last_error TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_global_bans_status ON global_bans(status);
CREATE INDEX IF NOT EXISTS idx_global_bans_user ON global_bans(user_id);