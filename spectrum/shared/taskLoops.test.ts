import { describe, expect, it } from 'bun:test'
import {
  LOOP_HANDLERS,
  buildFlightCheckinTexts,
  buildRefundText,
  buildWakeupText,
  isKillSwitchArmed,
  runLoopTask,
  scanRefundCandidates,
  startTaskLoopPoller,
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
  it('kill switch check is a no-op without env', async () => {
    const saved = process.env.HIREALPHA_API_URL
    delete process.env.HIREALPHA_API_URL
    expect(await isKillSwitchArmed('+15551234567')).toBe(false)
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
