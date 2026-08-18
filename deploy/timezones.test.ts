import { describe, expect, it } from 'bun:test'
import {
  formatZoneAbbrev,
  pickUserTimezone,
  resolveIanaTimezone,
  timezoneFromCoords,
  timezoneFromText,
} from './timezones'
import { formatUpcomingEvents, parseGoogleCalendarItems } from './calendarEvents'

const amy = parseGoogleCalendarItems([
  {
    summary: 'Sashank Singh and Amy Black, 12:30pm',
    start: { dateTime: '2026-08-18T12:30:00-07:00' },
    hangoutLink: 'https://meet.google.com/abc-defg-hij',
  },
])

describe('user timezone', () => {
  it('maps EST BST UTC PST onto IANA zones', () => {
    expect(resolveIanaTimezone('EST')).toBe('America/New_York')
    expect(resolveIanaTimezone('PST')).toBe('America/Los_Angeles')
    expect(resolveIanaTimezone('BST')).toBe('Europe/London')
    expect(resolveIanaTimezone('UTC')).toBe('UTC')
    expect(resolveIanaTimezone('America/New_York')).toBe('America/New_York')
  })

  it('hears I am in EST or London', () => {
    expect(timezoneFromText("I'm in EST")).toBe('America/New_York')
    expect(timezoneFromText('timezone is BST')).toBe('Europe/London')
    expect(timezoneFromText("I'm in UTC")).toBe('UTC')
    expect(timezoneFromText("I'm in PST now")).toBe('America/Los_Angeles')
    expect(timezoneFromText("I'm in London")).toBe('Europe/London')
    expect(timezoneFromText('Check calendar again')).toBe(null)
  })

  it('infers EST BST PST from coords', () => {
    expect(timezoneFromCoords(41.5, -81.7)).toBe('America/New_York')
    expect(timezoneFromCoords(51.5, -0.12)).toBe('Europe/London')
    expect(timezoneFromCoords(37.77, -122.42)).toBe('America/Los_Angeles')
  })

  it('lets a spoken zone beat a Pacific default', () => {
    expect(
      pickUserTimezone({ message: "I'm in EST", userTz: 'America/Los_Angeles' }),
    ).toBe('America/New_York')
    expect(pickUserTimezone({ userTz: 'UTC' })).toBe('UTC')
    expect(
      pickUserTimezone({
        userTz: 'America/Los_Angeles',
        latitude: 51.5,
        longitude: -0.12,
        locationFresh: true,
      }),
    ).toBe('Europe/London')
  })

  it('prints Amy 12:30 PDT as 3:30 EDT, 8:30 BST, 7:30 UTC, 12:30 PDT', () => {
    const pst = formatUpcomingEvents(amy, 'America/Los_Angeles')
    expect(pst).toContain('12:30 PM')
    expect(pst).toMatch(/PDT|GMT-7/)
    expect(pst).not.toMatch(/7:30/)

    const est = formatUpcomingEvents(amy, 'America/New_York')
    expect(est).toContain('3:30 PM')
    expect(est).toMatch(/EDT|EST|GMT-4/)

    const bst = formatUpcomingEvents(amy, 'Europe/London')
    expect(bst).toContain('8:30 PM')
    expect(bst).toMatch(/BST|GMT\+1/)

    const utc = formatUpcomingEvents(amy, 'UTC')
    expect(utc).toContain('7:30 PM')
    expect(utc).toContain('UTC')
    expect(formatZoneAbbrev(amy[0]!.start, 'UTC')).toBe('UTC')
  })
})
