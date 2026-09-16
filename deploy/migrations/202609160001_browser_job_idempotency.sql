-- One explicit task may have only one live browser for the same user, persona,
-- and canonical URL. Retire pre-existing duplicates before enforcing the rule.
-- Login task authorization now comes from the user's task/Open action, so old
-- pending login prompts must not remain visible after this policy transition.
UPDATE hire_browser_approvals
SET status = 'denied', decided_at = now()
WHERE status = 'pending';

UPDATE capability_grants
SET status = 'expired', decided_at = now()
WHERE status = 'pending' AND resource_type = 'credential' AND action = 'autofill';

WITH ranked AS (
  SELECT id,
    row_number() OVER (
      PARTITION BY user_id, persona, url
      ORDER BY created_at ASC, id ASC
    ) AS position
  FROM hire_browser_jobs
  WHERE status IN ('pending', 'running', 'waiting')
)
UPDATE hire_browser_jobs AS jobs
SET status = 'failed',
    error = 'Duplicate active browser session retired during idempotency migration.',
    finished_at = now()
FROM ranked
WHERE jobs.id = ranked.id AND ranked.position > 1;

CREATE UNIQUE INDEX IF NOT EXISTS idx_hire_browser_jobs_one_active_site
  ON hire_browser_jobs (user_id, persona, url)
  WHERE status IN ('pending', 'running', 'waiting');
