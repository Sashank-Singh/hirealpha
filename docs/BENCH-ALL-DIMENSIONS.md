# Everything: the repo, the iMessage path, how to test on this Mac, and all 15 dimensions

Written 2026-09-12. Written to be handed to another agent or read by the
founder with no other context. Every issue names the file, the evidence, and
the fix.

---

# PART 1 — The repo, mapped

```
/Users/sashanksingh/Projects/HireAlpha
├── deploy/                    the backend: one big API + the browser worker
│   ├── hire-api.ts            16k lines. ALL server routes. Maps tool lives here
│   │                          (fetchMapSearch, classifyMapQuery, mapAreaFromQuery,
│   │                          geocodeMapArea, buildOverpassQuery, fetchOverpass).
│   ├── web-server.ts          entry point for Coolify app "HireAlpha-Web"
│   ├── browserWorker.ts       entry point for Coolify app "HireAlpha-Worker"
│   │                          claims hire_browser_jobs, launches the browser
│   ├── browserSession.ts      Playwright driver for E2B sandboxes (CDP connect)
│   ├── kernelPage.ts          Kernel cloud browser, page-shaped (in-VM execute)
│   ├── kernelSession.ts       the agent loop on a Kernel browser
│   ├── agentDriver.ts         the agent's brain: prompts, action JSON, audit
│   ├── browserJobs.ts         hire_browser_jobs table + claim/handoff/result API
│   ├── browserVault.ts        approvals, credentials, result→iMessage delivery
│   ├── userPayments.ts        Link/Stripe spend approvals (decide/charge)
│   ├── e2bExecutor.ts         provider selection: kernel | e2b | local | disabled
│   └── browser-use/           noVNC live-view compose (NOT deployed)
├── spectrum/
│   ├── alpha/                 the Friend bot (the one that texts the founder)
│   │   ├── src/index.ts       Photon iMessage wiring: inbound → turn → send
│   │   ├── .env               GMI_MODEL=Qwen/Qwen3.8-Flash   ← LOCAL MODEL
│   │   └── bench-runtime.env  DeepSeek V4 Flash + prod DB key (gitignored)
│   ├── alpha-coworker/        Coworker bot (launchd, running)
│   ├── alpha-cofounder/       Cofounder bot (launchd, running)
│   └── shared/                the turn engine
│       ├── runHireTurn.ts     the turn: intent → tools → reply → card
│       ├── toolLoop.ts        the decision loop (lookups, drafts, grounding)
│       ├── conversationalFriend.ts  plain-chat path
│       ├── gmi.ts             model client (failover, retries)
│       ├── miniApps.ts        mini-app cards
│       └── *.test.ts          the suite
├── services/trust/            vault, capability grants, task environments
├── testbed/                   local iMessage stand-in (fixtures) + perf harness
├── scripts/                   bench + probe harnesses (see PART 3)
├── marketing/launch-kit/11-pawlan-self-bench.md   THE BENCHMARK (scores live here)
└── docs/                      local-testing.md, cloud-computer-diagnostic.md, this file
```

**Deploy targets** (Coolify at `coolify.alphasphere.trade`, token in
`~/.zcode/cli/config.json`):

| App | UUID | Runs |
|---|---|---|
| HireAlpha-Web | `ampdaixdebfrlv7pqcmojhb5` | hire-api.ts (`/api/*`, `/computer/:id`) |
| HireAlpha-Worker | `4puzx1k6ewpafcccsprfbdk7` | browserWorker.ts |
| HireAlpha-Friend | `drwwq3l81h2i6cf1n33agitq` | the Alpha bot on Photon |
| HireAlpha-Coworker | `toxniahittupkhdj8rcfsoho` | coworker bot |
| HireAlpha-Cofounder | `nunzd0rwo00e2fndwyasi50` | cofounder bot |
| HireAlpha-Database | `emr4talylynje35bnqycqytv` | Postgres 16 |

Deploy = push to `main`, then `POST /api/v1/deploy?uuid=<uuid>&force=true`.
Webhooks fire but **do not deploy**; always trigger the REST deploy and then
verify the container's `updated_at` moved. Never fire several deploys at once —
they queue sequentially and the resulting build load crashed Postgres into an
hour of recovery on 2026-09-12.

---

# PART 2 — The iMessage path, and why it fails

## 2.1 The path

```
your phone  ──iMessage──▶  +14155951440 (Photon project 3af40a72-…)
                              │
                              ▼
                   Friend bot (spectrum/alpha)  ← Coolify OR this Mac
                              │  runHireTurn
                              ├── maps / web / gmail / calendar / drive lookups
                              ├── propose draft → POST /api/internal/propose
                              ▼
                   /computer/<jobId>?token=…  →  session page (live view)
                              │
                   Worker claims the job → Kernel browser → agent loop
                              │
                   handoff (captcha/password) → waits for YOU
                   handoff (payment)          → Link/Stripe approval link
                              ▼
                   result → browser_result loop row → bot texts it
```

## 2.2 The issues, ranked by how much they cost

### I1 — A busy map server is reported as "no results" (FIXED, needs deploy)
`deploy/hire-api.ts` `fetchNearbyPlaces` made one Overpass request and parsed it
as JSON. Overpass under load answers **HTTP 200 with an HTML error page**
("the server is probably too busy" — reproduced live). The parse threw, the
catch returned null, and the user was told **"No map results found"**, then the
model was asked to answer a question it had just been told has no data.
**Fixed today:** retry across three mirrors (`overpass-api.de`,
`overpass.kumi.systems`, `overpass.private.coffee`), validate the body is JSON,
and never let a provider failure masquerade as an empty world.

### I2 — Landmarks geocoded to nothing (FIXED, needs deploy)
`geocodeMapArea` accepted only a whitelist of place types (city/town/suburb…).
Nominatim labels the Empire State Building `addresstype: office`, so "hotels
near the Empire State Building" geocoded to **null** and returned zero hotels —
while the raw coordinates were fetchable in one curl. **Fixed today:** reject
street classes instead of whitelisting place classes, plus strip leading filler
words ("hotels **the** Empire State Building").

### I3 — "…near X" was not recognised as a place ask (FIXED, needs deploy)
`toolLoop.ts` matched `find|recommend … restaurant|hotel…`, which does not match
"hotels **near** the Empire State Building". Verified map results were therefore
ignored and the reply fell back to whatever web search returned — booking-site
homepages. **Fixed today:** one shared `PLACE_ASK_RE` (exported from
`hire-api.ts`) covering "hotels near X", "cafe in Lisbon", "restaurant Chicago
Loop", while still not matching "no pork" or "my flight".

### I4 — Bad search results become answer links and run targets
A failed/hijacked web search put `Merriam-Webster "cheap"`,
`KAYAK flights`, `Best Buy store locator` into `publicMatches`, which is read by
both the reply and the browser-run router. **Partially fixed** (map results no
longer seed `publicMatches`; runs are gated by `isMerchantPortal`). **Still
needed:** a relevance filter — a result sharing no noun with the ask must not
appear as a link or a run target.

### I5 — The human live view may be unreachable
Kernel serves the live view on port **8443**, which the founder's network
blocks (verified: TCP fails locally, succeeds from a cloud sandbox). The worker
reaches it fine; the *person* solving the CAPTCHA may not. A run that waits for
a person who cannot open the page is stranded forever. **Options:** proxy the
view through `hirealpha.chat`; or relay the challenge into iMessage (send a
screenshot + ask for the code) so no second URL is needed.

### I6 — No typing indicator and no early acknowledgement
`space.responding()` sends the typing state, but Photon rejects
`ChatService/SetTyping` on this tier with `Target not allowed` and the SDK
swallows it. Long turns are a blind wait. **Fix:** send a real first bubble as
soon as the turn is classified as a task ("On it — checking real listings now.")
— an actual message, not a typing state — and keep the typing call as a bonus.

### I7 — Postgres on the box flaps under build load
One 8 GB VPS runs Postgres + builds + all containers. Concurrent deploys put it
into recovery for ~1 hour (2026-09-12), during which the worker cannot claim
jobs at all. **Fix:** the worker image no longer installs Chromium (done
today — that was minutes of every build), and the real fix is a separate
database host.

### I8 — Local bot and production bot share one Photon project
This Mac runs a Friend bot (pid 6768, `spectrum/alpha/.env`,
`GMI_MODEL=Qwen/Qwen3.8-Flash`) while production runs the same project with
DeepSeek V4 Flash. Texting the thread answers **from two brains with two
different models**, and the local one writes to its own thread file. For real
benchmark runs: stop the local bot, or run the test through the local bot
knowingly (see PART 3) — but never mix.

---

# PART 3 — Testing on this Mac, including iMessage by AppleScript

## 3.1 The fastest loop (no iMessage, no deploy)

```sh
export PATH="/Users/sashanksingh/Library/Application Support/reflex/bun/bin:$PATH"
cd /Users/sashanksingh/Projects/HireAlpha

bun run testbed:turn "check the rates for hotels near the Empire State Building"
BENCH_TRACE=1 bun run testbed:turn "…"     # every /api/internal call + its payload
bun run bench:dim 1 3 4                    # published dimensions, one after another
npm run typecheck:backend                  # catches missing imports (see I-imports)
```

This runs the **real** engine with the production model, the production API and
live connectors. Nothing is texted: delivery is captured, so it cannot spam the
thread. Numbers in `docs/local-testing.md`.

## 3.2 Driving the real thread from this Mac with AppleScript

The Mac's Messages.app can send an iMessage to Alpha's line, which is how a
full-channel test runs without touching the phone. Messages.app is running;
the first AppleScript send may raise a one-time Automation permission prompt.

**Send a test message:**

```sh
osascript <<'APPLESCRIPT'
tell application "Messages"
  set targetService to 1st account whose service type = iMessage
  set buddy to participant "+14155951440" of targetService
  send "Find hotels near the Empire State Building" to buddy
end tell
APPLESCRIPT
```

**Read the reply.** `~/Library/Messages/chat.db` is TCC-protected (copy fails
with "Operation not permitted"), so do not build a test loop on it. Read the
bot's own record instead — the bot writes every turn it ran, including the
reply text, to its thread file:

```sh
python3 - <<'PY'
import json
d = json.load(open('spectrum/alpha/data/threads/+12163032166.json'))
for m in d['history'][-6:]:
    print(m['role'], ':', str(m['content'])[:300].replace('\n',' | '))
PY
```

Caveat: that file is written by **whichever bot answered** — production writes
to the same path on its container, the local bot writes here. If the two are
both live, results are ambiguous (see I8). Pick one:

- **Local bot answers** (fastest, no deploy): the local bot is already running
  (pid 6768) — but it uses `Qwen/Qwen3.8-Flash` from `spectrum/alpha/.env`,
  not the production model. Start it with the production model instead:
  `cd spectrum/alpha && set -a && source bench-runtime.env && set +a && bun src/index.ts`
- **Production answers** (the real benchmark): `pkill -f "bun src/index.ts"`
  and let the Coolify bot answer. Then the only evidence available here is the
  thread on the phone plus the Coolify logs.

**Screenshot the thread** (for the record, and the fastest way to see the reply):

```sh
screencapture -x /tmp/thread-$(date +%H%M).png     # whole screen
```

## 3.3 Computer use, for the parts AppleScript cannot reach

When a test needs to *see* a UI rather than read a file:

- **The iMessage thread**: open Messages.app, screenshot, and read the bubbles.
  `osascript -e 'tell application "Messages" to activate'` brings it forward.
- **The live Cloud Computer view**: open the `/computer/<id>?token=…` link from
  the reply in the browser. That page embeds the provider live view
  (`streamUrl` from `/api/computer/session/<id>`), which is the exact browser
  doing the task — this is where a CAPTCHA gets solved by hand.
- **The session state as data** (no browser needed):

```sh
# Mint a view token for any job and read its state:
JOB=<jobId>; USER=701b8e97-3365-428c-84db-faeb152a40bb
TK=$(python3 -c "
import hmac,hashlib,time
job='$JOB'; user='$USER'; exp=int(time.time())+3600
print(f'{exp}.'+hmac.new(b'15d267831356b287a2c24d4605da490c4da1ae777845e2efc9806b883a006b9d', f'{job}:{user}:{exp}'.encode(), hashlib.sha256).hexdigest())")
curl -s "https://hirealpha.chat/api/computer/session/$JOB?token=$TK" | python3 -m json.tool
```

## 3.4 A full dimension run, end to end

```sh
# 0. one brain only
pkill -f "bun src/index.ts"                    # production answers, or
#   start the local bot with the prod model (3.2)

# 1. send the published task for the dimension
DIM=1
osascript -e "tell application \"Messages\" to send \"$(python3 -c "
import re,sys
t=open('marketing/launch-kit/11-pawlan-self-bench.md').read()
# print nothing here; keep tasks in the table below by hand")" ..."
```

Because the tasks are stable, keep them in one place and send by number:

| # | Task to send (dates resolved) |
|---|---|
| 1 | Book a hotel in Chicago Friday September 18 to Saturday September 19, under $250 a night, near the Loop, with free cancellation. |
| 2 | Book a round trip New York to Chicago, Friday September 18 morning out, Sunday September 20 evening back, aisle seat, under $400. Check in when the window opens and send me the boarding pass. |
| 3 | Find dinner for four tomorrow at 7:30 PM, walkable from the Loop in Chicago, vegetarian-friendly, not a chain, under $40 per person. Three options with why each fits. |
| 4 | Reorder two bags of the same coffee beans from Amazon using the home address. |
| 5 | Reply to Sam's Thursday email: decline and offer two real, available calendar slots in my tone. |
| 6 | (nothing — a flight is on the calendar tomorrow; observe) |
| 7 | Send me a weekday 7:00 AM digest with my calendar, replies owed, and weather. |
| 8 | Create a Notion task called "Send the deck", reserve a free 30-minute block on Thursday, and message Sam in Slack. |
| 9 | Connect Gmail, Calendar and Drive read-only, set "never send or spend without asking", then disconnect. |
| 10 | Remember for good: I always want an aisle seat on flights, and no pork anywhere we eat or order. |
| 12 | Call a restaurant and ask if they can seat eight people Saturday at 8:00 PM and whether a private room is available. |
| 13 | Text Om and Nithish, find a dinner date everyone accepts, and book the restaurant. |
| 14 | Check in for tomorrow's flight using the confirmation in my email and the passport information in my Drive. |
| 15 | (nothing — an ambiguous boss email, a delayed package, a friend's text; observe) |
| 16 | Create a birthday image featuring a dog and a 1990s trivia game for the group. |

Record each run in `11-pawlan-self-bench.md` under a new dated section, with:
production revision (git SHA of `main`), the channel, resolved dates, connected
providers and scopes, timestamps, the published task, the thread evidence, the
approval asked and taken, the real-world artifact, retries, the anchor score, and
a follow-up owner.

---

# PART 4 — All 15 dimensions: where we are, what wins each

Scores: current internal rehearsal, then what the competitor does. Instinct and
Muse numbers are from the tri-compare in
`marketing/launch-kit/` and `docs/` (Alpha 44 / Instinct 40 / Muse 27 overall).
**Instinct's edge is travel and full account control; Muse's is purchasing with
a virtual card. Neither has a maps tool.**

| # | Dimension | Us | Instinct | Muse | What "10" requires | The specific gap to close |
|---|---|---|---|---|---|---|
| 1 | Online task (hotel) | 6 | 9 | 7 | Real rooms, all three constraints, staged with a confirmation ask | I1+I2+I3 fixed → verified Loop hotels with rates. Then the run must reach the booking form and pause for payment. |
| 2 | Travel | 5 | 10 | 6 | Real fares, aisle seat, auto check-in, boarding pass | No airline check-in flow. Needs the airline login in the vault + an airline-specific step script (Web Check-In → seat map → boarding pass). Instinct wins this by logging into the user's own airline account. |
| 3 | Picks (dinner) | 3→7 | 3 | 4 | Three verified, constraint-satisfying, bookable choices | I1+I2+I3 fixed; maps now returns named places with walk times + diet tags. Remaining: opening hours/bookability (OSM has neither) → needs a booking site check, and "not a chain" is not derivable from OSM. |
| 4 | Purchasing | 6→8 | 6 | 10 | Correct item, saved address, confirm, order number | Spend-approval route was broken (unimported functions) — **fixed**. Needs: an Amazon connection or a repeatable product-page flow, and one real completed order with an order number. Muse wins because its virtual card is invisible to the merchant. |
| 5 | Email | 8 | 7 | 5 | Correct thread, verified slots, user's tone, sent under policy | Gmail reads work. Needs an inbound fixture (a real Sam email) and the draft→send approval to complete once. Then it is a 10. |
| 6 | Proactive | 4 | 8 | 5 | Check-in/gate handled before the user asks | Briefs exist and fire on time. Needs the flight-watch loop (airline status + gate) wired to the calendar. |
| 7 | Routine | 5 | 8 | 6 | Five-for-five weekday digests, editable, pausable | Weekday recurrence shipped (`weekdays` in reminders.ts). Needs a 5-day observation log and a pause command that works from chat. |
| 8 | Integrations | 3 | 7 | 5 | Notion + Calendar + Slack, all correct first try | Notion/Slack are simply not connected on this workspace; the friend tool allowlist excludes them. Connect via Composio, add to the allowlist, then it is a pass. |
| 9 | Permissions | 7 | 6 | 6 | Granular scopes, policy honored, disconnect verified | Auto-launch policy is explicit (password/payment only). Needs provider-level read-only scopes (currently Google is broad-read) and a verified disconnect deletion. |
| 10 | Memory | 3→7 | 8 | 6 | Applies a preference a week later, unprompted | Preference text is stored (`hard_nos: no pork`, `city`) and injection exists; needs an unprompted-application test after a delay, and the seat preference must reach the flight flow. |
| 11 | Personality | — | — | — | Not scored | Track quotes separately. |
| 12 | Phone calls | 3 | 5 | 4 | A real call, both questions answered | No telephony provider. One integration (Twilio/Retell) plus a call-result → iMessage summary. |
| 13 | Groups | 3 | 6 | 4 | Polls the group, agrees, books | The bot only talks to the requester. Needs a group-thread path (Photon group space) and a poll→agree→book flow. |
| 14 | Chained | 3 | 9 | 5 | Email + Drive → check in → boarding pass | Drive is not connected; needs the Drive connection plus the same airline check-in flow as #2. |
| 15 | Restraint | 5 | 7 | 6 | Handles the package, drafts the boss reply, waits on the friend | Needs three injectable fixtures (a boss email, a package notice, a friend text) and a rule for which get acted on. Today the parts exist; the scenario has never been run. |
| 16 | Images/games | 3 | 4 | 3 | Both artifacts work and iterate | No image generation wired and no in-chat game. Smallest version: an image API call + a text-native trivia game. |

## 4.1 The honest aggregate picture

- **Where we win today:** permission discipline (7), email search honesty (8),
  and maps — which neither competitor has at all.
- **Where the benchmark is won or lost:** dimensions 1–4 are all the same
  machine (search → verify → complete on a real site). Fixing I1–I4 moves four
  dimensions at once, which is why they were the priority today.
- **Where we cannot win by effort alone:** 2, 12, 13, 14, 16 need a third-party
  provider (airline login, telephony, group threads, Drive, image generation).
  Each is one integration, not a rebuild — but each is a deliberate product
  decision about spending and accounts.
- **Against Instinct:** they beat us on travel and full-account control because
  they log into the user's own airline/hotel accounts. Our counter is the same
  capability with an explicit ask-before-acting policy, which is also what
  dimension 9 scores.
- **Against Muse:** they beat us on purchasing with a merchant-invisible virtual
  card. We have the same idea (a one-time Link card) but **no completed
  purchase in production**. One real order is worth more than any feature here.

## 4.2 What to do next, in order

1. Deploy today's fixes (I1, I2, I3, spend-approval) and re-run dimensions 1, 3, 4
   through the real thread. These are the four dimensions the same machine owns.
2. Wire an early acknowledgement bubble (I6) so a run is never a blind wait.
3. Make the live view reachable for the human (I5) — proxy or in-thread relay.
4. Complete one purchase end to end (dimension 4). One real order number beats
   any feature work.
5. Then the provider integrations, cheapest first: Notion/Slack (dimension 8,
   already available in Composio), Drive (14), image generation (16), telephony
   (12), airline check-in (2, 14), group threads (13).
