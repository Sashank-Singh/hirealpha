import { describe, expect, it } from 'bun:test'
import type { ChatMessage } from '../../src/agents/types'
import { citiesIn, cityConflictInstruction, detectCityConflict, findActiveTrip, normalizeCity } from './cityConflict'

const now = Date.UTC(2026, 8, 18, 15, 0, 0) // 2026-09-18T15:00Z
const recent = now - 2 * 86_400_000

function user(content: string, ts = recent): ChatMessage {
  return { role: 'user', content, ts }
}

describe('city extraction', () => {
  it('normalizes aliases and drops time words', () => {
    expect(normalizeCity('NYC')).toBe('new york')
    expect(normalizeCity('New York City')).toBe('new york')
    expect(normalizeCity('Chicago Friday')).toBe('chicago')
    expect(normalizeCity('September')).toBeNull()
  })

  it('reads the destination from a from/to flight line', () => {
    expect(citiesIn('Book a flight from New York to Chicago on September 25')).toEqual(['new york', 'chicago'])
  })
})

describe('findActiveTrip', () => {
  it('finds the most recent lodging/trip plan', () => {
    const history = [
      user('Book a hotel stay in Chicago, Friday to Saturday next week.'),
      { role: 'assistant', content: 'Found rates in Chicago.', ts: recent } as ChatMessage,
      user('What is the weather?'),
    ]
    expect(findActiveTrip({ history, now })).toEqual({
      city: 'chicago',
      evidence: 'Book a hotel stay in Chicago, Friday to Saturday next week.',
    })
  })

  it('ignores trip plans older than the window', () => {
    const history = [user('Book a hotel in Chicago.', now - 30 * 86_400_000)]
    expect(findActiveTrip({ history, now })).toBeNull()
  })

  it('falls back to a timestamped travel fact', () => {
    expect(
      findActiveTrip({
        history: [],
        facts: [{ key: 'travel', value: 'NYC to Chicago, Sep 25-27', updatedAt: new Date(recent).toISOString() }],
        now,
      })?.city,
    ).toBe('chicago')
  })
})

describe('detectCityConflict', () => {
  const chicagoPlan = [user('Book a hotel stay in Chicago, Friday to Saturday next week, near the Loop.')]

  it('catches a New York place ask after a Chicago plan', () => {
    const conflict = detectCityConflict({
      userText: 'Great, now find me a dinner spot in New York on Saturday night.',
      history: chicagoPlan,
      now,
    })
    expect(conflict).toEqual({
      tripCity: 'chicago',
      askCity: 'new york',
      evidence: 'Book a hotel stay in Chicago, Friday to Saturday next week, near the Loop.',
    })
  })

  it('stays silent for a same-city ask', () => {
    expect(
      detectCityConflict({ userText: 'Find me dinner in Chicago on Friday.', history: chicagoPlan, now }),
    ).toBeNull()
  })

  it('stays silent when the flight destination is the planned city', () => {
    expect(
      detectCityConflict({
        userText: 'Book a flight from New York to Chicago on September 25, and dinner there that night.',
        history: chicagoPlan,
        now,
      }),
    ).toBeNull()
  })

  it('stays silent when the user explicitly replans', () => {
    expect(
      detectCityConflict({
        userText: "Actually we're going to New York instead. Find me dinner in New York.",
        history: chicagoPlan,
        now,
      }),
    ).toBeNull()
  })

  it('does not read a capitalized tool name as a trip city', () => {
    // Live: "passport information in Drive" made the active trip "Drive", and
    // every later place ask (Chicago hotel, NYC flight) was answered with a
    // nonsense "the plan in our thread is Drive" confirmation question.
    expect(
      detectCityConflict({
        userText: 'Book a hotel stay in Chicago, Friday to Saturday next week, under $250/night, near the Loop.',
        history: [
          { role: 'user', content: "Check in for tomorrow's flight using the confirmation in email and the passport information in Drive." },
          { role: 'assistant', content: 'There is no flight confirmation in your inbox.' },
        ] as never,
        now,
      }),
    ).toBeNull()
  })

  it('stays silent for non-place asks', () => {
    expect(
      detectCityConflict({ userText: 'What is the weather in New York?', history: chicagoPlan, now }),
    ).toBeNull()
  })

  it('writes one clear instruction for the model', () => {
    const conflict = detectCityConflict({
      userText: 'Find me a dinner reservation in New York this Saturday.',
      history: chicagoPlan,
      now,
    })!
    const instruction = cityConflictInstruction(conflict)
    expect(instruction).toContain('CITY CONFLICT')
    expect(instruction).toContain('chicago')
    expect(instruction).toContain('new york')
    expect(instruction).toContain('Do NOT search or book')
  })
})

describe('only real cities can conflict', () => {
  /* The confirm hijacked real traffic twice: "passport information in Drive"
   * and then "the same coffee beans … from Amazon" both became the ask city,
   * so an order was answered with "the plan in our thread is Chicago, but you
   * just asked about Amazon". */
  it('does not read a brand or a tool name as a city', () => {
    expect(normalizeCity('Amazon')).toBeNull()
    expect(normalizeCity('Drive')).toBeNull()
    expect(normalizeCity('Verkada')).toBeNull()
    expect(normalizeCity('Gmail')).toBeNull()
  })

  it('still reads the cities the check exists for', () => {
    expect(normalizeCity('Chicago')).toBe('chicago')
    expect(normalizeCity('New York')).toBe('new york')
    expect(normalizeCity('NYC')).toBe('new york')
    expect(normalizeCity('Chicago Friday')).toBe('chicago')
  })

  it('leaves an order alone even when a trip is planned in the thread', () => {
    const history = [
      { role: 'user' as const, content: 'Book me a hotel in Chicago for Friday and Saturday next week' },
      { role: 'assistant' as const, content: 'Staged the Loop hotel.' },
    ]
    expect(detectCityConflict({ userText: 'Order the same coffee beans I bought last time from Amazon, two bags, to my home address', history })).toBeNull()
    // And the case it exists for still fires.
    expect(detectCityConflict({ userText: 'Find a dinner spot for four in New York tomorrow at 7:30', history })?.askCity).toBe('new york')
  })
})
