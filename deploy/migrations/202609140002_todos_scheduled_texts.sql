-- To-do list + scheduled send-on-behalf (bench50 gaps #5, #14).
-- Idempotent: safe to re-run; the migration chain applies it once.

CREATE TABLE IF NOT EXISTS hire_todos (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id TEXT NOT NULL REFERENCES hire_users(id) ON DELETE CASCADE,
  text TEXT NOT NULL,
  done BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_hire_todos_user ON hire_todos (user_id, done, created_at DESC);

CREATE TABLE IF NOT EXISTS hire_scheduled_texts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id TEXT NOT NULL REFERENCES hire_users(id) ON DELETE CASCADE,
  persona TEXT NOT NULL DEFAULT 'friend',
  to_phone TEXT NOT NULL,
  body TEXT NOT NULL,
  send_at TIMESTAMPTZ NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  sent_at TIMESTAMPTZ,
  error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_hire_scheduled_texts_due
  ON hire_scheduled_texts (status, send_at);
