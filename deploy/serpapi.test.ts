import { afterEach, describe, expect, it } from 'bun:test'
import {
  dateFromText,
  datesFromText,
  looksLikeFlightAsk,
  looksLikeHotelAsk,
  resetSerpApiState,
  routeFromText,
  serpApiAllowedFor,
  serpApiBudget,
  serpHotelRates,
} from './serpapi'

const saved = { ...process.env }
afterEach(() => {
  process.env = { ...saved }
  resetSerpApiState()
})

describe('who may spend a SerpAPI call', () => {
  /* 250 searches a month is the entire budget, and they are for the benchmark
   * runs. A real user's lookup must never cost one. */
  it('is closed with no key, no testers, or mode off', () => {
    delete process.env.SERPAPI_API_KEY
    process.env.SERPAPI_TEST_PHONES = '+12163032166'
    expect(serpApiAllowedFor('+12163032166')).toBe(false)

    process.env.SERPAPI_API_KEY = 'k'
    delete process.env.SERPAPI_TEST_PHONES
    expect(serpApiAllowedFor('+12163032166')).toBe(false)

    process.env.SERPAPI_TEST_PHONES = '+12163032166'
    process.env.SERPAPI_MODE = 'off'
    expect(serpApiAllowedFor('+12163032166')).toBe(false)
  })

  it('opens only for the listed test numbers', () => {
    process.env.SERPAPI_API_KEY = 'k'
    delete process.env.SERPAPI_MODE
    process.env.SERPAPI_TEST_PHONES = '+12163032166, +15550001111'
    expect(serpApiAllowedFor('+12163032166')).toBe(true)
    expect(serpApiAllowedFor('+1 216 303 2166')).toBe(true)
    expect(serpApiAllowedFor('+15122217501')).toBe(false)
    expect(serpApiAllowedFor(undefined)).toBe(false)
  })

  it('stops at the daily budget', async () => {
    process.env.SERPAPI_API_KEY = 'k'
    process.env.SERPAPI_TEST_PHONES = '+12163032166'
    process.env.SERPAPI_DAILY_BUDGET = '1'
    let calls = 0
    globalThis.fetch = (async () => {
      calls++
      return new Response(JSON.stringify({ properties: [{ name: 'The Loop Hotel', rate_per_night: { extracted_lowest: 129 }, free_cancellation: true }] }), { status: 200 })
    }) as unknown as typeof fetch
    const first = await serpHotelRates({ query: 'hotels in the Loop', checkIn: '2026-09-25', checkOut: '2026-09-27' })
    expect(first).toContain('The Loop Hotel')
    expect(first).toContain('$129/night')
    expect(first).toContain('free cancellation')
    // Identical query: served from the day's cache, not a second call.
    await serpHotelRates({ query: 'hotels in the Loop', checkIn: '2026-09-25', checkOut: '2026-09-27' })
    expect(calls).toBe(1)
    // A different query would be the second call, and the budget is one.
    await serpHotelRates({ query: 'hotels near JFK', checkIn: '2026-09-25', checkOut: '2026-09-27' })
    expect(calls).toBe(1)
    expect(serpApiBudget()).toEqual({ spent: 1, limit: 1, left: 0 })
  })
})

describe('ask shapes', () => {
  it('recognizes a hotel ask and a flight ask', () => {
    expect(looksLikeHotelAsk('hotels in the Loop for Sep 25 to Sep 27')).toBe(true)
    expect(looksLikeHotelAsk('vegetarian restaurants near the Loop')).toBe(false)
    expect(looksLikeFlightAsk('round trip flight from New York to Chicago Sep 25')).toBe(true)
    expect(looksLikeFlightAsk('flight prices')).toBe(false)
  })

  it('reads the dates an ask names', () => {
    expect(dateFromText('hotels for 2026-09-25 to 2026-09-27')).toBe('2026-09-25')
    expect(dateFromText('hotels Sep 25 to Sep 27')).toBe('2026-09-25')
    expect(dateFromText('no dates here')).toBeNull()
  })
})

describe('datesFromText', () => {
  /* A stay names two dates. Resolving only the first made every booking a
   * single night, and the hotel lookup then searched the wrong window. */
  it('reads both dates of a stay, in order', () => {
    expect(datesFromText('hotels near the Loop Chicago Sep 25 to Sep 27 under 250 a night')).toEqual(['2026-09-25', '2026-09-27'])
    expect(datesFromText('flight from New York to Chicago 2026-09-25 returning 2026-09-27')).toEqual(['2026-09-25', '2026-09-27'])
    expect(datesFromText('hotel Sep 25')).toEqual(['2026-09-25'])
    expect(datesFromText('no dates at all')).toEqual([])
  })
})

describe('routeFromText', () => {
  /* Requiring the literal "from X to Y" meant the fare sources were skipped for
   * every other shape and the user got a Kayak mirror instead. */
  it('reads the route however the ask words it', () => {
    expect(routeFromText('round trip flights from New York to Chicago on Sep 25 returning Sep 27')).toEqual({ from: 'New York', to: 'Chicago' })
    expect(routeFromText('round trip flights New York to Chicago on Sep 25 return Sep 27')).toEqual({ from: 'New York', to: 'Chicago' })
    expect(routeFromText('flights JFK to ORD Sep 25')).toEqual({ from: 'JFK', to: 'ORD' })
  })

  it('does not mistake dates for a route', () => {
    expect(routeFromText('hotel Sep 25 to Sep 27 in Chicago')).toBeNull()
    expect(routeFromText('flight prices this week')).toBeNull()
  })
})
