import { describe, expect, it } from 'bun:test'
import {
  intersectGuestAvailability,
  describeMutualAvailability,
  findOverlaps,
  tightTurnarounds,
  describeDayConflicts,
  type GuestAvailability,
} from './calendarConflicts'

const slots = [
  { start: '2026-10-01T16:00:00.000Z', end: '2026-10-01T16:30:00.000Z', label: 'Thu 09:00' },
  { start: '2026-10-01T22:30:00.000Z', end: '2026-10-01T23:00:00.000Z', label: 'Thu 15:30' },
]

describe('intersectGuestAvailability', () => {
  it('removes slots a readable guest is busy for', () => {
    const guests: GuestAvailability[] = [
      { email: 'sarah@x.com', state: 'read', busy: [{ start: Date.parse(slots[0]!.start), end: Date.parse(slots[0]!.end) }] },
    ]
    const out = intersectGuestAvailability(slots, guests)
    expect(out.slots.map((s) => s.label)).toEqual(['Thu 15:30'])
    expect(out.readableGuests).toEqual(['sarah@x.com'])
    expect(out.unknownGuests).toEqual([])
  })

  it('keeps unknown guests OUT of the mutual claim', () => {
    const guests: GuestAvailability[] = [
      { email: 'sarah@x.com', state: 'unknown' },
    ]
    const out = intersectGuestAvailability(slots, guests)
    expect(out.slots).toHaveLength(2)
    expect(out.unknownGuests).toEqual(['sarah@x.com'])
  })
})

describe('describeMutualAvailability — the honesty contract', () => {
  it('says plainly which calendar it can and cannot see', () => {
    const text = describeMutualAvailability({
      slots,
      readableGuests: [],
      unknownGuests: ['sarah@x.com'],
      askedGuests: true,
    })
    expect(text).toContain("I can see your calendar, not sarah@x.com's")
    expect(text).toContain('unknown here')
    expect(text).not.toMatch(/mutually free|both free/i)
  })

  it('names mutual slots when the guest calendar was readable', () => {
    const text = describeMutualAvailability({
      slots: [slots[1]!],
      readableGuests: ['sarah@x.com'],
      unknownGuests: [],
      askedGuests: true,
    })
    expect(text).toContain('Free for you AND sarah@x.com')
    expect(text).toContain('Thu 15:30')
  })

  it('labels user-only reads as user-only', () => {
    const text = describeMutualAvailability({ slots, readableGuests: [], unknownGuests: [], askedGuests: false })
    expect(text).toContain('YOUR calendar')
  })

  it('admits a full window instead of inventing a slot', () => {
    const text = describeMutualAvailability({ slots: [], readableGuests: [], unknownGuests: [], askedGuests: false })
    expect(text).toContain('no free slot')
  })
})

describe('day conflicts', () => {
  const events = [
    { title: 'Standup', start: Date.parse('2026-10-01T16:00:00Z'), end: Date.parse('2026-10-01T16:30:00Z') },
    { title: 'Dentist', start: Date.parse('2026-10-01T16:15:00Z'), end: Date.parse('2026-10-01T17:00:00Z') },
    { title: '1:1', start: Date.parse('2026-10-01T18:00:00Z'), end: Date.parse('2026-10-01T18:30:00Z') },
  ]

  it('finds the overlap', () => {
    const overlaps = findOverlaps(events)
    expect(overlaps).toHaveLength(1)
    expect(overlaps[0]![0].title).toBe('Standup')
    expect(overlaps[0]![1].title).toBe('Dentist')
  })

  it('names both events in the conflict text', () => {
    const text = describeDayConflicts({ timezone: 'UTC', events })
    expect(text).toContain('"Standup"')
    expect(text).toContain('"Dentist"')
    expect(text).toContain('overlap')
  })

  it('reports a clean day honestly', () => {
    const clean = [{ title: 'A', start: Date.parse('2026-10-01T16:00:00Z'), end: Date.parse('2026-10-01T16:30:00Z') }]
    expect(describeDayConflicts({ timezone: 'UTC', events: clean })).toContain('No conflicts')
  })

  it('flags zero-gap turnarounds', () => {
    const back = [
      { title: 'A', start: Date.parse('2026-10-01T16:00:00Z'), end: Date.parse('2026-10-01T17:00:00Z') },
      { title: 'B', start: Date.parse('2026-10-01T17:00:00Z'), end: Date.parse('2026-10-01T18:00:00Z') },
    ]
    const tight = tightTurnarounds(back, 10 * 60_000)
    expect(tight).toHaveLength(1)
    expect(tight[0]!.gapMin).toBe(0)
    expect(describeDayConflicts({ timezone: 'UTC', events: back })).toContain('no gap')
  })
})
