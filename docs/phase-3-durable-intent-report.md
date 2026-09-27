# Phase 3 durable intent checkpoint

Date: 2026-09-26

## Changes

- UX10: commitment parsing normalizes curly apostrophes, requires a direct first-person statement, preserves explicit local clock time, and converts it with a DST-stable wall-clock conversion.
- UX16: Vault-dependent browser tasks now persist one task identity through `pending -> preparing -> queued`, or `pending -> preparing -> retryable_failure`. Login-missing returns to `pending`; only a successful enqueue or explicit cancellation clears the task.
- UX17: watch cadence and `runs`/`totalRuns` live in the database payload. The result API persists the replacement payload in the same update as the next schedule. Failed enqueue does not consume a run. Completion names the configured count and stops the loop.
- UX18: scheduled texts now use `pending -> preparing (lease) -> sending (lease) -> sent|failed`. Expired `preparing` rows are reclaimable. Expired `sending` rows become `outcome_unknown` and are not blindly resent. Claims and acknowledgements are fenced by a UUID token; provider IDs are stored when supplied; duplicate schedule requests use a unique idempotency key; failed sends attempt an owner notification.
- UX19: inbound stop/correction messages synchronously invalidate active work and abort supported work before waiting for the queued turn. A durable version record distinguishes `cancelled` before provider dispatch from `cancellation_requested -> outcome_unknown` during provider dispatch.
- EX21: watch intervals accept numeric or numeric-string whole hours from 1 through 168. Invalid, fractional, zero, negative, NaN, and over-limit values fail instead of defaulting or clamping.
- EX22: idempotency inputs use canonical typed JSON, retaining object equivalence while separating types, array order, nested structure, and delimiter-bearing strings.

## Schema

`deploy/migrations/202609260001_durable_intent.sql` adds scheduled-text lease, claim token, provider delivery ID, attempt count, idempotency key, and update timestamp columns. Partial concurrent indexes cover idempotent insertion, due claims, and expired lease reconciliation. The migration is additive, resumable, uses the repository's non-transactional migration protocol, and limits lock acquisition through the runner's five-second lock timeout.

## Verification

- `npm run lint`: pass; three pre-existing `no-eval` warnings.
- `npm run typecheck:backend`: pass.
- `npm test`: 2,498 pass, 22 skipped, 0 fail.
- `npm run build`: pass; Vite retains its existing non-module analytics-script warning.
- `bun test deploy/imageCopies.test.ts`: 4 pass, 0 fail.
- `git diff --check`: pass.

Regression coverage includes spring/fall DST, quoted commitments, typed idempotency collisions, interval validation, browser retry across restart, atomic watch payload persistence, immediate interruption, durable version cancellation, scheduled-text lease recovery, unknown outcomes, provider identifiers, and duplicate scheduling.

## Evidence gaps

`DATABASE_URL` was unavailable, so live PostgreSQL migration application and provider-backed scheduled-message delivery were not certified. The full local suite exercised SQL shape and state transitions; live database/provider certification remains a deployment-stage check.

The working tree also contains the prior Phase 1/2 changes and the user's email prototype edits. Phase 3 did not remove or redesign that prototype. Phase 4 has not started.
