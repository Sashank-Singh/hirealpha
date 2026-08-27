/** Tiny liveness HTTP surface for Coolify (bots otherwise have no HTTP). */
export function startHealthServer(label: string): void {
  const port = Number(process.env.HEALTH_PORT ?? 3000)
  Bun.serve({
    port,
    fetch(req) {
      const path = new URL(req.url).pathname
      if (path === '/healthz' || path === '/') {
        return Response.json({
          ok: true,
          service: label,
          ts: new Date().toISOString(),
        })
      }
      return new Response('not found', { status: 404 })
    },
  })
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
    }).catch(() => undefined)
  }
  ping()
  const timer = setInterval(ping, intervalMs)
  timer.unref?.()
}
