# Environment contract — provider certification

Every provider-backed test in `scripts/certify.ts` runs against real
infrastructure or is recorded **BLOCKED**. A skip is never a pass.

## Variables

| Variable | Used by | Where obtained | Notes |
|---|---|---|---|
| `DATABASE_URL` | web, worker, certification | Coolify app env (Postgres on the same VPS) | already live in prod; certification uses a **separate** `CERT_DATABASE_URL` database so prod data is never touched |
| `CERT_DATABASE_URL` | certification (postgres suite) | create empty DB on the VPS: `CREATE DATABASE hirealpha_cert;` | must NOT point at prod |
| `CERT_ALLOW_LIVE` | all certification suites | set to `1` explicitly | two-hand rule: refuses to run live suites implicitly |
| `OPENBAO_ADDR` | vault, memory, wallet encryption | self-hosted OpenBao on the VPS (`https://bao.<domain>:8200`) | transit mount `transit`, key `hirealpha-user-deks` |
| `OPENBAO_TOKEN` | same | OpenBao policy token with transit encrypt/decrypt + datakey only | rotate quarterly; token must never have broader policy |
| `E2B_API_KEY` | browser worker, certification (e2b suite) | e2b dashboard → API keys | |
| `E2B_BROWSER_TEMPLATE` | same | output of `deploy/e2b/browser-template` build (`bunx e2b template build`) | record build id in the launch checklist when rebuilt |
| `STRIPE_SECRET_KEY` | billing + purchases | Stripe dashboard → Developers → API keys | use a **restricted key** scoped to: PaymentIntents (write), Checkout Sessions (write), Customers (read/write). Never the account root key |
| `STRIPE_WEBHOOK_SECRET` | `/api/billing/webhook` | Stripe dashboard → Webhooks → signing secret (`whsec_...`) | endpoint must be HTTPS; replay tests need the same secret |
| `HIREALPHA_VAULT_KEY` | legacy vault rows (browserVault) | `openssl rand -base64 32` | v1 rows only; new rows use per-user OpenBao keys |
| `LINK_CLI_BIN` | Link wallet | leave unset in prod (uses `/opt/hirealpha-link`) | |
| `SESSION_SIGNING_SECRET` / `HIREALPHA_INTERNAL_KEY` | web session + internal endpoints | `openssl rand -hex 32` | rotate = force re-login |
| `MEM0_ENABLED` | memory recall (`services/trust/memoryIndex.ts`) | set to `true` to turn on semantic recall | unset/anything else = recall is disabled and memory falls back to recency ordering. The product still works; it just stops finding relevant old facts |
| `OLLAMA_BASE_URL` | embedder for the memory index | the Ollama container on the same VPS (`http://<service>:11434`) | self-hosted, so it is infrastructure rather than a new subprocessor (like OpenBao). Model pulls need egress once |
| `MEM0_EMBED_MODEL` | same | `qwen3-embedding:0.6b` | any Ollama embedding model. Changing it requires a re-embed: the stored vectors are model-specific and silently useless across a swap |
| `MEM0_EMBED_DIMS` | same | `1024` | must match the model. Wrong dims = dimension errors on insert |
| `MEM0_COLLECTION` | same | `hirealpha_memories` | the pgvector table name |
| `MEM0_RECALL_TIMEOUT_MS` | same | `1500` | recall is best-effort; past this the turn proceeds without it rather than blocking a reply |

## Deploy prerequisites for memory recall

Two are outside the application, and both are hard requirements:

1. **Postgres must ship pgvector.** The stock `postgres:16` image does not
   include the extension. The Coolify database resource must run
   `pgvector/pgvector:pg16` (a drop-in replacement; the data volume carries
   over). Migration `202609110002_pgvector_memory_index.sql` runs
   `CREATE EXTENSION IF NOT EXISTS vector` and fails loudly if absent. Creating
   the extension needs a superuser the first time; on a Coolify-managed
   database the `postgres` role is one. Once installed the migration no-ops.
2. **Ollama must be running with the embedding model pulled**, reachable from
   the API service. `ollama pull qwen3-embedding:0.6b` (639 MB) once, on a
   volume that survives redeploys.

Both are checked at the point of use, not at boot: without them the index
degrades to empty and memory behaves exactly as it did before this layer
existed, rather than failing turns.

## Secret rotation procedure

1. Generate the new value off-machine; never paste into chat, tickets, or the repo.
2. Set it in Coolify for the consuming app(s) (Web, Friend bot, browser worker) and redeploy.
3. For `OPENBAO_TOKEN` and `STRIPE_WEBHOOK_SECRET`, overlap old+new for one deploy cycle, then revoke the old.
4. Record the rotation date + operator in the launch-readiness checklist evidence column. No secret values, ever.

## Startup validation

`deploy/certification/envContract.ts` exports `validateEnvironment(mode)` listing
missing variables for a given surface. The browser worker logs the result at
boot; certification refuses to start suites with missing variables.
