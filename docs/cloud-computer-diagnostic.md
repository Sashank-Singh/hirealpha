# Why the Cloud Computer still doesn't complete a booking — full diagnostic

Written 2026-09-12 for a handoff. Every claim below is either reproduced live
in this session or read from production state, and the evidence is quoted.

## 1. The intended setup

```
iMessage (Photon line +14155951440)
   │  user texts "book a hotel in Chicago Friday under $250"
   ▼
Friend bot  (Coolify app HireAlpha-Friend, spectrum/alpha/src/index.ts)
   │  runHireTurn → intent classify → tool loop
   ├── maps tool   → OpenStreetMap Overpass + Nominatim  (no key, no account)
   ├── web tool    → DuckDuckGo
   ├── gmail/calendar/drive → Composio (user's own OAuth)
   ▼
browser task  (proposeBrowserTask → POST /api/internal/propose kind=browser)
   │  insert hire_browser_jobs row (pending), text back a /computer/<id> link
   ▼
Browser worker (Coolify app HireAlpha-Worker, deploy/browserWorker.ts)
   │  claim pending job → launch provider browser → agent loop
   ├── Kernel cloud browser  (KERNEL_API_KEY)  ← current provider
   │     managed stealth + proxy + CAPTCHA solver, live view URL, in-VM Playwright
   └── E2B sandbox (E2B_API_KEY)               ← fallback provider
   │
   ├── verify content → screenshot → pushBrowserResultLoop
   └── at money/CAPTCHA/password → onHandoff → status 'waiting'
          CAPTCHA/login → user opens live view and solves it → resume
          payment       → Link/Stripe approval link texted to the user
   ▼
result lands back in iMessage (task loop poller → bot sends bubbles)
```

Goal in one sentence: **the user texts a task, the cloud browser does it on the
real site with the user's own accounts, the user is asked only when a human is
legally required (payment, CAPTCHA, password), and the confirmation comes back
in the thread.**

## 2. What is actually working (verified)

- **The worker claims and runs jobs.** `hire_browser_jobs` job
  `a8704065-65e6-4b30-94e2-2024384295e5` reached `status: waiting` with live
  activity rows — the queue, the provider launch, the agent loop and the
  handoff all fired.
- **Kernel is the live provider and it is reachable from the box.**
  `resolveBrowserExecutorMode()` returns `kernel`; the run above got a Kernel
  live view URL and loaded a real page.
- **Kernel's stealth clears walls our own Chromium could not.** The same Yelp
  search that answered E2B Chromium with a device-verification interstitial
  returns real listings through Kernel (Handlebar 4.1, PLANTA Queen 4.3).
- **The live view is wired.** The session API returns the provider's live view
  as `streamUrl` (verified: `https://proxy.iad-elated-ellis.onkernel.com:8443/browser/live/AcUurXU0b6ZQ`).
- **Runs are gated to real merchant origins.** `isMerchantPortal` /
  `pickBrowserPortal` reject Yelp/Tripadvisor/Wikipedia/search pages; tests pin
  it (`spectrum/shared/toolLoop.test.ts`, "browser run routing").
- **Payment and password steps pause** rather than proceeding
  (`onHandoff` → `status: waiting`, `handoff_kind` set).
- **Maps answers are real when the lookup succeeds** (Burj Khalifa returns Taj
  Dubai, Radisson Blu, LEVA, Rove City Walk with walk times).

## 3. What is broken, in the order it bites

### 3.1 THE CORE BUG — search silently converts a transient failure into "nothing found"

`deploy/hire-api.ts` `fetchNearbyPlaces()` posts one Overpass request and does
`await res.json()`. Overpass under load answers **HTTP 200 with an HTML error
page**:

```
Error: runtime error: open64: 0 Success /osm3s_osm_base
Dispatcher_Client::request_read_and_idx::timeout. The server is probably too busy
```

Reproduced live this session. The `res.json()` throws, the `catch` returns
`null`, and the caller reports **"No map results found for …"** — a temporary
server hiccup presented to the user (and to the model) as a fact about the
world. Then the tool loop falls back to a web search, which for a
hotel-shaped query returns booking-site homepages and dictionary pages, and the
turn ends with the model correctly saying it has nothing.

Same query, immediately after, with a retry: real hotels. So the difference
between a good answer and "I could not verify any hotels" is currently luck.

**Fix:** retry Overpass (2 attempts with a short backoff), try a mirror
(`overpass.kumi.systems`, `overpass.private.coffee` — both verified answering
this session while `overpass-api.de` was refusing), and validate the response is
JSON before trusting it. Only then may the result be reported as empty.
Non-negotiable: **a provider error must never be presented as "no results".**
That distinction is the difference between "the internet has no hotels" and
"ask me again in a minute."

### 3.2 Bad search results are promoted to real answer links

The Empire State thread ends with `Merriam-Webster "cheap" definition`,
`KAYAK flights`, and `Best Buy store locator` as if they were results. Those
come from the failed web search being folded into `publicMatches`, which both
the reply and the browser-run router read. A dictionary definition must never
become a bullet in a hotel answer or a run target.

**Fix:** keep a relevance filter on `publicMatches` (the ask's own nouns), and
never let a search whose results share no meaningful term with the ask seed a
browser run.

### 3.3 The provider-hosted view is unreachable from some networks

Kernel serves CDP and the live view on port **8443**, which the founder's
network blocks (verified: `nc` to the proxy host fails locally; the same host
and port succeed from a cloud sandbox). The worker's own access is fine (the
run reached `waiting`), but **the human** is the one who has to open that URL
for a CAPTCHA — and if it does not load for them, the run is stranded forever in
`waiting`.

**Fix (in order):** (a) confirm the view loads from the founder's devices; (b)
if not, do not rely on it — relay the challenge into iMessage instead
("send me the code / I need you to tap 3 boxes, here is a screenshot"), or (c)
proxy the live view through `hirealpha.chat` so the port is never exposed to the
user.

### 3.4 No typing indicator, so every turn is a blind wait

The bot calls `space.responding()`, which sends the iMessage typing/read state,
but Photon rejects `ChatService/SetTyping` for this tier with the same
`Target not allowed` gate it applies to brand-new targets, and the SDK swallows
it as best-effort. There is no fallback, so the user sees nothing until the
first bubble — which after the fixes above can be 30-90 seconds of agent work.

**Fix:** send a lightweight first bubble as soon as the turn is classified as a
task ("On it — checking real listings in Chicago now."), which is a real
message rather than a typing state, and/or confirm with Photon that typing is
enabled for the project.

### 3.5 The end of the chain has never been proven with real money

Every piece exists in code — merchant checkout → `stageLinkPaymentHandoff` →
Link/Stripe approval → `chargeApprovedSpend` → order confirmation — but no
booking has ever been completed end to end, because no run has survived section
3.1-3.3 long enough to reach a payment page. The spend-approval route was itself
broken until today (`getLiveProfile`, `decideSpendApproval`, `chargeApprovedSpend`
were called without being imported); that is fixed and deployed.

## 4. What is genuinely missing (not broken — absent)

| Capability | Status |
|---|---|
| Airline check-in + boarding pass | Needs the user's airline login in the vault; no airline-specific step flow exists. Today the model declines this honestly. |
| Email/Drive chain (benchmark dim 14) | Drive is not connected on the account; Composio Google scopes are broad-read, not read-only. |
| Notion / Slack (dim 8) | Not connected on this workspace; the friend tool allowlist excludes them. |
| Telephony (dim 12) | No provider. One integration (Twilio/Retell) away. |
| Group threads (dim 13) | The bot only ever talks to the requester. |
| Image generation (dim 16) | No provider wired. |

## 5. How to verify a fix locally before deploying

`docs/local-testing.md` (pushed). Short version:

```sh
export PATH="/Users/sashanksingh/Library/Application Support/reflex/bun/bin:$PATH"
bun run testbed:turn "check the rates for hotels near the Empire State Building"
BENCH_TRACE=1 bun run testbed:turn "…"      # every tool call + payload
npm run typecheck:backend                    # catches missing imports
```

A local run executes the real engine with the production model and real
connectors; only iMessage delivery and the Postgres queue need a deploy.

## 6. The single highest-leverage fix

Section 3.1. Every observed "the search doesn't work" symptom this week traces
to one un-retried HTTP call that turns a busy server into "no results", after
which the model is asked to answer a question it was just told has no data.
Fix the retry and mirroring, keep provider errors distinguishable from empty
results, and the same engine starts returning the hotels it demonstrably can
return.
