CREATE TABLE capability_grants (
  id UUID PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES hire_users(id) ON DELETE CASCADE,
  task_id TEXT NOT NULL,
  resource_type TEXT NOT NULL CHECK (resource_type IN ('credential', 'payment', 'memory', 'computer')),
  resource_id TEXT,
  action TEXT NOT NULL,
  exact_origin TEXT CHECK (exact_origin IS NULL OR exact_origin ~ '^https://[^/]+$'),
  amount_cents INTEGER CHECK (amount_cents IS NULL OR amount_cents > 0),
  currency TEXT CHECK (currency IS NULL OR currency ~ '^[A-Z]{3}$'),
  merchant TEXT,
  recipient TEXT,
  cart JSONB NOT NULL DEFAULT '[]'::jsonb,
  requesting_agent TEXT NOT NULL,
  purpose TEXT NOT NULL,
  request_digest BYTEA NOT NULL CHECK (octet_length(request_digest) = 32),
  status TEXT NOT NULL CHECK (status IN (
    'proposed', 'pending', 'approved', 'consuming', 'consumed',
    'denied', 'revoked', 'expired', 'needs_reconciliation'
  )),
  provider_reference TEXT,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  decided_at TIMESTAMPTZ,
  approved_at TIMESTAMPTZ,
  consuming_at TIMESTAMPTZ,
  consumed_at TIMESTAMPTZ,
  finalized_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ,
  revocation_requested_at TIMESTAMPTZ,
  CONSTRAINT capability_payment_scope CHECK (
    (resource_type = 'payment' AND amount_cents IS NOT NULL AND currency IS NOT NULL AND merchant IS NOT NULL)
    OR
    (resource_type <> 'payment' AND amount_cents IS NULL AND currency IS NULL AND merchant IS NULL AND recipient IS NULL AND cart = '[]'::jsonb)
  )
);

CREATE INDEX capability_grants_user_status_idx ON capability_grants (user_id, status, expires_at);
CREATE INDEX capability_grants_task_idx ON capability_grants (task_id, created_at DESC);
CREATE UNIQUE INDEX capability_grants_provider_reference_idx
  ON capability_grants (provider_reference) WHERE provider_reference IS NOT NULL;

CREATE TABLE audit_events (
  sequence BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  id UUID NOT NULL UNIQUE,
  user_id TEXT NOT NULL REFERENCES hire_users(id) ON DELETE CASCADE,
  task_id TEXT,
  capability_grant_id UUID REFERENCES capability_grants(id) ON DELETE SET NULL,
  event_type TEXT NOT NULL,
  resource_type TEXT,
  outcome TEXT NOT NULL,
  safe_metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  previous_hash BYTEA,
  event_hash BYTEA NOT NULL CHECK (octet_length(event_hash) = 32),
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX audit_events_user_time_idx ON audit_events (user_id, occurred_at DESC);
CREATE INDEX audit_events_task_idx ON audit_events (task_id, sequence) WHERE task_id IS NOT NULL;

CREATE FUNCTION prevent_audit_event_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'audit_events is append-only';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER audit_events_no_update
  BEFORE UPDATE OR DELETE ON audit_events
  FOR EACH ROW EXECUTE FUNCTION prevent_audit_event_mutation();

-- certification: body modified after application
