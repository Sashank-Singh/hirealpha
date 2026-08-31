import { describe, expect, it } from 'bun:test'
import { todayWindowUtc, weekWindowUtc } from './hire-api'

/* A meal logged at 11:22 PM Saturday in LA lands at 06:22 UTC Sunday. The old
 * queries compared TIMESTAMPTZ columns to a bare `::date`, which Postgres reads
 * at midnight in its own session timezone (UTC in prod): the window closed at
 * 5 PM Pacific, so the meal never reached Home. These tests pin the instant
 * windows that replaced it. */
describe('local-day windows', () => {
  it('keeps a late LA dinner inside the day window', () => {
    const dinner = new Date('2026-08-23T06:22:00.000Z') // 11:22 PM PDT Sat Aug 22
    const w = todayWindowUtc('America/Los_Angeles', dinner)
    expect(w.start.toISOString()).toBe('2026-08-22T07:00:00.000Z')
    expect(w.end.toISOString()).toBe('2026-08-23T07:00:00.000Z')
    expect(dinner.getTime()).toBeGreaterThanOrEqual(w.start.getTime())
    expect(dinner.getTime()).toBeLessThan(w.end.getTime())

    // What the old `::date` comparison did: midnight in the session timezone.
    const utcMidnightEnd = new Date('2026-08-23T00:00:00.000Z')
    expect(dinner.getTime() >= utcMidnightEnd.getTime()).toBe(true)
  })

  it('shifts the window by DST, not by a fixed offset', () => {
    expect(todayWindowUtc('America/Los_Angeles', new Date('2026-12-07T20:00:00.000Z')).start.toISOString()).toBe(
      '2026-12-07T08:00:00.000Z',
    )
    expect(todayWindowUtc('Europe/London', new Date('2026-08-17T08:00:00.000Z')).start.toISOString()).toBe(
      '2026-08-16T23:00:00.000Z',
    )
  })
})

describe('local-week windows', () => {
  it('opens a Pacific Monday at 07:00 UTC in summer (PDT)', () => {
    const w = weekWindowUtc('2026-08-17', 'America/Los_Angeles')
    expect(w.start.toISOString()).toBe('2026-08-17T07:00:00.000Z')
    expect(w.end.toISOString()).toBe('2026-08-24T07:00:00.000Z')
  })

  it('opens a Pacific Monday at 08:00 UTC in winter (PST)', () => {
    const w = weekWindowUtc('2026-12-07', 'America/Los_Angeles')
    expect(w.start.toISOString()).toBe('2026-12-07T08:00:00.000Z')
    expect(w.end.toISOString()).toBe('2026-12-14T08:00:00.000Z')
  })

  it('is exact for UTC', () => {
    const w = weekWindowUtc('2026-08-17', 'UTC')
    expect(w.start.toISOString()).toBe('2026-08-17T00:00:00.000Z')
    expect(w.end.toISOString()).toBe('2026-08-24T00:00:00.000Z')
  })

  it('keeps a Sunday-night log in the right week', () => {
    const sundayDinner = new Date('2026-08-24T02:00:00.000Z') // 7 PM PDT Sun Aug 23
    const w = weekWindowUtc('2026-08-17', 'America/Los_Angeles')
    expect(sundayDinner.getTime()).toBeGreaterThanOrEqual(w.start.getTime())
    expect(sundayDinner.getTime()).toBeLessThan(w.end.getTime())
  })
})
