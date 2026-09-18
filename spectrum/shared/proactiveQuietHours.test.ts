import { describe, expect, it } from 'bun:test'
import {
  hardGuard,
  inQuietHours,
  localMinutesOfDay,
  quietHoursEndMinutes,
  type JudgmentState,
} from './judgment'
import { runLoopTask, taskObeysQuietHours, type LoopTask } from './taskLoops'

/* Quiet hours were stored in the judgment state and returned to the bot, but
 * nothing ever read them: a 3 AM poke or meal nudge could fire at 3 AM, and a
 * loop text (inbox ping, birthday, check-in) ignored the window entirely.
 * Dimension 15 scores exactly this ("does not wake or spam the user"). */

function state(over: Partial<JudgmentState> = {}): JudgmentState {
  return {
    persona: 'friend',
    localTime: '2026-09-17T12:00:00',
    weekday: 'Thursday',
    timezone: 'America/Los_Angeles',
    tick: 'judge',
    proactive: 'on',
    quietHours: '22:00-08:00',
    lastInboundMinutesAgo: 600,
    lastProactiveMinutesAgo: 600,
    lastProactiveTopic: null,
    unansweredProactive: 0,
    unansweredToday: 0,
    ...over,
  }
}

describe('inQuietHours', () => {
  it('holds the overnight window, cross-midnight included', () => {
    expect(inQuietHours('2026-09-17T23:30:00', '22:00-08:00')).toBe(true)
    expect(inQuietHours('2026-09-18T02:00:00', '22:00-08:00')).toBe(true)
    expect(inQuietHours('2026-09-18T07:59:00', '22:00-08:00')).toBe(true)
  })

  it('releases at the boundary and through the day', () => {
    expect(inQuietHours('2026-09-18T08:00:00', '22:00-08:00')).toBe(false)
    expect(inQuietHours('2026-09-17T12:00:00', '22:00-08:00')).toBe(false)
  })

  it('handles a same-day window and a junk window', () => {
    expect(inQuietHours('2026-09-17T13:00:00', '12:00-14:00')).toBe(true)
    expect(inQuietHours('2026-09-17T15:00:00', '12:00-14:00')).toBe(false)
    expect(inQuietHours('2026-09-17T23:00:00', 'not a window')).toBe(false)
  })

  it('falls back to the product default when the field is absent', () => {
    expect(inQuietHours('2026-09-17T23:00:00', null)).toBe(true)
  })

  it('never mutes on an unreadable clock', () => {
    expect(inQuietHours(null, '22:00-08:00')).toBe(false)
    expect(localMinutesOfDay('nonsense')).toBeNull()
    expect(quietHoursEndMinutes('22:00-08:00')).toBe(8 * 60)
  })
})

describe('hardGuard respects quiet hours and the unanswered cap', () => {
  it('holds a discretionary poke overnight', () => {
    expect(hardGuard(state({ localTime: '2026-09-17T23:10:00' }))).toBe('quiet hours')
  })

  it('still pokes midday when nothing else blocks', () => {
    expect(hardGuard(state())).toBeNull()
  })

  it('keeps the shared send-budget caps intact', () => {
    expect(hardGuard(state({ unansweredProactive: 2 }))).toBe('awaiting reply')
    expect(hardGuard(state({ unansweredToday: 2 }))).toBe('already pinged today')
    expect(hardGuard(state({ proactive: 'off' }))).toBe('proactive off')
  })
})

describe('loop sends respect quiet hours', () => {
  it('exempts replies the user is waiting on and imminent flights', () => {
    expect(taskObeysQuietHours({ id: '1', phone: '+1', kind: 'browser_result' })).toBe(false)
    expect(taskObeysQuietHours({ id: '1', phone: '+1', kind: 'save_contact' })).toBe(false)
    const soon = new Date(Date.now() + 2 * 3_600_000).toISOString()
    expect(taskObeysQuietHours({ id: '1', phone: '+1', kind: 'flight_checkin', payload: { date: soon } })).toBe(false)
    const later = new Date(Date.now() + 30 * 3_600_000).toISOString()
    expect(taskObeysQuietHours({ id: '1', phone: '+1', kind: 'flight_checkin', payload: { date: later } })).toBe(true)
    expect(taskObeysQuietHours({ id: '1', phone: '+1', kind: 'birthday_reminder' })).toBe(true)
  })

  it('snoozes instead of sending, and re-runs after the hold', async () => {
    const sent: string[] = []
    const results: Array<{ outcome: string; note?: string; next_run?: string }> = []
    const task: LoopTask = { id: 'q1', phone: '+15551234567', kind: 'wakeup' }
    await runLoopTask(task, () => ({ text: 'Morning.', outcome: 'done' }), {
      persona: 'friend',
      send: async (phone, text) => {
        sent.push(`${phone}:${text}`)
      },
      checkKillSwitch: async () => false,
      checkQuietHours: async () => true,
      postResult: async (_id, r) => {
        results.push(r)
      },
    })
    expect(sent).toEqual([])
    expect(results[0]?.outcome).toBe('snoozed')
    expect(results[0]?.note).toBe('quiet hours')
    expect(new Date(results[0]!.next_run!).getTime()).toBeGreaterThan(Date.now() + 60 * 60_000)
  })

  it('sends normally outside quiet hours', async () => {
    const sent: string[] = []
    await runLoopTask(
      { id: 'q2', phone: '+15551234567', kind: 'wakeup' },
      () => ({ text: 'Morning.', outcome: 'done' }),
      {
        persona: 'friend',
        send: async (phone, text) => {
          sent.push(`${phone}:${text}`)
        },
        checkKillSwitch: async () => false,
        checkQuietHours: async () => false,
        postResult: async () => undefined,
      },
    )
    expect(sent).toEqual(['+15551234567:Morning.'])
  })
})
