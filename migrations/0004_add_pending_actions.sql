-- Migration: Add pending actions table for button interactions
CREATE TABLE IF NOT EXISTS pending_ban_actions (
  id TEXT PRIMARY KEY,
  user_ids TEXT NOT NULL, -- JSON array of user IDs
  reason TEXT,
  delete_messages INTEGER DEFAULT 0,
  requested_by TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now')),
  expires_at TEXT DEFAULT (datetime('now', '+1 hour'))
);

-- Index for cleanup
CREATE INDEX IF NOT EXISTS idx_pending_actions_expires ON pending_ban_actions(expires_at);
