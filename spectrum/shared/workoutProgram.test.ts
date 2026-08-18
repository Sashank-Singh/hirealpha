import { describe, expect, it } from 'bun:test'
import {
  WORKOUT_PROGRAMS,
  WORKOUT_WEEKDAYS,
  defaultWorkoutWeekday,
  isWorkoutMoveCount,
  jsDayToWeekday,
  movePrescription,
  restLabel,
  workoutSession,
} from '../../src/platform/workoutProgram'

describe('workout programs', () => {
  it('has home and gym sessions for Monday through Friday', () => {
    for (const place of ['home', 'gym'] as const) {
      expect(WORKOUT_WEEKDAYS.map((day) => workoutSession(place, day).weekday)).toEqual([1, 2, 3, 4, 5])
      for (const day of WORKOUT_WEEKDAYS) {
        const session = WORKOUT_PROGRAMS[place][day]
        expect(session.moves.length).toBeGreaterThanOrEqual(6)
        expect(new Set(session.moves.map((m) => m.name.toLowerCase())).size).toBe(session.moves.length)
        expect(session.name.length).toBeGreaterThan(0)
      }
    }
  })

  it('keeps a 4 move session as the first four of the full day', () => {
    for (const place of ['home', 'gym'] as const) {
      for (const day of WORKOUT_WEEKDAYS) {
        const full = WORKOUT_PROGRAMS[place][day]
        const four = workoutSession(place, day, 4)
        expect(four.moves).toEqual(full.moves.slice(0, 4))
        expect(workoutSession(place, day).moves).toEqual(four.moves)
      }
    }
  })

  it('slices 5 and 6 move sessions from the full list', () => {
    for (const place of ['home', 'gym'] as const) {
      for (const day of WORKOUT_WEEKDAYS) {
        const full = WORKOUT_PROGRAMS[place][day]
        expect(workoutSession(place, day, 5).moves).toEqual(full.moves.slice(0, 5))
        expect(workoutSession(place, day, 6).moves).toEqual(full.moves.slice(0, 6))
      }
    }
  })

  it('falls invalid counts back to 4', () => {
    const four = workoutSession('gym', 1, 4).moves
    expect(workoutSession('gym', 1, 3).moves).toEqual(four)
    expect(workoutSession('gym', 1, 7).moves).toEqual(four)
    expect(workoutSession('gym', 1, 0).moves).toEqual(four)
    expect(isWorkoutMoveCount(4)).toBe(true)
    expect(isWorkoutMoveCount(5)).toBe(true)
    expect(isWorkoutMoveCount(6)).toBe(true)
    expect(isWorkoutMoveCount(3)).toBe(false)
  })

  it('uses a push pull legs upper lower gym split', () => {
    expect(workoutSession('gym', 1).name).toBe('Push')
    expect(workoutSession('gym', 2).name).toBe('Pull')
    expect(workoutSession('gym', 3).name).toBe('Legs')
    expect(workoutSession('gym', 4).name).toBe('Upper')
    expect(workoutSession('gym', 5).name).toBe('Lower')
  })

  it('treats Saturday and Sunday as rest', () => {
    expect(jsDayToWeekday(0)).toBeNull()
    expect(jsDayToWeekday(6)).toBeNull()
    expect(defaultWorkoutWeekday(new Date('2026-08-16T12:00:00'))).toBe(1)
  })

  it('prints compact set prescriptions without dashes', () => {
    expect(restLabel(120)).toBe('2 min rest')
    expect(movePrescription({ name: 'Bench press', sets: 4, reps: 6, restSec: 90 }, 185)).toBe(
      '4 × 6 @ 185. 90s rest',
    )
  })
})
