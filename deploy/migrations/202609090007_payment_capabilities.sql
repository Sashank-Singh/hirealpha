ALTER TABLE hire_spend_approvals
  ADD COLUMN IF NOT EXISTS capability_grant_id UUID REFERENCES capability_grants(id) ON DELETE SET NULL;

CREATE UNIQUE INDEX IF NOT EXISTS hire_spend_approvals_capability_idx
  ON hire_spend_approvals (capability_grant_id) WHERE capability_grant_id IS NOT NULL;
