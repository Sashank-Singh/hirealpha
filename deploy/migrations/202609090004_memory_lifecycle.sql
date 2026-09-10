CREATE TABLE consent_records (
  id UUID PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES hire_users(id) ON DELETE CASCADE,
  resource_type TEXT NOT NULL CHECK (resource_type IN ('memory', 'credential', 'payment', 'computer')),
  category TEXT,
  purpose TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('granted', 'revoked', 'expired')),
  granted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ
);

CREATE INDEX consent_records_active_idx ON consent_records (user_id, resource_type, category, purpose)
  WHERE status = 'granted';

CREATE TABLE memory_records (
  id UUID PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES hire_users(id) ON DELETE CASCADE,
  category TEXT NOT NULL CHECK (category IN ('identity', 'preference', 'relationship', 'work', 'health', 'financial', 'other')),
  purpose TEXT NOT NULL,
  ciphertext TEXT CHECK (ciphertext IS NULL OR ciphertext LIKE 'v2.%'),
  source TEXT,
  consent_id UUID NOT NULL REFERENCES consent_records(id),
  retention_days INTEGER NOT NULL CHECK (retention_days > 0 AND retention_days <= 365),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL,
  deleted_at TIMESTAMPTZ,
  deletion_reason TEXT CHECK (deletion_reason IS NULL OR deletion_reason IN ('user_request', 'retention_expired', 'account_deletion')),
  CONSTRAINT memory_deletion_state CHECK (
    (deleted_at IS NULL AND ciphertext IS NOT NULL AND deletion_reason IS NULL)
    OR (deleted_at IS NOT NULL AND ciphertext IS NULL AND deletion_reason IS NOT NULL)
  )
);

CREATE INDEX memory_records_active_idx ON memory_records (user_id, category, expires_at) WHERE deleted_at IS NULL;
