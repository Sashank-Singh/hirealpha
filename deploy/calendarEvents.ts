/** Google Calendar event start: timed (`dateTime`) or all-day (`date`). */

export type CalItem = { start: Date; title: string; description: string; allDay: boolean }

export function parseGoogleEventStart(
  start?: { dateTime?: string; date?: string } | null,
): { start: Date; allDay: boolean } | null {
  if (!start) return null
  if (start.dateTime) {
    const d = new Date(start.dateTime)
    if (Number.isNaN(d.getTime())) return null
    return { start: d, allDay: false }
  }
  if (start.date) {
    const d = new Date(`${start.date}T12:00:00Z`)
    if (Number.isNaN(d.getTime())) return null
    return { start: d, allDay: true }
  }
  return null
}

export function parseGoogleCalendarItems(
  items: Array<{
    summary?: string
    title?: string
    description?: string
    start?: { dateTime?: string; date?: string }
  }>,
): CalItem[] {
  const out: CalItem[] = []
  for (const e of items) {
    const parsed = parseGoogleEventStart(e.start)
    if (!parsed) continue
    out.push({
      start: parsed.start,
      allDay: parsed.allDay,
      title: String(e.summary || e.title || 'Meeting').slice(0, 120),
      description: String(e.description || '')
        .replace(/<[^>]+>/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 240),
    })
  }
  return out
}

export function formatUpcomingEvents(items: CalItem[]): string {
  if (!items.length) return 'No events on the calendar in the next 7 days.'
  return `Upcoming events:\n${items
    .map((e) => {
      const when = e.allDay ? e.start.toISOString().slice(0, 10) : e.start.toISOString()
      return `- ${when} ${e.title}`
    })
    .join('\n')}`
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
    title,
    description: String(e.description || '').slice(0, 240),
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

export function googleTokenHasScope(scopes: string, need: 'gmail' | 'calendar' | 'drive'): boolean {
  return scopes.toLowerCase().includes(need)
}
