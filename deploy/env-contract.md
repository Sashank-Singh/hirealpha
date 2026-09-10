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

## Secret rotation procedure

1. Generate the new value off-machine; never paste into chat, tickets, or the repo.
2. Set it in Coolify for the consuming app(s) (Web, Friend bot, browser worker) and redeploy.
3. For `OPENBAO_TOKEN` and `STRIPE_WEBHOOK_SECRET`, overlap old+new for one deploy cycle, then revoke the old.
4. Record the rotation date + operator in the launch-readiness checklist evidence column. No secret values, ever.

## Startup validation

`deploy/certification/envContract.ts` exports `validateEnvironment(mode)` listing
missing variables for a given surface. The browser worker logs the result at
boot; certification refuses to start suites with missing variables.
