# HireAlpha connectors — OAuth + Composio gateway

## What is real now

- `PostgresStore` against Coolify `HireAlpha-Database`
- Hand-rolled OAuth authorize → callback → encrypted tokens → persona permission seed
- **Composio gateway**: one `COMPOSIO_API_KEY` unlocks the full toolkit catalog (Connect Links). We do not implement OAuth per app.
- Platform **Connect** uses the gateway when configured; otherwise falls back to hand-rolled `/connect/:service`
- Google Calendar tools still available on the direct path
- Just-in-time refresh with in-process single-flight lock per `connected_account_id`

## The “250 connectors” trick

Products like Composio / Nango / Pipedream Connect maintain OAuth apps and tool schemas for hundreds of vendors. You integrate **once**:

1. Set `COMPOSIO_API_KEY` on HireAlpha-Connectors (Coolify).
2. `GET /gateway/catalog?user_id=&persona=` lists toolkits.
3. `GET /gateway/connect/:toolkit?user_id=&persona=&redirect_after=` redirects into Composio’s Connect Link.
4. Chat/agent layer calls `POST /gateway/session` with `{ userId, persona }` to get tools (or MCP URL with `mcp: true`).

Persona policy lives in `src/gateway/policy.ts` (Friend allowlist + hard denies).

## Google Cloud setup (direct OAuth path)

1. Create/select a GCP project. Enable **Google Calendar API**.
2. OAuth consent screen → **External** → **Testing**. Add your Google account as a test user.
3. Credentials → Create **OAuth client ID** → Application type **Web application**.
4. Authorized redirect URIs (Coolify + local):
   - `https://xx88g8zzx3wwedjdnnrbprm8.coolify.alphasphere.trade/oauth/callback/google_calendar`
   - `https://xx88g8zzx3wwedjdnnrbprm8.coolify.alphasphere.trade/oauth/callback/gmail`
   - `http://localhost:8787/oauth/callback/google_calendar`
5. Put `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` in Coolify **HireAlpha-Connectors** env (not git).

## Coolify env (Connectors)

| Key | Purpose |
|-----|---------|
| `DATABASE_URL` | Postgres |
| `TOKEN_ENCRYPTION_KEY` | AES key for hand-rolled tokens |
| `GOOGLE_CLIENT_ID` / `SECRET` | Direct Google OAuth |
| `COMPOSIO_API_KEY` | Gateway catalog + Connect Links |
| `APP_BASE_URL` | Platform origin for redirects |
| `CORS_ORIGIN` | Web origin |

Web build: `VITE_CONNECTORS_URL=https://xx88g8zzx3wwedjdnnrbprm8.coolify.alphasphere.trade`

## Coolify resources

| Resource | UUID |
|----------|------|
| HireAlpha-Connectors | `xx88g8zzx3wwedjdnnrbprm8` |
| HireAlpha-Database | `emr4talylynje35bnqycqytv` |
| HireAlpha-Web | `ampdaixdebfrlv7pqcmojhb5` |

