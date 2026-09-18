import { describe, expect, it } from 'bun:test'
import { partOfDayWindow, suggestSlotRanges, suggestSlotsFromBusy, googleScopesFor } from './hire-api'

/* Free calendar time the chat engine can actually book: the same walk the
 * pick-slot card uses, now with ISO ranges and a single-day window so
 * "a 30-minute block on Thursday afternoon" is verified against the real
 * calendar instead of guessed. */

const at = (iso: string) => Date.parse(iso)

describe('suggestSlotRanges', () => {
  it('returns ISO ranges alongside the labels', () => {
    const ranges = suggestSlotRanges([], { now: at('2026-08-31T09:30:00Z'), timezone: 'UTC', windowDays: 1, limit: 2 })
    expect(ranges).toHaveLength(2)
    expect(ranges[0]).toEqual({ start: '2026-08-31T09:30:00.000Z', end: '2026-08-31T10:00:00.000Z', label: 'Mon 09:30' })
  })

  it('never lands a range on a busy block', () => {
    const busy = [{ start: at('2026-08-31T09:00:00Z'), end: at('2026-08-31T12:00:00Z') }]
    const ranges = suggestSlotRanges(busy, { now: at('2026-08-31T09:00:00Z'), timezone: 'UTC', windowDays: 1, durationMin: 30, limit: 3 })
    expect(ranges.map((r) => r.label)).toEqual(['Mon 12:00', 'Mon 12:30', 'Mon 13:00'])
  })

  it('scopes to one local day and one part of the day', () => {
    const afternoon = partOfDayWindow('afternoon')
    expect(afternoon).toEqual({ start: 12, end: 18 })
    expect(partOfDayWindow('evening')).toEqual({ start: 17, end: 21 })
    expect(partOfDayWindow('whenever')).toBeNull()
    // Thursday 2026-09-17, 14:00 UTC = 07:00 in Los Angeles; the window is that
    // local Thursday afternoon only.
    const ranges = suggestSlotRanges([], {
      now: at('2026-09-17T14:00:00Z'),
      timezone: 'America/Los_Angeles',
      day: '2026-09-17',
      durationMin: 30,
      limit: 2,
      workStartHour: afternoon!.start,
      workEndHour: afternoon!.end,
    })
    expect(ranges.map((r) => r.label)).toEqual(['Thu 12:00', 'Thu 12:30'])
    expect(ranges.every((r) => r.start.startsWith('2026-09-17T'))).toBe(true)
  })

  it('keeps the label-only view identical to the ranges', () => {
    const busy = [{ start: at('2026-08-31T10:00:00Z'), end: at('2026-08-31T11:00:00Z') }]
    const opts = { now: at('2026-08-31T09:30:00Z'), timezone: 'UTC', windowDays: 2 }
    expect(suggestSlotsFromBusy(busy, opts)).toEqual(suggestSlotRanges(busy, opts).map((r) => r.label))
  })
})

describe('google connect scopes (dim 9)', () => {
  it('requests read-write only when the user did not ask for read-only', () => {
    const write = googleScopesFor(null)
    expect(write).toContain('https://www.googleapis.com/auth/gmail.send')
    expect(write).toContain('https://www.googleapis.com/auth/calendar.events')
  })

  it('drops every write scope for a read-only grant', () => {
    for (const flag of ['1', 'true', 'readonly', true]) {
      const read = googleScopesFor(flag)
      expect(read).toContain('https://www.googleapis.com/auth/gmail.readonly')
      expect(read).toContain('https://www.googleapis.com/auth/calendar.readonly')
      expect(read).toContain('https://www.googleapis.com/auth/drive.readonly')
      expect(read).not.toContain('gmail.send')
      expect(read).not.toContain('gmail.compose')
      expect(read).not.toContain('calendar.events')
    }
  })
})
