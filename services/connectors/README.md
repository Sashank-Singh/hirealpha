# @hirealpha/connectors

Standalone OAuth / connector / token layer for HireAlpha. The chat/LLM layer calls into this service; it does not own prompts or SMS.

## What it does

- **Composio gateway** (optional): one `COMPOSIO_API_KEY` → full toolkit catalog + Connect Links (do not hand-code each OAuth app)
- Hand-rolled OAuth authorize + callback for first-party Google (and other) apps when preferred
- Encrypts access/refresh tokens at rest (AES-256-GCM envelope) on the direct path
- Per-persona permissions (`friend` / `coworker` / `cofounder`) with hard rule: **Stripe never for Friend**
- Token refresh (15m job + just-in-time before tool use) on the direct path
- Audit `tool_call_log` + write-action confirmation gate
- HTTP API for connect/disconnect/permissions/activity — **never returns tokens to clients**

## Quick start

```bash
cd services/connectors
export TOKEN_ENCRYPTION_KEY="$(bun -e 'console.log(require("crypto").randomBytes(32).toString("base64"))')"
# Unlock the full catalog (recommended):
# COMPOSIO_API_KEY=...
# Optional direct Google OAuth:
# GOOGLE_CLIENT_ID=... GOOGLE_CLIENT_SECRET=...
bun run dev   # :8787
bun test
```

## API

| Method | Path | Notes |
|--------|------|--------|
| GET | `/gateway/status` | Whether Composio is configured |
| GET | `/gateway/catalog?user_id=&persona=` | Toolkit catalog (persona filtered) |
| GET | `/gateway/connect/:toolkit?...` | Redirect to Composio Connect Link |
| GET | `/gateway/users/:user_id/connections` | Gateway connected accounts |
| POST | `/gateway/disconnect/:id` | Remove gateway connection |
| POST | `/gateway/session` | `{ userId, persona, mcp? }` → tools for agents |
| GET | `/connect/:service?user_id=&persona=` | Direct OAuth redirect |
| GET | `/oauth/callback/:service` | State CSRF check, upsert connection |
| POST | `/disconnect/:connected_account_id` | Revoke + disable personas |
| GET | `/users/:user_id/connections` | Status only (no tokens) |
| PATCH | `/users/:user_id/personas/:persona/permissions` | `{ updates: [{ connectedAccountId, enabled }] }` |
| GET | `/users/:user_id/activity` | Paginated tool log |
| POST | `/internal/refresh` | Refresh sweep |

## Internal (chat layer)

```ts
import { createConnectorRuntime } from '@hirealpha/connectors'

const { service } = createConnectorRuntime({ store, masterKey, credentials })
const tools = await service.getActiveToolsForPersona(userId, 'coworker')
// tools[].accessToken is in-process only — do not serialize to browsers
```

Write tools:

```ts
const gate = await service.authorizeToolCall({ userId, persona, toolName: 'gmail.send', connectedAccountId, inputSummary })
// if confirmation_required → ask user → call again with confirmed: true + confirmationKey
```

## Security

- `TOKEN_ENCRYPTION_KEY`: 32-byte key, base64, from secrets manager / KMS-unwrapped DEK — never commit
- Tokens redacted in logs and `tool_call_log`
- OAuth `state` single-use, 10-minute TTL
- Connect/refresh rate-limited per user

## Scopes

See `src/oauth/scopes.ts` — pulled from current provider docs (least privilege). Notion uses integration capabilities (no classic scope string).
