import { shiftDateStr } from '../timezones'

export function calculateHabitStreak(dates: Set<string>, today: string): number {
  let cursor = dates.has(today) ? today : shiftDateStr(today, -1)
  let streak = 0
  while (dates.has(cursor)) {
    streak++
    cursor = shiftDateStr(cursor, -1)
  }
  return streak
}
