-- migrate: no-transaction
CREATE TABLE IF NOT EXISTS hire_email_followups (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id TEXT NOT NULL REFERENCES hire_users(id) ON DELETE CASCADE,
  persona TEXT NOT NULL,
  gmail_thread_id TEXT NOT NULL,
  expected_participant TEXT NOT NULL,
  direction TEXT NOT NULL DEFAULT 'inbound',
  deadline TIMESTAMPTZ NOT NULL,
  condition TEXT NOT NULL DEFAULT 'no_reply',
  status TEXT NOT NULL DEFAULT 'pending',
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS hire_file_sends (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id TEXT NOT NULL REFERENCES hire_users(id) ON DELETE CASCADE,
  persona TEXT NOT NULL,
  recipient TEXT NOT NULL,
  drive_file_id TEXT NOT NULL,
  source_thread_id TEXT,
  draft_version INTEGER NOT NULL DEFAULT 1,
  mode TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  provider_id TEXT,
  error TEXT,
  operation_key TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- migrate: statement-break
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_hire_email_followups_due
  ON hire_email_followups (deadline) WHERE status = 'pending';
-- migrate: statement-break
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS idx_hire_file_sends_operation
  ON hire_file_sends (user_id, operation_key);
