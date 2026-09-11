/**
 * Screen load TIME harness. app-load.ts measures transferred bytes; this
 * measures what the user actually waits for: time from navigation start to the
 * screen's own content being visible, per screen, with a hard budget.
 *
 * Run:  bun testbed/performance/screen-time.ts [baseUrl]
 *       (default http://localhost:5173 — a running dev server)
 *
 * Reports, per screen:
 *   ready   — ms until meaningful content is on screen (no skeleton/loader)
 *   fcp     — first contentful paint
 *   api     — number and slowest of the screen's own API calls
 * Fails when any screen exceeds BUDGET_MS.
 */
import { chromium } from 'playwright'

const base = process.argv[2] || 'http://localhost:5173'
const BUDGET_MS = 1000

type Screen = { name: string; path: string; readyText?: RegExp; needsSession?: boolean }

const screens: Screen[] = [
  { name: 'landing', path: '/', readyText: /people in your texts|Get started|HireAlpha/i },
  { name: 'login', path: '/app/login', readyText: /Continue|Sign in|password/i },
  { name: 'home', path: '/app/mini/friend/home', readyText: /today|Good|morning|Today/i, needsSession: true },
  { name: 'later', path: '/app/mini/friend/later', readyText: /later|today|nothing/i, needsSession: true },
  { name: 'nutrition', path: '/app/mini/friend/nutrition', readyText: /protein|calorie|meal|log/i, needsSession: true },
  { name: 'spending', path: '/app/mini/friend/spending_snapshot', readyText: /spent|spend|budget|\$/i, needsSession: true },
  { name: 'workout', path: '/app/mini/friend/workout', readyText: /train|workout|exercise|rest/i, needsSession: true },
  { name: 'sleep', path: '/app/mini/friend/sleep_tracker', readyText: /sleep|hours|bed/i, needsSession: true },
]

const LOADING = /Loading|Checking|Fetching|One moment|loading your/i

const browser = await chromium.launch({ headless: true })
const results: Array<Record<string, unknown>> = []
let failures = 0

try {
  for (const screen of screens) {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } })
    const apiCalls: Array<{ url: string; ms: number }> = []
    page.on('response', async (response) => {
      const url = new URL(response.url())
      if (!url.pathname.startsWith('/api/')) return
      const timing = response.request().timing()
      apiCalls.push({ url: url.pathname + url.search.slice(0, 40), ms: Math.round(timing.responseEnd - timing.requestStart) })
    })
    await page.addInitScript((withSession) => {
      localStorage.setItem('ha_setup_done', 'friend')
      if (withSession) {
        localStorage.setItem('hirealpha-session', JSON.stringify({
          email: 'perf@example.invalid', phone: '+15550000000', signedInAt: new Date().toISOString(),
        }))
      }
    }, Boolean(screen.needsSession))

    const started = Date.now()
    await page.goto(`${base}${screen.path}`, { waitUntil: 'domcontentloaded' })

    let readyMs: number | null = null
    let lastText = ''
    const deadline = Date.now() + 15_000
    while (Date.now() < deadline) {
      const text = await page.locator('body').innerText().catch(() => '')
      lastText = text
      const hasContent = text.trim().length > 0
      const stillLoading = LOADING.test(text)
      const matches = screen.readyText ? screen.readyText.test(text) : hasContent
      if (hasContent && matches && !stillLoading) { readyMs = Date.now() - started; break }
      await page.waitForTimeout(50)
    }

    const paints = await page.evaluate(() => {
      const entries = performance.getEntriesByType('paint') as PerformanceEntry[]
      const fcp = entries.find((e) => e.name === 'first-contentful-paint')
      const nav = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming | undefined
      return {
        fcp: fcp ? Math.round(fcp.startTime) : null,
        domContentLoaded: nav ? Math.round(nav.domContentLoadedEventEnd) : null,
        jsTransferred: performance.getEntriesByType('resource')
          .filter((r) => (r as PerformanceResourceTiming).name.endsWith('.js'))
          .reduce((sum, r) => sum + ((r as PerformanceResourceTiming).transferSize || 0), 0),
      }
    }).catch(() => ({ fcp: null, domContentLoaded: null, jsTransferred: 0 }))

    const slowestApi = apiCalls.slice().sort((a, b) => b.ms - a.ms)[0]
    const over = readyMs === null || readyMs > BUDGET_MS
    if (over) failures++
    const record = {
      screen: screen.name,
      readyMs,
      budgetMs: BUDGET_MS,
      status: readyMs === null ? 'NEVER' : over ? 'OVER' : 'ok',
      fcpMs: paints.fcp,
      jsKb: Math.round((paints.jsTransferred || 0) / 1024),
      apiCalls: apiCalls.length,
      slowestApiMs: slowestApi?.ms ?? null,
      slowestApi: slowestApi?.url ?? null,
      visibleText: lastText.slice(0, 200).replace(/\s+/g, ' '),
    }
    results.push(record)
    console.log(JSON.stringify(record))
    await page.close()
  }
} finally {
  await browser.close()
}

console.log(`\n${results.length - failures}/${results.length} screens under ${BUDGET_MS}ms`)
if (failures) {
  console.log('\nSLOW SCREENS:')
  for (const r of results) {
    if (r.status !== 'ok') console.log(`  ${r.screen}: ${r.readyMs ?? 'never'}ms (api ${r.apiCalls}x, slowest ${r.slowestApiMs}ms ${r.slowestApi ?? ''})`)
  }
  process.exitCode = 1
}
