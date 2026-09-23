import type { SQL } from 'bun'
import { isClock } from './parsers'

export type MiniPrefs = {
  workoutPlace: 'home' | 'gym'
  workoutMoveCount: 4 | 5 | 6
  workoutDays: number[]
  sleepBedtime: string
  sleepWake: string
  currentWeightLb: number | null
  targetWeightLb: number | null
  weightGoal: 'loss' | 'gain' | 'muscle' | null
}

export const DEFAULT_WORKOUT_DAYS = [1, 2, 3, 4, 5]

export function clampWorkoutMoveCount(v: unknown): 4 | 5 | 6 {
  const n = typeof v === 'number' ? v : Number(v)
  return n === 5 || n === 6 ? n : 4
}

export function clampWorkoutDays(v: unknown): number[] {
  const raw =
    typeof v === 'string'
      ? v.split(',').map((x) => Number(x.trim()))
      : Array.isArray(v)
        ? v.map(Number)
        : []
  const days = [...new Set(raw.filter((n) => Number.isInteger(n) && n >= 0 && n <= 6))].sort(
    (a, b) => a - b,
  )
  return days.length ? days : [...DEFAULT_WORKOUT_DAYS]
}

export async function loadMiniPrefs(sql: SQL, userId: string): Promise<MiniPrefs> {
  const rows = await sql`
    SELECT workout_place AS "workoutPlace", workout_move_count AS "workoutMoveCount",
           workout_days AS "workoutDays", sleep_bedtime AS "sleepBedtime", sleep_wake AS "sleepWake",
           current_weight_lb AS "currentWeightLb", target_weight_lb AS "targetWeightLb", weight_goal AS "weightGoal"
    FROM hire_mini_prefs WHERE user_id = ${userId} LIMIT 1
  `
  const row = rows[0] as (MiniPrefs & { workoutMoveCount?: unknown }) | undefined
  const place = row?.workoutPlace === 'home' ? 'home' : 'gym'
  return {
    workoutPlace: place,
    workoutMoveCount: clampWorkoutMoveCount(row?.workoutMoveCount),
    workoutDays: clampWorkoutDays(row?.workoutDays),
    sleepBedtime: isClock(row?.sleepBedtime || '') ? row!.sleepBedtime : '23:00',
    sleepWake: isClock(row?.sleepWake || '') ? row!.sleepWake : '07:00',
    currentWeightLb:
      typeof row?.currentWeightLb === 'number' && row.currentWeightLb > 0
        ? row.currentWeightLb
        : null,
    targetWeightLb:
      typeof row?.targetWeightLb === 'number' && row.targetWeightLb > 0
        ? row.targetWeightLb
        : null,
    weightGoal:
      row?.weightGoal === 'loss' || row?.weightGoal === 'gain' || row?.weightGoal === 'muscle'
        ? row.weightGoal
        : null,
  }
}

export async function saveMiniPrefs(
  sql: SQL,
  userId: string,
  patch: Partial<MiniPrefs>,
): Promise<MiniPrefs> {
  const cur = await loadMiniPrefs(sql, userId)
  const next: MiniPrefs = {
    workoutPlace:
      patch.workoutPlace === 'home' || patch.workoutPlace === 'gym'
        ? patch.workoutPlace
        : cur.workoutPlace,
    workoutMoveCount:
      patch.workoutMoveCount === 4 || patch.workoutMoveCount === 5 || patch.workoutMoveCount === 6
        ? patch.workoutMoveCount
        : cur.workoutMoveCount,
    workoutDays: patch.workoutDays?.length ? clampWorkoutDays(patch.workoutDays) : cur.workoutDays,
    sleepBedtime: isClock(patch.sleepBedtime || '') ? patch.sleepBedtime! : cur.sleepBedtime,
    sleepWake: isClock(patch.sleepWake || '') ? patch.sleepWake! : cur.sleepWake,
    currentWeightLb:
      typeof patch.currentWeightLb === 'number' && patch.currentWeightLb > 0
        ? Math.round(patch.currentWeightLb * 10) / 10
        : cur.currentWeightLb,
    targetWeightLb:
      typeof patch.targetWeightLb === 'number' && patch.targetWeightLb > 0
        ? Math.round(patch.targetWeightLb * 10) / 10
        : cur.targetWeightLb,
    weightGoal: patch.weightGoal ?? cur.weightGoal,
  }
  await sql`
    INSERT INTO hire_mini_prefs (user_id, workout_place, workout_move_count, workout_days, sleep_bedtime, sleep_wake, current_weight_lb, target_weight_lb, weight_goal, updated_at)
    VALUES (${userId}, ${next.workoutPlace}, ${next.workoutMoveCount}, ${next.workoutDays.join(',')}, ${next.sleepBedtime}, ${next.sleepWake}, ${next.currentWeightLb}, ${next.targetWeightLb}, ${next.weightGoal}, now())
    ON CONFLICT (user_id) DO UPDATE SET
      workout_place = excluded.workout_place,
      workout_move_count = excluded.workout_move_count,
      workout_days = excluded.workout_days,
      sleep_bedtime = excluded.sleep_bedtime,
      sleep_wake = excluded.sleep_wake,
      current_weight_lb = excluded.current_weight_lb,
      target_weight_lb = excluded.target_weight_lb,
      weight_goal = excluded.weight_goal,
      updated_at = now()
  `
  return next
}
