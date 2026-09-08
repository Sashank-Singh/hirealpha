# Agent execution upgrade — September 7, 2026

## What was actually wrong

The Friend conversation path could run one additional lookup while composing its
answer. A second lookup or a draft returned by the model was stripped from the
reply without execution. Its earlier planner was told to stop whenever any mail,
calendar, or people context existed, even when that context was unrelated.

The lookup API also discarded targeted Gmail queries in favor of a recent-mail
window. Search results did not reliably expose the message IDs needed to prepare
replies. Calendar lookups used generic windows. The recommendation prompt chose
the first map result, and location enrichment could replace the whole request
with a generic restaurant search.

These are execution and retrieval defects. Changing the model alone would not
resolve them. This work does not establish how HireAlpha compares with Instinct.

## Implemented behavior

- One bounded decision loop can look up information, inspect results, select the
  next source, and save an email or calendar draft for review. Default: six
  actions plus a final answer. No repeated identical searches; one draft-save
  attempt per turn, with no automatic retry of an uncertain write.
- The loop receives conversation history, saved preferences, and known contacts.
  It uses the existing configured model endpoint with a lower task temperature
  and enough output capacity for structured actions and useful answers.
- Gmail search preserves exact search terms and returns message IDs. A subsequent
  `id=<message ID>` lookup reads up to 12,000 characters of the body through
  Google or the existing Composio path. Attachments are not read.
- Calendar queries specify start/end instants with timezone offsets, up to 31
  days per request. Invalid windows return instructions to correct the query
  rather than silently fetching unrelated dates.
- Explicit tool selection cannot accidentally invoke another connector because
  its name appears in a query. Existing account and persona checks still apply.
- Search and draft errors go back to the decision loop. A saved draft survives a
  subsequent model failure and still gets a review card. New draft cards bypass
  the menu's kind-level duplicate suppression.
- Recommendations are instructed to compare evidence with constraints and
  preferences, rather than automatically selecting the first result. Relative
  location enrichment preserves the rest of the query.
- Removed a sent-email response that promised follow-up monitoring even though
  that code path had not created a monitoring task.

## Verification

The original mail → calendar → reply scenario was reproduced as a failing test
before the fix. Targeted Gmail queries and unwanted connector fan-out were also
reproduced as failures before their fixes.

Regression coverage exercises both the conversation entry point and the actual
lookup handler with synthetic model responses, Google responses, and accounts.
It covers chained actions, escaped draft text, alternate sources after failure,
disconnected tools, malformed output, action limits, uncertain draft writes,
saved-draft recovery, targeted dates, and message-body retrieval.

Run:

```sh
bun test spectrum/shared/toolLoop.test.ts spectrum/shared/runHireTurn.test.ts deploy/agentLookup.test.ts
npm test
npm run lint
npm run build
bun build spectrum/alpha/src/index.ts --target=bun --packages=external --outfile=/tmp/hirealpha-agent-check.js
bun build deploy/hire-api.ts --target=bun --packages=external --outfile=/tmp/hirealpha-agent-api-check.js
```

The full test suite, web build, and bot/API bundles passed locally. Lint has
existing warnings. The separate strict Friend TypeScript check still reports
errors in older SDK wiring and helpers; bundling is not a substitute for that
check. No inherited model API credential was available for a live model trial.

## What this does not add

- Autonomous purchasing, phone calls, or a general authenticated browser tool in
  this conversation loop. Those require separate execution and result-verification
  work; the presence of service modules does not make them callable here.
- Reading Drive document contents, email attachments, or every calendar page.
  Calendar results come from the primary calendar and may be capped. An event
  listing is not a guarantee of complete availability.
- Durable multi-day execution, cross-restart task recovery, or a completion ledger.
- Proof of recommendation quality or model judgment: synthetic tests verify
  orchestration, not the quality of a live model's choices.

## Next acceptance gate

Deploy the bot and API changes together to a test environment, then use a
designated connected test account. Do not use a customer inbox for evaluation.
Try variations of these workflows with different dates, preferences, and wording:

1. Find an older booking confirmation, read its details, check the corresponding
   calendar window, and prepare a reply for review.
2. Compare nearby restaurants under a budget with a dietary preference; verify
   that uncertain hours, menus, and prices are identified rather than invented.
3. Follow a recommendation with “what about the second one?” and check that the
   previous context is used without asking the user to repeat it.
4. Interrupt a lookup or draft-save response; confirm that the user sees a clear
   blocker and no duplicate write occurs.

Record verified completion, user interventions, constraint violations, latency,
and cost across repeated attempts. Establish this baseline before changing the
model or adding more capabilities. Production deployment and external messaging
were not performed in this pass.

## Conversation-first follow-up (September 7)

Hired Friend users now enter `conversationalFriend.ts` before the old topic
routing cascade. Exact navigation, connection shortcuts, and opt-out controls
remain deterministic. Other personas and slash-command paths retain their
existing routing. The model receives conversation history, preferences, current
connection state, and available capabilities before deciding whether to act.

The capability registry exposes existing reminders, preference storage, personal
records, explicit logging, briefing, meeting prep, app cards, and workshop builds
and updates alongside the multi-step lookup/draft loop. Ordinary conversation
requires no tool. The personality prompt encourages contextual, warm replies and
light humor without forced onboarding or automatic life logging.

A missing Gmail, Calendar, or Drive connection can now save the original request
in local thread memory. After connecting, a user can say "continue" to resume.
This survives local process restarts but is not autonomous background execution.
Each confirmed action receipt survives a later model failure. Uncertain writes
are not retried within the same turn. Reminder creation supports once/daily/weekly
notifications; cancellation and arbitrary future tool execution are not exposed
by this new registry.

Regression checks cover casual/negated messages avoiding automatic writes,
contextual preference confirmation, connection/resume persistence, chained
lookups and drafts, and retaining receipts after model failures. These use
scripted model responses and verify orchestration, not semantic model quality.
The full suite passed 1,153 tests before the final purchase validation regression;
all 53 focused tests pass afterward. The web build and bot/API bundles pass.
Strict bot type checking still reports existing SDK/helper errors outside this
new runtime. No deployment or live model trial was performed.

Next live acceptance examples: "I'm tired of this app", "I didn't spend $80",
"brief me on the second email", "same time tomorrow", and a Gmail connection
interruption followed by "connected, continue". Evaluate task completion,
unwanted actions, follow-up continuity, latency, and whether the conversation
feels pleasant. A passing scripted test is not evidence of beating Instinct.

## Incoming text bursts

The Friend iMessage intake now groups consecutive texts from the same sender
and space after 1.8 seconds of silence, capped at six seconds from the first
fragment. Receipt is marked read immediately; one combined turn uses all text
fragments in order and replies to the last message. The intake keeps receiving
messages while work runs. Each conversation executes serially; other users can
proceed independently. Texts arriving during execution become the next grouped
turn, not a restart of potentially completed actions. Photos remain ordered
boundaries with their existing handling. This queue is process-local, does not
survive restarts, and does not consume typing events or revise an active task.
Timing, isolation, ordering, failure recovery, and duplicate-delivery tests pass;
the bot bundles. Deployment has not been performed.
