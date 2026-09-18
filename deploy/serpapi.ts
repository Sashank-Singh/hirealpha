/* SerpAPI: the paid, structured view of Google's hotel, flight and local data.
 *
 * The free tier is 250 searches a month and that is the whole budget, so this
 * module is built around not wasting them:
 *
 *  1. It is OFF for real users. Only the phone numbers in SERPAPI_TEST_PHONES
 *     (the bench numbers) reach it; everyone else keeps the free stack
 *     (LangSearch + Brave, OpenStreetMap, Nominatim). The product must never
 *     spend a metered call on a lookup the free path can answer.
 *  2. Identical queries inside the cache window are answered from memory. Bench
 *     re-runs repeat the same hotel and flight searches, and a repeat should
 *     cost nothing.
 *  3. A daily budget (SERPAPI_DAILY_BUDGET, default 25) hard-stops the day's
 *     calls. Each call logs what it spent and what is left.
 *
 * Set SERPAPI_MODE=all to let every user through (a paid plan), =off to disable.
 */

const SERPAPI_BASE = 'https://serpapi.com/search.json'
/** How long an identical query is answered from cache. Hotel and flight answers
 * do not change minute to minute, and a bench run repeats itself. */
const CACHE_TTL_MS = 6 * 60 * 60 * 1000
const CACHE_MAX = 200

type CacheEntry = { at: number; text: string }
const cache = new Map<string, CacheEntry>()

let spentToday = 0
let spentDay = ''

function today(): string {
  return new Date().toISOString().slice(0, 10)
}

export function serpApiKey(): string {
  return process.env.SERPAPI_API_KEY?.trim() || ''
}

/** 'testers' (default), 'all' during a run you mean to pay for, 'off'. */
function mode(): 'testers' | 'all' | 'off' {
  const raw = (process.env.SERPAPI_MODE || 'testers').toLowerCase()
  return raw === 'all' || raw === 'off' ? raw : 'testers'
}

function testerPhones(): string[] {
  return (process.env.SERPAPI_TEST_PHONES || '')
    .split(',')
    .map((p) => p.trim())
    .filter(Boolean)
}

/** Spend a SerpAPI call only for the numbers we are testing with. */
export function serpApiAllowedFor(phone: string | undefined): boolean {
  if (!serpApiKey() || mode() === 'off') return false
  if (mode() === 'all') return true
  const list = testerPhones()
  if (!list.length) return false
  const normalized = String(phone || '').replace(/[^\d+]/g, '')
  return list.some((p) => p.replace(/[^\d+]/g, '') === normalized)
}

export function serpApiBudget(): { spent: number; limit: number; left: number } {
  const limit = Number(process.env.SERPAPI_DAILY_BUDGET || '25') || 25
  if (spentDay !== today()) return { spent: 0, limit, left: limit }
  return { spent: spentToday, limit, left: Math.max(0, limit - spentToday) }
}

/** Test seam. */
export function resetSerpApiState() {
  cache.clear()
  spentToday = 0
  spentDay = ''
}

function cached(key: string): string | null {
  const hit = cache.get(key)
  if (!hit) return null
  if (Date.now() - hit.at > CACHE_TTL_MS) {
    cache.delete(key)
    return null
  }
  return hit.text
}

function remember(key: string, text: string): string {
  if (cache.size >= CACHE_MAX) {
    const oldest = [...cache.entries()].sort((a, b) => a[1].at - b[1].at)[0]
    if (oldest) cache.delete(oldest[0])
  }
  cache.set(key, { at: Date.now(), text })
  return text
}

/** One call, with the ledger. Returns null on any failure so callers fall back. */
async function call(params: Record<string, string>, label: string): Promise<Record<string, unknown> | null> {
  const key = serpApiKey()
  if (!key) return null
  const budget = serpApiBudget()
  if (budget.left <= 0) {
    console.warn(`[serpapi] daily budget spent (${budget.limit}); using the free path for ${label}`)
    return null
  }
  const url = new URL(SERPAPI_BASE)
  url.searchParams.set('api_key', key)
  url.searchParams.set('output', 'json')
  for (const [k, v] of Object.entries(params)) if (v) url.searchParams.set(k, v)
  const started = Date.now()
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(15_000), headers: { Connection: 'close' } })
    const text = await res.text().catch(() => '')
    if (!res.ok) {
      console.warn(`[serpapi] ${label} http ${res.status}: ${text.slice(0, 160)}`)
      return null
    }
    const data = JSON.parse(text) as Record<string, unknown>
    if (data.error) {
      console.warn(`[serpapi] ${label} error: ${String(data.error).slice(0, 160)}`)
      return null
    }
    spentToday = spentDay === today() ? spentToday + 1 : 1
    spentDay = today()
    const left = serpApiBudget().left
    console.log(`[serpapi] ${label} ok in ${Date.now() - started}ms — ${spentToday} spent today, ${left} left`)
    return data
  } catch (err) {
    console.warn(`[serpapi] ${label} failed: ${(err as Error).message.slice(0, 120)}`)
    return null
  }
}

const money = (v: unknown): string => {
  const n = Number(v)
  return Number.isFinite(n) && n > 0 ? `$${Math.round(n)}` : ''
}

/** Real nightly rates for exact dates, with the free-cancellation flag the
 * benchmark's hotel task asks for. */
export async function serpHotelRates(input: {
  query: string
  checkIn: string
  checkOut: string
  currency?: string
}): Promise<string | null> {
  const cacheKey = `hotels|${input.query}|${input.checkIn}|${input.checkOut}`
  const hit = cached(cacheKey)
  if (hit) return hit
  const data = await call(
    {
      engine: 'google_hotels',
      q: input.query,
      check_in_date: input.checkIn,
      check_out_date: input.checkOut,
      currency: input.currency || 'USD',
      adults: '1',
      hl: 'en',
    },
    `hotels ${input.checkIn}→${input.checkOut}`,
  )
  if (!data) return null
  const props = (data.properties as Array<Record<string, unknown>> | undefined) || []
  const lines: string[] = []
  for (const p of props.slice(0, 8)) {
    const name = String(p.name || '').trim()
    if (!name) continue
    const perNight = (p.rate_per_night as { extracted_lowest?: number } | undefined)?.extracted_lowest
    const total = (p.total_rate as { extracted_lowest?: number } | undefined)?.extracted_lowest
    const rating = Number(p.overall_rating)
    const cancels = p.free_cancellation === true
    const bits = [
      money(perNight) ? `${money(perNight)}/night` : '',
      money(total) ? `${money(total)} total` : '',
      cancels ? 'free cancellation' : 'no free-cancellation flag',
      Number.isFinite(rating) && rating > 0 ? `${rating.toFixed(1)} stars` : '',
      String(p.type || '').trim(),
    ].filter(Boolean)
    lines.push(`- ${name}: ${bits.join(', ')}`)
  }
  if (!lines.length) return null
  return remember(
    cacheKey,
    `Live hotel rates for ${input.checkIn} to ${input.checkOut} (Google Hotels, real prices for these dates):\n${lines.join('\n')}\nVerify the rate on the property page before booking; these are the rates Google is showing for those nights.`,
  )
}

/** Real dated fares. Search only — Google hands back booking links, not a seat. */
export async function serpFlightFares(input: {
  from: string
  to: string
  outbound: string
  returnDate?: string
  adults?: number
}): Promise<string | null> {
  const cacheKey = `flights|${input.from}|${input.to}|${input.outbound}|${input.returnDate || ''}`
  const hit = cached(cacheKey)
  if (hit) return hit
  const data = await call(
    {
      engine: 'google_flights',
      departure_id: input.from,
      arrival_id: input.to,
      outbound_date: input.outbound,
      ...(input.returnDate ? { return_date: input.returnDate, type: '1' } : { type: '2' }),
      currency: 'USD',
      hl: 'en',
      adults: String(input.adults || 1),
    },
    `flights ${input.from}→${input.to} ${input.outbound}`,
  )
  if (!data) return null
  const list = [
    ...((data.best_flights as Array<Record<string, unknown>> | undefined) || []),
    ...((data.other_flights as Array<Record<string, unknown>> | undefined) || []),
  ]
  const insights = data.price_insights as { lowest_price?: number; typical_price_range?: unknown } | undefined
  const lines: string[] = []
  for (const it of list.slice(0, 5)) {
    const legs = (it.flights as Array<Record<string, unknown>> | undefined) || []
    const first = legs[0]
    const last = legs[legs.length - 1]
    const airline = String((first?.airline as string) || '')
    const dep = String(((first?.departure_airport as { time?: string } | undefined)?.time) || '')
    const arr = String(((last?.arrival_airport as { time?: string } | undefined)?.time) || '')
    const stops = legs.length > 1 ? `${legs.length - 1} stop${legs.length > 2 ? 's' : ''}` : 'nonstop'
    lines.push(`- ${airline} ${dep} → ${arr}, ${stops}, ${money(it.price)}${it.type ? ` (${it.type})` : ''}`)
  }
  if (!lines.length) return null
  const range = insights?.typical_price_range ? ` Typical range: ${JSON.stringify(insights.typical_price_range)}.` : ''
  return remember(
    cacheKey,
    `Live fares for ${input.from} to ${input.to} on ${input.outbound}${input.returnDate ? ` returning ${input.returnDate}` : ''} (Google Flights):\n${lines.join('\n')}\nSearch only: the airline link is where the seat gets picked, and nothing is booked until the user approves.${range}`,
  )
}

/** Real nearby places with rating and price level, for a pick ask. */
export async function serpLocalPlaces(query: string): Promise<string | null> {
  const cacheKey = `local|${query}`
  const hit = cached(cacheKey)
  if (hit) return hit
  const data = await call({ engine: 'google_local', q: query, hl: 'en' }, `local ${query.slice(0, 40)}`)
  if (!data) return null
  const places = (data.local_results as Array<Record<string, unknown>> | undefined) || []
  const lines: string[] = []
  for (const p of places.slice(0, 8)) {
    const name = String(p.title || '').trim()
    if (!name) continue
    const bits = [
      String(p.type || '').trim(),
      Number(p.rating) > 0 ? `${Number(p.rating).toFixed(1)} stars` : '',
      Number(p.reviews) > 0 ? `${p.reviews} reviews` : '',
      p.price ? `${String(p.price)} price level` : '',
      String(p.address || '').trim(),
    ].filter(Boolean)
    lines.push(`- ${name}: ${bits.join(', ')}`)
  }
  if (!lines.length) return null
  return remember(
    cacheKey,
    `Verified local places (Google):\n${lines.join('\n')}\nRating and price level come from Google; opening hours and whether they can seat you are NOT in this data — confirm before promising a time.`,
  )
}

/** "hotels in the Loop for Sep 25 to Sep 27" — a hotel ask that names dates. */
export function looksLikeHotelAsk(query: string): boolean {
  return /\b(?:hotels?|hostels?|motels?|lodging|accommodations?|resorts?)\b/i.test(query)
}

/** A flight ask: two places and a date-ish word, or the word flight/fare. */
export function looksLikeFlightAsk(query: string): boolean {
  if (!/\b(?:flights?|airfare|airfares|fares?|airline|nonstop|round ?trip)\b/i.test(query)) return false
  return /\b(?:from|to|between|out of|into)\b/i.test(query)
}

/**
 * Every date the ask named, in the order it named them. "Sep 25 to Sep 27" is a
 * check-in and a check-out; resolving only the first one made every stay a
 * single night.
 */
export function datesFromText(text: string, now = new Date()): string[] {
  const out: string[] = []
  const pattern = new RegExp(`\\b(\\d{4}-\\d{2}-\\d{2})\\b|\\b(${MONTHS.join('|')}|${MONTHS.map((m) => m.slice(0, 3)).join('|')})\\.?\\s+(\\d{1,2})\\b`, 'gi')
  for (const match of String(text || '').matchAll(pattern)) {
    if (match[1]) {
      out.push(match[1])
      continue
    }
    const monthName = String(match[2] || '').toLowerCase()
    const month = MONTHS.findIndex((m) => m === monthName || m.startsWith(monthName))
    if (month === -1) continue
    const day = Number(match[3])
    const year = month + 1 < now.getUTCMonth() + 1 ? now.getUTCFullYear() + 1 : now.getUTCFullYear()
    out.push(`${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`)
  }
  return out
}

const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december']

/** Resolve a date the ask named ("Sep 25", "next friday", "2026-09-25") to
 * YYYY-MM-DD, or null. Deliberately small: the model already resolves relative
 * dates in the query it writes, and a wrong date is worse than none. */
export function dateFromText(text: string, now = new Date()): string | null {
  const iso = /\b(\d{4}-\d{2}-\d{2})\b/.exec(text)
  if (iso) return iso[1]!
  const named = new RegExp(`\\b(${MONTHS.join('|')})\\.?\\s+(\\d{1,2})\\b`, 'i').exec(text)
  if (named) {
    const month = MONTHS.indexOf(named[1]!.toLowerCase()) + 1
    const day = Number(named[2])
    const year = month < now.getUTCMonth() + 1 ? now.getUTCFullYear() + 1 : now.getUTCFullYear()
    return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
  }
  const short = new RegExp(`\\b(${MONTHS.map((m) => m.slice(0, 3)).join('|')})\\.?\\s+(\\d{1,2})\\b`, 'i').exec(text)
  if (short) {
    const month = MONTHS.findIndex((m) => m.startsWith(short[1]!.toLowerCase())) + 1
    const day = Number(short[2])
    const year = month < now.getUTCMonth() + 1 ? now.getUTCFullYear() + 1 : now.getUTCFullYear()
    return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
  }
  return null
}
