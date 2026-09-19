# Instinct head-to-head: prioritized gap-closure checklist

Written 2026-09-18. Source of the score table: `docs/BENCH-ALL-DIMENSIONS.md`
Part 4 (rehearsal aggregate: Alpha 44 / Instinct 40 / Muse 27). Each losing
dimension maps to the **single cheapest** move that closes it, ordered by
(cost → point recovery). Items are grouped into four cost tiers; within a tier,
higher point-recovery first. Where the fix is already shipped in code, the file
is named — those items are verification, not building.

Cost legend: **DEPLOY** = already on main, ship + re-run · **CONFIG** = OAuth/allowlist/env only ·
**$RUN** = one real executed run (needs money/approval, no new code) · **CODE** = small scoped change ·
**INTEGRATION** = one third-party provider decision (the plan's "cannot win by effort alone" list).

## Tier 0 — deploy what already exists (moves ~7 points, zero building)

- [ ] **DEPLOY → dims 1, 3, 4.** Ship I1–I3 (map-server retry, landmark geocode,
      `PLACE_ASK_RE`) and the spend-approval import fix; they are marked
      "FIXED, needs deploy". Re-run dimensions 1, 3, 4 through the real thread
      per `BENCH-ALL-DIMENSIONS.md` §3.4 and record in
      `marketing/launch-kit/11-pawlan-self-bench.md`.
      *One deploy closes the same machine that owns four dimensions.*
- [ ] **DEPLOY → dim 3 guard.** After maps re-verification, add the one missing
      relevance filter (I4 remainder): a web result sharing no noun with the ask
      must not become a link or a run target. Small `CODE` in
      `spectrum/shared/toolLoop.ts` where `publicMatches` is populated.

## Tier 1 — config and fixtures only (moves ~6 points, no new product code)

- [ ] **CONFIG → dim 8 (3 vs 7), biggest cheap win.** The code path already
      exists: `WORK_LIVE_TOOLS` includes `slack`/`linear`/`notion`
      (`spectrum/shared/toolLoop.ts`) and `COMPOSIO_READ` has read specs for all
      three (`deploy/composioPlugins.ts`). Connect Notion + Slack on the
      workspace in Composio and add them to the friend tool allowlist. No code.
- [ ] **CONFIG → dim 14, half of it.** `COMPOSIO_READ.drive` already defines
      `GOOGLEDRIVE_LIST_FILES`/`GOOGLEDRIVE_FIND_FILE`; the account just isn't
      connected (also flagged in `docs/cloud-computer-diagnostic.md`). Connect
      Drive; the email→Drive→action chain loses its first blocker.
- [ ] **CODE (tiny) → dim 15 (5 vs 7).** Three injectable testbed fixtures — a
      boss email, a package notice, a friend's text — plus one written rule for
      which get acted on vs. drafted vs. ignored, run through
      `bun run testbed:turn`. Pure fixture work in `testbed/`.
- [ ] **$RUN → dim 5 lock-in.** One real send under the draft→approve flow (a
      real Sam fixture), so email goes from honest-search 8 to a completed 10.
      Also feeds dim 9 evidence (approval taken, logged).

## Tier 2 — small code + evidence runs (moves ~9 points)

- [ ] **$RUN → dim 4 (6→8 vs 6).** One real completed order with an order
      number via the Link approval flow. The bench doc is explicit: "One real
      order number beats any feature here." No new code; needs the $20k float
      policy or a small personal approval.
- [ ] **CODE → dim 7 (5 vs 8).** Weekday recurrence already shipped
      (`spectrum/shared/reminders.ts`). Add the chat pause command for the
      digest loop, then run the 5-for-5 weekday observation log.
- [ ] **CODE → dim 10 (3→7 vs 8).** Two parts: (a) a delayed unprompted-
      application test (store `aisle seat` + `no pork`, re-ask a week later in
      the testbed); (b) thread the stored seat preference into the flight flow
      payload (`armFlightCheckins` already builds a payload — add the
      preference). Memory injection exists; this is wiring, not building.
- [ ] **CODE → dim 9 lock-in.** Read-only scope sets are already defined in
      `deploy/hire-api.ts` (`gmail.readonly`, `calendar.readonly`,
      `drive.readonly`); the connected Google account is broad-read. Reconnect
      through the read-only scope path and verify disconnect deletes rows —
      then dimension 9 is a secured win instead of a contested one.
- [ ] **DEPLOY/CODE → enabler I6.** Early acknowledgement bubble ("On it —
      checking real listings now.") on task classification. Cheap, and it
      lifts the perceived latency of every scored run.

## Tier 3 — the one-integration list (moves ~16 points, four deliberate decisions)

Ordered by point-recovery per decision:

- [ ] **INTEGRATION → dims 2 + 14 together (5 vs 10, 3 vs 9): airline
      check-in.** Highest-value decision on the board. `armFlightCheckins`
      already arms a `flight_checkin` loop 24h before departure from calendar
      events (`deploy/hire-api.ts`); what's missing is the executor: the
      airline credential in the Vault (exact-origin) + one airline-specific
      step script (Web Check-In → seat map → boarding pass) in the browser
      worker, with the live takeover path (I5) for the seat/MFA step. One
      integration, ~11 points of headroom across two dimensions.
- [ ] **INTEGRATION → dim 12 (3 vs 5): telephony.** Composio path already
      anticipated — `toolkitForToolSlug` in `deploy/hire-api.ts` maps the
      `TWILIO_` prefix. Enable the Twilio toolkit, one outbound call flow +
      call-result → iMessage summary. Disclosed-call consent review per the
      plan's Phase 3 gate before any scored run.
- [ ] **INTEGRATION → dim 16 (3 vs 4): image generation.** Smallest version:
      one image-API call + a text-native trivia game. Cheapest of the four but
      also the smallest point recovery — hence last.
- [ ] **INTEGRATION → dim 13 (3 vs 6): group threads.** Photon group space +
      poll→agree→book. The plan defers multi-person coordination to Phase 3;
      Instinct leads by 3 here but no other dimension rides on it.
- [ ] **CODE → dim 6 (4 vs 8): flight watch.** Reuses the dim-2 work: extend
      the armed `flight_checkin` loop with an airline status/gate poll and
      change notification. Without dim 2's airline access, this stays capped.

## Cross-cutting gates (not scored, but they decide whether scored runs can pass)

- [ ] **I5 — live view reachable by the human** (port 8443 blocked): proxy
      through `hirealpha.chat` or relay the challenge into iMessage. Any
      CAPTCHA/MFA/seat-map handoff in a scored run strands without this.
- [ ] **I7 — dedicated database host.** Postgres recovery windows under build
      load were the root cause of every "mystery hang"; a flapping DB fails
      the plan's own reliability bar for every category.

## Ordering rationale (point arithmetic)

| Tier | Effort | Points recovered | Dimensions |
|---|---|---:|---|
| 0 Deploy | hours | ~7 | 1, 3, 4 |
| 1 Config/fixtures | days | ~6 | 8, 14½, 15, 5 |
| 2 Small code + runs | ~1 week | ~9 | 4, 7, 10, 9, I6 |
| 3 Integrations | the real decisions | ~16 | 2+14, 12, 16, 13, 6 |

Tiers 0–2 recover roughly the entire current deficit (Instinct leads by 22
raw points across losing dimensions) **without any third-party provider
decision**. The airline check-in integration is the one Tier-3 item to schedule
early because two dimensions and dim 6 all ride on it.

Not priority (already winning or capped): dim 3 (maps — Instinct has no maps
tool at all), dim 5, dim 9. Protect these; don't spend Tier 3 budget on them.

Matching the plan's priority rule
(`docs/strategy/beat-instinct-plan.md`): reliability defects first (Tier 0,
I5/I7), then frozen-benchmark capabilities (Tiers 1–2), then breadth (Tier 3).
