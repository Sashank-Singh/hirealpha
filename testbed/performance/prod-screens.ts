/**
 * Cold-open screen times against the PRODUCTION bundle, with production-shaped
 * API latency. screen-time.ts measures a dev server (unbundled modules, Vite
 * transform cost); this measures what ships.
 *
 * Run:  npm run build && bun testbed/performance/prod-screens.ts
 *
 * Fails when any screen's first meaningful content exceeds BUDGET_MS.
 */
import { chromium } from 'playwright'
import { join } from 'node:path'

const ROOT = join(import.meta.dir, '..', '..', 'dist')
/** User-visible budget. Home and the mini apps must appear under this. */
const BUDGET_MS = 1000
/** Measured production API latency for the slowest call a screen makes. */
const API_DELAY_MS = 450

/** Text that means "this screen is still working", not "this screen is here". */
const LOADING = /Loading|One moment|Loading your|still loading/i

const screens: Array<[name: string, path: string, ready: RegExp, signedIn?: boolean]> = [
  // login is what a signed-out visitor sees; seeding a session sends it through
  // the returning-user path instead, which is a different screen.
  ['login', '/app/login', /Continue|Sign In|Password/i, false],
  // These match the screen's own header, which is what the user perceives as
  // "the screen is here". Matching a deep data row instead would measure the
  // slowest API rather than the paint. innerText separates elements with
  // newlines, so the patterns tolerate whitespace between words.
  ['home', '/app/mini/friend/home', /Alpha\s+Home/, true],
  ['later', '/app/mini/friend/later', /Alpha\s+Later/, true],
  ['nutrition', '/app/mini/friend/nutrition', /Alpha\s+Nutrition/, true],
  ['spending', '/app/mini/friend/spending_snapshot', /Alpha\s+Spending/, true],
  ['workout', '/app/mini/friend/workout', /Alpha\s+Workout/, true],
  ['sleep', '/app/mini/friend/sleep_tracker', /Alpha\s+Sleep/, true],
  ['brief', '/app/mini/friend/brief', /Alpha\s+(Brief|Personal)/, true],
]

const server = Bun.serve({
  hostname: '127.0.0.1',
  port: 0,
  async fetch(req) {
    const url = new URL(req.url)
    if (url.pathname === '/api/auth/session') {
      return Response.json({ ok: true, user: null, hires: [] })
    }
    if (url.pathname.startsWith('/api/')) {
      // Shape the empty response like the real payloads: a bare {} makes
      // screens crash on .filter()/.map() and reports as a product bug.
      await new Promise((resolve) => setTimeout(resolve, API_DELAY_MS))
      const empty: Record<string, unknown> = {}
      for (const key of ['hires', 'subscriptions', 'requests', 'methods', 'people', 'nights', 'loops', 'meals', 'logs', 'items', 'entries', 'actions', 'capabilities', 'audit', 'memories', 'workouts', 'habits', 'groups', 'days', 'rows', 'events', 'sessions']) {
        empty[key] = []
      }
      empty.ok = true
      empty.link = { connected: false, pending: false }
      empty.hasMore = false
      return Response.json(empty)
    }
    const file = Bun.file(join(ROOT, url.pathname))
    return new Response(url.pathname !== '/' && (await file.exists()) ? file : Bun.file(join(ROOT, 'index.html')))
  },
})

const browser = await chromium.launch({ headless: true })
const rows: Array<Record<string, unknown>> = []
let failures = 0

try {
  for (const [name, path, ready, signedIn] of screens) {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } })
    let jsKb = 0
    page.on('response', (response) => {
      if (!new URL(response.url()).pathname.endsWith('.js')) return
      const length = response.headers()['content-length']
      if (length) jsKb += Number(length) / 1024
    })
    if (signedIn) {
      await page.addInitScript(() => {
        localStorage.setItem('ha_setup_done', 'friend')
        localStorage.setItem('hirealpha-session', JSON.stringify({
          email: 'perf@example.invalid', phone: '+15550000000', signedInAt: new Date().toISOString(),
        }))
      })
    }

    const started = Date.now()
    await page.goto(`http://127.0.0.1:${server.port}${path}`, { waitUntil: 'domcontentloaded' })

    let readyMs: number | null = null
    let lastText = ''
    const deadline = Date.now() + 15_000
    while (Date.now() < deadline) {
      const text = await page.locator('body').innerText().catch(() => '')
      lastText = text
      if (text.trim() && ready.test(text) && !LOADING.test(text)) {
        readyMs = Date.now() - started
        break
      }
      await page.waitForTimeout(25)
    }

    const paints = await page.evaluate(() => {
      const fcp = (performance.getEntriesByType('paint') as PerformanceEntry[])
        .find((entry) => entry.name === 'first-contentful-paint')
      const nav = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming | undefined
      return { fcp: fcp ? Math.round(fcp.startTime) : null, dcl: nav ? Math.round(nav.domContentLoadedEventEnd) : null }
    }).catch(() => ({ fcp: null, dcl: null }))

    const over = readyMs === null || readyMs > BUDGET_MS
    if (over) failures++
    const row = {
      screen: name,
      readyMs,
      status: readyMs === null ? 'NEVER' : over ? 'OVER' : 'ok',
      fcpMs: paints.fcp,
      jsKb: Math.round(jsKb),
      visibleText: lastText.slice(0, 160).replace(/\s+/g, ' '),
    }
    rows.push(row)
    console.log(
      `${name.padEnd(10)} ${String(readyMs).padStart(5)}ms  fcp ${String(paints.fcp).padStart(4)}ms  js ${String(Math.round(jsKb)).padStart(4)}kb  ${row.status}`,
    )
    await page.close()
  }
} finally {
  await browser.close()
  server.stop()
}

console.log(`\n${rows.length - failures}/${rows.length} screens under ${BUDGET_MS}ms (prod bundle, ${API_DELAY_MS}ms API)`)
if (failures) {
  process.exitCode = 1
  for (const row of rows.filter((r) => r.status !== 'ok')) {
    console.log(`  SLOW ${row.screen}: ${row.readyMs ?? 'never'}ms — "${row.visibleText}"`)
  }
}
