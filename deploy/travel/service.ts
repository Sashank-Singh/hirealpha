import type { SQL } from "bun"
import { airportsFor, knownCityIn, trvlFlights, trvlHotels } from "../trvl"
import {
  datesFromText,
  dateFromText,
  looksLikeFlightAsk,
  routeFromText,
  looksLikeHotelAsk,
  serpApiAllowedFor,
  serpFlightFares,
} from "../serpapi"
import { googleFlightsRates } from "../googleFlights"
import { googleHotelsRates } from "../googleHotels"
import { webSearchContext } from "../webSearch"
import { type LocationRow, locationLabel } from "../db/locations"
import {
  mapPlaceWords,
  mapAreaCandidates,
  hotelConstraintsFromAsk,
} from "../maps/query"

async function fetchWebSearch(query: string) {
  return webSearchContext(query)
}

export function maxPriceFromAsk(query: string): number | null {
  const m = /(?:under|below|less than|max(?:imum)?|up to|cheaper than)\s*\$?\s*(\d{2,5})/i.exec(String(query || ''))
  const n = m ? Number(m[1]) : NaN
  return Number.isFinite(n) && n > 0 ? n : null
}

/** The fare or rate block for a trip the classifier understood: airports and
 * dates arrive as data, so the sources are called with them directly. A flight
 * ask reaches trvl and Google Flights with the codes the user typed; a stay
 * reaches the hotel sources with the dates they named. Nothing here parses the
 * sentence — that is the whole point. */
export async function fetchRowsForUnderstoodTrip(
  sql: SQL,
  userId: string,
  trip: { kind: 'flight' | 'hotel'; from?: string; to?: string; place?: string; checkin?: string; checkout?: string; maxPrice?: number },
): Promise<string[]> {
  const rows: string[] = []
  if (trip.kind === 'flight') {
    const from = airportsFor(trip.from || '')
    const to = airportsFor(trip.to || '')
    if (!from || !to || !trip.checkin) return []
    const fares = await trvlFlights({
      from: trip.from!,
      to: trip.to!,
      date: trip.checkin,
      ...(trip.checkout ? { returnDate: trip.checkout } : {}),
    }).catch(() => null)
    if (fares) rows.push(fares)
    return rows
  }
  /* The rate sources take a CITY, not an area. "Chicago Loop" reached them
   * verbatim, returned nothing, and the ask fell through to a Kayak listicle —
   * while "Chicago" priced six booking sources for the same night. Map an area
   * down to the city the sources know, the same way the text-driven hotel path
   * already does, and only then give up. */
  const rawPlace = trip.place || trip.to || ''
  const city = knownCityIn(rawPlace) || rawPlace
  if (!city || !trip.checkin) return []
  const checkout = trip.checkout || new Date(Date.parse(`${trip.checkin}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10)
  const rates = await trvlHotels({
    city,
    checkin: trip.checkin,
    checkout,
    ...(trip.maxPrice ? { maxPricePerNight: trip.maxPrice } : {}),
  }).catch(() => null)
  if (rates) rows.push(rates)
  return rows
}

export async function googleHotelBlockForAsk(query: string, location: LocationRow | null): Promise<string | null> {
  const dates = datesFromText(query)
  const checkin = dates[0]
  if (!checkin) return null
  const checkout = dates[1] || new Date(Date.parse(`${checkin}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10)
  const cleaned = mapPlaceWords(mapAreaCandidates(query)[0] || (location ? locationLabel(location) : ''))
  const city = knownCityIn(cleaned) || cleaned
  if (!city) return null
  const constraints = hotelConstraintsFromAsk(query)
  return googleHotelsRates({
    city,
    checkin,
    checkout,
    ...(constraints.maxPricePerNight ? { maxPriceUsd: constraints.maxPricePerNight } : {}),
    maxResults: 8,
  }).catch(() => null)
}

export async function trvlHotelBlockForAsk(query: string, location: LocationRow | null): Promise<string | null> {
  const dates = datesFromText(query)
  const checkin = dates[0]
  if (!checkin) return null
  // Two dates named = check-in and check-out; one date + a stay ask = the night after.
  const checkout = dates[1] || new Date(Date.parse(`${checkin}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10)
  const cleaned = mapPlaceWords(mapAreaCandidates(query)[0] || (location ? locationLabel(location) : ''))
  if (!cleaned) return null
  /* The reliable search key is the city, not the neighborhood: measured on
   * v1.21.6, "Chicago" returns Loop inventory 0.02-0.7 km out with room-level
   * cancellation rates, while "Chicago Loop" returned zero usable hotels. The
   * neighborhood still drives the answer — the distance ranking and the ask's
   * area filter decide which of the city's properties count as "near the
   * Loop". One search per turn: it measures 20-50s, and a second attempt would
   * blow every deadline, so the phrase itself is used only when no city could
   * be resolved from it. */
  const city = knownCityIn(cleaned) || cleaned
  const constraints = hotelConstraintsFromAsk(query)
  return trvlHotels({
    city,
    checkin,
    checkout,
    ...(constraints.maxPricePerNight ? { maxPricePerNight: constraints.maxPricePerNight } : {}),
    freeCancellation: constraints.freeCancellation,
    ...(constraints.maxDistanceKm ? { maxDistanceKm: constraints.maxDistanceKm } : {}),
  }).catch(() => null)
}

/**
 * Web search, with one paid upgrade: a flight ask from a tester number goes to
 * Google Flights first, because "finds real eligible fares" is the half of the
 * travel dimension the free search cannot do. Cached and budget-capped like the
 * hotel lookup, and everyone else gets the free path unchanged.
 */
export async function webSearchWithSerpFallback(query: string, phone?: string): Promise<string> {
  // A question about a hotel ("how far is my hotel from the airport?") is not
  // a booking ask; the rate search is a 20-50s provider call and must not run
  // for one.
  const questionAsk = /^\s*(?:what|which|who|when|where|how|is |are |does |do |any |can you|could you|tell me)/i.test(query.trim())
  if (looksLikeHotelAsk(query) && !questionAsk) {
    /* The model's own hotel habit is `lookup web` (the friend prompt says so),
     * and this path used to answer a dated booking ask from a web listicle —
     * the rates on screen were an aggregator's marketing copy, not rooms for
     * the nights. The same dated trvl source the maps tool uses runs here
     * first, with the ask's own price, cancellation and area constraints. */
    const block = await trvlHotelBlockForAsk(query, null)
    if (block) return block
  }
  if (looksLikeFlightAsk(query)) {
    /* trvl merges Google Flights, Kiwi and Skiplagged and costs nothing per
     * call, so a flight ask from any user gets real fares. The question says
     * which two places and when; the resolver turns a city into its airports. */
    const when = datesFromText(query)
    const route = routeFromText(query)
    // Same discipline as hotels: when trvl's upstreams throttle our IP, Google
    // Flights is rendered through scrape.do and the page's fares are read with
    // the extractor the browser path uses. Measured: JFK→ORD 2026-09-25→27 in
    // ~10s with airline, stops, times and prices.
    if (when[0] && route) {
      const google = await googleFlightsRates({
        from: route.from,
        to: route.to,
        date: when[0],
        ...(when[1] ? { returnDate: when[1] } : {}),
        ...(maxPriceFromAsk(query) ? { maxPriceUsd: maxPriceFromAsk(query)! } : {}),
      }).catch(() => null)
      if (google) return google
    }
    if (when[0] && route) {
      const fares = await trvlFlights({
        from: route.from,
        to: route.to,
        date: when[0],
        ...(when[1] ? { returnDate: when[1] } : {}),
        ...(maxPriceFromAsk(query) ? { maxPriceUsd: maxPriceFromAsk(query)! } : {}),
      }).catch(() => null)
      if (fares) return fares
    }
  }
  if (serpApiAllowedFor(phone) && looksLikeFlightAsk(query)) {
    const outbound = dateFromText(query)
    if (outbound) {
      const rest = query.replace(outbound, ' ')
      const back = dateFromText(rest)
      const route = routeFromText(query)
      const fares = await serpFlightFares({
        from: route?.from || '',
        to: route?.to || '',
        outbound,
        ...(back ? { returnDate: back } : {}),
      }).catch(() => null)
      if (fares) return fares
    }
  }
  const web = await fetchWebSearch(query)
  /* Every live fare/rate source above declined (no trvl binary, a throttled
   * provider, no metered key). A general web page is then the only thing left,
   * and it carries stale ranges and marketing copy, never a bookable price for
   * these dates — say so in the payload so the model cannot present a listicle
   * figure as a quote. */
  if (looksLikeFlightAsk(query) || looksLikeHotelAsk(query)) {
    return `LIVE FARE/RATE SOURCE UNAVAILABLE for this ask (the dated sources returned nothing). The text below is a general web search, not verified availability or prices for these dates: do not present any figure from it as a fare or a rate, and say plainly that live pricing could not be verified.\n\n${web}`
  }
  return web
}
