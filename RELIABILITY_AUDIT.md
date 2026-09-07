# Reliability audit — September 5, 2026 (Pacific)

## Verified locally

The full test command passed 1,058 tests across 58 files. The web production build
and Friend bot bundle passed. Lint completed with 14 warnings in existing code;
these warnings are not a claim of runtime failure. Run `npm run check` for lint,
the full suite, and the web build. The Friend entry point was additionally bundled
with `bun build spectrum/alpha/src/index.ts --target=bun --packages=external`.

Fixes include the preceding Apps routing change:

- Apps requests return only the Apps card, before account/model work, even during
  profile lookup failure. Repeated requests are not throttled by the card router.
- Provider message IDs now identify inbound redeliveries. Distinct messages with
  identical text are accepted. The ID-less fallback preserves Unicode and uses a
  short exact-text deduplication window, rather than suppressing text for ten minutes.
- Friend delivery retries reuse the same turn result, avoiding a second execution
  of its tools. Card-only success is recorded as a successful send.
- A failed or malformed stop-switch lookup blocks proactive sends. An approval
  blocked by the switch is snoozed, not recorded as delivered.
- Task claims cannot overlap within one poller. Claim, acknowledgement, stop-switch,
  heartbeat, and model requests have deadlines on the paths changed here.
- Bot diagnostic reads and scoring require the internal bearer key. Missing
  configuration denies access. Scoring failures return HTTP 500 without exception text.
- Account lookup failures are distinguished from a confirmed missing account;
  the bot no longer treats an outage as evidence that tools are disconnected.
- A greeting followed by a real question is not replaced by the welcome template.
  Onboarding cannot override explicit tasks or save them as an onboarding priority.
- Returning-user introductions are filtered; saved-contact acknowledgements and
  explicit Gmail/Calendar connection requests have deterministic responses.
- The legacy systemd release script refuses dirty checkouts, preserves remote
  changes, verifies source revision, runs release checks, and fails on restart,
  health, or bundle mismatch. It no longer deletes old hashed client assets.

Regression tests exercise the original food/calendar-to-Apps scenarios, outage
responses, duplicate delivery identity, Unicode messages, blocked approvals,
stalled model calls, overlapping claims, diagnostic authorization, delivery retry
reuse, onboarding interruption, and deployment failures. External dependencies
are mocked; the tests do not send customer messages or perform purchases.

## Production observations

- Homepage: HTTP 200.
- `/healthz`: HTTP 200 with `ok`. This checks web-process liveness, not end-to-end readiness.
- `/api/status`: all three personas reported recent heartbeats; reply latency was null.
- SSH to `root@hirealpha.chat` rejected authentication. No private production logs,
  database rows, or deployment configuration were inspected through that connection.
- No production deployment or customer-facing test message was performed.

## Release blockers and remaining work

1. Obtain the authenticated Coolify connection or the correct SSH host. The repo
   documents Coolify; the legacy systemd script is not a substitute for that deployment.
2. Deploy the reviewed revision with a rollback target, then validate card-only
   Apps delivery, connected Calendar reads, approvals, and reconnect behavior on
   a designated test account. Live OAuth, payment webhooks, and iMessage delivery
   have not been exercised by this local suite.
3. Diagnostic authentication must be verified against the deployed bot endpoints.
4. Deduplication remains process-local. Durable delivery receipts/outbox semantics
   are still needed for guarantees across restarts or multiple replicas. An
   ambiguous provider timeout cannot establish whether a message was delivered.
5. The task-result API can fail after a send. Such failures are now logged, but
   durable acknowledgement retries and provider idempotency need a separate design
   to prevent duplicates following lease expiry or process failure.
6. A true readiness check should validate dependencies. Current heartbeat and
   liveness responses do not establish that database, OAuth, model, and messaging
   services can complete a user task.

This is a bounded reliability pass with verified fixes, not a certification that
every route is secure, every feature is complete, or the system cannot fail.
