-- Waitlist emails for HireAlpha marketing site
-- Applied automatically by deploy/web-server.ts on boot

CREATE TABLE IF NOT EXISTS waitlist_emails (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
