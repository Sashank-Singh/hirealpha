import { describe, expect, test } from 'bun:test'
import { cadenceLabel, isPersonMeetSuggestion } from './peopleMeets'

describe('isPersonMeetSuggestion', () => {
  test('drops Stay hotel cards', () => {
    expect(
      isPersonMeetSuggestion({
        who: 'Stay',
        title: 'Stay at Music City Hotel',
        time: 'All day',
        place: 'Music City Hotel - The San Francisco Music Experience',
      }),
    ).toBe(false)
    expect(
      isPersonMeetSuggestion({
        who: 'Stay',
        title: 'Stay',
        time: 'All day',
        place: 'Music City Hotel',
      }),
    ).toBe(false)
  })

  test('keeps Luigi and drops Stay', () => {
    expect(isPersonMeetSuggestion({ who: 'Stay', title: 'Stay', time: 'All day', place: 'Music City Hotel' })).toBe(false)
    expect(isPersonMeetSuggestion({ who: 'Luigi Ojeda', title: 'Luigi Ojeda', time: '11:30 AM' })).toBe(true)
  })
})

describe('cadenceLabel', () => {
  test('speaks the presets like a person would', () => {
    expect(cadenceLabel(7)).toBe('every week')
    expect(cadenceLabel(14)).toBe('every 2 weeks')
    expect(cadenceLabel(30)).toBe('every month')
    expect(cadenceLabel(60)).toBe('every 2 months')
    expect(cadenceLabel(180)).toBe('every 6 months')
    expect(cadenceLabel(365)).toBe('every year')
  })

  test('falls back to days for anything off the presets', () => {
    expect(cadenceLabel(23)).toBe('every 23 days')
    expect(cadenceLabel(90)).toBe('every 90 days')
  })
})
