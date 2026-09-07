# Pawlan self-bench — score Alpha against the benchmark he'll run on us

David Pawlan (@DavidPawlan) is testing 40 AI text assistants across 14
benchmarks, results public. HireAlpha is on the list. This harness runs HIS
announced categories against our own bot daily so we find the failures before
his posts do. The extra 7 benchmarks are unnamed; the likely set (memory,
latency, tone, error handling, setup friction, multi-step, value) is included
as unofficial rows.

## How to run

1. Deploy the current revision to prod first — benching a stale build is noise.
2. Text Alpha from the test phone (the founding-cohort test account).
3. For each row: send the prompt, note wall-clock seconds to first reply, and
   score PASS / PARTIAL / FAIL against the bar in the row.
4. Fill today's date section at the bottom. Never fake a result — a FAIL we
   know about is worth more than a PASS we invented.
5. Any FAIL gets a line in the backlog the same day.

## The 7 announced categories

### 1/ Carrying out an online task
| Prompt | Bar |
|---|---|
| "what's the news on the next apple event" | Real sources + links from web search, under 30s, no invented facts |
| "look up the price of a 5lb bag of jasmine rice on amazon" | Names a real price/URL or says it can't browse — never a made-up number |
| "find a table for 4 this friday near me" | Maps results from OSM near home, names one pick + one alternate + link |

### 2/ Recommendation quality
| Prompt | Bar |
|---|---|
| "good quiet restaurant for a date night this weekend?" | Uses saved location, gives ONE pick with a why + one alternate (not a listicle) |
| "i want to read something short tonight, any ideas?" | References known interests/memory, not a generic list |
| "best way to get to SFO at 5am friday" | Uses home location, real options, flags the calendar conflict if one exists |

### 3/ Purchasing a product
| Prompt | Bar |
|---|---|
| "order me more of that coffee i like" | Either a real approve-to-buy draft/payment link or an honest "I can't purchase yet, here's the cart link" — NEVER "done" |
| "how much did i spend on coffee this week" | Real numbers from the spending log |

### 4/ Responding to emails
| Prompt | Bar |
|---|---|
| (with Gmail connected) "what needs a reply today" | Real threads from Gmail, ranked, offers drafts |
| "draft a reply saying tuesday works" | A real DRAFT_MAIL in the approval card — never auto-sent |

### 5/ Proactive behavior
| Prompt | Bar |
|---|---|
| (passive — no prompt) connect Gmail + Calendar, then wait 24h | At least one useful first-text (watchtower/calendar-defense/brief) with zero spam; ≤2/day |
| "what are you watching for me right now?" | Correct list of armed loops, matches reality |

### 6/ Running a routine
| Prompt | Bar |
|---|---|
| (morning) wait for the 8am brief | Fires at set local time, real mail+calendar items, no model outage text |
| "slept 6.5 hours" | Sleep row lands, morning brief reflects it |
| (send a photo of food) | Meal logged; if macros pending, Alpha ASKS what it was — never reports 0/0/0/0 as fact |
| "remind me to call mom sunday at 5" | Reminder lands, fires Sunday |

### 7/ 3rd-party integrations
| Prompt | Bar |
|---|---|
| one-tap connect flow: slack/linear/notion/github from settings | OAuth completes, status flips to connected, read returns real data |
| "read my last notion page" | Real content or honest reconnect note — no invention |
| (UI) open Connected Tools | Only the 11 live connectors visible; no dead tiles |

## The likely hidden 7 (unofficial)

| Category | Bar |
|---|---|
| Memory | Say "my sister's name is Priya" day 1 → recalls unprompted day 7 |
| Latency | Median first-bubble time under 10s across a 20-turn day |
| Tone | No AI-slop taglines, no "As an AI", reads like a person, brief not chatty |
| Error handling | Disconnect Gmail then ask about mail → honest reconnect line, no hallucinated inbox |
| Setup friction | Cold signup → checkout → intro → wizard → first brief under 10 minutes, zero dead ends |
| Multi-step | "plan saturday: brunch, then bookstore, then dinner near it" → uses maps + calendar, coherent day, offers to hold slots |
| Value | After a week: name 3 things Alpha did unprompted that were worth $19 |

## Results log

### 2026-09-07 (build: pre-deploy local)
- Not run yet — fill after deploy.
