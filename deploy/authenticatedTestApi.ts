/** Route fixtures with explicit account selectors model an authenticated caller.
 * Security tests import hire-api directly; this helper never bypasses its boundary. */
import { createHmac } from 'node:crypto'
import { handleHireApi as handle } from './hire-api'
export * from './hire-api'

export async function handleHireApi(req: Request, sql: Parameters<typeof handle>[1]) {
  const url = new URL(req.url)
  const body = await req.clone().json().catch(() => ({})) as Record<string, unknown>
  const email = String(body.email || url.searchParams.get('email') || '')
  const phone = body.phone || url.searchParams.get('phone')
  if ((!email && !phone && !url.pathname.endsWith('/undo')) || url.pathname.startsWith('/api/internal/')) return handle(req, sql)
  const previous = process.env.HIREALPHA_SESSION_SECRET
  const secret = previous || process.env.HIREALPHA_INTERNAL_KEY || 'fixture-session-key'
  process.env.HIREALPHA_SESSION_SECRET = secret
  const payload = Buffer.from(JSON.stringify({ email: email || 'a@b.co', exp: Date.now() + 60_000 })).toString('base64url')
  const signature = createHmac('sha256', secret).update(payload).digest('base64url')
  const headers = new Headers(req.headers)
  headers.set('Cookie', `hirealpha_session=${payload}.${signature}`)
  try {
    return await handle(new Request(req, { headers }), sql)
  } finally {
    if (previous === undefined) delete process.env.HIREALPHA_SESSION_SECRET
    else process.env.HIREALPHA_SESSION_SECRET = previous
  }
}
