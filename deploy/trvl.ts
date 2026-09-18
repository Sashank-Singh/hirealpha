/* trvl — real flight, hotel and ground search, from one local binary.
 *
 * https://github.com/MikkoParkkola/trvl (PolyForm Noncommercial; the operator
 * confirmed the licence is settled for our use). It merges Google Flights,
 * Kiwi and Skiplagged for fares and six sources for hotels, and it is honest
 * about the sources that fail: a provider that gets blocked shows up in
 * `provider_statuses` instead of vanishing.
 *
 * Two things it does NOT do, both confirmed against the binary:
 *  - it takes IATA codes only ("invalid origin: must be exactly 3 uppercase
 *    letters"), so a city name has to be resolved here;
 *  - `--currency` converts the table display, not the JSON. Prices come back in
 *    whatever the provider quoted (EUR in practice), so anything we state as
 *    dollars is converted at a rate we can name, never guessed.
 *
 * Everything is best-effort: no binary, no network, a timeout, or a non-JSON
 * reply all return null and the caller carries on with the next source.
 */
import { formatFares, type FlightRow } from '../spectrum/shared/flightExtract'

/** The base ceiling for the binary. The two search kinds below narrow it. */
const TRVL_TIMEOUT_MS = Number(process.env.TRVL_TIMEOUT_MS || 50_000)
/**
 * A throttled flight source must not hold a turn open.
 *
 * Measured in production: `--timeout 20s` is a per-request ceiling inside the
 * binary, and its retry/backoff storm ran the command to our own 45s kill
 * (exit 137) with three 429 retries on the way — the user waited 45s for a web
 * fallback. A one-way search from a single airport pair answers inside 25s.
 *
 * A round trip does not: the return leg doubles the provider work, and after
 * the flight sources trvl still walks its ground-transport providers
 * (rome2rio 403, ferryhopper no-route) before printing. Measured 2026-09-18:
 * `flights JFK ORD <date> --format json --timeout 25s --return <date>` was
 * killed by this ceiling at 25005ms with nothing returned, while the same
 * command run by hand produced 12 fares in ~30s. So the return-trip ceiling is
 * 45s — still bounded, but past the wall the binary needs.
 */
const TRVL_FLIGHT_TIMEOUT_MS = Number(process.env.TRVL_FLIGHT_TIMEOUT_MS || Math.min(45_000, TRVL_TIMEOUT_MS))
/**
 * A hotel search measures 20-50s (six booking sources, room-level enrichment),
 * longer than the flight one, and still has to leave room for the turn to
 * write its answer. The ceiling bounds a stalled provider without cutting off a
 * search that is merely slow.
 */
const TRVL_HOTEL_TIMEOUT_MS = Number(process.env.TRVL_HOTEL_TIMEOUT_MS || TRVL_TIMEOUT_MS)
const CACHE_TTL_MS = 6 * 60 * 60 * 1000
const CACHE_MAX = 120

export function trvlEnabled(): boolean {
  return process.env.TRVL_ENABLED !== '0'
}

/**
 * A source that answered 429 is left alone for a while.
 *
 * Measured from the Coolify box: kiwi and skiplagged throttle the datacenter IP
 * on every flight search, so each ask burned the full 45s and still produced
 * nothing. The cooldown means the first ask pays that cost and the next twenty
 * minutes go straight to the next source in the chain.
 */
const RATE_LIMITED_COOLDOWN_MS = Number(process.env.TRVL_RATE_LIMIT_COOLDOWN_MS || 20 * 60 * 1000)
let rateLimitedUntil = 0

function noteRateLimit(kind: string, stderr: string) {
  if (!/\b429\b|rate ?limit|too many requests/i.test(stderr)) return
  rateLimitedUntil = Date.now() + RATE_LIMITED_COOLDOWN_MS
  console.warn(`[trvl] ${kind} providers rate limit this host; skipping trvl ${kind} for ${Math.round(RATE_LIMITED_COOLDOWN_MS / 60000)}min`)
}

/** Test seam. */
export function resetTrvlRateLimit() {
  rateLimitedUntil = 0
}

/** Test seam: stand in for the stderr note the real runner takes. */
export function noteTrvlRateLimitForTest(kind: string, stderr: string) {
  noteRateLimit(kind, stderr)
}

function trvlBin(): string {
  return process.env.TRVL_BIN?.trim() || 'trvl'
}

type CacheEntry = { at: number; value: string }
const cache = new Map<string, CacheEntry>()

function cached(key: string): string | null {
  const hit = cache.get(key)
  if (!hit) return null
  if (Date.now() - hit.at > CACHE_TTL_MS) {
    cache.delete(key)
    return null
  }
  return hit.value
}

function remember(key: string, value: string): string {
  if (cache.size >= CACHE_MAX) {
    const oldest = [...cache.entries()].sort((a, b) => a[1].at - b[1].at)[0]
    if (oldest) cache.delete(oldest[0])
  }
  cache.set(key, { at: Date.now(), value })
  return value
}

/** Test seam: swap the process runner. */
export type TrvlRunner = (args: string[], timeoutMs: number) => Promise<unknown | null>
let runner: TrvlRunner = defaultRunner

export function setTrvlRunner(next: TrvlRunner | null) {
  runner = next || defaultRunner
}

/** Test seam: drop cached answers, the day's FX rate and any cooldown. */
export function resetTrvlState() {
  cache.clear()
  fxRate = null
  runner = defaultRunner
  rateLimitedUntil = 0
}

async function defaultRunner(args: string[], timeoutMs: number): Promise<unknown | null> {
  const started = Date.now()
  let proc: ReturnType<typeof Bun.spawn>
  try {
    proc = Bun.spawn([trvlBin(), ...args], {
      stdout: 'pipe',
      stderr: 'pipe',
      env: { ...process.env, NO_COLOR: '1' },
    })
  } catch (err) {
    // No binary in this image, or it is not executable.
    console.warn(`[trvl] spawn failed: ${(err as Error).message.slice(0, 160)}`)
    return null
  }
  const timer = setTimeout(() => {
    try {
      proc.kill(9)
    } catch {
      /* already gone */
    }
  }, timeoutMs)
  try {
    // stdout/stderr are streams here (both were spawned as 'pipe'); the Bun type
    // also allows a file descriptor, which Response cannot take.
    const stdout = proc.stdout as ReadableStream<Uint8Array> | undefined
    const stderr = proc.stderr as ReadableStream<Uint8Array> | undefined
    const [out, err] = await Promise.all([new Response(stdout ?? '').text(), new Response(stderr ?? '').text()])
    const code = await proc.exited
    const ms = Date.now() - started
    if (code !== 0) {
      noteRateLimit(args[0] || 'search', err)
      // The reason lives on stderr: blocked providers, a rotated API version,
      // a route it could not resolve. Without this the caller only ever sees
      // "no results" and the cause is invisible from the container log.
      console.warn(`[trvl] ${args.join(' ').slice(0, 80)} exited ${code} in ${ms}ms: ${err.replace(/\s+/g, ' ').slice(-240)}`)
      return null
    }
    const start = out.indexOf('{')
    if (start === -1) {
      console.warn(`[trvl] ${args[0]} produced no JSON in ${ms}ms (stdout ${out.length}b): ${out.slice(0, 120)}`)
      return null
    }
    const data = JSON.parse(out.slice(start)) as unknown
    const count = Number((data as { count?: number }).count || (data as { flights?: unknown[] }).flights?.length || (data as { hotels?: unknown[] }).hotels?.length || 0)
    console.log(`[trvl] ${args.join(' ').slice(0, 80)} ok in ${ms}ms (${count} results)`)
    return data
  } catch (err) {
    console.warn(`[trvl] ${args[0]} failed after ${Date.now() - started}ms: ${(err as Error).message.slice(0, 160)}`)
    return null
  } finally {
    clearTimeout(timer)
  }
}

/** City, area or code → the IATA list trvl accepts ("JFK,EWR,LGA"). */
const AIRPORTS: Record<string, string> = {
  'new york': 'JFK,EWR,LGA', nyc: 'JFK,EWR,LGA', ny: 'JFK,EWR,LGA', manhattan: 'JFK,EWR,LGA',
  chicago: 'ORD,MDW', chi: 'ORD,MDW', 'san francisco': 'SFO,OAK', 'bay area': 'SFO,OAK,SJC', sf: 'SFO,OAK',
  'los angeles': 'LAX,BUR,LGB,SNA', la: 'LAX,BUR,LGB,SNA',
  boston: 'BOS', seattle: 'SEA', austin: 'AUS', denver: 'DEN', miami: 'MIA,FLL',
  atlanta: 'ATL', dallas: 'DFW,DAL', houston: 'IAH,HOU', phoenix: 'PHX', vegas: 'LAS',
  'las vegas': 'LAS', philadelphia: 'PHL', washington: 'DCA,IAD,BWI', dc: 'DCA,IAD,BWI',
  portland: 'PDX', nashville: 'BNA', 'new orleans': 'MSY', minneapolis: 'MSP',
  detroit: 'DTW', cleveland: 'CLE', columbus: 'CMH', cincinnati: 'CVG', pittsburgh: 'PIT',
  charlotte: 'CLT', orlando: 'MCO', tampa: 'TPA', 'san diego': 'SAN', 'san jose': 'SJC',
  london: 'LHR,LGW,STN', paris: 'CDG,ORY', rome: 'FCO', milan: 'MXP,LIN',
  barcelona: 'BCN', madrid: 'MAD', amsterdam: 'AMS', berlin: 'BER', munich: 'MUC',
  zurich: 'ZRH', vienna: 'VIE', lisbon: 'LIS', dublin: 'DUB', istanbul: 'IST',
  tokyo: 'NRT,HND', osaka: 'KIX', seoul: 'ICN', beijing: 'PEK,PKX', shanghai: 'PVG,SHA',
  'hong kong': 'HKG', singapore: 'SIN', bangkok: 'BKK', sydney: 'SYD', melbourne: 'MEL',
  auckland: 'AKL', toronto: 'YYZ', vancouver: 'YVR', montreal: 'YUL',
  mexico: 'MEX', cancun: 'CUN', bogota: 'BOG', lima: 'LIM', 'sao paulo': 'GRU',
  dubai: 'DXB', doha: 'DOH', delhi: 'DEL', mumbai: 'BOM', bengaluru: 'BLR',
  cairo: 'CAI', johannesburg: 'JNB', 'cape town': 'CPT', 'tel aviv': 'TLV',
}

/**
 * Airport codes for a place the ask named: a code stays as it is, a known city
 * becomes its airport list, and anything else returns null so the caller falls
 * through to a source that understands free text.
 */
export function airportsFor(place: string): string | null {
  const raw = String(place || '').trim()
  if (!raw) return null
  const bare = raw.replace(/[^A-Za-z, ]/g, ' ').trim()
  if (/^[A-Z]{3}(?:,[A-Z]{3})*$/.test(bare)) return bare
  const key = bare.toLowerCase().replace(/\b(?:airport|intl|international|the)\b/g, ' ').replace(/\s+/g, ' ').trim()
  if (AIRPORTS[key]) return AIRPORTS[key]!
  /* The city is not always alone in the phrase ("New York City", "Chicago
   * downtown"), and the leading words are the name in every such case; a
   * one-word lookup alone missed them and skipped every fare source. */
  const words = key.split(' ').filter(Boolean)
  for (const take of [2, 3]) {
    const phrase = words.slice(0, take).join(' ')
    if (AIRPORTS[phrase]) return AIRPORTS[phrase]!
  }
  return words[0] ? AIRPORTS[words[0]] || null : null
}

/** EUR→USD, cached for the day, from a keyless ECB feed. Null when unavailable
 * so a dollar figure is never invented. */
let fxRate: { at: string; usd: number } | null = null
async function eurToUsd(): Promise<number | null> {
  const today = new Date().toISOString().slice(0, 10)
  if (fxRate && fxRate.at === today) return fxRate.usd
  try {
    const res = await fetch('https://api.frankfurter.dev/v1/latest?base=EUR&symbols=USD', {
      signal: AbortSignal.timeout(8000),
      headers: { Accept: 'application/json', Connection: 'close' },
    })
    if (!res.ok) return null
    const data = (await res.json()) as { date?: string; rates?: { USD?: number } }
    const usd = Number(data.rates?.USD)
    if (!Number.isFinite(usd) || usd <= 0) return null
    fxRate = { at: today, usd }
    return usd
  } catch {
    return null
  }
}

type TrvlLeg = {
  departure_airport?: { code?: string }
  arrival_airport?: { code?: string }
  departure_time?: string
  arrival_time?: string
  airline?: string
  flight_number?: string
}
type TrvlFlight = {
  price?: number
  currency?: string
  duration?: number
  stops?: number
  provider?: string
  booking_url?: string
  legs?: TrvlLeg[]
}

/** Fares for one route and date, as a block the model answers from. */
export async function trvlFlights(input: {
  from: string
  to: string
  date: string
  returnDate?: string
  cabin?: string
  maxStops?: number | null
}): Promise<string | null> {
  if (!trvlEnabled()) return null
  const from = airportsFor(input.from)
  const to = airportsFor(input.to)
  if (!from || !to || !/^\d{4}-\d{2}-\d{2}$/.test(input.date)) return null
  const key = `flights|${from}|${to}|${input.date}|${input.returnDate || ''}|${input.cabin || ''}|${input.maxStops ?? ''}`
  const hit = cached(key)
  if (hit) return hit
  // Throttled ten minutes ago is still throttled: do not spend 20s finding out.
  if (Date.now() < rateLimitedUntil) return null

  /* A city maps to several airports and trvl searches every pair: JFK,EWR,LGA
   * × ORD,MDW is six routes, doubled for a round trip. Measured from the
   * container that fanned out into skiplagged and kiwi 429s and blew past both
   * this timeout and the bot's patience (exit 137 = our own kill). The primary
   * airport answers first; TRVL_MAX_AIRPORTS widens it deliberately. */
  const maxAirports = Math.max(1, Number(process.env.TRVL_MAX_AIRPORTS || '1') || 1)
  const fromIata = from.split(',').slice(0, maxAirports).join(',')
  const toIata = to.split(',').slice(0, maxAirports).join(',')
  const args = ['flights', fromIata, toIata, input.date, '--format', 'json', '--timeout', `${Math.max(8, Math.round(TRVL_FLIGHT_TIMEOUT_MS / 1000) - 5)}s`]
  if (input.returnDate) args.push('--return', input.returnDate)
  if (input.cabin) args.push('--cabin', input.cabin)
  if (input.maxStops === 0) args.push('--stops', 'nonstop')

  const data = (await runner(args, TRVL_FLIGHT_TIMEOUT_MS)) as { flights?: TrvlFlight[]; price_position?: { verdict?: string } } | null
  const flights = data?.flights || []
  if (!flights.length) return null

  const rate = await eurToUsd()
  const converted = flights.map((f) => f.currency === 'USD')
  const needsFx = converted.includes(false)
  const rows: FlightRow[] = []
  for (const f of flights.slice(0, 8)) {
    const price = Number(f.price)
    if (!Number.isFinite(price) || price <= 0) continue
    const currency = String(f.currency || '')
    const usd = currency === 'USD' ? price : needsFx && rate ? price * rate : 0
    const first = f.legs?.[0]
    const last = f.legs?.[f.legs.length - 1]
    rows.push({
      priceUsd: usd || price,
      currency: usd ? 'USD' : currency || 'EUR',
      airline: String(first?.airline || f.provider || '').trim(),
      flightNumber: String(first?.flight_number || '').trim() || null,
      stops: Number.isFinite(Number(f.stops)) ? Number(f.stops) : null,
      departTime: first?.departure_time ? first.departure_time.slice(11, 16) : null,
      arriveTime: last?.arrival_time ? last.arrival_time.slice(11, 16) : null,
      duration: Number.isFinite(Number(f.duration)) ? `${Math.floor(Number(f.duration) / 60)}h ${Number(f.duration) % 60}m` : null,
      travelDate: input.date,
      bookingUrl: f.booking_url || null,
    })
  }
  if (!rows.length) return null
  rows.sort((a, b) => a.priceUsd - b.priceUsd)
  /* The providers return one row per itinerary variant, so a single flight
   * number arrives three times at the same price with different return legs —
   * measured on JFK→ORD: four "JetBlue B6 405, $336" rows (plus a "JetBlue
   * Airways" spelling of the same one) that the model then repeated as
   * separate options. Same airline, same flight number, same price is one
   * option; the shortest total duration is the honest representative. */
  const deduped: FlightRow[] = []
  const seenFare = new Map<string, number>()
  for (const row of rows) {
    const key = `${row.airline.toLowerCase().replace(/\s+(?:airways|airlines)$/, '')}|${row.flightNumber || ''}|${Math.round(row.priceUsd)}`
    const at = seenFare.get(key)
    if (at === undefined) {
      seenFare.set(key, deduped.length)
      deduped.push(row)
      continue
    }
    if (minutesOf(row) < minutesOf(deduped[at]!)) deduped[at] = row
  }
  rows.length = 0
  rows.push(...deduped)

  const currencies = [...new Set(flights.map((f) => f.currency).filter(Boolean))]
  const fxNote =
    currencies.length === 1 && currencies[0] !== 'USD'
      ? rate
        ? ` Prices converted from ${currencies[0]} at ${rate.toFixed(3)} USD (ECB rate for today).`
        : ` Prices are in ${currencies[0]}; no conversion rate was available, so do not restate them as dollars.`
      : ''
  const verdict = data?.price_position?.verdict
  const verdictNote = verdict && verdict !== 'unknown' ? ` Price position on this route: ${verdict}.` : ''
  /* A round-trip search returns combined itineraries; the label has to say so,
   * or the model reads a two-leg price as a one-way fare for the outbound date
   * (measured: "American's 6:55 AM nonstop ($326 each way...)" for a $326
   * round-trip itinerary). */
  const label = input.returnDate
    ? `from ${from} to ${to}: out ${input.date}, back ${input.returnDate}`
    : `from ${from} to ${to} on ${input.date}`
  const legNote = input.returnDate ? ' Each price is for the full round trip (both legs), not per leg.' : ''
  return remember(key, `${formatFares(rows, { label })}${legNote}${fxNote}${verdictNote}`)
}

/** "2h 53m" / "45m" → 173 / 45; Infinity when the duration is missing. */
function minutesOf(row: FlightRow): number {
  const m = String(row.duration || '').match(/(?:(\d+)\s*h)?\s*(?:(\d+)\s*m)?/i)
  const hours = Number(m?.[1] || 0)
  const mins = Number(m?.[2] || 0)
  const total = hours * 60 + mins
  return total > 0 ? total : Infinity
}

type TrvlRoom = {
  name?: string
  price?: number
  nightly_price?: number
  total_price?: number
  currency?: string
  provider?: string
  /** The room-level cancellation truth: a refundable rate carries a real
   * cancellation policy, a saver rate reads "Non-refundable". */
  refundable?: boolean
  cancellation_policy?: string
}
type TrvlHotel = {
  name?: string
  stars?: number
  rating?: number
  review_count?: number
  price?: number
  currency?: string
  address?: string
  distance_km?: number
  booking_url?: string
  room_types?: TrvlRoom[]
  sources?: unknown
}
export type TrvlHotelRow = {
  name: string
  stars: number
  rating: number
  reviews: number
  priceUsd: number
  currency: string
  address: string
  bookingUrl: string
  distanceKm: number
  /** Cheapest nightly USD rate whose own room entry says it is refundable, or
   * null when no room entry states a policy. */
  refundableUsd: number | null
  /** The room-level cancellation wording, when the source carries it. */
  cancellation: string | null
}

/** One room's nightly rate in USD, or 0 when it does not carry a number. */
function roomNightlyUsd(room: TrvlRoom, rate: number | null): number {
  const nightly = Number(room.nightly_price ?? room.price)
  if (!Number.isFinite(nightly) || nightly <= 0) return 0
  const currency = String(room.currency || '')
  return currency === 'USD' || !currency ? nightly : rate ? nightly * rate : 0
}

/** The refundable rate and the cancellation wording from the room entries. A
 * top-level price is a headline (often a non-refundable saver rate) and says
 * nothing about cancellation, which is exactly the constraint the hotel task
 * scores. */
function cancellationFromRooms(rooms: TrvlRoom[], rate: number | null): { refundableUsd: number | null; cancellation: string | null } {
  let refundableUsd: number | null = null
  let cancellation: string | null = null
  for (const room of rooms) {
    const policy = String(room.cancellation_policy || '').trim()
    if (policy && !cancellation) cancellation = policy.slice(0, 80)
    if (room.refundable !== true) continue
    const usd = roomNightlyUsd(room, rate)
    if (usd > 0 && (refundableUsd === null || usd < refundableUsd)) refundableUsd = usd
  }
  return { refundableUsd, cancellation }
}

/** The hotel rows behind the block, for callers that want the structure. */
export async function trvlHotelRows(input: { city: string; checkin: string; checkout: string }): Promise<TrvlHotelRow[]> {
  const data = (await trvlHotelsRaw(input)) as { hotels?: TrvlHotel[] } | null
  const hotels = data?.hotels || []
  if (!hotels.length) return []
  const rate = await eurToUsd()
  return hotels
    .map((h) => {
      const price = Number(h.price)
      const currency = String(h.currency || '')
      const usd = currency === 'USD' ? price : rate ? price * rate : 0
      const rooms = Array.isArray(h.room_types) ? h.room_types : []
      const { refundableUsd, cancellation } = cancellationFromRooms(rooms, rate)
      return {
        name: String(h.name || '').trim(),
        stars: Number(h.stars) || 0,
        rating: Number(h.rating) || 0,
        reviews: Number(h.review_count) || 0,
        priceUsd: Math.round(usd || price),
        currency: usd ? 'USD' : currency || 'EUR',
        address: String(h.address || '').trim(),
        bookingUrl: String(h.booking_url || '').trim(),
        distanceKm: Number(h.distance_km) || 0,
        refundableUsd: refundableUsd === null ? null : Math.round(refundableUsd),
        cancellation,
      }
    })
    .filter((h) => h.name && h.priceUsd > 0)
    .map((h) => ({ ...h, distanceKm: Math.round(h.distanceKm * 10) / 10 }))
}

async function trvlHotelsRaw(input: { city: string; checkin: string; checkout: string }): Promise<unknown | null> {
  if (!trvlEnabled()) return null
  const city = String(input.city || '').trim()
  if (!city || !/^\d{4}-\d{2}-\d{2}$/.test(input.checkin) || !/^\d{4}-\d{2}-\d{2}$/.test(input.checkout)) return null
  return runner(['hotels', city, '--checkin', input.checkin, '--checkout', input.checkout, '--format', 'json'], TRVL_HOTEL_TIMEOUT_MS)
}

/**
 * The known city inside a place phrase, or null.
 *
 * The binary's location resolver is not monotonic in cleanliness: measured on
 * v1.21.6, "Chicago" returns 126 properties with Loop inventory 0.02-0.7 km out
 * and room-level cancellation rates, while the neighborhood phrase "Chicago
 * Loop" came back with 858 rentals and zero usable hotels. The city name is
 * therefore the reliable search key, and the neighborhood is what the distance
 * ranking and filter resolve.
 */
export function knownCityIn(area: string): string | null {
  const words = String(area || '')
    .toLowerCase()
    .replace(/[^a-z\s]/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
  for (let i = 0; i < words.length; i++) {
    const pair = `${words[i]} ${words[i + 1] || ''}`.trim()
    if (AIRPORTS[pair]) return pair
    if (AIRPORTS[words[i]!]) return words[i]!
  }
  return null
}

export type TrvlHotelQuery = {
  city: string
  checkin: string
  checkout: string
  /** The nightly ceiling the ask named ("under $250/night"). Rows above it are
   * dropped rather than ranked, so the reply cannot present an over-budget
   * property as a candidate. */
  maxPricePerNight?: number
  /** The ask required free cancellation: keep only rooms whose own entry says
   * they are refundable, and never present a non-refundable rate as free. */
  freeCancellation?: boolean
  /** The ask named an area ("near the Loop"): properties the source measured
   * farther than this are dropped. */
  maxDistanceKm?: number
}

/** Real rooms and nightly rates for the exact dates, from six sources. */
export async function trvlHotels(input: TrvlHotelQuery): Promise<string | null> {
  const key = `hotels|${input.city}|${input.checkin}|${input.checkout}|${input.maxPricePerNight ?? ''}|${input.freeCancellation ? 1 : 0}|${input.maxDistanceKm ?? ''}`
  const hit = cached(key)
  if (hit) return hit
  let rows = await trvlHotelRows(input)
  if (!rows.length) return null
  const notes: string[] = []
  if (input.freeCancellation) {
    /* The room entries are the only cancellation truth the source carries; a
     * headline price with no room detail is not evidence either way. Rows with
     * a refundable room are kept and priced at that rate; rows with a stated
     * non-refundable policy are excluded, because the ask made free
     * cancellation a hard constraint. */
    const refundable = rows.filter((h) => h.refundableUsd !== null)
    const unknown = rows.filter((h) => h.refundableUsd === null && !h.cancellation)
    const kept = [...refundable, ...unknown]
    notes.push(
      refundable.length
        ? `${refundable.length} of ${rows.length} show a free-cancellation rate below.`
        : 'No room entry in this result stated a free-cancellation rate.',
    )
    if (kept.length) rows = kept
    /* A property can carry both a saver and a flexible rate; the constraint is
     * only met at the refundable one, so that is the rate this block prices. */
    rows = rows.map((h) => (h.refundableUsd !== null ? { ...h, priceUsd: h.refundableUsd } : h))
  }
  if (input.maxPricePerNight && input.maxPricePerNight > 0) {
    const within = rows.filter((h) => h.priceUsd <= input.maxPricePerNight!)
    notes.push(
      within.length
        ? `All shown are at or under the $${input.maxPricePerNight}/night ceiling.`
        : `Nothing on these nights came in at or under $${input.maxPricePerNight}/night.`,
    )
    if (within.length) rows = within
  }
  if (input.maxDistanceKm && input.maxDistanceKm > 0) {
    /* A city search returns the whole metro (an O'Hare property reads 35 km out
     * for a Loop ask). Only measured properties can be filtered; an unmeasured
     * row is kept and shown without a distance. */
    const near = rows.filter((h) => !h.distanceKm || h.distanceKm <= input.maxDistanceKm!)
    if (near.length) rows = near
    else notes.push(`No result carried a measured distance under ${input.maxDistanceKm} km.`)
  }
  /* A refundable row leads when the ask made free cancellation a hard
   * constraint: the list is capped at eight, and distance alone filled it with
   * rows whose cancellation was not stated while the eleven real
   * free-cancellation rates sat below the cut. Measured production block that
   * made this concrete: "14 of 134 show a free-cancellation rate below" while
   * all eight shown rows read "cancellation not stated" — the refundable rows
   * had no distance and the old ranker kept only the measured ones. */
  const confirmedFirst = (a: TrvlHotelRow, b: TrvlHotelRow) =>
    (input.freeCancellation ? Number(b.refundableUsd !== null) - Number(a.refundableUsd !== null) : 0)
  /* Distance leads when the ask named an area, then the cheapest rate: the ask
   * was almost always "near where I am", and a distant bargain is not the
   * answer to it. An unmeasured row sorts after a measured one but is never
   * dropped for lacking a distance. */
  const byDistanceThenPrice = (list: TrvlHotelRow[]) =>
    [...list].sort((a, b) => {
      const da = a.distanceKm > 0 ? a.distanceKm : Number.POSITIVE_INFINITY
      const db = b.distanceKm > 0 ? b.distanceKm : Number.POSITIVE_INFINITY
      return da - db || a.priceUsd - b.priceUsd
    })
  const ranked = byDistanceThenPrice(rows).sort(confirmedFirst)
  const lines = ranked.slice(0, 8).map((h) => {
    const bits = [
      `$${h.priceUsd}/night`,
      h.stars ? `${h.stars}-star` : '',
      h.rating ? `${Math.round(h.rating * 10) / 10} rating` : '',
      h.reviews ? `${h.reviews} reviews` : '',
      h.address || '',
      h.distanceKm ? `${h.distanceKm} km out` : '',
      h.refundableUsd !== null ? `free-cancellation rate $${h.refundableUsd}/night` : h.cancellation ? h.cancellation : '',
      h.refundableUsd === null && !h.cancellation ? 'cancellation not stated' : '',
    ].filter(Boolean)
    return `- ${h.name}: ${bits.join(', ')}`
  })
  const caveat = notes.length ? ` ${notes.join(' ')}` : ''
  return remember(
    key,
    `Live hotel rates for ${input.checkin} to ${input.checkout} in ${input.city} (merged from six booking sources):\n${lines.join('\n')}\nThese are real rates for those nights.${caveat} The final total and the exact cancellation deadline still come from the booking page, so confirm them there before promising either.`,
  )
}
