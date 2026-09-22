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

## Signup intros (no manual number adds)

Each bot polls `HIREALPHA_API_URL /api/internal/intros/claim?persona=<id>` every 30s
(`spectrum/shared/introQueue.ts`). Numbers that sign up on the landing page (or set a
phone on their account) land in the `hire_intro_queue` table; the bot texts the intro,
then acks. Failures retry up to 5 attempts; after that the number parks as `failed`
in the queue and the signup screen's fallback ("text hi to ...") takes over. No more
INTRO_TO restarts for new users — that env still works for one-off manual tests.

## How to fix “Target not allowed” on intro

Shared Photon lines often **cannot cold-text first**. Text each hire from your phone (`+12163032166`), then they reply in character. Listeners are already running. For
signups, the same limit shows up as repeated intro failures — that is what the
fallback copy on the landing page covers.

## GMI

```env
GMI_API_KEY=your_key
GMI_BASE_URL=https://api.gmi-serving.com/v1
GMI_MODEL=deepseek-ai/DeepSeek-V4-Flash-0731
```

Without `GMI_API_KEY`, bots use the local personality fallback in `src/agents/runtime.ts`.

## GLM 5.3 Flash provider recovery

Keep the model fixed while moving text inference off GMI. The shared client
supports OpenRouter's `z-ai/glm-5.3-flash` identifier, prioritizes latency, permits
provider failover, and excludes `gmicloud`. It does not request another model.
OpenRouter reasoning settings are translated to its `reasoning` object.

To prepare a primary OpenRouter route, configure these runtime secrets/settings
in the deployment secret manager (the `GMI_` names remain for compatibility):

```text
GMI_BASE_URL=https://openrouter.ai/api/v1
GMI_MODEL=z-ai/glm-5.3-flash
GMI_MODEL_FALLBACK=z-ai/glm-5.3-flash
GMI_API_KEY=<OpenRouter API key>
```

Alternatively, keep the current primary and enable an independent backup with
all three settings below. No backup is enabled by default:

```text
HIREALPHA_MODEL_FALLBACK_BASE_URL=https://openrouter.ai/api/v1
HIREALPHA_MODEL_FALLBACK_MODEL=z-ai/glm-5.3-flash
HIREALPHA_MODEL_FALLBACK_API_KEY=<OpenRouter API key>
```

The shared client reserves part of the existing deadline for the backup,
retains the original messages, and isolates rate-limit queues by provider.
Explicit endpoint/credential callers keep their own route. This covers shared
text inference; browser vision and nutrition integrations use separate request
builders and must be validated separately before changing their environment.

Validation: `bun test spectrum/shared/providerFallback.test.ts
spectrum/shared/delivery.test.ts spectrum/shared/reliability.test.ts
deploy/gmiBackoff.test.ts`. Before production rollout, benchmark actual Alpha
turns with the chosen account, then verify the running deployment revision.
Published provider latency and uptime figures are not an application SLA.
