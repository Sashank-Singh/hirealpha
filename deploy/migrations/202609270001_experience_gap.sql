-- Experience-gap pass: durable thread reply-state and typed turn anchors.
-- Additive only; resumable.

-- One row per Gmail thread Alpha has touched (sent into, watched, or read in
-- the waiting-on paths). `awaiting` answers "who owes the next move" without
-- scanning a 2-day mailbox window:
--   them -> Alpha/user sent last; the participant owes a reply
--   me   -> the participant sent last; the user owes a reply
--   none -> resolved or informational
CREATE TABLE IF NOT EXISTS hire_thread_state (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES hire_users(id) ON DELETE CASCADE,
  persona TEXT NOT NULL DEFAULT '',
  thread_id TEXT NOT NULL,
  participant TEXT NOT NULL DEFAULT '',
  subject TEXT NOT NULL DEFAULT '',
  direction TEXT NOT NULL DEFAULT 'inbound',
  awaiting TEXT NOT NULL DEFAULT 'none',
  last_message_id TEXT NOT NULL DEFAULT '',
  last_activity_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, persona, thread_id)
);
CREATE INDEX IF NOT EXISTS hire_thread_state_awaiting_idx
  ON hire_thread_state (user_id, persona, awaiting, last_activity_at DESC);

-- Typed references to the objects the conversation is currently about, so a
-- process/container restart does not orphan "send it", "move that", or
-- "cancel that". One active anchor per (user, persona, kind); rows expire.
CREATE TABLE IF NOT EXISTS hire_turn_anchors (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES hire_users(id) ON DELETE CASCADE,
  persona TEXT NOT NULL,
  kind TEXT NOT NULL,
  ref JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL,
  UNIQUE (user_id, persona, kind)
);
CREATE INDEX IF NOT EXISTS hire_turn_anchors_expiry_idx ON hire_turn_anchors (expires_at);

-- Contact upsert-by-name: collapse duplicates, then enforce one row per person
-- per account so "add alex" merges instead of cloning.
DELETE FROM hire_network a USING hire_network b
  WHERE a.user_id = b.user_id AND lower(a.name) = lower(b.name) AND a.id < b.id;
CREATE UNIQUE INDEX IF NOT EXISTS hire_network_user_name_key ON hire_network (user_id, lower(name));
