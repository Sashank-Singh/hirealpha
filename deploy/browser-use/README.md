# browser-use — Cloud AI Browser Sessions on Coolify

Self-hosted AI web-agent with a live browser stream, deployed on your existing Coolify
instance. Zero extra cost — everything runs inside a single Docker container on the
server you already own.

**Stack:** [`browser-use/web-ui`](https://github.com/browser-use/web-ui) · Gradio UI · noVNC
(live screen cast) · Chromium headless

---

## URLs (after deployment)

| Interface | URL |
|---|---|
| **Gradio Web UI** | `https://browser.hirealpha.chat` |
| **Live browser stream (noVNC)** | `https://browser.hirealpha.chat/vnc/` |

---

## Coolify — 1-Click Deployment

### 1. Create a new resource

1. Open your Coolify dashboard → **Projects** → `HireAlpha` → **Add Resource**
2. Choose **Docker Compose**
3. Set **Source** to **"Git"** and point it at this repo, subdirectory `deploy/browser-use/`
   — **or** paste `docker-compose.yml` directly into the Compose editor

### 2. Set environment variables

In the Coolify **Environment Variables** tab, add at minimum:

| Variable | Value |
|---|---|
| `BROWSER_USE_DOMAIN` | `browser.hirealpha.chat` |
| `OPENAI_API_KEY` | your OpenAI key (or use Anthropic/Google) |
| `CHROME_VNC_PASSWORD` | a strong password (6–8 chars) |
| `GRADIO_USERNAME` | optional — enables HTTP basic auth |
| `GRADIO_PASSWORD` | optional |

> **Tip:** You can use any LLM provider — set `ANTHROPIC_API_KEY` or `GOOGLE_API_KEY`
> instead of OpenAI. For fully local/free inference, point `OLLAMA_ENDPOINT` at an
> Ollama instance running on the same host.

### 3. Configure the domain

1. In Coolify: **Domains** → Add `browser.hirealpha.chat`
2. Enable **Let's Encrypt** — Coolify handles the TLS certificate automatically
3. Coolify injects the Traefik labels from `docker-compose.yml` automatically

### 4. Deploy

Click **Deploy**. First run pulls `ghcr.io/browser-use/web-ui:main` (~2.5 GB with
Chromium). Subsequent deploys are instant.

Watch the logs: when you see `Running on http://0.0.0.0:7788` the UI is ready.

---

## Running a Task

1. Open `https://browser.hirealpha.chat`
2. Select your LLM model (e.g. `gpt-4o`, `claude-3-7-sonnet-20250219`)
3. Type a task in plain English:
   - _"Go to gmail.com, find emails from Notion, and summarize them"_
   - _"Order Jasmine rice from Instacart using the saved address"_
   - _"Check the latest news on TechCrunch and list the top 5 headlines"_
4. Watch the live browser in the noVNC panel or the embedded Gradio video
5. The agent reports back with a summary when complete

---

## Architecture

```
Coolify (Traefik)
  └─ browser-use container
       ├─ Gradio UI        :7788  ← task input / status output
       ├─ noVNC web client :6080  ← live browser screen cast
       ├─ VNC server       :5901  ← raw VNC (not publicly exposed)
       ├─ Chrome DevTools  :9222  ← CdP (not publicly exposed)
       └─ Chromium         (headless, managed by browser-use)
```

The container is stateless between tasks. `browser-use-data` volume persists the
browser profile (cookies, local storage) so logins survive restarts.

---

## Connecting to HireAlpha

HireAlpha's existing browser job queue (`hire_browser_jobs`) and worker
(`deploy/browserWorker.ts`) can dispatch tasks to this instance. Set the following
env var on your HireAlpha Coolify resource:

```
BROWSER_USE_URL=https://browser.hirealpha.chat
```

The worker will POST tasks to the Gradio API endpoint and poll for results.

---

## Shared Memory

The container is configured with `shm_size: 2gb`. Chromium requires large `/dev/shm`
for rendering; the default Docker 64 MB causes frequent tab crashes on complex pages.

---

## Updating

Coolify → resource → **Redeploy** pulls the latest `ghcr.io/browser-use/web-ui:main`.
Pin to a specific digest in `docker-compose.yml` if you need reproducible deploys.

---

## References

- [`browser-use`](https://github.com/browser-use/browser-use) — Python agent library
- [`web-ui`](https://github.com/browser-use/web-ui) — Gradio + noVNC frontend
- [Coolify docs — Docker Compose](https://coolify.io/docs/resources/docker-compose)
