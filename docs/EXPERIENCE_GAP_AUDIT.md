# Alpha Experience-Gap Audit — "If I can just text it like an assistant, where does it let me down?"

Date: 2026-09-27
Method: static execution-path tracing across the full codebase (six parallel deep audits: agent loop/tools, email/calendar/contacts, memory/state, proactive systems, browser/exec/travel, surfaces/domain), plus the repo's own recorded live-run evidence (`docs/cloud-computer-diagnostic.md`, `docs/purchase-browser-search-audit.md`, `docs/instinct-gap-closure.md`, `docs/alpha-email-experience.md`). No production behavior was modified; no synthetic conversations were run in this pass (the prior docs already contain recorded live failures, cited where used). Every claim below is grounded in `file:line` evidence or a recorded run.

The standard applied throughout: the user says something naturally → Alpha understands → retrieves context automatically → takes the useful action → verifies what happened → remembers the result → follows up when needed → costs less effort than doing it manually. Every place that chain breaks is documented.

---

# Part 1 — Actual Capability Inventory

Three personas, three separate iMessage numbers (friend +14155951440, coworker +162826476476, cofounder +14156035536; `deploy/personas.ts`, `src/agents/definitions.ts`). iMessage is the **only** transport (`spectrum/alpha/src/index.ts:46-52`); the README's "SMS, WhatsApp, Slack" claim is aspirational (`README.md:5` vs no provider in any bot runtime). Memory is **per user+persona** (`hire_context` keyed on (user, persona), `deploy/db/schema.ts:89-96`) — the coworker number does not know what the friend number knows.

Classes: **A** read · **B** suggest · **C** draft/stage · **D** execute · **E** monitor/follow up · **F** verify completion · **G** undo/edit/cancel.

## Email

| Operation | Class | State |
|---|---|---|
| Search/read inbox | A | Real. Gmail REST + Composio fallback; 2-day default window, cap 30 (`MAIL_READ_WINDOW='2d'`, `deploy/gmailHelpers.ts:26-27`); full-body read via `id=` capped 12k chars, **attachments not included** (`deploy/hire-api.ts:1471`) |
| Summarize/triage ("needs you") | A/B | Real. Model judge with piles (reply/thanks/assessment/money/delivery), needs-you ranking with reasons (`deploy/aiJudge.ts:47-79`, `gmailHelpers.ts:447-596`), cached 15 min |
| Detect promises in mail ("Priya sends specs by Friday") | A/E | Real, best-effort; judge extracts `promise` → open loop (`hire-api.ts:2517-2544`) |
| Draft reply / new mail | C | Real. Saved to `hire_drafts`, never auto-sent; rewrite endpoint exists (`routes/mail.ts:270-309`); drafts also savable to Gmail's Drafts folder (`google/actions.ts:129-166`) |
| Send | D | Real **only after explicit human tap** (`approve_send` card → `/api/work/send`) or the literal in-chat "send it" on a retained delegate draft (`runHireTurn.ts:1317-1346`) |
| Verify send | F | Strong. Success requires Gmail returning a message id; unknown outcomes stored `outcome_unknown`, never retried (`google/actions.ts:88-94`, `routes/work.ts:304-325`) |
| Send attachment (Drive file) | D | Real, 25 MB limit, idempotent (`google/actions.ts:31-66`) |
| Read/summarize attachments or PDFs | A | **Missing.** No attachment download/parse anywhere |
| Forward | D | **Missing.** Subjects forced to `Re:` (`gmailHelpers.ts:478-482`); no forward in tool grammar |
| Mark read/unread, archive, label, trash | D | **Missing.** No `gmail.modify` scope granted at all (`hub.ts:751-759`); triage feedback is recorded, not applied |
| Undo send / cancel sent email | G | **Missing.** No Gmail trash/modify call exists anywhere |
| Follow-up on a thread ("nudge me if no reply by Fri") | E/F | Real and re-verifying: `hire_email_followups` re-reads the live thread, auto-resolves if the participant replied, honest on read failure (`routes/reminders.ts:22-66`) |
| Generic "did they answer my last email?" | A | **Not modeled.** Only (a) an explicit follow-up row, or (b) the 20h-capped watchtower ping on new inbound mail |
| Schedule future send | D | **Explicitly forbidden** (`conversationalFriend.ts:669`) |
| Proactive "you have unread mail that needs you" | E | Real: inbox watchtower every 30 min, regex score ≥70 then model judge, ≤1 ping/20h (`deploy/nudges/watchtower.ts`) |

## Calendar

| Operation | Class | State |
|---|---|---|
| List/read day/week | A | Real (primary + up to 4 chosen secondaries; ≤31-day tool window) |
| Find free slots | A | Real logic, **likely broken in production**: the `free_slots` tool POSTs to `/api/internal/work/slots` which has **no deploy-side handler** (`spectrum/shared/liveContext.ts:441-473` vs `routes/work.ts:419` GET-only; mock at `testbed/audit/harness.ts:244`). Against the live server the tool must refuse to offer times |
| Create event/hold | C/D | Real as staged draft → `pick_slot` card → Book tap writes a `tentative` hold with a stable idempotent id (`google/actions.ts:283-333`) |
| Move/reschedule existing event | D/G | Real but brittle: requires resolving the provider event id first, update needs **both** start and end; no enforced conflict re-check (prompt advice only); **no undo** |
| Cancel event | D/G | Real (410 tolerated); model-invoked cancel is a **silent write, no confirmation card** (`conversationalFriend.ts:744-751`) |
| RSVP | D | Self-only responseStatus patch; refuses if user not an attendee (`google/actions.ts:362-367`) |
| Invite attendees | D | **Missing.** No attendees write anywhere |
| Other people's availability ("when can Sarah and I meet?") | A | **Missing.** freeBusy queries the user's primary calendar only (`google/actions.ts:252`). Answering "when can I meet Sarah" from your own free slots invites confident wrong answers |
| Recurring events | D | Occurrence vs series handled |
| Conflict/double-booking detection | B/E | Real nightly `calendar_defense` (overlaps, <30-min turnarounds, prep-worthy) texted for tomorrow (`hire-api.ts:653-777`) |
| Travel time between events | A | **Missing.** Location is captured; used only for a place-change heuristic (`hire-api.ts:677-680`) |

## Contacts / people

| Operation | Class | State |
|---|---|---|
| Store/CRM | A/D | `hire_network` (+ relationships with cadence & last_touch); 50 rows returned to the engine (`routes/network.ts:41-76`) |
| Resolve "Sam" → address | A | Only from CRM rows already saved; **no Google Contacts lookup**; `send_text_later` refuses to guess a phone (`conversationalFriend.ts:774-787`) |
| Add/edit contact in chat | D | **Missing** (web routes only) |
| "When did I last talk to Alex?" | A | Only CRM `last_touch` (updated when Alpha logs a touch) — **not** derived from email history |
| Cadence nudges ("you haven't pinged Alex in 3 weeks") | E | Real (`hire-api.ts:5588-5594`, `work/stack.ts:524-551`) |

## Reminders / scheduled texts

| Operation | Class | State |
|---|---|---|
| Create (incl. recurring daily/weekly/weekdays, DST-safe) | D | Real, deterministic parse, idempotent |
| List / snooze / edit / cancel (occurrence vs series) | G | Real (`routes/reminders.ts:68-92, 269-324`) |
| Delivery & retry | E/F | Real: 10s poller, atomic claim, failure → retry +10 min, carrier-block → proactive freeze until user replies |
| Scheduled text on your behalf ("text mom at midnight") | D/F | Real with lease protocol, crash-safe, failure notifies owner; **no cancel path exists** for a scheduled text (`routes/reminders.ts:97-180` has POST/claim/ack only) |
| Commitment capture ("I'll send the deck by Friday") | E | Regex first-person only, rescue armed due−24h (`commitmentRescue.ts`); silently wrong if phrasing differs |

## Memory / context

| Operation | Class | State |
|---|---|---|
| Durable facts + semantic recall | A | Real, every turn, encrypted, vector index fail-open to recency (`deploy/memory/store.ts:123-176`) |
| Conversation history | A | **Last 20 messages** + LLM-compressed summary, both container-local — **die on container swap** (`spectrum/shared/memory.ts:6`; `memoryBlock.ts:66-69`) |
| Correction of previous ask ("nyc I meant") | G | Real rewriter for the previous ask (`followUpCorrection.ts`), within history window |
| Single-slot state | G | `pendingSpend` (10-min expiry), `pendingVaultTask`, `pendingConnection`, numbered-card selection, bare-2FA-digit routing — all container-local, lost on restart |
| Entity memory (people ↔ mentions) | A | Weak: flat facts + CRM rows; no entity linking |
| General anaphora ("that one", "the other one") | A | Only within the 20-message window + numbered-card selection; no resolver |

## Browser / real-world execution

| Operation | Class | State |
|---|---|---|
| Web research | A | LangSearch → DDG cascade; **opens one page, 4000 chars** (`webSearch.ts:370-393`). Multi-step work delegated to browser runs |
| Browser task execution | D | Real pipeline: merchant-portal whitelist, Kernel cloud headful+stealth (browser-use driver), e2b fallback, network policy, per-origin vault login, CAPTCHA/2FA handoff with screenshot + live view + chat-relayed 2FA codes, auto-resume, 25-min ceiling |
| Purchases | D/F | Full machinery exists (exact-total DOM check, Link one-time card, JSON-LD receipt verification, screenshots) but **no purchase/booking has ever completed end-to-end** (`docs/purchase-browser-search-audit.md:3,16-22`; `docs/cloud-computer-diagnostic.md:135-141`). $200 cap; Link consent required — **text approval cannot substitute** (`userPayments.ts:654`) |
| Cancel/refund a placed order | G | **Missing** and stated to the user (`spendTurn.ts:22-29`) |
| Cancel a running browser job | G | Partial: waiting-question jobs and approval-denial cascade only; no general "stop my run" |
| Travel search | A | Flights/hotels via scrape.do (token **unset by default** → returns null; `scrapeDo.ts:5-8`), trvl binary, SerpAPI (testers only). Honest "source unavailable" banner otherwise |
| Travel booking | D | **No booking module.** Only generic browser jobs |
| Flight check-in | D | **Does not check in.** Texts a check-in URL at departure−24h (`taskLoops.ts:386-445`) |
| Flight change/gate alerts | E | **Missing** (comments only) |
| Package tracking | E | **Missing** |
| Software generation ("build me…") | D | Real: single-file Bun artifact, sandboxed, `/b/` URL, 7-day expiry unless kept, 10/day (`deploy/workshop.ts`) |

## Habits / life data

| Domain | State |
|---|---|
| Nutrition | Text/photo auto-log; macros are a **pure model estimate**, no food DB (`deploy/habits/parsers.ts:219-425`) |
| Sleep | Text parse + Apple Health ingest endpoint; insights (short sleep) |
| Workouts | Set-by-set logging, PRs, generated programs with GIF demos |
| Mood/gratitude/habits | Real logs, streaks, weekly resurface |
| Spending | **Only what the user texts or approves.** No bank/transaction feed writes `hire_spending` (Plaid exists as a read tool if connected, but nothing reconciles it) |
| Money jobs | Renewal radar from mail (3-day lead) is real; **bill-increase detection is a wired-but-dead stub** (`taskLoops.ts:610-613`) |
| Meetings | Prep bundles (person + threads + web + draft), debrief capture, meeting ledger |

## Proactive (full list)

Morning/afternoon/evening/weekly briefs (08/17/21 + Fri, tap-open digest card), life-state pokes (sleep/protein/workout/spend/mood/wind-down) with hardGuard (quiet hours 22:00–08:00, ≥60 min spacing, ≤2 unanswered, freeze-until-reply), event nudges (meeting_soon 15–45 min, debrief 10–45 min after, promise due, decision review, meal/workout check-ins), trigger nudges (Slack mention, Linear assigned, urgent email, new event — friend only), webhook event inbox with quiet-hours hold, ~18 task-loop kinds (wakeup, refund_hunter, memory resurface, trial_ending, **birthday day-of**, streak_ended, overwork_check, quiet_check, day1 check-in, save_contact, onboard_done, calendar_defense, flight_checkin-link, inbox_ping, browser_result, commitment_rescue, email_followup, browser_watch, bill_increase-stub), intro queue, scheduled texts, inbox watchtower, renewal radar, smart tapbacks, progressive "checking your email…" stage texts.

## Surfaces

38 mini apps (≈20 mint iMessage cards; cards are tappable webview links to hirealpha.chat, not Apple payloads), web workspace (email reader, slot picker, pipeline, vault, live browser view), setup wizard, chat onboarding (name → city → priority), voice notes in (Whisper), photos in (food macros), images out, group chats (privacy manners only, no coordination), free beta billing with trial nudge.

---

# Part 2 — 160 messages a normal person would actually text

Verdicts: ✅ works · 🟡 partial (works with caveats) · ❌ fails/missing · ⚠️ works but will mislead or annoy. "Gap" codes defined in Part 3.

## Morning

| # | Message | What they expect | Alpha today | Verdict |
|---|---|---|---|---|
| 1 | "what do i need to know today" | brief: schedule + what needs me | Digest/lifeState + judged mail; solid | ✅ |
| 2 | "anything important?" | same, shorter | needs-you pick + insights | ✅ |
| 3 | "what am i forgetting?" | open promises, due items, conflicts | open loops + reminders + calendar_defense | 🟡 misses email promises outside last-2d judged window |
| 4 | "who do i owe a reply to?" | list from actual inbox | needs-you reply pile — but mail window is **2 days / 30 mails** | 🟡 older unanswered mail invisible |
| 5 | "do i have anything early?" | first event + warnings | calendar read works | ✅ |
| 6 | "what's my day look like?" | schedule | calendar read | ✅ |
| 7 | "anything happen overnight?" | mail/missed texts/news | judged mail; no missed-call/SMS/news | 🟡 |
| 8 | "do i need to leave soon?" | leave-by with traffic | event time only; **no travel time** | ❌ gap: capability missing |
| 9 | "summarize my emails" | triage summary | judged piles | ✅ |
| 10 | "did anything blow up?" | urgent detection | watchtower/urgent email nudge exists; on-demand search window 2d | 🟡 |

## Work

| # | Message | Expect | Alpha | Verdict |
|---|---|---|---|---|
| 11 | "prep me for my 2pm" | who/why/history/talking points | real prep bundle: person, threads, web, draft (`work/prep.ts:96-282`) | ✅ strong |
| 12 | "what did we talk about last time" | last-meeting recap | meeting ledger + gmail search | 🟡 depends on ledger use |
| 13 | "did they ever reply?" | checked the thread and answered | gmail search only; no sent/waiting state machine | 🟡 |
| 14 | "send the deck" | attach and send | send_file works if file in Drive; "the deck" needs find_file context | 🟡 |
| 15 | "follow up with him" | find thread, draft nudge | draft path works if "him" resolvable in context | 🟡 pronoun risk |
| 16 | "move that meeting" | reschedule | resolve event + both times; no conflict re-check; no undo | 🟡 brittle |
| 17 | "what should i focus on today?" | prioritized view | Next stack logic exists in-card; chat answer decent | ✅ |
| 18 | "remind me what i promised them" | commitments re that person | commitment loops (regex) + mail promises | 🟡 capture is narrow |
| 19 | "find the latest version" | Drive search | filename-only listing (`hire-api.ts:1634`) | 🟡 no content/version compare |
| 20 | "tell me what changed" | diff | not supported | ❌ |
| 21 | "email the team standup" | write + send | Slack/Notion writes exist; email draft only | 🟡 no Slack→user's team unless connected |
| 22 | "block focus time till noon" | create hold | staged hold → tap to book | ✅ |
| 23 | "decline the 4pm, double booked" | decline + propose alt | RSVP self works; no auto-alt | 🟡 |
| 24 | "what's on my plate for Q4" | planning view | not supported (no docs/notes read beyond Drive filenames) | ❌ |
| 25 | "summarize this doc" (shared link) | read + summarize | browser run could fetch public page; Drive = filename only | ❌ for Drive docs |

## Email

| # | Message | Expect | Alpha | Verdict |
|---|---|---|---|---|
| 26 | "handle my inbox" | triage: reply what's replyable, file the rest | drafts for judged items; **no archive/mark-read** — inbox itself untouched | ⚠️ drafts ≠ inbox handled |
| 27 | "anything urgent?" | urgent-first | attention pick | ✅ |
| 28 | "reply to the important ones" | batch drafts | one draft per turn (`draftAttempted`) | 🟡 serial, slow |
| 29 | "ignore the newsletters" | filter learning | judge drops promos; per-user pile vocab; triage feedback recorded, not applied | 🟡 |
| 30 | "did i reply to sam?" | yes/no from real state | gmail search reconstruction | 🟡 |
| 31 | "what am i waiting on?" | waiting-on list | email_followups (if created) + loops | 🟡 only if follow-ups were armed |
| 32 | "who am i ignoring?" | overdue replies | needs-you + overdue people | 🟡 2-day mail window |
| 33 | "send her the file" | attach + send | find_file + send_file (Drive) | ✅ if in Drive |
| 34 | "reply saying yes" | short real reply | draft "Yes" → tap send; or "send it" delegate | ✅ (two steps) |
| 35 | "make it warmer" | rewrite draft | web card rewrite voices are real; in-chat path model-dependent | 🟡 |
| 36 | "don't send it yet" | hold | drafts never auto-send; trivially satisfied | ✅ |
| 37 | "follow up tomorrow if they don't answer" | watch + nudge | email_followup tool — real, re-verifying | ✅ capability star; **discoverability poor** |
| 38 | "forward this to accounting" | forward | **missing** | ❌ |
| 39 | "what's the attachment they sent?" | read PDF | **missing** (attachments excluded from reads) | ❌ |
| 40 | "unsubscribe me from this" | act | not supported | ❌ |
| 41 | "send this at 8am" | scheduled send | explicitly forbidden | ❌ |
| 42 | "did my email send?" | confirmation | outcome states are real; "outcome_unknown" honest | ✅ |
| 43 | "unsend that" | undo | missing | ❌ |
| 44 | "archive everything from this sender" | bulk action | missing | ❌ |

## Calendar

| # | Message | Expect | Alpha | Verdict |
|---|---|---|---|---|
| 45 | "move lunch later" | reschedule | update needs id + both times; "later" inference on the model | 🟡 |
| 46 | "cancel my 2" | cancel today's 2pm | resolve + cancel; **no card, no undo** | ⚠️ silent write |
| 47 | "when can i meet Sarah?" | mutual availability | **only your calendar** | ⚠️ misleading |
| 48 | "find 30 minutes this week" | free slots | free_slots tool hits a **missing endpoint** in prod | ❌ likely |
| 49 | "move everything after 3" | bulk move | serial one-by-one; no bulk op | ❌ |
| 50 | "can i make this meeting?" | conflict check | calendar_defense exists nightly; on-demand check not modeled | 🟡 |
| 51 | "how long between these?" | gap math | two events from calendar; model math | ✅ |
| 52 | "add travel time" | buffer with drive time | missing | ❌ |
| 53 | "invite dana to the sync" | add attendee | missing | ❌ |
| 54 | "what did i agree to on friday" | review | calendar read | ✅ |
| 55 | "reschedule my dentist" | call/portal action | not supported (no phone; portal = heavy browser job) | ❌ |

## Personal life

| # | Message | Expect | Alpha | Verdict |
|---|---|---|---|---|
| 56 | "remind me to call mom" | reminder | solid (recurring, snooze, cancel) | ✅ |
| 57 | "text mom happy birthday at 9" | scheduled text | real, lease-safe, failure notice; **no cancel** | ✅ / ⚠️ G |
| 58 | "what did my landlord say?" | find + summarize | gmail search + full read | ✅ |
| 59 | "did i pay rent?" | real payment status | only mail evidence + self-logged spend | 🟡 |
| 60 | "how much did i spend eating out?" | from actual transactions | **only what you told it** | ⚠️ confidently incomplete |
| 61 | "am i sleeping enough?" | trend + advice | sleep logs + insights | ✅ |
| 62 | "what groceries do i need?" | running list | drop_zone only, no list feature | 🟡 |
| 63 | "book dinner for tonight" | real reservation | browser run to OpenTable; machinery real, e2e unproven; vault/handoffs likely | 🟡 |
| 64 | "when is my flight?" | itinerary | calendar event (airline) | ✅ if in calendar |
| 65 | "check me in" | do it | **sends a link** | ❌ expectation mismatch |
| 66 | "is my package coming today?" | tracking | delivery-classified mail ping only | ❌ |
| 67 | "order more dog food" | buy | purchase pipeline unproven e2e; $200 cap; Link consent | 🟡 |
| 68 | "book a hotel in chicago friday under $250" | search + book | search sources mostly disabled by default; no booking | 🟡 honest but weak |
| 69 | "what time is sunset" / trivia | quick answer | web search | ✅ |
| 70 | "find me a plumber saturday" | local search | maps (OSM, now mirrored/retried) | ✅ |
| 71 | "happy birthday to me" → (it's user's birthday) | acknowledgment | no self-birthday feature | 🟡 |
| 72 | "i moved apartments" | update context | memory fact (city etc.) | ✅ |
| 73 | "call the pharmacy" | phone call | **no telephony**; declines honestly | ❌ |
| 74 | "read me this article" (link) | summarize | web fetch one page | ✅ |
| 75 | "what's on at the movies" | listings | web search | 🟡 |

## Money

| # | Message | Expect | Alpha | Verdict |
|---|---|---|---|---|
| 76 | "what am i spending too much on?" | category analysis vs real spend | self-logged spend only | ⚠️ |
| 77 | "can i afford this?" | vs real balance | weekly budget vs logged spend | 🟡 |
| 78 | "did anything charge me twice?" | transaction scan | **no transaction feed** (Plaid read tool exists but unwired) | ❌ |
| 79 | "cancel that subscription" | do it | renewal radar informs; no cancellation execution | ❌ |
| 80 | "find a cheaper option" | price research | web search + browser_watch; fare sources mostly off | 🟡 |
| 81 | "buy the cheaper one" | execute purchase | unproven e2e; Link consent; $200 cap | 🟡 |
| 82 | "tell me before anything renews" | renewal alerts | **renewal radar is real** (3-day lead, 08:00 text) | ✅ discoverability poor |
| 83 | "my bill went up?" | increase detection | stub, never fires | ❌ |
| 84 | "split this with jake" | payments | missing | ❌ |
| 85 | "stop the purchase" | cancel mid-flight | deny works pre-approval; **no post-execution cancel** | 🟡 |

## Travel

| # | Message | Expect | Alpha | Verdict |
|---|---|---|---|---|
| 86 | "plan my trip to austin" | itinerary + bookings | searches (sources often off) + holds; no itinerary assembly | 🟡 |
| 87 | "what do i still need to book?" | trip state | no trip model | ❌ |
| 88 | "did my flight change?" | monitoring | missing | ❌ |
| 89 | "when should i leave for the airport?" | traffic + boarding | missing | ❌ |
| 90 | "check me in when it opens" | auto check-in | link text at T−24h only | ❌ expectation gap |
| 91 | "get me an aisle if one opens" | seat monitor | missing (preference stored but not threaded into any flow) | ❌ |
| 92 | "track this fare" | price watch | browser_watch can watch a named URL; no fare-feed | 🟡 |
| 93 | "i land tuesday — shift my stuff" | timezone shift | travel mode records tz; scheduler uses travel_tz; honest that full shift is partial | 🟡 |
| 94 | "cancel my hotel" | execute cancellation | no booking execution → nothing to cancel; browser job could attempt | ❌ |
| 95 | "rental car or uber?" | cost/time compare | web + maps; shallow | 🟡 |

## Relationships

| # | Message | Expect | Alpha | Verdict |
|---|---|---|---|---|
| 96 | "when did i last talk to Alex?" | real comms history | CRM last_touch only (not email-derived) | 🟡 |
| 97 | "who haven't i replied to?" | inbox truth | needs-you + cadence | 🟡 |
| 98 | "remind me to check in with Sam monthly" | recurring relationship reminder | recurring reminder works | ✅ |
| 99 | "what did Sarah tell me last time?" | person-context recap | facts + gmail search; no per-person digest | 🟡 |
| 100 | "did i promise her anything?" | commitment search | loops + mail promises | 🟡 |
| 101 | "who should i follow up with?" | prioritized list | overdue people + waiting piles | ✅ |
| 102 | "send alex a text" | actually text | send_text_later needs CRM phone; refuses to guess | ❌ if not in CRM |
| 103 | "add alex to my people" | contact create | missing in chat | ❌ |
| 104 | "it's dave's birthday soon" | lead-time notice | birthday fires **day-of only** | 🟡 no lead time |
| 105 | "how's my mom doing" (she never texts alpha) | relationship state | no inbound data | ❌ |

## Browser / life admin

| # | Message | Expect | Alpha | Verdict |
|---|---|---|---|---|
| 106 | "renew my registration" | do it end-to-end | browser job; gov portal → vault + CAPTCHA handoffs; honest failure likely | 🟡 heavy |
| 107 | "fill out this form" (URL) | autofill | userIdentity profile + browser autofill | 🟡 |
| 108 | "return these shoes" | start return | portal login + unproven flow | 🟡 |
| 109 | "cancel my gym membership" | do it | no execution; declines honestly | ❌ |
| 110 | "find the receipt for my monitor" | search mail | gmail search | ✅ |
| 111 | "book a dentist appointment" | real booking | browser job; 2FA/handoffs; unproven | 🟡 |
| 112 | "check the status of my refund" | chase | refund_hunter only scans mail for refund mentions (weekly) | 🟡 |
| 113 | "change my address with the bank" | do it | bank = protected portal; vault; heavy; no verification of success beyond screenshots | 🟡 |
| 114 | "watch this page, tell me when X" | monitor | browser_watch — real, goal-judged, capped runs | ✅ capability star |
| 115 | "do this for me" (vague) | figure it out | Tier-4 delegate drafts; classifier | 🟡 |

## Slang, typos, fragments, pronouns, corrections, multi-ask

| # | Message | Expect | Alpha | Verdict |
|---|---|---|---|---|
| 116 | "yo" | normal greeting | pinned welcome | ✅ |
| 117 | "wagmi w the deck tmrw" | understand | model handles slang; commitment regex may miss "wagmi w" | 🟡 |
| 118 | "remidn me cal l mom at 6" (typos) | parse | reminder parser + model; deterministic fallback may reject, model path recovers | 🟡 |
| 119 | "that one" | last-discussed item | within 20-msg window + numbered cards | 🟡 |
| 120 | "the other one" | alternative item | only numbered selection | ❌ often |
| 121 | "nyc I meant boston" | correct previous ask | followUpCorrection rewrites previous ask | ✅ capability star |
| 122 | "actually 3pm not 2" | correct previous hold | refinement rewriter | ✅ |
| 123 | "wait stop" | interrupt work | interrupt honored (burst combining, stop/cancel) | ✅ |
| 124 | "cancel that" | undo last action | only cancels waiting browser jobs; **no general undo** (undo = metadata stamp) | 🟡 |
| 125 | "also remind jake" (multi-ask) | two things, one text | burst combining; classifier single-intent | 🟡 |
| 126 | "yes" (to pending question) | confirm | approval grammar strict, 10-min expiry | ✅ |
| 127 | "yes but can you do X" | conditional approval | grammar **rejects** conditions ("Questions or conditions do not approve") — then asks again | ⚠️ safe but rigid |
| 128 | "6**" (2FA code) | type into page | bare-digit routing into paused run | ✅ magic |
| 129 | "k" / "👍" | ack | tapbacks/rhythm gates; no misunderstanding risk | ✅ |
| 130 | "what about tomorrow?" | follow-up on previous query | context in window | ✅ |
| 131 | "how much was it?" (purchase context) | recall price | if within window / receipt stored | 🟡 |
| 132 | "did we ever finish that?" | task state recall | loops open/closed; only if captured as loop | 🟡 |
| 133 | "what happened with that apartment?" | past-thread recall | summary may carry it; container swap kills it | 🟡 |
| 134 | "do i still need to do that?" | open-loop check | loops | 🟡 |
| 135 | "switch to my work number" | persona handoff | three separate numbers, separate memory; no handoff | ❌ |
| 136 | "don't text me till monday" | pause | proactive pause (paused_until) | ✅ |
| 137 | "stop" | kill proactive | kill switch, fail-closed | ✅ |
| 138 | "read this voice note → do it" | voice in → action out | Whisper transcription → normal turn | ✅ |
| 139 | [photo of lunch] | log macros | vision estimate + Nutrition card | ✅ |
| 140 | "what did i eat yesterday" | recall | nutrition logs | ✅ |
| 141 | "start a 7-day shred" | program | workoutProgram generated plans | ✅ |
| 142 | "bench 3x5 @185" | log set | parser | ✅ |
| 143 | "i'm stressed" | empathy + useful | friend persona conversational; mood log | ✅ |
| 144 | "build me a tip calculator" | artifact | workshop build → URL | ✅ |
| 145 | "make the button blue" (on artifact) | iterate | update_build | ✅ |
| 146 | "keep it" | persist | keep/toss; 7-day expiry otherwise | ✅ |
| 147 | "remember i hate cilantro" | memory | remember tool + diet conflict detection later | ✅ |
| 148 | "forget that" | memory delete | forget tool + tombstones | ✅ |
| 149 | "what do you remember about me" | transparency | recall smart feature | ✅ |
| 150 | "connect my gmail" | connect | connect flow + auto-armed briefs | ✅ |
| 151 | "is my gmail still connected?" | status check | connector status endpoint (server-config only) | 🟡 |
| 152 | "your texts stopped coming" | diagnose | no self-diagnosis; quiet_check exists (3d silence) | 🟡 |
| 153 | "why didn't you remind me?" | accountability | no failure-trace surfacing | ❌ |
| 154 | "text me the deck when sam sends it" | trigger→action | no inbound-trigger automation beyond followup/watch | ❌ |
| 155 | "every day at 6 tell me X" | recurring digest text | reminder (once/daily/weekly/weekdays) | ✅ |
| 156 | "send my location to jake" | share | location share gets ack only | ❌ |
| 157 | "add this to my notes" | notes | drop_zone/Notion if connected | 🟡 |
| 158 | "what's my tz in tokyo this week" | travel mode | travel flag + tz table | 🟡 honest partial |
| 159 | "run a poll in the group chat" | group coordination | group chat explicitly no coordination | ❌ |
| 160 | "call an uber" | ride | uber connector denied for friend/coworker personas; no ride execution | ❌ |

Count: 160 messages. (Part 4 matrix draws the 75 highest-frequency jobs from these.)

---

# Part 3 — Expectation-gap method

For each message: (1) what a reasonable person thinks a personal assistant would do; (2) what Alpha supports; (3) what Alpha actually does today (traced through the turn pipeline: deterministic gates → intent classify → tool loop → draft cards → loops); (4) where the user is let down. Gap classes used in the matrix:

**capability-missing** · **not-discoverable** (exists, nobody would find it) · **no-trigger** (exists, the phrasing doesn't route to it) · **over-clarifies** · **sends-to-another-app** (link/settings/url) · **suggests-instead-of-acting** · **acts-but-no-followup** · **acts-but-cant-verify** · **forgets-state** · **cant-modify-cancel** · **friction** · **too-much-text** · **trust-boundary-unclear** · **unsupported-phrasing** · **bad-prioritization** · **technically-works-feels-dumb** · **false-completion-risk** (P0 family).

---

# Part 4 — Capability vs User Expectation Matrix (75 jobs)

| # | Real-life job | User expects | Alpha capability | Actual behavior | Gap | Sev | Opportunity |
|---|---|---|---|---|---|---|---|
| 1 | Morning orientation | "here's your day + what needs you" | Brief + digest card | 08:00 text + tappable digest | minor | P3 | make brief reply-parseable ("reply 2 to draft Greg's reply") |
| 2 | Leave-by-time | "leave at 2:40 for your 3:30" | none | event time only | capability-missing | P1 | maps ETA + buffer in calendar_defense |
| 3 | Overnight catch-up | mail + missed texts | judged mail only | no missed-call/SMS | capability-missing | P2 | iMessage inbound count at brief time |
| 4 | "who owes me a reply" | full inbox truth | 2d/30-mail judged window | older invisible | capability-missing | P1 | widen window for reply-kind scan, or thread-state table |
| 5 | Reply to an email | drafted, ready, one tap | draft + approve_send card | solid | — | — | keep |
| 6 | Send an email | it actually sent | real send w/ id receipt | solid; "send it" only on retained draft | friction | P2 | allow "send it" to resolve most-recent draft in thread |
| 7 | Confirm send happened | yes/no | outcome states | honest, incl. outcome_unknown | — | — | surface "delivered/sent" wording consistently |
| 8 | Follow up if no reply | automatic chase | email_followup re-verifies | real; only invoked if user phrases it exactly | not-discoverable | P1 | contextual teach: after any send, offer "watch for her reply?" |
| 9 | Forward email | forwarded | none | refuses | capability-missing | P1 | Gmail forward API |
| 10 | Read attachment | summary of PDF | none | "attachments not included" | capability-missing | P1 | attachment fetch + text/PDF parse |
| 11 | Archive/mark done | inbox actually cleaner | none (no gmail.modify) | inbox unchanged | capability-missing | P2 | scope bump + archive/mark-read actions |
| 12 | Undo send | recall | none | refuses | capability-missing | P2 | Gmail undo-send window |
| 13 | Scheduled send | timed delivery | forbidden | refuses | capability-missing | P3 | compose+scheduled send |
| 14 | Inbox triage honesty | "handled" means handled | drafts only; inbox untouched | ⚠️ implies more than done | false-completion-adjacent | P2 | pair every draft with "archive after send" option |
| 15 | "handle my inbox" | batch process | one draft/turn | serial, slow | friction | P2 | batch drafts + "reply 1,3" (sweep exists in smart features — discover) |
| 16 | Meeting prep | brief + context | prep bundle | strong | — | — | auto-attach to meeting_soon nudge always |
| 17 | Reschedule a meeting | moved + attendees notified | update w/ sendUpdates=all | works; needs id resolution; no conflict check; no undo | cant-modify-cancel | P2 | post-move confirm + revert offer |
| 18 | Cancel an event | cancel | delete; silent write | no card/confirm/undo | trust-boundary-unclear | P1 | confirmation card for destructive calendar ops |
| 19 | Mutual scheduling | Sarah's availability too | own calendar only | may offer times Sarah can't do | false-completion-risk | P1 | freeBusy query for named guest or honest "I can only see yours" |
| 20 | Find a slot | real free times | free_slots → **missing endpoint** | refuses/claims can't | capability-missing (bug) | P1 | implement `/api/internal/work/slots` handler |
| 21 | Invite a guest | attendee added | none | refuses | capability-missing | P1 | attendees write in calendarHold/mutate |
| 22 | Conflict check on demand | "can I make it?" | nightly defense only | on-demand not routed | no-trigger | P2 | route conflict-shaped asks to defense analyzer |
| 23 | Travel time | drive/transit ETA | none | — | capability-missing | P2 | maps ETA on events with location |
| 24 | Reminder set | done | deterministic | strong (recurring/snooze/cancel/DST) | — | — | — |
| 25 | Reminder edit/cancel | managed | full ops | strong | — | — | — |
| 26 | Scheduled text | sent on time, cancellable | leases + failure notice; **no cancel** | can't stop it | cant-modify-cancel | P1 | cancel/edit scheduled_texts route + chat grammar |
| 27 | "text mom" | send a real SMS now | send_text_later schedules; needs CRM phone | refuses to guess | capability-missing | P1 | Google Contacts / device contacts lookup |
| 28 | Contact add | "save alex: …" | none in chat | web-only | capability-missing | P2 | chat contact upsert |
| 29 | "when did I last talk to X" | from actual email/texts | CRM touch only | misleading if CRM empty | false-completion-adjacent | P2 | derive last_touch from gmail threads |
| 30 | Promise tracking | two-way ("she owes me") | outbound regex only; inbound modeled for email threads only | chat promises from others untracked | capability-missing | P2 | inbound commitment extraction from judged mail |
| 31 | Commitment rescue | nudge before due | due−24h, live-loop closure | fires even if user already did it elsewhere | acts-but-cant-verify | P2 | completion check ("done?") before nag |
| 32 | Morning brief reliability | always 8am | reminder scheduler + freeze rules | solid; hold only if user texted <10 min ago | — | — | — |
| 33 | Proactive restraint | not annoying | hardGuard stack | strong (quiet hours, caps, freeze) | — | — | — |
| 34 | Meeting-soon nudge | 15–45 min warning | real, urgent | solid | — | — | include leave-by once ETA exists |
| 35 | Meeting debrief | capture next steps | 10–45 min post-event nudge | solid | — | — | auto-draft the followup email right there |
| 36 | Calendar defense | conflicts flagged | nightly, actionable text | solid | — | — | one-tap "move the dentist" fix |
| 37 | Purchase ("buy X") | bought, verified | full pipeline exists, **never proven e2e** | unverified in the field | acts-but-cant-verify | P1 | one real order e2e is the acceptance bar |
| 38 | Payment consent | text "yes" approves | **Link consent mandatory** | text can't approve | friction | P2 | keep Link but make its consent 1-tap from the thread |
| 39 | Spend cap | raise when asked | $200; "Ask in chat to raise it" but **no raise path** | dead-end instruction | friction | P2 | implement cap-raise request flow |
| 40 | Cancel a purchase | stop it | pre-approval yes; post-execution no | honest refusal | cant-modify-cancel | P2 | post-order cancel attempt via portal + refund_hunter wiring |
| 41 | Receipt | stored proof | merchant JSON-LD + screenshot | real when purchase works | — | — | — |
| 42 | Travel search | real fares | scrape.do off / SerpAPI testers-only | often "source unavailable" | capability-missing (config) | P1 | enable one paid fare source |
| 43 | Book a flight/hotel | booked | no booking module | search only | capability-missing | P1 | browser booking flow w/ Link |
| 44 | Flight check-in | checked in, boarding pass | **link text only** | expectation miss | capability-missing | P1 | vault airline login + check-in script (Instinct doc: highest-value integration) |
| 45 | Flight change alerts | notified | none | — | capability-missing | P2 | airline status poll on flight events |
| 46 | Package tracking | "arriving today" | mail classification only | no carrier integration | capability-missing | P2 | parse tracking numbers → carrier status poll |
| 47 | Renewal warnings | before renewal | renewal radar (3-day) | real | not-discoverable | P2 | mention it in brief when it fires first time |
| 48 | Bill-increase detection | caught | stub, never fires | — | capability-missing | P2 | compare renewal amounts to history |
| 49 | Duplicate charge | caught | none | — | capability-missing | P1 (trust) | Plaid feed or mail-charge dedup scan |
| 50 | "Can I afford this?" | real balance | budget vs self-logged spend | shallow but framed | capability-missing | P2 | Plaid balances if connected |
| 51 | Spending analytics | real transactions | self-logged only | ⚠️ answers confidently from partial data | false-completion-risk | P1 | label answers "of what you've told me" or wire Plaid |
| 52 | Subscription cancel | done | none | refuses honestly | capability-missing | P2 | browser flow on known cancel pages |
| 53 | Browser task ("renew registration") | done | jobs + vault + handoffs | heavy but real machinery; e2e unproven | friction | P2 | prove one gov/portal flow e2e |
| 54 | 2FA during task | type the code | chat-relayed digits | magic when it works | — | — | teach it in onboarding ("I'll ask for codes here") |
| 55 | CAPTCHA | solved | live-view handoff | depends on live view reachability (port 8443 issue documented) | sends-to-another-app | P1 | proxy live view through hirealpha.chat (fix exists per diagnostic) |
| 56 | Cancel running task | stopped | narrow cases only | no general stop | cant-modify-cancel | P2 | "stop" kills any active job + confirms |
| 57 | Watch a page | notified on condition | browser_watch | real, capped runs, honest | not-discoverable | P2 | teach after price/shopping asks |
| 58 | Price-drop alert | push | watch finding arrives via run report | works-ish; no diffing | no-trigger | P3 | "price dropped from $X" phrasing |
| 59 | Build me software | artifact URL | workshop | real, sandboxed, 7-day expiry | friction | P3 | keep default on "keep it" |
| 60 | Image generation | image | Pollinations/flux | real | — | — | — |
| 61 | Voice notes | handled | Whisper + hotwords | real | — | — | — |
| 62 | Photo → macros | logged + estimates | vision estimate, no food DB | numbers are guesses | acts-but-cant-verify | P3 | say "estimate" in the reply |
| 63 | Sleep tracking | from device | Apple Health ingest + text | partial wiring | capability-missing | P3 | expand ingest sources |
| 64 | Nutrition truth | real calories | model estimate | ⚠️ presented as macros | false-completion-risk | P3 | confidence labeling |
| 65 | Workout programs | plan + logging | generated + GIFs | real | — | — | — |
| 66 | Spending log by text | logged | parse + budget guard | real | — | — | — |
| 67 | Mood/gratitude | logged | auto-log | real | — | — | — |
| 68 | "What did I eat yesterday" | recall | logs | real | — | — | — |
| 69 | Habit streaks | tracked + nudged | streak_ended loop | real | — | — | — |
| 70 | Morning wakeup | "first up: X" | wakeup loop from top items | real | — | — | — |
| 71 | Birthday handling | lead time + gift idea | day-of only, once | no lead time | no-trigger | P2 | arm at T−3d |
| 72 | Quiet-time discipline | no 11pm pings | 4-layer quiet hours | strong; briefs deliberately exempt (8am fine) | — | — | — |
| 73 | Overwork notice | "you're up late" | overwork_check | real; could feel surveillance-y | trust-boundary-unclear | P3 | frame once, then leave alone |
| 74 | Going-quiet check | "everything ok?" | quiet_check 3d | real | — | — | — |
| 75 | "Refund me" chase | proactive | refund_hunter weekly mail scan | real-ish; no execution | acts-but-no-followup | P3 | draft the refund email right in the ping |

---

# Part 5 — 34 "It would've been faster to just open the app" moments

1. **"When can I meet Sarah?"** — Alpha only sees the user's calendar; user opens Gmail/Calendar to see Sarah's actual availability anyway. Fix: query guest freeBusy or say "I can only see your side — want me to email her 3 times?"
2. **"Find 30 minutes this week"** — `free_slots` calls a nonexistent internal endpoint; Alpha likely refuses. Calendar app shows free/busy instantly. Fix: implement the handler (`liveContext.ts:457` → no route).
3. **"Send it"** after a draft from an earlier session — refused because the delegate draft lives only in memory. User opens Gmail Drafts instead. Fix: resolve the most recent pending draft in-thread.
4. **CAPTCHA handoff** — "Open the live computer" link, which on some networks doesn't load (port 8443; `cloud-computer-diagnostic.md` §3.3). Fix: proxy the live view through hirealpha.chat (planned) or relay into chat.
5. **Gmail reconnect** — mid-conversation failure returns a raw URL: "Reconnect Gmail at /app/hires/friend?connect=gmail" (`hire-api.ts:1476-1480`). User should get a tappable connect card instead.
6. **Purchase approval** — "Approve the one-time payment in Link: <url>" — user must leave iMessage for Link's app. Fix: deep-link + clear "why" (fraud safety) + fallback.
7. **Flight check-in** — "Check in now: <airline URL>" — that's literally what the airline's own reminder email already does. Fix: vault login + auto check-in.
8. **$200 cap dead-end** — "Ask in chat to raise it" but no raise path exists (`userPayments.ts:176`). Fix: implement or remove the instruction.
9. **"Send her the file"** when the file was emailed as an attachment — Alpha can't read attachments, so it can't forward what it received. User forwards in Gmail. Fix: attachment passthrough.
10. **"Forward this to accounting"** — missing. Gmail takes 5 seconds.
11. **Name→phone for "text mom"** — refuses without CRM entry; user just opens Messages. Fix: Google Contacts lookup.
12. **"What's the attachment?"** — "attachments not included" — user opens Gmail. Fix: parse.
13. **Travel fares** — "LIVE FARE/RATE SOURCE UNAVAILABLE" (honest, but the user just opens Google Flights). Fix: enable one source.
14. **"Who's free Thursday?"** with multiple people — same as #1.
15. **Draft review on the web** — approve_send card opens a webview; fine — but if the token expired, fallback unsigned URL can confuse. Keep friction < 2 taps.
16. **"Did anything charge me twice?"** — no transaction feed; user opens bank app. Fix: Plaid.
17. **"Cancel that subscription"** — refuses; user opens the merchant site. Fix: targeted cancel flows for top-20 merchants.
18. **"Book dinner tonight"** — if OpenTable requires login and the vault is empty, the job asks the user to save credentials first (`needsVault`) — three extra steps vs the OpenTable app. Fix: guest-booking paths where possible.
19. **"What did we talk about last time?"** — after a container swap the summary is empty; Alpha asks the user to re-explain. Fix: persist summary server-side.
20. **"The other one"** — only numbered-card selection works; otherwise Alpha asks which one — with no candidate list attached. Fix: re-render the candidate list in the clarify.
21. **"Move everything after 3"** — no bulk ops; user drags events in Calendar faster. Fix: bulk mutation loop with one confirmation.
22. **"Add dana to the sync"** — missing; user opens the event. Fix: attendees write.
23. **"Unsubscribe me"** — missing; user taps List-Unsubscribe in Gmail. Fix: one-click unsubscribe header support.
24. **"Why didn't you remind me?"** — Alpha can't explain its own failures; user loses trust and self-serves. Fix: loop/job status surfacing.
25. **"Is my gmail connected?"** — status endpoint reports server config, not the user's connection state. Fix: real per-user status in chat.
26. **Spend answers from partial data** — user cross-checks the bank app and stops trusting spend answers. Fix: data-source labeling.
27. **"Email it to me"** (artifact/screens) — screenshots arrive in iMessage; artifacts are URLs; fine — but PDF export of a workshop artifact is missing, user screenshots manually.
28. **"Schedule this for next Tuesday 9am"** (email) — forbidden; user uses Gmail's schedule-send. Fix: enable it (compose scope already granted).
29. **"RSVP yes for me + add it to my cal"** — RSVP self works; but for events not on the primary calendar, refuses. Fix: secondary-calendar RSVP.
30. **"What's due this week?"** (school/bills) — no doc/notes reading beyond Drive filenames; user opens their notes app. Fix: Drive content read.
31. **"Book the dentist"** — portal 2FA + vault + handoffs; user phones the dentist (Alpha can't call). Honest refusal at least. Telephony is the real fix.
32. **"Reply in the group chat"** — Alpha talks to the requester only (`groupChat.ts:1-13`); user switches to WhatsApp. Phase-3 item.
33. **"Search my email for that contractor quote"** — works only within the 2-day window by default; older requires the user to know Gmail search syntax through Alpha. Fix: default window escalation on miss ("searched 2 days, want 90?").
34. **"Watch my package"** — no tracking; user opens the carrier app. Fix: parse tracking number → poll.

---

# Part 6 — Incomplete capability families

| Existing ability | Natural adjacent expectation | Supported? | Gap |
|---|---|---|---|
| Create reminder | edit / cancel / snooze / list / recurring / condition-based | edit/cancel/snooze/recurring ✅ | condition-based ("remind me when I leave work") ❌ |
| Send email (approved) | reply / forward / attachments / follow-up / change draft / sent-confirmation / reply-detection | reply ✅ attachments(Drive) ✅ follow-up ✅ verify ✅ | forward ❌ attachments-in ❌ generic reply-detection 🟡 unsend ❌ |
| Draft email | rewrite / tone / hold / schedule | rewrite ✅ hold ✅ | tone-chips in chat 🟡 schedule ❌ |
| Create calendar hold | reschedule / cancel / RSVP / invite / conflicts / travel time | reschedule ✅ cancel ✅ RSVP(self) ✅ conflicts(nightly) ✅ | invite ❌ guest-availability ❌ travel-time ❌ undo ❌ |
| Read email | search / summarize / attachments / triage act | search ✅ summarize ✅ | attachments ❌ archive/label/mark-read ❌ |
| Email follow-up watch | list all watches / edit / cancel | update/cancel via API ✅ | in-chat list/cancel phrasing 🟡 discoverability ❌ |
| Scheduled text | cancel / edit / view | — | **no cancel/edit/list in chat** ❌ |
| Purchase pipeline | cancel / refund / history | receipt history in spend rows 🟡 | cancel ❌ refund ❌ raise-cap ❌ |
| Browser job | stop / status / retry / resume | status via session view 🟡 resume ✅ retry(auto ≤3) ✅ | chat "status"/"stop" grammar ❌ |
| browser_watch | pause / edit goal / list | cadence in payload ✅ | chat controls ❌ |
| Renewal radar | list subscriptions / cancel | list via "bills" slash ✅ | cancel ❌ increase-detection ❌(stub) |
| Commitment rescue | mark done / snooze / show all | loops card ✅ | "I already did it" reconciliation 🟡 |
| Nutrition auto-log | edit a log / correct it | logs editable in web ✅ | "that was actually 2 bowls" in-chat correction 🟡 |
| Memory remember/forget | see everything / export | recall feature ✅ | full transparency/export ❌ |
| Contact CRM | add/edit in chat / derive from email | web only | chat ops ❌ email-derived touch ❌ |
| Morning brief | act on items from the reply | card actions ✅ | reply-numbered actions 🟡 |
| Group chat | coordinate/plan | privacy manners only | coordination ❌ (phase 3) |
| Workshop build | edit / keep / export | iterate/keep ✅ | export/PDF ❌ expiry confusion 🟡 |
| Voice notes | reply by voice | no TTS outbound | outbound voice ❌ (iMessage constraint) |
| Image generation | edit image | regenerates only | pixel edit ❌ |
| Persona numbers | cross-persona memory | per-persona isolation | shared memory layer ❌ |

---

# Part 7 — Contextual intelligence tests (predicted from execution paths)

| Test | Alpha behavior (traced) | Correct inference? | Unnecessary clarification? | Wrong-confident risk? |
|---|---|---|---|---|
| "did he get back to me?" (within last 20 msgs) | history contains "he"; gmail search on resolved name | ✅ mostly | rarely | 🟡 search-window 2d |
| "did he get back to me?" (fresh session, "he" = person from yesterday) | summary may carry it; container swap kills summary | 🟡 | asks "who?" | — |
| "move it later" (event discussed 3 msgs ago) | history + calendar read; needs id resolution + both times | 🟡 | sometimes asks which event even with one candidate | ⚠️ may move wrong event, silent |
| "send that" | delegate draft path only for retained draft; else refuse | 🟡 | refuses with no candidate list | — |
| "how much was it?" | receipt rows / spend logs within window | 🟡 | — | 🟡 may answer from wrong purchase |
| "what about tomorrow?" | prior query in history re-run for tomorrow | ✅ | rarely | — |
| "the other one" | only numbered-card selection supports it | ❌ | asks, often without re-listing options | — |
| "did we ever finish that?" | loops open/closed if captured; else summary | 🟡 | — | — |
| "what happened with that apartment?" | 20-msg window or summary; container swap = forgotten | 🟡 | asks user to re-explain | — |
| "do i still need to do that?" | open loops | 🟡 | — | — |
| "yes but also do X" (conditional) | approval grammar **rejects conditions by design** then re-asks | safe | ✅ yes (by design) | — |
| "nyc I meant boston" | followUpCorrection rewrites the previous ask | ✅ | no | — |
| "6-digit code" mid-run | routed into paused browser run | ✅ | no | — |
| "that" across persona numbers | per-persona memory isolation | ❌ | asks | — |
| "cancel that" | cancels waiting browser job only; no general undo | 🟡 | sometimes | — |
| "book the usual" (restaurant) | no preference anchored for restaurants (seats/airlines/hotels/drinks only) | ❌ | asks | — |

Summary: inference quality is high **inside the 20-message window** (raw history is in-prompt) and degrades sharply outside it or after a container swap. Single-slot anchors (pendingSpend, pendingVaultTask, numbered cards, lastBuild) work but are invisible to the user — when they miss, Alpha asks "which one?" without re-showing candidates, which reads as not paying attention. No general entity resolution exists (people are flat facts; mentions aren't linked to CRM rows).

---

# Part 8 — Proactivity vs. what a great human assistant notices

| Signal a great assistant notices | Alpha detects? | Knows it matters? | Useful time? | Offers next action? | Annoyance risk |
|---|---|---|---|---|---|
| Unanswered important email | ✅ watchtower + needs-you | ✅ judged why-lines | ≤20h cadence, urgent bypass | ✅ "Want the reply drafted?" | low |
| User promised something due tomorrow | ✅ commitment_rescue at due−24h | 🟡 (regex capture) | ✅ | ✅ "help finish it before it slips?" | 🟡 fires even if already done |
| Someone owes the user and is late | 🟡 email_followups only if armed; no inbound-promise model for chat | 🟡 | 🟡 | 🟡 | low |
| Schedule changed (new/conflicting event) | ✅ trigger nudge (new event) + nightly defense | ✅ | ✅ | 🟡 (text, not fix-tap) | low |
| User needs to leave soon | 🟡 meeting_soon only — no drive time | 🟡 | ✅ 15–45 min | ❌ no leave-by | low |
| Flight check-in opened | 🟡 T−24h link only | ✅ | ✅ | 🟡 link, not action | low |
| Subscription renewal approaching | ✅ renewal radar | ✅ | 3-day lead, 08:00 | 🟡 informs, no cancel | low |
| Unusually high charge | ❌ | — | — | — | — |
| Calendar conflict | ✅ calendar_defense | ✅ | night before | 🟡 says "needs a look" | low |
| Missing attachment before send | ❌ | — | — | — | — (would be a strong guard) |
| Task failed | 🟡 browser failures texted; scheduled-text failures notify; generic loop failures park silently after 5 attempts | 🟡 | ✅ | 🟡 | low |
| Reminder failed | 🟡 retry +10min; frozen if carrier-blocked; **user never told** reminder delivery failed | ❌ | — | ❌ | trust risk |
| Connector broke | ❌ no proactive "your Gmail expired" text (only on-demand failure messages) | — | — | ❌ | P1 — silent degradation |
| Interview tomorrow without prep | ✅ calendar_defense prep-worthy + meeting_soon prep offer | ✅ | ✅ | ✅ prep bundle | low |
| Birthday coming up | 🟡 day-of only | ✅ | ❌ no lead time | ✅ card/call idea | low |
| Recurring bill increased | ❌ stub (`taskLoops.ts:610-613`) | — | — | — | — |
| User went quiet | ✅ quiet_check | 🟡 | 3d | ✅ | low |
| Late-night overwork | ✅ overwork_check | 🟡 | evening | ✅ | 🟡 surveillance feel |
| Habit streak broken | ✅ streak_ended (≥21d, 3d gap) | ✅ | ✅ | ✅ | low |

Net: the anti-annoyance stack is genuinely strong (4-layer quiet hours, ≤2 unanswered, 60-min spacing, freeze-until-reply, fail-closed kill switch, dedup logs). The gaps are **missing senses** (money, packages, flights, connector health), **missing lead time** (birthdays), and **blind firing** for most armed loops (payload frozen at arm time — e.g., commitment rescue doesn't check whether the promise was completed by other means).

---

# Part 9 — 32 "assistant, not chatbot" failures

Places where Alpha talks when it should act (current text drawn from actual copy in code):

1. "Send it" with no retained draft → refusal instead of "You mean the Greg reply from yesterday? Sending." — fix: resolve recent draft.
2. `free_slots` failure → "no free time could be read" instead of answering from `loadBusyBlocks` fallback that already exists (`work/stack.ts:195-228`).
3. "I could not verify current information because the web lookup did not run" (`toolLoop.ts:1061`) — robot receipt; should say "my search hiccuped — try me again in a minute."
4. Travel banner "LIVE FARE/RATE SOURCE UNAVAILABLE…" — internal-grade copy reaching the user.
5. "An email needs a valid recipient" (`toolLoop.ts:1333`) — should resolve the name against contacts/web first, then ask only on true ambiguity.
6. "The human decides this one" ($200 cap, `toolLoop.ts:2075`) — should offer the raise-request flow.
7. CAPTCHA handoff → link + "press Resume" — better: "I hit a check. Tap here, solve the box, I take over again automatically." (auto-resume exists! Say so.)
8. Vault `needsVault` → "save a login" — better: open vault capture prefilled for that portal, one tap.
9. "Do not claim you can make phone calls" is a model rule, but the user-facing decline should offer the next-best action (draft a script + the number to call).
10. "Questions or conditions do not approve it" — safe, but reply should be "Want me to change the amount first?" not a re-ask.
11. Renewal radar text "Merchant renews 10/01 — $15.49" — should end with "want me to cancel it before then?"
12. Birthday text fires on the day — a real assistant says "Dave's birthday is Saturday — want a gift idea queued?"
13. calendar_defense "Tomorrow needs a look" — should propose the concrete fix ("move the dentist to 4:15? I can send that now").
14. Debrief nudge "want to capture next steps?" — should already have extracted next steps from the user's own notes and show a draft.
15. Watchtower ping — should offer the numbered-choice draft immediately in the same bubble.
16. "Inbox watch is on" — one-time notice; should demo with a real example within 24h.
17. Commitment rescue — should first ask "did this already happen?" before nagging.
18. Streak_ended — good copy; should attach "new target" one-tap options.
19. Refund hunter — should attach the drafted refund email, not just "want me to chase it?"
20. Quiet_check "Everything ok?" — should include "want me to pause everything for a week?" as a tap.
21. Trial_ending "Keep it or cancel?" — fine; add "what did I actually do for you this month?" (value receipt).
22. "Connect Google and I am dangerous" (`onboarding.ts`) — charming, but should be followed by the one-tap connect card in the same bubble.
23. "Reconnect Calendar in Settings" (`hub.ts:572`) — "Settings" is an app the user must find; make it a tappable connect card.
24. reminder parse failure fallback — should reply with the two closest interpretations as numbered choices, not a generic miss.
25. "which event?" clarify without listing candidates — always re-render candidates.
26. "I don't have that person in my contacts" — should offer "want me to look them up / add them?"
27. Purchase outcome_unknown — already honest; add "I'll check the merchant's order-status page and text you" (browser_watch can do this today — wire it).
28. Spend cap error — add "want me to ask for approval for $X?" (the flow should exist).
29. Workshop expiry — don't let the user discover the link died; text "your build expires tomorrow — keep it?"
30. Persona mismatch ("did he reply?" asked to coworker number) — respond with "that thread lives on my friend line — want me to check there?" instead of blank.
31. "Can I afford this?" — don't answer from partial spend silently; say "of what you've logged, yes — I can't see your bank."
32. Meal nudge "Reply eat, skip, or later" — good; but when user replies "skip," confirm silently (log) rather than chatting.

---

# Part 10 — "Too much assistant" risks

1. **Silent calendar cancel/move** — model-invoked `calendar_event` update/cancel writes without a card (`conversationalFriend.ts:744-751`). A wrong "cancel my 2" is destructive with no undo. Deserves a confirm card.
2. **send_text_later** — schedules a real outbound SMS from the user's number after an "in-chat confirmation sentence," no card. Ambiguous confirmations ("sure, why not" to an unrelated question) could fire a text. Deserves the same card treatment as email.
3. **Slack/Notion writes without cards** — model-invoked, guard-railed, but a wrong-channel Slack post is externally visible. Consider a draft card.
4. **Browser runs auto-stage (`autoApprove:true`)** — mitigated by payment/password gates, but the *run itself* (login on user's behalf, form submissions) starts without an explicit "go." A "starting — say stop anytime" bubble exists in spirit (progressive delivery) but the consent is implicit.
5. **Meal/workout nudges** — up to 4 windows/day. For a new user this reads as nagging before it reads as caring. Cap day-1 frequency.
6. **Smart tapbacks** — emoji reactions from a bot can feel off in grief/serious threads. Context gate exists (conversation-start or ≥4 turns) — add serious-topic exclusion.
7. **Overwork/quiet checks** — "You have been at it late" can feel surveillance-y to a user who never asked for wellness features. Make onboarding chips (they exist in the wizard) the strict gate — verify they're enforced per feature.
8. **Networking capture** — people mentioned in passing get CRM rows; a user may be surprised "Alex from the party" is stored with cadence. Disclosure beat needed.
9. **Memory retention buckets** — health/financial facts purge at 30 days — good privacy, but a user who told Alpha their salary 5 weeks ago gets amnesia; confusing. Tell the user the shelf-life at capture.
10. **Blind intro** — the product texts first before the user ever opts in conversationally; fine for waitlist signups, risky if the number was typed wrong.
11. **"Doesn't sleep" briefs** — briefs bypass quiet hours by design (8am is fine) — keep; but digest time user-set at 6am should double-check they meant it.
12. **Auto-spend logging** — "I spent $23 on uber" logs silently; a wrong category silently skews budget answers. Log + show category in one line.

---

# Part 11 — User mental model: 50 assumptions vs. reality

| # | New user assumes… | Reality |
|---|---|---|
| 1 | I can say "cancel that" | Only narrow cases; no general undo |
| 2 | It remembers what we just discussed | ✅ within 20 messages; dies on container swap |
| 3 | It knows who "Sam" is | ✅ if Sam is in its CRM; ❌ otherwise |
| 4 | If it says sent, it sent | ✅ verified with provider id |
| 5 | If it says no emails, it really checked | ✅ (empty vs failure distinguished) |
| 6 | If it says it'll remind me, it will | ✅ robust delivery + retry |
| 7 | If something fails, it'll tell me | 🟡 browser/scheduled-text failures yes; reminder/loop failures mostly silent |
| 8 | If I change my mind, I can stop it | 🟡 approvals yes; running jobs partially; sent email no |
| 9 | It can read attachments | ❌ |
| 10 | It can forward email | ❌ |
| 11 | It can see my bank/transactions | ❌ (only what I text it) |
| 12 | "Afford it?" = real balance | ❌ budget vs self-logged spend |
| 13 | It can check me in for flights | ❌ sends a link |
| 14 | It can book things end-to-end | 🟡 machinery exists, never proven e2e |
| 15 | It can make calls | ❌ declines honestly |
| 16 | It works on WhatsApp/SMS | ❌ iMessage only |
| 17 | It can text anyone in my phone | ❌ only people in its own CRM |
| 18 | "When can Sarah and I meet" includes Sarah | ❌ my calendar only |
| 19 | It can invite people to events | ❌ |
| 20 | It can move/cancel events | ✅ (but cancel is unconfirmed + unundoable) |
| 21 | "Handled my inbox" means my inbox is clean | ⚠️ drafts only; nothing archived |
| 22 | It will warn me before subscriptions renew | ✅ (3-day radar) — undiscoverable |
| 23 | It will catch double charges | ❌ |
| 24 | It tracks packages | ❌ |
| 25 | It knows my flight changed | ❌ |
| 26 | I can text it from my computer | web view only; chat is iMessage |
| 27 | My work line and personal line share memory | ❌ per-persona isolation |
| 28 | "Send it at 8am" works for email | ❌ forbidden |
| 29 | If it's quiet, nothing's wrong | ⚠️ connector death is silent |
| 30 | I can ask it to remember things | ✅ |
| 31 | It won't spend money without asking | ✅ strong gates (Link, exact total, $200 cap) |
| 32 | It won't email without approval | ✅ draft-only by design |
| 33 | It can browse/log in for me | ✅ with vault; CAPTCHA handoff |
| 34 | 2FA codes go through the chat | ✅ (magic when discovered) |
| 35 | It can build me software | ✅ workshop (undiscoverable) |
| 36 | It can generate images | ✅ |
| 37 | It understands voice notes | ✅ |
| 38 | It understands photos (food) | ✅ estimates |
| 39 | It knows nutrition facts precisely | ⚠️ model estimates |
| 40 | It can watch a webpage for me | ✅ browser_watch (undiscoverable) |
| 41 | It can renew/fill government forms | 🟡 heavy but possible |
| 42 | It can cancel subscriptions for me | ❌ |
| 43 | It can search my Drive and read docs | 🟡 filenames only |
| 44 | It can post to Slack/Notion | ✅ if connected |
| 45 | It knows my calendar is shared with my team | ❌ primary + 4 selected only |
| 46 | If I ignore it, it stops | ✅ 2-unanswered cap + freeze |
| 47 | "Stop" stops everything | ✅ fail-closed kill switch |
| 48 | It tells me when it's unsure | ✅ generally honest (fail-open to "chat") |
| 49 | It learns my preferences (aisle, no pork) | ✅ stored; 🟡 not threaded into booking flows |
| 50 | It's free | ✅ beta (trial nudge exists) |

The most dangerous mismatches: **9, 11, 12, 14, 18, 21, 29** — all places where partial data or partial action could be read as complete truth.

---

# Part 12 — 20 discoverability failures

| # | Capability (real today) | Likely user wording | Recognized? | How they'd find it today | Contextual teach |
|---|---|---|---|---|---|
| 1 | email_followup reply-watch | "nudge me if he ignores me" | partially | never | after any send: "watch for her reply?" |
| 2 | browser_watch | "tell me when X drops" | yes (tool) | never | after price asks: "want me to keep checking daily?" |
| 3 | Renewal radar | "warn me about renewals" | "bills" slash | never | first time it fires: "this is your renewal radar" |
| 4 | Scheduled texts | "text mom at 9 her bday" | yes | never | after: "I can also cancel/edit these — just ask" |
| 5 | Sweep (batch send) | "send 1 and 3" | yes | never | after second draft: "you can approve several at once" |
| 6 | Brain dump | "dumping everything…" | partially | docs only | recognize the shape, confirm what it captured |
| 7 | 2FA relay | user just needs to know | yes | luck | on first handoff: "codes come here, I type them in" |
| 8 | Workshop builds | "make me a little app" | yes ("build") | never | first artifact delivery: "I can build things like this — ask anytime" |
| 9 | Draft rewrite/tone | "make it warmer" | 🟡 in-chat | web reader | on first draft: "reply 'warmer' or 'shorter' to recut" |
| 10 | Digest controls | "move my brief to 7" | yes | never | first brief: "reply 'change time' anytime" |
| 11 | Quiet hours config | "don't text after 10" | partially | settings | first evening poke: "want quiet hours after 10?" |
| 12 | Persona split | three numbers | — | signup | onboarding should state it once, plainly |
| 13 | Vault + autofill | "save my airline login" | yes | needsVault moment | that moment is the teach — make the card one-tap |
| 14 | followUpCorrection | "I meant boston" | yes | luck | confirm the rewrite in one line ("got it — Boston") |
| 15 | email promises → loops | "she'll send specs friday" | 🟡 | brief pile | "I'm watching this promise — want a nudge Thursday?" |
| 16 | find_file/send_file | "send her the deck" | yes | — | list what it found, numbered |
| 17 | Recurring reminders | "every monday" | yes | — | — |
| 18 | Meeting prep bundles | "prep me" | yes | — | meeting_soon nudge should always offer it |
| 19 | Live browser view | watching Alpha work | yes | link in handoff | — (this one's fine) |
| 20 | "Keep me honest" | "hold me to the gym 3x/week" | partially | docs | after commitment capture: "want me to check in Fridays?" |

Pattern: Alpha's best capabilities (follow-up watching, page watching, renewal radar, scheduled texts, 2FA relay) are all **invisible until the exact happy phrasing**. Each needs one contextual teach moment attached to the adjacent everyday flow.

---

# Part 13 — Seven-day user journeys

## 1. Founder (friend + cofounder numbers)
Morning brief ✅ strong start. "Prep me for the VC call" ✅ strongest moment (threads + web + draft). "Move the board meeting" 🟡 brittle. "Send the update to investors" ✅ draft→approve. "Can I afford this agency retainer?" ⚠️ budget-vs-self-logged answer. Departure: **when a connector expires silently mid-week** and briefs stop mentioning mail, the founder's trust snaps (no proactive "Gmail broke" text). Habit-former: evening debrief + promise rescues. Churn risk: travel search weakness.

## 2. Engineer (coworker)
Linear/Slack/GitHub triggers ✅ genuinely useful. Standup assembly ✅. "Did the deploy finish?" ❌ no CI/CD read. "Summarize this PR" 🟡 not a tool. "Text me when staging errors spike" ❌ no monitoring grammar (browser_watch on a Grafana page is the hack). Annoyance point: meal nudges during deep work (busy-check exists — verify it covers focus blocks). Leaves for Slack itself unless connector writes get cards + speed.

## 3. Recruiter / job seeker (HireAlpha's home turf)
Pipeline board ✅. "Move Acme to interview" ✅ parser. "Prep me for the Google screen" ✅ (prep bundle; interview word handled). "Draft a follow-up to the recruiter" ✅. "Did they reply?" 🟡 2-day window pain (recruiters go quiet for 2 weeks). "Apply for me on LinkedIn" ❌ protected portal + no proven flow. "What did I promise them?" 🟡. The **email follow-up watch** is the killer feature here — and it's the one nobody finds. Huge opportunity: default-arm a followup on every sent application.

## 4. Busy professional (parent-adjacent)
Morning brief ✅. "Text coach we'll be late" ✅ (if coach in CRM — usually not → ❌). "Book dentist" 🟡 heavy. "Did I pay the water bill?" 🟡 mail-only. "What's for dinner plan" 🟡 tonight card exists (maps) — nice. School-form attachments ❌ (can't read them) — real pain. Annoyance: 3 meal pings/day to someone who eats at their desk — onboarding chips must be enforced.

## 5. Student
"Remind me to register for classes at 7am" ✅. "Watch the advising page for an opening" ✅ browser_watch — magic. "Summarize this PDF" ❌ attachments/Drive-content gap. "Build me a study planner" ✅ workshop. "Cheapest flight home" 🟡 fare sources off. "Quiz me on these notes" ❌ no doc ingest. Budget questions ⚠️ partial-data trap. Habit loop ✅.

## 6. Parent
"Remind me soccer carpool 3:15" ✅ recurring. "Text sam's mom" ❌ CRM gate. "Order more diapers" 🟡 purchase unproven. "Did the school email anything?" ✅ judged mail. "Add the recital to the calendar + invite grandparents" — invite ❌ → half-done. Group coordination (carpool thread) ❌ phase 3. The strongest moment is the school-email watchtower; the sharpest miss is group coordination.

## 7. Frequent traveler
"Flight next week?" ✅. Check-in ❌ (link). Flight change ❌. "Book hotel under $250" 🟡 sources off. Timezone shift 🟡 partial. Leave-for-airport ❌. Seats ❌ (stored preference never used). This persona experiences the widest expectation-vs-reality gap and is the most likely to say "I'll just use the airline app." The airline check-in integration (Instinct doc Tier 3) is the unlock; until then, don't market travel to this persona.

---

# Part 14 — 25 magic moments (ranked by value ÷ difficulty)

| # | Moment | Current support | Missing | Difficulty | Value |
|---|---|---|---|---|---|
| 1 | 2FA code typed into the live checkout from a bare text | ✅ real | just discoverability | done | ★★★★★ |
| 2 | "You asked Sam for the deck Thursday. Still nothing. Drafted a nudge." | email_followup re-verifies live thread | auto-arm on sends + teach | low | ★★★★★ |
| 3 | "Your 2pm moved — it now collides with the dentist. Move the dentist to 4:15?" | calendar_defense detects | one-tap fix mutation | low | ★★★★★ |
| 4 | "You told Maya you'd send this today. Latest file is in Drive. Send?" | find_file + send_file + commitment rescue | join the three | low | ★★★★★ |
| 5 | 2FA-less CAPTCHA auto-resume ("solve the box, I take back over") | ✅ auto-resume exists | copy + reliable live view | low | ★★★★ |
| 6 | "Checked the thread — she replied at 9:12. She's in for Friday." | email_followup eval | silent resolution notice | low | ★★★★ |
| 7 | Morning brief that names the ONE thing ("Greg is the one with a clock on it") | judgedAttentionPick exists | ship the /lab/brief narrative into the digest | med | ★★★★ |
| 8 | "Renewal tomorrow: NordVPN $15.49. Cancel before it fires?" | renewal radar | cancel flow | med | ★★★★ |
| 9 | Flight check-in executed with vault login, boarding pass screenshot | machinery (vault, browser, handoff) | airline script + e2e proof | med | ★★★★★ |
| 10 | "Your package is out for delivery" | delivery mail classification | carrier tracking poll | med | ★★★ |
| 11 | "Amazon charged you twice for the same order" | — | mail charge dedup or Plaid | med | ★★★★ |
| 12 | "Your AWS bill is $312 — up 40% from last month" | — | bill increase (un-stub) | med | ★★★ |
| 13 | "Sam hasn't texted back in 6 days — his flight landed Tuesday; want to check in?" | relationships + flight events | join | med | ★★★ |
| 14 | "Boarding in 45 min, gate B12. You're 20 min away." | meeting_soon pattern | flight status + maps ETA | med | ★★★★ |
| 15 | "Your flight now lands 19:40 — moved your dinner hold to 20:30." | — | flight change + cascade | high | ★★★★★ |
| 16 | "Draft ready for all 4 waiting threads — reply 'send all'" | sweep exists | proactively batch at evening brief | low | ★★★ |
| 17 | "You're 21 days into meditation and stopped Tuesday. Restart or new target?" | streak_ended | one-tap options | done-ish | ★★★ |
| 18 | "That API you watched just posted v2.0" | browser_watch | diff phrasing | done-ish | ★★★ |
| 19 | "Wish mom happy birthday" sent at 9:00 sharp + "delivered" | scheduled texts | cancel/edit UI | done | ★★★★ |
| 20 | "Built it: <artifact URL>" then "kept" persists forever | workshop | default keep + expiry warning | low | ★★★ |
| 21 | "Meeting ended — captured 3 next steps from your notes; draft to the team?" | debrief + prep gather | notes extraction | med | ★★★★ |
| 22 | "Sarah's free Tue 2pm and Wed 10am (shared her calendar)" | — | guest freeBusy | low-med | ★★★★ |
| 23 | "You're paying for 4 streaming services; watched Netflix only this month" | — | usage inference — skip (creepy) | high | ★★ |
| 24 | "Rent cleared. You're $1,100 under budget this month." | — | bank feed | high | ★★★★ |
| 25 | "It's raining at 5 — move your run indoors; your program has a home variant" | weather + workout program | join | low | ★★★ |

---

# Part 15 — Things Alpha should make obsolete

The user should almost never again have to:

1. Search their inbox for "did X reply" — thread-state table should answer.
2. Check whether a sent email was answered — auto-armed follow-up watches.
3. Remember who owes whom — open loops + inbound promises.
4. Manually follow up — draft attached to every aging thread.
5. Re-explain context after saying "that one" — candidate re-rendering + durable task state.
6. Check whether a browser task finished — result delivery exists; also needs "status" grammar.
7. Reconnect services without knowing they broke — proactive connector-health pings.
8. Look up renewal dates — radar exists; make it loud at 7 days, not 3.
9. Find confirmation numbers — purchase receipts + mail search surfaced in one ask.
10. Compute "when do I leave" — ETA + buffer.
11. Check a flight status by hand — status poll on armed flight events.
12. Track packages across carriers — parse tracking numbers from delivery mail.
13. Remember birthdays day-of — lead-time arming.
14. Manually check-in for flights — vault + airline script.
15. Keep a shopping/price-watch list — browser_watch with proactive offers.
16. Summarize their own week — weekly review loop exists; make it comparative ("vs last week").
17. Type the same preferences twice (aisle, no pork) — stored but must thread into flows.
18. Wonder if a reminder actually fired — delivery status surfacing.
19. Scan attachments for the one number — attachment parsing.
20. Decide "is this email even real" — judge already classifies; show the why.

---

# FINAL DELIVERABLES

## 1. Top 50 real-life user expectations

1. Reply to an email with one sentence and have it actually sent.
2. "Did they reply?" answered from real mailbox state.
3. Automatic chase when someone doesn't answer.
4. Forward an email.
5. Read/summarize attachments.
6. A morning brief that ends with actions, not information.
7. Leave-by times with traffic.
8. Reschedule/cancel meetings safely (confirm + undo).
9. Mutual availability for scheduling.
10. Find open slots that are actually free.
11. Invite guests to events.
12. Reminders that can be edited/cancelled/condition-based.
13. Scheduled texts that can be cancelled.
14. Text anyone in their phone.
15. Contacts that add themselves from conversation.
16. Real spending data (transactions, not self-reports).
17. Duplicate-charge and bill-increase detection.
18. Renewal warnings with cancel option.
19. "Can I afford this?" against real money.
20. Flight check-in done, not linked.
21. Flight change/gate alerts.
22. Package tracking.
23. Book restaurants/flights/hotels end-to-end.
24. Cancel/reschedule what it booked.
25. Government/life-admin forms executed with 2FA relay.
26. Watch pages for conditions.
27. Stop anything, anytime.
28. Undo anything recent.
29. It remembers across days, numbers, and restarts.
30. "That one" resolves to the thing just discussed.
31. Corrections land ("I meant Boston").
32. It never emails/texts/buys without asking.
33. If it says done, it's done; if unsure, it says unsure.
34. It tells them when something broke (integrations, reminders).
35. Quiet hours respected.
36. Nudges stop when ignored.
37. Birthdays flagged with lead time.
38. Meeting prep before every meeting.
39. Debrief + follow-up capture after meetings.
40. Voice notes and photos handled like texts.
41. Preferences learned once, applied everywhere (aisle, no pork, cilantro).
42. Calendar defense before the day, not after the collision.
43. One number for everything (persona unification expectation).
44. Works on their platform (Android/SMS/WhatsApp expectation).
45. Transparency: "what do you remember about me" answered fully.
46. It knows what it can't do and says so without making them do the work.
47. Group plans handled.
48. Batch actions ("reply 1,3" / "send all").
49. Receipts/confirmations kept findable.
50. Less effort than the app it replaces — every single time.

## 2. Top 30 expectation gaps

1. Flight check-in = a link (P1).
2. No booking execution (flights/hotels) (P1).
3. Travel fare sources disabled in prod config → "source unavailable" (P1).
4. Purchase flow never proven end-to-end with a real order (P1).
5. No transaction/bank data; spend answers from self-logs (P1, false-completion risk).
6. No attachment reading (P1).
7. No email forward (P1).
8. No archive/mark-read/labels — "inbox handled" isn't (P2, honesty gap).
9. No generic reply-detection / waiting-on state (P1).
10. No guest availability → misleading scheduling answers (P1).
11. No event guest invites (P1).
12. `free_slots` calls a missing endpoint → slot-finding fails (P1 bug).
13. Scheduled texts can't be cancelled (P1).
14. Calendar cancel/move is silent, unconfirmed, unundoable (P1 trust).
15. No general undo ("cancel that") (P2).
16. No contact add/text without CRM entry (P1).
17. "When did I last talk to X" from CRM only (P2).
18. 20-message memory window + container-local summary death (P1).
19. No connector-health proactivity — silent degradation (P1).
20. Bill-increase detection stub (P2).
21. No duplicate-charge detection (P1).
22. No package tracking (P2).
23. No flight change monitoring (P2).
24. Birthday day-of only (P2).
25. $200 cap has no raise path ("ask in chat" dead end) (P2).
26. Text approval can't authorize purchases (friction, deliberate) (P2).
27. Live browser view unreachable on some networks → stranded handoffs (P1).
28. Commitment rescues fire even when done (P2).
29. Persona memory isolation surprises users (P2).
30. iMessage-only vs. README's multi-channel claim (P2, expectation set by marketing).

## 3. Top 30 "faster manually" moments

(Condensed from Part 5 — the full list with fixes is there.)

1. Mutual scheduling — open calendar. 2. Slot finding — broken endpoint. 3. "Send it" across sessions. 4. CAPTCHA live view. 5. Gmail reconnect URL. 6. Link payment consent context switch. 7. Flight check-in. 8. $200 cap dead end. 9. Attachment forwarding. 10. Forwarding at all. 11. Texting anyone not in CRM. 12. Reading attachments. 13. Fare search. 14. "The other one" without a list. 15. Bulk calendar moves. 16. Event invites. 17. Unsubscribe. 18. "Why didn't you remind me?" 19. Connector status. 20. Spend cross-checks. 21. Subscription cancellation. 22. Booking with empty vault (3-step credential dance). 23. Post-container-swap context re-explaining. 24. Email search beyond 2 days. 25. Package tracking. 26. Summarizing a doc (Drive = filenames). 27. Group plans. 28. Calls (pharmacy, dentist). 29. Scheduled email sends. 30. Explaining its own failures.

## 4. Top 20 missing everyday capabilities

1. Forward email. 2. Attachment read/send-through. 3. Archive/mark-read/labels. 4. Undo send. 5. Scheduled email send. 6. Event guest invites. 7. Guest free/busy. 8. Travel-time/leave-by. 9. Flight check-in execution. 10. Flight change alerts. 11. Package tracking. 12. Bank/transaction feed (or honest labeling). 13. Duplicate-charge detection. 14. Bill-increase detection (un-stub). 15. Subscription cancellation execution. 16. Scheduled-text cancel/edit. 17. In-chat contact add/edit + Google Contacts lookup. 18. General task stop/undo. 19. Condition-based reminders. 20. Cross-persona shared memory.

## 5. Top 20 context failures

1. "The other one" without numbered cards. 2. "Send that" across sessions. 3. "He" outside the 20-message window. 4. Container swap wipes summary/history. 5. "Move it later" ambiguity without candidate list. 6. "How much was it?" ambiguous purchase recall. 7. "That apartment" — long-horizon topic recall. 8. Persona-isolated memory across numbers. 9. "Cancel that" scope. 10. "Book the usual" — no anchored preferences for restaurants. 11. People mentioned in chat not linked to CRM rows. 12. "Did we finish that?" outside loop capture. 13. Multi-ask messages partially executed. 14. "Yes but also…" conditional approvals rejected rigidly. 15. Clarify-asks that don't re-list options. 16. 2-day default search window breaking follow-ups on slow responders. 17. pendingSpend 10-minute expiry surprising slow repliers. 18. Preferences stored but not threaded into booking flows (aisle seat). 19. No entity memory of what was promised to whom in free text. 20. "Wait stop" honored, but partial actions already taken can't roll back.

## 6. Top 20 proactivity opportunities

1. Auto-arm a reply-watch on every sent email. 2. Connector-health ping. 3. Reminder-failure surfacing. 4. Leave-by times on event nudges. 5. Flight status change alerts. 6. Package status pushes. 7. Duplicate-charge alerts. 8. Bill-increase alerts (un-stub). 9. Birthday T−3d. 10. One-tap fixes in calendar_defense. 11. Pre-drafted follow-up in debrief nudges. 12. "Did this already happen?" check before commitment rescues. 13. Renewal radar at 7 days with cancel offer. 14. Evening batch-draft offer ("send all"). 15. Workshop expiry warnings. 16. Missing-attachment guard before send drafts. 17. Post-purchase order-status recheck on outcome_unknown. 18. Streak restart one-taps. 19. First-brief demo of one hidden capability (rotating teach). 20. "Your task failed 3× — want me to try a different way?" loop failure surfacing.

## 7. Top 20 discoverability failures

(Listed in Part 12 — top by impact: auto reply-watch after sends; browser_watch after price asks; renewal radar naming; scheduled-text cancelability; sweep batch sends; 2FA relay instruction; workshop builds; tone words for drafts; digest time control by text; quiet-hours setup offer; persona explanation; vault one-tap capture; correction confirmations; promise watching; numbered file results; recurring reminders; prep offers in meeting nudges; keep-me-honest cadence; artifact keep default; "what do you remember" transparency.)

## 8. Top 25 magic moments

See Part 14 (top five: 2FA relay; auto follow-up watch with drafted nudge; conflict → one-tap fix; promise→file→send join; CAPTCHA auto-resume).

## 9. Capability completeness map

| Domain | Read | Understand | Act | Edit | Cancel | Monitor | Verify | Recover |
|---|---|---|---|---|---|---|---|---|
| Email | ●●● | ●●● (judge) | ●● (send gated, no fwd/attach-in) | ● (rewrite) | ○ | ●●● (followup/watchtower) | ●●● | ○ (no unsend) |
| Calendar | ●●● | ●● | ●● (holds, move, cancel, RSVP) | ●● (update) | ●● | ●● (defense) | ●● | ○ (no undo) |
| Contacts | ● (CRM) | ○ | ● (CRM via web) | ● (web) | ● (web) | ●● (cadence) | — | — |
| Reminders | ●●● | ●●● | ●●● | ●●● | ●●● | ●●● | ●●● | ●● (retry/freeze) |
| Scheduled texts | ● | ● | ●● | ○ | ○ **no cancel** | — | ●● | ●● (lease/outcome_unknown) |
| Memory | ●●● | ●● | ●● (remember/forget) | ●● | ●● | ● (resurface) | — | ● (tombstones) |
| Browser tasks | ●●● | ●● | ●● (unproven e2e) | ○ | ● (narrow) | ●● (watch) | ●● (screenshots) | ● (resume/retry) |
| Purchases | ●● | ●● | ● (unproven; Link-gated) | ○ | ○ post-execution | ● (watch) | ●●● (receipt) | ○ (no cancel/refund) |
| Travel | ● (config-dependent) | ●● | ○ (no booking) | ○ | ○ | ● (checkin link) | ● (fare banner) | — |
| Money | ● (self-logged) | ●● | ○ | ● | — | ●● (radar) | — | — |
| Habits/health | ●●● | ●●● | ●●● (logs) | ●● | ●● | ●●● (streaks/pokes) | — | — |
| Research/web | ●● (1 page) | ●● | ○ | — | — | ● (watch) | ● (disclaimers) | — |
| Software gen | — | ●● | ●●● (build) | ●●● (iterate/keep) | ● (toss) | — | ● (parse-check) | ● (expiry) |

●●● strong · ●● partial · ● narrow · ○ missing · — n/a

## 10. "Why would I text Alpha instead of opening the app?"

- **Gmail**: Yes for "who needs me / draft this reply / watch for her reply / prep this person." No for forward, attachments, archive, unsubscribe, scheduled send. The winning frame is *triage + chase*, not *mail client*.
- **Calendar**: Yes for prep bundles, debrief capture, nightly conflict defense, holds by text. No for invites, guest availability, bulk edits, travel time. Winning frame: *meeting memory + defense*.
- **Browser**: Yes — this is the differentiator — 2FA relay, vault logins, CAPTCHA handoff, watch loops, verified receipts. But zero flows are proven end-to-end; until one is, this is potential, not product. Winning frame: *logins + verification + watching*.
- **Reminders**: Yes — best-in-family. Recurring, snooze, DST, retry, freeze. Losing only on condition-based triggers. Winning frame: *the thing it says it will do actually happens*.
- **Travel apps**: **No compelling answer today.** Fares mostly unavailable, no booking, check-in is a link, no change alerts. Fix: one fare source + check-in execution + change monitoring, or de-emphasize travel.
- **Banking/spending**: **No compelling answer today.** No transaction data; answers from self-logs risk trust. Fix: Plaid feed or honest data-source labeling + focus on bills/renewals from mail.
- **Notes**: Weak. Drop zone + Notion if connected. No doc reading. Not a reason to text.
- **ChatGPT**: Yes — Alpha has context (mail/calendar/people/logs) that ChatGPT lacks, plus execution (send/book/watch). The moat is context+action, not intelligence. Losing ground when it answers from partial data as if complete — that erases the moat.

## 11. User habit analysis

- **Once a week**: weekly review + renewal radar + refund hunter — passive value, no daily hook. Requires zero effort; survives on trust.
- **Once a day**: the morning brief is the anchor. Habit forms if the brief ends in one completed action (send one draft, book one hold) — day after day, that's the ritual. Evening wrap + debrief capture is the second anchor.
- **10+ per day**: only reachable through (a) logging by text (food/gym/spend — already works for self-trackers), (b) the email draft→send loop (needs "send it" to be reliable cross-session), (c) live task participation (2FA/answers mid-run — magic moments), (d) being genuinely useful inside work hours (coworker: standup, Linear, follow-up watches). The 10×/day habit is earned by *executions*, not answers: every verified send, every completed chase, every caught conflict is a deposit.

## 12. Recommended product priorities

Scored on frequency × pain × expectation-strength × differentiation ÷ complexity:

| Rank | Priority | Rationale |
|---|---|---|
| 1 | **Fix the broken floor**: implement `/api/internal/work/slots`; prove one real e2e purchase; enable one fare source; proxy the live view | Reliability is the moat's foundation; the internal audits name these as acceptance blockers |
| 2 | **Auto-arm reply-watches on every sent email + contextual teach** | Highest frequency job (email) × existing-but-invisible capability × tiny complexity |
| 3 | **One-tap confirm/undo for destructive calendar ops + post-move verification** | Trust for the write-path family; small |
| 4 | **Scheduled-text cancel/edit + general "stop/status" grammar for jobs** | Closes the only un-cancellable action family; small |
| 5 | **Connector-health proactivity + reminder-failure surfacing** | Silent degradation is the top churn driver found in this audit |
| 6 | **Attachment read/forward (Gmail modify scope bump)** | Unlocks a dozen everyday jobs (forward, PDF read, unsubscribe, archive) with one scope change |
| 7 | **Contacts: Google Contacts lookup + chat contact add** | Unlocks "text X" for real life; medium |
| 8 | **Guest freeBusy + event invites** | Fixes misleading scheduling answers; medium |
| 9 | **Spend data honesty (labeling) → Plaid feed** | Kills the false-completion risk on money questions |
| 10 | **Airline check-in execution (vault + script)** | Big differentiation, high value, depends on #1's live-view fix |
| 11 | **Bill-increase + duplicate-charge detection from mail** | Un-stub + scan; medium |
| 12 | **Cross-persona memory layer (or single-number unification)** | Removes a structural surprise |
| 13 | **Server-persisted conversation summary** | Memory survives container swaps |
| 14 | **Candidate re-listing on every clarify** | Small UX rule, large "paying attention" feel |
| 15 | **Flight change monitoring + package tracking from delivery mail** | Senses users assume exist |

## 13. Final product thesis

**Alpha should not try to be an app you text. It should be the executor and chaser for the commitments that live inside your existing apps.**

The evidence in this audit points one direction: Alpha's reliable, differentiated moments are all of the form **"it said it would do something, it did it, it verified it, and it came back"** — reminders that fire, sends that verify, follow-up watches that re-read the live thread, 2FA codes typed into a real checkout, conflicts flagged before they bite. Its failures are all of the form **partial action presented as complete** — drafts that don't clean the inbox, availability that ignores the other person, spend answers from self-reported data, a travel stack that searches nothing, a purchase pipeline nobody has completed.

So the thesis, stated as the promise a stranger should be able to hold Alpha to after one day:

> **"Text me what needs to happen. I'll do the parts a machine can do, ask you exactly once for the parts only a human can do, prove it happened, and chase it until it's closed — or tell you honestly why it isn't."**

Concretely that means: every send arms a chase; every commitment arms a rescue that checks before it nags; every destructive action confirms and can be undone; every failure texts the user before they discover it; every money answer discloses its data source; and every handoff is one tap, not a URL. Feature count is not the product. **The closed loop — ask → act → verify → remember → follow up — executed without a single silent failure — is the product.** Everything else in this audit is downstream of making that loop unbroken.

---

## Appendix — Method notes

- Six parallel code audits traced: turn pipeline (`spectrum/shared/runHireTurn.ts`, `toolLoop.ts`, `conversationalFriend.ts`, `gmi.ts`, `turnIntent.ts`), server surface (`deploy/hire-api.ts` + 29 route modules), email/calendar internals (`deploy/google/actions.ts`, `connectors/hub.ts`, `gmailHelpers.ts`), memory (`deploy/memory/store.ts`, `spectrum/shared/memory.ts`), proactive systems (`deploy/nudges/*`, `deploy/loops/engine.ts`, `spectrum/shared/taskLoops.ts`, `lifeState.ts`, `judgment.ts`), execution (`deploy/browserWorker.ts`, `agentDriver.ts`, `linkWallet.ts`, `userPayments.ts`, `travel/*`), surfaces (`spectrum/shared/miniApps.ts`, `src/platform/*`).
- Prior recorded live evidence: `docs/cloud-computer-diagnostic.md` (live Kernel runs, Overpass failure → "no results", port 8443, never-completed booking), `docs/purchase-browser-search-audit.md` (Link acceptance criteria unmet), `docs/instinct-gap-closure.md` (dimension gaps), `docs/alpha-email-experience.md` (brief prototype).
- No production systems were modified. No synthetic conversations were executed in this pass; predictions marked 🟡/⚠️ are traced from code paths and should be confirmed with `bun run testbed:turn` before acting on them.
