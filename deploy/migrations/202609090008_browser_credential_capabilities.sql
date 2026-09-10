ALTER TABLE hire_browser_jobs ADD COLUMN IF NOT EXISTS vault_item_id UUID REFERENCES vault_items_v2(id) ON DELETE SET NULL;
ALTER TABLE hire_browser_jobs ADD COLUMN IF NOT EXISTS credential_capability_id UUID REFERENCES capability_grants(id) ON DELETE SET NULL;
ALTER TABLE hire_browser_jobs ADD COLUMN IF NOT EXISTS credential_capability_digest TEXT;
ALTER TABLE hire_browser_jobs ADD COLUMN IF NOT EXISTS credential_task_id TEXT;

ALTER TABLE hire_browser_jobs ADD CONSTRAINT browser_job_credential_capability_complete CHECK (
  (credential_capability_id IS NULL AND credential_capability_digest IS NULL AND credential_task_id IS NULL AND vault_item_id IS NULL)
  OR
  (credential_capability_id IS NOT NULL AND credential_capability_digest ~ '^[a-f0-9]{64}$'
    AND credential_task_id IS NOT NULL AND vault_item_id IS NOT NULL)
);

CREATE UNIQUE INDEX IF NOT EXISTS hire_browser_jobs_credential_capability_idx
  ON hire_browser_jobs (credential_capability_id) WHERE credential_capability_id IS NOT NULL;
