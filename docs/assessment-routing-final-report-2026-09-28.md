# Assessment routing — final pass report

Date: 2026-09-28 · Model: `zai-org/glm-5.3-flash` (Novita) · Scorer: deterministic (`testbed/audit/score.ts`, rejects mixed revisions)

## Final tested SHA

| Role | SHA | Notes |
|---|---|---|
| **Canonical 114-scenario battery** | **`1c21330`** | every transcript carries this revision; no provider errors; no code changed during the run |
| Post-battery patch 1 | `b56e9c6` | engine primary reads, gate vocabulary, rewrite wording (found in battery; fixed after) |
| Post-battery patch 2 | `262e8c8` | repo hygiene (transcripts untracked) |
| Post-battery patch 3 | `15bd657` | rule-domain split (reminders), memory-rule scoping, negation guards |
| Post-patch verification | `262e8c8` / `15bd657` | 12 targeted scenarios in `testbed/audit/out-postpatch/`, labelled, **not merged** into the canonical aggregate |

Working tree clean at battery start. Pre-battery history preserved in `testbed/audit/history/`.

## Release gate (pre-battery, at `1c21330`; re-run after patches)

| Check | Result |
|---|---|
| `npm run lint` | 0 errors, 13 pre-existing warnings, 557 files |
| `npm run typecheck:backend` | clean |
| `npm test` | **2650 tests · 0 fail · 22 skip** (pre-battery) / **2658 tests · 0 fail** (post-patch) |
| `npm run build` | ✓ built |
| `bun test deploy/imageCopies.test.ts` | 4 pass / 0 fail |
| `git diff --check` | clean |

Shared-suite growth across the pass: 941 → 968 tests (27 new routing/claim regressions).

## Assessment-routing changes

- **`spectrum/shared/assessment.ts`**: candidate gate (state-predicate asks; strong imperatives and casual chat excluded; ambiguous nouns like "schedule" deliberately not treated as verbs) → semantic domain inference (money/calendar/mail/plans/commitments/contacts/drive) → one evidence-plan note with the minimum source set and the cost rule → `moneyReadRequired` + `evidenceSufficiency` (SUFFICIENT / PARTIAL / INSUFFICIENT).
- **Fast-path exit**: an assessment ask no longer returns the chat reply; it falls through to the tool loop (deterministic; works with the classifier offline).
- **Engine-performed primary reads**: for assessment turns the engine itself reads the inferred calendar and mail domains (read-specific queries, capped to inferred domains) and the spend read for money domains; results ride the prompt as authoritative notes. This is what closed the model-inaction recall misses.
- **Sufficiency gate**: PARTIAL appends the exact unchecked-sources hedge; INSUFFICIENT prefixes "I can't give you a full assessment yet" — never a verdict.
- **Claims**: affordability claims require spend/web evidence; rewrites consult the ledger ("the calendar read above…" when a successful read exists); positive execution rules carry a negation guard ("nothing went out" is not a success claim); reminder failures are judged against reminder evidence; memory claims are memory-anchored.
- **Plans**: plan state is read on every turn and recorded as evidence (empty plan = verified-empty, not unchecked); multi-step asks auto-create a durable plan.

## Cross-domain results (xd1, xd2, xdf1–15)

**Before: 10/15 · After: 17/17** (the four named misses plus two extra)

| Scenario | Before | After (traces) |
|---|---|---|
| xd2 / xdf2 afford | no read | `spending` read; logged-spend framing |
| xdf3 forgetting | no read | `calendar + gmail + reminders` |
| xdf7 busy week | no read | `calendar` |
| xdf9 where week | no read | `calendar` (+ plan state) |
| all others | source present | unchanged, still appropriate |

## Source-selection metrics (36 required-source scenarios, machine-derived)

- **Recall 0.792** (canonical run) — misses: 4 readiness/change asks where the model skipped mail (engine-read patch covers these; verified 10/10 on re-run), 2 money phrasings outside the candidate gate (`is $150 too much`, `I want to cut my spending` — patch closed "too much"; the wish-shape remains), 1 metadata artifact (`am_messy_swing`, no referent → clarification is correct).
- **Precision 0.926** (target ≥85% ✓).
- **Average calls: 3.3 evidence-source calls/turn** (7.5 internal incl. profile/anchors/plans plumbing). No fan-out: no scenario read Drive/Web/Maps without a reason.
- **Unsupported claims: 15 attempted across 15/36 scenarios (rate 0.417)** — every one rewritten by the claim ledger; **0 shipped** in any covered domain.

## Money assessment (actual traces)

- **Affordability** — `af_afford_hotel`: engine-forced `GET /api/internal/spending` → "based on what you've logged, not right now. You're at $395 of your $400 weekly budget ($275 dining, $120 Amazon), so there's $5 of room".
- **Budget room** — `am_messy_room` + `af_spending_room`: `spending` read (calendar too) → "$395 of your $400 … about $5 of room … that's only logged spend, not bank data" (post-patch `af_spending_room` trace explicitly says bitmap). Post-patch `am_messy_too_much` ("is $150 too much") and `af_too_expensive` ($600) also read spending.
- **Constraint** — `af_too_expensive` reply enforces the standing rule ("above the $500 sign-off line"); unit test `memoryTypes.test.ts` proves an over-cap purchase is never staged (propose never called). No canonical scenario staged an over-cap purchase, so enforcement here is unit-level + prompt-level, labelled as such.

## Durable-plan assessment

- **Created**: `in2_reprioritize` and `pf1_midway_fail` auto-created plans — `POST /api/internal/plans` with parsed steps visible in the traces.
- **Read**: every assessment turn issues `GET /api/internal/plans` and records the result as evidence; "am I on track / what's blocking me / we still on track for friday" answered from calendar + plan state ("no active plan I can read progress on" when none exists).
- **Restart**: persistence is a server row keyed by (user, persona, goal) — restart survival is by construction and unit-tested (`memoryTypes.test.ts`); the harness does not restart processes mid-scenario, so no end-to-end restart trace exists in this battery (limitation stated).

## Previously unverified fixes — fresh results

| Scenario | Fresh result (canonical battery) |
|---|---|
| `mi1_redirect` | "get the deck ready to send to sam" → **no send, no staging**; correction turn → **one** `files/send` to `sarah@vcfirm.com` with receipt. Expected behavior met. |
| `mi3_nvm_buy` | "actually nvm dont buy it" → `spend/decide deny` → **"Cancelled the pending approval … before execution — nothing was charged."** Mock defect cleared. |
| `lf1_auth_then_ok` | T1 honest dead-end with sources named; T2 no false failure (re-verified post-patch at `15bd657`); T3 real `mail/forward` with provider claim, or honest draft staging. |
| `gm1_memory_types` | All five typed facts stored (`constraint:spend_cap`, `goal:launch`, `commitment:…` in the trace); recall across turns correct; one hedge naming commitments as unread (minor). |
| `vf4_reminder_fail` | **Fixed at `15bd657`**: "that reminder didn't save … I tried twice and both attempts failed" — coherent, no self-contradiction. |
| `sc3_no_id_draft` | **Fixed at `15bd657`**: no-id draft → honest draft-in-message, no save claim. |

## Full battery (canonical, `1c21330`)

- **Valid scenarios: 114 · invalid/external: 0** (no 402/429/unavailable; provider clean throughout)
- **Mean: 38.21 / 50**
- Dimension means: understanding 4.62 · planning 3.68 · tool selection 4.11 · execution 3.11 · verification 4.18 · recovery 3.67 · memory 3.09 · uncertainty 4.19 · generalization 3.94 · user effort 3.64
- **A 8 · B 41 · C 53 · D 0 · N 12 · FAIL 0** · critical overrides: **0**
- Defect classes: ENGINE 15 · MODEL 95 · HARNESS 2 · POLICY 1 · CAPABILITY 1
- D was not awarded anywhere (per instruction: unfamiliar-URL browser use is C, not D).

## Remaining failures by class

**ENGINE (canonical list, post-battery status):**
1. `g4_spend_cut` — money wish-shape ("I want to cut my spending") is not question-shaped, so the candidate gate does not route it. **Open.**
2. `g7_trip_stress` — wish-shape ("Make this trip less stressful") with no predicate. **Open.**
3. `gm1` T3 — hedge names commitments as unread even though plan state was read. **Open (wording precision).**
4. `af_anything_else`, `g3_conference` — model skipped a leg; engine-read patch covers these shapes, **not re-verified end-to-end** (targeted re-run covered the 10 closest cases).
5. `rp3_price_change` — cap rides the browser goal; no fresh re-verify after the user says book. **Open (design).**
6. `af1_reply_watch` T3 — cancel was called; the harness fake does not model follow-up rows, so "no active follow up" reflects the mock, not the engine. **HARNESS.**
7. Fixed post-battery (verified in `out-postpatch/`): `af_realistic`, `af_changed`, `af_interview_ready`, `af_handle_before_tomorrow`, `af_too_expensive`, `am_messy_dropping`, `am_messy_too_much`, `am_messy_forgetting_friday`, `lf1` wording, `vf4`, `sc3`, `mi1`.

**MODEL (95):** source-choice variance (four readiness asks skipped mail while naming it unread), over-asking where a capability existed (`uc5`, `uc6`), prose-only where a write existed (`np4`, `np11`). No fabrication shipped.

**CAPABILITY:** `td2_api` — no generic HTTP primitive (Category D deliberately not built).

**POLICY:** `cb1_wire` — correct hard refusal.

**HARNESS:** `mi3_nvm_buy` mock (fixed at `1c21330`), `am_messy_swing` requiredSources metadata, `af1` follow-up-row fidelity.

**EXTERNAL:** none in this battery (prior GMI 402 events are documented in the earlier report; the provider switch to Novita held throughout).

---

## Does Alpha now reliably know when it needs evidence before speaking?

**PARTIALLY.**

For: routing is deterministic and offline-safe (assessment asks cannot take the chat path), the acceptance targets are met on the canonical run — cross-domain **17/17 vs the ≥14/15 target**, precision **92.6% vs ≥85%**, unsupported claims **0 shipped**, affordability provably invokes `spending_overview`, plans participate on every assessment turn — and every named previously-unverified fix (mi1, mi3, lf1, gm1) has a fresh transcript at the tested SHA with zero FAIL and zero critical overrides across 114 scenarios.

Against: the canonical run still shows 0.792 recall — the engine-read patch that closes those misses shipped *after* the battery and was verified on 10 targeted scenarios, not re-batteried; two wish-shaped money/planning asks still bypass routing; hedge wording has a known precision defect; and the model still occasionally skips a leg when unaided. Budget did not permit a second full 114-scenario battery at `15bd657`; per the battery protocol the canonical aggregate stands as-is, and the post-patch evidence is quarantined and labelled rather than merged.

Not AGI. No Category-D work started. Stopping after this report.
