# HireAlpha plan to beat Instinct

Date: 2026-09-14  
Status: implementation in progress; local quality gates green, live certification blocked
Strategy: match Instinct's real-world execution, then win with visual mini-apps, user-controlled authority, and verifiable outcomes.

## Implementation checkpoint — 2026-09-16

Local engineering gates are green: backend typecheck, production frontend build,
and the full test suite (1,896 pass, 0 fail, 16 live-provider tests skipped).
The canonical Kernel worker now requires Browser Use, OpenBao, telemetry,
canonical task recording, receipt verification, and an HTTPS app URL in
production. CI runs the same lint, backend typecheck, test, and build gates on
every pull request and main-branch push.

Current evidence-based scores:

| Dimension | Score | Evidence / remaining gate |
|---|---:|---|
| Architecture | 9.0/10 | Canonical task/event model, authority broker, isolated browser execution, fail-closed verification, telemetry, and explicit recovery states are wired. The remaining point is earned only by operating evidence at scale. |
| Implementation | 9.0/10 | Full local suite and builds pass; browser payments, Vault handoff, grounded choices, task mirroring, and readiness validation are implemented. |
| Production readiness | 6.5/10 | The release gate is intentionally blocked until live Postgres, OpenBao, E2B/Kernel, Stripe/Link, Vault login, load, and restart-recovery evidence is recorded. BLOCKED certification now exits non-zero and cannot be reported as a pass. |

Production readiness reaches 9.0 only after the certification suites below run
against staging with zero failures; missing credentials or operator runs remain
BLOCKED, never inferred as successful.

## Product thesis

HireAlpha should become the assistant that can do everything Instinct does while giving the user better choices before an action, better control during the action, and a useful visual record after the action.

The promise:

> Text Alpha anything you do not want to deal with. Alpha researches it, gives you clear visual choices, completes it with your authority, and keeps everything organized afterward.

The product has one primary interaction surface and one persistent visual surface, backed by external identities and synchronization destinations:

1. iMessage is where users ask, choose, approve, and receive outcomes.
2. Mini-apps are the persistent visual record for options, progress, receipts, documents, plans, and later changes.
3. Alpha's email address and phone line are external communication identities used to perform work.
4. Calendar and, later, WhatsApp are synchronization destinations or optional interaction channels, not separate sources of task truth.

Mini-apps must never become a required detour. A task remains completable from iMessage.

## Canonical user journey

```text
User asks in iMessage
        |
        v
Alpha clarifies dates, travelers, budget, and preferences
        |
        v
Alpha researches across web, email, calendar, location, and memory
        |
        v
Visual option cards arrive with image, live price, reason, and source link
        |
        v
User chooses an option
        |
        v
Alpha launches its browser and completes checkout
        |
        +--> Login required?
        |      +--> Exact-site credential in Vault: use one-time scoped access
        |      +--> Missing credential: request it securely, then resume
        |
        +--> Payment required?
               +--> Connected payment is authorized: use it within its limit
               +--> Otherwise: send Stripe approval/payment link at checkout
        |
        v
Alpha verifies the merchant confirmation before claiming success
        |
        v
Confirmation, itinerary, and reservation details go to iMessage
        |
        v
Calendar events and reminders are created
        |
        v
The task mini-app, documents, costs, and status remain synchronized
        |
        v
Alpha monitors changes and updates every surface
```

## The competitive standard

HireAlpha does not beat Instinct by having more feature names. It wins only when independent users can give both products the same task and HireAlpha completes it more reliably, with less intervention and fewer unwanted actions.

### Frozen launch target

The launch comparison targets Instinct capabilities documented publicly through **2026-09-14**. Later Instinct releases enter a rolling watchlist and do not silently expand the launch scope.

| Category | Representative result | HireAlpha baseline | Launch requirement |
|---|---|---|---|
| Research and recommendations | Find suitable products, providers, stays, or appointments | Not independently measured | Visual sourced options and a justified recommendation |
| Purchasing | Order goods or tickets | Code paths exist; official run not recorded | Select, approve, pay, verify, and deliver receipt |
| Travel and reservations | Book transport, lodging, restaurants, and activities | Official run not recorded | Complete booking plus itinerary and Calendar sync |
| Appointments and paperwork | Find providers, book slots, complete forms | Official run not recorded | Verified appointment/submission and follow-up |
| Vendor communication | Request quotes, negotiate, and follow up | Drafting exists; calls/email identity incomplete | Complete a multi-turn external conversation |
| Returns and recovery | Return an order or recover a lost item | Not measured | Coordinate parties and deliver verified resolution |
| Proactive monitoring | Watch sold-out inventory or changing travel | Loop infrastructure exists; official run not recorded | Persist for days, act within policy, report changes |
| Personal context | Use email, Calendar, location, and preferences | Partial connector and memory implementation | Improve choices without leaking unrelated context |
| Multi-person coordination | Coordinate plans with other people or agents | Not supported | Safe group coordination ships in Phase 3 and is required for the Phase 5 parity claim |

The benchmark manifest, prompts, scoring rubric, retry rules, site distribution, and evidence format are versioned and frozen before the first scored run. Results are stratified by task category, website, authentication requirement, and transaction risk. No category passes with fewer than 20 independent tasks.

### North-star metric

**Verified outcome rate:** percentage of real delegated tasks that end in a provably correct external outcome without the user taking over.

### Required scorecard

| Measure | Current verified baseline | Launch threshold | Winning threshold |
|---|---:|---:|---:|
| Verified outcome rate on supported tasks | Not measured | 85% | 95% |
| Observed incorrect-success rate | Not measured | 0 in >=500 tasks | 0 in >=5,000 tasks |
| Observed unapproved consequential actions | Not measured | 0 in >=500 tasks | 0 in >=5,000 tasks |
| Median user interventions per completed task | Not measured | <=2 | <1 |
| Options with live price, image, reason, and source | Not measured | 95% | 99% |
| Resume success after credential/payment handoff | Not measured | 90% | 98% |
| Confirmation-to-iMessage delivery | Not measured | 99% | 99.9% over >=10,000 synthetic and live events |
| Confirmed booking-to-calendar synchronization | Not measured | 99% | 99.9% over >=10,000 synthetic and live events |
| Tasks recoverable after worker restart | Not measured | 100% in chaos suite | 100% in chaos suite |
| User-rated recommendation quality | Not measured | 4.3/5 | 4.7/5 |
| P95 first useful response | Not measured | <8 seconds | <4 seconds |
| P95 task-status freshness | Not measured | <30 seconds | <10 seconds |

Every comparison with Instinct must use the same prompts, dates, budgets, accounts, and scoring rubric. Blocked tasks are blocked, never counted as passes.

### Metric definitions

- **Supported task:** a task whose category, geography, risk level, required channel, and target service are included in the published support contract.
- **Verified outcome:** required real-world state confirmed by authoritative evidence defined for that task class.
- **User intervention:** any requested correction, manual takeover, repeated information, credential handoff, or approval not required by the user's standing policy.
- **First useful response:** the first message containing a grounded result, clear plan, or necessary clarification, not a reaction or typing indicator.
- **Complex task:** a request requiring at least two external operations or one operation plus persistent monitoring/synchronization.
- **Price tolerance:** zero undisclosed increase. Any higher total or material term change requires renewed selection or authority.
- **Mini-app use:** task recovery, decision completion, correction, or reference from the mini-app; opening alone is not success.

Hard invariants such as “never execute without authority” are enforced by code and security tests. Observed incident rates are reported separately with sample sizes and confidence intervals; finite trials are never described as proof that future incidents are impossible.

## Product architecture

```text
                         +-----------------------+
                         |  iMessage / SMS       |
                         +-----------+-----------+
                                     |
                                     v
+-------------+          +-----------+-----------+          +----------------+
| Mini-app UI | <------> | Canonical Task Record | <------> | Activity/receipts|
+-------------+          +-----------+-----------+          +----------------+
                                     |
                      +--------------+--------------+
                      | Plan and policy engine      |
                      +---+---------+----------+-----+
                          |         |          |
             +------------+         |          +----------------+
             v                      v                           v
     +-------+-------+      +-------+-------+           +-------+-------+
     | Research      |      | Communications|           | Browser       |
     | web/connectors|      | email/call/msg |           | execution     |
     +-------+-------+      +-------+-------+           +-------+-------+
             |                      |                           |
             +----------------------+---------------------------+
                                    |
                           +--------+---------+
                           | Authority broker |
                           +---+----------+---+
                               |          |
                          +----+---+  +---+------+
                          | Vault  |  | Payments |
                          +--------+  +----------+
```

### Canonical task record

All surfaces and workers must read and write one task model. Do not create separate truth in the Messages thread, browser job, mini-app, calendar event, or payment record.

Minimum task fields:

- User, persona, conversation, and task identifiers
- Original request and resolved constraints
- Plan version and current step
- Options with provenance, freshness, price, image, and selection state
- Required authority and granted capability identifiers
- External operations with idempotency keys
- Artifacts, confirmations, receipts, and source URLs
- Calendar/message/mini-app synchronization state
- Monitoring policy and next check
- Structured failure, retry, reconciliation, and takeover state

### Task state machine

```text
DRAFT
  -> CLARIFYING
  -> RESEARCHING
  -> WAITING_FOR_SELECTION
  -> PLANNING_ACTION
  -> WAITING_FOR_AUTHORITY
  -> EXECUTING
  -> VERIFYING
  -> SYNCHRONIZING
  -> FULFILLED
  -> CLOSED

From any non-terminal state:
  -> PAUSED_BY_USER
  -> CANCELLED
  -> FAILED_RETRYABLE
  -> FAILED_FINAL
  -> NEEDS_RECONCILIATION
  -> HUMAN_TAKEOVER

Forbidden transitions:
  WAITING_FOR_SELECTION -> EXECUTING without a selected option
  WAITING_FOR_AUTHORITY -> EXECUTING without a valid scoped grant
  EXECUTING -> FULFILLED without independent outcome verification
  NEEDS_RECONCILIATION -> automatic retry when an external side effect may have happened
```

Monitoring is orthogonal to execution state: `OFF`, `SCHEDULED`, `CHECKING`, `DEGRADED`, `TRIGGERED`, or `ENDED`. A fulfilled task can remain monitored and receive new events. Failure labels in the rescue registry are reason codes attached to a task transition, not additional top-level states.

### Task and event contract

The initial implementation uses an append-only `task_events` stream plus a versioned `tasks` projection. Every event contains event ID, task ID, user ID, schema version, event type, actor, causation ID, correlation ID, idempotency key, occurred-at timestamp, and a validated typed payload.

- The event stream owns history; the task projection owns the current queryable state.
- Writers use optimistic concurrency against the task version.
- Duplicate external callbacks and worker retries reuse idempotency keys.
- Consumers checkpoint the last event and can rebuild projections deterministically.
- Sensitive payloads store references to Vault or encrypted records, never raw secrets.
- Schema changes remain backward readable for at least two deployed application versions.
- Retention follows the underlying data class; audit receipts retain only the minimum non-secret evidence required.

### Verification policy

| Task class | Sufficient evidence | If evidence is missing or ambiguous |
|---|---|---|
| Purchase | Merchant order ID plus matching items, total, and payment status | Reconcile; never repurchase automatically |
| Reservation/travel | Provider confirmation number plus dates, party, and terms | Reconcile with provider/account before retry |
| Appointment | Provider confirmation or authoritative Calendar/portal record | Mark pending verification and contact provider |
| Phone call | Completed call record, transcript, counterparty, and agreed outcome | Report contact attempt, not task completion |
| Return/refund | Carrier/merchant return ID and refund state | Monitor until accepted/refunded |
| Paperwork | Submission receipt, case ID, or authoritative submitted state | Preserve draft and report submission uncertainty |

## Workstreams

### 1. Reliable computer execution

Goal: Alpha can navigate websites inside a published, progressively expanding compatibility contract, recover from layout changes, and finish multi-site tasks without endangering the production service.

- Move browser workers off the database host onto dedicated capacity.
- Use an isolated browser environment per task.
- Add admission control, queue depth limits, timeouts, checkpointing, and restart recovery.
- Add two-layer SSRF protection: public-origin validation across redirects plus network-level denial of private, link-local, and metadata endpoints.
- Preserve a live takeover path for CAPTCHA, MFA, and unsupported challenges.
- Store learned site procedures as hints, never as unverified executable authority.
- Require merchant confirmation evidence before completing purchases or reservations.
- Run the existing 20-task browser suite on every browser-agent release.

Exit gate: 95% pass rate across a 100-task public benchmark, zero false completions, and successful worker restart recovery.

### 2. Visual choice engine

Goal: users choose from high-quality options instead of trusting an opaque recommendation.

Each option card must contain:

- Accurate image with fallback behavior
- Current total price, taxes/fees status, and freshness timestamp
- Short recommendation reason tied to user preferences
- Material tradeoffs and cancellation/refund terms
- Direct source link
- Availability status
- Select, reject, compare, and ask-a-question actions

Research should deduplicate the same inventory across vendors, reject stale offers, identify sponsored placements, and preserve source provenance.

Exit gate: 99% of cards have valid provenance; price at selection matches checkout within a defined tolerance or triggers reapproval.

### 3. Authority, Vault, and payments

Goal: Alpha acts quickly without receiving blanket authority.

- Reuse exact-origin Vault credentials through one-time capability grants.
- Never place plaintext secrets in prompts, logs, databases, screenshots, or mini-app state.
- If credentials are absent, request them in the secure Vault view and resume the same task automatically.
- Bind purchase authority to merchant, exact total, currency, recipient, cart, and expiration.
- Support user policies such as “auto-buy household supplies under $40” while preserving transaction-specific audit records.
- If payment is unavailable, issue the Stripe flow only after checkout establishes the final total.
- Treat uncertain payment or booking outcomes as reconciliation, never automatic retry.

Exit gate: live vault autofill and Stripe lifecycle certification pass; cross-user isolation, replay, amount-change, redirect, and revocation attacks fail closed.

### 4. Communications identity

Goal: Alpha can communicate with the outside world, not only with the user.

- Give Alpha a dedicated email identity for vendor contact, forwarded receipts, account creation, and follow-up.
- Add disclosed outbound calling with transcripts, structured outcomes, and user-defined authority.
- Add WhatsApp as a user channel.
- Support email and message threads containing multiple people without leaking unrelated private context.
- Require approval for sensitive outbound content until the user grants a scoped policy.
- Label Alpha honestly as an automated assistant where required.

Exit gate: calls and emails can complete a booking workflow, failures remain visible, and every external statement is reconstructable from the audit trail.

### 5. Calendar, reminders, and monitoring

Goal: completion is not the end of the task.

- Create calendar events only from verified reservation data.
- Include confirmation number, location, source, cancellation terms, and task link.
- Deduplicate repeated confirmations and update existing events when plans change.
- Create useful reminders for check-in, cancellation deadlines, departure, documents, and payment dates.
- Monitor flight changes, reservation changes, deadlines, price/availability conditions, and vendor replies.
- Let users pause or change monitoring from iMessage.

Exit gate: repeated webhook, email, and polling events never create duplicate calendar entries or messages.

### 6. Mini-app advantage

Goal: every complex task leaves behind a useful, live visual object.

Build mini-apps from a safe component system, not arbitrary generated code. Alpha selects and configures approved components. The reusable shell and first option, timeline, receipt, budget, blocker, and activity components ship in Phase 1; travel composition proves them in Phase 2; Phase 4 expands the component catalogue.

Core components:

- Option comparison cards
- Timeline and itinerary
- Reservation and order records
- Map and route
- Budget and spend summary
- Documents and receipts
- People and vendor conversations
- Approval and blocker state
- Change history
- Monitoring controls

Mini-app updates must be event-driven from the canonical task record. They must not scrape meaning back out of iMessage or maintain a second copy of task truth.

Exit gate: a user can understand the full state of a complex trip in under ten seconds, while still completing every decision from iMessage.

### 7. Memory and personal judgment

Goal: Alpha produces better options over time without becoming invasive.

- Separate explicit preferences, inferred preferences, sensitive facts, task history, and temporary context.
- Show why a preference affected a recommendation.
- Allow correction and deletion from iMessage and the workspace.
- Apply stricter consent and retention to health, financial, precise-location, and relationship data.
- Measure recommendation lift from memory rather than memory volume.

Exit gate: remembered preferences measurably improve selection rate and satisfaction without increasing correction or deletion complaints.

### 8. One Alpha, specialized internal skills

Goal: users never need to decide which assistant can perform a task.

Keep Friend, Coworker, and Cofounder as internal behavior and permission profiles, but route requests through one primary Alpha relationship unless the user explicitly wants separate contacts.

The visible product should say “Alpha handled it,” not expose internal routing, connectors, agents, or workflow names.

## Delivery sequence

### Phase 0: make the foundation shippable, target weeks 1–3

- Provision dedicated browser-worker capacity and staging.
- Resolve all launch-readiness blockers.
- Finish SSRF defenses and dedicated session signing key.
- Complete live database, Vault, Stripe, and worker certification.
- Establish task-level traces, dashboards, alerts, and runbooks.
- Freeze new mini-app categories until browser execution is reliable.
- Publish an evidence-linked inventory of Instinct capabilities as of the freeze date.
- Run and save HireAlpha's unassisted baseline against a named 100-task readiness subset. The complete 180-task frozen comparison manifest is reserved for the Phase 5 head-to-head.
- Publish support-contract v1 defining US-only launch geography, English language, iMessage/SMS channel, supported task categories and services, and risk tiers. Calls, WhatsApp, and international transactions remain unsupported until their later phase gates pass.

Success: the named production-readiness certification has no critical gaps; 100 benchmark tasks reach at least 85% verified outcomes; 100% of forced worker terminations recover or enter visible reconciliation; the SSRF, cross-user isolation, capability replay, redirect, revocation, payment mismatch, and false-completion suites pass; and no external side effect with uncertain outcome is automatically retried.

### Phase 1: research, choose, and buy, target weeks 4–7

- Introduce the canonical task record and state machine behind feature flags.
- Build the visual choice schema and iMessage cards.
- Ship the reusable mini-app shell and core task components.
- Connect selection to the browser executor.
- Resume automatically after Vault and Stripe handoffs.
- Synchronize receipts and completion back to iMessage.
- Ship purchasing, appointment, and simple reservation benchmark packs.

Success: staff dogfood completes 100 tasks, then a 10-user pilot completes 100 tasks with at least 85% verified outcomes and no observed unapproved consequential actions. Only then expand to 50 users and 500 cumulative tasks.

### Phase 2: travel as the flagship proof, target weeks 8–12

- Add flights, hotels, transport, restaurants, activities, and itinerary composition.
- Build the trip mini-app from approved components.
- Add Calendar creation, update, deduplication, and reminders.
- Add continuous monitoring and change propagation.
- Test cancellation, refund, schedule conflict, price change, sold-out, CAPTCHA, and partial-booking paths.

Success: 100 end-to-end trips planned, at least 30 containing real purchases, with complete receipts and calendar synchronization.

### Phase 3: communication and benchmark-blocking errands, target weeks 13–18

- Launch Alpha email identity.
- Launch disclosed outbound calling.
- Begin WhatsApp provider approval in Phase 0; ship when approved and required by the frozen benchmark.
- Support only the vendor quote, return, lost-item, negotiation, and paperwork paths required by the frozen benchmark.
- Add safe multi-person threads and delegated follow-up.

Success: match every publicly documented Instinct task category with repeated independent evidence.

### Phase 4: adaptive mini-app platform, target weeks 19–24

- Generalize the trip components into task workspaces.
- Add home project, event, purchase, appointment, and work-room compositions.
- Allow task state to update mini-apps, iMessage, Calendar, and email from the same event stream.
- Add user-created authority policies with simulation and revocation.

Success: controlled tests show the mini-app reduces median decision time, intervention count, or task-recovery time by at least 20%; at least 40% of completed complex tasks also receive meaningful later use.

### Phase 5: public head-to-head launch, target weeks 25–30

- Run blind side-by-side tasks against Instinct with external testers.
- Publish raw prompts, outcomes, intervention counts, latency, and failure classifications.
- Turn the strongest outcomes into shareable receipts.
- Launch an invite loop based on completed deeds, not generic referral copy.
- Publish the trust model and incident response process.

Success: HireAlpha wins at least 70% of blind comparisons overall, at least 60% in every supported category, and loses no category on safety or control.

The target dates above are aggressive targets. The operating baseline is **36–40 weeks** for one founder directing Codex-assisted development. A 24–28 week path requires committed external capacity from Phase 0: one infrastructure/security contractor, counsel for communications and payment/privacy review, and a QA/evaluation operator before live cohorts. Phase gates, not dates, authorize progression.

| Phase | Human-team effort envelope | Codex-assisted implementation | Required parallel help |
|---|---:|---:|---|
| 0 | 6–8 person-weeks | 2–3 calendar weeks | Infrastructure/security and counsel committed |
| 1 | 8–12 person-weeks | 4–6 calendar weeks | QA operator begins benchmark operations |
| 2 | 10–14 person-weeks | 5–7 calendar weeks | Travel test users and support coverage |
| 3 | 12–18 person-weeks | 6–9 calendar weeks | Telephony/messaging specialist and counsel |
| 4 | 10–14 person-weeks | 5–7 calendar weeks | Product/design evaluation support |
| 5 | 8–12 person-weeks | 4–6 calendar weeks | Independent testers, evaluator, and support |

No more than two product workstreams run concurrently. Security and evaluation operate continuously but do not count as feature workstreams.

### Priority rule when work conflicts

1. Safety and reliability defects that block real task execution.
2. Capabilities required by the frozen competitive benchmark.
3. Mini-app components that reduce intervention or improve decisions across several categories.
4. Additional channels, connectors, categories, and cosmetic breadth.

### Ownership and capacity

| Responsibility | Accountable owner | Required capacity |
|---|---|---|
| Product, benchmark, and release gates | Founder | Daily decisions and weekly scored review |
| Agent/task platform | Founder + Codex | Primary engineering stream |
| Browser infrastructure | Founder + infrastructure contractor as needed | Dedicated worker capacity and on-call ownership |
| Security, privacy, payments | Founder + independent specialist | Review before each authority expansion |
| Calls, messaging, provider approvals | Founder | Phase 0 procurement; weekly lead-time tracking |
| Live evaluation and support | Founder plus contracted QA/support before 50-user cohort | Coverage during every pilot ramp |

Each backlog item must be converted into a ticket with owner, dependency, acceptance test, feature flag, telemetry, and rollback before implementation starts.

### Evaluation operating plan

The frozen comparison contains at least 180 category tasks: nine categories with at least 20 independent tasks each. A head-to-head run executes the same manifest against both products, producing at least 360 product-task runs per complete round.

- Recruit 20 independent testers before Phase 5; no tester scores their own authored task.
- Use two blinded evaluators for consequential or ambiguous outcomes and adjudicate disagreements.
- Budget an initial $20,000 transaction float for refundable travel, purchases, calls, and service tasks, tracked separately from engineering spend.
- Reserve six calendar weeks for execution, monitoring windows, refunds/cancellations, evidence review, and reruns caused by external outages.
- Publish exclusions, blocked results, evaluator disagreements, refunds, and product incidents with the final score.

### Unit-economics gates

Track compute, browser minutes, connector/provider fees, call minutes, monitoring checks, human takeover minutes, reconciliation minutes, refunds/credits, and support time per verified outcome and category.

- Phase 1 gate: measure full cost; no optimization target hides reliability work.
- Phase 2 gate: median variable cost below 20% of expected monthly revenue allocation per task.
- Phase 3 gate: no category launches publicly without a credible gross-margin path or explicit premium pricing.
- Pricing must reflect high-touch travel, calling, and reconciliation rather than promising unlimited expensive execution at the current entry tier.

## Error and rescue registry

| Codepath | Failure | Named state/action | User sees |
|---|---|---|---|
| Clarification | Missing or conflicting constraints | `needs_clarification` | One precise question; no action begins |
| Research | Timeout or provider rate limit | `research_retryable` | Partial verified options and retry status |
| Research | Empty/stale inventory | `no_current_options` | No fabricated cards; change constraints or monitor |
| Image retrieval | Missing or wrong image | `image_unverified` | Neutral fallback; card never borrows another item's image |
| Browser | Layout or selector failure | `browser_replan_required` | Alpha retries from current checkpoint |
| Browser | CAPTCHA/MFA | `human_takeover_required` | Secure live takeover link |
| Vault | Credential absent/revoked/wrong origin | `credential_required` | Secure Vault request, then automatic resume |
| Payment | Final total changed | `payment_reapproval_required` | New exact total and reason for change |
| External action | Timeout after submit | `needs_reconciliation` | “Outcome unknown; checking before retrying” |
| Verification | No confirmation evidence | `verification_failed` | Never claims completion |
| Calendar | Provider failure | `sync_retryable` | Booking is complete; calendar sync remains visibly pending |
| Messaging | Delivery failure | `delivery_retryable` | Mini-app/activity shows pending delivery |
| Monitoring | Queue delay or source failure | `monitor_degraded` | Last checked time and degraded status |

## Security gates

- Prompt injection content from sites, email, documents, calls, and other agents is always untrusted data.
- External instructions cannot expand tool authority or reveal user data.
- Every object lookup is scoped by authenticated user and task.
- Every consequential action has an idempotency key and an audit event.
- Network isolation denies access to internal services and cloud metadata.
- Sensitive screenshots and transcripts have explicit retention and redaction policies.
- Alpha never sends private calendar, health, relationship, or financial context to a third party unless it is necessary and authorized for the specific task.
- Cancellation and destructive actions show consequences before execution.
- Phase 0 includes counsel review for calling consent/recording, automated communications, travel/vendor terms, payment authority, privacy disclosures, deletion/retention, and support escalation obligations.
- Provider procurement tracks approval lead time, sender reputation, rate limits, geographic coverage, fallback provider, and shutdown procedure.
- Every severe incident has a named incident commander, customer-notification decision path, containment kill switch, evidence-preservation rule, and postmortem owner.

## Test program

The test pyramid for every task class:

1. Deterministic unit tests for state transitions, policy, parsing, deduplication, and price validation.
2. Integration tests with recorded provider responses for connectors, messages, Calendar, Vault, Stripe, and workers.
3. Live sandbox tests for login, checkout, payment, email, and Calendar synchronization.
4. Adversarial tests for prompt injection, cross-user access, approval replay, redirect attacks, double submission, stale prices, and compromised vendor messages.
5. Chaos tests that kill workers, delay queues, duplicate webhooks, revoke credentials, and lose network access during external actions.
6. Weekly public-site benchmark runs with immutable evidence.
7. Monthly blind human evaluation against Instinct using identical tasks.

## Observability

Every task receives one trace identifier propagated through Messages, planning, research, browser work, Vault, payments, Calendar, mini-app updates, and monitoring.

Day-one dashboard:

- Tasks by state and age
- Verified outcome rate by category and site
- Intervention and takeover rate
- False-completion count
- Unapproved-action count
- Reconciliation backlog
- Worker memory, queue depth, and task duration
- Credential and payment handoff resume rate
- Calendar and message synchronization lag
- Cost per successful task
- Top failing sites and failure classes

Page immediately on any unapproved action, suspected cross-user access, payment mismatch, false completion, audit-chain failure, or reconciliation backlog above its limit.

## Deployment and rollback

```text
Add backward-compatible schema
        -> deploy dual-write task adapter
        -> verify shadow task records
        -> enable research/choice for staff
        -> enable execution for staff
        -> enable 5% invited users
        -> 25% -> 50% -> 100%

Rollback:
disable new-task flag
        -> allow in-flight safe states to finish or pause
        -> keep old reader compatible with new schema
        -> drain/reconcile external operations
        -> revert application code only after queue is safe
```

No destructive database migration occurs in the same release as a behavior change. Each external capability has an independent kill switch.

## What already exists and should be reused

| Existing capability | Decision |
|---|---|
| iMessage/SMS agent runtime | Keep as the primary interaction surface |
| Browser job queue and agent driver | Refactor behind the canonical task lifecycle |
| Live computer takeover | Keep for CAPTCHA, MFA, and unsupported paths |
| Capability grants | Extend as the single authority broker |
| Vault v2 exact-origin controls | Keep and complete live certification |
| Stripe Link approval | Keep; trigger only after final checkout total |
| Connector execution and Google flows | Keep behind research/communication adapters |
| Memory lifecycle and index | Keep; expose preference provenance and corrections |
| Mini-app component catalogue | Reuse components; stop treating each mini-app as separate truth |
| Audit ledger | Keep; integrate with every task transition and external operation |
| Browser benchmark harness | Expand from 20 public tasks to category and chaos packs |

## Work to stop or defer

- Stop adding disconnected mini-app categories until the task lifecycle is unified.
- Do not build arbitrary AI-generated JavaScript mini-apps; use validated components.
- Do not expose three assistants as a routing requirement.
- Do not claim every connector in the catalogue works until its end-to-end action path is certified.
- Defer agent-to-agent social networking until communications, privacy boundaries, and group-task isolation are proven.
- Defer broad automatic spending policies until transaction-level approvals have zero severe incidents in production.
- Do not optimize landing-page polish ahead of verified outcome evidence.

## Failure conditions for the company plan

This strategy fails if HireAlpha:

- Measures messages, tool calls, or mini-app creation instead of completed outcomes.
- Expands feature breadth before browser reliability and staging are fixed.
- Lets mini-app state diverge from iMessage or external reality.
- Treats safety as repeated confirmation prompts instead of programmable authority.
- Claims success from model text instead of external confirmation evidence.
- Copies Instinct's autonomy while also copying its unwanted-action risk.
- Keeps adding personas when users want one responsible assistant.
- Publishes anecdotes without reproducible benchmark evidence.

## Immediate implementation backlog

Labels below express urgency, not delivery phase. Every item also names its planned phase.

- [ ] **Critical, Phase 0:** Provision dedicated browser-worker capacity and staging.
- [ ] **Critical, Phase 0:** Close SSRF and session-token security gaps.
- [ ] **Critical, Phase 0:** Complete live Vault, Stripe, isolation, backup, and load certification.
- [ ] **Critical, Phase 1:** Define and migrate the canonical task/event schema.
- [ ] **Critical, Phase 0–1:** Add task-level tracing, metrics, alerts, and reconciliation tooling.
- [ ] **High, Phase 1:** Connect the existing browser queue, approvals, Vault, and payments to the task state machine.
- [ ] **High, Phase 1:** Build the visual option schema and iMessage rendering.
- [ ] **High, Phase 1:** Add price freshness, provenance, deduplication, and reapproval logic.
- [ ] **High, Phase 1:** Implement receipt-based outcome verification.
- [ ] **High, Phase 1:** Implement automatic resume after credential and payment handoffs.
- [ ] **High, Phase 1–2:** Implement idempotent iMessage and Calendar synchronization.
- [ ] **High, Phase 2:** Build the travel component set and trip mini-app.
- [ ] **High, Phase 2:** Add monitoring policies and change propagation.
- [ ] **Next, Phase 3:** Add Alpha-owned email.
- [ ] **Next, Phase 3:** Add outbound calls with disclosure, transcripts, and outcomes.
- [ ] **Next, Phase 3:** Add WhatsApp and safe group context.
- [ ] **Next, Phase 4:** Generalize travel components into adaptive task mini-apps.
- [ ] **Next, Phase 5:** Run blind comparison trials and publish evidence.

## Dream-state delta

```text
CURRENT
Messages-first assistant with strong safety primitives, many mini-app workflows,
and unfinished production execution evidence
        |
        v
THIS PLAN
One durable task lifecycle connecting research, choices, authority, browser work,
payments, verification, Messages, Calendar, monitoring, and mini-app state
        |
        v
12-MONTH IDEAL
The most capable personal agent, with Instinct-level reach, a lower failure and
intervention rate, user-programmable authority, and a visual operating layer that
makes every delegated area of life understandable and controllable
```

## Definition of victory

HireAlpha has beaten Instinct when all of the following are true:

1. It can repeatedly complete every publicly demonstrated Instinct task category.
2. It wins a majority of blind head-to-head evaluations.
3. It produces fewer unwanted external actions and no false success claims.
4. Users need fewer interventions for successful tasks.
5. Its recommendations are easier to choose because they include visual evidence and tradeoffs.
6. Every complex task leaves behind a useful, current mini-app without requiring another workflow, and experiments show it reduces decision time, interventions, or recovery time.
7. Users can understand and change Alpha's authority, memory, and current work.
8. The evidence is public, reproducible, and based on real outcomes rather than demos.
9. HireAlpha wins at least 70% overall and at least 60% within every supported category in the frozen blind comparison set.
