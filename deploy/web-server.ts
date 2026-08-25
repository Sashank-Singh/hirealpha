/**
 * HireAlpha marketing site: static files + waitlist API.
 * Stores emails in HireAlpha Postgres (Coolify).
 */
import { SQL } from 'bun'
import { brotliCompressSync, constants as zlibConstants } from 'node:zlib'
import { join } from 'node:path'
import { ensureHireSchema, handleHireApi, miniCardOgDescription } from './hire-api'
import {
  isKnownClientRoute,
  isKnownPage,
  PAGE_FILES,
  wantsMarkdown,
  markdownFor,
  notFoundMarkdown,
  PUBLIC_INFO,
  PERSONAS,
} from './agentReady'

const PORT = Number(process.env.PORT || 80)
const ROOT = process.env.STATIC_ROOT || join(import.meta.dir, 'dist')
const DATABASE_URL = process.env.DATABASE_URL || ''

/* Four connections was a cap on how much of a page could load at once: home
 * fires ~22 independent queries together, so a pool of four turned them back
 * into six round trips. Twelve is still nothing to a Postgres box and lets a
 * page's reads land in about two. */
/* The session timezone is pinned to UTC so a `::date` cast can never quietly
 * read at midnight in some other timezone. The local dev box ran its Postgres
 * session in America/Los_Angeles while prod ran UTC — that drift is exactly how
 * the "meal logged at 11 PM never reached Home" bug stayed invisible for weeks.
 * All day/week windows are computed as UTC instants; this is the belt behind
 * the suspenders. */
const sql = DATABASE_URL
  ? new SQL(DATABASE_URL, { max: 12, idleTimeout: 30, connectionTimeout: 10, connection: { options: '-c timezone=UTC' } })
  : null

/* ---- Compression ----
 * Nothing in front of this server was compressing, so a phone opening a mini
 * app downloaded 731 kB of JavaScript and CSS that squeezes to about 145 kB.
 * Assets are content-hashed and the process restarts on every deploy, so the
 * compressed bytes are held in memory by path: the first request pays, and
 * every request after it is a map lookup. */
const COMPRESSIBLE = /\.(js|mjs|css|html|json|svg|txt|map|webmanifest)$/i
const HASHED_ASSET = /-[A-Za-z0-9_-]{8,}\.[a-z0-9]+$/
const MIN_COMPRESS_BYTES = 1024
const MAX_CACHED_BYTES = 4 * 1024 * 1024
const encodedAssets = new Map<string, Uint8Array>()

/* Bun has shipped node:zlib brotli for a while, but this server is the only
 * thing standing between a user and a blank page — feature-detect rather than
 * assume, and fall back to gzip if it ever goes missing. */
const BROTLI_OK = (() => {
  try {
    brotliCompressSync(Buffer.from('x'.repeat(64)))
    return true
  } catch (err) {
    console.warn('[web] brotli unavailable, using gzip only', err)
    return false
  }
})()

function wantsEncoding(req: Request): 'br' | 'gzip' | null {
  const accept = (req.headers.get('accept-encoding') || '').toLowerCase()
  if (BROTLI_OK && accept.includes('br')) return 'br'
  if (accept.includes('gzip')) return 'gzip'
  return null
}

function squeeze(bytes: Uint8Array, enc: 'br' | 'gzip', quality: number) {
  if (enc === 'gzip') return Bun.gzipSync(bytes, { level: 6 })
  return new Uint8Array(
    brotliCompressSync(bytes, {
      params: {
        [zlibConstants.BROTLI_PARAM_QUALITY]: quality,
        [zlibConstants.BROTLI_PARAM_SIZE_HINT]: bytes.length,
      },
    }),
  )
}

function bytesResponse(body: Uint8Array, type: string, cache: string, enc?: 'br' | 'gzip') {
  const headers: Record<string, string> = {
    'Content-Type': type,
    'Cache-Control': cache,
    // Without this a shared cache can hand compressed bytes to a client that
    // did not ask for them.
    Vary: 'Accept-Encoding',
  }
  if (enc) headers['Content-Encoding'] = enc
  return new Response(body, { headers })
}

/**
 * Compress if the client asked and the body is big enough to be worth it.
 * `cacheKey` is set for files on disk, which are immutable for the life of the
 * process; dynamic HTML passes none and gets a cheaper brotli level instead.
 */
function textResponse(req: Request, bytes: Uint8Array, type: string, cache: string, cacheKey?: string) {
  const enc = bytes.length >= MIN_COMPRESS_BYTES ? wantsEncoding(req) : null
  if (!enc) return bytesResponse(bytes, type, cache)
  const key = cacheKey ? `${cacheKey}|${enc}` : ''
  const hit = key ? encodedAssets.get(key) : undefined
  if (hit) return bytesResponse(hit, type, cache, enc)
  const out = squeeze(bytes, enc, cacheKey ? 6 : 4)
  if (key && out.length <= MAX_CACHED_BYTES) encodedAssets.set(key, out)
  return bytesResponse(out, type, cache, enc)
}

/** HTML and markdown are negotiated, so caches must key on Accept as well as encoding. */
function withVary(res: Response, status = res.status) {
  const headers = new Headers(res.headers)
  headers.set('Vary', 'Accept, Accept-Encoding')
  return new Response(res.body, { status, headers })
}

function markdownResponse(req: Request, body: string, status = 200) {
  const res = textResponse(req, new TextEncoder().encode(body), 'text/markdown; charset=utf-8', 'no-cache')
  return withVary(res, status)
}

function htmlResponse(req: Request, body: string, status = 200) {
  const res = textResponse(req, new TextEncoder().encode(body), 'text/html; charset=utf-8', 'no-cache')
  return withVary(res, status)
}

/** API payloads are dynamic, so they are compressed but never cached. */
async function squeezeJson(req: Request, res: Response) {
  if (res.status !== 200) return res
  if (!(res.headers.get('content-type') || '').includes('application/json')) return res
  const enc = wantsEncoding(req)
  if (!enc) return res
  const raw = new Uint8Array(await res.arrayBuffer())
  const headers = new Headers(res.headers)
  headers.set('Vary', 'Accept-Encoding')
  if (raw.length < MIN_COMPRESS_BYTES) return new Response(raw, { status: res.status, headers })
  headers.set('Content-Encoding', enc)
  return new Response(squeeze(raw, enc, 4), { status: res.status, headers })
}

/* ---- Route chunks ----
 * The app is split per route, which on its own would trade bytes for a round
 * trip: the browser cannot know it needs the mini-app chunk until the entry
 * chunk has downloaded and parsed. The build manifest lets this server say so
 * in the HTML instead, so both download at once. */
type ManifestNode = { file: string; css?: string[]; imports?: string[]; isEntry?: boolean }
let manifest: Record<string, ManifestNode> | null = null

async function loadManifest() {
  try {
    manifest = JSON.parse(await Bun.file(join(ROOT, '.vite/manifest.json')).text())
    console.log(`[web] build manifest ready (${Object.keys(manifest || {}).length} entries)`)
  } catch {
    manifest = null
    console.warn('[web] no build manifest — route preload hints disabled')
  }
}

function routeChunk(pathname: string): string | null {
  if (pathname.startsWith('/app/mini/')) return 'src/platform/MiniAppPage.tsx'
  if (pathname === '/app/login') return 'src/platform/LoginPage.tsx'
  if (pathname.startsWith('/app')) return 'src/platform/PlatformShell.tsx'
  if (pathname === '/') return 'src/Landing.tsx'
  return null
}

function preloadTags(pathname: string) {
  const key = routeChunk(pathname)
  if (!key || !manifest) return ''
  const seen = new Set<string>()
  const js: string[] = []
  const css: string[] = []
  const walk = (k: string) => {
    if (seen.has(k)) return
    seen.add(k)
    const node = manifest![k]
    // The entry chunk and its CSS are already linked in the HTML; a lazy
    // chunk lists it as an import, so stop there rather than repeat it.
    if (!node || node.isEntry) return
    js.push(node.file)
    for (const c of node.css || []) css.push(c)
    for (const i of node.imports || []) walk(i)
  }
  walk(key)
  return [
    ...css.map((f) => `<link rel="stylesheet" href="/${f}" />`),
    ...js.map((f) => `<link rel="modulepreload" crossorigin href="/${f}" />`),
  ].join('\n    ')
}

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
  if (path.endsWith('.gif')) return 'image/gif'
  if (path.endsWith('.webp')) return 'image/webp'
  if (path.endsWith('.ico')) return 'image/x-icon'
  if (path.endsWith('.woff2')) return 'font/woff2'
  if (path.endsWith('.woff')) return 'font/woff'
  if (path.endsWith('.json')) return 'application/json'
  if (path.endsWith('.txt')) return 'text/plain; charset=utf-8'
  if (path.endsWith('.xml')) return 'application/xml'
  if (path.endsWith('.md')) return 'text/markdown; charset=utf-8'
  return 'application/octet-stream'
}

const MINI_META: Record<string, { title: string; description: string }> = {
  menu: { title: 'Apps', description: 'Tap one to open it.' },
  apps: { title: 'Apps', description: 'Tap one to open it.' },
  digest: { title: 'Morning brief', description: 'Who is next, what to do, what can wait.' },
  next_move: { title: 'Next', description: 'One ranked action. Do it, snooze it, or skip it.' },
  nutrition: { title: 'Nutrition', description: 'Log meals, estimate macros, and keep today’s totals.' },
  open_loops: { title: 'Promises', description: 'What you told a person you would do, until you mark it done.' },
  relationship_radar: { title: 'Stay in touch', description: 'See who to reach out to and when.' },
  drop_zone: { title: 'Save for later', description: 'Capture something messy and sort it later.' },
  meeting_mode: { title: 'Meeting mode', description: 'Prep before the meeting and wrap it cleanly after.' },
  decision_ledger: { title: 'Decisions', description: 'Record important calls and revisit the reasoning.' },
  check_in: { title: 'Check-in', description: 'Take a quick pulse on how you are doing.' },
  pick_night: { title: "Tonight's plan", description: 'Compare plans and decide what to do tonight.' },
  spiral_options: { title: 'Get unstuck', description: 'Step back and look at the options.' },
  approve_send: { title: 'Approve & send', description: 'Review a draft before it goes out.' },
  pick_slot: { title: 'Pick a slot', description: 'Compare times and choose the one that works.' },
  standup_paste: { title: 'Standup', description: 'Turn raw notes into a tight standup.' },
  linear_triage: { title: 'Linear triage', description: 'Triage issues and backlog.' },
  kill_keep_park: { title: 'Kill, keep, park', description: 'Decide what to kill, keep, or park.' },
  hire_decision: { title: 'Hire decision', description: 'Pressure-test the candidate call.' },
  weekly_focus: { title: 'Weekly focus', description: 'Choose what matters this week.' },
  weekly_review: { title: 'Weekly review', description: 'What got done, what slipped, and next week’s focus.' },
  approve_investor_note: { title: 'Investor note', description: 'Review an investor update before it goes out.' },
  habit_streak: { title: 'Habits', description: 'Build streaks and track daily habits.' },
  mood_tracker: { title: 'Mood', description: 'Log how you feel and spot patterns.' },
  workout_log: { title: 'Workout log', description: 'Log lifts and track PRs.' },
  learning_queue: { title: 'Learning queue', description: 'Save articles, videos, and podcasts.' },
  networking_crm: { title: 'Networking', description: 'People you met and when to follow up.' },
  sleep_tracker: { title: 'Sleep', description: 'Bedtime, wake, and sleep debt.' },
  pipeline_board: { title: 'Pipeline', description: 'Jobs, fundraising, and leads by stage.' },
  gratitude_journal: { title: 'Gratitude', description: 'One sentence a day.' },
  spending_snapshot: { title: 'Spending', description: 'Log spend against a weekly budget.' },
  home: { title: 'Home', description: 'Here is what your life actually looks like.' },
}

function miniMeta(pathname: string) {
  const match = pathname.match(/^\/app\/mini\/(friend|coworker|cofounder)\/([^/]+)/)
  if (!match) return null
  const persona = match[1] === 'friend' ? 'Alpha' : match[1] === 'coworker' ? 'Alpha (Coworker)' : 'Alpha (CoFounder)'
  const feature = MINI_META[match[2]] || { title: 'HireAlpha', description: 'A live HireAlpha mini-app.' }
  // The apps grid is the storefront, not one feature — it reads better as a
  // product headline than as "Apps · Alpha".
  if (match[2] === 'apps' || match[2] === 'menu') return { ...feature, title: 'Alpha Apps' }
  return { ...feature, title: `${feature.title} · ${persona}` }
}

function escapeAttr(value: string) {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

/** index.html changes only on deploy, and a deploy restarts this process. */
let shellHtml: string | null = null
async function appShell() {
  if (shellHtml === null) shellHtml = await Bun.file(join(ROOT, 'index.html')).text()
  return shellHtml
}

/**
 * The app shell for a route: per-app title and OG text where we have them, the
 * route's chunk preloaded, and — for the mini apps — the page background set
 * before any JavaScript runs, so the hold before first paint is the app's own
 * color rather than a white flash. The inline script lifts the saved light
 * theme off this device before that first paint; the style tag carries an id
 * so MiniAppPage can drop the hold when navigating away client-side.
 */
async function pageHtml(pathname: string, search = '') {
  let html = await appShell()
  const match = pathname.match(/^\/app\/mini\/(friend|coworker|cofounder)\/([^/]+)/)
  const meta = miniMeta(pathname)
  if (meta) {
    const token = new URLSearchParams(search.startsWith('?') ? search.slice(1) : search).get('t') || ''
    if (sql && match && token && (match[2] === 'digest' || match[2] === 'pick_night')) {
      try {
        const live = await miniCardOgDescription(sql, token, match[1]!, match[2]!)
        if (live) meta.description = live
      } catch (err) {
        console.warn('[web] mini og preview failed', err)
      }
    }
    const safeTitle = escapeAttr(meta.title)
    const safeDescription = escapeAttr(meta.description)
    /* Every kind gets its own designed card image (scripts/og-template.html
     * renders them) — the old shell-wide stock photo made every card in the
     * thread look like a template. Unknown kinds fall back to the brand card. */
    const ogKind = MINI_META[match?.[2] || ''] ? (match![2] as string) : 'default'
    const ogImage = `https://hirealpha.chat/images/og/${ogKind}.png`
    html = html
      .replace(/<title>[^<]*<\/title>/, `<title>${safeTitle}</title>`)
      .replace(
        /<meta\s+name="description"\s+content="[^"]*"\s*\/>/,
        `<meta name="description" content="${safeDescription}" />`,
      )
      .replace(
        /<meta\s+property="og:image"\s+content="[^"]*"\s*\/>/,
        `<meta property="og:image" content="${escapeAttr(ogImage)}" />`,
      )
      .replace(
        '</head>',
        `\n  <meta property="og:title" content="${safeTitle}" />\n  <meta property="og:description" content="${safeDescription}" />\n  </head>`,
      )
  }
  const head = [
    match
      ? '<style id="mini-hold">body{background:#141414}html[data-mini-theme="light"] body{background:#f5f4f0}</style>' +
        '<script>try{if(localStorage.getItem("mini-theme")==="light")document.documentElement.dataset.miniTheme="light"}catch(e){}</script>'
      : '',
    preloadTags(pathname),
  ].filter(Boolean)
  if (head.length) html = html.replace('</head>', `${head.join('\n    ')}\n  </head>`)
  // The no-JS marketing copy only belongs on the public home; on app routes React
  // would replace it anyway, and shipping it there just adds bytes and a flash.
  if (pathname !== '/') html = html.replace(/<main class="seo-fallback"[\s\S]*?<\/main>/, '')
  return html
}

async function staticAsset(req: Request, rel: string) {
  const type = contentType(rel)
  const cache = rel.match(/\.(js|css|png|jpg|jpeg|gif|svg|ico|webp|woff2?)$/)
    ? // Content-hashed names can never mean anything else, so let them stick.
      HASHED_ASSET.test(rel)
      ? 'public, max-age=31536000, immutable'
      : 'public, max-age=604800'
    : 'no-cache'
  if (COMPRESSIBLE.test(rel)) {
    // A cache hit means the file existed when we read it, so skip the stat.
    const enc = wantsEncoding(req)
    const hit = enc ? encodedAssets.get(`${rel}|${enc}`) : undefined
    if (hit && enc) return bytesResponse(hit, type, cache, enc)
  }
  const file = Bun.file(join(ROOT, rel))
  if (!(await file.exists())) return null
  if (COMPRESSIBLE.test(rel)) {
    return textResponse(req, new Uint8Array(await file.arrayBuffer()), type, cache, rel)
  }
  return new Response(file, { headers: { 'Content-Type': type, 'Cache-Control': cache } })
}

async function serveStatic(req: Request, pathname: string, search = '') {
  const clean = pathname.split('?')[0] || '/'
  const accept = req.headers.get('accept')

  // Static assets and machine files (js/css/img, robots, llms, sitemap, openapi).
  if (clean !== '/' && !clean.endsWith('.html') && !isKnownPage(clean)) {
    const asset = await staticAsset(req, clean)
    if (asset) return asset
  }

  // Content negotiation: the home and the trust/portal pages answer markdown.
  if (wantsMarkdown(accept)) {
    const md = markdownFor(clean)
    if (md) return markdownResponse(req, md)
  }

  // The static trust/portal pages at clean URLs.
  if (isKnownPage(clean)) {
    const file = Bun.file(join(ROOT, PAGE_FILES[clean]))
    if (await file.exists()) return htmlResponse(req, await file.text())
  }

  // The SPA shell, only for routes the client actually owns.
  if (isKnownClientRoute(clean)) {
    try {
      return htmlResponse(req, await pageHtml(clean, search))
    } catch {
      return notFound(req, clean)
    }
  }

  return notFound(req, clean)
}

/** A real 404 with a short body pointing agents at the sitemap and llms.txt. */
function notFound(req: Request, clean: string) {
  const accept = req.headers.get('accept') || ''
  if (wantsMarkdown(accept) || !accept.includes('text/html')) {
    return markdownResponse(req, notFoundMarkdown(clean), 404)
  }
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>404 — HireAlpha</title></head><body style="font-family:monospace;background:#efebe4;color:#111;padding:48px"><h1>404 — not found</h1><p><code>${clean}</code> does not exist. Try the <a href="/sitemap.xml">sitemap</a> or <a href="/llms.txt">llms.txt</a>.</p></body></html>`
  return htmlResponse(req, html, 404)
}

await ensureSchema()
await loadManifest()

Bun.serve({
  port: PORT,
  hostname: '0.0.0.0',
  idleTimeout: 60,
  async fetch(req) {
    const url = new URL(req.url)
    if (url.pathname === '/healthz') {
      return new Response('ok', { headers: { 'Content-Type': 'text/plain' } })
    }
    if (url.pathname === '/api/waitlist') return handleWaitlist(req)
    if (url.pathname === '/api/public/info') return json(PUBLIC_INFO)
    if (url.pathname === '/api/public/personas') return json(PERSONAS)
    const hire = await handleHireApi(req, sql)
    if (hire) return squeezeJson(req, hire)
    if (url.pathname.startsWith('/api/')) return json({ error: 'Not found' }, 404)
    return serveStatic(req, url.pathname, url.search)
  },
})

console.log(`[web] listening on :${PORT} root=${ROOT} compression=${BROTLI_OK ? 'br+gzip' : 'gzip'}`)
