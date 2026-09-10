# Data Subject Requests (DSAR)

This document covers how a person asks for their data (access, export,
correction, deletion), how their identity is verified, what the response
contains, and — stated plainly — where the current tooling falls short of the
public promises. Nothing here claims GDPR or CCPA compliance; it describes the
mechanisms that exist in code and the manual steps that fill the gaps.
⚠ COUNSEL: the SLA interpretation, the identity-verification level, and the
gap disclosures below all need legal review before they are relied on.

## Intake channels

1. **Email: hello@hirealpha.chat.** The public, standing channel — it is the
   address printed on the privacy page (`public/pages/privacy.html`): "Email
   us at hello@hirealpha.chat any time to get a copy or a deletion of your
   data." Any email at that address that plausibly asks for data access or
   deletion is a DSAR, regardless of what words the sender uses; there is no
   required form.
2. **In-product, self-service:**
   - **Export:** `GET /api/trust/memory/export` (implemented in
     `services/trust/trustApi.ts`) returns the user's consented memories as a
     JSON attachment (`hirealpha-memory-export.json`) with
     `cache-control: no-store`, after decrypting with the user's per-user key
     via `exportUserMemories` in `services/trust/memoryLifecycle.ts`.
   - **Deletion:** `DELETE /api/trust/account` (same file) invokes
     `purgeAccountTrustData` and returns the per-table deletion counts.
   - **Scoped tools:** `DELETE /api/trust/memory` (all or per category),
     `DELETE /api/trust/memory/consent?id=`, `DELETE /api/trust/vault?id=`,
     and `DELETE /api/trust/capabilities/:id` allow partial exercise without
     a full account deletion.
   All in-product routes require an authenticated session
   (`resolveUser` → 401 otherwise), which is the identity verification for the
   self-service path.

**Intake log.** Every DSAR — email or in-product — gets a row in a simple
intake log (a file is acceptable at this scale) recording: received date,
channel, requester identity, request type, verification method, SLA due date,
fulfillment date, and evidence references. The GDPR and CCPA clocks start at
receipt of the email, not at the moment someone gets around to reading it,
so the mailbox must actually be checked regularly.

## Identity verification

- **In-product requests** are verified by the session itself: the caller must
  hold a valid signed session (`SESSION_SIGNING_SECRET`-based, per
  `deploy/env-contract.md`). No further verification is added to
  self-service flows — the session is the credential, and adding friction to
  an authenticated user's own data helps nobody.
- **Email requests** require connecting the requester to an account before any
  data is released or any deletion is executed. Steps, in order:
  1. Reply from hello@hirealpha.chat to the address on file for the account
     in question and ask the requester to confirm (a) the account's hire
     number(s) or signup email, and (b) one factual detail of recent activity
     (e.g., which hire they have, approximate start date). Never send data to
     an address that is not already the account address of record.
  2. If the request comes from a different address, treat it as third-party
     until proven: require the confirmation to be completed from the address
     of record, and do not act on the new address at all.
  3. For deletion specifically, prefer steering the requester into the
     authenticated in-product flow (`DELETE /api/trust/account`) so the
     verification is the session, not an email dance.
  4. Record the verification method in the intake log.
  ⚠ COUNSEL: this is deliberately a "reasonable" level of verification —
  sufficient to prevent casual exfiltration, not a full KYC process. Whether
  it meets "reasonable" for the request volume expected is a legal judgment.

## SLAs

- **GDPR: respond without undue delay, within one month (30 days)** of
  receipt, extendable by two further months for complex requests with notice
  to the requester within the first month. ⚠ COUNSEL to confirm the operational
  handling of extensions.
- **CCPA: respond within 45 days**, extendable once by another 45 days with
  notice. CCPA verification may only require a degree of verification
  reasonable in proportion to the request's sensitivity — another ⚠ COUNSEL
  point.
- In practice: acknowledge within 2 business days, fulfill well inside 30
  days, and log both dates.

## What the export contains — and what it does not

The self-service export (`GET /api/trust/memory/export`) returns
`{ exported_at, memories: [...] }` where each memory carries `id`, `category`,
`purpose`, decrypted `content`, `source`, `created_at`, `expires_at`. Only
non-deleted, unexpired rows are included (`exportUserMemories` filters
`deleted_at IS NULL AND expires_at > now()`), and decryption uses the user's
own per-user key via the OpenBao broker, so the export proves the encryption
layer works.

Honest scope note: today's automated export covers **consented memories
only**. It does not yet include the product log tables (`hire_nutrition_logs`,
`hire_workouts`, `hire_sleep`, `hire_spending`, `hire_pipeline`,
`hire_drafts`, `hire_memories`, etc.) or vault metadata. An email DSAR for
"all my data" therefore requires a founder-run query of those tables for the
verified user. ⚠ COUNSEL + engineering action item: either extend the export
endpoint or write and rehearse the manual export query set; the privacy page's
promise ("get a copy of your data") currently leans on the manual path.

## Verified deletion walkthrough

The in-product account purge is real and worth walking through, because every
step is verifiable in `purgeAccountTrustData`
(`services/trust/memoryLifecycle.ts`):

1. **`memory_records`** — hard `DELETE` of every row for the user. (Softer
   paths — `ciphertext = NULL, deleted_at = now(), deletion_reason =
   'account_deletion'` — exist for scoped deletion and the retention sweep,
   but account deletion removes the rows outright.)
2. **`hire_memories`** — the bot memory store (persona/key/value rows) is
   deleted per user.
3. **`consent_records`** — deleted, removing the consent trail's personal
   linkage.
4. **`vault_items_v2`** — saved credentials deleted.
5. **`capability_grants`** — any non-terminal grants flipped to `revoked`
   with `revoked_at`/`finalized_at` timestamps.
6. **`user_wrapped_keys`** — the per-user data key is destroyed:
   `wrapped_dek = NULL, destroyed_at = now()`, which the
   `wrapped_key_lifecycle` CHECK constraint (migration
   `202609090003_user_keys_and_vault_v2.sql`) makes irreversible — a
   destroyed key cannot hold a wrapped DEK. Any residual ciphertext
   anywhere is then cryptographically unrecoverable (crypto-shredding).
7. **Evidence:** the response body returns the per-table counts, and the
   endpoint appends an `account.trust_data_purged` audit event
   (`services/trust/trustApi.ts`). Note what survives by design: the audit
   event itself, under an opaque subject identifier — migration
   `202609090006_audit_retention.sql` removed the
   `audit_events → hire_users` foreign key precisely so deletion evidence
   survives the deletion, and its comment guarantees that column is "never an
   email or phone number."

### The honest gaps

1. **Non-trust tables are not covered by the in-product purge.** The log
   tables listed above hang off `hire_users(id) ON DELETE CASCADE`, but the
   purge does not delete the `hire_users` row, and no code path in the repo
   does (verified: no `DELETE FROM hire_users` exists anywhere). Fulfilling a
   full deletion therefore includes a founder-run manual step (deleting the
   `hire_users` row cascades the log tables), executed inside the 30-day
   promise window and recorded in the intake log. This is README discrepancy 2
   and must be either automated or formally accepted. ⚠ COUNSEL.
2. **Backups retain deleted data until they expire.** If any database backup
   exists (none is configured in the repo — README discrepancy 5), a deletion
   executed today does not propagate backward into it, so deleted personal
   data persists in backups until that backup's retention expires. The
   truthful current statement of the window is: **unknown and uncontrolled**,
   because the backup configuration could not be verified from the repo.
   Fixing BK-1 (documented backup schedule + tested restore) is a
   prerequisite for stating the window in the privacy notice. ⚠ COUNSEL on
   how to phrase backup retention in the notice once the window is known.
3. **Stripe and vendor copies.** Stripe retains its own copy of billing data
   under its legal/operational obligations; deletion of HireAlpha data does
   not delete Stripe records. This belongs in the response language for
   deletion requests (and in `retention-schedule.md`).
