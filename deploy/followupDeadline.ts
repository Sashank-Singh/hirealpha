import { pickUserTimezone, wallTimeToUtc } from './timezones'

/**
 * The next weekday-Friday 17:00 in the user's timezone, computed after `from`.
 * Used by the post-send follow-up offer ("remind you Friday if they don't
 * answer") so the deadline the user agrees to is the deadline that is stored.
 */
export function nextFridayAt5(from: Date = new Date(), tz?: string): string {
  const timezone = pickUserTimezone({ userTz: tz })
  const fmt = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' })
  const weekday = (ymd: string) => new Intl.DateTimeFormat('en-US', { timeZone: timezone, weekday: 'short' }).format(wallTimeToUtc(ymd, 12, 0, timezone))
  let ymd = fmt.format(from)
  // Walk forward until the local weekday is Friday AND 17:00 that day is
  // strictly in the future (a Friday-after-5 send must get the NEXT Friday).
  let candidate = wallTimeToUtc(ymd, 17, 0, timezone)
  while (weekday(ymd) !== 'Fri' || candidate.getTime() <= from.getTime()) {
    const d = wallTimeToUtc(ymd, 12, 0, timezone)
    d.setUTCDate(d.getUTCDate() + 1)
    ymd = fmt.format(d)
    candidate = wallTimeToUtc(ymd, 17, 0, timezone)
  }
  return candidate.toISOString()
}
