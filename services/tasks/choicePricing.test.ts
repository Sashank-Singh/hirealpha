import { describe, expect, it } from 'bun:test'
import { cardIsFresh, priceDriftCents, requiresReapproval } from './choicePricing'
import type { TaskOption } from './taskContract'

const NOW = new Date('2026-09-14T18:00:00.000Z')

function card(overrides: Partial<TaskOption> = {}): TaskOption {
  return {
    id: 'a', title: 'A', price_cents: 4000, currency: 'USD',
    reason: 'r', source_url: 'https://x.test/a', freshness: '2026-09-14T17:55:00.000Z',
    ...overrides,
  }
}

describe('price freshness', () => {
  it('accepts cards inside the TTL and rejects older or junk ones', () => {
    expect(cardIsFresh(card(), NOW)).toBe(true)
    expect(cardIsFresh(card({ freshness: '2026-09-14T17:00:00.000Z' }), NOW)).toBe(false)
    expect(cardIsFresh(card({ freshness: '2026-09-14T17:59:59.000Z' }), NOW)).toBe(true)
    expect(cardIsFresh(card({ freshness: 'yesterday' }), NOW)).toBe(false)
    expect(cardIsFresh(card({ freshness: undefined }), NOW)).toBe(false)
  })
})

describe('checkout-vs-card reapproval math', () => {
  it('zero tolerance on increases: one cent higher reapproves', () => {
    const verdict = requiresReapproval(card(), { totalCents: 4001 })
    expect(verdict.reapproval).toBe(true)
    expect(verdict.reason).toBe('price-increase')
    expect(priceDriftCents(card(), 4001)).toBe(1)
  })

  it('lets cheaper and equal totals through', () => {
    expect(requiresReapproval(card(), { totalCents: 4000 })).toEqual({ reapproval: false })
    expect(requiresReapproval(card(), { totalCents: 3500 })).toEqual({ reapproval: false })
  })

  it('treats currency change and missing card price as needing explicit authority', () => {
    expect(requiresReapproval(card(), { totalCents: 4000, currency: 'EUR' }).reason).toBe('currency-change')
    expect(requiresReapproval(card({ price_cents: null }), { totalCents: 4000 }).reason).toBe('price-unknown')
    expect(requiresReapproval(card({ price_cents: null }), { totalCents: 0 }).reason).toBe('price-unknown')
  })

  it('defaults the card currency to USD when comparing', () => {
    expect(requiresReapproval(card({ currency: undefined }), { totalCents: 4000, currency: 'usd' })).toEqual({ reapproval: false })
  })
})
