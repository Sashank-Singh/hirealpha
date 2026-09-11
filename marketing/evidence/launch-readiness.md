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

## Release review — 2026-09-11 (feature-freeze audit)

Production revision tested: `main @ e388da7` + local `14b57be` (worker build tools).
Deployed production: Web/Friend/Coworker/Cofounder on `e388da7`-shape + fixed HIREALPHA_INTERNAL_KEY; Worker `running:healthy` with `HIREALPHA_DISABLE_BROWSER_JOBS=1` (kill switch ON — see CRITICAL-1).

### Critical findings

- **CRITICAL-1: current VPS cannot run the browser worker.** One Chromium task peaks 1.27 GB RSS (Walmart product page measured via ps across all renderer processes); 3 concurrent = 2.25 GB. With Postgres + 3 bots + web + 5 other projects colocated, the worker's first task OOM-killed Postgres into recovery mode 3×, taking prod down each time. Worker now runs with `HIREALPHA_DISABLE_BROWSER_JOBS=1`. Fix = dedicated worker box (~8 GB) or VPS RAM upgrade.
- **CRITICAL-2: main has 3 failing tests in the parallel session's brief-cache slice** (`/api/digest` + `/api/mini pick_night` "serves the persisted row instantly", fake SQL returns `builtAt` but the route expects a different field shape). Swept into commit d22921b via the shared tree. Owner: mem0/parallel session. Not deployable until fixed or flagged.

### P1 — mem0/pgvector migration: PASS (with fix)
Ordering correct (persona columns 110001 before index 110002); additive only; legacy rows get `persona='' durable=false` defaults (verified on real PG); tenant isolation holds ((user_id, persona, memory_key) unique — cross-user same key allowed, same-user dup rejected, verified); consent/retention/deletion/export propagate to the index (purgeAccountTrustData → dropByUser, sweep passes index); single source of truth (memoryIndex is a documented rebuildable projection, mem0 telemetry off, no LLM in the layer).
**Fixed:** blank-database chain failed at 0007 (`hire_spend_approvals` created at runtime, not by migrations) — runMigrations now bootstraps the two minimum runtime tables. 11/11 apply on blank DB + idempotent (real PG 16).
**Note:** index stores plaintext memory text (embedding requirement), retention-bound and deletion-propagated — acceptable, but backups now contain plaintext memory projections.

### P2 — worker capacity: MEASURED
- Idle task: 236 MB → commerce search: 720 MB → product page: **1.27 GB** → 3 concurrent commerce: **2.25 GB** (~0.75 GB/task shared) → cleanup returns to 0 (no leak).
- Vision-agent task: 45–90 s wall, cap 25 steps / 90 s; tokens ~65k in / 3k out ≈ **$0.01–0.03/task**; GPU zero on our side.
- **Recommendation:** dedicated 8 GB worker VPS (Hetzner CX32 ~$10/mo), concurrency 3 (matches 2.25 GB measured + headroom), 100 tasks/day ≈ 40–60 min. Admission control already exists: queue + claim LIMIT; overload queues, never crashes the DB — *once the worker is off the Postgres box*.
- Kill switch verified: `HIREALPHA_DISABLE_BROWSER_JOBS=1` stops claims immediately (prod ran on it today).

### P3 — integration surface audit: PASS with flags
- Image completeness: imageCopies test green for web + worker.
- Duplicate routes: none (matches were dispatch-vs-handler).
- No credential-shaped values in worker/bot console paths.
- **FLAG:** local Chromium IS the production default (documented decision, b91fc60). Fail-closed only when `HIREALPHA_BROWSER_MODE=disabled`.
- Cancel/timeout/retry: kill switch + 3-attempt cap + "interrupted; outcome unknown" verified in tests; uncertain provider results never retried into double-spend.

### P4 — regression matrix
| Check | Result |
|---|---|
| Unit/integration (100 files) | 1,389 run, 4 fail: 1 live-model rate-limit (retried, not a miss), **3 = CRITICAL-2** |
| TypeScript build | PASS |
| Container builds | Web/Friend built today (prod); Worker built (healthy) — PASS |
| Blank + upgrade migrations | PASS (real PG 16, 11/11, idempotent, legacy-row defaults verified) |
| Playwright staging | BLOCKED — no staging env |
| OpenBao / E2B live | BLOCKED — no creds (mocked suites pass; never counted as live) |
| Stripe Link | PASS in live wallet (real approval + one-time card issued, nothing charged); test-mode lifecycle = manual protocol, not run |
| Tenant isolation / capability replay | PASS (unit matrix + real-PG concurrent claim: 1 winner of 5) |
| Backup/restore | BLOCKED — no backups exist (ops/backup-dr.md) |
| Load/soak | BLOCKED — needs the memory fix first |

### P5 — 24h staging burn-in: BLOCKED
No staging environment exists. Setup: ops/staging-plan.md. Burn-in cannot start before CRITICAL-1 (worker box) and CRITICAL-2 (failing tests) are resolved.

### Smallest founder actions
1. Approve + create ~8 GB worker VPS (or RAM upgrade) — unblocks the entire browser dimension.
2. Tell the mem0-session agent: fix the 3 failing brief-cache tests on main (fake-SQL field mismatch) — main is feature-frozen.
3. Check GMI dashboard pricing/quota for the IE-tier key.
