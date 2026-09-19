/**
 * scrape.do — a rendering proxy, used as the dated-price source when the free
 * ones are throttled or walled. OFF BY DEFAULT, and deliberately so: the
 * founder's call is that the per-call cost is not worth it while trvl can be
 * made to work (serialized providers), so `SCRAPE_DO_TOKEN` is unset everywhere
 * and every caller checks `scrapeDoEnabled()` first. The modules stay because
 * the option is one environment variable away, not because anything spends.
 *
 * Why it exists: `trvl` covers hotels and flights but its upstream providers
 * rate-limit our datacenter IP (429s from kiwi and skiplagged measured), and
 * the Google travel pages refuse a plain fetch. scrape.do renders the page from
 * their own IPs, so Google Hotels comes back with real per-night prices for the
 * exact dates — the thing SerpAPI would have supplied — for ~5s and one credit.
 *
 * Discipline borrowed from the SerpAPI module: a daily call budget, a cache, and
 * an honest null. Never a silent fallback to a listicle.
 */

const ENDPOINT = 'https://api.scrape.do/'
/* Measured: a Google Hotels render is ~2.8MB of HTML in ~5s. Two minutes is
 * the ceiling for a stalled render, not a normal wait. */
const RENDER_TIMEOUT_MS = Number(process.env.SCRAPE_DO_TIMEOUT_MS || 120_000)
/* Free/entry tiers are credit-metered; a hotel ask costs one credit. This cap
 * exists so a loop cannot empty the account overnight. */
const DAILY_BUDGET = Math.max(1, Number(process.env.SCRAPE_DO_DAILY_BUDGET || 40))
const CACHE_TTL_MS = 6 * 60 * 60 * 1000

export function scrapeDoToken(): string {
  return (process.env.SCRAPE_DO_TOKEN || process.env.SCRAPEDO_TOKEN || '').trim()
}

export function scrapeDoEnabled(): boolean {
  return scrapeDoToken().length > 10
}

let spentToday = 0
let spendDay = new Date().toISOString().slice(0, 10)

/** Test seam. */
export function resetScrapeDoState(): void {
  spentToday = 0
  spendDay = new Date().toISOString().slice(0, 10)
  cache.clear()
}

export function scrapeDoBudgetLeft(): number {
  rollDay()
  return Math.max(0, DAILY_BUDGET - spentToday)
}

function rollDay(): void {
  const today = new Date().toISOString().slice(0, 10)
  if (today !== spendDay) {
    spendDay = today
    spentToday = 0
  }
}

const cache = new Map<string, { at: number; body: string }>()
const CACHE_MAX = 40

function cached(key: string): string | null {
  const hit = cache.get(key)
  if (!hit) return null
  return Date.now() - hit.at < CACHE_TTL_MS ? hit.body : null
}

function remember(key: string, body: string): string {
  if (cache.size >= CACHE_MAX) {
    const oldest = [...cache.entries()].sort((a, b) => a[1].at - b[1].at)[0]
    if (oldest) cache.delete(oldest[0])
  }
  cache.set(key, { at: Date.now(), body })
  return body
}

export type ScrapeResult = { ok: true; body: string } | { ok: false; error: string }

/** Fetch a URL through the proxy. `render` costs more but is what JS pages need. */
export async function scrapeDoFetch(url: string, opts?: { render?: boolean }): Promise<ScrapeResult> {
  if (!scrapeDoEnabled()) return { ok: false, error: 'scrape.do is not configured' }
  if (!/^https?:\/\//i.test(url)) return { ok: false, error: 'scrape.do needs an http(s) url' }
  rollDay()
  const key = `${opts?.render ? 'r:' : ''}${url}`
  const hit = cached(key)
  if (hit) return { ok: true, body: hit }
  if (spentToday >= DAILY_BUDGET) {
    return { ok: false, error: `scrape.do daily budget spent (${DAILY_BUDGET} calls)` }
  }
  const params = new URLSearchParams({ token: scrapeDoToken(), url })
  if (opts?.render) params.set('render', 'true')
  spentToday++
  try {
    const res = await fetch(`${ENDPOINT}?${params.toString()}`, {
      signal: AbortSignal.timeout(RENDER_TIMEOUT_MS),
    })
    const body = await res.text()
    if (!res.ok) {
      /* The proxy answers with its own error text; surfacing a slice of it is
       * how a bad token or a spent account becomes visible in the log. */
      console.warn(`[scrape.do] ${res.status}: ${body.slice(0, 160)}`)
      return { ok: false, error: `scrape.do answered ${res.status}` }
    }
    if (!body.trim()) return { ok: false, error: 'scrape.do returned an empty body' }
    return { ok: true, body: remember(key, body) }
  } catch (err) {
    console.warn('[scrape.do] failed', err instanceof Error ? err.message : err)
    return { ok: false, error: 'scrape.do did not answer' }
  }
}
