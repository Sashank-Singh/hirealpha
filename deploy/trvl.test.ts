import { afterEach, describe, expect, it } from 'bun:test'
import { airportsFor, resetTrvlState, setTrvlRunner, trvlFlights, trvlHotels } from './trvl'

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
})
