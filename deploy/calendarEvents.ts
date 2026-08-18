import { formatZoneAbbrev } from './timezones'

export type CalItem = {
  start: Date
  title: string
  description: string
  allDay: boolean
  kind: string
  rawStart?: string
}

export function parseGoogleEventStart(
  start?: { dateTime?: string; date?: string } | null,
): { start: Date; allDay: boolean; rawStart: string } | null {
  if (!start) return null
  if (start.dateTime) {
    const d = new Date(start.dateTime)
    if (Number.isNaN(d.getTime())) return null
    return { start: d, allDay: false, rawStart: start.dateTime }
  }
  if (start.date) {
    const d = new Date(`${start.date}T12:00:00Z`)
    if (Number.isNaN(d.getTime())) return null
    return { start: d, allDay: true, rawStart: start.date }
  }
  return null
}

export function inferEventKind(e: {
  hangoutLink?: string
  location?: string
  description?: string
  summary?: string
  title?: string
  conferenceData?: { entryPoints?: Array<{ entryPointType?: string; uri?: string }> }
}): string {
  const loc = String(e.location || '')
  const title = String(e.summary || e.title || '')
  const desc = String(e.description || '')
  const hangout = String(e.hangoutLink || '')
  const entries = e.conferenceData?.entryPoints || []
  const blob = `${loc} ${desc} ${hangout} ${title} ${entries.map((p) => p.uri || '').join(' ')}`.toLowerCase()
  if (
    hangout ||
    /meet\.google\.com|hangouts\.google|zoom\.us|teams\.microsoft/.test(blob) ||
    entries.some((p) => p.entryPointType === 'video')
  ) {
    return 'Google Meet'
  }
  if (
    entries.some((p) => p.entryPointType === 'phone') ||
    /\+\s*\d[\d\s.()-]{3,}/.test(`${loc} ${title}`) ||
    /\b(phone|call)\b/.test(blob)
  ) {
    return 'Phone call'
  }
  if (loc.trim() && !/https?:\/\//i.test(loc) && !/meet\.google/i.test(loc)) {
    return 'In person'
  }
  return 'Meeting'
}

export function parseGoogleCalendarItems(
  items: Array<{
    summary?: string
    title?: string
    description?: string
    location?: string
    hangoutLink?: string
    start?: { dateTime?: string; date?: string }
    conferenceData?: { entryPoints?: Array<{ entryPointType?: string; uri?: string }> }
  }>,
): CalItem[] {
  const out: CalItem[] = []
  for (const e of items) {
    const parsed = parseGoogleEventStart(e.start)
    if (!parsed) continue
    out.push({
      start: parsed.start,
      allDay: parsed.allDay,
      rawStart: parsed.rawStart,
      title: String(e.summary || e.title || 'Meeting').slice(0, 120),
      description: String(e.description || '')
        .replace(/<[^>]+>/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 240),
      kind: inferEventKind(e),
    })
  }
  return out
}

export function formatClock(d: Date, timezone: string): string {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  })
    .format(d)
    .replace(/\u202f/g, ' ')
    .replace(/\u00a0/g, ' ')
}

export function formatDayLabel(d: Date, timezone: string, now = new Date()): string {
  const ymd = d.toLocaleDateString('en-CA', { timeZone: timezone })
  const today = now.toLocaleDateString('en-CA', { timeZone: timezone })
  const tomorrow = new Date(now.getTime() + 36 * 3600_000).toLocaleDateString('en-CA', { timeZone: timezone })
  if (ymd === today) return 'today'
  if (ymd === tomorrow) return 'tomorrow'
  return d.toLocaleDateString('en-US', { timeZone: timezone, weekday: 'short', month: 'short', day: 'numeric' })
}

export function formatUpcomingEvents(items: CalItem[], timezone = 'America/Los_Angeles'): string {
  if (!items.length) return 'No events on the calendar in the next 7 days.'
  const sample = items.find((e) => !e.allDay)?.start || new Date()
  const abbrev = formatZoneAbbrev(sample, timezone)
  const lines = items.map((e) => {
    const clock = e.allDay ? 'All day' : `${formatClock(e.start, timezone)} ${formatZoneAbbrev(e.start, timezone)}`
    const day = formatDayLabel(e.start, timezone)
    const when = e.allDay ? e.rawStart || e.start.toISOString().slice(0, 10) : e.rawStart || e.start.toISOString()
    return `- ${when} ${clock} ${day} local · ${e.kind} · ${e.title}`
  })
  return [
    `Upcoming events. Clocks are already local (${timezone}, ${abbrev}). Repeat the printed clock and the zone letters (PST, PDT, EST, EDT, BST, GMT, UTC). Do not convert to a different zone. Do not call these dinner, lunch, or drinks unless the title says that.`,
    ...lines,
  ].join('\n')
}

function asStart(raw: unknown): { dateTime?: string; date?: string } | null {
  if (!raw) return null
  if (typeof raw === 'string') {
    return raw.includes('T') || raw.includes(' ') ? { dateTime: raw.replace(' ', 'T') } : { date: raw }
  }
  if (typeof raw === 'object') {
    const o = raw as { dateTime?: string; date?: string; date_time?: string }
    return { dateTime: o.dateTime || o.date_time, date: o.date }
  }
  return null
}

function eventFromUnknown(raw: unknown): CalItem | null {
  if (!raw || typeof raw !== 'object') return null
  const e = raw as Record<string, unknown>
  const parsed = parseGoogleEventStart(asStart(e.start || e.start_time || e.startTime) || undefined)
  if (!parsed) return null
  const title = String(e.summary || e.title || e.name || 'Meeting').slice(0, 120)
  return {
    start: parsed.start,
    allDay: parsed.allDay,
    rawStart: parsed.rawStart,
    title,
    description: String(e.description || '').slice(0, 240),
    kind: inferEventKind({
      hangoutLink: typeof e.hangoutLink === 'string' ? e.hangoutLink : undefined,
      location: typeof e.location === 'string' ? e.location : undefined,
      description: typeof e.description === 'string' ? e.description : undefined,
      summary: title,
      conferenceData:
        e.conferenceData && typeof e.conferenceData === 'object'
          ? (e.conferenceData as { entryPoints?: Array<{ entryPointType?: string; uri?: string }> })
          : undefined,
    }),
  }
}

/** Pull events out of Composio's variously nested Google Calendar payloads. */
export function parseComposioCalendarData(data: unknown, depth = 0): CalItem[] {
  if (data == null || depth > 6) return []
  if (Array.isArray(data)) {
    const direct = data.map(eventFromUnknown).filter((x): x is CalItem => !!x)
    if (direct.length) return direct
    return data.flatMap((x) => parseComposioCalendarData(x, depth + 1))
  }
  if (typeof data !== 'object') return []
  const o = data as Record<string, unknown>
  if (Array.isArray(o.items)) return parseComposioCalendarData(o.items, depth + 1)
  if (Array.isArray(o.events)) return parseComposioCalendarData(o.events, depth + 1)
  const self = eventFromUnknown(o)
  if (self) return [self]
  return Object.values(o).flatMap((v) => parseComposioCalendarData(v, depth + 1))
}

export function hydrateCalItems(
  rows: Array<{ start: string; title: string; allDay?: boolean; kind?: string; rawStart?: string; description?: string }>,
): CalItem[] {
  return rows
    .map((r) => {
      const start = new Date(r.start)
      if (Number.isNaN(start.getTime())) return null
      return {
        start,
        title: r.title,
        allDay: !!r.allDay,
        kind: r.kind || 'Meeting',
        rawStart: r.rawStart,
        description: r.description || '',
      } satisfies CalItem
    })
    .filter((x): x is CalItem => !!x)
}

export function serializeCalItems(items: CalItem[]) {
  return items.map((e) => ({
    start: e.start.toISOString(),
    title: e.title,
    allDay: e.allDay,
    kind: e.kind,
    rawStart: e.rawStart,
    description: e.description,
  }))
}

export function parseFormattedEventLine(line: string): {
  iso: string
  clock?: string
  dayLabel?: string
  kind?: string
  title: string
} | null {
  const trimmed = line.trim().replace(/^-\s*/, '')
  const neu = trimmed.match(
    /^(\S+)\s+(All day|\d{1,2}:\d{2} [AP]M)(?:\s+(PST|PDT|EST|EDT|CST|CDT|MST|MDT|BST|GMT|UTC|GMT[+\-]?\d+))?\s+(today|tomorrow|.+?)\s+local · (.+?) · (.+)$/i,
  )
  if (neu) {
    return {
      iso: neu[1]!,
      clock: neu[2],
      dayLabel: neu[4],
      kind: neu[5]!.trim(),
      title: neu[6]!.trim(),
    }
  }
  const old = trimmed.match(/^(\S+)\s+(.*)$/)
  if (!old) return null
  return { iso: old[1]!, title: old[2]!.trim() }
}

export function googleTokenHasScope(scopes: string, need: 'gmail' | 'calendar' | 'drive'): boolean {
  return scopes.toLowerCase().includes(need)
}
