# Vendor & Subprocessor Inventory

Every third party that receives HireAlpha customer data, or could receive it
incidentally, is listed here. This inventory is the data-sharing source of
truth referenced by the ROPA draft in `gdpr-ccpa-checklist.md`.

Two honesty rules apply. First, where a data processing agreement has not been
obtained and signed, the DPA column says **DPA: NOT SIGNED** — it is not
inferred from the vendor's size or reputation. Second, regions are recorded as
known today; a vendor that moves data across regions without notice is a
finding for the quarterly review, not something this table should paper over.

⚠ COUNSEL applies to the whole table: whether each vendor is a "subprocessor"
in the GDPR sense, a "service provider" or "contractor" under CCPA, and whether
any data flow constitutes a "sale" or "share" under CCPA are legal
determinations that have not been made by counsel. The engineering facts (what
is sent, to whom, under which key) are as verified from the code.

| Vendor | Purpose | Data shared | DPA status | Region |
|---|---|---|---|---|
| Photon / Spectrum | iMessage/SMS delivery infrastructure; phone number registration for hires (`registerPhotonUser`, `PHOTON_PROJECT_ID` in `deploy/hire-api.ts`) | User's phone number and name (bound to the assigned hire number); message content transits the messaging platform | DPA: NOT SIGNED | US (to verify) |
| Coolify on Hetzner VPS (`vmi2997871`) | Hosting control plane and server for the web app, bots, browser worker, Postgres, OpenBao, and Plausible | All application data resides here; Coolify holds environment variables including `DATABASE_URL`, `OPENBAO_TOKEN`, `STRIPE_SECRET_KEY` | DPA: NOT SIGNED (Hetzner offers a DPA — obtain it) | Hetzner datacenter region to verify (see transfer notes in `gdpr-ccpa-checklist.md`) |
| GMI Cloud | LLM inference for the bots and agent-driven browser tasks (`GMI_API_KEY`, `GMI_BASE_URL` default `api.gmi-serving.com/v1` per `deploy/hire-api.ts`) | Conversation content, task context, page content during agent browsing; per the privacy page, sent "under agreements that prohibit training on it" — ⚠ COUNSEL to obtain and verify that agreement | DPA: NOT SIGNED | US |
| DeepSeek (via GMI) | Underlying model family served through GMI (`deepseek-v4-flash-exp` references in `deploy/hire-api.ts` model config) | Same inference payloads as GMI; subcontractor layer under GMI — reachability and terms to verify via GMI | DPA: NOT SIGNED | US (via GMI; to verify) |
| Stripe | Billing: subscriptions, trials, checkout, the Link one-time payment credential flow (`deploy/userPayments.ts`, webhook at `/api/billing/webhook`) | Email, name, billing address as collected by Stripe; card data stays with Stripe (HireAlpha never sees PANs — the Link card exists only inside the browser worker's memory at checkout) | Stripe's standard DPA terms apply to the account by default — obtain the signed copy for records; verify whether SCCs are needed | US (to verify) |
| Composio | Connector OAuth and tool integrations (`deploy/composioPlugins.ts`) | OAuth tokens for connected tools on the user's behalf; scoped to making the hires work, revocable per the privacy page | DPA: NOT SIGNED | US (to verify) |
| DuckDuckGo | Last-resort web search backend: the worker fetches and parses DuckDuckGo HTML results (`deploy/webSearch.ts`) | Search queries derived from user tasks; no direct user identifiers sent by HireAlpha — incidental processing | DPA: NOT SIGNED (likely unnecessary for a public search query; ⚠ COUNSEL to confirm characterization) | US (to verify) |
| E2B | Sandboxed browser execution environments; every production browser task runs in a fresh E2B sandbox (`deploy/e2bExecutor.ts`, `E2BTaskEnvironmentProvider`, `task_environments` table) | Task page content and session activity inside the sandbox; credentials are injected at task time and not persisted by the sandbox by design | DPA: NOT SIGNED | US (to verify) |
| OpenBao (self-hosted) | Transit key management for per-user AES-256-GCM data keys (`services/trust/userKeyBroker.ts`, key `hirealpha-user-deks`); self-hosted on the same VPS, so it is infrastructure rather than an external subprocessor | Plaintext keys exist only in transit responses within the VPS; OpenBao never receives customer content | N/A — self-hosted | Same VPS (`vmi2997871`) |
| Plausible (self-hosted, Community Edition v3.2.1) | Cookieless web analytics for hirealpha.chat, self-hosted per `deploy/plausible/README.md` with its own Postgres and ClickHouse, separate from the HireAlpha database | Page visits (no cookies, no cross-site identifiers); not customer trust data | N/A — self-hosted | Same VPS (`vmi2997871`) |
| 1Password (optional) | Optional backing store for the credential vault: when `OP_SERVICE_ACCOUNT_TOKEN`/`OP_VAULT_ID` (or Connect) is configured, saved credentials live as LOGIN items in the user-chosen vault and `hire_vault_entries` keeps only an opaque `op1p:` reference (`deploy/onePassword.ts`) | User-saved credentials, if the user opts into the 1Password connector; otherwise no data leaves the VPS (local AES-256-GCM fallback) | DPA: NOT SIGNED (1Password offers standard terms — obtain if the connector ships) | Vendor-managed (region per 1Password account; to verify) |
| Google (Gmail, Calendar) | OAuth API access on the user's behalf for mail and calendar features (`deploy/gmailHelpers.ts`, `deploy/calendarEvents.ts`) | The mail and calendar data the user connects; access tokens scoped and revocable | Governed by Google's API terms + OAuth consent; restricted-scope verification status to be recorded | Vendor-managed (global) |
| Apple (iMessage platform) | Delivery channel for all bot conversations | Message content between the user and each hire transits Apple's messaging infrastructure | No direct agreement possible; platform terms apply | Vendor-managed (global) |

## Subprocessor review checklist (quarterly)

1. Re-run the data-flow walk: grep for outbound HTTP destinations in
   `deploy/` and confirm every destination appears in this table.
2. For each "DPA: NOT SIGNED" vendor, record either a signed DPA or a
   documented decision (with counsel) that no DPA is required for that flow.
3. Confirm region claims against vendor dashboards and the transfer analysis
   in `gdpr-ccpa-checklist.md`.
4. Remove vendors no longer in use and note the removal date; the audit trail
   for vendor removal is this file's git history.
