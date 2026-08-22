import { describe, expect, test } from 'bun:test'
import { isPersonMeetSuggestion } from './peopleMeets'

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
