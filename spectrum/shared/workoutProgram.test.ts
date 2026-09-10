import { describe, expect, it } from 'bun:test'
import {
  WORKOUT_CATEGORIES,
  WORKOUT_PROGRAMS,
  WORKOUT_WEEKDAYS,
  defaultWorkoutDay,
  defaultWorkoutWeekday,
  formatTimerDisplay,
  isWorkoutCategory,
  isWorkoutMoveCount,
  jsDayToWeekday,
  movePrescription,
  programFor,
  restLabel,
  workoutSession,
} from '../../src/platform/workoutProgram'
import { exerciseDemoUrl } from '../../src/platform/exerciseDemos'

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

  it('keeps home days bodyweight only with balanced coach-recommended splits', () => {
    const gear = /\b(dumbbell|barbell|bench|cable|machine|goblet|kettle|smith|pulldown|pushdown)\b/i
    expect(workoutSession('home', 1).name).toBe('Push & Core')
    expect(workoutSession('home', 2).name).toBe('Pull & Posterior')
    expect(workoutSession('home', 3).name).toBe('Legs & Power')
    expect(workoutSession('home', 4).name).toBe('Upper & Athletic')
    expect(workoutSession('home', 5).name).toBe('Lower & Conditioning')
    expect(WORKOUT_PROGRAMS.home[1].moves.map((m) => m.name)).toEqual([
      'Push ups',
      'Pike push ups',
      'Plank shoulder taps',
      'Cobra',
      'Diamond push ups',
      'Plank',
    ])
    expect(WORKOUT_PROGRAMS.home[2].moves.map((m) => m.name)).toEqual([
      'Superman',
      'Glute bridge',
      'Back extension',
      'Glute kickback',
      'Cobra',
      'Plank shoulder taps',
    ])
    expect(WORKOUT_PROGRAMS.home[3].moves.map((m) => m.name)).toEqual([
      'Squat',
      'Reverse lunge',
      'Glute bridge',
      'Jump squat',
      'Split squat',
      'Calf raise',
    ])
    expect(WORKOUT_PROGRAMS.home[4].moves.map((m) => m.name)).toEqual([
      'Hindu push ups',
      'Superman',
      'Wide push ups',
      'Back extension',
      'Plank shoulder taps',
      'Plank',
    ])
    expect(WORKOUT_PROGRAMS.home[5].moves.map((m) => m.name)).toEqual([
      'Walking lunge',
      'Single leg glute bridge',
      'Reverse lunge',
      'Split squat',
      'Calf raise',
      'Glute kickback',
    ])
    for (const day of WORKOUT_WEEKDAYS) {
      for (const move of WORKOUT_PROGRAMS.home[day].moves) {
        expect(move.name).not.toMatch(gear)
      }
    }
  })

  it('has a local demo for every programmed lift', () => {
    for (const place of ['home', 'gym'] as const) {
      for (const day of WORKOUT_WEEKDAYS) {
        for (const move of WORKOUT_PROGRAMS[place][day].moves) {
          const url = exerciseDemoUrl(move.name) ?? ''
          expect(`${move.name}:${url}`).toMatch(/:\/workout\//)
        }
      }
    }
  })

  it('treats Pushups and Push ups as the same demo', () => {
    const push = exerciseDemoUrl('Push ups')
    expect(push).toContain('/workout/push-ups.gif')
    expect(exerciseDemoUrl('Pushups')).toBe(push)
    expect(exerciseDemoUrl('push-ups')).toBe(push)
    const wide = exerciseDemoUrl('Wide push ups')
    expect(wide).toContain('/workout/wide-push-ups.gif')
    expect(exerciseDemoUrl('wide push ups')).toBe(wide)
    expect(exerciseDemoUrl('wide push-ups')).toBe(wide)
  })

  it('treats Saturday and Sunday as rest', () => {
    expect(jsDayToWeekday(0)).toBeNull()
    expect(jsDayToWeekday(6)).toBeNull()
    expect(defaultWorkoutWeekday(new Date('2026-08-16T12:00:00'))).toBe(1)
  })

  it('supports distinct coach-crafted workout categories with local demos', () => {
    for (const cat of WORKOUT_CATEGORIES) {
      expect(isWorkoutCategory(cat.id)).toBe(true)
      for (const day of WORKOUT_WEEKDAYS) {
        const session = workoutSession('home', day, 6, cat.id)
        expect(session.moves.length).toBe(6)
        expect(session.name.length).toBeGreaterThan(0)
        for (const move of session.moves) {
          const url = exerciseDemoUrl(move.name) ?? ''
          expect(`${cat.id}:${move.name}:${url}`).toMatch(/:\/workout\//)
        }
      }
    }
  })

  it('guarantees home and gym workouts are strictly different for every category', () => {
    const gear = /\b(dumbbell|barbell|bench|cable|machine|goblet|kettle|smith|pulldown|pushdown)\b/i
    for (const cat of WORKOUT_CATEGORIES) {
      for (const day of WORKOUT_WEEKDAYS) {
        const homeSession = workoutSession('home', day, 6, cat.id)
        const gymSession = workoutSession('gym', day, 6, cat.id)
        const homeMoveNames = homeSession.moves.map((m) => m.name)
        const gymMoveNames = gymSession.moves.map((m) => m.name)

        // Home and Gym must NEVER be the same moveset
        expect(homeMoveNames).not.toEqual(gymMoveNames)

        // Home workouts must never require gym gear
        for (const move of homeSession.moves) {
          expect(move.name).not.toMatch(gear)
        }

        // Gym workouts must have local demos for all moves
        for (const move of gymSession.moves) {
          const url = exerciseDemoUrl(move.name) ?? ''
          expect(`gym:${cat.id}:${move.name}:${url}`).toMatch(/:\/workout\//)
        }
      }
    }
  })

  it('formats restLabel cleanly for minutes and seconds', () => {
    expect(restLabel(60)).toBe('1 minute rest')
    expect(restLabel(120)).toBe('2 minutes rest')
    expect(restLabel(180)).toBe('3 minutes rest')
    expect(restLabel(45)).toBe('45 seconds rest')
    expect(restLabel(90)).toBe('90 seconds rest')
  })

  it('safely formats timer display without NaN', () => {
    expect(formatTimerDisplay(0)).toBe('00:00')
    expect(formatTimerDisplay(-5)).toBe('00:00')
    expect(formatTimerDisplay(NaN)).toBe('00:00')
    expect(formatTimerDisplay(Infinity)).toBe('00:00')
    expect(formatTimerDisplay(65)).toBe('01:05')
    expect(formatTimerDisplay(120)).toBe('02:00')
  })

  it('defaultWorkoutDay handles missing or empty days safely', () => {
    const sunday = new Date('2026-08-16T12:00:00') // day 0
    expect(defaultWorkoutDay(null, sunday)).toBe(1)
    expect(defaultWorkoutDay(undefined, sunday)).toBe(1)
    expect(defaultWorkoutDay([], sunday)).toBe(1)
    expect(defaultWorkoutDay([2, 4], new Date('2026-08-18T12:00:00'))).toBe(2)
  })

  it('programFor normalizes invalid day inputs safely without throwing', () => {
    const fallback = programFor('gym', 1)
    // @ts-expect-error invalid day
    expect(programFor('gym', 7).name).toBe(fallback.name)
    // @ts-expect-error invalid day
    expect(programFor('gym', -1).name).toBe(fallback.name)
    // @ts-expect-error invalid day
    expect(programFor('gym', undefined).name).toBe(fallback.name)
  })
})

