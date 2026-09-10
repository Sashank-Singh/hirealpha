# Launch-readiness checklist

Single source of truth for the production-readiness review. Every line is
PASS, FAIL, or BLOCKED with evidence — no optimistic summaries. Update the
evidence column in place; append dated notes, never delete history.

Legend: PASS = verified with saved evidence · FAIL = verified broken ·
BLOCKED = cannot verify yet (missing credentials, deployment, or decision) ·
N/A = not applicable to this product.

## Phases

| # | Check | Status | Evidence |
|---|---|---|---|
| 1 | Every browser task runs in a fresh E2B sandbox | BLOCKED | Code live: `deploy/e2bExecutor.ts` + `deploy/browserWorker.ts` (commit 7c3ddbe); local mode dev-gated; **needs E2B_API_KEY + E2B_BROWSER_TEMPLATE + template build** (`deploy/e2b/browser-template/`) |
| 2 | VM destruction verified on every terminal path | PARTIAL | Verified-destruction code + audit events in `withTaskSandbox`, unit-tested (`deploy/e2bExecutor.test.ts`); live-VM evidence pending suite `e2b-fresh-sandbox-and-destruction` |
| 3 | Vault v2 autofill on a real site, no leakage | BLOCKED | One-time capability chain unit-proven (`services/trust/vaultV2.test.ts`); real-site run needs OpenBao + E2B envs — manual protocol in `scripts/certify.ts` |
| 4 | Real PostgreSQL isolation tests pass | BLOCKED | Suite ready (`deploy/certification/postgres.live.test.ts`); needs CERT_ALLOW_LIVE=1 + CERT_DATABASE_URL |
| 5 | OpenBao cross-user isolation tests pass | BLOCKED | Suite ready (`deploy/certification/openbao.live.test.ts`); needs OPENBAO_ADDR/TOKEN |
| 6 | Stripe Link test-mode lifecycle passes | BLOCKED | Unit + API tests green (charges never live); test-mode operator run pending — steps in cert harness |
| 7 | Memory consent/retention/export/deletion work | PASS (code) / BLOCKED (live) | `services/trust/memoryLifecycle.ts` + tests; consent version migration 202609090009; account purge route; hourly retention sweep |
| 8 | Unified approvals + audit from production UI | PARTIAL | Trust & Audit + Memory views, revoke route, nav views shipped (53d27c8); needs deploy to verify against prod |
| 9 | Sidebar/navigation tests pass consistently | PASS (offline) / BLOCKED (staging) | Stale-tab crash fixed + fallback; Playwright specs in `e2e/` skip without staging env by design |
| 10 | Security/load/provider tests pass with evidence | BLOCKED | `bun run scripts/certify.ts` — 1 PASS, 6 BLOCKED as of 2026-09-10: `marketing/evidence/certification/2026-09-10/summary.md` |
| 11 | Operational control documents have owners | PARTIAL | `ops/` package complete (11 docs incl. staging plan); owners are roles (several vacant); 6 real discrepancies recorded in ops/README.md; no operating evidence yet |
| 12 | Staging deployment + canary pass | BLOCKED | Plan ready: `ops/staging-plan.md`; requires user-approved Coolify staging deploy |
| 13 | Production rollback + monitoring ready | PARTIAL | Coolify redeploy = rollback path; /readyz exists; no dashboards/alerts — PLANNED |
| 14 | No critical/high security findings remain | PARTIAL | Known-open: local browser fallback exists behind explicit gate until E2B lands; no hire_users deletion path (ops discrepancy #2 — DSAR promise conflict); plaintext hire_* log tables; verifyAuditChain never called; pen test unscheduled |
| 15 | Launch report lists items needing legal/auditor sign-off | PARTIAL | `ops/` docs carry ⚠ COUNSEL / ⚠ AUDITOR tags; DPA status unknown for most vendors |

## Explicit non-goals (not ready, not claimed)

- SOC 2 / any compliance certification — controls exist in code; operating
  evidence does not. Do not claim compliance anywhere.
- Phone calls, group chats, images/games benchmark dimensions — no product
  capability; record N/A in runs rather than partially testing.

## Missing credentials / decisions blocking the most work

1. `E2B_API_KEY` + template build (unblocks checks 1, 2, 3, suite e2b).
2. `OPENBAO_ADDR` / `OPENBAO_TOKEN` (unblocks 3, 5, vault e2e).
3. `CERT_DATABASE_URL` throwaway DB + `CERT_ALLOW_LIVE=1` (unblocks 4).
4. User decision: create staging app in Coolify (unblocks 9 live, 12, load suite).
5. User decision: full `hire_users` account deletion FK strategy (audit_events cascade).
