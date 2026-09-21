/* Place search for the address fields: one Nominatim query shape, one parser,
 * one label shortener — shared by the onboarding wizard and the settings sheet so
 * a saved place means the same thing in both.
 *
 * The wizard used to geocode once, at Next, with `limit=1`: you typed an address,
 * tapped Next, and found out afterwards whether Nominatim agreed with you. The
 * founder's ask, 2026-09-21, with the address mid-typed:
 *
 *   "make this recommend places when i type so i can easily select my address"
 *
 * So the same endpoint is queried as the person types (type-ahead, limit 5) and
 * the row they pick is carried to the save — coordinates and all — instead of
 * being re-guessed from the string.
 */

export type PlaceHit = {
  /** What goes in the input after a pick: the short, human part. */
  label: string
  /** What the row shows in the dropdown: the full disambiguation. */
  display: string
  lat: number
  lon: number
}

const NOMINATIM_SEARCH = 'https://nominatim.openstreetmap.org/search'

/**
 * Suggestions for `query`, or an empty list when it is too short to be worth a
 * request. Two characters match half the planet; three is the point where
 * suggestions start to mean something.
 */
export function placeSearchUrl(query: string, limit = 5): string | null {
  const q = query.trim()
  if (q.length < 3) return null
  const url = new URL(NOMINATIM_SEARCH)
  url.searchParams.set('q', q)
  url.searchParams.set('format', 'jsonv2')
  url.searchParams.set('limit', String(limit))
  return url.toString()
}

/** The URL for one exact lookup — the save path when nothing was picked. */
export function placeLookupUrl(query: string): string {
  const url = new URL(NOMINATIM_SEARCH)
  url.searchParams.set('q', query.trim())
  url.searchParams.set('format', 'jsonv2')
  url.searchParams.set('limit', '1')
  return url.toString()
}

/**
 * Nominatim's jsonv2 rows → hits. `lat`/`lon` arrive as strings and some rows
 * carry no coordinates at all; a row that cannot be placed is dropped rather than
 * offered, because picking it would save a label with no location behind it.
 * `query` is the text the person typed, which the label follows (see
 * shortPlaceLabel).
 */
export function parsePlaceHits(payload: unknown, limit = 5, query = ''): PlaceHit[] {
  if (!Array.isArray(payload)) return []
  const hits: PlaceHit[] = []
  for (const raw of payload) {
    if (!raw || typeof raw !== 'object') continue
    const row = raw as { lat?: unknown; lon?: unknown; display_name?: unknown; name?: unknown }
    const lat = Number(row.lat)
    const lon = Number(row.lon)
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue
    if (lat < -90 || lat > 90 || lon < -180 || lon > 180) continue
    const display = String(row.display_name || row.name || '').trim()
    if (!display) continue
    hits.push({ label: shortPlaceLabel(display, query), display, lat, lon })
    if (hits.length >= limit) break
  }
  return hits
}

/**
 * What goes in the input after a pick. Two rules, in order:
 *
 * 1. **Follow the words the person typed.** Nominatim leads with whatever it
 *    matched, and for the founder's own address the live result was
 *    "Music City, 1353;1355, Bush Street, Polk Gulch, San Francisco, California,
 *    94109, United States" — a building name he never typed, first, ahead of the
 *    city. Head-truncating that to four parts produced "Music City, 1353;1355,
 *    Bush Street, Polk Gulch": the address he typed, with San Francisco gone. So
 *    the parts that share a word with the query are the parts kept, in the
 *    source's own order. "1353 Bush Street San Francisco, 94109" comes back as
 *    "1353;1355, Bush Street, San Francisco, 94109".
 * 2. **Otherwise take it from the front**, capped, with the trailing country
 *    dropped — "San Francisco, California, United States" reads the same as
 *    "San Francisco, California" to anyone standing in it, and the country never
 *    disambiguates anything in a one-country list.
 */
export function shortPlaceLabel(display: string, query = '', maxParts = 4, maxChars = 72): string {
  const parts = tidyParts(
    String(display || '')
      .split(',')
      .map((p) => p.trim())
      .filter(Boolean),
  )
  if (!parts.length) return ''
  // Only when something is left to identify the place without it.
  if (parts.length > 2 && TRAILING_COUNTRY.test(parts[parts.length - 1]!)) parts.pop()

  const words = String(query || '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length >= 3 && !/^\d{1,2}$/.test(w))
  const kept: string[] = []
  if (words.length) {
    for (const part of parts) {
      const low = part.toLowerCase()
      if (!words.some((w) => low.includes(w))) continue
      kept.push(part)
      if (kept.length >= maxParts) break
    }
  }
  const chosen = kept.length ? kept : parts.slice(0, maxParts)
  const out: string[] = []
  for (const part of chosen) {
    const next = [...out, part].join(', ')
    if (next.length > maxChars && out.length) break
    out.push(part)
  }
  return out.join(', ')
}

/**
 * Nominatim's display_name is a comma-joined field dump, and two of its habits
 * read badly in an input box:
 *
 *   "Music City, 1353;1355, Bush Street, …"  → "1353 Bush Street, …"
 *
 * A building with two street numbers comes back as "1353;1355" (a semicolon,
 * because the source lists them), and the house number is always its own
 * component — so on its own it reads as "1353, Bush Street". The first number is
 * the one the person typed, and a number belongs with the street it numbers.
 */
function tidyParts(parts: string[]): string[] {
  const numbered = parts.map((part) => (/^\d+(?:[;/]\d+)*$/.test(part) ? part.split(/[;/]/)[0]! : part))
  const out: string[] = []
  for (let i = 0; i < numbered.length; i++) {
    const part = numbered[i]!
    const next = numbered[i + 1]
    // Never glue a number to a country: a postcode is also a lone number, and
    // "94109 United States" stopped the country trim from recognising the tail.
    if (/^\d+$/.test(part) && next && /[a-z]/i.test(next) && !TRAILING_COUNTRY.test(next)) {
      out.push(`${part} ${next}`)
      i++
      continue
    }
    out.push(part)
  }
  return out
}

/** Country tails Nominatim spells out in full at the end of a display name. */
const TRAILING_COUNTRY =
  /^(?:united states(?: of america)?|usa|u\.s\.a\.?|united kingdom|uk|canada|australia|india|germany|france|spain|italy|netherlands|ireland|new zealand|singapore|united arab emirates|mexico|brazil|japan|south korea|china)$/i

/**
 * One exact lookup, for the save path when the person typed instead of picking.
 * Throws with a sentence a person can read, which is what both callers show.
 */
export async function geocodePlace(query: string): Promise<{ lat: number; lon: number; label: string }> {
  const url = placeLookupUrl(query)
  const res = await fetch(url, { headers: { Accept: 'application/json' } })
  if (!res.ok) throw new Error('Could not look up that address')
  const hits = parsePlaceHits(await res.json(), 1)
  const hit = hits[0]
  if (!hit) throw new Error('No place found. Try a city or address.')
  return { lat: hit.lat, lon: hit.lon, label: hit.label }
}

/* Nominatim's usage policy caps automated traffic at one request per second, and
 * type-ahead is exactly the shape that breaks it. The debounce in the component
 * handles fast typing; this handles the case the policy is really about — a
 * keystroke stream that keeps re-arming the timer. Every search goes through
 * here, so the spacing holds across the two address fields as well. */
let lastRequestAt = 0
export async function rateLimitedPlaceSearch(url: string, query = '', signal?: AbortSignal): Promise<PlaceHit[]> {
  const wait = Math.max(0, 1000 - (Date.now() - lastRequestAt))
  if (wait) await new Promise((resolve) => setTimeout(resolve, wait))
  lastRequestAt = Date.now()
  const res = await fetch(url, { headers: { Accept: 'application/json' }, signal })
  if (!res.ok) throw new Error(`Place search failed (${res.status})`)
  return parsePlaceHits(await res.json(), 5, query)
}
