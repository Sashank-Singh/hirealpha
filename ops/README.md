# HireAlpha — Operational Security & Privacy Launch Controls

This package documents the security and privacy controls that exist in the
HireAlpha codebase and operations today, together with the controls that are
planned but not yet built. It is written for three audiences: the founder (who
owns every control right now), future contractors (who need to know the rules
before they get access), and eventual counsel or an auditor (who need an honest
map of what exists versus what is aspirational).

## Standing statement

**Everything in this package describes controls that are built or planned.
None of it claims SOC 2, ISO 27001, HIPAA, or any other certification, and
nothing here should be read as a claim of compliance with GDPR, CCPA, or any
other regulation.** Where a control exists, the documents say so as "control
exists in code" or "control exists in operations." Where a control exists but
has never been exercised, reviewed, or evidenced, the documents say
"operating evidence: not yet collected." The distinction matters: code that
implements a control is not the same thing as a control that has been operating
reliably over time, and this package does not blur that line.

Where a decision belongs to a lawyer, an auditor, or the organization as a
whole rather than to engineering, the item is tagged ⚠ COUNSEL or ⚠ AUDITOR.
Those tags mean "do not treat the surrounding text as a decision — get the
decision made by the right person."

## Contents

| File | What it covers |
|---|---|
| `control-matrix.md` | Every control, its owner, its evidence source, and its build status (BUILT / PARTIAL / PLANNED) |
| `risk-register.md` | The top 10 risks with likelihood, impact, mitigation, owner, and status |
| `vendors.md` | Vendor and subprocessor inventory: purpose, data shared, DPA status, region |
| `access-control.md` | Joiner/mover/leaver, MFA, production access, break-glass, quarterly review checklist |
| `incident-response.md` | Severity levels, detection sources, containment, the 72-hour GDPR notification clock, postmortem template |
| `dsar.md` | Data subject request intake, identity verification, SLAs, export and verified-deletion walkthrough |
| `gdpr-ccpa-checklist.md` | ROPA draft, lawful bases, DPIA determination, international transfers, CCPA notice and do-not-sell |
| `retention-schedule.md` | Per-data-store retention, deletion mechanism, and evidence |
| `pen-test.md` | Penetration test scope, methodology, and remediation SLAs |

## How evidence is collected

Evidence in this package is deliberately tied to things that can be re-checked,
not to assertions. Three kinds of evidence are used:

1. **Code evidence.** A named file and the specific function, table, or
   constraint that implements the control. Anyone can re-verify it by reading
   the file. Example: the tamper-evident audit chain is implemented in
   `services/trust/auditLedger.ts` (per-user SHA-256 hash chain over
   `audit_events`), and the append-only guarantee is a database trigger
   (`prevent_audit_event_mutation`) created in
   `deploy/migrations/202609090001_trust_capabilities.sql`.

2. **Operational evidence.** A command that can be run, a query whose output
   can be saved, or a screenshot of an external system (Coolify deploy history,
   Stripe dashboard, Hetzner console). Where this package says "operating
   evidence: not yet collected," the collection step is written down as an
   explicit action item. As of this writing, **no control in this package has
   collected operating evidence over time** — the product is pre-scale and the
   review cadences (quarterly access review, quarterly secret rotation) have
   not yet completed a full cycle.

3. **External evidence.** Contracts, DPAs, and dashboard configurations that
   live outside the repo (Stripe DPA, Hetzner account settings, 1Password
   vault policy). Where these have not been obtained or verified, the vendor
   inventory in `vendors.md` marks them "DPA: NOT SIGNED" or "to verify"
   rather than guessing.

Review cadence: this package should be re-read in full at each quarterly access
review (see `access-control.md`), and the control matrix statuses updated.
The package is version-controlled in the repo alongside the code it describes,
so changes to the controls and changes to the documentation land together.

## Scope and ownership

HireAlpha is operated by a single founder with contractor support ("SF-based,
small independent team" per `marketing/launch-kit/00-facts.md`). Until the
team grows, every control is owned by the founder, and the vacancy notes in the
control matrix (e.g., "Security (vacant)") are honest: there is no security
function today, and pretending otherwise would be worse than the gap itself.

The system in scope is: the web application at hirealpha.chat (served by
`deploy/web-server.ts`), the iMessage bots (Friend live; Coworker and Cofounder
in the workshop), the browser automation worker (`deploy/browserWorker.ts`),
the trust layer (`services/trust/`), and the PostgreSQL database running on the
Hetzner VPS `vmi2997871` under Coolify.

## Discrepancies found while writing

These are places where what was asked for, what the documentation implied, and
what the code actually does diverge. Each is written truthfully in the relevant
file; they are collected here so nobody discovers them during an audit.

1. **Audit events have no retention window — they are retained indefinitely by
   design.** The migration file
   `deploy/migrations/202609090006_audit_retention.sql` does not set a numeric
   retention period despite its name. It does two things: it drops the foreign
   key `audit_events_user_id_fkey` so that audit evidence survives account
   deletion instead of cascading away with the user row, and it adds a column
   comment stating that `audit_events.user_id` is an opaque subject identifier
   retained as security evidence, never an email or phone number. Because the
   `prevent_audit_event_mutation` trigger (created in
   `202609090001_trust_capabilities.sql`) raises an exception on any UPDATE or
   DELETE against `audit_events`, no deletion mechanism can exist without
   dropping the trigger. The retention schedule in `retention-schedule.md`
   records this as indefinite retention with a pseudonymized subject column.
   Whether indefinite retention of pseudonymized security evidence is the right
   posture is a ⚠ COUNSEL question, not something engineering should decide
   silently.

2. **`DELETE /api/trust/account` purges trust data but does not delete the
   user's account row or the non-trust log tables.**
   `purgeAccountTrustData` in `services/trust/memoryLifecycle.ts` deletes from
   `memory_records`, `hire_memories`, `consent_records`, and `vault_items_v2`,
   revokes outstanding `capability_grants`, and destroys the per-user key in
   `user_wrapped_keys`. It does not delete the `hire_users` row, and no code
   path in the repository deletes it (verified: no `DELETE FROM hire_users`
   exists). All of the product log tables (`hire_nutrition_logs`,
   `hire_workouts`, `hire_sleep`, `hire_spending`, `hire_pipeline`,
   `hire_drafts`, etc.) reference `hire_users(id) ON DELETE CASCADE`, so they
   would be removed only if the `hire_users` row itself were deleted — which
   today happens, if at all, by manual SQL. The public privacy page
   (`public/pages/privacy.html`) promises removal of "nutrition, sleep,
   spending, network, pipeline, decisions, and connected-token records"
   within 30 days of account deletion. The in-product flow does not yet deliver
   that promise end to end; the email-driven flow depends on a manual step.
   This gap is recorded in `dsar.md` and the control matrix.

3. **Per-user encryption covers the trust layer only, not the product log
   tables.** `memory_records` and `vault_items_v2` are encrypted with
   per-user AES-256-GCM data keys wrapped by OpenBao transit
   (`services/trust/userKeyBroker.ts`). The product log tables listed above
   store their contents in plaintext in Postgres. That is a deliberate,
   documentable scope decision (they are operationally convenient to query and
   they cascade-delete), but the control matrix must say PARTIAL, and it does.

4. **The audit chain verification function exists but nothing calls it.**
   `verifyAuditChain` in `services/trust/auditLedger.ts` re-walks a user's
   hash chain and would detect tampering, but no scheduled job, endpoint, or
   operational procedure invokes it in production. The tamper-evidence control
   therefore exists in code but has never been exercised operationally. A
   periodic verification job is listed as PLANNED in the control matrix.

5. **No backup configuration exists in the repository.** There is no
   `pg_dump`, WAL archiving, snapshot script, or backup schedule anywhere in
   the repo; the only Postgres is the Coolify-managed instance on the Hetzner
   VPS. Whether any backup exists is a property of the hosting configuration,
   not the code, and it could not be verified while writing this package. The
   honest consequences, stated in `dsar.md` and `retention-schedule.md`: (a)
   the privacy page's 30-day deletion promise cannot be confirmed for backups;
   (b) the backup retention window is unknown and must be pinned down against
   the actual Hetzner/Coolify configuration; (c) if no backup exists, that is
   itself a top-tier availability risk and it is listed in `risk-register.md`
   as such.

6. **The pen test has not been scheduled.** `pen-test.md` defines scope and
   remediation SLAs so the engagement is ready to commission, but no
   third-party test has been booked as of this writing.

None of these discrepancies blocks launch on its own, but items 2, 3, and 5
should be resolved or consciously accepted by the founder before the privacy
page's promises are relied on in any customer-facing way. ⚠ COUNSEL for the
promise-versus-reality question in item 2.
