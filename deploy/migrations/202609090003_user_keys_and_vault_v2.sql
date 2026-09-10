CREATE TABLE IF NOT EXISTS user_wrapped_keys (
  user_id TEXT PRIMARY KEY REFERENCES hire_users(id) ON DELETE CASCADE,
  wrapped_dek TEXT,
  key_version INTEGER NOT NULL CHECK (key_version > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  rotated_at TIMESTAMPTZ,
  destroyed_at TIMESTAMPTZ,
  CONSTRAINT wrapped_key_lifecycle CHECK (
    (destroyed_at IS NULL AND wrapped_dek IS NOT NULL)
    OR (destroyed_at IS NOT NULL AND wrapped_dek IS NULL)
  )
);

CREATE TABLE IF NOT EXISTS vault_items_v2 (
  id UUID PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES hire_users(id) ON DELETE CASCADE,
  exact_origin TEXT NOT NULL CHECK (exact_origin ~ '^https://[^/]+$'),
  label TEXT NOT NULL,
  username_hint TEXT,
  ciphertext TEXT NOT NULL CHECK (ciphertext LIKE 'v2.%'),
  encryption_version INTEGER NOT NULL CHECK (encryption_version > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  revoked_at TIMESTAMPTZ,
  UNIQUE (user_id, exact_origin, label)
);

CREATE INDEX IF NOT EXISTS vault_items_v2_user_origin_idx ON vault_items_v2 (user_id, exact_origin) WHERE revoked_at IS NULL;
