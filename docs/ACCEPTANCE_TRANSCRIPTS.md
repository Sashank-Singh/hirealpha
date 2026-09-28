# Acceptance Transcripts — Experience-Gap Fix Pass (2026-09-27)

Each transcript below is the target conversation for one high-frequency job. The **automation** column names what is now code (`deploy/acceptanceGate.test.ts` pins the contract at the route/copy level), and **live-only** names what still needs a real account run before this transcript is guaranteed end to end. Honesty rules apply everywhere: partial data is labeled, suggestion is never execution, and unknown outcomes are stated as unknown.

## 1. "handle my inbox"

```
user:      handle my inbox
alpha:     3 need you. I drafted replies for the two with asks:
           1. Greg · contract redline · draft ready
           2. Maya · invoice question · draft ready
           The other 9 in the last 2 days are promos, receipts, and newsletters.
alpha:     Say "send 1" (or "1,2") when the drafts read right, and "archive the rest"
           if you want the noise filed. Sending happens on your tap.
user:      1,2 and archive the rest
alpha:     Sent to Greg and Maya (receipts confirmed). Archived 9. Your inbox now
           shows what Gmail shows — I filed the copies I could reach.
```
- Automated: sweep copy names send-needs-tap + filing (`handleSweep`); archive/mark-read/trash/labels execute per-message-id with per-id outcomes (`POST /api/internal/mail/actions`); batch approval existed ("1,3").
- Live-only: the model's judgment of which mail gets drafts; archive coverage of mail Alpha has not read.

## 2. "reply saying Tuesday works" → "make it warmer" → "send it" → "did they answer?"

```
user:      reply saying Tuesday works
alpha:     Drafted to Sam: "Hi Sam — Tuesday works..." [Send card]
user:      make it warmer
alpha:     Recut: "Hi Sam! Tuesday works great — looking forward to it..."
user:      send it
alpha:     Sent to sam@acme.co. Want me to watch this thread and remind you
           Friday if they don't reply? (yes / no)
user:      yes
alpha:     Watching the thread with sam@acme.co. If they haven't replied by
           Friday, I'll check it and draft the nudge — nothing sends without you.
user:      (Thursday) did they answer?
alpha:     Not yet — the last message in "Re: deck" is still yours (Thu 09:12).
```
- Automated: draft + rewrite (`/api/mail/draft/rewrite`); "send it" resolves the durable draft anchor even after a restart (`runHireTurn` delegate fallback → `/api/internal/mail/send`, threadId passed); the follow-up offer is the one-time teach after a send (`followup_offer` task loop + `pending_followup_ask` anchor); "did they answer?" re-reads the live thread before answering (`/api/internal/mail/state?refreshThreadId=…`). Gate scenarios 2 + 8.
- Live-only: an actual Gmail send and reply on a real account; the "make it warmer" chat-path recut (web rewrite endpoint is real; in-chat is model-driven).

## 3. "when can Sarah and I meet?"

```
user:      when can Sarah and I meet this week?
alpha:     I can see your calendar, not Sarah's — her availability is unknown
           here. You're free Thu 09:00, Thu 15:30, or Fri 11:00. Want me to
           email her those three times?
user:      yes, email her
alpha:     Drafted to Sarah with the three slots [Send card].
```
- Automated: the slots route reads guest freeBusy when resolvable and returns `guests.unknown` when not; the honest line is pinned verbatim (`describeMutualAvailability`, `POST /api/internal/work/slots`). User-only reads are labeled "YOUR calendar". Gate scenario 3.
- Live-only: a same-domain guest whose freeBusy actually resolves (then the slots genuinely intersect and are labeled "Free for you AND …").

## 4. "what am I waiting on?"

```
user:      what am i waiting on?
alpha:     Tracked threads waiting on them:
           Greg <greg@x.com> · Contract redline · 2026-09-27
           Sam <sam@acme.co> · Deck · 2026-09-26
           Plus your promise: "send the deck by Friday" (due Fri). This is my
           per-thread tracking, not the whole mailbox — want a deeper search?
```
- Automated: durable `hire_thread_state` (seeded by sends, refreshed by reads, re-verified live); waiting-on / ignoring / per-person queries (`mail_state` capability + `/api/internal/mail/state`). Gate scenario 4.
- Live-only: promise-loops captured from free-form chat phrasing (regex capture).

## 5. "what am I forgetting?"

```
user:      what am i forgetting?
alpha:     Three things with clocks:
           • You promised Maya the contract by today (it's 16:00)
           • Greg hasn't replied since Tuesday — I can draft the nudge
           • Tomorrow: Dentist 15:00 overlaps Standup 15:10 — want me to move Standup?
           Your 8am brief carries the rest.
```
- Automated: open loops + commitment rescues + calendar_defense (nightly) + on-demand conflict check (`check_conflicts` capability, `describeDayConflicts`); every line names an action. Gate scenario 5.
- Live-only: cross-window mail promises outside Alpha's judged set.

## 6. "send her the deck"

```
user:      send her the deck
alpha:     Found 2 files named like "deck": 1. deck-v3.pdf (2 MB) 2. deck-final.pdf (2 MB)
user:      1, to maya@x.com, as an attachment
alpha:     Sent "deck.pdf" to maya@x.com as an attachment. Gmail receipt confirmed
           (id MSG-SENT-1). Want me to watch for her reply?
```
- Automated: Drive resolve + attach + send + provider receipt (`/api/internal/files/send`, receipt status `sent`, `outcome_unknown` never retried); duplicate files force a numbered choice; recipient must be a real address. Gate scenario 6.
- Live-only: the model resolving "her" → Maya from context (contacts anchor makes it restart-safe).

## 7. "did my flight change?"

```
user:      did my flight change?
alpha:     I can't monitor airline status changes yet, so I can't answer that —
           checking now would be a guess. What I CAN do: watch the airline's
           status page and text you when it shows a change, and check-in
           reminders 24h before departure. Want the watch?
```
- Automated: the honesty rule (no bluffing, no implied monitoring) is pinned in the engine prompt truth-rules and the check-in copy ("I can't complete airline check-in…"). Gate scenario 7.
- Live-only: the browser_watch arm on the airline's status page (capability exists; the model must choose it).

## Cross-cutting restart test (P3)

Between any two turns above, the process/container may be restarted. Anchors (`hire_turn_anchors`: draft, thread, event, person, browser_job, reminder, selection, pending_event_action, pending_followup_ask) survive; "send it", "the other one", "move that", "cancel that", "undo", and "did they reply?" resolve against them. Gate: the send-it fallback and thread binding are pinned; the full restart matrix runs live via `bun run testbed:turn` pairs.
