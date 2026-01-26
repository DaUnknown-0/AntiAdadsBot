-- Migration 0002b: Create global_bans table
-- This table tracks global bans across servers

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

-- Create indexes for efficient querying
CREATE INDEX IF NOT EXISTS idx_global_bans_status ON global_bans(status);
CREATE INDEX IF NOT EXISTS idx_global_bans_user ON global_bans(user_id);
CREATE INDEX IF NOT EXISTS idx_global_bans_created ON global_bans(created_at);
