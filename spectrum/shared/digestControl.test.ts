import { describe, expect, it } from 'bun:test'
import { clockFromText, digestControlIntent, digestManageReply, mentionsDigest } from './reminders'

/* Dimension 7 covered only a daily brief; the chat path refused "weekday".
 * These pin the deterministic parser that now backs the bench ask, plus the
 * pause/resume/edit paths the dimension scores ("easy to edit or pause"). */

describe('digest control intent', () => {
  it('parses the bench ask: weekday morning digest at 7am', () => {
    const got = digestControlIntent(
      'Set me up a weekday morning digest at 7am: my calendar for the day, emails I still owe a reply to, and the weather.',
    )
    expect(got).toEqual({ action: 'set', time: '07:00', recurrence: 'weekdays', label: 'Weekday morning digest' })
  })

  it('parses a plain daily digest with a time', () => {
    expect(digestControlIntent('send me a daily digest at 6:30 am')).toEqual({
      action: 'set',
      time: '06:30',
      recurrence: 'daily',
      label: 'Morning digest',
    })
  })

  it('treats monday-friday as weekdays', () => {
    const got = digestControlIntent('schedule my morning brief for Monday to Friday at 8')
    expect(got?.action).toBe('set')
    if (got?.action === 'set') expect(got.recurrence).toBe('weekdays')
  })

  it('pauses and resumes', () => {
    expect(digestControlIntent('Pause my weekday morning digest.')).toEqual({ action: 'pause' })
    expect(digestControlIntent('stop my daily digest')).toEqual({ action: 'pause' })
    expect(digestControlIntent('resume my morning digest')).toEqual({ action: 'resume' })
    expect(digestControlIntent('turn my digest back on')).toEqual({ action: 'resume' })
  })

  it('edits the time of an existing digest', () => {
    const got = digestControlIntent('change my morning digest to 8:15am')
    expect(got?.action).toBe('set')
    if (got?.action === 'set') expect(got.time).toBe('08:15')
  })

  it('never hijacks digest questions or other asks', () => {
    expect(digestControlIntent('when does my morning brief arrive?')).toBeNull()
    expect(digestControlIntent('what did my daily digest say')).toBeNull()
    expect(digestControlIntent('remind me to call mom tomorrow at 9am')).toBeNull()
    expect(digestControlIntent('set a reminder for the dentist')).toBeNull()
  })

  it('mentionsDigest is broader than the actionable parser', () => {
    expect(mentionsDigest('when does my morning brief arrive?')).toBe(true)
    expect(mentionsDigest('remind me to call mom')).toBe(false)
  })
})

describe('clock parsing', () => {
  it('accepts am/pm and 24h forms', () => {
    expect(clockFromText('at 7am')).toBe('07:00')
    expect(clockFromText('at 7:05 PM')).toBe('19:05')
    expect(clockFromText('by 12:00')).toBe('12:00')
    expect(clockFromText('in the morning')).toBeNull()
  })
})

describe('digest manage reply states the real state', () => {
  it('set names cadence, time and contents', () => {
    const reply = digestManageReply(
      { action: 'set', recurrence: 'weekdays', label: 'Weekday morning digest' },
      { ok: true, digest: [{ recurrence: 'weekdays', scheduledAt: '2026-09-18T14:00:00.000Z' }] },
      'America/Los_Angeles',
    )
    expect(reply).toContain('Weekdays')
    expect(reply).toContain('7:00 AM')
    expect(reply).toContain('weather')
  })

  it('pause with no digest does not claim a pause happened', () => {
    const reply = digestManageReply(
      { action: 'pause' },
      { ok: true, note: 'no digest scheduled', digest: [] },
      'America/Los_Angeles',
    )
    expect(reply).toContain("wasn't a digest")
  })
})
