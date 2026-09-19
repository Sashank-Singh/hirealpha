# Run doc — HireAlpha marketing/landing app (Vite)

This project's web frontend is Vite + React (`npm run dev`). The backend API and
browser worker are separate Bun services and are NOT needed for the preview —
`vite.config.ts` proxies `/api` to production (`https://hirealpha.chat`)
unless `HIREALPHA_API_TARGET` is set.

## Reproduce artifacts a fresh checkout needs

1. Copy env files from the main checkout (`/Users/sashanksingh/Projects/HireAlpha`):
   `.env` → project root. Copy, never symlink. (`.env.example` documents keys.)
   For the landing preview no API keys are required; the default proxy target
   is the production site.
2. Install dependencies with npm (project has both `package-lock.json` and
   `bun.lock`; the scripts are npm-flavored):
   ```
   npm install
   ```
   Playwright browsers are only needed for the test/perf harnesses, not for
   `npm run dev`.

## Run the dev server

Default port is 5173 (`vite.config.ts`). It is frequently occupied by another
local Vite instance, so this preview uses **5174** with `--strictPort`:

```
npm run dev -- --port 5174 --strictPort
```

Detached under launchd (survives the conversation; npm scripts need node on
PATH, which launchd's default PATH lacks — hence the export):

```
launchctl submit -l com.freebuff.preview-3c1c61ef -- /bin/sh -c \
  'export PATH=/opt/homebrew/bin:$PATH; cd /Users/sashanksingh/Projects/HireAlpha && exec npm run dev -- --port 5174 --strictPort > /Users/sashanksingh/Projects/HireAlpha/.freebuff/preview-3c1c61ef-e11b-4caf-bc30-efbf01a64b1d.log 2>&1'
```

- Log: `.freebuff/preview-3c1c61ef-e11b-4caf-bc30-efbf01a64b1d.log`
- PID: `launchctl print gui/$(id -u)/com.freebuff.preview-3c1c61ef | grep pid`
- Stop: `launchctl remove com.freebuff.preview-3c1c61ef`
- URL: http://localhost:5174/
