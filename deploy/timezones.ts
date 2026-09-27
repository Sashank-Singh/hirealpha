/** Map spoken / stored zone names onto IANA so calendar clocks follow the person. */

const ABBR: Record<string, string> = {
  pst: 'America/Los_Angeles',
  pdt: 'America/Los_Angeles',
  pacific: 'America/Los_Angeles',
  est: 'America/New_York',
  edt: 'America/New_York',
  eastern: 'America/New_York',
  cst: 'America/Chicago',
  cdt: 'America/Chicago',
  central: 'America/Chicago',
  mst: 'America/Denver',
  mdt: 'America/Denver',
  mountain: 'America/Denver',
  bst: 'Europe/London',
  gmt: 'Europe/London',
  utc: 'UTC',
  zulu: 'UTC',
}

const CITIES: Array<[RegExp, string]> = [
  [/\b(london|uk|britain|england|scotland|ireland)\b/i, 'Europe/London'],
  [/\b(new york|nyc|boston|miami|atlanta|cleveland|philadelphia|washington)\b/i, 'America/New_York'],
  [/\b(san francisco|\bsf\b|los angeles|\bla\b|seattle|portland|oakland|bay area)\b/i, 'America/Los_Angeles'],
  [/\b(chicago|austin|dallas|houston|minneapolis)\b/i, 'America/Chicago'],
  [/\b(denver|boulder|salt lake)\b/i, 'America/Denver'],
]

export function isValidTimeZone(tz: string): boolean {
  try {
    Intl.DateTimeFormat('en-US', { timeZone: tz }).format(new Date())
    return true
  } catch {
    return false
  }
}

export function resolveIanaTimezone(raw?: string | null): string | null {
  if (!raw?.trim()) return null
  const s = raw.trim()
  const lower = s.toLowerCase()
  if (ABBR[lower]) return ABBR[lower]
  const compact = lower.replace(/[^a-z]/g, '')
  if (ABBR[compact]) return ABBR[compact]
  if (isValidTimeZone(s)) return s
  return null
}

export function timezoneFromCoords(lat: number, lng: number): string | null {
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null
  if (lat >= 49.8 && lat <= 60.9 && lng >= -8.8 && lng <= 1.8) return 'Europe/London'
  if (lat >= 24.5 && lat <= 49.5 && lng >= -125 && lng <= -66.9) {
    if (lng <= -114) return 'America/Los_Angeles'
    if (lng <= -102) return 'America/Denver'
    if (lng <= -87) return 'America/Chicago'
    return 'America/New_York'
  }
  return null
}

export function timezoneFromText(text: string): string | null {
  const t = text.trim()
  if (!t) return null
  const spoken = t.match(
    /\b(?:i(?:'?m| am) (?:in|on)|now in|currently in|landed in|flying to|switching to|moved to|timezone(?: is)?|time zone(?: is)?)\s+([A-Za-z/_+-]+(?:\s+[A-Za-z]+){0,2})\b/i,
  )
  if (spoken) {
    const chunk = spoken[1]!.trim()
    const first = chunk.split(/\s+/)[0] || chunk
    const resolved = resolveIanaTimezone(first) || resolveIanaTimezone(chunk)
    if (resolved) return resolved
    for (const [re, iana] of CITIES) {
      if (re.test(chunk)) return iana
    }
  }
  return null
}

export function pickUserTimezone(opts: {
  message?: string
  userTz?: string | null
  contextTz?: string | null
  memoryTz?: string | null
  latitude?: number | null
  longitude?: number | null
  locationFresh?: boolean
}): string {
  const spoken = timezoneFromText(opts.message || '')
  if (spoken) return spoken
  if (
    opts.locationFresh &&
    opts.latitude != null &&
    opts.longitude != null &&
    Number.isFinite(opts.latitude) &&
    Number.isFinite(opts.longitude)
  ) {
    const geo = timezoneFromCoords(opts.latitude, opts.longitude)
    if (geo) return geo
  }
  return (
    resolveIanaTimezone(opts.userTz) ||
    resolveIanaTimezone(opts.contextTz) ||
    resolveIanaTimezone(opts.memoryTz) ||
    'America/Los_Angeles'
  )
}

/** Ground-truth clock for the model. No guessed weekday. */
export function formatNowForAgent(timezone: string, now = new Date()): string {
  const tz = resolveIanaTimezone(timezone) || 'America/Los_Angeles'
  const weekday = new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'long' }).format(now)
  const date = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    month: 'long',
    day: 'numeric',
    year: 'numeric',
  }).format(now)
  const time = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  })
    .format(now)
    .replace(/\u202f/g, ' ')
    .replace(/\u00a0/g, ' ')
  const zone = formatZoneAbbrev(now, tz)
  return `Today is ${weekday}, ${date}. Local time ${time} ${zone}. This is today. Do not guess the weekday or date.`
}

/** Convert a wall clock in `timezone` to a UTC Date. */
export function wallTimeToUtc(ymd: string, hour: number, minute: number, timezone: string): Date {
  const pad = (n: number) => String(n).padStart(2, '0')
  const naive = `${ymd}T${pad(hour)}:${pad(minute)}:00`
  const utcGuess = new Date(`${naive}Z`)
  const wanted = Date.UTC(
    Number(ymd.slice(0, 4)),
    Number(ymd.slice(5, 7)) - 1,
    Number(ymd.slice(8, 10)),
    hour,
    minute,
  )
  let candidate = utcGuess
  // The first correction can cross a DST boundary and therefore change the
  // applicable offset. Re-evaluate until the requested wall clock is stable.
  for (let i = 0; i < 3; i++) {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hour12: false,
    }).formatToParts(candidate)
    const get = (t: string) => Number(parts.find((p) => p.type === t)?.value || 0)
    let h = get('hour')
    if (h === 24) h = 0
    const asLocal = Date.UTC(get('year'), get('month') - 1, get('day'), h, get('minute'))
    const delta = wanted - asLocal
    if (delta === 0) break
    candidate = new Date(candidate.getTime() + delta)
  }
  return candidate
}

/** Parse ISO or spoken "tomorrow 3pm" into a UTC instant in the user's zone. */
export function parseSpokenWhen(raw: string, timezone: string, now = new Date()): Date | null {
  const s = String(raw || '').trim()
  if (!s) return null
  const tz = resolveIanaTimezone(timezone) || 'America/Los_Angeles'
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(s)) {
    if (/Z|[+-]\d{2}:\d{2}$/.test(s)) {
      const d = new Date(s)
      return Number.isNaN(d.getTime()) ? null : d
    }
    const ymd = s.slice(0, 10)
    const hour = Number(s.slice(11, 13))
    const minute = Number(s.slice(14, 16) || 0)
    return wallTimeToUtc(ymd, hour, minute, tz)
  }
  const lower = s.toLowerCase()
  const timeM = lower.match(/(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i)
  if (!timeM) {
    const d = new Date(s)
    return Number.isNaN(d.getTime()) ? null : d
  }
  let hour = Number(timeM[1])
  const minute = Number(timeM[2] || 0)
  const ap = (timeM[3] || '').toLowerCase()
  if (ap === 'pm' && hour < 12) hour += 12
  if (ap === 'am' && hour === 12) hour = 0
  if (!ap && hour <= 7) hour += 12
  let ymd = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now)
  if (/\btomorrow\b/.test(lower)) {
    const [y, m, d] = ymd.split('-').map(Number)
    ymd = new Date(Date.UTC(y || 1970, (m || 1) - 1, (d || 1) + 1)).toISOString().slice(0, 10)
  }
  const out = wallTimeToUtc(ymd, hour, minute, tz)
  return Number.isNaN(out.getTime()) ? null : out
}

export function formatZoneAbbrev(d: Date, timezone: string): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    hour: 'numeric',
    timeZoneName: 'short',
  }).formatToParts(d)
  const raw = (parts.find((p) => p.type === 'timeZoneName')?.value || '').replace(/\u202f/g, ' ').replace(/\u00a0/g, ' ')
  if (timezone === 'UTC') return 'UTC'
  if (timezone === 'Europe/London' && /^GMT\+1$/.test(raw)) return 'BST'
  if (timezone === 'Europe/London' && (raw === 'GMT' || raw === 'GMT+0')) return 'GMT'
  return raw || timezone
}

/** UTC offset in ms for an IANA zone at a given instant. */
export function tzOffsetMs(utcMs: number, timezone: string): number {
  try {
    const dtf = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      timeZoneName: 'longOffset',
      hour12: false,
    })
    const part = dtf
      .formatToParts(new Date(utcMs))
      .find((p) => p.type === 'timeZoneName')?.value
    const m = part?.match(/GMT([+-])(\d{2}):(\d{2})/)
    if (!m) return 0
    const sign = m[1] === '-' ? -1 : 1
    return sign * (Number(m[2]) * 60 + Number(m[3])) * 60 * 1000
  } catch {
    return 0
  }
}

/** Day window in the user's timezone as UTC [start,end] for "today". */
export function todayWindowUtc(timezone: string, now = new Date()): { start: Date; end: Date } {
  const tz = timezone || 'America/Los_Angeles'
  const dtf = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  })
  const [y, mo, d] = dtf.format(now).split('-').map(Number)
  const wallStart = Date.UTC(y!, mo! - 1, d!)
  const offset = tzOffsetMs(wallStart, tz)
  return { start: new Date(wallStart - offset), end: new Date(wallStart - offset + 86_400_000) }
}

/** Week window (the Monday `weekStart` in the user's timezone) as UTC [start,end]. */
export function weekWindowUtc(weekStart: string, timezone: string): { start: Date; end: Date } {
  const tz = timezone || 'America/Los_Angeles'
  const [y, m, d] = String(weekStart).split('-').map(Number)
  const wallStart = Date.UTC(y || 1970, (m || 1) - 1, d || 1)
  const offset = tzOffsetMs(wallStart, tz)
  const start = new Date(wallStart - offset)
  return { start, end: new Date(start.getTime() + 7 * 86_400_000) }
}

export function localDateStrInTz(d = new Date(), timezone?: string | null): string {
  const tz = timezone || 'America/Los_Angeles'
  try {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: tz,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(d)
  } catch {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: 'America/Los_Angeles',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(d)
  }
}

/** Next local HH:MM (today or tomorrow) as a UTC ISO string for the given zone. */
export function nextLocalTimeUtc(timezone: string, hour: number, minute = 0): string {
  const dtf = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  })
  const parts = dtf.formatToParts(new Date())
  const get = (t: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === t)?.value || '0'
  const wallNow = Date.UTC(
    Number(get('year')),
    Number(get('month')) - 1,
    Number(get('day')),
    Number(get('hour')),
    Number(get('minute')),
    Number(get('second')),
  )
  let wall = Date.UTC(
    Number(get('year')),
    Number(get('month')) - 1,
    Number(get('day')),
    hour,
    minute,
    0,
  )
  if (wall <= wallNow) wall += 86_400_000
  return new Date(wall - tzOffsetMs(wall, timezone)).toISOString()
}

export function loopTimezone(tz: string | null | undefined): string {
  return tz && isValidTimeZone(tz) ? tz : 'America/Los_Angeles'
}

/** Local calendar day and weekday (0=Sunday) for an instant in a zone. */
export function localWall(tz: string, at: Date): { ymd: string; weekday: number } {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    weekday: 'short',
  }).formatToParts(at)
  const get = (t: string) => parts.find((p) => p.type === t)?.value || ''
  const ymd = `${get('year')}-${get('month')}-${get('day')}`
  const weekday = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(get('weekday').slice(0, 3))
  return { ymd, weekday }
}

/** The next `hour`:00 local time in `tz` as a UTC ISO string. */
export function nextDailyUtc(tz: string | null | undefined, hour: number, from = new Date()): string {
  const zone = loopTimezone(tz)
  let when = wallTimeToUtc(localWall(zone, from).ymd, hour, 0, zone)
  if (when.getTime() <= from.getTime()) {
    const tomorrow = localWall(zone, new Date(from.getTime() + 24 * 60 * 60 * 1000)).ymd
    when = wallTimeToUtc(tomorrow, hour, 0, zone)
  }
  return when.toISOString()
}

/** The next `weekday` at `hour`:00 local time in `tz` as a UTC ISO string. */
export function nextWeeklyUtc(
  tz: string | null | undefined,
  hour: number,
  weekday: number,
  from = new Date(),
): string {
  const zone = loopTimezone(tz)
  const wall = localWall(zone, from)
  const add = (weekday - wall.weekday + 7) % 7
  let target = localWall(zone, new Date(from.getTime() + add * 24 * 60 * 60 * 1000)).ymd
  let when = wallTimeToUtc(target, hour, 0, zone)
  if (when.getTime() <= from.getTime()) {
    target = localWall(zone, new Date(from.getTime() + (add + 7) * 24 * 60 * 60 * 1000)).ymd
    when = wallTimeToUtc(target, hour, 0, zone)
  }
  return when.toISOString()
}

/** The next `intervalDays`-out run at `hour`:00 local time in `tz`, as a UTC ISO string. */
export function nextEveryDaysUtc(
  tz: string | null | undefined,
  hour: number,
  intervalDays: number,
  from = new Date(),
): string {
  const zone = loopTimezone(tz)
  let when = wallTimeToUtc(localWall(zone, from).ymd, hour, 0, zone)
  if (when.getTime() <= from.getTime()) {
    const later = localWall(zone, new Date(from.getTime() + intervalDays * 24 * 60 * 60 * 1000)).ymd
    when = wallTimeToUtc(later, hour, 0, zone)
  }
  return when.toISOString()
}

/** weekday: 0 = Sunday ... 6 = Saturday */
export function nextWeekdayLocalUtc(timezone: string, weekday: number, hour: number, minute = 0): string {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    weekday: 'short',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  })
  const parts = dtf.formatToParts(new Date())
  const get = (t: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === t)?.value || '0'
  const dayMap: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }
  const today = dayMap[get('weekday')] ?? 0
  const wallNow = Date.UTC(
    Number(get('year')),
    Number(get('month')) - 1,
    Number(get('day')),
    Number(get('hour')),
    Number(get('minute')),
    Number(get('second')),
  )
  let add = (weekday - today + 7) % 7
  let wall = Date.UTC(
    Number(get('year')),
    Number(get('month')) - 1,
    Number(get('day')),
    hour,
    minute,
    0,
  )
  if (add === 0 && wall <= wallNow) add = 7
  wall += add * 86_400_000
  return new Date(wall - tzOffsetMs(wall, timezone)).toISOString()
}

/** Date-only inputs become 9am in the user's timezone so "Thursday" stays Thursday. */
export function parseFlexibleWhen(raw: string | undefined, timezone: string): string | null {
  const s = String(raw || '').trim()
  if (!s) return null
  const day = s.match(/^(\d{4}-\d{2}-\d{2})$/)
  if (day) {
    const [y, m, d] = day[1]!.split('-').map(Number)
    const wall = Date.UTC(y || 1970, (m || 1) - 1, d || 1, 9, 0, 0)
    return new Date(wall - tzOffsetMs(wall, timezone || 'America/Los_Angeles')).toISOString()
  }
  const at = new Date(s)
  if (Number.isNaN(at.getTime())) return null
  return at.toISOString()
}

/** Same wall-clock (in the user's zone) one day/week later, as a UTC ISO string. */
export function nextReminderAt(utcIso: string, recurrence: string, timezone: string): string {
  const tz = timezone || 'America/Los_Angeles'
  const dtf = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  })
  const at = new Date(utcIso)
  const parts = dtf.formatToParts(at)
  const get = (t: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === t)?.value || ''
  const wall = Date.UTC(
    Number(get('year')),
    Number(get('month')) - 1,
    Number(get('day')),
    Number(get('hour')),
    Number(get('minute')),
    Number(get('second')),
  )
  // Weekday recurrence: step a day at a time until the wall date is Mon-Fri
  // (getUTCDay on the reconstructed wall clock gives the local weekday).
  if (recurrence === 'weekdays') {
    let next = wall + 86_400_000
    while (next > wall) {
      const dow = new Date(next).getUTCDay()
      if (dow >= 1 && dow <= 5) break
      next += 86_400_000
    }
    return new Date(next - tzOffsetMs(next, tz)).toISOString()
  }
  const nextWall = wall + (recurrence === 'weekly' ? 7 : 1) * 86_400_000
  return new Date(nextWall - tzOffsetMs(nextWall, tz)).toISOString()
}

export function shiftDateStr(dateStr: string, days: number): string {
  const [y, m, d] = dateStr.split('-').map(Number)
  return new Date(Date.UTC(y || 1970, (m || 1) - 1, (d || 1) + days)).toISOString().slice(0, 10)
}

export function ymdOf(value: unknown): string {
  if (!value) return ''
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value.toISOString().slice(0, 10)
  const m = String(value).match(/(\d{4}-\d{2}-\d{2})/)
  return m?.[1] || ''
}

export function mondayOfDateStr(dateStr: string): string {
  const [y, m, d] = dateStr.split('-').map(Number)
  const day = new Date(Date.UTC(y || 1970, (m || 1) - 1, d || 1)).getUTCDay()
  const diff = day === 0 ? 6 : day - 1
  return shiftDateStr(dateStr, -diff)
}

export function weekDaysFromMonday(weekStart: string): string[] {
  return Array.from({ length: 7 }, (_, i) => shiftDateStr(weekStart, i))
}

export function userMonday(user: { timezone?: string | null }, d = new Date()): string {
  return mondayOfDateStr(localDateStrInTz(d, user.timezone))
}


