-- migrate: no-transaction
-- Durable Phase 3 execution state. Additive and safe to re-run.
ALTER TABLE hire_scheduled_texts ADD COLUMN IF NOT EXISTS lease_until TIMESTAMPTZ;
ALTER TABLE hire_scheduled_texts ADD COLUMN IF NOT EXISTS claim_token UUID;
ALTER TABLE hire_scheduled_texts ADD COLUMN IF NOT EXISTS provider_delivery_id TEXT;
ALTER TABLE hire_scheduled_texts ADD COLUMN IF NOT EXISTS attempt_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE hire_scheduled_texts ADD COLUMN IF NOT EXISTS idempotency_key TEXT;
ALTER TABLE hire_scheduled_texts ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now();

-- migrate: statement-break
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS idx_hire_scheduled_texts_idempotency
  ON hire_scheduled_texts (idempotency_key) WHERE idempotency_key IS NOT NULL;
-- migrate: statement-break
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_hire_scheduled_texts_claim
  ON hire_scheduled_texts (persona, send_at) WHERE status = 'pending';
-- migrate: statement-break
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_hire_scheduled_texts_lease
  ON hire_scheduled_texts (lease_until) WHERE status IN ('preparing', 'sending');
