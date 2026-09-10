# Retention Schedule

What data is kept, for how long, how it is deleted, and how one would prove
both. Every row names the actual store and the actual mechanism in the code.
Where no deletion mechanism exists, that is stated rather than softened —
"deleted when X happens" is only true if code or procedure makes it happen.

A note on mechanism vocabulary, because the distinctions matter for GDPR:

- **Hard delete** — the row is removed (`DELETE FROM ...`).
- **Crypto-shred** — the ciphertext is nulled and deletion metadata is
  recorded; because the per-user key is wrapped by OpenBao and can be
  destroyed, the data is unrecoverable even if the row survives. In this
  codebase the two are used together deliberately (the
  `memory_deletion_state` CHECK in migration
  `202609090004_memory_lifecycle.sql` enforces that a row is either fully
  alive or fully deleted: `deleted_at` set, `ciphertext` NULL,
  `deletion_reason` present).

| Data store | Contents | Retention | Deletion mechanism | Evidence |
|---|---|---|---|---|
| `memory_records` (encrypted, per-user AES-256-GCM) | Consented memories in categories identity, preference, relationship, work, health, financial, other | Per-category caps in `MAX_RETENTION_DAYS` (`services/trust/memoryLifecycle.ts`): identity / preference / relationship **365 days**, work **180 days**, health / financial **30 days**, other **90 days**; per-record `retention_days` is user-chosen but validated against the cap, and `expires_at` is set at insert | Hourly sweep `sweepExpiredMemories` (setInterval 60 min in `deploy/web-server.ts`) crypto-shreds expired rows (`ciphertext = NULL`, `deletion_reason = 'retention_expired'`); user-scoped deletion via `DELETE /api/trust/memory` with reason `user_request`; account purge `purgeAccountTrustData` hard-deletes all rows | Sweep logs `[trust] memory retention sweep failed` on error; `memory_records.expires_at` column is queryable; CHECK constraints in migration `202609090004_memory_lifecycle.sql` |
| `consent_records` | Memory/credential/payment/computer consents with `consent_version`, `source`, `status`, optional `expires_at` | Active until revoked or expired; retained as the consent trail while the account exists | `revokeMemoryConsent` sets `status='revoked', revoked_at=now()`; hard delete in `purgeAccountTrustData` at account deletion | `consent_records.status`/`revoked_at`; code `services/trust/memoryLifecycle.ts` |
| `hire_memories` (plaintext) | Bot memory key/value store per persona (`deploy/hire-api.ts` schema) | Life of account — no automatic expiry exists | Hard delete in `purgeAccountTrustData`; cascade via `hire_users` deletion if the manual account row removal is performed | Response counts from the purge endpoint; **no scheduled sweeper exists for this table** — that is an honest gap vs. the memory_records story |
| `hire_nutrition_logs`, `hire_nutrition_goals`, `hire_workouts`, `hire_sleep`, `hire_moods` (health-style logs, plaintext) | Nutrition, workouts, sleep, moods | Life of account; privacy page promises removal within 30 days of account deletion | FK `ON DELETE CASCADE` to `hire_users` — deleted only when the user row is deleted, which today is a **manual founder step** (no `DELETE FROM hire_users` exists in the repo; README discrepancy 2) | Table definitions in `deploy/hire-api.ts`; cascade constraints visible in schema |
| `hire_spending`, `hire_spending_budget`, `hire_pipeline`, `hire_drafts`, `hire_gratitude`, `hire_learning`, `hire_network`, `hire_user_locations`, `hire_loops`, and other `hire_*` tables | Spending, pipeline, drafts, contacts, locations, loops (plaintext) | Same as above — life of account | Same as above | Same as above |
| `vault_items_v2` (encrypted) | Saved site credentials (ciphertext, masked username hints) | Life of account or until revoked | `revokeVaultItem` (`services/trust/vaultV2.ts`, sets `revoked_at`); hard delete in `purgeAccountTrustData` | `vault_items_v2.revoked_at`; partial index `WHERE revoked_at IS NULL` (migration `202609090003_user_keys_and_vault_v2.sql`) |
| `user_wrapped_keys` | Per-user wrapped data keys | Life of account | `destroyUserKey` / `purgeAccountTrustData` set `wrapped_dek = NULL, destroyed_at = now()` — irreversible by the `wrapped_key_lifecycle` CHECK; after this, all of the user's ciphertext is permanently unreadable | Migration `202609090003_user_keys_and_vault_v2.sql`; endpoint response `user_keys_destroyed` count |
| `capability_grants` | Agent permission grants and their digests | Grant-level: pending/approved grants expire at `expires_at` (user- or flow-chosen); rows retained as history after account deletion (purge revokes rather than deletes, to preserve the audit join) | 5-minute sweep `expireCapabilityGrants` (setInterval in `deploy/web-server.ts`) flips stale grants to `expired`; revocation via `requestCapabilityRevocation`; `purgeAccountTrustData` revokes outstanding grants | Sweep error log `[trust] grant expiry sweep failed`; `status`/`finalized_at` columns; state machine in `services/trust/capabilityGrants.ts` |
| `hire_browser_jobs` | Browser task jobs: URL, steps, results, activity log | Life of account; no automatic expiry exists | Cascade via `hire_users` deletion (manual step); result text persists until then — **gap to close** | Schema in `deploy/browserJobs.ts` (`ensureBrowserJobsSchema`) |
| `task_environments` | E2B sandbox lifecycle records | Lifecycle-bound: `destroyed_at`, `destruction_verified_at` recorded per environment | Provider-side destruction with verification timestamps (migration `202609090002_task_environments.sql`) | `task_environments.destruction_verified_at` |
| `audit_events` | Tamper-evident security/activity log, per-user hash chain | **Indefinite, by design.** Migration `202609090006_audit_retention.sql` does NOT set a numeric window (despite the filename) — it drops `audit_events_user_id_fkey` so evidence survives account deletion and comments the `user_id` column as an opaque identifier, "never an email or phone number." The `prevent_audit_event_mutation` trigger (migration `202609090001_trust_capabilities.sql`) forbids UPDATE and DELETE outright | None possible without dropping the trigger; subject linkage is minimized via the opaque identifier instead | Trigger definition in the migration; `user_id` column comment; chain verification function `verifyAuditChain` exists (`services/trust/auditLedger.ts`) but has no production caller (control-matrix AL-4). ⚠ COUNSEL: confirm indefinite retention of pseudonymized security evidence |
| Stripe records | Invoices, charges, subscriptions, customer PII | Governed by Stripe's terms and tax/accounting law — **legal hold**, not controlled by HireAlpha deletion flows; explicitly out of scope for `purgeAccountTrustData` | Stripe dashboard / Stripe's own retention policy | Stripe dashboard; `deploy/env-contract.md` for key scope |
| Backups | Whatever the database contains at backup time | **Unknown/uncontrolled.** No backup configuration exists in the repo (README discrepancy 5); if Hetzner/Coolify-level snapshots exist, their retention was not verifiable while writing this. Deletions do not propagate into backups | To be defined together with BK-1 (documented schedule + tested restore). Until then the honest window for deleted data persisting in backups is "unknown" | None yet — creating this evidence is the BK-1 action item |
| Coolify environment variables | Secrets (`DATABASE_URL`, `OPENBAO_TOKEN`, `STRIPE_SECRET_KEY`, etc.) | Rotated per `deploy/env-contract.md` (quarterly for OPENBAO_TOKEN; on leaver/break-glass events) | Rotation procedure: new value off-machine → Coolify → redeploy → revoke old (overlap only for OPENBAO_TOKEN and STRIPE_WEBHOOK_SECRET) | Rotation dates recorded in the access review log per `ops/access-control.md` |
| Plausible analytics (self-hosted, own Postgres + ClickHouse) | Cookieless page events | Plausible CE defaults (verify the installed instance's settings) | Plausible's own data management; never contains HireAlpha trust data | `deploy/plausible/README.md`, `docker-compose.yml` |
| OpenBao transit key material | Master transit key `hirealpha-user-deks` | Life of the system; backing up this key is what makes DB restores able to re-encrypt per-user data | Key rotation is an OpenBao administrative action — no documented procedure yet (gap to close with BK-1) | `services/trust/userKeyBroker.ts`; `deploy/env-contract.md` |

## Known inconsistencies this schedule surfaces

1. **`memory_records` has a real retention engine; `hire_memories` and the
   `hire_*` logs do not.** The consented-memory store is the showcase
   (caps, sweeper, crypto-shredding, deletion reasons); the product log
   tables rely entirely on account-deletion cascade via a manual step. If a
   regulator or user asks "when is my sleep log deleted?", the current
   truthful answer is "when the account row is deleted, which happens on
   request" — not "automatically at N days."
2. **The audit retention migration's name oversells its content** — this is
   README discrepancy 1, repeated here because the retention schedule is
   where an auditor will look first.
3. **The backup row cannot be completed** until the hosting reality is
   verified. Everything else in this table is code-verifiable; that row is
   operations-verifiable only.
