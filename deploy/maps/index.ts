import { webSearchContext } from "../webSearch"
import { serpApiAllowedFor, serpHotelRates, dateFromText, looksLikeHotelAsk } from "../serpapi"
import { formatPlaceSiteFacts, readPlaceSites } from "../placeSite"
import { type LocationRow, coordsUsable, locationLabel } from "../db/locations"
import { googleHotelBlockForAsk, trvlHotelBlockForAsk } from "../travel/service"
import { knownCityIn } from "../trvl"
import {
  MAP_WORD_KINDS,
  MAP_KIND_TAGS,
  MAP_FILLER_WORDS,
  FOREIGN_PLACE,
  classifyMapQuery,
  mapAreaFromQuery,
  mapPlaceWords,
  hotelConstraintsFromAsk,
  mapAreaCandidates,
  dietsFromQuery,
  PLACE_ASK_RE,
  timezoneCountry,
} from "./query"

export {
  classifyMapQuery,
  mapAreaFromQuery,
  mapPlaceWords,
  hotelConstraintsFromAsk,
  mapAreaCandidates,
  dietsFromQuery,
  PLACE_ASK_RE,
  timezoneCountry,
}

async function fetchPublic(url: URL, init: RequestInit, timeoutMs = 8000) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    return await fetch(url, { ...init, signal: controller.signal })
  } catch {
    return new Response(null, { status: 504 })
  } finally {
    clearTimeout(timer)
  }
}

export function buildOverpassQuery(
  kinds: string[],
  lat: number,
  lon: number,
  radiusM = 1600,
  dietTags: string[] = [],
): string {
  const tags: string[] = []
  for (const kind of kinds) {
    // Accept both category words ("coffee") and kind names ("cafe").
    const names = MAP_WORD_KINDS[kind] || [kind]
    for (const name of names) {
      for (const tag of MAP_KIND_TAGS[name] || []) {
        if (!tags.includes(tag)) tags.push(tag)
      }
    }
  }
  if (!tags.length) return ''
  const at = `(around:${Math.max(50, Math.round(radiusM))},${lat},${lon})`
  const bodies = tags.map((tag) => {
    const [key, value] = tag.split('=')
    return `  node["${key}"="${value}"]${at};\n  way["${key}"="${value}"]${at};`
  })
  if (tags.includes('amenity=restaurant') || tags.includes('amenity=cafe') || tags.includes('amenity=fast_food')) {
    for (const diet of dietTags) {
      const [key, value] = diet.split('=')
      bodies.push(`  node["${key}"="${value}"]["amenity"~"^(restaurant|cafe|fast_food)$"]${at};`)
      bodies.push(`  way["${key}"="${value}"]["amenity"~"^(restaurant|cafe|fast_food)$"]${at};`)
    }
  }
  return `[out:json][timeout:10];\n(\n${bodies.join('\n')}\n);\nout center 30;`
}

/** Meters between two points; only used for a rough walk-time line. */
export function metersBetween(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const toRad = (deg: number) => (deg * Math.PI) / 180
  const dLat = toRad(lat2 - lat1)
  const dLon = toRad(lon2 - lon1)
  const a =
    Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2
  return 2 * 6_371_000 * Math.asin(Math.sqrt(a))
}

export function formatMapResults(
  rows: Array<{ name: string; addr?: string; cuisine?: string; lat?: number; lon?: number; note?: string }>,
  label: string,
  center?: { lat: number; lon: number } | null,
): string {
  const seen = new Set<string>()
  const lines: string[] = []
  for (const row of rows) {
    const name = String(row.name || '').trim()
    if (!name || seen.has(name.toLowerCase())) continue
    seen.add(name.toLowerCase())
    const cuisine = String(row.cuisine || '')
      .trim()
      .split(';')[0]
      .replace(/_/g, ' ')
    const link =
      typeof row.lat === 'number' && typeof row.lon === 'number'
        ? `https://www.openstreetmap.org/?mlat=${row.lat}&mlon=${row.lon}#map=16/${row.lat}/${row.lon}`
        : ''
    // A walk time is the difference between a plausible pick and a list the
    // user has to re-check; only computed when the search was centered.
    const walk =
      center && typeof row.lat === 'number' && typeof row.lon === 'number'
        ? ` · ~${Math.max(1, Math.round(metersBetween(center.lat, center.lon, row.lat, row.lon) / 80))} min walk`
        : ''
    const note = String(row.note || '')
    lines.push(
      `- ${name}${cuisine ? ` (${cuisine})` : ''}${note ? ` [${note}]` : ''}${walk}${link ? `\n  ${link}` : ''}${row.addr ? `\n  ${row.addr}` : ''}`,
    )
    if (lines.length >= 6) break
  }
  if (!lines.length) return `No map results found for "${label}".`
  return `Map results for "${label}":\n${lines.join('\n')}`
}

/** Geocoding a phrase must land on a destination, not on a street: "Chicago
 * Loop" resolves first to a residential road in North Carolina, and a 1.6 km
 * search there returns hardware stores for a dinner ask. Landmarks are
 * destinations too, and they are labelled inconsistently — the Empire State
 * Building is addresstype `office` — so this rejects the street classes rather
 * than listing the acceptable ones. A whitelist silently turned a landmark ask
 * into "no map results at all". */
const GEOCODE_STREET_TYPES = new Set([
  'road', 'residential', 'unclassified', 'service', 'track', 'path', 'footway',
  'cycleway', 'steps', 'pedestrian', 'living_street', 'motorway', 'trunk',
  'primary', 'secondary', 'tertiary', 'house', 'building_entrance', 'bus_stop',
])

/** Exported for the regression test that pins landmark vs street. */
export function geocodeRowUsableForTest(row: { lat?: string; lon?: string; type?: string; addresstype?: string } | undefined): boolean {
  return geocodeRowUsable(row)
}

function geocodeRowUsable(row: { lat?: string; lon?: string; type?: string; addresstype?: string } | undefined): boolean {
  const lat = Number(row?.lat)
  const lon = Number(row?.lon)
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return false
  const kind = String(row?.addresstype || row?.type || '').toLowerCase()
  // An empty kind is accepted: the test fixtures answer without one, and a
  // provider that omits the field should not turn every geocode into a miss.
  return !kind || !GEOCODE_STREET_TYPES.has(kind)
}

export async function nominatimArea(term: string, countryHint: string): Promise<{ lat: number; lon: number } | null> {
  try {
    const url = new URL('https://nominatim.openstreetmap.org/search')
    const zip = /^\d{5}(?:-\d{4})?$/.test(term) && (!countryHint || countryHint === 'us')
    url.searchParams.set(zip ? 'postalcode' : 'q', term)
    if (zip) url.searchParams.set('countrycodes', 'us')
    url.searchParams.set('format', 'jsonv2')
    url.searchParams.set('limit', '5')
    if (countryHint && !FOREIGN_PLACE.test(term)) url.searchParams.set('countrycodes', countryHint)
    const res = await fetchPublic(url, {
      headers: { Accept: 'application/json', 'User-Agent': 'HireAlpha/1.0 (https://hirealpha.chat)' },
    })
    if (!res.ok) return null
    const rows = (await res.json()) as Array<{ lat?: string; lon?: string; type?: string; addresstype?: string }>
    const hit = rows.find((row) => geocodeRowUsable(row))
    if (!hit) return null
    return { lat: Number(hit.lat), lon: Number(hit.lon) }
  } catch {
    return null
  }
}

/**
 * Geocode an area phrase, dropping leading words until something geocodes to
 * an actual place. "Chicago Loop" misses as a whole but "Chicago" does not, so
 * a named neighborhood the geocoder has never heard of still resolves to its
 * city instead of silently searching the user's home city.
 */
export async function geocodeMapArea(area: string, countryHint: string) {
  const words = area.replace(/\s+/g, ' ').trim().split(' ').filter(Boolean)
  if (!words.length) return null
  for (let start = 0; start < words.length; start++) {
    // A leading filler survives the word-dropping loop otherwise: "hotels the
    // Empire State Building" gave "the Empire State Building", which does not
    // geocode, and a landmark ask then reported no results at all.
    while (start < words.length - 1 && MAP_FILLER_WORDS.has((words[start] || '').toLowerCase())) start++
    const term = words.slice(start).join(' ')
    const hit = await nominatimArea(term, countryHint)
    if (hit) return hit
    // Nominatim allows ~1 request/second; keep the retry honest.
    if (start + 1 < words.length) await new Promise((r) => setTimeout(r, 1100))
  }
  return null
}

const OVERPASS_MIRRORS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
]

/** The category words Nominatim understands for a bounded search, per kind. */
const NOMINATIM_KIND_QUERY: Record<string, string> = {
  cafe: 'cafe',
  restaurant: 'restaurant',
  bar: 'bar',
  bakery: 'bakery',
  fast_food: 'fast food',
  ice_cream: 'ice cream',
  gym: 'gym',
  grocery: 'supermarket',
  pharmacy: 'pharmacy',
  park: 'park',
  hotel: 'hotel',
  hostel: 'hostel',
  guest_house: 'guest house',
}

/**
 * Nearby places when Overpass is unreachable.
 *
 * Measured 2026-09-18: all three Overpass mirrors failing at once — the main
 * one answering 504, the other two timing out or rate limiting a request that
 * carried a proper User-Agent. Every dining ask then fell through to the
 * named-place path, then to a web search, and answered "three vegetarian
 * dinner spots in the Loop" with a 2008 usenet FAQ.
 *
 * Nominatim serves the same OpenStreetMap data from separate infrastructure and
 * can answer a category ask inside a bounding box. It carries no diet or price
 * tags, so the block says what it is: real nearby places, tags unverified.
 */
async function nominatimNearby(
  kinds: string[],
  lat: number,
  lon: number,
  radiusM = 1600,
): Promise<string | null> {
  const terms = kinds.map((k) => MAP_WORD_KINDS[k] || [k]).flat().map((k) => NOMINATIM_KIND_QUERY[k]).filter(Boolean)
  if (!terms.length) return null
  // ~111km per degree of latitude; a box on the same radius keeps this honest.
  const dLat = radiusM / 111_000
  const dLon = dLat / Math.max(0.2, Math.cos((lat * Math.PI) / 180))
  const found: Array<{ name: string; addr?: string; cuisine?: string; lat?: number; lon?: number }> = []
  for (const term of terms.slice(0, 2)) {
    try {
      const url = new URL('https://nominatim.openstreetmap.org/search')
      url.searchParams.set('q', term)
      url.searchParams.set('format', 'jsonv2')
      url.searchParams.set('limit', '30')
      url.searchParams.set('addressdetails', '1')
      url.searchParams.set('viewbox', `${lon - dLon},${lat + dLat},${lon + dLon},${lat - dLat}`)
      url.searchParams.set('bounded', '1')
      const res = await fetchPublic(url, {
        headers: { Accept: 'application/json', 'User-Agent': 'HireAlpha/1.0 (https://hirealpha.chat)' },
      }, 8000)
      if (!res.ok) continue
      const rows = (await res.json()) as Array<{ name?: string; display_name?: string; lat?: string; lon?: string; type?: string }>
      for (const row of rows) {
        const name = String(row.name || '').split(',')[0]?.trim()
        if (!name) continue
        const addr = String(row.display_name || '').split(',').slice(1, 3).join(',').trim()
        found.push({
          name,
          addr,
          cuisine: String(row.type || '').replace(/_/g, ' '),
          lat: row.lat ? Number(row.lat) : undefined,
          lon: row.lon ? Number(row.lon) : undefined,
        })
      }
    } catch {
      /* try the next term */
    }
  }
  if (!found.length) return null
  const block = formatMapResults(found, 'nearby', { lat, lon })
  return `${block}\n(Source: OpenStreetMap via Nominatim. Names and addresses only: this source carries no menu, price or dietary tags, so do not state any. Opening hours, where a row carries them, come from OpenStreetMap too.)`
}

/** One Overpass query, retried across mirrors. Returns null only when every
 * attempt failed to produce JSON — the caller must not read null as "no places
 * exist", and callers that report emptiness should say the lookup failed
 * instead. */
async function fetchOverpass(query: string): Promise<{
  elements?: Array<{
    tags?: Record<string, string>
    lat?: number
    lon?: number
    center?: { lat: number; lon: number }
  }>
} | null> {
  for (const [attempt, endpoint] of OVERPASS_MIRRORS.entries()) {
    if (attempt) await new Promise((resolve) => setTimeout(resolve, 700 * attempt))
    try {
      const res = await fetchPublic(
        new URL(endpoint),
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            Accept: 'application/json',
            'User-Agent': 'HireAlpha/1.0 (https://hirealpha.chat)',
          },
          body: `data=${encodeURIComponent(query)}`,
        },
        12000,
      )
      if (!res.ok) continue
      const text = await res.text()
      // A mirror that is busy answers 200 with an HTML error document.
      if (!text.trimStart().startsWith('{')) continue
      return JSON.parse(text) as { elements?: Array<Record<string, never>> }
    } catch {
      /* try the next mirror */
    }
  }
  return null
}

// Overpass for category asks; a null return falls back to the Nominatim path.
/** A nearby ask with no place to be near. Returned INSTEAD of falling through
 * to a global place search: measured live, a group dinner ask with no
 * resolvable city answered with a Bangalore listicle for a Chicago Loop
 * request. Asking which city is the honest answer; a worldwide search is not. */
const MAPS_NEEDS_LOCATION = 'Maps search needs a city, neighborhood, or address. Ask which area to search, then look again — do not answer with places from anywhere else.'

/** Does the ask contain a proper name — a capitalised word past the first?
 * "find the Berghoff" does; "vegetarian friendly thali" does not, and that is
 * the difference between searching for a venue and searching the world. */
function namesAPlace(query: string): boolean {
  return /[A-Z][a-z]{2,}/.test(String(query || '').slice(1))
}

async function fetchNearbyPlaces(
  query: string,
  kinds: string[],
  countryHint: string,
  location: LocationRow | null,
): Promise<string | null> {
  try {
    // Try every plausible area until one geocodes: a sentence with two kind
    // words ("restaurants near the Loop ... from downtown hotels") used to
    // resolve to nothing and fall through to a web search.
    let lat: number | null = null
    let lon: number | null = null
    for (const area of mapAreaCandidates(query)) {
      const geo = await geocodeMapArea(area, countryHint)
      if (geo) { lat = geo.lat; lon = geo.lon; break }
    }
    if (lat === null || lon === null) {
      const fallbackArea = mapAreaFromQuery(query)
      if (fallbackArea) {
        const geo = await geocodeMapArea(fallbackArea, countryHint)
        if (geo) { lat = geo.lat; lon = geo.lon }
      }
    }
    if (lat === null || lon === null) {
      if (location && coordsUsable(location.latitude, location.longitude)) {
        lat = location.latitude
        lon = location.longitude
      }
    }
    if (lat === null || lon === null) return MAPS_NEEDS_LOCATION
    const ql = buildOverpassQuery(kinds, lat, lon, 1600, dietsFromQuery(query))
    if (!ql) return null
    // Overpass answers a busy moment with HTTP 200 and an HTML error page
    // ("server is probably too busy"). A single un-retried call turned that
    // into "No map results found", i.e. a temporary server hiccup was reported
    // to the user as a fact about the world — the search looked broken while
    // the very next request returned real hotels. Retry, then try a mirror,
    // and only trust a response that is actually JSON.
    let data = await fetchOverpass(ql)
    /* A diet tag is a hard filter inside the query, and OSM carries `diet:*` on
     * a small minority of places: "vegetarian-friendly dinner in the Loop" came
     * back empty, which fell through to the named-place path and answered with a
     * 2008 usenet FAQ. One retry without the diet filter returns real nearby
     * restaurants the model can name and caveat, which beats stale listicles. */
    const wantedDiets = dietsFromQuery(query)
    if (data && wantedDiets.length && !(data.elements || []).length) {
      const loose = buildOverpassQuery(kinds, lat, lon, 1600)
      if (loose) data = (await fetchOverpass(loose)) || data
    }
    if (!data) {
      // Every mirror down: same data, different infrastructure.
      const near = await nominatimNearby(kinds, lat, lon)
      if (near) return near
      return null
    }
    const sitesByName = new Map<string, string>()
    const rows = (data.elements || [])
      .map((el) => {
        const tags = el.tags || {}
        const elLat = el.lat ?? el.center?.lat
        const elLon = el.lon ?? el.center?.lon
        const street = tags['addr:street'] || ''
        const housenumber = tags['addr:housenumber'] || ''
        const diet = Object.entries(tags)
          .filter(([key, value]) => key.startsWith('diet:') && value === 'yes')
          .map(([key]) => `${key.slice('diet:'.length).replace(/_/g, ' ')}, confirmed`)
        /* OSM tags the opening hours and sometimes the site. Both are free and
         * already in the response — the answer path was simply not using them,
         * so a verified pick could not say when the place is open, which is one
         * of the constraints the picks task names. */
        const hours = String(tags.opening_hours || '').trim().slice(0, 120)
        const site = String(tags.website || tags['contact:website'] || '').trim().slice(0, 160)
        const notes = [
          diet.join('; '),
          hours ? `hours: ${hours}` : '',
          site ? `site: ${site}` : '',
        ].filter(Boolean)
        if (site) sitesByName.set(String(tags.name || '').trim(), site)
        return {
          name: String(tags.name || '').trim(),
          addr: [housenumber, street].filter(Boolean).join(' ') || tags['addr:city'] || '',
          cuisine: tags.cuisine || '',
          note: notes.join(' | '),
          lat: typeof elLat === 'number' ? elLat : undefined,
          lon: typeof elLon === 'number' ? elLon : undefined,
        }
      })
      .filter((row) => row.name)
    // A full meal is not a coffee shop: a dinner ask that answers with a
    // Starbucks reads as a non-answer even though the diet tag checks out.
    const wantsMeal = /\b(dinner|lunch|brunch|breakfast|supper|restaurant|eat)\b/i.test(query)
    const light = /coffee shop|coffee|snack|ice cream|ice_cream|dessert|bakery|cafe\b/i
    const seats = rows.filter((row) => !(wantsMeal && light.test(`${row.name} ${row.cuisine}`)))
    const usable = seats.length ? seats : rows
    if (!usable.length) return null
    // A place carrying the diet the user asked for belongs ahead of one that
    // merely happens to be close: the list is capped, and the vegetarian
    // option must survive the cut.
    const wanted = dietsFromQuery(query)
    const dietRanked = wanted.length
      ? [...usable].sort((a, b) => Number(Boolean(b.note)) - Number(Boolean(a.note)))
      : usable
    const block = formatMapResults(dietRanked, query.trim().slice(0, 120), { lat, lon })
    /* The one thing OSM cannot carry is what the place charges and whether it is
     * open when the user asked. Both live on the venue's own page, which this
     * same free response already linked, so the top picks are read from their own
     * sites and their published facts ride under the results. */
    const topPicks = dietRanked.slice(0, 3).filter((r) => sitesByName.has(r.name))
    if (!topPicks.length) return block
    const facts = await readPlaceSites(topPicks.map((r) => ({ name: r.name, site: sitesByName.get(r.name)! }))).catch(() => [])
    const extra = formatPlaceSiteFacts(facts)
    return extra ? `${block}\n\n${extra}` : block
  } catch {
    return null
  }
}

/**
 * Real dated hotel rates for a booking ask, whoever routed it here.
 *
 * The ask names the dates in words ("Friday to Saturday next week"), the area
 * as a place phrase ("in Chicago ... near the Loop"), and the constraints as
 * prose ("under $250/night ... with free cancellation"). All three are resolved
 * before the search runs, so the block the model answers from is already
 * filtered to the rooms that satisfy the task; a search that ignored them
 * presented the whole metro at any price.
 */
/** The same resolution the trvl block does, pointed at Google Hotels through
 * scrape.do: dates and area out of the ask, the price ceiling enforced when the
 * ask named one. Returns null (never a listicle) when the render fails. */

export async function fetchMapSearch(query: string, countryHint = '', location: LocationRow | null = null, phone?: string) {
  const wantsHotel = /\b(?:hotels?|hostels?|motels?|lodging|stay|room rates?|resorts?|accommodations?)\b/i.test(query)
  if (wantsHotel) {
    /* Tester numbers only, and only when the ask names dates: Google Hotels
     * answers with real nightly rates and the free-cancellation flag for those
     * exact nights, which is the difference between "average price near JFK"
     * and "your nights, this price". Every other user keeps the free path
     * below, and a repeated query is served from the day's cache, so re-running
     * a bench costs nothing. */
    /* trvl first: real nightly rates for the exact dates from six booking
     * sources, at no per-call cost, for every user. When its upstream providers
     * throttle our IP (measured 429s), Google Hotels comes from scrape.do's own
     * IPs with per-night rates for the same dates — verified by fetching one
     * night and two and getting identical figures. SerpAPI stays behind the
     * tester gate as the third source, and the web path is last. */
    const live = await trvlHotelBlockForAsk(query, location)
    if (live) return live
    const googleBlock = await googleHotelBlockForAsk(query, location)
    if (googleBlock) return googleBlock
    if (serpApiAllowedFor(phone)) {
      const checkIn = dateFromText(query)
      if (checkIn && looksLikeHotelAsk(query)) {
        const rest = query.replace(checkIn, ' ')
        const checkOut =
          dateFromText(rest) ||
          new Date(Date.parse(`${checkIn}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10)
        const live = await serpHotelRates({ query, checkIn, checkOut }).catch(() => null)
        if (live) return live
      }
    }
    try {
      const webOut = await webSearchContext(query)
      if (webOut && !/unavailable|no usable results/i.test(webOut)) {
        // The dated sources returned nothing: the web page is not evidence of
        // a rate, so the payload says so before the model can quote it.
        return `LIVE RATE SOURCE UNAVAILABLE for this ask (the dated hotel sources returned nothing). The text below is a general web search, not verified room availability or nightly prices for these dates: do not present any figure from it as a rate, and say plainly that live pricing could not be verified.\n\n${webOut}`
      }
    } catch {
      /* fall back to nearby / osm */
    }
  }
  const classified = classifyMapQuery(query)
  if (classified.mode === 'nearby') {
    /* A city named in the ask beats the user's own coordinates. With the stored
     * location as the center this branch searched around the user and answered
     * "dinner for four in austin" with Applausi, 199 Sound Beach Avenue — Old
     * Greenwich, Connecticut. Geocode the named city and search there; fall
     * back to the user's location only when the ask names none. */
    let center = location
    const namedCity = knownCityIn(query)
    if (namedCity) {
      const hit = await geocodeMapArea(namedCity, countryHint ?? '').catch(() => null)
      const lat = Number(hit?.lat)
      const lon = Number(hit?.lon)
      if (Number.isFinite(lat) && Number.isFinite(lon)) {
        center = { ...(location ?? {}), latitude: lat, longitude: lon } as typeof location
      }
    }
    const nearby = await fetchNearbyPlaces(query, classified.kinds, countryHint, center)
    console.warn(`[maps] branch=nearby query="${query.slice(0, 80)}" center=${center ? `${center.latitude},${center.longitude}` : "none"}`)
    if (nearby) return nearby
    /* `fetchNearbyPlaces` returns the marker only when it could not place the
     * ask at all. That must not become a worldwide search — UNLESS the ask
     * named a specific place ("find the Berghoff"), where searching for that
     * name is exactly right. A nameless ask asks which city instead.
     * A lowercase city is a name too: `namesAPlace` wants a capitalised word,
     * so "dinner in seattle tomorrow, not touristy" was refused here and fell
     * through to a web search — three real venues, no hours, no links, and the
     * reply apologising that its sources carry none. `knownCityIn` scans the
     * words for a city the airport table knows, which is exactly the case that
     * was being thrown away. */
    if (nearby === MAPS_NEEDS_LOCATION && !namesAPlace(query) && !knownCityIn(query)) return MAPS_NEEDS_LOCATION
    // Overpass miss, no coords, or empty result: the named place path below answers.
  }
  if (location && !/\b(?:near|around|in|at|by)\b/i.test(query)) {
    const marker = locationLabel(location)
    query = `${query} near ${marker}`
  }
  const cleaned = query
    .replace(/\b(find|search|show|recommend|tonight|tomorrow|today|this (?:week|weekend|evening|afternoon)|weekend|maps|hangout|near me|near us|nearby|near\b|around|where should we|where can we|not touristy|non[- ]?touristy|touristy|non[- ]?tourist)\b/gi, ' ')
    .replace(/\s+/g, ' ')
    .replace(/[\s,]+$/, '')
    .trim()
  if (!cleaned || /^(quiet|good|best|eat|food|dinner|lunch|breakfast|coffee|drink|drink|hangout)$/i.test(cleaned)) {
    return 'Maps search needs a city, neighborhood, or address. Ask for a place in a specific area.'
  }
  try {
    const url = new URL('https://nominatim.openstreetmap.org/search')
    url.searchParams.set('q', cleaned)
    url.searchParams.set('format', 'jsonv2')
    url.searchParams.set('limit', '5')
    url.searchParams.set('dedupe', '1')
    /* The ask's own city outranks the user's coordinates. With the location
     * bias always on, "dinner for four in austin" came back as Applausi, 199
     * Sound Beach Avenue — Old Greenwich, Connecticut — because Nominatim
     * preferred what was near the stored lat/lon over the city in the query.
     * Bias only when the ask names no city of its own. */
    const askNamesCity = !!knownCityIn(cleaned)
    /* The center this search actually used: the stored coordinates when the
     * bias applied, otherwise the ask's own city. The log line below names it,
     * so a wrong-city result can be told apart from a wrong-branch one without
     * a second run. */
    const bias = location && coordsUsable(location.latitude, location.longitude) && !FOREIGN_PLACE.test(cleaned) && !askNamesCity ? location : null
    if (bias) {
      url.searchParams.set('lat', String(bias.latitude))
      url.searchParams.set('lon', String(bias.longitude))
    } else if (countryHint && !FOREIGN_PLACE.test(cleaned) && !askNamesCity) {
      url.searchParams.set('countrycodes', countryHint)
    }
    const res = await fetchPublic(url, {
      headers: { Accept: 'application/json', 'User-Agent': 'HireAlpha/1.0 (https://hirealpha.chat)' },
    })
    if (!res.ok) {
      const webOut = await webSearchContext(query).catch(() => '')
      if (webOut && !/unavailable|no usable results/i.test(webOut)) return webOut
      return `Maps search unavailable (${res.status}).`
    }
    const rows = (await res.json()) as Array<{ display_name?: string; lat?: string; lon?: string; type?: string }>
    if (!rows.length) {
      const webOut = await webSearchContext(query).catch(() => '')
      if (webOut && !/unavailable|no usable results/i.test(webOut)) return webOut
      return `No map results found for "${cleaned}".`
    }
    console.warn(`[maps] branch=named query="${query.slice(0, 80)}" cleaned="${cleaned}" center=${bias ? `${bias.latitude},${bias.longitude}` : askNamesCity ? `ask:${cleaned}` : 'none'}`)
    return `Map results for "${cleaned}":\n${rows
      .map((row) => {
        const label = String(row.display_name || '').split(',').slice(0, 3).join(',')
        const link = row.lat && row.lon ? `https://www.openstreetmap.org/?mlat=${row.lat}&mlon=${row.lon}#map=16/${row.lat}/${row.lon}` : ''
        return `- ${label}${row.type ? ` (${row.type})` : ''}${link ? `\n  ${link}` : ''}`
      })
      .join('\n')}`
  } catch {
    const webOut = await webSearchContext(query).catch(() => '')
    if (webOut && !/unavailable|no usable results/i.test(webOut)) return webOut
    return 'Maps search unavailable right now.'
  }
}
