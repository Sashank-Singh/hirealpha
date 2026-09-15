import { describe, expect, it } from 'bun:test'
import { parseEventInput } from './taskContract'
import {
  DEFAULT_TRANS_BUFFER_MINUTES,
  TRIP_SOURCE_PLACEHOLDER,
  findConflicts,
  legsToOptionCards,
  parseTripLegs,
  renderItineraryLines,
  sortItinerary,
  validateTripLeg,
  type TripLeg,
  type TripLegKind,
} from './trip'

/* ------------------------------------------------------------------ helpers */

let legCounter = 0

type LegSeed = {
  kind?: TripLegKind
  title?: string
  start: string
  end?: string | null
  city?: string
  place?: string
  ref?: string | null
  url?: string | null
  confirmedAt?: string | null
  priceCents?: number
  currency?: string
  id?: string
}

/** Builds an already-validated TripLeg for conflict/sort/render tests. */
function makeLeg(seed: LegSeed): TripLeg {
  legCounter += 1
  const raw: Record<string, unknown> = {
    id: seed.id ?? `leg-${legCounter}`,
    kind: seed.kind ?? 'activity',
    title: seed.title ?? 'Test leg',
    start_at: seed.start,
    end_at: seed.end ?? null,
    location: { city: seed.city ?? 'Chicago', ...(seed.place ? { place: seed.place } : {}) },
  }
  if (seed.ref !== undefined) raw.confirmation_ref = seed.ref
  if (seed.url !== undefined) raw.booking_url = seed.url
  if (seed.confirmedAt !== undefined) raw.confirmed_at = seed.confirmedAt
  if (seed.priceCents !== undefined) raw.price_cents = seed.priceCents
  if (seed.currency !== undefined) raw.currency = seed.currency
  return validateTripLeg(raw)
}

/** 2026-09-18 is a Friday; 2026-09-20 is a Sunday. All instants are UTC. */
const VALID = {
  id: 'flight-aa248',
  kind: 'flight',
  title: 'AA248 SFO→ORD',
  start_at: '2026-09-18T18:00:00Z',
  end_at: '2026-09-18T21:30:00Z',
  location: { city: 'Chicago', place: "O'Hare" },
  confirmation_ref: 'ORD887',
}

/* ------------------------------------------------------- validate / parse */

describe('validateTripLeg / parseTripLegs', () => {
  it('accepts and normalizes a well-formed leg', () => {
    const leg = validateTripLeg({ ...VALID, confirmation_ref: '  ORD887  ', currency: 'usd' })
    expect(leg.confirmation_ref).toBe('ORD887')
    expect(leg.currency).toBe('USD')
    expect(leg.end_at).toBe('2026-09-18T21:30:00Z')
    expect(leg.location.place).toBe("O'Hare")
  })

  it('accepts a null end_at as a point event', () => {
    const leg = validateTripLeg({ ...VALID, end_at: null })
    expect(leg.end_at).toBeNull()
  })

  it('accepts an offset-qualified ISO instant', () => {
    const leg = validateTripLeg({ ...VALID, start_at: '2026-09-18T13:00:00-05:00', end_at: '2026-09-18T16:30:00-05:00' })
    expect(Date.parse(leg.start_at)).toBe(Date.parse('2026-09-18T18:00:00Z'))
  })

  it('rejects an unknown kind', () => {
    expect(() => validateTripLeg({ ...VALID, kind: 'helicopter' })).toThrow(/kind/)
  })

  it('rejects junk, naive, and calendar-impossible start times', () => {
    expect(() => validateTripLeg({ ...VALID, start_at: 'not-an-iso' })).toThrow()
    expect(() => validateTripLeg({ ...VALID, start_at: '2026-09-18T18:00' })).toThrow(/ISO-8601/) // no zone
    expect(() => validateTripLeg({ ...VALID, start_at: '2026-02-30T00:00:00Z' })).toThrow() // Feb 30
    expect(() => validateTripLeg({ ...VALID, start_at: '18:00' })).toThrow()
    expect(() => validateTripLeg({ ...VALID, start_at: '2026-13-01T00:00:00Z' })).toThrow()
  })

  it('rejects end_at at or before start_at', () => {
    expect(() => validateTripLeg({ ...VALID, end_at: VALID.start_at })).toThrow(/after/)
    expect(() => validateTripLeg({ ...VALID, end_at: '2026-09-18T17:00:00Z' })).toThrow(/after/)
    expect(() => validateTripLeg({ ...VALID, end_at: 'garbage' })).toThrow(/ISO-8601/)
  })

  it('rejects a missing or empty city', () => {
    expect(() => validateTripLeg({ ...VALID, location: {} })).toThrow(/city/)
    expect(() => validateTripLeg({ ...VALID, location: { city: '   ' } })).toThrow(/city/)
    expect(() => validateTripLeg({ ...VALID, location: 'Chicago' })).toThrow(/location/)
  })

  it('rejects non-https booking links and junk prices/currency', () => {
    expect(() => validateTripLeg({ ...VALID, booking_url: 'http://book.example/x' })).toThrow(/https/)
    expect(() => validateTripLeg({ ...VALID, price_cents: -5 })).toThrow(/price_cents/)
    expect(() => validateTripLeg({ ...VALID, price_cents: 12.5 })).toThrow(/price_cents/)
    expect(() => validateTripLeg({ ...VALID, currency: 'dollars' })).toThrow(/currency/)
  })

  it('parseTripLegs accepts a JSON string and an array', () => {
    const legs = parseTripLegs(JSON.stringify([VALID, { ...VALID, id: 'x2', start_at: '2026-09-19T10:00:00Z', end_at: null }]))
    expect(legs).toHaveLength(2)
    expect(legs[1].id).toBe('x2')
    expect(parseTripLegs([])).toEqual([])
  })

  it('parseTripLegs fails closed on junk', () => {
    expect(() => parseTripLegs('{oops')).toThrow(/not valid JSON/)
    expect(() => parseTripLegs({ not: 'array' })).toThrow(/array/)
    expect(() => parseTripLegs([{ ...VALID, start_at: 'junk' }])).toThrow(/start_at/)
  })
})

/* ------------------------------------------------------------- conflicts */

describe('findConflicts: overlap', () => {
  it('flags two same-city non-stay legs whose intervals intersect', () => {
    const dinner = makeLeg({ kind: 'restaurant', title: 'Dinner', start: '2026-09-18T19:00:00Z', end: '2026-09-18T21:00:00Z' })
    const show = makeLeg({ kind: 'activity', title: 'Jazz show', start: '2026-09-18T20:00:00Z', end: '2026-09-18T22:00:00Z' })
    const conflicts = findConflicts([dinner, show])
    expect(conflicts).toHaveLength(1)
    expect(conflicts[0].reason).toBe('overlap')
    expect(conflicts[0].leg_ids).toEqual([dinner.id, show.id])
    expect(conflicts[0].gap_minutes).toBeLessThan(0)
  })

  it('does not flag same-city legs that merely touch back to back', () => {
    const lunch = makeLeg({ kind: 'restaurant', start: '2026-09-18T12:00:00Z', end: '2026-09-18T13:00:00Z' })
    const tour = makeLeg({ kind: 'activity', start: '2026-09-18T13:00:00Z', end: '2026-09-18T15:00:00Z' })
    expect(findConflicts([lunch, tour])).toEqual([])
  })

  it('two stays overlapping in different cities are a hard overlap conflict', () => {
    const chicago = makeLeg({ kind: 'stay', title: 'Hilton', start: '2026-09-18T20:00:00Z', end: '2026-09-19T11:00:00Z', city: 'Chicago' })
    const boston = makeLeg({ kind: 'stay', title: 'Marriott', start: '2026-09-18T22:00:00Z', end: '2026-09-19T11:00:00Z', city: 'Boston' })
    const conflicts = findConflicts([chicago, boston])
    expect(conflicts).toHaveLength(1)
    expect(conflicts[0].reason).toBe('overlap')
  })

  it('two stays overlapping in the same city are fine (split stay)', () => {
    const a = makeLeg({ kind: 'stay', start: '2026-09-18T20:00:00Z', end: '2026-09-19T11:00:00Z' })
    const b = makeLeg({ kind: 'stay', start: '2026-09-18T22:00:00Z', end: '2026-09-19T11:00:00Z' })
    expect(findConflicts([a, b])).toEqual([])
  })

  it('an on-site restaurant inside a stay window is fine', () => {
    const stay = makeLeg({ kind: 'stay', start: '2026-09-18T20:00:00Z', end: '2026-09-19T11:00:00Z', city: 'Chicago' })
    const dinner = makeLeg({ kind: 'restaurant', start: '2026-09-18T21:00:00Z', end: '2026-09-18T22:00:00Z', city: 'Chicago' })
    expect(findConflicts([stay, dinner])).toEqual([])
  })
})

describe('findConflicts: tight-connection', () => {
  it('flags a flight followed by a different-city leg inside the transport buffer', () => {
    const flight = makeLeg({ kind: 'flight', title: 'UA55 SFO→ORD', start: '2026-09-18T14:00:00Z', end: '2026-09-18T17:00:00Z', city: 'Chicago' })
    const dinner = makeLeg({ kind: 'restaurant', start: '2026-09-18T18:30:00Z', end: '2026-09-18T20:00:00Z', city: 'Milwaukee' })
    const conflicts = findConflicts([flight, dinner])
    expect(conflicts).toHaveLength(1)
    expect(conflicts[0].reason).toBe('tight-connection')
    expect(conflicts[0].leg_ids).toEqual([flight.id, dinner.id])
    expect(conflicts[0].gap_minutes).toBe(90)
  })

  it('honors a custom transbufferMinutes', () => {
    const flight = makeLeg({ kind: 'flight', start: '2026-09-18T14:00:00Z', end: '2026-09-18T17:00:00Z', city: 'Chicago' })
    const dinner = makeLeg({ kind: 'restaurant', start: '2026-09-18T17:50:00Z', city: 'Milwaukee' })
    expect(findConflicts([flight, dinner], { transbufferMinutes: 30 })).toEqual([])
    expect(findConflicts([flight, dinner], { transbufferMinutes: 60 })).toHaveLength(1)
  })

  it('uses the default 120-minute buffer', () => {
    expect(DEFAULT_TRANS_BUFFER_MINUTES).toBe(120)
    const flight = makeLeg({ kind: 'flight', start: '2026-09-18T14:00:00Z', end: '2026-09-18T17:00:00Z', city: 'Chicago' })
    const late = makeLeg({ kind: 'restaurant', start: '2026-09-18T19:30:00Z', city: 'Milwaukee' })
    expect(findConflicts([flight, late])).toEqual([]) // 150-min gap clears the buffer
  })

  it('same-city leg after a landing is not tight', () => {
    const flight = makeLeg({ kind: 'flight', start: '2026-09-18T14:00:00Z', end: '2026-09-18T17:00:00Z', city: 'Chicago' })
    const dinner = makeLeg({ kind: 'restaurant', start: '2026-09-18T17:30:00Z', city: 'Chicago' })
    expect(findConflicts([flight, dinner])).toEqual([])
  })

  it('flight-to-flight within the buffer in the same city is tight (airport transfer)', () => {
    const inbound = makeLeg({ kind: 'flight', title: 'AA100', start: '2026-09-18T14:00:00Z', end: '2026-09-18T17:00:00Z', city: 'Chicago' })
    const onward = makeLeg({ kind: 'flight', title: 'AA200', start: '2026-09-18T18:00:00Z', end: '2026-09-18T20:00:00Z', city: 'Chicago' })
    const conflicts = findConflicts([inbound, onward])
    expect(conflicts).toHaveLength(1)
    expect(conflicts[0].reason).toBe('tight-connection')
  })

  it('only flights trigger the connection rule', () => {
    const activity = makeLeg({ kind: 'activity', start: '2026-09-18T14:00:00Z', end: '2026-09-18T17:00:00Z', city: 'Chicago' })
    const next = makeLeg({ kind: 'restaurant', start: '2026-09-18T17:30:00Z', city: 'Milwaukee' })
    const conflicts = findConflicts([activity, next])
    expect(conflicts).toHaveLength(1)
    expect(conflicts[0].reason).toBe('teleport') // 30 min across cities is physics, not a buffer hint
  })

  it('rejects a nonsensical buffer', () => {
    expect(() => findConflicts([], { transbufferMinutes: 0 })).toThrow(/positive/)
    expect(() => findConflicts([], { transbufferMinutes: Number.NaN })).toThrow(/positive/)
  })
})

describe('findConflicts: teleport', () => {
  it('flags different-city legs with a sub-45-minute gap', () => {
    const chicago = makeLeg({ kind: 'activity', start: '2026-09-18T10:00:00Z', end: '2026-09-18T12:00:00Z', city: 'Chicago' })
    const detroit = makeLeg({ kind: 'restaurant', start: '2026-09-18T12:20:00Z', city: 'Detroit' })
    const conflicts = findConflicts([chicago, detroit])
    expect(conflicts).toHaveLength(1)
    expect(conflicts[0].reason).toBe('teleport')
  })

  it('flags a later-city leg starting before the earlier leg ends', () => {
    const chicago = makeLeg({ kind: 'restaurant', start: '2026-09-18T10:00:00Z', end: '2026-09-18T12:00:00Z', city: 'Chicago' })
    const detroit = makeLeg({ kind: 'activity', start: '2026-09-18T11:00:00Z', end: '2026-09-18T13:00:00Z', city: 'Detroit' })
    const conflicts = findConflicts([chicago, detroit])
    expect(conflicts).toHaveLength(1)
    expect(conflicts[0].reason).toBe('teleport')
    expect(conflicts[0].gap_minutes).toBeLessThan(0)
  })

  it('clears the gap with 45+ minutes between cities', () => {
    const chicago = makeLeg({ kind: 'activity', start: '2026-09-18T10:00:00Z', end: '2026-09-18T12:00:00Z', city: 'Chicago' })
    const detroit = makeLeg({ kind: 'restaurant', start: '2026-09-18T13:00:00Z', city: 'Detroit' })
    expect(findConflicts([chicago, detroit])).toEqual([])
  })

  it('movement legs are the sanctioned way cities change', () => {
    // A flight departing 20 min after an activity, listed with its arrival city, is physics-fine.
    const chicago = makeLeg({ kind: 'activity', start: '2026-09-18T10:00:00Z', end: '2026-09-18T12:00:00Z', city: 'Chicago' })
    const flight = makeLeg({ kind: 'flight', title: 'UA7 Delta-bound', start: '2026-09-18T12:20:00Z', end: '2026-09-18T15:00:00Z', city: 'Atlanta' })
    expect(findConflicts([chicago, flight])).toEqual([])
  })

  it('a train bridging two cities clears a sub-45-minute arrival gap', () => {
    const before = makeLeg({ kind: 'activity', start: '2026-09-18T10:00:00Z', end: '2026-09-18T12:00:00Z', city: 'Chicago' })
    const train = makeLeg({ kind: 'transport', start: '2026-09-18T12:10:00Z', end: '2026-09-18T15:00:00Z', city: 'St. Louis' })
    expect(findConflicts([before, train])).toEqual([])
  })
})

describe('findConflicts: determinism', () => {
  it('returns identical conflicts regardless of input order', () => {
    const a = makeLeg({ kind: 'restaurant', start: '2026-09-18T10:00:00Z', end: '2026-09-18T12:00:00Z', city: 'Chicago' })
    const b = makeLeg({ kind: 'activity', start: '2026-09-18T11:00:00Z', end: '2026-09-18T13:00:00Z', city: 'Chicago' })
    const c = makeLeg({ kind: 'restaurant', start: '2026-09-18T13:10:00Z', city: 'Detroit' })
    const forward = findConflicts([a, b, c])
    const scrambled = findConflicts([c, a, b])
    expect(scrambled).toEqual(forward)
    expect(forward.map((conflict) => conflict.reason)).toEqual(['overlap', 'teleport'])
  })
})

/* ------------------------------------------------------------------ sorting */

describe('sortItinerary', () => {
  it('orders legs chronologically', () => {
    const late = makeLeg({ start: '2026-09-20T09:00:00Z', title: 'Late' })
    const early = makeLeg({ start: '2026-09-18T09:00:00Z', title: 'Early' })
    const middle = makeLeg({ start: '2026-09-19T09:00:00Z', title: 'Middle' })
    expect(sortItinerary([late, early, middle]).map((leg) => leg.title)).toEqual(['Early', 'Middle', 'Late'])
  })

  it('breaks start-time ties by id (stable, total order)', () => {
    const b = makeLeg({ id: 'b-leg', start: '2026-09-18T12:00:00Z' })
    const a = makeLeg({ id: 'a-leg', start: '2026-09-18T12:00:00Z' })
    expect(sortItinerary([b, a]).map((leg) => leg.id)).toEqual(['a-leg', 'b-leg'])
  })

  it('fails closed on junk timestamps instead of guessing', () => {
    const junk = { ...makeLeg({ start: '2026-09-18T12:00:00Z' }), start_at: 'someday' }
    const good = makeLeg({ start: '2026-09-19T12:00:00Z' })
    expect(() => sortItinerary([junk, good])).toThrow(/invalid start_at/)
  })
})

/* ---------------------------------------------------------------- rendering */

describe('renderItineraryLines', () => {
  it('renders the contract line for a confirmed flight', () => {
    const leg = validateTripLeg(VALID)
    const [line] = renderItineraryLines([leg])
    expect(line).toContain('Fri 18:00') // en-US Intl, UTC-pinned
    expect(line).toContain('–21:30')
    expect(line).toContain('AA248 SFO→ORD')
    expect(line).toContain("Chicago, O'Hare")
    expect(line).toContain('(confirmed ORD887)')
  })

  it('renders multi-day stays with a month/day end', () => {
    const stay = makeLeg({ kind: 'stay', title: 'Hilton', start: '2026-09-18T20:00:00Z', end: '2026-09-20T11:00:00Z' })
    const [line] = renderItineraryLines([stay])
    expect(line).toContain('Sep 20')
    expect(line).toContain('11:00')
  })

  it('orders lines chronologically without pre-sorting', () => {
    const late = makeLeg({ start: '2026-09-20T09:00:00Z', title: 'Late dinner' })
    const early = makeLeg({ start: '2026-09-18T09:00:00Z', title: 'Arrival walk' })
    const lines = renderItineraryLines([late, early])
    expect(lines[0]).toContain('Arrival walk')
    expect(lines[1]).toContain('Late dinner')
  })

  it('drops a junk-ISO leg with a flagged line and never crashes', () => {
    const junk = { ...makeLeg({ title: 'Ghost booking', start: '2026-09-18T09:00:00Z' }), start_at: 'next tuesday-ish' }
    const good = makeLeg({ start: '2026-09-18T09:00:00Z', title: 'Real leg' })
    const lines = renderItineraryLines([junk, good])
    expect(lines).toHaveLength(2)
    const flagged = lines.find((line) => line.includes('[!]'))
    expect(flagged).toBeDefined()
    expect(flagged).toContain('dropped')
    expect(flagged).toContain('Ghost booking')
    expect(lines.some((line) => line.includes('Real leg'))).toBe(true)
  })

  it('ignores a junk `now` instead of crashing', () => {
    const leg = makeLeg({ start: '2026-09-18T09:00:00Z', end: '2026-09-18T10:00:00Z' })
    const lines = renderItineraryLines([leg], 'whenever')
    expect(lines[0]).not.toContain('past')
  })

  it('annotates ended legs when now is provided', () => {
    const past = makeLeg({ start: '2026-09-18T09:00:00Z', end: '2026-09-18T10:00:00Z', title: 'Past dinner' })
    const future = makeLeg({ start: '2026-09-19T09:00:00Z', end: '2026-09-19T10:00:00Z', title: 'Future dinner' })
    const lines = renderItineraryLines([past, future], '2026-09-18T23:00:00Z')
    expect(lines[0]).toContain('past')
    expect(lines[1]).not.toContain('past')
  })
})

/* ----------------------------------------------------------- option cards */

describe('legsToOptionCards', () => {
  const NOW = '2026-09-17T12:00:00Z'

  it('publishes legs through the real options_published contract', () => {
    const leg = makeLeg({ kind: 'flight', title: 'AA248 SFO→ORD', start: '2026-09-18T18:00:00Z', url: 'https://book.alpha.test/aa248', confirmedAt: '2026-09-15T10:00:00Z', ref: 'ORD887' })
    const cards = legsToOptionCards([leg])
    expect(cards).toHaveLength(1)
    const parsed = parseEventInput({ type: 'options_published', payload: { options: cards } })
    expect(parsed.type).toBe('options_published')
    if (parsed.type === 'options_published') {
      expect(parsed.payload.options[0].source_url).toBe('https://book.alpha.test/aa248')
      expect(parsed.payload.options[0].freshness).toBe('2026-09-15T10:00:00Z')
      expect(parsed.payload.options[0].source_label).toBe('Confirmation ORD887')
    }
  })

  it('prefers the leg confirmation time, falls back to the provided now', () => {
    const withTime = makeLeg({ start: '2026-09-18T09:00:00Z', url: 'https://book.alpha.test/a', confirmedAt: '2026-09-10T08:00:00Z' })
    const bare = makeLeg({ start: '2026-09-19T09:00:00Z', url: 'https://book.alpha.test/b' })
    const cards = legsToOptionCards([withTime, bare], { now: NOW })
    expect(cards[0].freshness).toBe('2026-09-10T08:00:00Z')
    expect(cards[1].freshness).toBe(NOW)
  })

  it('dedups by leg id, keeping the first itinerary-order occurrence', () => {
    const first = makeLeg({ id: 'dup', start: '2026-09-18T09:00:00Z', title: 'First copy', url: 'https://book.alpha.test/1' })
    const second = makeLeg({ id: 'dup', start: '2026-09-18T10:00:00Z', title: 'Second copy', url: 'https://book.alpha.test/2' })
    const cards = legsToOptionCards([second, first], { now: NOW })
    expect(cards).toHaveLength(1)
    expect(cards[0].title).toBe('First copy')
  })

  it('allows the internal placeholder source only for a leg carrying its own confirmation ref', () => {
    const leg = makeLeg({ start: '2026-09-18T09:00:00Z', ref: 'HTL42', confirmedAt: NOW })
    const cards = legsToOptionCards([leg])
    expect(cards[0].source_url).toBe(TRIP_SOURCE_PLACEHOLDER)
    expect(TRIP_SOURCE_PLACEHOLDER.startsWith('https://')).toBe(true)
  })

  it('rejects linkless legs with no provenance anchor — no fabricated sources', () => {
    const leg = makeLeg({ start: '2026-09-18T09:00:00Z', confirmedAt: NOW })
    expect(() => legsToOptionCards([leg])).toThrow(/leg .*refusing to fabricate/)
  })

  it('rejects when neither the leg nor the caller supplies a freshness source', () => {
    const leg = makeLeg({ start: '2026-09-18T09:00:00Z', url: 'https://book.alpha.test/a' })
    expect(() => legsToOptionCards([leg])).toThrow(/freshness/)
  })

  it('rejects a junk now instead of publishing an unanchored timestamp', () => {
    const leg = makeLeg({ start: '2026-09-18T09:00:00Z', url: 'https://book.alpha.test/a' })
    expect(() => legsToOptionCards([leg], { now: 'soon' })).toThrow(/now/)
  })

  it('copies price and currency onto the card', () => {
    const leg = makeLeg({ start: '2026-09-18T09:00:00Z', url: 'https://book.alpha.test/a', confirmedAt: NOW, priceCents: 18900, currency: 'usd' })
    const cards = legsToOptionCards([leg])
    expect(cards[0].price_cents).toBe(18900)
    expect(cards[0].currency).toBe('USD')
  })
})

/* ---------------------------------------------------------------- round trip */

describe('parse -> sort -> render -> cards smoke', () => {
  it('carries one trip through every stage without a second truth', () => {
    const legs = parseTripLegs([
      {
        id: 'stay-hilton',
        kind: 'stay',
        title: 'Hilton Chicago',
        start_at: '2026-09-18T22:00:00Z',
        end_at: '2026-09-20T11:00:00Z',
        location: { city: 'Chicago' },
        confirmation_ref: 'HTL77',
        booking_url: 'https://book.alpha.test/htl77',
        confirmed_at: '2026-09-10T08:00:00Z',
      },
      {
        id: 'flight-aa248',
        kind: 'flight',
        title: 'AA248 SFO→ORD',
        start_at: '2026-09-18T18:00:00Z',
        end_at: '2026-09-18T21:30:00Z',
        location: { city: 'Chicago', place: "O'Hare" },
        confirmation_ref: 'ORD887',
        price_cents: 32000,
        currency: 'USD',
        confirmed_at: '2026-09-09T08:00:00Z',
      },
    ])
    const sorted = sortItinerary(legs)
    expect(sorted.map((leg) => leg.id)).toEqual(['flight-aa248', 'stay-hilton'])

    const lines = renderItineraryLines(sorted, '2026-09-17T00:00:00Z')
    expect(lines).toHaveLength(2)
    expect(lines[0]).toContain('Fri 18:00–21:30')
    expect(lines[0]).toContain('(confirmed ORD887)')
    expect(lines.every((line) => !line.includes('[!]'))).toBe(true)

    // No conflicts: the stay starts after the flight lands, same city.
    expect(findConflicts(sorted)).toEqual([])

    const parsed = parseEventInput({ type: 'options_published', payload: { options: legsToOptionCards(sorted) } })
    if (parsed.type !== 'options_published') throw new Error('unreachable')
    expect(parsed.payload.options.map((card) => card.id)).toEqual(['flight-aa248', 'stay-hilton'])
    // The flight carries only a confirmation ref -> internal placeholder source;
    // the stay carries its own booking link -> real provenance.
    expect(parsed.payload.options[0].source_url).toBe(TRIP_SOURCE_PLACEHOLDER)
    expect(parsed.payload.options[1].source_url).toBe('https://book.alpha.test/htl77')
  })
})
