-- Autonomous site memory procedure cache for the general browser agent.
--
-- Records verified interaction recipes keyed by root_domain (and optional category),
-- allowing subsequent tasks on the same site to skip exploratory guessing and
-- immediately execute known selectors, consent dismissals, and navigation flows.

CREATE TABLE IF NOT EXISTS hire_site_procedures (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  root_domain TEXT NOT NULL,
  task_category TEXT NOT NULL DEFAULT 'general',
  procedure JSONB NOT NULL,
  success_count INT NOT NULL DEFAULT 1,
  last_verified_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT unique_site_procedure UNIQUE (root_domain, task_category)
);

CREATE INDEX IF NOT EXISTS idx_site_procedures_domain ON hire_site_procedures (root_domain);
