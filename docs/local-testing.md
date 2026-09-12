# Test a change locally, in seconds

A deploy is a 20-minute round trip through a full image build, and only the
last mile needs it. Everything on the conversational path and the browser path
runs locally against the same production services, so a fix can be exercised
before it is pushed.

All commands assume the bun shim on PATH:

```sh
export PATH="/Users/sashanksingh/Library/Application Support/reflex/bun/bin:$PATH"
```

## 1. A message, through the real turn engine

```sh
bun run scripts/bench-turn.ts "Find hotels near the Burj Khalifa"
bun run scripts/bench-turn.ts "check the rates for hotels near the Burj Khalifa" --dim 1
BENCH_TRACE=1 bun run scripts/bench-turn.ts "Find dinner near the Loop"   # every tool call + payload
```

This runs `runHireTurn` — the exact engine the bots run — with the production
model, the production API, live connectors, and real tool calls. The reply is
printed as JSON (`bubbles`, `card`, `source`). Nothing is texted: delivery is
captured, so a test cannot spam the thread.

`--dim N` labels the run; `BENCH_TRACE=1` prints each `/api/internal/*` call and
its response, which is how a "the lookup returned nothing" mystery gets solved.

The published benchmark tasks are in one place:

```sh
bun run scripts/bench-dim.ts 1 3 4        # several dimensions in order
bun run scripts/bench-dim.ts --all --trace
```

## 2. The browser path, on a real Kernel browser

```sh
KERNEL_API_KEY=... bun run scripts/kernel-booking-probe.ts
KERNEL_API_KEY=... bun run scripts/kernel-via-e2b.ts "https://www.yelp.com/search?cflt=vegetarian&find_loc=Chicago%2C+IL"
```

`kernel-booking-probe` runs the real agent loop (`deploy/kernelSession.ts`)
against a live hotel search and prints the steps and the final answer.

Note: this machine cannot reach Kernel's browser port (8443 is blocked on this
network), so a local `Connection error` is a property of the network, not of
Kernel. `kernel-via-e2b` runs the same flow from a cloud sandbox where the port
is open — use it whenever the local path reports a connection error.

## 3. The whole test suite

```sh
bun test spectrum/shared/ deploy/ services/ src/   # ~1400 tests
npx tsc -b                                          # frontend
bun run typecheck:backend                           # deploy/ + spectrum/ + services/
```

The backend typecheck is the gate that catches a missing import before an image
build does (a missing import is what crashed a live browser run with
`setBrowserLiveView is not defined` while `tsc -b` reported clean).

## What still needs a deploy

- iMessage delivery itself (Photon), and the bot's inbound handling.
- Postgres-backed queue behaviour: claiming a job, heartbeats, the live-view URL
  landing on the job row. The worker reads the production database, which is
  only reachable from the VPS.
- Anything that only exists in the built web bundle (`/computer/:jobId`).

For those, deploy and then check the live evidence rather than guessing: the
worker logs (`browser-worker` lines), and the session view itself —
`https://hirealpha.chat/computer/<jobId>?token=<token>`.
