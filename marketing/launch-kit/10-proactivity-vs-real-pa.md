# Alpha proactivity vs a real personal assistant

Honest comparison. A great human EA (think the folks handling logistics for a CEO at a $50M fund) does 6 categories of work. Scoring is on the same 1–10 scale as the proactivity backlog: value to the person × how often it lands well × annoyance if wrong.

## What a $200/hr EA does that a phone-based AI friend cannot (or could but we haven't built yet)

1. **Hold a calendar that survives the user** — they hand you their week and you protect it from collision-creep. EA: 9. Phone AI today: 3 (the brief is reactive; doesn't yet pre-empt or block a conflicting meeting invite).
2. **Pre-flight prep for every meeting** — a 1-page note 5 min before, tailored to who they are about to sit with. EA: 9. AI: 2 (partial, in onboarding_minutes/standup_paste mini-app).
3. **Triage your inbox and decide** — EA marks or deletes mail without asking you. AI: 2 (read-only, you still pick what's important).
4. **Make reservations and calls on your behalf** — EA: 9. AI: 1 (text only, no outbound action).
5. **Catch the small thing that prevents the next disaster** — EA notices a pattern and says it. AI: 6 (the cross-domain silence and streak-end are early versions of this).
6. **Remember the throwaway, surface it later** — EA: 10. AI: 4 (long-term memory exists, retrieval is not yet contextual).
7. **Filter the social calendar** — EA tells the user which invites to decline. AI: 2.
8. **Manage vendors and recurring admin** — EA negotiates. AI: 1 (drafting only).
9. **Hold an emotional temperature** — EA reads when the user is at a low and adjusts the day. AI: 5 (cross-domain quiet is the start).
10. **Discreet triage of the user's social life** — EA knows who matters to whom. AI: 3 (network has cadence, but no judgment).

Real EA: 10/10, 9/10 on most lines, ~80/100 across the ten. Alpha today: ~25/100 — the breakfast and bedtime-friend layer, not the working-day triage layer.

## Where Alpha wins against the human

1. **Always there** — never sleeping, never at a wedding, never a vacation week. 10.
2. **Knows your data** — meals, sleep, spending, mails, contacts. EA reads what you forward. 9.
3. **Doesn't judge** — EA can wince; AI never does. 10.
4. **No social cost** — you can text at 2am with a stupid question. 10.
5. **Runs on the signal, not the social** — the EA's hardest work is "do I tell them this, or is it just noise?" AI can be tuned to never do social-touch work; the human can't. 8.
6. **Cheap to repeat** — a quick daily check-in that the user would never call a $200/hr human for. 10.
7. **Cross-domain pattern detection** — the EA's blind spot is "your habit streak broke, you skipped sleep three nights, and your spend spiked in the same week" because the EA's pattern detection is in their head, not a query. AI can do this and never forget. 9.
8. **Privacy to say anything to** — the "I cheated" reframe. 10.

Where the AI dominates: roughly half of "always there / never judges" plus most of "cross-domain pattern." Where the human dominates: every line that requires judgement on a person, discretion with a stranger, or a real-time body-language read.

## The "older sibling" line we keep repeating

The framing is honest: a good older sibling doesn't run your calendar. They notice the throwaway, the change in tone, the birthday that you forgot. They text "you went quiet this week, everything ok?" and mean it. They do not make your calls. They also do not write a daily essay; they text "dude, sleep." That is the band the 100-idea backlog targets, and the per-day touches the founder picked sit in that band.

## What we just shipped maps to this band

- Morning brief: 9 (a real PA does this).
- Sleep-gated morning: 9.
- Birthday reminder: 9.
- Streak ended: 9.
- Trial ending: 8.
- Bill went up: 8.
- "You went quiet" cross-domain: 8 (this one is the human-EA replacement).
- "What would you tell your best friend" (decision spiral): 9.
- "That was a meal, not a crime": 9.
- "Call a real person" when lonely: 8.
- Flight tz retime: 8.

What is NOT shipped, and which the EA would do, and which we should build next:

- **Calendar triage and hold** — pre-flight meeting notes, conflict detection. 9 if we build it. (Human EA is currently the only way to get this reliably.)
- **Triage and draft mail** — read-only now, draft-only. To move from 2 to 7, we need action-taking with confirmation.
- **Reservations / calls / vendor actions** — these need an action layer with a confirmation step. Out of scope for a phone-friend MVP; high cost if wrong.
- **Long-term memory that surfaces unprompted** — we have storage, retrieval is the gap. 10 if we build a good "what I remember about you" prompt into the per-turn context.
- **Per-person personality tuning** — the 100-idea backlog implicitly assumes one EA. A real EA reads the user. The next product layer is "who is this user, what matters to them, what should I default to" — that is the difference between an AI that feels kind and an AI that knows the user.

## Score summary (out of 100)

| Layer | Real EA ($200/hr) | Alpha today | Alpha with the next batch shipped |
| --- | --- | --- | --- |
| Calendar control | 90 | 25 | 45 |
| Mail triage + draft | 85 | 20 | 45 |
| Spending + admin | 80 | 30 | 60 (trials + bill) |
| People + relationships | 90 | 35 | 65 (birthdays + cross-domain) |
| Health + body | 70 | 35 | 55 (sleep) |
| Career + work | 80 | 25 | 45 |
| Learning + growth | 60 | 15 | 20 |
| Emotional + admin | 85 | 35 | 70 (the reframes batch lands here) |
| Long-term memory | 80 | 25 | 50 |
| Cross-domain pattern | 70 | 40 | 70 |

Real EA total: ~790. Alpha today: ~285. Alpha with the founder's chosen batch + memory: ~525. That is the band of "the best friend who pays attention," not "the executive assistant who runs your week." Both are valid products; the band we are in is the one that scales and feels like love.

## Honest gap

What an AI friend has that a real EA doesn't is also worth naming: a friend is the only person the user texts at 2am with the same weight. The EA is asleep. That asymmetry is the whole reason the proactivity backbone (memory, calendar, sleep, spend, relationships) matters. The PA is the upper bound; we are not chasing it. We are building the bottom 80% that the user does not call an EA for, and that is what the backlog is for.
