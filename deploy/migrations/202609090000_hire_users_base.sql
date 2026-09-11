-- Canonical base schema for hire_users.
--
-- Every trust-chain migration (0001 onward) foreign-keys hire_users(id), but
-- that table was historically created only at web boot (ensureHireSchema). A
-- blank database — staging init, DR restore, certification — therefore failed
-- migration 0001 with 'relation "hire_users" does not exist', and the failure
-- surfaced as a masked 'current transaction is aborted' on the next statement.
--
-- This migration makes the chain self-contained: hire_users is created with the
-- full current shape and reconciled with ADD COLUMN IF NOT EXISTS, so an
-- existing production table is untouched. ensureHireSchema remains the owner of
-- any future columns; its CREATE/ALTER statements are idempotent no-ops here.

CREATE TABLE IF NOT EXISTS hire_users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  name TEXT,
  timezone TEXT,
  phone_e164 TEXT UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE hire_users ADD COLUMN IF NOT EXISTS name TEXT;
ALTER TABLE hire_users ADD COLUMN IF NOT EXISTS assigned_phone TEXT;
ALTER TABLE hire_users ADD COLUMN IF NOT EXISTS timezone TEXT;
ALTER TABLE hire_users ADD COLUMN IF NOT EXISTS password_hash TEXT;
