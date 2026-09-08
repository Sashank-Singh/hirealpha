# Conversation load testing

A JMeter-style local load test with virtual users, ramp-up, repeated requests,
latency percentiles, assertions, and exportable reports. Runs with Bun already
used by the project; Apache JMeter and Java are not required.

```sh
npm run test:load
npm run test:load -- --users=100 --rounds=10 --ramp-ms=10000
npm run test:load -- --users=500 --rounds=2 --p95-ms=8000
```

The default is 100 users starting together, two rounds each, four fragments per
round spaced 150 ms apart. It uses the production 1.8-second quiet window and
six-second maximum collection window. Each user waits for their completed turn
before starting the next round (closed-loop load).

## What is exercised

- Actual `createMessageBursts` queue, `runHireTurn`, conversational Friend tool
  loop, and local per-user memory.
- Three simulated model calls and two simulated lookups per successful turn.
- Four fragments become one response, remain ordered, and retain their user ID.
- Conversation isolation, duplicate turns, overlapping turns for one user,
  missing completions, task failures, and unexpected network calls.
- End-to-end elapsed time from the first fragment; p50/p95/p99 from the last
  fragment; processing p95; throughput; peak active turns; event-loop delay;
  sampled final process RSS.

All HTTP calls are intercepted in this standalone process, with no fallback to
real network access. Model responses and external services are scripted. No
credentials are required, no iMessages are sent, and no live account is touched.
Temporary conversation memory is isolated from the testbed and production data.

This measures local orchestration under simulated latency. It does **not** test
Spectrum delivery, actual provider rate limits, semantic recommendation quality,
production database contention, multi-process operation, or restart recovery.
It is not proof that the live service supports the tested user count. The
existing messageBursts unit tests separately cover arrivals during active work
and media boundaries.

## Configuration

Use `--key=value`:

| Option | Default | Meaning |
|---|---:|---|
| users | 100 | Concurrent virtual users, up to 5,000 |
| rounds | 2 | Requests per user |
| ramp-ms | 0 | Spread initial user starts across this interval |
| fragment-ms | 150 | Gap between the four texts, up to 1,500 ms |
| model-ms | 100 | Simulated latency per model call |
| tool-ms | 50 | Simulated latency per external lookup |
| timeout-ms | 120000 | Deadline for the entire run |
| p95-ms | 5000 | Maximum passing p95 after the last fragment |
| fail-user-every | 0 | Every Nth user gets persistent simulated model 503s |
| out | timestamped directory | Report destination |

To model slower services, raise `model-ms` and `tool-ms` explicitly. These are
inputs, not predictions about real providers. Raise the run deadline for longer
soak tests. This generator waits for completions and does not represent an
unbounded arrival stream.

## Reports and pass/fail

Each run writes `report.html`, `summary.json`, `samples.json`, and `results.jtl`
under `testbed/load-results/` (ignored by Git). Open the HTML report in a browser.
The JTL uses standard JMeter CSV column names for importing into a JMeter results
listener; it is an export, not a JMeter `.jmx` test plan. Its thread-count columns
represent the configured virtual users; exact peak active turns are in JSON.

Exit status is zero only when all expected turns complete successfully, no
ordering/isolation/duplicate/network violations occur, and p95 meets the budget.
A timeout writes a failure report and exits nonzero. Failed runs retain details
in `samples.json`. Reports clearly label the simulated-service scope.

Verify failure detection:

```sh
npm run test:load -- --users=4 --rounds=1 --fail-user-every=2
npm run test:load -- --users=2 --rounds=1 --p95-ms=1
```

Both commands should exit **1**. The first checks provider failure detection;
the second checks that latency budgets actually fail the run. Do not treat a
successful local run as permission to run a load generator against production.

## Progressive replies

The driver now supplies the real progress callback and records `firstTextP95Ms`
(time after the last incoming fragment until the first outgoing text) separately
from full completion, plus `totalTexts` and each sample's `textCount`. The first
text may be an acknowledgment or a useful partial result. It permits up to two
intermediate texts and one final response, rejecting duplicate updates. The
simulated model includes a partial restaurant result before its second lookup.

```sh
npm run test:load -- --users=100 --rounds=1 --model-ms=1000 --tool-ms=500 --p95-ms=8000
```

This slow-service profile exercises progressive delivery; default fast calls
usually finish before the intermediate-message threshold. Full completion,
not an early acknowledgment, remains the latency pass/fail gate.
