# Spectrum bots (HireAlpha)

Three Photon Spectrum projects, one hire each:

| Hire | Folder | Line | Project ID |
| --- | --- | --- | --- |
| Friend / Alpha | `alpha/` | +1 (415) 595-1440 | `3af40a72-…` |
| Coworker | `alpha-coworker/` | +1 (628) 264-7648 | `db7bcc82-…` |
| Cofounder | `alpha-cofounder/` | +1 (415) 603-5536 | `9998e5ea-…` |

## Run

```bash
# set GMI_API_KEY in each spectrum/*/.env (or export it)
bash scripts/start-spectrum.sh
```

Or one at a time:

```bash
cd spectrum/alpha && bun start
```

## Coolify

Root `Dockerfile` builds all three hires. Set `HIREALPHA_BOT` per app:

| App | `HIREALPHA_BOT` |
| --- | --- |
| HireAlpha-Friend | `friend` |
| HireAlpha-Coworker | `coworker` |
| HireAlpha-Cofounder | `cofounder` |

Required env (runtime): `PROJECT_ID`, `PROJECT_SECRET`, `GMI_API_KEY`, `GMI_BASE_URL`, `GMI_MODEL`, `SKIP_INTRO=1`, `HEALTH_PORT=3000`, `HIREALPHA_API_URL=https://hirealpha.chat`, `HIREALPHA_INTERNAL_KEY` (same secret as HireAlpha-Web).

Health: `GET /healthz` on port 3000.

## How to fix “Target not allowed” on intro

Shared Photon lines often **cannot cold-text first**. Text each hire from your phone (`+12163032166`), then they reply in character. Listeners are already running.

## GMI

```env
GMI_API_KEY=your_key
GMI_BASE_URL=https://api.gmi-serving.com/v1
GMI_MODEL=deepseek-ai/DeepSeek-V4-Flash-0731
```

Without `GMI_API_KEY`, bots use the local personality fallback in `src/agents/runtime.ts`.
