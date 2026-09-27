-- migrate: no-transaction
-- This migration is intentionally resumable. The concurrent index cannot be
-- created inside the runner's normal transaction; the ledger row is written
-- only after every statement succeeds. IF NOT EXISTS and the explicit index
-- reset make a retry safe even if a prior concurrent build was interrupted.
CREATE TABLE IF NOT EXISTS hire_drafts (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES hire_users(id) ON DELETE CASCADE,
  persona TEXT NOT NULL DEFAULT '',
  kind TEXT NOT NULL DEFAULT 'email',
  to_addr TEXT NOT NULL DEFAULT '',
  subject TEXT NOT NULL DEFAULT '',
  body TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE hire_drafts
  ADD COLUMN IF NOT EXISTS provider_id TEXT,
  ADD COLUMN IF NOT EXISTS operation_key TEXT,
  ADD COLUMN IF NOT EXISTS source_message_id TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS version INTEGER NOT NULL DEFAULT 1;

-- migrate: statement-break
DROP INDEX CONCURRENTLY IF EXISTS hire_drafts_pending_operation_idx;

-- migrate: statement-break
CREATE UNIQUE INDEX CONCURRENTLY hire_drafts_pending_operation_idx
  ON hire_drafts (user_id, operation_key)
  WHERE operation_key IS NOT NULL AND status IN ('pending', 'sending', 'booking', 'outcome_unknown');
