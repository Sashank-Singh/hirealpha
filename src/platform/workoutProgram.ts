export type WorkoutPlace = 'home' | 'gym'
export type WorkoutWeekday = 1 | 2 | 3 | 4 | 5
export type WorkoutMoveCount = 4 | 5 | 6

export type WorkoutMove = {
  name: string
  sets: number
  reps: number
  restSec: number
}

export type WorkoutSession = {
  weekday: WorkoutWeekday
  dayLabel: string
  name: string
  moves: WorkoutMove[]
}

export const WORKOUT_PLACE_KEY = 'hire.workout.place'
export const WORKOUT_MOVE_COUNT_KEY = 'hire.workout.moves'

export const WORKOUT_WEEKDAYS: WorkoutWeekday[] = [1, 2, 3, 4, 5]

export const WORKOUT_DAY_LETTERS: Record<WorkoutWeekday, string> = {
  1: 'M',
  2: 'T',
  3: 'W',
  4: 'T',
  5: 'F',
}

export const WORKOUT_DAY_LABELS: Record<WorkoutWeekday, string> = {
  1: 'Monday',
  2: 'Tuesday',
  3: 'Wednesday',
  4: 'Thursday',
  5: 'Friday',
}

const GYM: Record<WorkoutWeekday, WorkoutSession> = {
  1: {
    weekday: 1,
    dayLabel: 'Monday',
    name: 'Push',
    moves: [
      { name: 'Bench press', sets: 4, reps: 6, restSec: 120 },
      { name: 'Overhead press', sets: 3, reps: 8, restSec: 90 },
      { name: 'Incline dumbbell press', sets: 3, reps: 10, restSec: 75 },
      { name: 'Tricep pushdown', sets: 3, reps: 12, restSec: 60 },
      { name: 'Lateral raise', sets: 3, reps: 12, restSec: 60 },
      { name: 'Cable fly', sets: 3, reps: 12, restSec: 60 },
    ],
  },
  2: {
    weekday: 2,
    dayLabel: 'Tuesday',
    name: 'Pull',
    moves: [
      { name: 'Barbell row', sets: 4, reps: 6, restSec: 120 },
      { name: 'Lat pulldown', sets: 3, reps: 8, restSec: 90 },
      { name: 'Seated cable row', sets: 3, reps: 10, restSec: 75 },
      { name: 'Dumbbell curl', sets: 3, reps: 10, restSec: 60 },
      { name: 'Face pull', sets: 3, reps: 12, restSec: 60 },
      { name: 'Hammer curl', sets: 3, reps: 10, restSec: 60 },
    ],
  },
  3: {
    weekday: 3,
    dayLabel: 'Wednesday',
    name: 'Legs',
    moves: [
      { name: 'Back squat', sets: 4, reps: 6, restSec: 150 },
      { name: 'Romanian deadlift', sets: 3, reps: 8, restSec: 120 },
      { name: 'Leg press', sets: 3, reps: 10, restSec: 90 },
      { name: 'Calf raise', sets: 3, reps: 12, restSec: 60 },
      { name: 'Leg extension', sets: 3, reps: 12, restSec: 60 },
      { name: 'Hanging knee raise', sets: 3, reps: 12, restSec: 45 },
    ],
  },
  4: {
    weekday: 4,
    dayLabel: 'Thursday',
    name: 'Upper',
    moves: [
      { name: 'Incline bench', sets: 4, reps: 8, restSec: 90 },
      { name: 'Pull ups', sets: 4, reps: 8, restSec: 90 },
      { name: 'Seated dumbbell press', sets: 3, reps: 10, restSec: 75 },
      { name: 'Chest supported row', sets: 3, reps: 10, restSec: 75 },
      { name: 'Lateral raise', sets: 3, reps: 12, restSec: 60 },
      { name: 'Face pull', sets: 3, reps: 12, restSec: 60 },
    ],
  },
  5: {
    weekday: 5,
    dayLabel: 'Friday',
    name: 'Lower',
    moves: [
      { name: 'Deadlift', sets: 3, reps: 5, restSec: 180 },
      { name: 'Bulgarian split squat', sets: 3, reps: 8, restSec: 90 },
      { name: 'Leg curl', sets: 3, reps: 10, restSec: 75 },
      { name: 'Walking lunge', sets: 3, reps: 10, restSec: 75 },
      { name: 'Hip abductor', sets: 3, reps: 12, restSec: 60 },
      { name: 'Calf raise', sets: 3, reps: 15, restSec: 45 },
    ],
  },
}

const HOME: Record<WorkoutWeekday, WorkoutSession> = {
  1: {
    weekday: 1,
    dayLabel: 'Monday',
    name: 'Push',
    moves: [
      { name: 'Push ups', sets: 4, reps: 10, restSec: 75 },
      { name: 'Pike push ups', sets: 3, reps: 8, restSec: 75 },
      { name: 'Diamond push ups', sets: 3, reps: 10, restSec: 60 },
      { name: 'Wide push ups', sets: 3, reps: 12, restSec: 60 },
      { name: 'Hindu push ups', sets: 3, reps: 10, restSec: 60 },
      { name: 'Decline push ups', sets: 3, reps: 10, restSec: 60 },
    ],
  },
  2: {
    weekday: 2,
    dayLabel: 'Tuesday',
    name: 'Pull',
    moves: [
      { name: 'Superman', sets: 4, reps: 12, restSec: 60 },
      { name: 'Glute kickback', sets: 3, reps: 12, restSec: 60 },
      { name: 'Cobra', sets: 3, reps: 12, restSec: 45 },
      { name: 'Back extension', sets: 3, reps: 12, restSec: 60 },
      { name: 'Glute bridge', sets: 3, reps: 12, restSec: 60 },
      { name: 'Plank', sets: 3, reps: 30, restSec: 45 },
    ],
  },
  3: {
    weekday: 3,
    dayLabel: 'Wednesday',
    name: 'Legs',
    moves: [
      { name: 'Squat', sets: 4, reps: 10, restSec: 75 },
      { name: 'Reverse lunge', sets: 3, reps: 10, restSec: 75 },
      { name: 'Glute bridge', sets: 3, reps: 12, restSec: 60 },
      { name: 'Jump squat', sets: 3, reps: 10, restSec: 60 },
      { name: 'Calf raise', sets: 3, reps: 15, restSec: 45 },
      { name: 'Split squat', sets: 3, reps: 8, restSec: 75 },
    ],
  },
  4: {
    weekday: 4,
    dayLabel: 'Thursday',
    name: 'Upper',
    moves: [
      { name: 'Push ups', sets: 3, reps: 12, restSec: 60 },
      { name: 'Pike push ups', sets: 3, reps: 8, restSec: 75 },
      { name: 'Superman', sets: 3, reps: 12, restSec: 60 },
      { name: 'Diamond push ups', sets: 3, reps: 10, restSec: 60 },
      { name: 'Glute kickback', sets: 3, reps: 12, restSec: 60 },
      { name: 'Plank', sets: 3, reps: 30, restSec: 45 },
    ],
  },
  5: {
    weekday: 5,
    dayLabel: 'Friday',
    name: 'Lower',
    moves: [
      { name: 'Reverse lunge', sets: 3, reps: 8, restSec: 75 },
      { name: 'Single leg glute bridge', sets: 3, reps: 10, restSec: 60 },
      { name: 'Split squat', sets: 3, reps: 8, restSec: 75 },
      { name: 'Calf raise', sets: 3, reps: 15, restSec: 45 },
      { name: 'Walking lunge', sets: 3, reps: 10, restSec: 75 },
      { name: 'Plank', sets: 3, reps: 30, restSec: 45 },
    ],
  },
}

export const WORKOUT_PROGRAMS: Record<WorkoutPlace, Record<WorkoutWeekday, WorkoutSession>> = {
  home: HOME,
  gym: GYM,
}

export function isWorkoutPlace(value: string | null | undefined): value is WorkoutPlace {
  return value === 'home' || value === 'gym'
}

export function isWorkoutMoveCount(value: unknown): value is WorkoutMoveCount {
  return value === 4 || value === 5 || value === 6
}

export function isWorkoutWeekday(value: number): value is WorkoutWeekday {
  return value === 1 || value === 2 || value === 3 || value === 4 || value === 5
}

export function jsDayToWeekday(jsDay: number): WorkoutWeekday | null {
  return isWorkoutWeekday(jsDay) ? jsDay : null
}

export function defaultWorkoutWeekday(now = new Date()): WorkoutWeekday {
  return jsDayToWeekday(now.getDay()) ?? 1
}

export function isWeekend(now = new Date()): boolean {
  const d = now.getDay()
  return d === 0 || d === 6
}

export function workoutSession(
  place: WorkoutPlace,
  weekday: WorkoutWeekday,
  count: number = 4,
): WorkoutSession {
  const full = WORKOUT_PROGRAMS[place][weekday]
  const n = isWorkoutMoveCount(count) ? count : 4
  return { ...full, moves: full.moves.slice(0, n) }
}

export function readWorkoutPlace(): WorkoutPlace {
  try {
    const raw = localStorage.getItem(WORKOUT_PLACE_KEY)
    if (isWorkoutPlace(raw)) return raw
  } catch {
    /* ignore */
  }
  return 'gym'
}

export function writeWorkoutPlace(place: WorkoutPlace) {
  try {
    localStorage.setItem(WORKOUT_PLACE_KEY, place)
  } catch {
    /* ignore */
  }
}

export function readWorkoutMoveCount(): WorkoutMoveCount {
  try {
    const n = Number(localStorage.getItem(WORKOUT_MOVE_COUNT_KEY))
    if (isWorkoutMoveCount(n)) return n
  } catch {
    /* ignore */
  }
  return 4
}

export function writeWorkoutMoveCount(count: WorkoutMoveCount) {
  try {
    localStorage.setItem(WORKOUT_MOVE_COUNT_KEY, String(count))
  } catch {
    /* ignore */
  }
}

export function restLabel(restSec: number): string {
  if (restSec >= 120 && restSec % 60 === 0) {
    const m = restSec / 60
    return `${m} minute${m === 1 ? '' : 's'} rest`
  }
  return `${restSec} seconds rest`
}

export function setsRepsLabel(sets: number, reps: number): string {
  return `${sets} set${sets === 1 ? '' : 's'} of ${reps} rep${reps === 1 ? '' : 's'}`
}

export function movePrescription(move: WorkoutMove, weight = 0): string {
  const lift = setsRepsLabel(move.sets, move.reps)
  const load = weight > 0 ? ` at ${weight} lbs` : ''
  return `${lift}${load}. ${restLabel(move.restSec)}`
}
