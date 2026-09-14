import { describe, expect, it } from 'bun:test'
import { renderOptionCard, renderOptionCards, selectionFromReply } from './choiceCards'
import type { TaskOption } from './taskContract'

const NOW = new Date('2026-09-14T18:00:00.000Z')

function option(overrides: Partial<TaskOption> = {}): TaskOption {
  return {
    id: 'o-1',
    title: 'River Hotel',
    price_cents: 24700,
    currency: 'USD',
    reason: 'free cancellation, 5 min from your office',
    source_url: 'https://booking.test/river',
    source_label: 'Booking',
    freshness: '2026-09-14T17:50:00.000Z',
    available: true,
    ...overrides,
  }
}

describe('visual choice cards', () => {
  it('renders the full decision surface: price, reason, terms, source, freshness, link', () => {
    const card = renderOptionCard(
      option({ cancellation: 'free until 24h before', taxes_included: false }),
      1,
      NOW,
    )
    expect(card).toContain('1. River Hotel — $247 + taxes/fees')
    expect(card).toContain('free cancellation, 5 min from your office')
    expect(card).toContain('free until 24h before')
    expect(card).toContain('Booking · checked 10m ago')
    expect(card).toContain('https://booking.test/river')
  })

  it('falls back gracefully: no image needed, sold-out marked, no price, unknown host', () => {
    const soldOut = renderOptionCard(option({ available: false }), 2, NOW)
    expect(soldOut).toContain('(sold out)')
    const priceless = renderOptionCard(option({ price_cents: null }), 3, NOW)
    expect(priceless).not.toContain('$')
    expect(priceless).toContain('3. River Hotel')
    const bare = renderOptionCard(
      { id: 'x', title: 'Plain', reason: 'why', source_url: 'https://deep.example.com/a/b/c?d=1', freshness: NOW.toISOString() },
      4,
      NOW,
    )
    expect(bare).toContain('deep.example.com')
  })

  it('numbers the live cards in order, skips rejected ones, caps length, null on empty', () => {
    const options = [option(), option({ id: 'o-2', title: 'Second', currency: 'EUR', price_cents: 19900 }), option({ id: 'o-3', rejected: true })]
    const text = renderOptionCards(options, 'Chicago stay, Fri–Sun', { now: NOW })!
    expect(text).toContain('1. River Hotel')
    expect(text).toContain('2. Second — EUR 199')
    expect(text).not.toContain('3. River Hotel')
    expect(text).toContain('Reply a number to pick one, or ask me to compare.')
    expect(renderOptionCards([option({ rejected: true })], 'x', { now: NOW })).toBe(null)
    expect(renderOptionCards(options, '   ', { now: NOW })).toBe(null)
    const many = Array.from({ length: 40 }, (_, i) => option({ id: `o-${i}`, title: `Hotel ${i} with an unusually long name to blow the budget up and over it` }))
    expect(renderOptionCards(many, 'long', { now: NOW })!.length).toBeLessThanOrEqual(3500)
  })

  it('parses only the reply grammar it owns; everything else is the classifier’s', () => {
    const options = [option({ id: 'a' }), option({ id: 'b', title: 'B' }), option({ id: 'c', rejected: true })]
    expect(selectionFromReply('2', options)).toBe('b')
    expect(selectionFromReply(' first ', options)).toBe('a')
    expect(selectionFromReply('Second', options)).toBe('b')
    // rejected cards shrink the numbering space: only 1 live card remains ('b' at 1).
    expect(selectionFromReply('1', [option({ id: 'a', rejected: true }), option({ id: 'b' })])).toBe('b')
    expect(selectionFromReply('3', options)).toBe(null)
    expect(selectionFromReply('0', options)).toBe(null)
    expect(selectionFromReply('I like the second hotel actually', options)).toBe(null)
    expect(selectionFromReply('', options)).toBe(null)
    expect(selectionFromReply('1', [])).toBe(null)
  })

  it('relative freshness labels degrade to time unknown for junk', () => {
    const junk = renderOptionCard(option({ freshness: 'garbage' }), 1, NOW)
    expect(junk).toContain('time unknown')
  })
})
