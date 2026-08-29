# 05 — Launch day checklist

Work backwards from a Tuesday (newscycle peaks Mon–Thurs; avoid Fridays).

## T-minus 3 days
- [ ] Plausible site created for `hirealpha.chat`; homepage snippet confirmed live
- [ ] Resend audience + API key live; backfill run; 2 broadcasts built
      ("soft launch" email → send now; "your number is ready" → launch day)
- [ ] Stripe friend checkout verified with a test card: $5 promo, 7-day trial,
      downgrade/upgrade path, cancel flow
- [ ] 3 consented, redacted screenshots collected; uploads staged
- [ ] Show HN + Product Hunt + X drafts final; pin date

## T-minus 1 day
- [ ] Product Hunt page assembled, first comment written, launched at 00:01 PT
- [ ] Rehearse the answer to "another chatbot / wrapper?" — memory + three
      separate hires + approve-before-send + live-now-vs-waitlist
- [ ] Alert test: confirm `/healthz` and one checkout in prod

## Launch day
- [ ] 00:01 PT — Product Hunt goes live with the pinned first comment
- [ ] 05:00 PT — Show HN post goes up
- [ ] 05:30 PT — soft email: "HireAlpha is live, Friend texts first"
- [ ] 06:00 PT — Day-1 X thread + post to your primary community
- [ ] All day — reply to every comment on every platform < 1 hour
- [ ] Text every waitlist phone whose member already joined: ask what they want
      Alpha to handle first (the highest-converting move, free)

## Day after
- [ ] Thank-you comment on PH + "what broke/what stayed" update
- [ ] Pull analytics: sessions, waitlist_joined, checkout_started
- [ ] Look at Stripe: trials started, conversions. The only three numbers that
      matter for week 1: visits → waitlist joins → paid trials.
- [ ] Decide: which 2 channels produced signups? Double those, kill the rest.

## Week 1 metrics to watch
- Visits (Plausible), waitlist joins vs visits, checkout starts vs waitlist,
  trial → paid (Stripe). Anything below ~20% visits → waitlist on a strong
  post means the landing page is losing people — test the headline next.