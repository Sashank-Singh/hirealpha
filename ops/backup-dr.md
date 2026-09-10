# Backup, restore, and disaster recovery — plan and honest status

## Status: NO BACKUPS EXIST (BLOCKED)

Nothing in this repo or the VPS configuration creates database backups. The
DSAR backup-retention window is therefore unknown and uncontrolled, and total
data loss (VPS disk failure) is risk R-09 in `risk-register.md`. Everything
below is the plan; the restore test cannot run until step 1 exists.

## Plan

### 1. Daily logical backup (smallest thing that works)

`pg_dump --format=custom` of the prod database, nightly, kept on a second
machine. Suggested: cron on the VPS, output piped through `age` (or `gpg`)
using a key stored OFF the VPS, then `rclone` to any second location (even a
laptop pull). Retention: 14 daily, 8 weekly. Secrets (connection string, age
key) live in Coolify env + the founder's password manager — never in the repo.

### 2. Restore test (the control that makes backups real)

Quarterly, staged: restore the newest dump into `hirealpha_restore_test` on
the VPS, boot the web app against it, run the canary script
(`scripts/canary-staging.ts` with `CANARY_BASE_URL` pointed at a localhost
instance), record PASS + timings in `marketing/evidence/`. An untested backup
is a hope, not a control — this test is the evidence an auditor asks for.

### 3. RPO / RTO targets (to confirm with founder)

- RPO: 24 hours (nightly dump) until WAL archiving is justified by revenue.
- RTO: 2 hours — recreate VPS → restore dump → redeploy Coolify stack →
  DNS intact. The full stack is infrastructure-as-repo (Dockerfiles + Coolify
  apps re-creatable), so RTO is dominated by restore time, not rebuild time.
- ⚠ COUNSEL: confirm whether any contractual/regulatory RPO/RTO applies.

### 4. Disaster-recovery runbook (when the day comes)

1. `HIREALPHA_DISABLE_BROWSER_JOBS=1` (kill switch) + pause Coolify apps —
   stop writes before restoring.
2. Restore newest healthy dump into a fresh database; keep the corrupted one.
3. Point apps at the restored DB (Coolify env change), redeploy, verify
   /readyz + canary script PASS.
4. Re-enable browser jobs. Postmortem within 48h per `incident-response.md`.

## Evidence expectations

| Control | Evidence | Status |
|---|---|---|
| Backup exists | dump file listing + age-encrypted object | NOT YET |
| Restore works | canary PASS against restored DB, dated | NOT YET |
| DR rehearsed | timed runbook walkthrough, dated | NOT YET |
