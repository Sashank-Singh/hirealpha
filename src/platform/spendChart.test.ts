import { describe, expect, it } from 'bun:test'
import {
  SPEND_SLOTS,
  SPEND_SLOT_COLORS,
  aggregateSpend,
  spendCategorySlot,
  spendSegments,
  spendSlices,
} from './spendChart'

describe('spendCategorySlot', () => {
  it('keeps the six known categories', () => {
    for (const slot of SPEND_SLOTS) expect(spendCategorySlot(slot)).toBe(slot)
  })

  it('folds anything it does not recognise into other', () => {
    // The SMS agent lets you log free text, so these really do arrive.
    expect(spendCategorySlot('Coffee')).toBe('other')
    expect(spendCategorySlot('vet bill')).toBe('other')
    expect(spendCategorySlot('')).toBe('other')
  })

  it('is forgiving about case and stray whitespace', () => {
    expect(spendCategorySlot('  Food ')).toBe('food')
    expect(spendCategorySlot('SUBSCRIPTIONS')).toBe('subscriptions')
  })
})

describe('aggregateSpend', () => {
  it('sums unlisted categories into one other segment', () => {
    const { parts, total } = aggregateSpend([
      { category: 'food', amount: 100 },
      { category: 'coffee', amount: 12 },
      { category: 'vet', amount: 8 },
    ])
    expect(total).toBe(120)
    expect(parts.map((p) => p.slot)).toEqual(['food', 'other'])
    expect(parts.find((p) => p.slot === 'other')?.amount).toBe(20)
  })

  it('returns segments in slot order however the rows arrive', () => {
    // This is the whole point: the bar keeps its shape week to week.
    const rows = [
      { category: 'fun', amount: 11 },
      { category: 'housing', amount: 300 },
      { category: 'food', amount: 60 },
    ]
    expect(aggregateSpend(rows).parts.map((p) => p.slot)).toEqual(['housing', 'food', 'fun'])
    expect(aggregateSpend(rows.slice().reverse()).parts.map((p) => p.slot)).toEqual([
      'housing',
      'food',
      'fun',
    ])
  })

  it('gives a category the same colour whatever its size', () => {
    const big = aggregateSpend([{ category: 'fun', amount: 900 }, { category: 'food', amount: 3 }])
    const small = aggregateSpend([{ category: 'fun', amount: 3 }, { category: 'food', amount: 900 }])
    const funColor = (r: typeof big) => r.parts.find((p) => p.slot === 'fun')?.color
    expect(funColor(big)).toBe(SPEND_SLOT_COLORS.fun)
    expect(funColor(small)).toBe(SPEND_SLOT_COLORS.fun)
  })

  it('drops zero, negative, and unparseable amounts', () => {
    const { parts, total } = aggregateSpend([
      { category: 'food', amount: 0 },
      { category: 'fun', amount: -20 },
      { category: 'housing', amount: Number.NaN },
      { category: 'transport', amount: 40 },
    ])
    expect(total).toBe(40)
    expect(parts.map((p) => p.slot)).toEqual(['transport'])
  })

  it('survives an empty week', () => {
    expect(aggregateSpend([])).toEqual({ parts: [], total: 0 })
  })

  it('reports each share as a percentage of the total', () => {
    const { parts } = aggregateSpend([
      { category: 'food', amount: 75 },
      { category: 'fun', amount: 25 },
    ])
    expect(parts[0]!.share).toBeCloseTo(75, 6)
    expect(parts[1]!.share).toBeCloseTo(25, 6)
  })
})

describe('spendSegments', () => {
  const week = [
    { category: 'housing', amount: 200 },
    { category: 'food', amount: 100 },
    { category: 'fun', amount: 50 },
  ]

  it('scales to the budget when under it, leaving the rest as empty track', () => {
    const bar = spendSegments(week, 500)
    expect(bar.scale).toBe(500)
    expect(bar.total).toBe(350)
    expect(bar.over).toBe(false)
    expect(bar.capPct).toBeNull() // the track's right edge already means "cap"
    expect(bar.segments.map((s) => s.pct)).toEqual([40, 20, 10])
    expect(bar.remainingPct).toBeCloseTo(30, 6)
  })

  it('scales to the total when over, and puts the cap tick inside the bar', () => {
    const bar = spendSegments(week, 280)
    expect(bar.scale).toBe(350)
    expect(bar.over).toBe(true)
    expect(bar.capPct).toBeCloseTo(80, 6) // 280 of 350
    expect(bar.remainingPct).toBeCloseTo(0, 6)
  })

  it('spends exactly the budget without flipping to over', () => {
    const bar = spendSegments(week, 350)
    expect(bar.over).toBe(false)
    expect(bar.capPct).toBeNull()
    expect(bar.remainingPct).toBeCloseTo(0, 6)
  })

  it('reads as pure part-to-whole when no budget is set', () => {
    for (const budget of [0, -100, Number.NaN]) {
      const bar = spendSegments(week, budget)
      expect(bar.budget).toBe(0)
      expect(bar.scale).toBe(350)
      expect(bar.capPct).toBeNull()
      expect(bar.over).toBe(false)
      expect(bar.remainingPct).toBeCloseTo(0, 6)
    }
  })

  it('shows a full empty track when nothing is logged yet', () => {
    const bar = spendSegments([], 400)
    expect(bar.segments).toEqual([])
    expect(bar.remainingPct).toBe(100)
    expect(bar.over).toBe(false)
  })

  it('does not divide by zero with no spend and no budget', () => {
    const bar = spendSegments([], 0)
    expect(bar.scale).toBe(0)
    expect(bar.remainingPct).toBe(100)
    expect(bar.segments).toEqual([])
  })

  it('never sorts by amount', () => {
    const bar = spendSegments(
      [
        { category: 'fun', amount: 300 },
        { category: 'housing', amount: 5 },
      ],
      400,
    )
    expect(bar.segments.map((s) => s.slot)).toEqual(['housing', 'fun'])
  })
})

describe('spendSlices', () => {
  const circumference = (r: number) => 2 * Math.PI * r

  it('walks the offsets around the ring so slices sit end to end', () => {
    const { slices, radius } = spendSlices([
      { category: 'housing', amount: 50 },
      { category: 'food', amount: 25 },
      { category: 'fun', amount: 25 },
    ])
    const c = circumference(radius)
    expect(slices.map((s) => s.dashOffset)).toEqual([0, -c / 2, -(c * 0.75)])
  })

  it('cuts the gap out of each slice rather than stroking between them', () => {
    const { slices, circumference: c } = spendSlices(
      [
        { category: 'food', amount: 50 },
        { category: 'fun', amount: 50 },
      ],
      { gap: 2 },
    )
    const drawn = Number(slices[0]!.dashArray.split(' ')[0])
    expect(drawn).toBeCloseTo(c / 2 - 2, 6)
    // The rest of the circumference is the dash's gap, so nothing else paints.
    expect(Number(slices[0]!.dashArray.split(' ')[1])).toBeCloseTo(c - drawn, 6)
  })

  it('draws a single category as an unbroken ring', () => {
    const { slices, circumference: c } = spendSlices([{ category: 'food', amount: 80 }])
    expect(slices).toHaveLength(1)
    expect(Number(slices[0]!.dashArray.split(' ')[0])).toBeCloseTo(c, 6)
  })

  it('never emits a negative drawn length for a hairline slice', () => {
    const { slices } = spendSlices(
      [
        { category: 'housing', amount: 1000 },
        { category: 'fun', amount: 0.01 },
      ],
      { gap: 2 },
    )
    const drawn = Number(slices[1]!.dashArray.split(' ')[0])
    expect(drawn).toBe(0)
  })

  it('honours a custom radius', () => {
    const { radius, circumference: c } = spendSlices([{ category: 'food', amount: 10 }], {
      radius: 30,
    })
    expect(radius).toBe(30)
    expect(c).toBeCloseTo(circumference(30), 6)
  })

  it('returns nothing to draw for an empty week', () => {
    const { slices, total } = spendSlices([])
    expect(slices).toEqual([])
    expect(total).toBe(0)
  })
})
