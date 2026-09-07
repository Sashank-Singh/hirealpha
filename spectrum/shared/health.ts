/** Tiny liveness HTTP surface for Coolify (bots otherwise have no HTTP). */
export function healthHandler(
  label: string,
  opts?: {
    /** Serve recent turn-eval rows at /evals. */
    readEvals?: () => unknown[]
    /** Score recent turns on demand (POST /evals/score). */
    scoreEvals?: () => Promise<number>
  },
) {
    return (req: Request) => {
      const path = new URL(req.url).pathname
      if (path === '/healthz' || path === '/') {
        return Response.json({
          ok: true,
          service: label,
          ts: new Date().toISOString(),
        })
      }
      // Evals contain conversation text; scoring also spends model credits.
      // Keep liveness public, but never expose diagnostics without a secret.
      if (path === '/evals' || path === '/evals/score') {
        const key = process.env.HIREALPHA_INTERNAL_KEY
        if (!key || req.headers.get('Authorization') !== `Bearer ${key}`) {
          return Response.json({ error: 'Unauthorized' }, { status: 401 })
        }
      }
      if (path === '/evals' && req.method === 'GET' && opts?.readEvals) {
        const rows = opts.readEvals()
        const scored = rows.filter((r) => (r as { score?: unknown }).score)
        const avg = (k: 'intelligence' | 'tone' | 'brevity' | 'human') => {
          const vals = scored
            .map((r) => (r as { score: Record<string, number> }).score?.[k])
            .filter((n): n is number => typeof n === 'number')
          return vals.length ? Math.round(vals.reduce((a, b) => a + b, 0) / vals.length) : null
        }
        return Response.json({
          ok: true,
          service: label,
          ts: new Date().toISOString(),
          turns: rows.length,
          scored: scored.length,
          avg: scored.length
            ? { intelligence: avg('intelligence'), tone: avg('tone'), brevity: avg('brevity'), human: avg('human') }
            : null,
          latest: rows.slice(-5),
        })
      }
      if (path === '/evals/score' && req.method === 'POST' && opts?.scoreEvals) {
        return opts.scoreEvals().then(
          (n) => Response.json({ ok: true, scored: n }),
          () => Response.json({ ok: false, error: 'Scoring failed' }, { status: 500 }),
        )
      }
      return new Response('not found', { status: 404 })
    }
}

export function startHealthServer(label: string, opts?: Parameters<typeof healthHandler>[1]): void {
  const port = Number(process.env.HEALTH_PORT ?? 3000)
  Bun.serve({ port, fetch: healthHandler(label, opts) })
  console.log(`[${label}] health on :${port} (/healthz)`)
}

function apiBase() {
  return (process.env.HIREALPHA_API_URL || '').replace(/\/$/, '')
}

/** Boot plus every 60s liveness ping. Missing env or a failed post is a
 * no-op, a dead heartbeat endpoint must never take the bot down. */
export function startHeartbeat(persona: string, intervalMs = 60_000): void {
  const base = apiBase()
  if (!base || !process.env.HIREALPHA_INTERNAL_KEY) {
    console.log(`[${persona}] heartbeat off: HIREALPHA_API_URL or HIREALPHA_INTERNAL_KEY missing`)
    return
  }
  const ping = () => {
    fetch(`${base}/api/internal/heartbeat`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.HIREALPHA_INTERNAL_KEY || ''}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ persona }),
      signal: AbortSignal.timeout(8000),
    }).catch(() => undefined)
  }
  ping()
  const timer = setInterval(ping, intervalMs)
  timer.unref?.()
}
