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

const MINI_META: Record<string, { title: string; description: string }> = {
  menu: { title: 'Your HireAlpha features', description: 'Choose what this HireAlpha contact can help with.' },
  digest: { title: 'Morning brief', description: 'Your calendar, important mail, and reminders in one place.' },
  nutrition: { title: 'Nutrition', description: 'Log meals, estimate macros, and keep today’s totals.' },
  open_loops: { title: 'Loose ends', description: 'Track promises and follow-ups so nothing slips.' },
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
  mirror: { title: 'The mirror', description: 'Here is what your life actually looks like.' },
}

function miniMeta(pathname: string) {
  const match = pathname.match(/^\/app\/mini\/(friend|coworker|cofounder)\/([^/]+)/)
  if (!match) return null
  const persona = match[1] === 'friend' ? 'Alpha' : match[1] === 'coworker' ? 'Alpha (Coworker)' : 'Alpha (CoFounder)'
  const feature = MINI_META[match[2]] || { title: 'HireAlpha', description: 'A live HireAlpha mini-app.' }
  return { ...feature, title: `${feature.title} · ${persona}` }
}

async function miniIndex(pathname: string) {
  const meta = miniMeta(pathname)
  if (!meta) return null
  const index = await Bun.file(join(ROOT, 'index.html')).text()
  const safeTitle = meta.title.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
  const safeDescription = meta.description.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
  const withTitle = index.replace(/<title>[^<]*<\/title>/, `<title>${safeTitle}</title>`)
  const withDescription = withTitle.replace(
    /<meta\s+name="description"\s+content="[^"]*"\s*\/>/,
    `<meta name="description" content="${safeDescription}" />`,
  )
  const og = `\n  <meta property="og:title" content="${safeTitle}" />\n  <meta property="og:description" content="${safeDescription}" />`
  return withDescription.replace('</head>', `${og}\n  </head>`)
}

async function serveStatic(pathname: string) {
  const clean = pathname.split('?')[0] || '/'
  const mini = await miniIndex(clean)
  if (mini) {
    return new Response(mini, {
      headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' },
    })
  }
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
