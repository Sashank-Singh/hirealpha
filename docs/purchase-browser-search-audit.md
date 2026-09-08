# Purchase, cloud browser, and web search acceptance

Checked September 7, 2026 (Pacific). Status: incomplete; no production deployment or purchase performed.

## Verified and changed

- Live DuckDuckGo calls returned Apple event sources and an Amazon 5 lb jasmine rice product page. This proves local network search, not the deployed iMessage path or current checkout prices.
- The live API handler and service helper now share `deploy/webSearch.ts`. Organic links are normalized, ad redirects are excluded, and titles and snippets are retained. HTML failures fall back to DuckDuckGo Lite within a bounded request budget. Total failure returns an explicit unavailable message, never a fabricated search result.
- The conversation loop now retains freshness context for affirmative follow-ups, requires a web attempt separately from other tools, and blocks an unsupported final answer when the model ignores its search correction. Three regression tests failed before this change and passed afterward.
- The web Dockerfile includes the new search module. The web build and bot/API bundles passed. Lint completed with existing warnings.
- Final isolated full-suite run: `COMPOSIO_API_KEY='' npm test` — 1,175 passed, zero failed. An earlier unrestricted rerun had two Composio/mail timeouts; the search regression checks passed in both environments. An initial full run before adding the Lite fallback test passed 1,174 tests.
- The public production `/healthz` returned HTTP 200 (`ok`). This is web-server liveness only; it does not prove the browser worker, Link flow, or deployed revision.

Live evidence is in `artifacts/capability-audit/live-search.json` and `artifacts/capability-audit/rice-with-fallback.json` (local, ignored artifacts). The first rice call timed out; the subsequent call with fallback returned organic results. Search snippets can contain old promotions and do not establish a final price, taxes, shipping, or inventory.

## Link purchases — not accepted

Link's documented agent flow supports one-time payment credentials and user-approved spend requests: https://link.com/agents . The current HireAlpha purchase endpoint instead creates a Stripe Checkout payment using the product name and amount; that is not an Amazon merchant checkout or proof of an order.

The Link CLI reports unauthenticated on this machine. A local developer authentication would not itself connect each HireAlpha user's wallet on the server. Do not substitute one developer wallet for all users.

Acceptance requires user-isolated wallet authentication; merchant checkout inspection; final total including taxes and shipping; Link approval; secure credential use in that checkout; verified merchant order receipt; and denial, expiry, challenge, and uncertain-payment handling without duplicate orders. No payment test was attempted.

## Cloud computer — not accepted

`Dockerfile.worker` builds a headless Playwright/Chromium container, not a visible desktop. The examined worker requires saved portal credentials, including for public tasks, and the session calls the login routine before agent execution. No desktop stream or viewer was found in this repository. The Friend handler examined during this audit explicitly rejected browser draft delivery. Other browser queue and routing changes were concurrently present and have not been production verified by this audit.

No callable Coolify MCP tool was available. The repository's default SSH destination rejected the available authentication. The Coolify dashboard URL and browser application/server identity have been requested. Do not provision duplicate infrastructure before inspecting the existing deployment.

Acceptance requires identifying the deployed worker/VM; showing an authenticated live session; completing a public browsing task without saved credentials; completing an approved interactive task; handling login/challenge handoff; returning evidence to the originating iMessage thread; and verifying cancellation, isolation, cleanup, approval enforcement, and no duplicate side effects after a failure.

## Definition of 100/100

Each feature reaches 100 only when all its acceptance checks pass in the actual deployed user flow, with recorded evidence. Local unit tests, a compiled bundle, a model's claim, and a queued job do not constitute end-to-end completion. Search additionally needs the deployed iMessage original request and "Yes" follow-up tested, sources opened and checked, and unavailable-search behavior verified. Universal success on every third-party website is not established by these checks.

The immediate external blocker is access to the existing Coolify deployment. Link connection and a specific approved test purchase will be needed for payment acceptance after the merchant checkout integration is ready.
