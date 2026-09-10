# Certification run — 2026-09-10T11:56:16.272Z

PASS: 1 · FAIL: 0 · BLOCKED: 6

A BLOCKED suite is missing configuration or operator execution — it is not a pass. Unblocking instructions: deploy/env-contract.md.

- **unit-regression** — PASS
- **postgres-migrations-and-isolation** — BLOCKED (missing: CERT_ALLOW_LIVE, CERT_DATABASE_URL)
- **openbao-isolation-and-rotation** — BLOCKED (missing: OPENBAO_ADDR, OPENBAO_TOKEN)
- **e2b-fresh-sandbox-and-destruction** — BLOCKED (missing: E2B_API_KEY, E2B_BROWSER_TEMPLATE)
- **stripe-link-test-mode-lifecycle** — BLOCKED (missing: STRIPE_SECRET_KEY (restricted), STRIPE_WEBHOOK_SECRET, a Link-connected test user)
- **vault-end-to-end-autofill** — BLOCKED (missing: OPENBAO_ADDR, OPENBAO_TOKEN, staging site with a login form, E2B_API_KEY + E2B_BROWSER_TEMPLATE)
- **load-and-queue-latency** — BLOCKED (missing: staging deployment, CERT_ALLOW_LIVE, CERT_DATABASE_URL)

Full machine results: results.json (includes captured test output tails; no environment values).