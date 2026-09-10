# Control Matrix

Statuses: **BUILT** means the control exists in code or operations today and
its evidence source can be pointed at. **PARTIAL** means the control exists but
covers only part of the surface, or has never been exercised. **PLANNED** means
the control is described here but does not exist yet. Per `ops/README.md`,
nothing in this matrix claims certification, and no control has collected
operating evidence over a review cycle yet — the cadences below define when
that evidence would start to exist.

Owners use role names because there is no org chart. "Security (vacant)" and
"Privacy (vacant)" mean exactly that: the function does not exist and the
founder is covering it by default. ⚠ COUNSEL marks rows where a lawyer must
confirm the control or the claim; ⚠ AUDITOR marks rows an auditor will ask
about first.

| ID | Control | Owner | Evidence source | Frequency | Status |
|---|---|---|---|---|---|
| AC-1 | Authentication on all `/api/trust/*` endpoints: every request resolves to a signed-in user or returns 401 (`handleTrustApi` in `services/trust/trustApi.ts` calls `deps.resolveUser`) | CTO (acting) | `services/trust/trustApi.ts`; tests in `deploy/trust.test.ts` | Continuous (code) | BUILT |
| AC-2 | Human approval required before any agent side effect: capability grants are created `pending` and must be decided by the user; the state machine (`ALLOWED_TRANSITIONS` in `services/trust/capabilityGrants.ts`) forbids skipping states | CTO (acting) | `services/trust/capabilityGrants.ts` (`decideCapabilityGrant`); `deploy/migrations/202609090001_trust_capabilities.sql` | Continuous (code) | BUILT |
| AC-3 | Production access policy: who can deploy via Coolify and who can read the production database | Founder (CEO) | `ops/access-control.md`; Hetzner/Coolify account config | Continuous | PARTIAL — policy written here; no independent review of accounts performed |
| AC-4 | Quarterly access review of all accounts with production access | Founder (CEO) | `ops/access-control.md` § Quarterly review checklist | Quarterly | PLANNED — first review not yet performed |
| AC-5 | MFA on all privileged accounts (Hetzner, Coolify, Stripe, GitHub, Google, 1Password) | Founder (CEO) | External dashboards (verify per account) | Continuous | PARTIAL — enforced by default on some providers; per-account verification not yet recorded |
| CM-1 | Change management: all changes via git; migrations are checksummed and append-only (`hire_schema_migrations` with SHA-256 checksums, advisory-locked, single transaction per migration in `deploy/migrate.ts`; modified applied migrations are rejected) | CTO (acting) | `deploy/migrate.ts`; `deploy/migrations/` | Every deploy | BUILT |
| CM-2 | Deploy path: GitHub → Coolify build on the Hetzner VPS (`vmi2997871`); deploy history retained in Coolify | Founder (CEO) | Coolify deploy history (screenshot/export per review) | Every deploy | BUILT — operating evidence: not yet collected |
| CM-3 | Pre-deploy test gate (repository test suites run in CI or locally before deploy) | CTO (acting) | Test files (`deploy/*.test.ts`, `services/trust/*.test.ts`); CI config | Every change | PARTIAL — suites exist; enforcement gate not formally defined |
| EN-1 | Encryption at rest for trust data: per-user AES-256-GCM with AAD-bound contexts (`encryptUserPayload`/`decryptUserPayload` in `services/trust/userKeyBroker.ts`), covering `memory_records` and `vault_items_v2` | CTO (acting) | `services/trust/userKeyBroker.ts`; `deploy/migrations/202609090003_user_keys_and_vault_v2.sql`; `deploy/migrations/202609090004_memory_lifecycle.sql` (ciphertext `CHECK (ciphertext LIKE 'v2.%')`) | Continuous (code) | BUILT |
| EN-2 | Key management: 256-bit data keys generated and wrapped by self-hosted OpenBao transit (mount `transit`, key `hirealpha-user-deks`), wrapped DEKs stored in `user_wrapped_keys`, key destruction enforced by `wrapped_key_lifecycle` CHECK | CTO (acting) | `services/trust/userKeyBroker.ts` (`OpenBaoTransitClient`, `loadOrCreateUserKey`); `deploy/env-contract.md` (OPENBAO_ADDR/OPENBAO_TOKEN, HTTPS enforced outside localhost) | Continuous | BUILT |
| EN-3 | Encryption at rest for product log tables (`hire_nutrition_logs`, `hire_workouts`, `hire_sleep`, `hire_spending`, `hire_pipeline`, `hire_drafts`, `hire_memories`, etc.) | CTO (acting) | Table definitions in `deploy/hire-api.ts` (plaintext columns) | — | PLANNED — see risk register R-07 |
| EN-4 | In-transit encryption: HTTPS enforced at the Coolify proxy (Let's Encrypt per `deploy/plausible/README.md` pattern); OpenBao client refuses non-HTTPS outside localhost | CTO (acting) | `services/trust/userKeyBroker.ts` (protocol check); nginx config `deploy/nginx-web.conf` | Continuous | BUILT — external cert configuration to verify |
| SM-1 | Secrets management: all secrets via Coolify environment variables, none committed to the repo; documented contract with rotation procedure in `deploy/env-contract.md` | Founder (CEO) | `deploy/env-contract.md`; repo grep for secret values (none) | Rotation per contract (quarterly for OPENBAO_TOKEN) | BUILT — operating evidence: not yet collected |
| SM-2 | Restricted Stripe key scoping (PaymentIntents write, Checkout write, Customers read/write; never account root key) | Founder (CEO) | `deploy/env-contract.md`; Stripe dashboard key list | Per rotation | BUILT — verify actual key scopes in dashboard |
| AL-1 | Tamper-evident audit log: per-user SHA-256 hash chain over `audit_events` (`appendAuditEvent`, `verifyAuditChain` in `services/trust/auditLedger.ts`) with advisory-lock serialization | CTO (acting) | `services/trust/auditLedger.ts` | Continuous (code) | BUILT |
| AL-2 | Audit log append-only enforcement: DB trigger `prevent_audit_event_mutation` raises on UPDATE or DELETE of `audit_events` | CTO (acting) | `deploy/migrations/202609090001_trust_capabilities.sql` (trigger definition) | Continuous (code) | BUILT |
| AL-3 | Audit metadata hygiene: allowlist `SAFE_METADATA_KEYS` plus regex ban on secret/password/token/cookie/card keys (`sanitizeAuditMetadata`) | CTO (acting) | `services/trust/auditLedger.ts` | Continuous (code) | BUILT |
| AL-4 | Periodic audit-chain verification job (invoke `verifyAuditChain` across users, alert on failure) | CTO (acting) | Function exists in `services/trust/auditLedger.ts`; no caller | Daily (proposed) | PLANNED |
| AL-5 | Security-event alerting (failed login bursts, payment anomalies, bot delivery anomalies) routed to the founder | Founder (CEO) | `ops/incident-response.md` detection sources | Continuous | PLANNED — detection is currently manual |
| BK-1 | Database backups with documented schedule and tested restore | Founder (CEO) | No backup configuration found in repo; Hetzner/Coolify config to be verified | Daily (target) | PLANNED — see risk register R-01 and README discrepancy 5 |
| IR-1 | Incident response plan with severity levels, on-call, and breach-notification decision tree | Founder (CEO) | `ops/incident-response.md` | Per incident + annual review | BUILT (document) — operating evidence: not yet collected; on-call is founder-only |
| VM-1 | Vulnerability management: dependency updates, patch cadence, remediation SLAs | CTO (acting) | `ops/pen-test.md` remediation SLAs; `bun.lock`/lockfile diffs | Monthly (target) | PLANNED — no scheduled scan or patch window exists yet |
| VM-2 | Third-party penetration test | Founder (CEO) | `ops/pen-test.md` (scope + methodology ready; not booked) | Annual (target) | PLANNED |
| VM-3 | Browser task SSRF defense: HTTPS-only targets, credential-in-URL ban, DNS resolution checked against a private/reserved IP blocklist at navigation time and re-checked per request post-redirect | CTO (acting) | `deploy/browserNetworkPolicy.ts` (`assertPublicHttpsUrl`, `installBrowserNetworkPolicy`); tests `deploy/browserNetworkPolicy.test.ts` | Continuous (code) | BUILT |
| VM-4 | Sandbox isolation for browser tasks: every production task runs in a fresh E2B sandbox (local Chromium only behind explicit `HIREALPHA_ALLOW_LOCAL_BROWSER=1`; nothing runs unconfigured); environment lifecycle recorded in `task_environments` with `destruction_verified_at` | CTO (acting) | `deploy/e2bExecutor.ts` (`resolveBrowserExecutorMode`); `deploy/browserWorker.ts`; `deploy/migrations/202609090002_task_environments.sql` | Continuous (code) | BUILT |
| VD-1 | Vendor/subprocessor inventory with DPA tracking | Privacy (vacant) | `ops/vendors.md` | Quarterly | PARTIAL — inventory written; DPAs largely NOT SIGNED |
| DS-1 | DSAR intake and fulfillment (email + in-product endpoints) | Privacy (vacant) | `ops/dsar.md`; `services/trust/trustApi.ts` (`GET /api/trust/memory/export`, `DELETE /api/trust/account`) | Per request | PARTIAL — export and trust-data purge BUILT; full-account deletion has a manual step (README discrepancy 2) |
| DS-2 | Consent capture for memory categories with versioning: `consent_records` (category, purpose, status, `consent_version`, `source`), enforcement in `storeConsentedMemory` | CTO (acting) | `services/trust/memoryLifecycle.ts` (`grantMemoryConsent`); `deploy/migrations/202609090004_memory_lifecycle.sql`; `deploy/migrations/202609090009_consent_version_source.sql` | Continuous (code) | BUILT |
| RT-1 | Retention enforcement for consented memories: per-category caps (identity/preference/relationship 365d, work 180d, health/financial 30d, other 90d) with hourly crypto-shredding sweep | CTO (acting) | `MAX_RETENTION_DAYS` in `services/trust/memoryLifecycle.ts`; `sweepExpiredMemories` scheduled hourly in `deploy/web-server.ts` (setInterval, 60 min); `retention-schedule.md` | Hourly | BUILT |
| RT-2 | Capability expiry: pending/approved grants past `expires_at` flipped to `expired` so stale approvals cannot be consumed | CTO (acting) | `expireCapabilityGrants` in `services/trust/capabilityGrants.ts`; scheduled every 5 min in `deploy/web-server.ts` | 5 minutes | BUILT |
| RT-3 | Account deletion propagation: `purgeAccountTrustData` destroys memories, bot memories, consents, vault items, outstanding grants, and the per-user key; evidenced by `account.trust_data_purged` audit event | CTO (acting) | `services/trust/memoryLifecycle.ts` (`purgeAccountTrustData`); `services/trust/trustApi.ts` (`DELETE /api/trust/account`) | Per request | BUILT — scope limited to trust tables (README discrepancy 2) |
| PG-1 | Privacy notice at collection (privacy page) | Privacy (vacant) | `public/pages/privacy.html` | Per change | BUILT — ⚠ COUNSEL review of wording against actual data flows not yet done |
| PG-2 | ROPA (record of processing activities) | Privacy (vacant) | `ops/gdpr-ccpa-checklist.md` (draft) | Quarterly | PARTIAL — draft written; ⚠ COUNSEL review required |
| PG-3 | DPIA for AI assistant + browser automation | Privacy (vacant) | `ops/gdpr-ccpa-checklist.md` (determination written; analysis not performed) | Once + on material change | PLANNED — ⚠ COUNSEL |
| PG-4 | Do-not-sell/share posture: no sale or sharing of personal data; stated on the privacy page | Privacy (vacant) | `public/pages/privacy.html` ("We never sell or rent your personal data"); no advertising or data-sale code paths exist | Continuous | BUILT — ⚠ COUNSEL confirmation that no vendor relationship constitutes a "sale" or "share" under CCPA |
| BC-1 | Business continuity beyond the single VPS (second-region failover, documented restore-time objective) | Founder (CEO) | Risk register R-01/R-09 | — | PLANNED |

Notes for the next owner of this matrix: statuses are a snapshot from the
current code. When a PLANNED item becomes code, update the row in the same
commit and add the evidence source. When a BUILT item's evidence source moves,
update it in the same commit. Anything that would require a lawyer to sign off
before launch should inherit the ⚠ COUNSEL tag from this matrix.
