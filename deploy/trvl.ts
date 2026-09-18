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

const TRVL_TIMEOUT_MS = Number(process.env.TRVL_TIMEOUT_MS || 45_000)
const CACHE_TTL_MS = 6 * 60 * 60 * 1000
const CACHE_MAX = 120

export function trvlEnabled(): boolean {
  return process.env.TRVL_ENABLED !== '0'
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

/** Test seam: drop cached answers and the day's FX rate. */
export function resetTrvlState() {
  cache.clear()
  fxRate = null
  runner = defaultRunner
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
  'new york': 'JFK,EWR,LGA', nyc: 'JFK,EWR,LGA', manhattan: 'JFK,EWR,LGA',
  chicago: 'ORD,MDW', 'san francisco': 'SFO,OAK', 'bay area': 'SFO,OAK,SJC',
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
  const first = key.split(' ')[0]!
  return AIRPORTS[first] || null
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

  const args = ['flights', from, to, input.date, '--format', 'json']
  if (input.returnDate) args.push('--return', input.returnDate)
  if (input.cabin) args.push('--cabin', input.cabin)
  if (input.maxStops === 0) args.push('--stops', 'nonstop')

  const data = (await runner(args, TRVL_TIMEOUT_MS)) as { flights?: TrvlFlight[]; price_position?: { verdict?: string } } | null
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

  const currencies = [...new Set(flights.map((f) => f.currency).filter(Boolean))]
  const fxNote =
    currencies.length === 1 && currencies[0] !== 'USD'
      ? rate
        ? ` Prices converted from ${currencies[0]} at ${rate.toFixed(3)} USD (ECB rate for today).`
        : ` Prices are in ${currencies[0]}; no conversion rate was available, so do not restate them as dollars.`
      : ''
  const verdict = data?.price_position?.verdict
  const verdictNote = verdict && verdict !== 'unknown' ? ` Price position on this route: ${verdict}.` : ''
  return remember(key, `${formatFares(rows, { label: `from ${from} to ${to} on ${input.date}` })}${fxNote}${verdictNote}`)
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
  room_types?: Array<{ name?: string; price?: number; nightly_price?: number }>
  sources?: unknown
}
export type TrvlHotelRow = { name: string; stars: number; rating: number; reviews: number; priceUsd: number; currency: string; address: string; bookingUrl: string; distanceKm: number }

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
      }
    })
    .filter((h) => h.name && h.priceUsd > 0)
    .map((h) => ({ ...h, distanceKm: Math.round(h.distanceKm * 10) / 10 }))
}

async function trvlHotelsRaw(input: { city: string; checkin: string; checkout: string }): Promise<unknown | null> {
  if (!trvlEnabled()) return null
  const city = String(input.city || '').trim()
  if (!city || !/^\d{4}-\d{2}-\d{2}$/.test(input.checkin) || !/^\d{4}-\d{2}-\d{2}$/.test(input.checkout)) return null
  return runner(['hotels', city, '--checkin', input.checkin, '--checkout', input.checkout, '--format', 'json'], TRVL_TIMEOUT_MS)
}

/** Real rooms and nightly rates for the exact dates, from six sources. */
export async function trvlHotels(input: { city: string; checkin: string; checkout: string }): Promise<string | null> {
  const key = `hotels|${input.city}|${input.checkin}|${input.checkout}`
  const hit = cached(key)
  if (hit) return hit
  const rows = await trvlHotelRows(input)
  if (!rows.length) return null
  /* A city search returns the whole metro (an O'Hare property reads 35 km out
   * for a Loop ask), so anything the source measured leads by distance: the ask
   * was almost always "near where I am". */
  const measured = rows.filter((h) => h.distanceKm > 0)
  const ranked = measured.length ? [...measured].sort((a, b) => a.distanceKm - b.distanceKm) : rows
  const lines = ranked.slice(0, 8).map((h) => {
    const bits = [
      `$${h.priceUsd}/night`,
      h.stars ? `${h.stars}-star` : '',
      h.rating ? `${Math.round(h.rating * 10) / 10} rating` : '',
      h.reviews ? `${h.reviews} reviews` : '',
      h.address || '',
      h.distanceKm ? `${h.distanceKm} km out` : '',
    ].filter(Boolean)
    return `- ${h.name}: ${bits.join(', ')}`
  })
  return remember(
    key,
    `Live hotel rates for ${input.checkin} to ${input.checkout} in ${input.city} (merged from six booking sources):\n${lines.join('\n')}\nThese are real rates for those nights. Cancellation terms and the final total come from the booking page, so confirm them there before promising either.`,
  )
}
