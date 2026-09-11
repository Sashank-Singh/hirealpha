-- Canonical base schemas for the two runtime tables the browser pipeline alters.
--
-- History: hire_spend_approvals and hire_browser_jobs were historically created
-- at web boot by ensureUserPaymentsSchema / ensureBrowserJobsSchema, so
-- migrations 0007/0008 (which ALTER them) silently assumed a prior boot. On a
-- blank database — staging init, DR restore, certification — 0007 failed with
-- 'relation does not exist'. This migration makes the chain self-contained.
--
-- It is deliberately positioned between 0006 and 0007 (13-digit name) so a
-- blank database reaches a complete schema in one ordered pass.
--
-- Reconciliation: CREATE TABLE IF NOT EXISTS plus ADD COLUMN IF NOT EXISTS for
-- every column means an existing production table (which may predate any column
-- added later by the ensure* functions) is brought to the same shape without
-- touching its data. 0007/0008 re-state their ALTERs as IF NOT EXISTS no-ops.
-- The runtime ensure* functions remain as compatibility checks; this migration
-- is the schema owner.

-- ---------------------------------------------------------------- spend ----
CREATE TABLE IF NOT EXISTS hire_spend_approvals (
  id UUID PRIMARY KEY,
  user_id UUID NOT NULL,
  amount_cents INTEGER NOT NULL,
  merchant TEXT NOT NULL,
  purpose TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  payment_intent_id TEXT,
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  decided_at TIMESTAMPTZ,
  consumed_at TIMESTAMPTZ,
  paid_at TIMESTAMPTZ,
  finalization_status TEXT NOT NULL DEFAULT 'pending',
  finalization_job_id UUID,
  order_confirmation TEXT,
  link_spend_request_id TEXT,
  link_approval_url TEXT,
  merchant_url TEXT
);

ALTER TABLE hire_spend_approvals ADD COLUMN IF NOT EXISTS payment_intent_id TEXT;
ALTER TABLE hire_spend_approvals ADD COLUMN IF NOT EXISTS last_error TEXT;
ALTER TABLE hire_spend_approvals ADD COLUMN IF NOT EXISTS decided_at TIMESTAMPTZ;
ALTER TABLE hire_spend_approvals ADD COLUMN IF NOT EXISTS consumed_at TIMESTAMPTZ;
ALTER TABLE hire_spend_approvals ADD COLUMN IF NOT EXISTS paid_at TIMESTAMPTZ;
ALTER TABLE hire_spend_approvals ADD COLUMN IF NOT EXISTS finalization_status TEXT NOT NULL DEFAULT 'pending';
ALTER TABLE hire_spend_approvals ADD COLUMN IF NOT EXISTS finalization_job_id UUID;
ALTER TABLE hire_spend_approvals ADD COLUMN IF NOT EXISTS order_confirmation TEXT;
ALTER TABLE hire_spend_approvals ADD COLUMN IF NOT EXISTS link_spend_request_id TEXT;
ALTER TABLE hire_spend_approvals ADD COLUMN IF NOT EXISTS link_approval_url TEXT;
ALTER TABLE hire_spend_approvals ADD COLUMN IF NOT EXISTS merchant_url TEXT;

CREATE INDEX IF NOT EXISTS idx_hire_spend_approvals_user ON hire_spend_approvals (user_id, status);
CREATE UNIQUE INDEX IF NOT EXISTS idx_hire_spend_link_id ON hire_spend_approvals (link_spend_request_id) WHERE link_spend_request_id IS NOT NULL;

-- --------------------------------------------------------------- browser ----
CREATE TABLE IF NOT EXISTS hire_browser_jobs (
  id UUID PRIMARY KEY,
  user_id UUID NOT NULL,
  persona TEXT NOT NULL,
  phone_e164 TEXT,
  kind TEXT NOT NULL,
  url TEXT NOT NULL,
  steps JSONB,
  goal TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  attempts INTEGER NOT NULL DEFAULT 0,
  result TEXT,
  error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  claimed_at TIMESTAMPTZ,
  finished_at TIMESTAMPTZ,
  approval_id UUID,
  vault_item_id UUID,
  current_url TEXT,
  activity JSONB NOT NULL DEFAULT '[]'::jsonb,
  handoff_kind TEXT,
  handoff_message TEXT,
  handoff_at TIMESTAMPTZ,
  handoff_resumed_at TIMESTAMPTZ,
  spend_request_id UUID
);

ALTER TABLE hire_browser_jobs ADD COLUMN IF NOT EXISTS approval_id UUID;
ALTER TABLE hire_browser_jobs ADD COLUMN IF NOT EXISTS vault_item_id UUID;
ALTER TABLE hire_browser_jobs ADD COLUMN IF NOT EXISTS credential_capability_id UUID;
ALTER TABLE hire_browser_jobs ADD COLUMN IF NOT EXISTS credential_capability_digest TEXT;
ALTER TABLE hire_browser_jobs ADD COLUMN IF NOT EXISTS credential_task_id TEXT;
ALTER TABLE hire_browser_jobs ADD COLUMN IF NOT EXISTS spend_request_id UUID;
ALTER TABLE hire_browser_jobs ADD COLUMN IF NOT EXISTS current_url TEXT;
ALTER TABLE hire_browser_jobs ADD COLUMN IF NOT EXISTS activity JSONB NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE hire_browser_jobs ADD COLUMN IF NOT EXISTS handoff_kind TEXT;
ALTER TABLE hire_browser_jobs ADD COLUMN IF NOT EXISTS handoff_message TEXT;
ALTER TABLE hire_browser_jobs ADD COLUMN IF NOT EXISTS handoff_at TIMESTAMPTZ;
ALTER TABLE hire_browser_jobs ADD COLUMN IF NOT EXISTS handoff_resumed_at TIMESTAMPTZ;

CREATE UNIQUE INDEX IF NOT EXISTS idx_hire_browser_jobs_approval ON hire_browser_jobs (approval_id) WHERE approval_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_hire_browser_jobs_spend_request ON hire_browser_jobs (spend_request_id) WHERE spend_request_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_hire_browser_jobs_status ON hire_browser_jobs (status, created_at);
