# Benchmark run records — immutable evidence

One directory per logged run attempt. Rules (from
[11-pawlan-self-bench.md](../../marketing/launch-kit/11-pawlan-self-bench.md)):

1. One record per dimension per run. Never overwrite — new attempt = new file
   with `-attempt-N` suffix and a new timestamp.
2. No real logged run = no score. Internal rehearsals are labeled
   `internal-rehearsal` and never presented as official results.
3. Save the raw evidence in the same folder: screenshots, full thread text,
   approval links, artifacts, plus the production revision hash (git SHA or
   Coolify deployment id) and the exact resolved dates.

## File naming

```
NNN-dimension-YYYY-MM-DD-internal-rehearsal.md
NNN-dimension-YYYY-MM-DD-public-run.md
```

## Priority order (wall-clock dimensions start first)

| Order | Dimension | Why first |
|---|---|---|
| 1 | Routine | needs 5 consecutive weekdays of evidence |
| 2 | Memory | needs a 7-day gap between seed and probe |
| 3 | Proactive | needs a real flight/calendar event to fire on |
| 4 | Permissions | we are strong here (scoped OAuth + ask-first); demo-ready |
| 5 | Restraint | same evening script, demo-ready |
| 6 | Email | live Gmail + calendar slots |
| 7 | Integrations | Notion + Calendar + Slack one request |
| 8 | Picks | bookable options with reasons |
| 9 | Online task + Purchasing | requires live E2B execution (env pending) |
| — | Travel, Phone calls, Groups, Chained, Images/games | product gaps; tracked as N/A or future runs |

## Status

No runs recorded yet. First rehearsals start on the founder's test phone.
