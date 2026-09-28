# Release Gate — Experience-Gap Fix Pass (2026-09-27)

Scope honored: targeted gap fixes only (email depth, calendar honesty, durable conversational anchors, contextual teaches, partial-completion honesty). No new product areas, no architecture refactor.

## Gate results

| Check | Command | Result |
|---|---|---|
| Lint | `npm run lint` (oxlint) | PASS — 0 errors (5 pre-existing `no-eval` warnings in browser runners, unchanged) |
| Backend typecheck | `npm run typecheck:backend` | PASS — 0 errors |
| Test suite | `npm test` (bun test) | 2536 pass, 22 skip, **1 fail** |
| Production build | `npm run build` (tsc -b + vite) | PASS |

**The one failing test is pre-existing on `main`**, verified by running it on a clean tree (`git stash`): `agentLookup.test.ts > still fills in the recent window when the read itself failed` — the test's fetch mock never sees the second Gmail list call because the Composio fallback answers the fill read from the same mock. It is environment-dependent and unrelated to this pass; a candidate fix is to make the fill-read assertion count only `gmail.googleapis.com` list calls.

## What was fixed (real-life gaps)

### Priority 1 — Email should feel handled
- **Attachment read**: attachments are listed on every message read (metadata + ids bound to the thread), and text-like files and PDFs are extracted to bounded text on demand (`deploy/google/attachments.ts`, `GET /api/mail/:id/attachment/:attId`, `POST /api/internal/mail/attachment`, `mail_attachment` capability). The "attachments not included" cop-out is gone from the by-id tool read.
- **Forward**: a real forwarded message — original From/Date/Subject block, attachments re-attached, thread identity preserved, Message-ID idempotency, receipt-only success (`gmailForwardMessage`, `/api/internal/mail/forward`, `forward_email` capability). Not a "Re:" with pasted text; a MIME bug in the multipart branch (missing headers) was caught by the gate test and fixed.
- **Inbox actions**: mark read/unread, archive/unarchive, labels, trash — per-message-id with per-id outcomes and honest partial-failure reporting (`modifyGmailMessages`/`trashGmailMessages`, `inbox_action` capability, web `/api/mail/actions`). `gmail.modify` scope added to the Google grant; existing grants get a "reconnect to file mail" message instead of a fake success.
- **Waiting-on / reply-state**: durable per-thread state (`hire_thread_state`) seeded by every send and conversational read, re-verified against the live thread before answering (`mail_state` capability, `/api/internal/mail/state?refreshThreadId=`). "Who owes me a reply?" / "who am I ignoring?" / "did Sam ever reply?" no longer depend on the 2-day mailbox window.
- **Auto-offer follow-up**: after any send (card tap or "send it"), a one-time offer — "Want me to watch this thread and remind you Friday if they don't reply?" — is texted by the `followup_offer` loop and armed only by the user's yes (`pending_followup_ask` anchor → `email_followup`). Never auto-arms; capped at 3 offers/30 days and 2 open follow-ups.

### Priority 2 — Calendar stops sounding smarter than it is
- **The broken production path is fixed**: `POST /api/internal/work/slots` now exists (the bot's `free_slots` tool previously called an endpoint with no handler).
- **Mutual availability is honest**: guest freeBusy is queried when the guest's calendar resolves; otherwise the response carries `guests.unknown` and the reply says verbatim: "I can see your calendar, not Sarah's" — user-only slots are labeled user-only (`computeFreeSlots`, `describeMutualAvailability`).
- **Invites**: `calendar_event` gained `invite` (attendees merged, provider emails them); holds accept attendees.
- **On-demand conflicts**: `check_conflicts` capability + `/api/internal/calendar/conflicts` — overlaps and zero-gap turnarounds, named event by event.
- **Confirm / undo / readback**: cancel and move now confirm first ("Cancel 'Dentist'? Reply yes"), execute on yes, read back the provider state, and keep the prior times for a one-hour "undo" that restores them. Cancel-after-yes offers hold-recreation. A bare "cancel that" / "move that" resolves against the event anchor instead of asking which meeting without listing options.

### Priority 3 — Conversational continuity survives restarts
- New typed, expiring, per-(user, persona, kind) anchor store (`hire_turn_anchors` + `/api/internal/anchors`): `draft`, `thread`, `event`, `person`, `browser_job`, `reminder`, `selection`, `build`, `pending_event_action`, `pending_followup_ask`. Refs are provider ids (plus the draft body for the send-it anchor) — not transcripts.
- Restart-safe resolutions wired in `runHireTurn`: "send it" (draft anchor fallback), "the other one" (selection anchor), "move that"/"cancel that"/"undo" (event + pending anchors), "did they/he/she reply?" (thread anchor → live re-read), follow-up offer confirmation. Anchors are set at the choke points: `proposeLiveDraft`, `proposeBrowserTask`, `/api/work/send`, `/api/work/hold`.

### Priority 4 — Hidden strengths, taught contextually
- `spectrum/shared/teaches.ts`: gated one-liners (max 2 shows, 3-day cooldown) attached to the relevant moment — follow-up watch after a send, page-watch after a price/travel answer, 2FA relay on the first login handoff, renewal radar naming on the first renewal text. The meeting nudge already offered prep; no tutorial surfaces were added.

### Priority 5 — Partial completion honesty
- Engine truth rules added (never present partial as complete): spend answers are framed as "of what you've logged"; mail reads state their window; user-only availability is never mutual; draft ≠ sent, hold ≠ booked; browser tasks claim only verified outcomes; flight check-in / subscription cancellation / calls are declined with the next real action; flight changes and packages are not promised as monitored.
- Flight check-in copy now says "I can't complete airline check-in for you yet" next to the direct link. Sweep copy says "Sending happens on your tap" and offers filing.

## Remaining incomplete user jobs (deliberately not built in this pass)
1. **Flight/hotel booking execution and real check-in** — needs the airline-specific executor + a proven e2e purchase (per `docs/cloud-computer-diagnostic.md`).
2. **Bank/transaction feed** — spend answers are honest but still self-reported; Plaid read tool exists, reconciliation does not.
3. **Flight change / gate monitoring, package tracking** — honesty shipped; the monitors did not.
4. **Bill-increase detection** — still a stub (`taskLoops.ts`).
5. **Live-only verification** of the acceptance transcripts on a real account (transcripts marked accordingly in `docs/ACCEPTANCE_TRANSCRIPTS.md`).

## Flows that still require leaving iMessage
- Google OAuth (re)connect, Vault credential save, Link payment consent (by design — text cannot approve spend), CAPTCHA/CAPTCHA-adjacent live-view handoffs when auto-resume does not fire, and mini-app cards (tap-out to hirealpha.chat webviews).

## Flows now clearly faster than opening the original app
- "Send it" / draft→tap send with receipt, **including after a restart**.
- "Follow up if they don't answer" (one word arms a live re-verifying watch).
- "Did they reply?" (thread re-read, not a search reconstruction).
- "Forward this with the attachments" (was: impossible in chat).
- "Archive / mark read / trash these" (was: impossible in chat).
- "Send her the deck" (Drive → attachment → receipt in one thread).
- "When can Sarah and I meet?" (honest slots, or a drafted ask in one step).
- "Cancel/move that" with confirm + undo (Calendar app has no undo).
- Contextual 2FA relay during any portal task.
