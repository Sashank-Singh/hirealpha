# HireAlpha Launch Kit

Everything below is copy‑paste ready and grounded in what the product actually
does today. Read `00-facts.md` first — every promise in this kit maps to a real
feature, and the constraints at the bottom are non‑negotiables.

## Contents

- `00-facts.md` — the verified feature/pricing sheet + the only facts you may use
- `01-show-hn.md` — Hacker News "Show HN" post + replies to prep
- `02-product-hunt.md` — Product Hunt launch: tagline, first comment, images
- `03-x-threads.md` — a week of X/Twitter threads, all built on real screenshots
- `04-communities.md` — Reddit/Discord/HN-native posts (no links in some places)
- `05-launch-day-checklist.md` — the order of operations for one big day

## Before you post anywhere — 30-minute setup

1. **Analytics on**: create your site at https://plausible.io with domain
   `hirealpha.chat`. The homepage snippet already points at it, so pageviews and
   the custom events (`waitlist_joined`, `checkout_started`, `share_clicked`,
   `invite_copied`) start landing under Goals → Custom events. 10 minutes.
2. **Email on**: `resend.com` → add audience "HireAlpha waitlist", copy
   `RESEND_API_KEY` + `RESEND_AUDIENCE_ID` into your production env. New signups
   sync automatically. Then run the backfill:
   `RESEND_API_KEY=... RESEND_AUDIENCE_ID=... DATABASE_URL=... bun scripts/sync-waitlist-resend.ts`.
   Build two broadcasts in the Resend dashboard: the soft "we exist" email and
   the launch-day "your number is ready / hire Alpha now" email. Send the soft
   one 2–3 days *before* launch day so the launch email lands in a warm inbox.
3. **Checkout live**: verify the Friend hire's Stripe checkout works end to end
   with the $5 promo and trial. Do this with a test card, not a real user.
4. **Screenshots**: take 3 real iMessage screenshots (ask the user for
   permission, redact names). Waitlist is live but the product is live too — the
   strongest asset is *actual* texts, not renders.

## The one-line positioning (use it everywhere)

> HireAlpha is where you **hire people, not download another app**. Three AI
> contacts with their own numbers and personalities — Friend, Coworker,
> Cofounder — who text you like they know you. Friend is live now. $19/mo.

## Honesty rules (do not break these)

- Friend is a companion, never a replacement for a therapist or for real
  people. Never imply it fills a grief or mental-health gap.
- Drafts never send without approval — say that; it is a differentiator.
- Coworker and Cofounder are "in the workshop" until they actually ship.
- "Waitlist" is real: joiners get a number and the hire texts first.
- Do not compare to or trash competitors by name in public. Compare the
  category honestly ("most of these are closed waitlists; ours is live").