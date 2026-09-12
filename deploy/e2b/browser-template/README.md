# E2B browser template

Fresh Chromium sandbox for every `hire_browser_jobs` task.

## Build and publish

Requires an E2B account with template-build permission and `E2B_API_KEY`.

```sh
export E2B_API_KEY=...
cd deploy/e2b/browser-template
bunx e2b template build   # prints the assigned template name/id
```

Set the resulting template in the worker environment:

```
E2B_API_KEY=<key>
E2B_BROWSER_TEMPLATE=hirealpha-browser   # or the id the build printed
```

The image's `CMD` is the CDP proxy (`node /opt/browser/cdp-proxy.mjs`), which
supervises Chromium on 127.0.0.1:9222 and rewrites the DevTools Host header on
9223 — the port the worker's `SANDBOX_CDP_PORT` expects. Do not override the
start command with a bare Chromium: remote CDP then fails with an opaque
timeout.

Template is versioned by e2b's immutable build IDs; rebuild and redeploy only
intentionally — record the build id in the launch-readiness checklist.

## What runs where

| Component | Location | Notes |
|---|---|---|
| Chromium + page storage | E2B sandbox | fresh per task, `/tmp` profile, destroyed after |
| Playwright driver, agent loop, vault credentials, DB | Coolify browser-worker | never enters the sandbox |
| Credentials | worker memory only | typed into the page as keystrokes over CDP at fill time |

## Sandbox guarantees

- **Fresh per task.** `Sandbox.create` per job; sandbox id and task id are
  recorded in `task_environments` and the audit ledger (`environment_created`,
  `environment_destroyed`).
- **No secrets in the sandbox.** Sandbox `envs` stay empty; the driver never
  runs inside the VM; credentials never touch sandbox disk or logs.
- **Egress denied** to metadata (169.254.0.0/16), loopback, link-local, RFC1918
  and other private ranges (`DENIED_EGRESS` in `services/trust/taskEnvironments.ts`).
  The in-page network policy (`deploy/browserNetworkPolicy.ts`) re-checks every
  request after redirects and rejects non-public HTTPS targets.
- **Destruction verified.** `withTaskSandbox` destroys in a `finally` path for
  success, error, cancellation and timeout, then confirms via
  `Sandbox.getInfo` (404 = destroyed). Verified result is written to the
  tamper-evident audit ledger.

`secure: false` is deliberate: `connectOverCDP` cannot send the traffic-access
token header a secure sandbox requires. The sandbox holds no plaintext
credentials, lives minutes, denies private egress, and is destroyed after the
task — recorded as an accepted trade-off in the launch checklist until an
authenticated CDP relay exists.

## Known gaps (tracked in launch checklist)

- Live noVNC session view shows the worker's local browser; with E2B mode the
  session URL serves progress/activity only (no live pixels). Handoffs still
  deliver the page screenshot next to the activity stream, and the challenge
  detection in `deploy/challengeDetection.ts` pauses the run there.
- Cross-task isolation proofs beyond destruction verification (cookie/file/
  process bleed tests) run in `deploy/e2bExecutor.test.ts` against the provider
  contract; live-VM evidence is Phase 6 certification.
