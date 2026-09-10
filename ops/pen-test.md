# Penetration Test Plan

**Status up front: a third-party penetration test has NOT been scheduled.**
This document defines scope, methodology, and remediation SLAs so the
engagement can be commissioned the moment budget and timing allow. Until a
report exists with a date and a tester name, treat "we plan to pen test" —
never "we were pen tested" — as the only permissible phrasing in any
customer, investor, or partner conversation. ⚠ AUDITOR: an auditor will ask
for the report or for the documented decision to defer; this file plus the
risk register (VM-2) is that documentation.

## Scope

In scope:

1. **Web application** — hirealpha.chat, the Bun-served app
   (`deploy/web-server.ts`): static surface, public API (`/api/waitlist`,
   `/api/public/*`, the agent-ready surface: `llms.txt`, `openapi.json`,
   markdown content negotiation), authenticated surfaces, billing webhooks
   (`/api/billing/webhook`), and the certification/test API boundary if
   exposed.
2. **iMessage bot flows** — the full lifecycle: signup and number assignment
   (`registerPhotonUser` path in `deploy/hire-api.ts`), inbound message
   parsing (prompt-injection surface), outbound draft approval ("drafts never
   send without approval"), the proactive loops, and any webhook/callback
   entry points Photon uses. The tester should attempt to send messages,
   spend, or act as another user purely via message content.
3. **Trust APIs and agent capability system** — everything under
   `/api/trust/*` (`services/trust/trustApi.ts`), capability grant/decision/
   consumption flows, the digest mechanism, and the vault endpoints.
4. **Browser task pipeline** — task creation, approval gating, credential
   injection (`consumeVaultCredential` path in `deploy/browserWorker.ts`),
   payment handoff (Link one-time credential, `hire_spend_approvals`
   finalization), and the E2B sandbox boundary.
5. **The single VPS perimeter as observable from outside** — exposed ports
   and services on the Hetzner host, Coolify proxy behavior, header hygiene.
   (Deep internal testing of the VPS itself is coordinated separately with
   the founder; see out of scope.)

Out of scope:

- Denial-of-service and volumetric load testing (single-server deployment;
  risk register R-09).
- Social engineering of the founder or contractors, phishing simulations,
  and physical attacks. The people-layer risk is real (R-04) but is managed
  through the MFA and access reviews in `access-control.md`, not pen testing.
- Production data destruction or modification: the tester must use dedicated
  test accounts and must not execute real payments beyond the explicitly
  sanctioned micro-amount test purchases against the tester's own Stripe
  test/limited accounts.
- Attacking third-party vendors (Photon, GMI, E2B, Stripe, Hetzner
  infrastructure) — their security is a vendor-management matter
  (`ops/vendors.md`), not the engagement's target. Merchant sites visited by
  agent tasks must never be attacked; agent-driven tasks during the test
  should target tester-controlled pages only.
- Any form of persistence or backdoor installation on the VPS.

## Methodology

The engagement should follow a standard phased approach, with the
HireAlpha-specific checks below as named, non-optional test cases. The value
of a pen test here is not generic scanning — it is whether the tester can
break the specific architectural fences the product depends on.

1. **Recon.** External footprint: DNS, subdomains, exposed services,
   certificate posture, the public API surface (including what
   `openapi.json` and `llms.txt` advertise), error-message leakage, and
   version fingerprinting.
2. **Authentication and session.** Session issuance and validation
   (`SESSION_SIGNING_SECRET` scheme), session fixation and replay, auth
   boundary bypass attempts on all `/api/*` routes (the repo has
   `deploy/authBoundary.test.ts` — the tester should try to beat what it
   asserts), webhook signature validation on the Stripe endpoint
   (`STRIPE_WEBHOOK_SECRET`), and rate-limiting behavior on auth and
   messaging endpoints.
3. **Authorization / IDOR on user-scoped endpoints.** Every user-scoped query
   in the codebase filters by user (`WHERE user_id = ...` throughout
   `deploy/hire-api.ts` and the trust layer). The test must systematically
   attempt cross-user reads and writes on: trust APIs (memory export,
   deletion, vault), capability decisions (the decision endpoint matches on
   `id` + `user_id` + `task_id` + digest — try to decide or consume another
   user's grant), browser jobs and spend approvals (`hire_browser_jobs`,
   `hire_spend_approvals`), draft approval, and the referral/invite system.
   Where an ID is a UUID, testers should not accept "unguessable" as a
   control — the server-side user scoping is the control.
4. **Capability digest tampering.** The digest (`capabilityRequestDigest` in
   `services/trust/capabilityGrants.ts`) is a SHA-256 over the canonical
   request with fixed key ordering; consumption is fenced by it
   (`beginCapabilityConsumption` matches on `request_digest`). The tester
   should attempt: digest recomputation with modified scope fields (amount,
   origin, recipient), replay of a consumed digest, decision of an expired
   or already-decided grant, and consumption after revocation or expiry.
5. **SSRF via browser task URLs.** `deploy/browserNetworkPolicy.ts` enforces
   HTTPS-only targets, bans embedded credentials, blocks local/internal
   hostnames, and resolves DNS against a private/reserved IP blocklist —
   re-checked per request after redirects (`installBrowserNetworkPolicy`).
   The tester should attempt: DNS rebinding, redirects from public to
   private targets, IPv6-mapped IPv4 evasion, decimal/octal/hex IP
   encodings, `data:`/`blob:`/`about:` navigation abuse, and
   `.localhost`/`.internal`/`.local` variants. The control's own comment
   says the network firewall is the final enforcement layer and this guard
   is user-facing error clarity — the test should determine what actually
   blocks what.
6. **Prompt injection and agent abuse.** Page-controlled content attempting
   to: trigger purchases or message sends without approval, exfiltrate
   injected credentials to an attacker page, navigate to attacker
   infrastructure, or abuse the payment handoff (e.g., mismatched merchant
   display vs. checkout host — the code checks declared vs. actual merchant
   in `stageLinkPaymentHandoff`; attempt to defeat that). Also test the
   success-signal guard: `hasMerchantOrderConfirmation` exists to stop
   false "order placed" claims — attempt to forge a merchant confirmation.
7. **Injection and data handling.** SQL injection across the parameterized
   query surface (Bun SQL tagged templates — verify no string-built SQL
   exists outside the reviewed `unsafe` usage in `deploy/migrate.ts`),
   stored XSS via message content/drafts rendered in web surfaces, and
   path traversal in static file serving (`serveStatic`).
8. **Cryptographic review (light).** The envelope format
   (`v2.iv.tag.ciphertext` with AAD binding user/record/scope in
   `services/trust/userKeyBroker.ts`): verify AAD actually prevents
   ciphertext swapping between users/records/scopes, IV uniqueness under
   load, and that the legacy v1 vault path (`HIREALPHA_VAULT_KEY`) cannot
   downgrade trust flows.
9. **Reporting.** Findings rated by severity with reproduction steps;
   retest of fixed findings included in the fee.

## Remediation SLAs

Measured from the report date (or earlier discovery):

| Severity | Fix deadline | Notes |
|---|---|---|
| Critical (RCE, auth bypass, cross-user data access, key/secret exposure) | **7 days** | Severe enough → treated as a SEV-1 under `incident-response.md` immediately on discovery |
| High (SSRF bypass, capability fencing bypass, injection in a privileged path) | **30 days** | |
| Medium (defense-in-depth gaps, missing rate limits, header hygiene) | **90 days** | |
| Low / informational | Best effort or documented-accept | Each acceptance written down with a reason |

A finding that would invalidate a claim made in this `ops/` package (for
example, breaking the capability digest or the audit chain) also triggers a
same-week update to the affected ops documents — the docs and the code are
versioned together on purpose.

## Commissioning checklist (when scheduled)

1. Pick a tester with demonstrated web + OAuth + agent/automation experience;
   brief them with this file, `ops/risk-register.md`, and read access to the
   repo architecture docs.
2. Provide two test accounts (one "attacker," one "victim") and a funded
   Stripe test-mode setup; agree micro-payment limits in writing.
3. Freeze the window: tester gets a stable build; note the commit SHA tested.
4. On report: triage within 3 days, assign owners per SLA, retest, then file
   the final report alongside this document and update the control matrix
   (VM-2 → BUILT) with the report date.
