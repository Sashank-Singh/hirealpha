import { describe, expect, it } from 'bun:test'
import {
  extractOtherPerson,
  eventStartsByEightPm,
  formatDigestEventLabel,
  formatUpcomingEvents,
  googleTokenHasScope,
  inferEventKind,
  isHotelStayEvent,
  isWalkIn,
  parseComposioCalendarData,
  parseFormattedEventLine,
  parseGoogleCalendarItems,
  parseGoogleEventStart,
  selectNextEvents,
} from './calendarEvents'

describe('calendar event parsing', () => {
  it('keeps timed events', () => {
    const got = parseGoogleEventStart({ dateTime: '2026-08-18T12:30:00-07:00' })
    expect(got?.allDay).toBe(false)
    expect(got?.rawStart).toBe('2026-08-18T12:30:00-07:00')
    expect(got?.start.toISOString()).toBe('2026-08-18T19:30:00.000Z')
  })

  it('prints Pacific clock not Zulu dinner time', () => {
    const items = parseGoogleCalendarItems([
      {
        summary: 'Sashank Singh and Amy Black, 12:30pm',
        start: { dateTime: '2026-08-18T12:30:00-07:00' },
        hangoutLink: 'https://meet.google.com/abc-defg-hij',
      },
      {
        summary: 'Sashank Singh and McKenley Land, 1:30pm, +1 216',
        start: { dateTime: '2026-08-18T13:30:00-07:00' },
        location: '+1 2165550100',
      },
    ])
    const block = formatUpcomingEvents(items, 'America/Los_Angeles')
    expect(block).toContain('12:30 PM')
    expect(block).toContain('1:30 PM')
    expect(block).not.toMatch(/7:30/)
    expect(block).not.toMatch(/8:30/)
    expect(block).toContain('Google Meet')
    expect(block).toContain('Phone call')
    expect(block).toContain('Do not call these dinner')
    const amy = block.split('\n').find((l) => l.includes('Amy Black'))
    expect(amy).toBeTruthy()
    const parsedAmy = parseFormattedEventLine(amy!)
    expect(parsedAmy?.clock).toBe('12:30 PM')
    expect(parsedAmy?.kind).toBe('Google Meet')
    expect(parsedAmy?.title).toContain('Amy Black')
  })

  it('keeps all-day events that only have start.date', () => {
    const items = parseGoogleCalendarItems([
      { summary: 'Sister lands', start: { date: '2026-08-18' } },
      { summary: 'Standup', start: { dateTime: '2026-08-18T10:00:00-07:00' } },
      { summary: 'Dropped', start: {} },
    ])
    expect(items.map((e) => e.title)).toEqual(['Sister lands', 'Standup'])
    expect(items[0]?.allDay).toBe(true)
    const block = formatUpcomingEvents(items, 'America/Los_Angeles')
    expect(block).toContain('All day')
    expect(block).toContain('Sister lands')
  })

  it('labels a Meet link as Google Meet, not dinner', () => {
    expect(
      inferEventKind({ hangoutLink: 'https://meet.google.com/aaa-bbbb-ccc', summary: 'Amy' }),
    ).toBe('Google Meet')
    expect(inferEventKind({ location: '+1 2165550100', summary: 'McKenley' })).toBe('Phone call')
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

describe('extractOtherPerson', () => {
  it('extracts the non-owner name from "X and Y" titles', () => {
    expect(extractOtherPerson('Sashank Singh and Amy Black', 'Sashank Singh')).toBe('Amy Black')
    expect(extractOtherPerson('Sashank Singh and McKenley Land', 'Sashank Singh')).toBe('McKenley Land')
  })

  it('handles reversed order', () => {
    expect(extractOtherPerson('Amy Black and Sashank Singh', 'Sashank Singh')).toBe('Amy Black')
  })

  it('strips trailing time and phone info', () => {
    expect(extractOtherPerson('Sashank Singh and Amy Black, 12:30pm', 'Sashank Singh')).toBe('Amy Black')
    expect(extractOtherPerson('Sashank Singh and McKenley Land, 1:30pm, +1 216', 'Sashank Singh')).toBe('McKenley Land')
  })

  it('strips trailing at-place from "and" pattern', () => {
    expect(extractOtherPerson('Sashank Singh and Amy Black at Coffee Bar', 'Sashank Singh')).toBe('Amy Black')
  })

  it('falls back to stripping meet/call prefix when no and-pattern', () => {
    expect(extractOtherPerson('Meeting with Amy Black', 'Sashank Singh')).toBe('Amy Black')
    expect(extractOtherPerson('Call with McKenley', null)).toBe('McKenley')
  })

  it('returns right side when no myName given', () => {
    expect(extractOtherPerson('Alice and Bob', null)).toBe('Bob')
  })
})

describe('isHotelStayEvent', () => {
  it('flags all-day hotel/stay events', () => {
    expect(isHotelStayEvent({ title: 'Stay at Music City Hotel', allDay: true })).toBe(true)
    expect(isHotelStayEvent({ title: 'Hotel check-in', allDay: true })).toBe(true)
    expect(isHotelStayEvent({ title: 'Flight to NYC', allDay: true })).toBe(true)
    expect(isHotelStayEvent({ title: 'OOO - vacation', allDay: true })).toBe(true)
  })

  it('does not flag timed events', () => {
    expect(isHotelStayEvent({ title: 'Stay at Music City Hotel', allDay: false })).toBe(false)
  })

  it('does not flag ordinary all-day events that are about people', () => {
    expect(isHotelStayEvent({ title: 'Sister lands', allDay: true })).toBe(false)
    expect(isHotelStayEvent({ title: 'Mithil birthday', allDay: true })).toBe(false)
  })
})

describe('next stack calendar picks', () => {
  it('keeps a meeting hours away, not only the next 45 minutes', () => {
    const now = Date.parse('2026-08-18T21:00:00-07:00')
    const events = [
      { id: '1', title: 'Amy', start: '2026-08-18T12:30:00-07:00', allDay: false },
      { id: '2', title: 'Standup tomorrow', start: '2026-08-19T09:30:00-07:00', allDay: false },
    ]
    expect(selectNextEvents(events, now).map((e) => e.title)).toEqual(['Standup tomorrow'])
    expect(isWalkIn('2026-08-18T21:20:00-07:00', now)).toBe(true)
    expect(isWalkIn('2026-08-19T09:30:00-07:00', now)).toBe(false)
  })

  it('does not require a 45 minute walk in to show the next event', () => {
    const now = Date.parse('2026-08-18T10:00:00-07:00')
    const events = [
      { id: '1', title: 'Amy', start: '2026-08-18T12:30:00-07:00', allDay: false },
      { id: '2', title: 'McKenley', start: '2026-08-18T13:30:00-07:00', allDay: false },
    ]
    expect(selectNextEvents(events, now).map((e) => e.title)).toEqual(['Amy', 'McKenley'])
  })
})

describe('formatDigestEventLabel', () => {
  it('shows the other person, not both names', () => {
    const items = parseGoogleCalendarItems([
      {
        summary: 'Sashank Singh and Amy Black, 12:30pm',
        start: { dateTime: '2026-08-18T12:30:00-07:00' },
        hangoutLink: 'https://meet.google.com/abc-defg-hij',
      },
    ])
    const label = formatDigestEventLabel(items[0]!, 'America/Los_Angeles', 'Sashank Singh')
    expect(label).toContain('Amy Black')
    expect(label).toContain('12:30 PM')
    expect(label).not.toContain('Sashank Singh and Amy Black')
  })
})

describe('eventStartsByEightPm', () => {
  it('keeps events through 8pm local and drops later', () => {
    const early = { start: new Date('2026-08-18T19:00:00-07:00'), allDay: false }
    const eight = { start: new Date('2026-08-18T20:00:00-07:00'), allDay: false }
    const late = { start: new Date('2026-08-18T21:00:00-07:00'), allDay: false }
    expect(eventStartsByEightPm(early, 'America/Los_Angeles')).toBe(true)
    expect(eventStartsByEightPm(eight, 'America/Los_Angeles')).toBe(true)
    expect(eventStartsByEightPm(late, 'America/Los_Angeles')).toBe(false)
    expect(eventStartsByEightPm({ start: new Date(), allDay: true }, 'America/Los_Angeles')).toBe(true)
  })
})
