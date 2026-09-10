# Incident Response

This plan is written for the team that exists: one founder, no on-call rotation,
no security staff. That constraint shapes everything below. The plan's job is
to make a bad hour orderly, not to describe an organization that does not
exist. It should be reviewed annually and after every incident, and the
postmortem template at the end should be filled in for every SEV-1 and SEV-2.

## On-call reality

**There is no on-call rotation. The founder is the on-call, the escalation
path, and the incident commander, simultaneously and indefinitely.** The
documented mitigation for the resulting single-point-of-failure is risk
register R-01: designate one emergency backup person with scoped access and a
break-glass kit (`access-control.md`). Until that happens, the honest
statement is that an incident occurring while the founder is unreachable will
wait, and detection-to-response time is unbounded. Users should not be told
there is a 24/7 team, because there is not.

## Severity levels

- **SEV-1 — customer data or money is affected.** Confirmed or strongly
  suspected: unauthorized access to customer data, credential or vault
  exposure, unauthorized payment execution, ransomware or destructive
  compromise of the VPS, full outage (web + bots down). Response is immediate
  and takes priority over everything, including sleep and launches.
- **SEV-2 — service integrity is threatened.** Intermittent outage, one
  surface down (bots up but web down, or browser worker failing),
  suspicious-but-unconfirmed indicators (unexplained deploys, audit chain
  anomalies), a vulnerable dependency with public exploit in a prod path.
  Response within hours.
- **SEV-3 — contained degradation.** Single-user issues, delivery delays,
  non-exploitable bugs, vendor hiccups with workarounds. Next business day.
- **SEV-4 — cosmetic or informational.** Logged, batched, triaged weekly.

## Detection sources

Detection is currently thin, and this section does not pretend otherwise.
Working today:

1. **Coolify alerts and deploy history.** Failed health checks and failed or
   unexpected deployments are visible in the Coolify control plane.
2. **`/readyz` failures.** The web server's readiness endpoint
   (`deploy/web-server.ts`) performs a real database roundtrip and returns 503
   when the database is unreachable — "a real DB roundtrip, not liveness
   theater," as the code comment says. The browser worker exposes an
   equivalent `/healthz` (DB check, port `WORKER_HEALTH_PORT`). Coolify's
   health monitoring against these endpoints is the automated tripwire.
3. **Bot delivery anomalies.** The operational loops in `deploy/web-server.ts`
   (intro queue, watchtower, nudges) log failures; a sudden drop in outbound
   iMessage deliveries or a spike in Photon registration failures
   (`deploy/hire-api.ts`) is user-visible first — support email to
   hello@hirealpha.chat is a real detection channel at this scale.
4. **Stripe dashboard notifications.** Payment failures, disputes, and
   webhook delivery failures.
5. **Trust-layer data, queried manually.** `capability_grants` stuck in
   `needs_reconciliation` (unknown-outcome payments), and
   `audit_events` (queryable per user; the chain is verifiable with
   `verifyAuditChain` in `services/trust/auditLedger.ts`, though no scheduled
   verification job exists yet — control-matrix AL-4).

Not working yet: central log aggregation, alerting on trust-table anomalies,
anomaly detection on auth, and scheduled chain verification. Each is a PLANNED
control (AL-4, AL-5, R-08). ⚠ AUDITOR: an auditor will treat detection as the
weakest layer, correctly.

## Response steps

### 1. Detect and declare
The founder confirms the trigger, assigns a severity, and starts a timestamped
log (a private file or note is fine — the point is timestamps, decisions, and
actions, written as they happen). Declare early; downgrade later is free.

### 2. Contain
Goals, in order: stop ongoing harm, preserve evidence, avoid self-inflicted
wounds.

- Suspected credential/secret compromise: rotate the affected secrets
  immediately per `deploy/env-contract.md` (new value off-machine → Coolify →
  redeploy → revoke old), and force re-login by rotating
  `SESSION_SIGNING_SECRET` / `HIREALPHA_INTERNAL_KEY` if sessions are the
  concern.
- Suspected VPS compromise: stop the affected services from Coolify; if the
  box cannot be trusted, snapshot (for evidence) then rebuild from code —
  the entire system is reproducible from the repo plus the env contract,
  **except the OpenBao transit key and the database**, which is precisely why
  their backup status is risk register R-09. ⚠ Do not wipe before snapshotting
  unless data destruction is actively in progress.
- Suspected malicious browser task: worker concurrency is 1 per container
  (`CONCURRENCY = 1` in `deploy/browserWorker.ts`) — stop the worker via
  Coolify to halt task execution; jobs sit pending in `hire_browser_jobs`.
- Payment anomaly: revoke in-flight grants with
  `requestCapabilityRevocation` (`services/trust/capabilityGrants.ts`); grants
  in `consuming` become `cancellation_requested` and the Link flow supports
  cancel/deny statuses; investigate via `audit_events` and
  `hire_spend_approvals.finalization_status`.

### 3. Eradicate
Find the entry point (deploy diff, credential leak, vulnerable dependency,
compromised vendor), close it, and verify the closure — patched dependency
redeployed, leaked key revoked and confirmed dead at the provider, malicious
code path removed in a reviewed commit.

### 4. Recover
Restore service from the clean state: redeploy from the repo via Coolify,
restore the database from the last known-good backup if data was damaged
(if no backup exists, that fact goes in the postmortem with total honesty —
see README discrepancy 5), re-enable the stopped workers, and watch
`/readyz`, the worker `/healthz`, and bot delivery for one normal cycle
before declaring recovery.

### 5. Learn
Write the postmortem (template below) within five business days for SEV-1/2.
Blameless in tone, specific in mechanism.

## Breach notification decision tree (72-hour GDPR clock)

⚠ COUNSEL governs every decision in this section; the tree below is
engineering's best preparation, not legal advice. The clock that matters:
under GDPR Art. 33, a controller must notify the competent supervisory
authority within 72 hours of becoming aware of a personal data breach,
unless the breach is unlikely to result in a risk to individuals. Under
CCPA there is no general breach-notification duty, but California Civil Code
§1798.82 (a separate statute) requires notification of California residents
for breaches of unencrypted personal information — state breach laws apply
in parallel. Do not self-certify any of this; get counsel on the phone.

```
Incident declared
  └─ Does the incident involve personal data at all?
      ├─ NO (pure availability of non-personal services, no data touched)
      │    → no statutory notification; still fix + postmortem
      └─ YES → start the 72-hour clock AT AWARENESS. Write down the
           awareness timestamp; it anchors everything.
           ├─ Is the data encrypted end-to-end such that it is
           │   unintelligible to the attacker?
           │    ├─ YES (e.g., only ciphertext of memory_records /
           │    │   vault_items_v2 exposed — per-user AES-256-GCM,
           │    │   keys wrapped in OpenBao, not on the attacker's path)
           │    │    → potentially the Art. 34 "no risk" carve-out;
           │    │      COUNSEL decides; document the encryption analysis
           │    └─ NO / MIXED (plaintext log tables, DB dump, keys exposed)
           │         → assume notifiable; proceed
           ├─ Which individuals, which data, how many? (query the
           │   affected tables; audit_events gives per-user evidence)
           ├─ NOTIFY:
           │    ├─ Supervisory authority (Art. 33) within 72h unless
           │    │   COUNSEL concludes no-risk and documents why
           │    ├─ Affected individuals without undue delay (Art. 34)
           │    │   when risk to them is high
           │    ├─ Stripe per its terms if card/billing data involved
           │    ├─ Vendors involved (Photon/GMI/E2B/Hetzner) if the
           │    │   breach crosses their boundary
           │    └─ US state notifications per §1798.82 et al. if
           │        residents' unencrypted data affected
           └─ PRESERVE: the audit_events chain, access logs, deploy
               history, and the incident log — regulators ask for the
               record, and the append-only trigger guarantees the
               audit_events record cannot have been cleaned up.
```

Practical rule for a solo operator: at SEV-1 with any personal-data angle,
call counsel within hours, not after containment. The 72 hours are for
preparing a good notification, not for finishing the investigation.

## Postmortem template

Copy this into the incident file for every SEV-1 and SEV-2.

```
# Postmortem: <short title>            Date: <YYYY-MM-DD>
Severity: SEV-?   Duration: detect→recover <?h    Author: <name>

## Summary
2-4 sentences: what happened, who/what was affected, current state.

## Timeline (all times UTC)
- <t0> Detection: <source from the list above>
- <t0+?> Declaration: SEV-? declared by <name>
- <...> Key actions: containment, eradication, recovery, notifications
- <tN> Recovery confirmed: <evidence — readyz green, delivery normal, ...>

## Impact
- Users affected: <count / scope, or "none confirmed">
- Data involved: <tables/fields, or "none">
- Money involved: <amounts, grants, refunds issued>
- Notifications made: <authorities / individuals / vendors / none + why>

## Root cause
The technical chain of events, precisely. No blaming people; blame mechanisms.

## What worked / what didn't
Detection speed, containment options that existed or were missing,
documentation gaps hit during the response.

## Action items
| # | Item | Type (fix/process/doc) | Owner | Due | Status |
Each item links to a file path or issue. No item without an owner.

## Evidence preserved
<list: incident log, audit_events excerpts, deploy history, snapshots>
```
