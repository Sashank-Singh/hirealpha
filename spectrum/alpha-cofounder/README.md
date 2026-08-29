# alpha-cofounder

Alpha(CoFounder), the startup partner hire. A [Spectrum](https://photon.codes/docs/spectrum-ts) app wired with `imessage`, running the shared HireAlpha turn engine from `../shared` (same runtime as alpha and alpha-coworker):

- `runHireTurn` for every inbound text, with per-persona skills, memory, and mini apps
- intro texts on first contact (`INTRO_TO`) plus a signup intro poller
- reminder scheduler, task loop poller, and heartbeat/health server
- iMessage app cards for the cofounder mini apps (Brief, Home, Pipeline, Decisions, Investor note, Hire decision, Kill/Keep/Park, …)

## Environment

Before running, open `.env` and fill in the values:

From your project Settings on the [Photon dashboard](https://app.photon.codes):

- `PROJECT_ID`
- `PROJECT_SECRET`

## Run

```sh
bun install
bun start
```
