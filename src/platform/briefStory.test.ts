import { describe, expect, test } from 'bun:test'
import { buildBriefLead, isNoiseReminder, mailGroupHeading, mailReasonLabels, pickBriefAction } from './briefStory'

describe('brief story', () => {
  test('leads with the next person, not an empty calendar', () => {
    const s = buildBriefLead({
      beats: [{ time: '11:30 AM', name: 'Luigi Ojeda', kind: 'Meeting' }],
      due: [],
      calendarConnected: true,
    })
    expect(s.lead).toBe('Luigi Ojeda at 11:30 AM')
    expect(s.sub).toBeUndefined()
  })

  test('does not say nothing on the calendar when the day is quiet', () => {
    const s = buildBriefLead({ beats: [], due: [], calendarConnected: true })
    expect(s.lead).toBe('A quiet day so far')
  })

  test('hides the daily brief reminder', () => {
    expect(isNoiseReminder('8:00 AM Daily brief')).toBe(true)
    expect(isNoiseReminder('Call Maya')).toBe(false)
  })

  test('next person is the action once sleep is in', () => {
    const a = pickBriefAction({
      hour: 8,
      lastNightLogged: true,
      next: { time: '11:30 AM', name: 'Luigi Ojeda', kind: 'Meeting' },
      due: [],
      asks: [],
    })
    expect(a.title).toContain('Luigi')
    expect(a.kind).toBe('prep')
    expect(a.hint).toBe('Show up ready.')
    expect(a.prepName).toBe('Luigi Ojeda')
  })

  test('mail headings use counts a person can scan', () => {
    expect(mailGroupHeading('reply', 3, 'To reply')).toBe('3 to reply')
    expect(mailGroupHeading('assessment', 1, 'Assessments')).toBe('1 assessment')
    expect(mailGroupHeading('thanks', 5, 'Thanks')).toBe('5 thanks')
  })

  test('reason chips read like a person talks', () => {
    expect(mailReasonLabels(['waiting_on_you', 'deadline'])).toEqual(['waiting on you', 'deadline'])
    expect(mailReasonLabels(['vip_sender', 'money'])).toEqual(['you usually reply', 'money'])
    expect(mailReasonLabels([])).toEqual([])
    expect(mailReasonLabels(['mystery_reason'])).toEqual([])
  })
})
