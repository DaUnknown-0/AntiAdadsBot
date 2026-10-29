CREATE TABLE IF NOT EXISTS bot_jobs (
  id TEXT PRIMARY KEY,
  request_key TEXT UNIQUE,
  title TEXT NOT NULL,
  moderator_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('running', 'cancel_requested', 'completed', 'failed', 'cancelled')),
  summary TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  lease_until INTEGER NOT NULL
);
-- Serialize global moderation work so manual and scheduled runs cannot overlap.
CREATE UNIQUE INDEX IF NOT EXISTS idx_bot_jobs_active ON bot_jobs((1)) WHERE status IN ('running', 'cancel_requested');
CREATE INDEX IF NOT EXISTS idx_bot_jobs_updated ON bot_jobs(updated_at);
ALTER TABLE pending_ban_actions ADD COLUMN claim_until INTEGER NOT NULL DEFAULT 0;
ALTER TABLE pending_ban_actions ADD COLUMN claim_token TEXT;
