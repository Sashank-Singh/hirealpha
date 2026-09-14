-- Canonical task record (beat-instinct plan: one truth shared by iMessage, browser,
-- mini-apps, calendar, and payments). Append-only event stream + versioned projection.
-- Idempotent: safe to re-run. Nothing reads these tables until the task engine wires in.

CREATE TABLE IF NOT EXISTS hire_tasks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id TEXT NOT NULL REFERENCES hire_users(id) ON DELETE CASCADE,
  persona TEXT NOT NULL DEFAULT 'friend',
  conversation_id TEXT,
  request TEXT NOT NULL,
  constraints JSONB NOT NULL DEFAULT '{}'::jsonb,
  state TEXT NOT NULL DEFAULT 'DRAFT',
  resumed_state TEXT,
  monitor_state TEXT NOT NULL DEFAULT 'OFF',
  monitor_policy JSONB,
  monitor_next_check_at TIMESTAMPTZ,
  plan_version INTEGER NOT NULL DEFAULT 0,
  plan JSONB,
  current_step JSONB,
  options JSONB NOT NULL DEFAULT '[]'::jsonb,
  selected_option_id TEXT,
  grants JSONB NOT NULL DEFAULT '[]'::jsonb,
  external_ops JSONB NOT NULL DEFAULT '[]'::jsonb,
  artifacts JSONB NOT NULL DEFAULT '[]'::jsonb,
  verification JSONB,
  sync_state JSONB NOT NULL DEFAULT '{}'::jsonb,
  failure JSONB,
  version INTEGER NOT NULL DEFAULT 0,
  event_seq INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT hire_tasks_state_check CHECK (state IN (
    'DRAFT', 'CLARIFYING', 'RESEARCHING', 'WAITING_FOR_SELECTION', 'PLANNING_ACTION',
    'WAITING_FOR_AUTHORITY', 'EXECUTING', 'VERIFYING', 'SYNCHRONIZING', 'FULFILLED',
    'CLOSED', 'PAUSED_BY_USER', 'CANCELLED', 'FAILED_RETRYABLE', 'FAILED_FINAL',
    'NEEDS_RECONCILIATION', 'HUMAN_TAKEOVER'
  )),
  CONSTRAINT hire_tasks_monitor_state_check CHECK (monitor_state IN (
    'OFF', 'SCHEDULED', 'CHECKING', 'DEGRADED', 'TRIGGERED', 'ENDED'
  )),
  CONSTRAINT hire_tasks_version_check CHECK (version >= 0),
  CONSTRAINT hire_tasks_event_seq_check CHECK (event_seq >= 0)
);

CREATE INDEX IF NOT EXISTS idx_hire_tasks_user_state
  ON hire_tasks (user_id, state, updated_at DESC);

CREATE TABLE IF NOT EXISTS hire_task_events (
  id BIGSERIAL PRIMARY KEY,
  event_id UUID NOT NULL UNIQUE DEFAULT gen_random_uuid(),
  task_id UUID NOT NULL REFERENCES hire_tasks(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL,
  schema_version INTEGER NOT NULL DEFAULT 1,
  type TEXT NOT NULL,
  actor TEXT NOT NULL,
  causation_id UUID,
  correlation_id TEXT,
  idempotency_key TEXT,
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  task_seq INTEGER NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS hire_task_events_task_seq
  ON hire_task_events (task_id, task_seq);

CREATE UNIQUE INDEX IF NOT EXISTS hire_task_events_idempotency
  ON hire_task_events (task_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_hire_task_events_task_stream
  ON hire_task_events (task_id, task_seq);
