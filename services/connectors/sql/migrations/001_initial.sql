-- HireAlpha connectors service — Postgres schema
-- Apply with: psql $DATABASE_URL -f sql/schema.sql

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

CREATE TYPE connector_service AS ENUM (
  'google_calendar',
  'gmail',
  'slack',
  'notion',
  'linear',
  'github',
  'google_drive',
  'spotify',
  'uber',
  'stripe',
  'figma',
  'google_maps'
);

CREATE TYPE connected_account_status AS ENUM (
  'active',
  'expired',
  'revoked',
  'error'
);

CREATE TYPE persona AS ENUM (
  'friend',
  'coworker',
  'cofounder'
);

CREATE TYPE tool_call_status AS ENUM (
  'success',
  'error',
  'user_denied',
  'pending_confirmation'
);

CREATE TABLE users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  phone_number TEXT NOT NULL UNIQUE,
  email TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE connected_accounts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  service connector_service NOT NULL,
  access_token TEXT NOT NULL,
  refresh_token TEXT,
  token_expires_at TIMESTAMPTZ,
  scopes_granted TEXT[] NOT NULL DEFAULT '{}',
  external_account_id TEXT,
  status connected_account_status NOT NULL DEFAULT 'active',
  last_refreshed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, service)
);

CREATE TABLE persona_connector_permissions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  persona persona NOT NULL,
  connected_account_id UUID NOT NULL REFERENCES connected_accounts(id) ON DELETE CASCADE,
  enabled BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, persona, connected_account_id)
);

CREATE TABLE oauth_state (
  state TEXT PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  service connector_service NOT NULL,
  persona persona,
  redirect_after TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX oauth_state_created_at_idx ON oauth_state (created_at);

CREATE TABLE tool_call_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  persona persona NOT NULL,
  connected_account_id UUID REFERENCES connected_accounts(id) ON DELETE SET NULL,
  tool_name TEXT NOT NULL,
  input_summary TEXT,
  output_summary TEXT,
  status tool_call_status NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX tool_call_log_user_created_idx ON tool_call_log (user_id, created_at DESC);
CREATE INDEX connected_accounts_expires_idx ON connected_accounts (token_expires_at)
  WHERE status = 'active';
