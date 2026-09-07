import { describe, expect, it } from 'bun:test'
import {
  LOOP_HANDLERS,
  buildBillIncreaseText,
  buildFlightCheckinTexts,
  buildRefundText,
  buildTrialEndingText,
  buildWakeupText,
  flightCrossesTimezones,
  flightLandingRetimeNote,
  isKillSwitchArmed,
  runLoopTask,
  scanRefundCandidates,
  startTaskLoopPoller,
  trialEndWeekday,
  type LoopHandlerResult,
  type LoopTask,
} from './taskLoops'

const NOW = new Date('2026-08-20T12:00:00Z')
const BEFORE_WINDOW = new Date('2026-08-20T08:00:00Z')

function makeTask(over: Partial<LoopTask> = {}): LoopTask {
  return { id: 't1', phone: '+15551234567', kind: 'flight_checkin', ...over }
}

describe('flight check in texts', () => {
  it('announces before the window and snoozes to it', () => {
    const out = buildFlightCheckinTexts(
      { airline: 'United', flight: 'UA 220', date: '2026-08-21T18:00:00Z' },
      BEFORE_WINDOW,
    )
    expect(out.announce).toContain('Check in window')
    expect(out.announce).toContain('United UA 220')
    expect(out.checkin).toBeNull()
    expect(out.windowAt?.toISOString()).toBe('2026-08-20T18:00:00.000Z')
  })
  it('texts the confirmation link once the window is open', () => {
    const out = buildFlightCheckinTexts(
      {
        airline: 'United',
        flight: 'UA 220',
        date: '2026-08-20T18:00:00Z',
        confirmation_url: 'https://united.example/checkin',
      },
      NOW,
    )
    expect(out.announce).toBeNull()
    expect(out.checkin).toBe('Check in now: https://united.example/checkin')
  })
  it('honors an explicit checkin_at and handles missing payload', () => {
    const out = buildFlightCheckinTexts({ checkin_at: '2026-08-20T09:00:00Z' }, NOW)
    expect(out.checkin).not.toBeNull()
    expect(buildFlightCheckinTexts({}, NOW).windowAt).toBeNull()
  })
  it('handler announces then checks in', async () => {
    const soon = new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString()
    const past = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString()
    const early = await LOOP_HANDLERS.flight_checkin!(makeTask({
      payload: { airline: 'Delta', date: soon },
    }))
    expect(early.outcome).toBe('snoozed')
    expect(early.text).toContain("I'll ping you")
    const late = await LOOP_HANDLERS.flight_checkin!(makeTask({
      payload: { airline: 'Delta', date: past },
    }))
    expect(late.outcome).toBe('done')
    expect(late.text).toContain('Check in now')
  })
})

describe('flight landing re-time note', () => {
  it('mentions re-timing briefs to the destination zone on a cross-zone flight', () => {
    const out = buildFlightCheckinTexts(
      {
        airline: 'United',
        flight: 'UA 220',
        date: '2026-08-20T18:00:00Z',
        home_tz: 'America/Los_Angeles',
        destination: 'Tokyo',
        destination_tz: 'Asia/Tokyo',
      },
      NOW,
    )
    expect(out.checkin).toContain('Check in now')
    expect(out.checkin).toContain('After you land, I will move briefs and reminders to Tokyo time.')
    expect(flightCrossesTimezones(
      { home_tz: 'America/Los_Angeles', destination_tz: 'Asia/Tokyo' },
      NOW,
    )).toBe(true)
  })

  it('stays silent when destination matches home time', () => {
    const out = buildFlightCheckinTexts(
      {
        airline: 'United',
        date: '2026-08-20T18:00:00Z',
        home_tz: 'America/New_York',
        destination: 'New York',
        destination_tz: 'America/New_York',
      },
      NOW,
    )
    expect(out.checkin).toBe('Check in now on the United site, the window is open.')
    expect(flightLandingRetimeNote(
      { home_tz: 'America/New_York', destination_tz: 'America/New_York' },
      NOW,
    )).toBe('')
  })

  it('appends the retime note after a confirmation URL with a clean break', () => {
    const out = buildFlightCheckinTexts(
      {
        airline: 'United',
        date: '2026-08-20T18:00:00Z',
        confirmation_url: 'https://united.example/checkin',
        home_tz: 'America/Los_Angeles',
        destination: 'London',
        destination_tz: 'Europe/London',
      },
      NOW,
    )
    expect(out.checkin).toContain('Check in now: https://united.example/checkin')
    expect(out.checkin).toContain('. After you land, I will move briefs and reminders to London time.')
  })

  it('resolves a destination from a known city when only the city is supplied', () => {
    const note = flightLandingRetimeNote(
      { home_tz: 'America/Los_Angeles', destination: 'Tokyo' },
      NOW,
    )
    expect(note).toBe('After you land, I will move briefs and reminders to Tokyo time.')
  })

  it('no-ops when the zone cannot be resolved', () => {
    expect(flightLandingRetimeNote({ home_tz: 'America/Los_Angeles', destination: 'Mars' }, NOW)).toBe('')
    expect(buildFlightCheckinTexts({ airline: 'Delta', date: '2026-08-20T18:00:00Z' }, NOW).checkin).toBe(
      'Check in now on the Delta site, the window is open.',
    )
  })
})

describe('trial ending', () => {
  it('names the weekday and asks to keep or cancel, no dashes', () => {
    // 2026-08-21 is a Friday (UTC). America/Los_Angeles is 7h behind UTC.
    const payload = {
      trial_end: '2026-08-21T23:59:00.000Z',
      tier: 'Alpha',
      tz: 'America/Los_Angeles',
    }
    expect(trialEndWeekday(payload)).toBe('Friday')
    const text = buildTrialEndingText(payload)
    expect(text).toBe('Your Alpha trial ends Friday. Keep it or cancel?')
    expect(text).not.toMatch(/[-\u2013\u2014]/)
  })

  it('falls back to a friendly weekday without a tier or zone', () => {
    const text = buildTrialEndingText({ trial_end: '2026-08-22T00:00:00.000Z' })
    expect(text).toContain('Your trial ends')
    expect(buildTrialEndingText({})).toBe('')
  })

  it('handler sends once and marks done', async () => {
    const out = await LOOP_HANDLERS.trial_ending!(makeTask({
      kind: 'trial_ending',
      payload: { trial_end: '2026-08-21T12:00:00.000Z', tier: 'Alpha' },
    }))
    expect(out.outcome).toBe('done')
    expect(out.text).toContain('trial ends')
    const missing = await LOOP_HANDLERS.trial_ending!(makeTask({ kind: 'trial_ending', payload: {} }))
    expect(missing.outcome).toBe('failed')
  })
})

describe('bill increase', () => {
  it('builds the negotiation text for a single real increase', () => {
    const text = buildBillIncreaseText([{ merchant: 'your internet bill', from: 60, to: 68, period: 'month' }])
    expect(text).toBe('your internet bill went up from $60 to $68. Want me to draft the negotiation?')
    expect(text).not.toMatch(/[-\u2013\u2014]/)
  })

  it('counts several bills and skips empty input', () => {
    const text = buildBillIncreaseText([
      { merchant: 'Netflix', to: 18 },
      { merchant: 'Verizon', to: 82 },
    ])
    expect(text).toContain('2 recurring bills went up')
    expect(buildBillIncreaseText([])).toBe('')
  })

  it('handler no-ops with a console note when no price-change data source is wired', async () => {
    const out = (await LOOP_HANDLERS.bill_increase!(makeTask({
      kind: 'bill_increase',
      payload: {},
    }))) as LoopHandlerResult
    expect(out.text).toBeUndefined()
    expect(out.outcome).toBe('done')
    expect(out.note).toContain('not wired')
  })

  it('handler sends when a wired source supplies increases', async () => {
    const out = await LOOP_HANDLERS.bill_increase!(makeTask({
      kind: 'bill_increase',
      payload: { increases: [{ merchant: 'Comcast', from: 70, to: 78 }] },
    }))
    expect(out.outcome).toBe('done')
    expect(out.text).toContain('Comcast went up')
  })
})

describe('refund hunter scan', () => {
  const rows = [
    { subject: 'Your refund request', snippet: 'We got your request', thread: 'a' },
    { subject: 'Refund processed', snippet: 'Your refund is on the way', thread: 'a' },
    { subject: 'Statement credit posted', snippet: 'You earned a credit', thread: 'b' },
    { subject: 'Weekly newsletter', snippet: 'Top stories', thread: 'c' },
    { subject: 'Rebate approved', snippet: 'Mail your rebate form', thread: 'd' },
  ]
  it('keeps refund flavored rows without a processed notice', () => {
    const out = scanRefundCandidates(rows)
    const subjects = out.map((r) => r.subject)
    expect(subjects).toContain('Statement credit posted')
    expect(subjects).toContain('Rebate approved')
    expect(subjects).not.toContain('Your refund request')
    expect(subjects).not.toContain('Refund processed')
    expect(subjects).not.toContain('Weekly newsletter')
  })
  it('builds a chase text without dashes', () => {
    const text = buildRefundText([{ subject: 'Rebate approved' }])
    expect(text).toContain('Rebate approved')
    expect(text).not.toMatch(/[-\u2013\u2014]/)
    expect(buildRefundText([])).toBe('')
  })
  it('handler reports no candidates when mail is empty', async () => {
    const saved = process.env.HIREALPHA_API_URL
    delete process.env.HIREALPHA_API_URL
    const out = (await LOOP_HANDLERS.refund_hunter!(makeTask({
      kind: 'refund_hunter',
    }))) as LoopHandlerResult
    expect(out.outcome).toBe('done')
    if (saved) process.env.HIREALPHA_API_URL = saved
  })
})

describe('wake up text', () => {
  it('uses the day top items when given', () => {
    const text = buildWakeupText(['email Sara', 'draft pricing'])
    expect(text).toContain('email Sara')
    expect(text).toContain('draft pricing')
  })
  it('falls back to three plain sentences', () => {
    const text = buildWakeupText()
    const sentences = text.split('.').filter((s) => s.trim())
    expect(sentences.length).toBe(3)
    expect(text).not.toMatch(/[-\u2013\u2014]/)
  })
  it('wakeup handler sends and finishes', async () => {
    const out = await LOOP_HANDLERS.wakeup!(makeTask({ kind: 'wakeup', payload: {} }))
    expect(out.outcome).toBe('done')
    expect(out.text).toContain('Morning')
  })
})

describe('loop runner', () => {
  it('sends the handler text and posts done', async () => {
    const sent: string[] = []
    const posted: Array<{ outcome: string }> = []
    await runLoopTask(
      makeTask({ kind: 'wakeup' }),
      () => ({ text: 'Morning.', outcome: 'done' }),
      {
        persona: 'friend',
        send: async (phone, text) => {
          sent.push(`${phone}:${text}`)
        },
        checkKillSwitch: async () => false,
        postResult: async (_id, r) => {
          posted.push({ outcome: r.outcome })
        },
      },
    )
    expect(sent).toEqual(['+15551234567:Morning.'])
    expect(posted).toEqual([{ outcome: 'done' }])
  })
  it('skips the send and snoozes when the kill switch is armed', async () => {
    const sent: string[] = []
    const posted: Array<{ outcome: string; note?: string }> = []
    await runLoopTask(makeTask(), () => ({ text: 'Morning.', outcome: 'done' }), {
      persona: 'friend',
      send: async (_phone, text) => {
        sent.push(text)
      },
      checkKillSwitch: async () => true,
      postResult: async (_id, r) => {
        posted.push({ outcome: r.outcome, note: r.note })
      },
    })
    expect(sent).toEqual([])
    expect(posted).toEqual([{ outcome: 'snoozed', note: 'kill switch armed' }])
  })
  it('gated actions ask for approval instead of executing', async () => {
    const sent: string[] = []
    const posted: Array<{ outcome: string; note?: string }> = []
    let handlerRan = false
    await runLoopTask(
      makeTask({ payload: { action: 'purchase', detail: 'the yearly plan' } }),
      () => {
        handlerRan = true
        return { text: 'bought', outcome: 'done' }
      },
      {
        persona: 'friend',
        send: async (_phone, text) => {
          sent.push(text)
        },
        checkKillSwitch: async () => false,
        postResult: async (_id, r) => {
          posted.push({ outcome: r.outcome, note: r.note })
        },
      },
    )
    expect(handlerRan).toBe(false)
    expect(sent[0]).toContain('make that purchase')
    expect(sent[0]).toContain('the yearly plan')
    expect(posted).toEqual([{ outcome: 'done', note: 'approval requested' }])
  })
  it('posts failed when the handler throws', async () => {
    const posted: Array<{ outcome: string }> = []
    await runLoopTask(
      makeTask(),
      () => {
        throw new Error('boom')
      },
      {
        persona: 'friend',
        send: async () => undefined,
        checkKillSwitch: async () => false,
        postResult: async (_id, r) => {
          posted.push({ outcome: r.outcome })
        },
      },
    )
    expect(posted).toEqual([{ outcome: 'failed' }])
  })
})

describe('poller and kill switch defaults', () => {
  it('kill switch blocks proactive sends without env', async () => {
    const saved = process.env.HIREALPHA_API_URL
    delete process.env.HIREALPHA_API_URL
    expect(await isKillSwitchArmed('+15551234567')).toBe(true)
    if (saved) process.env.HIREALPHA_API_URL = saved
  })
  it('poller stays off without env and does not throw', () => {
    const saved = process.env.HIREALPHA_API_URL
    delete process.env.HIREALPHA_API_URL
    expect(() =>
      startTaskLoopPoller({ persona: 'friend', send: async () => undefined }),
    ).not.toThrow()
    if (saved) process.env.HIREALPHA_API_URL = saved
  })
})
