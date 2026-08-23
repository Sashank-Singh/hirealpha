import { describe, expect, test } from 'bun:test'
import { homeFetchPlan, mergeMeets, pickHomeAction, pickLastNight, remainingMeets, type HomeSlice } from './home'

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

describe('pickHomeAction', () => {
  test('asks for last night before food in the morning', () => {
    const a = pickHomeAction({ ...base, lastNightLogged: false, proteinToday: 0 })
    expect(a.openKind).toBe('sleep_tracker')
    expect(a.title).toBe('Log last night')
  })

  test('does not promote protein at 7am when sleep is in', () => {
    const a = pickHomeAction({ ...base, hour: 7, proteinToday: 0 })
    expect(a.openKind).not.toBe('nutrition')
  })

  test('next meet beats people and food', () => {
    const a = pickHomeAction({
      ...base,
      next: { time: '9:00 AM', title: 'Amy' },
      peopleDue: [{ name: 'Maya', days: 16 }],
    })
    expect(a.openKind).toBe('digest')
    expect(a.title).toContain('Amy')
  })

  test('people due when the morning is otherwise clear', () => {
    const a = pickHomeAction({
      ...base,
      workoutToday: { name: 'Friday rest', rest: true, done: false },
      peopleDue: [{ name: 'Maya', days: 16 }],
    })
    expect(a.title).toBe('Ping Maya')
    expect(a.openKind).toBe('networking_crm')
  })

  test('protein can win after 11am', () => {
    const a = pickHomeAction({
      ...base,
      hour: 13,
      proteinToday: 0,
      workoutToday: { name: 'Friday rest', rest: true, done: false },
    })
    expect(a.openKind).toBe('nutrition')
  })

  test('evening over cap beats leftover protein', () => {
    const a = pickHomeAction({
      ...base,
      hour: 19,
      proteinToday: 40,
      spend: 500,
      weeklyBudget: 400,
      workoutToday: { name: 'Friday rest', rest: true, done: false },
    })
    expect(a.openKind).toBe('spending_snapshot')
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
