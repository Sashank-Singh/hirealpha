import { describe, expect, it } from 'bun:test'
import {
  formatUpcomingEvents,
  googleTokenHasScope,
  parseComposioCalendarData,
  parseGoogleCalendarItems,
  parseGoogleEventStart,
} from './calendarEvents'

describe('calendar event parsing', () => {
  it('keeps timed events', () => {
    const got = parseGoogleEventStart({ dateTime: '2026-08-18T19:00:00-07:00' })
    expect(got?.allDay).toBe(false)
    expect(got?.start.toISOString()).toBe('2026-08-19T02:00:00.000Z')
  })

  it('keeps all-day events that only have start.date', () => {
    const items = parseGoogleCalendarItems([
      { summary: 'Sister lands', start: { date: '2026-08-18' } },
      { summary: 'Standup', start: { dateTime: '2026-08-18T10:00:00-07:00' } },
      { summary: 'Dropped', start: {} },
    ])
    expect(items.map((e) => e.title)).toEqual(['Sister lands', 'Standup'])
    expect(items[0]?.allDay).toBe(true)
    const block = formatUpcomingEvents(items)
    expect(block).toContain('Upcoming events:')
    expect(block).toContain('2026-08-18 Sister lands')
    expect(block).toContain('Standup')
  })

  it('reads Composio nested items including all-day', () => {
    const items = parseComposioCalendarData({
      data: {
        items: [
          { summary: 'Mithil at Jai ho', start: { dateTime: '2026-08-18T19:00:00-07:00' } },
          { title: 'OOO', start: { date: '2026-08-19' } },
        ],
      },
    })
    expect(items.map((e) => e.title)).toEqual(['Mithil at Jai ho', 'OOO'])
  })

  it('does not treat a Google login token as a calendar token', () => {
    expect(googleTokenHasScope('openid email profile', 'calendar')).toBe(false)
    expect(googleTokenHasScope('https://www.googleapis.com/auth/calendar.events', 'calendar')).toBe(true)
  })
})
