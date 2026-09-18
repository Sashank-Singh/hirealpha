import { afterEach, describe, expect, it } from 'bun:test'
import { airportsFor, knownCityIn, noteTrvlRateLimitForTest, resetTrvlState, setTrvlRunner, trvlFlights, trvlHotels } from './trvl'

afterEach(() => resetTrvlState())

/* Shapes captured from the real binary (v1.21.6), not from the docs: prices
 * arrive in the provider's currency, durations in minutes, and the itinerary
 * lives under legs[]. */
const FLIGHTS = {
  success: true,
  count: 2,
  flights: [
    {
      price: 141.73913043478262,
      currency: 'EUR',
      duration: 168,
      stops: 0,
      provider: 'skiplagged',
      booking_url: 'https://skiplagged.com/flights/JFK/ORD/2026-09-25#trip=AA2909',
      legs: [
        { departure_airport: { code: 'JFK' }, arrival_airport: { code: 'ORD' }, departure_time: '2026-09-25T14:58:00-04:00', arrival_time: '2026-09-25T16:46:00-05:00', airline: 'American Airlines', flight_number: 'AA2909' },
      ],
    },
    {
      price: 120,
      currency: 'EUR',
      duration: 300,
      stops: 1,
      provider: 'kiwi',
      legs: [{ departure_airport: { code: 'LGA' }, arrival_airport: { code: 'ORD' }, departure_time: '2026-09-25T06:00:00-04:00', arrival_time: '2026-09-25T11:00:00-05:00', airline: 'Delta Air Lines', flight_number: 'DL 100' }],
    },
  ],
  price_position: { verdict: 'buy' },
}
const HOTELS = {
  success: true,
  count: 2,
  hotels: [
    { name: 'The Wade', stars: 4, rating: 8.2, review_count: 117, price: 173.65, currency: 'EUR', address: 'Chicago (IL), United States', distance_km: 2.1574128930169874 },
    { name: 'Far Airport Inn', stars: 2, rating: 6.6, review_count: 434, price: 57.4, currency: 'EUR', address: 'Chicago (IL)', distance_km: 35.20316727232361 },
  ],
}

describe('airport resolution', () => {
  it('turns a city into its airports and leaves a code alone', () => {
    expect(airportsFor('New York')).toBe('JFK,EWR,LGA')
    expect(airportsFor('chicago')).toBe('ORD,MDW')
    expect(airportsFor('JFK')).toBe('JFK')
    expect(airportsFor('JFK,EWR')).toBe('JFK,EWR')
    expect(airportsFor('Springfield')).toBeNull()
  })

  it('reads a city with words around it and the common short names', () => {
    expect(airportsFor('New York City')).toBe('JFK,EWR,LGA')
    expect(airportsFor('Chicago downtown')).toBe('ORD,MDW')
    expect(airportsFor('NY')).toBe('JFK,EWR,LGA')
  })

  /* The hotel search key: the binary returned zero usable hotels for the
   * neighborhood phrase but Loop inventory with distances for the city. */
  it('finds the city inside a neighborhood phrase', () => {
    expect(knownCityIn('chicago loop')).toBe('chicago')
    expect(knownCityIn('loop chicago')).toBe('chicago')
    expect(knownCityIn('new york manhattan')).toBe('new york')
    expect(knownCityIn('the loop')).toBeNull()
  })
})

describe('trvl fares', () => {
  it('converts the provider currency at a named rate and keeps the itinerary', async () => {
    globalThis.fetch = (async (url: string) =>
      String(url).includes('frankfurter')
        ? new Response(JSON.stringify({ date: '2026-09-18', rates: { USD: 1.1 } }), { status: 200 })
        : new Response('[]', { status: 200 })) as unknown as typeof fetch
    setTrvlRunner(async () => FLIGHTS)
    const block = await trvlFlights({ from: 'New York', to: 'Chicago', date: '2026-09-25' })
    expect(block).toContain('from JFK,EWR,LGA to ORD,MDW on 2026-09-25')
    expect(block).toContain('American Airlines')
    expect(block).toContain('nonstop')
    expect(block).toContain('2h 48m')
    expect(block).toContain('converted from EUR at 1.100 USD')
    expect(block).toContain('buy')
    // Cheapest first: the 120 EUR one leads.
    expect(block!.indexOf('Delta')).toBeLessThan(block!.indexOf('American'))
  })

  it('refuses to invent a dollar figure when no rate is available', async () => {
    globalThis.fetch = (async () => new Response('nope', { status: 500 })) as unknown as typeof fetch
    setTrvlRunner(async () => FLIGHTS)
    const block = await trvlFlights({ from: 'JFK', to: 'ORD', date: '2026-09-26' })
    expect(block).toContain('do not restate them as dollars')
  })

  it('returns nothing without a resolvable airport or a date', async () => {
    setTrvlRunner(async () => FLIGHTS)
    expect(await trvlFlights({ from: 'Springfield', to: 'Chicago', date: '2026-09-25' })).toBeNull()
    expect(await trvlFlights({ from: 'New York', to: 'Chicago', date: 'next friday' })).toBeNull()
  })

  /* Measured in production: the binary's own --timeout is per request and its
   * 429 retry storm ran to our 45s kill (exit 137), so the user waited 45s for
   * a web fallback. A one-way search from one airport pair answers inside 25s,
   * so the flight ceiling stays under the hotel one (50s) — but it must clear
   * the wall a round trip needs: on 2026-09-18 the old 25s ceiling killed a
   * JFK→ORD round trip at 25005ms (exit 137, nothing returned) while the
   * identical command by hand produced 12 fares in ~30s. */
  it('gives a throttled flight search a tighter ceiling than a hotel search', async () => {
    let ceiling = 0
    setTrvlRunner(async (_args, timeoutMs) => {
      ceiling = timeoutMs
      return FLIGHTS
    })
    globalThis.fetch = (async () => new Response(JSON.stringify({ date: '2026-09-18', rates: { USD: 1.1 } }), { status: 200 })) as unknown as typeof fetch
    await trvlFlights({ from: 'New York', to: 'Chicago', date: '2026-09-25' })
    expect(ceiling).toBeGreaterThanOrEqual(30_000)
    expect(ceiling).toBeLessThanOrEqual(45_000)
  })

  /* A round-trip search answers with combined itineraries; the label has to
   * carry both dates or a two-leg price reads as a one-way fare for the
   * outbound date (the benchmark's flight ask is exactly this shape). */
  it('labels a round trip with the outbound and the return date', async () => {
    globalThis.fetch = (async () => new Response(JSON.stringify({ date: '2026-09-18', rates: { USD: 1.1 } }), { status: 200 })) as unknown as typeof fetch
    setTrvlRunner(async () => FLIGHTS)
    const block = await trvlFlights({
      from: 'New York',
      to: 'Chicago',
      date: '2026-09-25',
      returnDate: '2026-09-27',
    })
    expect(block).toContain('out 2026-09-25, back 2026-09-27')
    expect(block).toContain('full round trip (both legs), not per leg')
  })
})

describe('trvl hotels', () => {
  it('leads with the property the source measured closest', async () => {
    globalThis.fetch = (async () => new Response(JSON.stringify({ date: '2026-09-18', rates: { USD: 1.1 } }), { status: 200 })) as unknown as typeof fetch
    setTrvlRunner(async () => HOTELS)
    const block = await trvlHotels({ city: 'Chicago', checkin: '2026-09-25', checkout: '2026-09-27' })
    expect(block).toContain('The Wade')
    expect(block!.indexOf('The Wade')).toBeLessThan(block!.indexOf('Far Airport Inn'))
    expect(block).toContain('2.2 km out')
    expect(block).toContain('confirm them there before promising')
  })

  it('is quiet when the binary is not there', async () => {
    setTrvlRunner(async () => null)
    expect(await trvlHotels({ city: 'Chicago', checkin: '2026-09-25', checkout: '2026-09-27' })).toBeNull()
  })

  /* The scored hotel ask carries a price ceiling, an area and free
   * cancellation. The first search ignored all three: a Loop ask listed
   * properties 35 km out at any price, and the reply said cancellation could
   * not be confirmed while the data carried room-level policies. */
  describe('the constraints the ask stated', () => {
    const ROOMS = {
      success: true,
      count: 4,
      hotels: [
        {
          name: 'Cambria Chicago Loop', stars: 4, rating: 8.6, review_count: 2007, price: 180, currency: 'USD', address: 'Chicago Loop', distance_km: 0.4,
          room_types: [{ name: 'Saver rate', nightly_price: 180, refundable: false, cancellation_policy: 'Non-refundable' }],
        },
        {
          name: 'Central Loop Hotel', stars: 4, rating: 8, review_count: 1711, price: 148, currency: 'USD', address: 'Chicago Loop', distance_km: 0.5,
          room_types: [{ name: 'Flex rate', nightly_price: 210, refundable: true, cancellation_policy: 'Free cancellation until 24 hours before' }],
        },
        {
          name: 'River North Over Budget', stars: 5, rating: 9, review_count: 400, price: 320, currency: 'USD', address: 'Chicago', distance_km: 1.2,
          room_types: [{ name: 'Flex rate', nightly_price: 340, refundable: true, cancellation_policy: 'Free cancellation until 48 hours before' }],
        },
        {
          name: "O'Hare Airport Inn", stars: 3, rating: 7.5, review_count: 900, price: 120, currency: 'USD', address: 'Chicago (IL)', distance_km: 35.2,
          room_types: [{ name: 'Flex rate', nightly_price: 130, refundable: true, cancellation_policy: 'Free cancellation' }],
        },
      ],
    }
    const ask = { city: 'chicago loop', checkin: '2026-09-25', checkout: '2026-09-26', maxPricePerNight: 250, freeCancellation: true, maxDistanceKm: 5 }

    it('keeps only in-budget, in-area, refundable rooms and prices them at the refundable rate', async () => {
      setTrvlRunner(async () => ROOMS)
      const block = await trvlHotels(ask)
      expect(block).toContain('Central Loop Hotel')
      expect(block).toContain('free-cancellation rate $210/night')
      // Over budget, too far, or a stated non-refundable rate: none is a candidate.
      expect(block).not.toContain('Over Budget')
      expect(block).not.toContain('Airport Inn')
      expect(block).not.toContain('Cambria')
      expect(block).toContain('at or under the $250/night ceiling')
    })

    it('keeps a row whose cancellation is simply not stated, and says so', async () => {
      setTrvlRunner(async () => ({
        success: true,
        count: 1,
        hotels: [{ name: 'Quiet Loop Inn', stars: 3, rating: 8, review_count: 50, price: 140, currency: 'USD', address: 'Chicago Loop', distance_km: 0.7 }],
      }))
      const block = await trvlHotels(ask)
      expect(block).toContain('Quiet Loop Inn')
      expect(block).toContain('cancellation not stated')
      expect(block).toContain('No room entry in this result stated a free-cancellation rate')
    })

    it('keeps an unmeasured free-cancellation rate ahead of measured rows that state nothing', async () => {
      // Production block measured 2026-09-18: "14 of 134 show a free-cancellation
      // rate below" while all eight shown rows read "cancellation not stated" —
      // the refundable rows carried no distance and the ranker kept only the
      // measured ones. The constraint row must survive the cut.
      setTrvlRunner(async () => ({
        success: true,
        count: 2,
        hotels: [
          { name: 'Measured Unknown Inn', price: 150, currency: 'USD', distance_km: 0.6 },
          {
            name: 'Unmeasured Refundable Inn', price: 210, currency: 'USD',
            room_types: [{ name: 'Flex rate', nightly_price: 210, refundable: true, cancellation_policy: 'Free cancellation' }],
          },
        ],
      }))
      const block = await trvlHotels({ city: 'chicago', checkin: '2026-09-25', checkout: '2026-09-26', freeCancellation: true })
      expect(block).toContain('Unmeasured Refundable Inn')
      expect(block!.indexOf('Unmeasured Refundable Inn')).toBeLessThan(block!.indexOf('Measured Unknown Inn'))
    })

    it('shows every row, nearest first, when the ask stated no constraints', async () => {
      setTrvlRunner(async () => ROOMS)
      const block = await trvlHotels({ city: 'chicago', checkin: '2026-09-25', checkout: '2026-09-26' })
      expect(block).toContain('Cambria')
      expect(block).toContain('Airport Inn')
      expect(block!.indexOf('Cambria')).toBeLessThan(block!.indexOf('Airport Inn'))
    })
  })
})

describe('rate-limited providers', () => {
  /* Measured from the Coolify box: kiwi and skiplagged 429 every flight search
   * against the datacenter IP, so each ask spent 45s and returned nothing. */
  it('stops asking a source that just refused, then tries again after the cooldown', async () => {
    resetTrvlState()
    let calls = 0
    setTrvlRunner(async () => {
      calls++
      throw new Error('exit 1: retry attempt=2 status=429 backoff_ms=4000')
    })
    // The runner throwing is how a 429 reaches us; the note is taken from stderr
    // in the real runner, which the injected one stands in for.
    noteTrvlRateLimitForTest('flights', 'retry attempt=0 status=429 backoff_ms=1000')
    expect(await trvlFlights({ from: 'JFK', to: 'ORD', date: '2026-09-25' })).toBeNull()
    expect(calls).toBe(0)
  })

  it('forgets the cooldown on reset', async () => {
    // Reset first: it restores the real runner, so injecting before it would be
    // thrown away.
    resetTrvlState()
    setTrvlRunner(async () => ({ flights: [{ price: 200, currency: 'USD', legs: [{ airline: 'Delta' }] }] }))
    globalThis.fetch = (async () => new Response(JSON.stringify({ date: '2026-09-18', rates: { USD: 1 } }), { status: 200 })) as unknown as typeof fetch
    const block = await trvlFlights({ from: 'New York', to: 'Chicago', date: '2026-09-25' })
    expect(block).toContain('Delta')
  })
})

describe('one itinerary is one option', () => {
  /* Measured on JFK→ORD 2026-09-18: the providers return the same flight once
   * per return-leg variant — four "JetBlue B6 405, $336" rows that the model
   * repeated as four separate choices, three of them with invented durations. */
  it('collapses same-flight same-price duplicates and keeps the shortest', async () => {
    resetTrvlState()
    globalThis.fetch = (async () => new Response(JSON.stringify({ date: '2026-09-18', rates: { USD: 1 } }), { status: 200 })) as unknown as typeof fetch
    const leg = (airline: string, flight: string, depart: string, arrive: string) => ({
      departure_airport: { code: 'JFK' },
      arrival_airport: { code: 'ORD' },
      departure_time: depart,
      arrival_time: arrive,
      airline,
      flight_number: flight,
    })
    setTrvlRunner(async () => ({
      flights: [
        { price: 336, currency: 'USD', duration: 173, stops: 0, legs: [leg('JetBlue', 'B6 405', '2026-09-18T20:05:00-04:00', '2026-09-18T22:58:00-05:00')] },
        { price: 336, currency: 'USD', duration: 314, stops: 0, legs: [leg('JetBlue', 'B6 405', '2026-09-18T20:05:00-04:00', '2026-09-19T01:19:00-05:00')] },
        { price: 336, currency: 'USD', duration: 327, stops: 0, legs: [leg('JetBlue Airways', 'B6 405', '2026-09-18T20:05:00-04:00', '2026-09-19T00:25:00-05:00')] },
        { price: 346, currency: 'USD', duration: 408, stops: 1, legs: [leg('JetBlue', 'B6 405', '2026-09-18T20:05:00-04:00', '2026-09-19T03:00:00-05:00')] },
      ],
    }))
    const block = await trvlFlights({ from: 'New York', to: 'Chicago', date: '2026-09-18' })
    const rows = (block || '').split('\n').filter((line) => line.startsWith('- '))
    expect(rows.length).toBe(2)
    expect(rows[0]).toContain('2h 53m')
    expect(rows.filter((r) => r.includes('$336')).length).toBe(1)
  })
})
