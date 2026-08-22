import { describe, expect, test } from 'bun:test'
import { mergeMeets, pickHomeAction, pickLastNight, type HomeSlice } from './home'

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
