# HireAlpha Cloud Computer on Coolify

This deployment runs the HireAlpha browser worker, Chromium, Xvfb, and noVNC
in the same container. The browser at `https://browser.hirealpha.chat/vnc.html`
is therefore the exact browser executing the queued task—not a separate demo
or browser-use Web UI session.

## Deploy

1. In Coolify, create a Docker Compose resource from this repository and select
   `deploy/browser-use/docker-compose.yml`.
2. Route `browser.hirealpha.chat` to the compose service's port `6080`.
3. Set the environment variables below, then deploy.
4. On the web/API resource set:
   `BROWSER_USE_STREAM_URL=https://browser.hirealpha.chat/vnc.html`.

Required variables:

| Variable | Purpose |
|---|---|
| `DATABASE_URL` | Shared Postgres queue used by the API and browser worker |
| `GMI_API_KEY` | Vision/action model used for arbitrary web tasks |
| `SESSION_SECRET` | Must match the web/API resource so iMessage view links verify |
| `CHROME_VNC_PASSWORD` | Password passed to the private noVNC client |

Credential variables are optional but recommended:

| Variable | Purpose |
|---|---|
| `OP_SERVICE_ACCOUNT_TOKEN` | Resolve saved credentials from 1Password at task time |
| `OP_VAULT_ID` | 1Password vault containing the login items |
| `HIREALPHA_VAULT_KEY` | Encrypts saved logins and each user's isolated Link authorization; required for agent purchases |
| `USER_SPEND_MAX_CENTS` | Per-purchase approval cap (defaults to 20000 / $200) |

## How a task runs

1. Alpha queues a scoped browser job and texts a signed `/computer/:id` link.
2. The user approves the one-time browser session from that page.
3. The worker opens a headful Chromium window on the streamed X display.
4. The vision loop sees screenshots plus numbered interactive targets. It may
   use stable selectors or coordinate-based mouse/keyboard actions.
5. At a password, one-time code, CAPTCHA, or identity check, the worker pauses
   without closing Chromium. The user takes control, completes the protected
   step on the site, and selects **Done — let Alpha continue**.
6. At payment, Alpha waits until the merchant shows the final total, creates a
   Link spend request for that exact merchant/item/amount, and texts its private
   approval link. Manual resume is disabled for this checkpoint.
7. After Link confirms approval, the same worker retrieves one one-time card
   into memory, fills the live checkout without exposing it to the model or UI,
   and resumes the same page. Alpha reports success only after the merchant
   returns an order confirmation, then sends the result in iMessage.

The database activity feed contains only coarse action names and URLs. Field
values, page text, passwords, and verification codes are not stored there.

## Scaling

`WORKER_CONCURRENCY=1` is intentional because one noVNC display must map to one
active user session. To run simultaneous sessions, provision isolated worker +
stream instances (or a session router) and set `BROWSER_USE_STREAM_URL` to a
template containing `{sessionId}`. The API replaces that token per job.
