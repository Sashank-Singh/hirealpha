# GDPR / CCPA Checklist

This is a working checklist, not a compliance claim. Each item states what
exists, what is missing, and who owns the decision. Items tagged ⚠ COUNSEL
require a lawyer's determination before the underlying claim is made anywhere
customer-facing; ⚠ AUDITOR items are what a reviewer will ask for first. The
phrase to keep in mind throughout: control exists in code — operating
evidence: not yet collected.

## GDPR side

### ROPA (Article 30 record of processing activities) — draft

⚠ COUNSEL review required before treating this as the ROPA. The vendor column
cites `ops/vendors.md`, which holds the verified data flows. Categories are
drawn from the actual tables, not from a template.

| Processing activity | Purpose | Data categories | Lawful basis | Recipients (see vendors.md) | Retention (see retention-schedule.md) |
|---|---|---|---|---|---|
| Account provision | Provide the hires as contacts | Phone number, name, signup email | Contract | Photon/Spectrum; Apple (delivery) | Life of account |
| Conversations and memory | Let hires remember the user across threads | Message content; consented memory categories (identity, preference, relationship, work, health, financial, other) in `memory_records` | Contract (core) + Consent (per memory category — see below) | GMI Cloud / DeepSeek (inference) | Per-category caps, 30–365 days |
| Health-style logging | Friend's tracking features | Nutrition, workouts, sleep, moods (`hire_nutrition_logs`, `hire_workouts`, `hire_sleep`, `hire_moods`) | Contract | GMI (macro estimation per `deploy/hire-api.ts`) | Until account deletion |
| Spending tracking | Friend/Cofounder financial context | Amounts, categories, descriptions (`hire_spending`, budget) | Contract | None beyond hosting | Until account deletion |
| Agentic browsing | Perform approved tasks on the web | Task instructions, page content, session activity (`hire_browser_jobs`); credentials used at task time from `vault_items_v2` | Contract | E2B (sandbox); DuckDuckGo (search queries) | See retention schedule |
| Payments | Billing and one-time purchases | Email, name, billing data (Stripe-side); `hire_spend_approvals` metadata | Contract | Stripe; Link (payment credential) | Stripe: legal hold; approvals: see schedule |
| Security evidence | Detect/abuse-response, user-visible activity log | Pseudonymized `audit_events` per user | Legitimate interest (security) ⚠ COUNSEL to confirm | None (self-hosted) | Indefinite by design (README discrepancy 1) |
| Analytics | Understand site usage | Cookieless page events | Legitimate interest ⚠ COUNSEL (Plausible's cookieless model is commonly run on legitimate interest; confirm) | Plausible (self-hosted) | Plausible default retention |
| Marketing site | Waitlist, launch content | Contact details from waitlist | Consent ⚠ COUNSEL | None | Until used or withdrawn |

### Lawful bases — per processing activity

- **Contract (Article 6(1)(b))** for the core service: account provision,
  conversations, logs, agentic tasks, billing. This is the straightforward
  case — the data exists to deliver what the user bought.
- **Consent (Article 6(1)(a)) for memory categories.** The code treats memory
  as consent-gated, not contract-gated: `storeConsentedMemory` refuses to
  store unless an active `consent_records` row exists for the exact category
  and purpose (`services/trust/memoryLifecycle.ts`), consents carry
  `consent_version` and `source` (migration
  `202609090009_consent_version_source.sql`), and can be revoked
  (`revokeMemoryConsent`). ⚠ COUNSEL: confirm consent is the right basis
  (versus contract) for the sensitive-adjacent categories — health and
  financial memories in particular — and confirm the UI presents withdrawal
  as easily as granting (Art. 7(3)).
- **Legitimate interest (Article 6(1)(f))** candidates: `audit_events`
  security evidence, cookieless analytics. Each requires the documented
  balancing test (LIA). ⚠ COUNSEL: no LIA has been written yet — that is a
  gap, and the honest current status is PLANNED.

### DPIA — required or not? (determination, not yet analysis)

The question: does the AI assistant + browser automation combination require a
Data Protection Impact Assessment under Article 35?

Arguments that it does: systematic processing of personal data at scale;
automated agents acting on the user's behalf across third-party sites;
inference by third-party models; credential handling; the memory system
touches health and financial categories (Art. 35(3)(b) territory when
large-scale).

Arguments that it might not (yet): one-user-at-a-time processing, no
systematic monitoring of public spaces, no automated decision-making with
legal effect, encryption-first design, per-user scope.

**Determination recorded here: a DPIA is treated as REQUIRED, on the
conservative reading, before scaling beyond early access.** ⚠ COUNSEL to
confirm and to define scope. Current status: PLANNED (no DPIA analysis exists
yet — control matrix PG-3). The pieces that would feed it already exist:
this ROPA draft, `ops/risk-register.md` (R-03, R-06), and the
`browserNetworkPolicy.ts`/capability-digest architecture descriptions.

### International transfer notes

- **Hetzner VPS (`vmi2997871`)**: the datacenter region must be recorded in
  `ops/vendors.md` (currently "to verify"). If the VPS is in the EU/US
  boundary matters for EU users, the answer changes the transfer analysis.
- **GMI Cloud (US)**: conversation content and task page content are
  processed in the US. Transfers need a mechanism (SCCs or a covered
  framework) — currently **DPA: NOT SIGNED** in vendors.md, which means the
  transfer tooling does not exist on paper yet. ⚠ COUNSEL — this is the
  single most likely GDPR transfer finding.
- **Stripe, E2B, Composio, Photon**: same pattern — US-processed, DPAs not
  signed. The fix is mechanical (obtain signed terms per vendor) but not done.
- Self-hosted OpenBao, Plausible, and the Postgres instance keep those data
  flows on the VPS itself, which shrinks the transfer surface to exactly the
  vendor list above.

## CCPA side

### Notice at collection

The privacy page (`public/pages/privacy.html`) serves as the notice: it
describes what is stored (connected Google data, logged sleep/food/training/
spending, people, promises, decisions, pipeline), why ("to make your personas
useful to you"), the retention promise (deletion within 30 days of account
deletion — note the gap analysis in `dsar.md` before relying on this), and
contact via hello@hirealpha.chat. ⚠ COUNSEL: a CCPA-compliant notice at
collection has specific required elements (categories, purposes, retention
per category, rights list); the current page is a strong plain-English
summary, not yet a verified statutory notice.

### Do-not-sell statement

**HireAlpha does not sell personal information.** The basis: the privacy page
states "We never sell or rent your personal data," and no code path sells,
licenses, or shares data for cross-context behavioral advertising — there is
no advertising infrastructure, no ad SDK, no data broker integration, and the
business model is subscription only (per
`marketing/launch-kit/00-facts.md`: "No ads; no free tier that reads your
data"). This is an engineering fact plus a legal conclusion; the legal
conclusion needs ⚠ COUNSEL sign-off (specifically, that the GMI/DeepSeek
inference flow is a service-provider relationship, not a "sale" or "share").

### Sell/share determination

- **Sale: NONE.** No monetary or other valuable consideration flows in
  exchange for personal information.
- **Share (cross-context behavioral advertising): NONE.** No such processing
  exists.
- **Service-provider relationships to verify under contract:** GMI Cloud,
  E2B, Composio, Photon — each must actually hold service-provider terms
  (the "agreements that prohibit training" promised on the privacy page) for
  the determination to hold. All are "DPA: NOT SIGNED" today in
  `ops/vendors.md`.

### Rights intake

CCPA rights (know/access, delete, correct, opt-out of sale/share, limit use
of sensitive PI) are intake-handled through the same channels as the GDPR
DSAR flow: email to hello@hirealpha.chat and the in-product endpoints —
documented in `ops/dsar.md`, with the 45-day CCPA SLA. Two CCPA-specific
notes: (1) the "limit use of sensitive personal information" right is
probably inapplicable because HireAlpha does not use sensitive PI for
inference beyond what the user directed — ⚠ COUNSEL to confirm; (2) the
non-discrimination promise (no worse service for exercising rights) should be
added to the notice at the next revision.

## Close-out order (suggested)

1. Vendor DPAs / service-provider terms (vendors.md NOT SIGNED items) —
   mechanical, highest leverage. ⚠ COUNSEL.
2. Full account deletion automation (closes the privacy page's biggest
   promise gap — `dsar.md` gap 1).
3. Backup reality check (unblocks the retention disclosures).
4. LIA write-ups for audit_events and analytics; consent-flow review for
   health/financial memory categories.
5. DPIA analysis before growth marketing scales the user base.
