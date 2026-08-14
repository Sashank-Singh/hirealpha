import { gmiChat } from './gmi'

export type ReminderIntent =
  | { action: 'set'; text: string; localTime: string; recurrence: 'once' | 'daily' | 'weekly' }
  | { action: 'list' }
  | { action: 'cancel' }
  | { action: 'none' }

export interface DueReminder {
  id: string
  userId: string
  phone: string
  text: string
  scheduledAt: string
  recurrence: string
  timezone: string | null
}

/** Cheap pre-gate so we only pay an LLM call when the message smells like a reminder. */
export function looksLikeReminder(text: string): boolean {
  return /\b(remind(?:er)? me|set (?:a |an )?reminder|nudge me|ping me|reminders?|cancel (?:the )?reminder)\b/i.test(
    text,
  )
}

function isLocalTime(s: string): boolean {
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/.test(s)
}

function parseRecurrence(v: unknown): 'once' | 'daily' | 'weekly' {
  return v === 'daily' || v === 'weekly' ? v : 'once'
}

/**
 * Deterministic parser for common relative/absolute times, so short requests
 * like "remind me in 2 mins" work even if the LLM is slow or non-compliant.
 * Returns a localTime ("YYYY-MM-DDTHH:MM:SS") or null.
 */
export function parseRelativeLocalTime(
  userText: string,
  timezone: string,
  nowLocal: string,
): string | null {
  const now = new Date(`${nowLocal}Z`).getTime()
  if (Number.isNaN(now)) return null
  const m = userText.match(/\bin\s+(\d+)\s*(min|minute|mins|minutes|hr|hrs|hour|hours|sec|secs|second|seconds|day|days)\b/i)
  if (m && m[2]) {
    const n = Number(m[1])
    const unit = m[2].toLowerCase()
    let ms = 0
    if (unit.startsWith('min')) ms = n * 60_000
    else if (unit.startsWith('hr')) ms = n * 3_600_000
    else if (unit.startsWith('sec')) ms = n * 1000
    else if (unit.startsWith('day')) ms = n * 86_400_000
    if (ms > 0) return new Date(now + ms).toISOString().slice(0, 19).replace('T', 'T')
  }
  const tm = userText.match(/\b(?:tomorrow|tmrw)\s+at\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\b/i)
  if (tm) {
    let h = Number(tm[1])
    const min = Number(tm[2] || '0')
    const ap = (tm[3] || '').toLowerCase()
    if (ap === 'pm' && h < 12) h += 12
    if (ap === 'am' && h === 12) h = 0
    const d = new Date(now + 86_400_000)
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}T${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}:00`
  }
  const am = userText.match(/\b(?:at|around)\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/i)
  if (am) {
    let h = Number(am[1])
    const min = Number(am[2] || '0')
    const ap = (am[3] || '').toLowerCase()
    if (ap === 'pm' && h < 12) h += 12
    if (ap === 'am' && h === 12) h = 0
    const d = new Date(now)
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}T${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}:00`
  }
  return null
}

/** Pull a JSON object out of a model reply that may be wrapped in prose/fences. */
function extractJson(raw: string): Record<string, unknown> | null {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/)
  const candidate = (fenced?.[1] || raw).trim()
  if (!candidate) return null
  try {
    return JSON.parse(candidate) as Record<string, unknown>
  } catch {
    /* fall through */
  }
  const first = candidate.indexOf('{')
  const last = candidate.lastIndexOf('}')
  if (first !== -1 && last > first) {
    try {
      return JSON.parse(candidate.slice(first, last + 1)) as Record<string, unknown>
    } catch {
      return null
    }
  }
  return null
}

/**
 * Ask the model to turn a message like "remind me tomorrow 9am to call the
 * dentist" into a structured intent with an absolute local wall-clock time.
 * Returns action 'none' if the model decides it isn't a reminder request.
 */
export async function parseReminderIntent(
  userText: string,
  timezone: string | null,
): Promise<ReminderIntent> {
  const tz = timezone || 'America/Los_Angeles'
  const nowLocal = formatLocalNow(tz)
  const fallback = parseRelativeLocalTime(userText, tz, nowLocal)
  try {
    const raw = await gmiChat({
      temperature: 0,
      maxTokens: 160,
      messages: [
        {
          role: 'system',
          content: [
            'You convert iMessage reminder requests into strict JSON. The user is in IANA timezone "' +
              tz +
              '" and the current local time is ' +
              nowLocal +
              '.',
            'Reply with ONLY a single JSON object, no prose, no markdown fences. Shape:',
            '{"action":"set"|"list"|"cancel"|"none","text":"reminder text",',
            '"localTime":"YYYY-MM-DDTHH:MM:SS" or "","recurrence":"once"|"daily"|"weekly"}',
            'Rules:',
            '- "remind me to X" / "set a reminder for X" / "remind me in 2 mins" -> action set. text is X (or the whole request if no X given).',
            '- Resolve relative time ("tomorrow 9am", "in 2 hours", "every weekday 8am") to an absolute localTime for the NEXT occurrence.',
            '- If it repeats every day -> recurrence daily. Every week / specific weekday -> weekly. Otherwise once.',
            '- "what reminders" / "my reminders" -> action list.',
            '- "cancel/remove the reminder" -> action cancel.',
            '- Anything else -> action none.',
          ].join('\n'),
        },
        { role: 'user', content: userText },
      ],
    })
    const parsed = extractJson(raw)
    if (!parsed) {
      if (fallback) {
        return {
          action: 'set',
          text: userText.replace(/\bremind me\b/i, '').trim() || 'Reminder',
          localTime: fallback,
          recurrence: 'once',
        }
      }
      return { action: 'none' }
    }
    const action = typeof parsed.action === 'string' ? parsed.action : 'none'
    if (action === 'set') {
      const localTime =
        typeof parsed.localTime === 'string' && isLocalTime(parsed.localTime)
          ? parsed.localTime
          : fallback
      if (!localTime) return { action: 'none' }
      return {
        action: 'set',
        text: String(parsed.text || '').trim() || userText.replace(/\bremind me\b/i, '').trim() || 'Reminder',
        localTime,
        recurrence: parseRecurrence(parsed.recurrence),
      }
    }
    if (action === 'list') return { action: 'list' }
    if (action === 'cancel') return { action: 'cancel' }
    return { action: 'none' }
  } catch {
    if (fallback) {
      return {
        action: 'set',
        text: userText.replace(/\bremind me\b/i, '').trim() || 'Reminder',
        localTime: fallback,
        recurrence: 'once',
      }
    }
    return { action: 'none' }
  }
}

/** Current local wall-clock (no offset) for the given IANA zone. */
export function formatLocalNow(timezone: string): string {
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
  const get = (t: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === t)?.value || ''
  return `${get('year')}-${get('month')}-${get('day')}T${get('hour')}:${get('minute')}:${get('second')}`
}

/** UTC offset in ms for an IANA zone at a given instant. */
function tzOffsetMs(utcMs: number, timezone: string): number {
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

/** Parse "YYYY-MM-DDTHH:MM:SS" as pure wall-clock components (no timezone). */
function parseWallClock(localTime: string): Date {
  const m = localTime.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})$/)
  if (!m) return new Date(NaN)
  return new Date(
    Date.UTC(
      Number(m[1]),
      Number(m[2]) - 1,
      Number(m[3]),
      Number(m[4]),
      Number(m[5]),
      Number(m[6]),
    ),
  )
}

/** Convert local wall-clock "YYYY-MM-DDTHH:MM:SS" in a zone to a UTC ISO string. */
export function localTimeToUtc(localTime: string, timezone: string): string {
  const naive = parseWallClock(localTime).getTime()
  if (Number.isNaN(naive)) return ''
  const offset = tzOffsetMs(naive, timezone)
  return new Date(naive - offset).toISOString()
}

/** Compute the next recurrence time in the user's zone. */
export function nextRecurrence(prevUtc: string, recurrence: 'daily' | 'weekly', timezone: string): string {
  const local = formatLocalAt(prevUtc, timezone)
  const wall = parseWallClock(local)
  wall.setUTCDate(wall.getUTCDate() + (recurrence === 'daily' ? 1 : 7))
  const p = (n: number) => String(n).padStart(2, '0')
  const nextLocal = `${wall.getUTCFullYear()}-${p(wall.getUTCMonth() + 1)}-${p(wall.getUTCDate())}T${p(wall.getUTCHours())}:${p(wall.getUTCMinutes())}:${p(wall.getUTCSeconds())}`
  return localTimeToUtc(nextLocal, timezone)
}

function formatLocalAt(utc: string, timezone: string): string {
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
  const parts = dtf.formatToParts(new Date(utc))
  const get = (t: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === t)?.value || ''
  return `${get('year')}-${get('month')}-${get('day')}T${get('hour')}:${get('minute')}:${get('second')}`
}

function apiBase() {
  return (process.env.HIREALPHA_API_URL || '').replace(/\/$/, '')
}

function authHeaders() {
  return {
    Authorization: `Bearer ${process.env.HIREALPHA_INTERNAL_KEY || ''}`,
    Accept: 'application/json',
    'Content-Type': 'application/json',
  }
}

export async function createReminder(input: {
  phone: string
  persona: string
  text: string
  scheduledAt: string
  recurrence: string
  timezone: string
}): Promise<boolean> {
  const base = apiBase()
  if (!base) return false
  try {
    const res = await fetch(`${base}/api/internal/reminders`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify(input),
    })
    return res.ok
  } catch {
    return false
  }
}

export async function listReminders(phone: string, persona: string): Promise<Array<{ text: string; scheduledAt: string; recurrence: string; status: string }>> {
  const base = apiBase()
  if (!base) return []
  try {
    const res = await fetch(
      `${base}/api/internal/reminders/list?phone=${encodeURIComponent(phone)}&persona=${encodeURIComponent(persona)}`,
      { headers: authHeaders() },
    )
    if (!res.ok) return []
    const data = (await res.json()) as { reminders?: Array<{ text: string; scheduledAt: string; recurrence: string; status: string }> }
    return data.reminders || []
  } catch {
    return []
  }
}

export async function fetchDueReminders(persona: string): Promise<DueReminder[]> {
  const base = apiBase()
  if (!base) return []
  try {
    const res = await fetch(
      `${base}/api/internal/reminders/due?persona=${encodeURIComponent(persona)}`,
      { headers: authHeaders() },
    )
    if (!res.ok) return []
    const data = (await res.json()) as { reminders?: DueReminder[] }
    return data.reminders || []
  } catch {
    return []
  }
}

export async function markReminderDone(id: string, nextAt?: string): Promise<boolean> {
  const base = apiBase()
  if (!base) return false
  try {
    const res = await fetch(`${base}/api/internal/reminders/${encodeURIComponent(id)}/done`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify(nextAt ? { nextAt } : {}),
    })
    return res.ok
  } catch {
    return false
  }
}

export async function deleteReminder(id: string): Promise<boolean> {
  const base = apiBase()
  if (!base) return false
  try {
    const res = await fetch(`${base}/api/internal/reminders?id=${encodeURIComponent(id)}`, {
      method: 'DELETE',
      headers: authHeaders(),
    })
    return res.ok
  } catch {
    return false
  }
}

/**
 * Poll for due reminders and send them. Run inside the bot process via
 * setInterval. `send` is provided by the bot's imessage space.
 */
export function startReminderScheduler(opts: {
  persona: string
  pollMs?: number
  send: (phone: string, text: string) => Promise<void>
}) {
  const pollMs = opts.pollMs ?? 30_000
  const timer = setInterval(async () => {
    try {
      const due = await fetchDueReminders(opts.persona)
      for (const r of due) {
        await opts.send(r.phone, r.text)
        const tz = r.timezone || 'America/Los_Angeles'
        const nextAt =
          r.recurrence === 'daily' || r.recurrence === 'weekly'
            ? nextRecurrence(r.scheduledAt, r.recurrence, tz)
            : undefined
        await markReminderDone(r.id, nextAt)
      }
    } catch (err) {
      console.warn(`[reminders:${opts.persona}] scheduler error`, err)
    }
  }, pollMs)
  timer.unref?.()
  console.log(`[reminders:${opts.persona}] scheduler started every ${pollMs / 1000}s`)
}
