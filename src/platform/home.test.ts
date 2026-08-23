import { describe, expect, test } from 'bun:test'
import { homeFetchPlan, mergeMeets, pickHomeQueue, pickLastNight, remainingMeets, type HomeSlice } from './home'

const base: HomeSlice = {
  hour: 7,
  lastNightLogged: true,
  lastNightHours: 7.8,
  peopleDue: [],
  proteinToday: 0,
  proteinGoal: 150,
  spend: 383,
  weeklyBudget: 459,
  workoutToday: { name: 'Friday Pull', rest: false, done: false },
}

/** The ladder's order is what used to decide the single card, so the lead rung is
 * still the assertion that matters for ranking. */
const lead = (s: HomeSlice) => pickHomeQueue(s)[0]!

describe('pickHomeQueue ranking', () => {
  test('asks for last night before food in the morning', () => {
    const a = lead({ ...base, lastNightLogged: false, proteinToday: 0 })
    expect(a.openKind).toBe('sleep_tracker')
    expect(a.title).toBe('Log last night')
  })

  test('does not promote protein at 7am when sleep is in', () => {
    expect(lead({ ...base, hour: 7, proteinToday: 0 }).openKind).not.toBe('nutrition')
  })

  test('next meet beats people and food', () => {
    const a = lead({
      ...base,
      next: { time: '9:00 AM', title: 'Amy' },
      peopleDue: [{ name: 'Maya', days: 16 }],
    })
    expect(a.openKind).toBe('digest')
    expect(a.title).toContain('Amy')
  })

  test('people due when the morning is otherwise clear', () => {
    const a = lead({
      ...base,
      workoutToday: { name: 'Friday rest', rest: true, done: false },
      peopleDue: [{ name: 'Maya', days: 16, id: 'p1' }],
    })
    expect(a.title).toBe('Ping Maya')
  })

  test('protein can win after 11am', () => {
    expect(
      lead({
        ...base,
        hour: 13,
        proteinToday: 0,
        workoutToday: { name: 'Friday rest', rest: true, done: false },
      }).openKind,
    ).toBe('nutrition')
  })

  test('evening over cap beats leftover protein', () => {
    expect(
      lead({
        ...base,
        hour: 19,
        proteinToday: 40,
        spend: 500,
        weeklyBudget: 400,
        workoutToday: { name: 'Friday rest', rest: true, done: false },
      }).openKind,
    ).toBe('spending_snapshot')
  })

  test('caps at four rungs even when everything is due at once', () => {
    const q = pickHomeQueue({
      ...base,
      hour: 19,
      lastNightLogged: false,
      next: { time: '8:00 PM', title: 'Amy' },
      peopleDue: [{ name: 'Maya', days: 16, id: 'p1' }],
      dueLoop: { id: 'l1', title: 'Send Maya the deck', dueAt: '2020-01-01T00:00:00.000Z' },
      proteinToday: 10,
      spend: 500,
      weeklyBudget: 400,
    })
    expect(q).toHaveLength(4)
    // Distinct ids, or React would collapse rows and Done would mark the wrong one.
    expect(new Set(q.map((i) => i.id)).size).toBe(4)
  })

  test('says nothing is on fire only when the queue is otherwise empty', () => {
    const quiet = pickHomeQueue({
      ...base,
      hour: 15,
      proteinToday: 200,
      workoutToday: { name: 'Friday rest', rest: true, done: false },
    })
    expect(quiet).toHaveLength(1)
    expect(quiet[0]!.title).toBe('Nothing is on fire')

    const busy = pickHomeQueue({ ...base, hour: 15, proteinToday: 200 })
    expect(busy.map((i) => i.title)).not.toContain('Nothing is on fire')
  })
})

describe('pickHomeQueue verbs', () => {
  const clear: HomeSlice = {
    ...base,
    hour: 15,
    proteinToday: 200,
    workoutToday: { name: 'Friday rest', rest: true, done: false },
  }

  test('a person with an id can be marked touched from home', () => {
    const a = lead({ ...clear, peopleDue: [{ name: 'Maya Lin', days: 16, id: 'p1', phone: '+1 (555) 010-2030' }] })
    expect(a.action).toBe('person')
    expect(a.personId).toBe('p1')
    expect(a.doLabel).toBe('Talked')
    // And a prefilled text, so the ping and the log are one gesture.
    expect(a.sms).toContain('sms:+15550102030')
    expect(a.sms).toContain('Maya')
  })

  test('a person without an id degrades to a link, not a dead button', () => {
    const a = lead({ ...clear, peopleDue: [{ name: 'Maya', days: 16 }] })
    expect(a.action).toBe('open')
    expect(a.openKind).toBe('networking_crm')
    expect(a.personId).toBeUndefined()
  })

  test('an overdue promise can be closed from home', () => {
    const q = pickHomeQueue(
      { ...clear, dueLoop: { id: 'l1', title: 'Send Maya the deck', dueAt: '2026-01-01T00:00:00.000Z' } },
      new Date('2026-02-01T12:00:00.000Z'),
    )
    const loop = q.find((i) => i.action === 'loop')!
    expect(loop.loopId).toBe('l1')
    expect(loop.doLabel).toBe('Done')
    expect(loop.kicker).toBe('Overdue')
    expect(loop.hot).toBe(true)
  })

  test('a promise still ahead of its date is not called overdue', () => {
    const q = pickHomeQueue(
      { ...clear, dueLoop: { id: 'l1', title: 'Send the deck', dueAt: '2026-03-01T00:00:00.000Z' } },
      new Date('2026-02-01T12:00:00.000Z'),
    )
    const loop = q.find((i) => i.action === 'loop')!
    expect(loop.kicker).toBe('Promised')
    expect(loop.hot).toBeFalsy()
  })

  test('no promise means no promise rung', () => {
    expect(pickHomeQueue({ ...clear, dueLoop: null }).some((i) => i.action === 'loop')).toBe(false)
    expect(pickHomeQueue(clear).some((i) => i.action === 'loop')).toBe(false)
  })

  test('every rung that is not open carries the id its verb needs', () => {
    const q = pickHomeQueue({
      ...base,
      hour: 15,
      peopleDue: [{ name: 'Maya', days: 16, id: 'p1' }],
      dueLoop: { id: 'l1', title: 'Ship it' },
    })
    for (const item of q) {
      if (item.action === 'person') expect(item.personId).toBeTruthy()
      else if (item.action === 'loop') expect(item.loopId).toBeTruthy()
      else expect(item.action).toBe('open')
      // An open rung is a link, so it must have somewhere to go.
      if (item.action === 'open') expect(item.openKind).toBeTruthy()
    }
  })
})

describe('pickLastNight', () => {
  test('treats yesterday as logged', () => {
    const n = pickLastNight(
      [{ sleepDate: '2026-08-20', bedtime: '23:00', wake: '07:00' }],
      '2026-08-21',
    )
    expect(n.logged).toBe(true)
    expect(n.hours).toBe(8)
  })

  test('treats this morning as last night', () => {
    const n = pickLastNight(
      [{ sleepDate: '2026-08-21T00:00:00.000Z', bedtime: '23:15', wake: '07:00' }],
      '2026-08-21',
    )
    expect(n.logged).toBe(true)
  })

  test('counts a night saved in the last 36 hours', () => {
    const n = pickLastNight(
      [{ sleepDate: 'not-a-date', bedtime: '23:00', wake: '07:00', createdAt: new Date().toISOString() }],
      '2026-08-21',
    )
    expect(n.logged).toBe(true)
    expect(n.hours).toBe(8)
  })

  test('does not invent a night from last week', () => {
    const n = pickLastNight(
      [{ sleepDate: '2026-08-14', bedtime: '23:00', wake: '07:00', createdAt: '2026-08-14T08:00:00.000Z' }],
      '2026-08-21',
    )
    expect(n.logged).toBe(false)
  })
})

describe('mergeMeets', () => {
  test('fills empty primary from today calendar', () => {
    const out = mergeMeets([], [{ time: '4:00 PM', title: 'Amy' }])
    expect(out).toEqual([{ time: '4:00 PM', title: 'Amy' }])
  })
})

describe('homeFetchPlan', () => {
  test('skips both when the snapshot already answered', () => {
    expect(homeFetchPlan({ home: { lastNight: { logged: true }, peopleDue: [{ name: 'Amy' }] } })).toEqual({
      sleep: false,
      people: false,
    })
  })

  test('asks for sleep only when last night is unlogged', () => {
    expect(homeFetchPlan({ home: { lastNight: { logged: false }, peopleDue: [{ name: 'Amy' }] } })).toEqual({
      sleep: true,
      people: false,
    })
  })

  test('asks for people only when the snapshot has none due', () => {
    expect(homeFetchPlan({ home: { lastNight: { logged: true }, peopleDue: [] } })).toEqual({
      sleep: false,
      people: true,
    })
  })

  test('asks for both with no snapshot, or a snapshot missing the fields', () => {
    expect(homeFetchPlan(null)).toEqual({ sleep: true, people: true })
    expect(homeFetchPlan(undefined)).toEqual({ sleep: true, people: true })
    expect(homeFetchPlan({})).toEqual({ sleep: true, people: true })
    expect(homeFetchPlan({ home: {} })).toEqual({ sleep: true, people: true })
  })
})

describe('remainingMeets', () => {
  const at = (h: number, min = 0) => ({ getHours: () => h, getMinutes: () => min } as unknown as Date)

  test('drops meetings whose time has already passed', () => {
    const meets = [{ time: '11:30 AM', title: 'Past' }, { time: '6:00 PM', title: 'Still ahead' }]
    expect(remainingMeets(meets, at(17))).toEqual([{ time: '6:00 PM', title: 'Still ahead' }])
  })

  test('keeps a meeting that just started during the grace window', () => {
    const meets = [{ time: '4:58 PM', title: 'Just began' }]
    expect(remainingMeets(meets, at(17))).toEqual(meets)
  })

  test('keeps all-day or unparseable times rather than dropping them as past', () => {
    const meets = [{ time: 'All day', title: 'Offsite' }, { time: '9:00 AM', title: 'Early' }]
    expect(remainingMeets(meets, at(17))).toEqual([{ time: 'All day', title: 'Offsite' }])
  })
})
