-- Phase 1 wiring (beat-instinct plan): the browser job is the EXECUTING arm of
-- a canonical task. One nullable link; the task record owns the lifecycle.
-- Idempotent: safe to re-run. hire_tasks is created by 202609140003 (earlier).

ALTER TABLE hire_browser_jobs
  ADD COLUMN IF NOT EXISTS task_id UUID REFERENCES hire_tasks(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_hire_browser_jobs_task
  ON hire_browser_jobs (task_id) WHERE task_id IS NOT NULL;
