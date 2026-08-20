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
    /\b(?:i(?:'?m| am) (?:in|on)|now in|currently in|landed in|flying to|switching to|moved to|timezone(?: is)?|time zone(?: is)?)\s+([A-Za-z/_+\-]+(?:\s+[A-Za-z]+){0,2})\b/i,
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
