CREATE TABLE task_environments (
  id UUID PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES hire_users(id) ON DELETE CASCADE,
  task_id TEXT NOT NULL UNIQUE,
  provider TEXT NOT NULL CHECK (provider = 'e2b'),
  provider_environment_id TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL CHECK (status IN ('ready', 'running', 'destroying', 'destroyed', 'failed', 'destruction_failed')),
  network_policy JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  ready_at TIMESTAMPTZ,
  destroyed_at TIMESTAMPTZ,
  destruction_verified_at TIMESTAMPTZ
);

CREATE INDEX task_environments_user_created_idx ON task_environments (user_id, created_at DESC);
