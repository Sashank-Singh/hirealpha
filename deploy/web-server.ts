/**
 * HireAlpha marketing site: static files + waitlist API.
 * Stores emails in HireAlpha Postgres (Coolify).
 */
import { SQL } from 'bun'
import { join } from 'node:path'
import { ensureHireSchema, handleHireApi } from './hire-api'

const PORT = Number(process.env.PORT || 80)
const ROOT = process.env.STATIC_ROOT || join(import.meta.dir, 'dist')
const DATABASE_URL = process.env.DATABASE_URL || ''

const sql = DATABASE_URL
  ? new SQL(DATABASE_URL, { max: 4, idleTimeout: 30, connectionTimeout: 10 })
  : null

async function ensureSchema() {
  if (!sql) {
    console.warn('[waitlist] DATABASE_URL missing — emails will not be stored')
    return
  }
  await sql`
    CREATE TABLE IF NOT EXISTS waitlist_emails (
      id TEXT PRIMARY KEY,
      email TEXT NOT NULL UNIQUE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `
  await ensureHireSchema(sql)
  console.log('[waitlist] table ready')
}

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
    },
  })
}

function isValidEmail(email: string) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) && email.length <= 320
}

async function handleWaitlist(req: Request) {
  if (req.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
      },
    })
  }
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405)
  if (!sql) return json({ error: 'Waitlist storage unavailable' }, 503)

  let body: { email?: string }
  try {
    body = (await req.json()) as { email?: string }
  } catch {
    return json({ error: 'Invalid JSON' }, 400)
  }

  const email = String(body.email || '')
    .trim()
    .toLowerCase()
  if (!isValidEmail(email)) return json({ error: 'Enter a valid email' }, 400)

  try {
    await sql`
      INSERT INTO waitlist_emails (id, email)
      VALUES (${crypto.randomUUID()}, ${email})
      ON CONFLICT (email) DO NOTHING
    `
    return json({ ok: true })
  } catch (err) {
    console.error('[waitlist] insert failed', err)
    return json({ error: 'Could not save email' }, 500)
  }
}

function contentType(path: string) {
  if (path.endsWith('.html')) return 'text/html; charset=utf-8'
  if (path.endsWith('.js')) return 'text/javascript; charset=utf-8'
  if (path.endsWith('.css')) return 'text/css; charset=utf-8'
  if (path.endsWith('.svg')) return 'image/svg+xml'
  if (path.endsWith('.png')) return 'image/png'
  if (path.endsWith('.jpg') || path.endsWith('.jpeg')) return 'image/jpeg'
  if (path.endsWith('.webp')) return 'image/webp'
  if (path.endsWith('.ico')) return 'image/x-icon'
  if (path.endsWith('.woff2')) return 'font/woff2'
  if (path.endsWith('.woff')) return 'font/woff'
  if (path.endsWith('.json')) return 'application/json'
  return 'application/octet-stream'
}

async function serveStatic(pathname: string) {
  const clean = pathname.split('?')[0] || '/'
  const rel = clean === '/' ? '/index.html' : clean
  const filePath = join(ROOT, rel)
  const file = Bun.file(filePath)
  if (await file.exists()) {
    return new Response(file, {
      headers: {
        'Content-Type': contentType(rel),
        'Cache-Control': rel.match(/\.(js|css|png|jpg|jpeg|gif|svg|ico|webp|woff2?)$/)
          ? 'public, max-age=604800'
          : 'no-cache',
      },
    })
  }

  // SPA fallback
  const index = Bun.file(join(ROOT, 'index.html'))
  if (await index.exists()) {
    return new Response(index, {
      headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' },
    })
  }
  return new Response('Not found', { status: 404 })
}

await ensureSchema()

Bun.serve({
  port: PORT,
  hostname: '0.0.0.0',
  async fetch(req) {
    const url = new URL(req.url)
    if (url.pathname === '/healthz') {
      return new Response('ok', { headers: { 'Content-Type': 'text/plain' } })
    }
    if (url.pathname === '/api/waitlist') return handleWaitlist(req)
    const hire = await handleHireApi(req, sql)
    if (hire) return hire
    return serveStatic(url.pathname)
  },
})

console.log(`[web] listening on :${PORT} root=${ROOT}`)
