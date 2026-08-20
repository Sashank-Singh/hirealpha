import { describe, expect, it } from 'bun:test'
import { parseRelativeLocalTime } from './reminders'

describe('parseRelativeLocalTime deterministic fallback', () => {
  const now = '2026-08-19T10:00:00'

  it('parses minutes', () => {
    expect(parseRelativeLocalTime('remind me in 2 mins', 'America/New_York', now)).toBe(
      '2026-08-19T10:02:00',
    )
  })

  it('parses hours, including the full-word "hour"/"hours"', () => {
    expect(parseRelativeLocalTime('remind me in 2 hrs', 'America/New_York', now)).toBe(
      '2026-08-19T12:00:00',
    )
    expect(parseRelativeLocalTime('remind me in 2 hours', 'America/New_York', now)).toBe(
      '2026-08-19T12:00:00',
    )
    expect(parseRelativeLocalTime('remind me in 1 hour', 'America/New_York', now)).toBe(
      '2026-08-19T11:00:00',
    )
  })

  it('parses seconds and days', () => {
    expect(parseRelativeLocalTime('ping me in 30 secs', 'America/New_York', now)).toBe(
      '2026-08-19T10:00:30',
    )
    expect(parseRelativeLocalTime('remind me in 2 days', 'America/New_York', now)).toBe(
      '2026-08-21T10:00:00',
    )
  })

  it('returns null when there is no time hint', () => {
    expect(parseRelativeLocalTime('what is the weather?', 'America/New_York', now)).toBeNull()
  })
})