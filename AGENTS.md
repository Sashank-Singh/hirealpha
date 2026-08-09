# AGENTS.md

## Cursor Cloud specific instructions

HireAlpha is a React 19 + Vite 8 web app (package manager: **npm**, Node 22). The
primary product is the web app at the repo root; the `spectrum/` folder holds three
optional iMessage bots that need Bun plus paid Photon Spectrum + iMessage credentials
and are not required to run or test the web product locally.

### Web app (primary service)

Standard scripts live in `package.json` — use them directly:

- `npm run dev` — Vite dev server on `http://localhost:5173` (this is the only process you need).
- `npm run build` — `tsc -b && vite build`.
- `npm run lint` — Oxlint.
- `npm run preview` — serve the built `dist/`.

There is **no separate backend process and no test suite**. The `/api/chat` and
`/api/agents` endpoints are served by a Vite middleware plugin (`server/apiPlugin.ts`)
that is mounted automatically inside both `npm run dev` and `npm run preview`.

Non-obvious gotchas:

- **No API key is required to run end-to-end.** Without `GMI_API_KEY`/`OPENAI_API_KEY`,
  `/api/chat` returns deterministic local fallback replies (`"source":"local"`), so the
  chat flow works fully offline. Set a key in a root `.env` (copy `.env.example`) only if
  you want live model replies (`"source":"live"`).
- Env vars are read from a root `.env` by `server/apiPlugin.ts` at server start (no
  `dotenv` dependency). Restart the dev server after editing `.env`.
- Auth and connector state are **client-side only** (`localStorage`). On `/login` any
  valid email + 6+ char password logs you in; there is no real user backend.
- `npm run build` prints Vite `configLoader: 'native'` warnings about extensionless
  imports in `server/apiPlugin.ts` / `src/agents/*`. These are warnings only; the build
  and dev server succeed.

### Spectrum bots (optional, not needed for local testing)

`npm run spectrum*` targets require Bun (not installed by default) and real Photon
Spectrum project credentials + an iMessage line. `scripts/start-spectrum.sh` also
hardcodes a macOS-specific Bun path and a personal number, so it is not portable to the
Linux VM. Skip these unless specifically working on the iMessage integration.
