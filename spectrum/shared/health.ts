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
