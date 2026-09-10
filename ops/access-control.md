# Access Control

This document describes who can touch production, how access is granted,
changed, and removed, and how that is verified. It is written for the team as
it exists today (one founder, contractors with scoped repo access) and for the
team as it grows; the growth rules are stated even though they have not been
exercised.

## Current population and access model

- **Founder (CEO)** — the only person with production access today. Holds:
  Hetzner account (the VPS `vmi2997871`), Coolify control plane (deploys and
  environment variables), production database credentials via
  `DATABASE_URL`, OpenBao (the `OPENBAO_TOKEN` with transit encrypt/decrypt +
  datakey policy per `deploy/env-contract.md`), Stripe, GitHub administration,
  Google Workspace/Console, and the 1Password account if the connector is
  configured.
- **Contractors** — scoped repository access only. No Coolify access, no
  production database access, no access to any environment variable value.
  The scoping happens in GitHub (per-repository, least-privilege roles), not
  by sharing credentials of any kind.

There are no shared accounts. Any credential that more than one person would
need is a design smell; the answer is a new scoped identity, not a shared
password. ⚠ COUNSEL: contractor agreements should include confidentiality and
security obligations that match this document; that is a legal checklist item,
not an engineering one.

## Joiner / mover / leaver

**Joiner.** A new contractor gets, in this order: a written scope statement
(which repos, which role), a GitHub invite at that role, and nothing else.
Production access (Coolify, DB, Hetzner) is not granted to contractors by
default and requires the founder to (a) write down why the role needs it,
(b) grant the minimum subset, and (c) record the grant in the quarterly review
log. New employees or long-term contractors follow the same path; the
difference is only the scope statement's duration.

**Mover.** When someone's role changes, their access is re-derived from the
new role within one week, and the delta (granted, removed) is noted in the
review log. Access never accumulates silently across role changes.

**Leaver.** On the last day of involvement: remove GitHub access (revokes repo
and, transitively, any deploy path that goes through the repo), remove any
explicitly granted Coolify/Hetzner/Stripe invitations, rotate any secret the
person could have known if the relationship ended under strain — per
`deploy/env-contract.md` the rotation procedure is: generate the new value
off-machine, set it in Coolify for the consuming apps, redeploy, overlap
old+new only where the contract requires it (OPENBAO_TOKEN,
STRIPE_WEBHOOK_SECRET), then revoke the old. Session secrets
(`SESSION_SIGNING_SECRET`, `HIREALPHA_INTERNAL_KEY`) rotation forces
re-login everywhere, which is the desired leaver outcome.

## MFA requirements

MFA is required on every account in the privileged set: Hetzner, Coolify,
Stripe, GitHub, Google, and 1Password. Where the provider supports
hardware-key or TOTP MFA, hardware keys are preferred for the Hetzner and
Stripe accounts because they are the two accounts where a takeover is
equivalent to a full platform compromise (risk register R-04, R-09).

**Operating evidence: not yet collected.** The per-account MFA status has not
been verified and recorded. First action item: log into each account, confirm
MFA is active, and record the date and method in the quarterly review log.

## Production access policy

**Who can deploy via Coolify.** The founder only. Coolify builds from the
GitHub repository; a contractor's merged code does not deploy itself — a
human with Coolify access triggers or approves the deployment, which keeps the
change-management path (AC-1/CM-1/CM-2 in `control-matrix.md`) single-gated.
When a second person needs deploy rights, the gate becomes: PR reviewed by
someone other than the deployer, deploy recorded, deploy reversible via
Coolify's redeploy-previous-version.

**Who can read the production database.** The founder only, using
`DATABASE_URL` from the Coolify environment. Reading prod data is permitted
for operations and incident response, with two standing rules: (1) prefer the
certification database (`CERT_DATABASE_URL`, a separate empty database per
`deploy/env-contract.md`) for any testing, so prod data is never touched;
(2) never export customer content out of prod onto a laptop — query in place,
aggregate, and leave the rows where they are. The database is reached over
SSH to the VPS, not over a public Postgres port; the firewall posture that
guarantees this must be verified once and recorded (risk register R-05,
⚠ AUDITOR will ask).

**Ad-hoc scripts against prod.** Permitted for the founder, but anything that
writes should run inside a transaction and be reversible; `deploy/migrate.ts`
already enforces this pattern for schema (checksummed, advisory-locked,
single-transaction migrations that reject modified history — see
`deploy/migrations/` and `hire_schema_migrations`).

## Break-glass procedure

The break-glass path exists for the scenario where the normal path is
unavailable: Hetzner or Coolify console outage, lost credentials, or the
founder being unreachable during an incident.

1. **Recovery entry points, in order.** (a) Hetzner web console (SSH into the
   VPS independent of Coolify), (b) Coolify's own admin recovery (its database
   lives on the same VPS), (c) SSH keys held in the founder's 1Password.
2. **Credential escrow.** A sealed emergency kit (root SSH key, Hetzner
   recovery codes, 2FA reset codes, Coolify admin recovery) exists physically
   offline. Access to the kit is itself logged: breaking the seal is an
   incident and triggers `incident-response.md`.
3. **During an emergency.** Do whatever restores service safely; then, within
   24 hours, rotate every secret touched during the emergency using the
   rotation procedure in `deploy/env-contract.md`, and write the postmortem.
4. **Founder-unreachable case.** Once a backup person is designated (risk
   register R-01), that person holds a sealed copy of the kit with a
   documented "only when the founder is unreachable and production is failing"
   rule. Until that designation happens, the honest statement is: there is no
   second person, and a founder-incapacitation event means an outage nobody
   else can fix. This is the single strongest argument for closing R-01.

**Operating evidence: not yet collected.** The break-glass kit has not been
drilled. First action item: schedule a rehearsal that restores from the kit on
a spare instance, and record the restore time.

## Quarterly access review checklist

Run this every quarter; the first run creates the baseline. Keep the completed
checklist (with dates and screenshots where relevant) as the evidence.

1. **List every human with any production touchpoint** — founder, contractors,
   the emergency backup if designated — and their access level per system
   (GitHub, Coolify, Hetzner, Stripe, Google, 1Password, direct DB).
2. **Verify each access against the current role.** Remove anything not
   justified by a written scope statement. Record grants and removals.
3. **Verify MFA is active on every account** (per-account, not per-policy).
   Record method: hardware key, TOTP, or SMS (SMS is a finding to fix).
4. **Verify the Stripe API key in use is the restricted key** scoped per
   `deploy/env-contract.md`, not the account root key. Rotate if uncertain.
5. **Rotate `OPENBAO_TOKEN`** per the quarterly cadence in
   `deploy/env-contract.md`, using the overlap-then-revoke procedure; record
   the rotation date and operator, never the value.
6. **Review Coolify deploy history** for deployments nobody can explain; each
   unexplained deploy is traced to a commit and a person.
7. **Review GitHub audit events** (member additions, permission changes,
   personal access tokens) for the quarter.
8. **Re-check the database is not internet-exposed** (Hetzner firewall rules,
   Postgres bind address, no public port). Record the verification.
9. **Re-walk the vendor data flows** per the checklist in `vendors.md`.
10. **Re-read `ops/README.md` discrepancies** and update their status; a
    discrepancy closed by code lands with its commit and its own evidence.
