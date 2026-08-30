# Self-hosted Plausible on Coolify

Plausible Community Edition for **hirealpha.chat** analytics, pinned to
`ghcr.io/plausible/community-edition:v3.2.1` (AGPL-3.0). Runs its own Postgres
+ ClickHouse inside the stack — it does not touch the HireAlpha Postgres.

## One-time setup in Coolify

1. **DNS.** Add an A record at your DNS provider:
   `analytics 300 IN A <your-server-ip>` (same server as hirealpha.chat).
2. **Create the resource.** Coolify → **New Resource** → **Docker Compose**.
   - Paste the contents of `deploy/plausible/docker-compose.yml` (or point the
     resource at this repo and pick `deploy/plausible/docker-compose.yml`).
   - This file is self-contained: the small ClickHouse tuning XMLs are inlined
     as Compose `configs`, so there are no extra files to upload.
3. **Environment variables** (the compose requires exactly two):
   - `BASE_URL=https://analytics.hirealpha.chat`
   - `SECRET_KEY_BASE=<64+ bytes>` → generate with
     `openssl rand -base64 48`, store it somewhere safe (it signs your
     dashboard sessions; you want it stable across upgrades).
   - Recommended extras: `DISABLE_REGISTRATION=invite_only` (default anyway,
     so the first signup just works, then nobody else can register).
   - Optional: SMTP vars (see `.env.example`) if you want password resets and
     weekly report emails to be auto-sent.
4. **Domain / proxy.** Set the resource's **Domain** to
   `analytics.hirealpha.chat` with internal **port 8000** (this is CE's
   `HTTP_PORT`). Coolify's proxy will issue the Let's Encrypt cert and handle
   WebSockets automatically. Leave `HTTPS_PORT` unset.
5. **Deploy.** Coolify builds and starts `plausible`, `plausible_db`
   (Postgres), and `plausible_events_db` (ClickHouse). Healthchecks make the
   app wait for both databases before the CE container runs
   `createdb + migrate + run` automatically — no manual schema step.
6. **Create the owner account.** Open `https://analytics.hirealpha.chat`,
   register once (first registration = admin), then go to
   **Settings → Sites** and add a site with domain **`hirealpha.chat`**.

## Wiring the homepage

The snippet in `index.html` already points at the self-hosted instance:

```html
<script defer data-domain="hirealpha.chat" src="https://analytics.hirealpha.chat/js/script.js"></script>
```

No changes needed in the app. Then define the funnel events under
**Settings → Goals → Custom events**: `waitlist_joined`, `checkout_started`,
`share_clicked`, `invite_copied`. Alerts/GDPR: Plausible is cookieless and
collects no personal data, so no consent banner is required.

## Upgrading

1. Edit the image tag in `docker-compose.yml` (new releases at
   https://github.com/plausible/community-edition/releases).
2. Redeploy in Coolify. CE runs migrations on boot. Back up before you do.

## Backups

- **Postgres** (users, sites, goals): dump once a day on the server:
  `docker exec deploy_plausible_db-1 pg_dump -U postgres -d plausible_db | gzip > plausible-db-$(date +%F).sql.gz`
  (the container name depends on Coolify's project prefix — `docker ps` to find
  it), or use Coolify's own backup feature for the compose project.
- **ClickHouse** (`event-data`) holds analytics history only. If you lose it,
  the dashboard loses past stats but nothing about users/sites breaks.

## Requirements

- Docker Compose **>= 2.23** (inline `configs:` content) — Coolify's bundled
  version qualifies. A local check: `docker compose version`.
- ~2 GB free RAM for ClickHouse + Plausible.
- CPU with SSE 4.2 or NEON (ClickHouse requirement — any modern x86/ARM box).

## Local smoke test

```bash
cd deploy/plausible
./smoke-test.sh          # needs Docker; boots the stack on :8000
open http://localhost:8000
```