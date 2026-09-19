import { gmiChat } from './gmi'
import { PROACTIVE_POLL_MS, SEND_FAILURE_BACKOFF_MS } from './delivery'
import { buildDigestBriefing, mintMiniAppCard, type MiniAppCard } from './miniApps'
import { ackEventNudge, fetchDueEventNudges, revertEventNudge } from './eventNudges'
import {
  fetchJudgmentState,
  freezeProactiveUntilReply,
  isJudgeTick,
  isRecipientSendBlocked,
  recordProactiveSent,
  runJudgmentLoop,
} from './judgment'
import type { AgentId } from '../../src/agents/types'
import { killSwitchBlocksSend } from './taskLoops'

/** A reminder text that carries the scheduled morning or evening brief: the
 * "[digest]…" markers created when a user picks a brief time, plus the
 * "[judge]morning" / "[judge]evening" ticks that are the default brief time
 * (8am / 9pm). The brief is an expected daily touch, not a discretionary
 * "should I bother" judgment, so these ticks bypass the judgment decline
 * gate entirely. */
export function isBriefTick(text: string): boolean {
  return /^\[digest\]/.test(text) || /^\[judge\]\s*(morning|evening)\b/i.test(text)
}

export type ReminderIntent =
  | { action: 'set'; text: string; localTime: string; recurrence: 'once' | 'daily' | 'weekly' | 'weekdays' }
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

function parseRecurrence(v: unknown): 'once' | 'daily' | 'weekly' | 'weekdays' {
  return v === 'daily' || v === 'weekly' || v === 'weekdays' ? v : 'once'
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
            '"localTime":"YYYY-MM-DDTHH:MM:SS" or "","recurrence":"once"|"daily"|"weekly"|"weekdays"}',
            'Rules:',
            '- "remind me to X" / "set a reminder for X" / "remind me in 2 mins" -> action set. text is X (or the whole request if no X given).',
            '- Resolve relative time ("tomorrow 9am", "in 2 hours", "every weekday 8am") to an absolute localTime for the NEXT occurrence.',
            '- If it repeats every day -> recurrence daily. Monday-Friday / weekdays only -> weekdays. Every week / a specific weekday -> weekly. Otherwise once.',
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

/* ---- Morning digest control (dimension 7) ----
 * The chat path used to refuse weekday briefs ("reminders can only nudge with
 * static text") and had no way to pause or move a digest. The digest is a real
 * [digest] reminder row, so setting/pausing/editing it is reminder management,
 * not a new capability; the parser below is deterministic so the bench ask
 * never depends on the model. */

export type DigestControl =
  | { action: 'set'; time?: string; recurrence: 'daily' | 'weekdays'; label: string }
  | { action: 'pause' }
  | { action: 'resume' }

/** Does the text talk about the morning digest/brief at all? Used to stop
 * digest questions ("when is my brief") from falling into the reminder LLM.
 *
 * The verb shapes matter as much as the noun: "send me a digest with my
 * calendar" is the bench phrasing and the old patterns ("morning digest",
 * "my digest", "digest is") all missed it, so the ask fell through to the
 * model and three runs of the same sentence produced three outcomes — a real
 * row, a narrated "scheduler is rejecting it", and the freshness gate's
 * canned "web lookup did not run". */
export function mentionsDigest(text: string): boolean {
  return /\b(?:morning|daily|weekday)\s+(?:brief|digest|recap)\b|\bmy\s+(?:morning\s+|daily\s+|weekday\s+)?(?:brief|digest|recap)\b|\b(?:brief|digest|recap)\s+(?:is|was|comes?|with|that|each|every|at)\b|\b(?:set ?up|setup|schedule|create|make|start|send(?: me)?|give me|put together)\b[^.!?]{0,40}?\b(?:a\s+|the\s+)?(?:morning\s+|daily\s+|weekday\s+)?(?:brief|digest|recap)\b/i.test(
    String(text || ''),
  )
}

/** "7", "7:30", "07:15" + am/pm → canonical "HH:MM"; null when absent. */
export function clockFromText(text: string): string | null {
  const m = String(text || '').match(/\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/i) || String(text || '').match(/\b(\d{1,2}):(\d{2})\b/)
  if (!m) return null
  let h = Number(m[1])
  const min = Number(m[2] || '0')
  const ap = (m[3] || '').toLowerCase()
  if (!Number.isFinite(h) || !Number.isFinite(min) || h > 23 || min > 59) return null
  if (ap === 'pm' && h < 12) h += 12
  if (ap === 'am' && h === 12) h = 0
  return `${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}`
}

/** A digest ask the bot can act on, or null when the text is a question or
 * some other request. Deliberately conservative: it must name the digest and
 * carry a scheduling verb (or an explicit clock for the set case). */
export function digestControlIntent(text: string): DigestControl | null {
  const t = String(text || '').trim()
  if (!t || !mentionsDigest(t)) return null
  if (/\b(?:pause|stop|turn (?:it )?off|hold|disable|cancel)\b/i.test(t)) return { action: 'pause' }
  if (/\b(?:resume|unpause|re-?enable|restart|start (?:it )?again)\b/i.test(t) || /\bturn\b.{0,24}\bback on\b/i.test(t)) {
    return { action: 'resume' }
  }
  const schedulingVerb = /\b(?:set(?: me)? up|setup|schedule|create|make|start|change|move|edit|update|switch|push)\b/i.test(t)
  const explicitClock = /\b\d{1,2}(?::\d{2})?\s*(?:am|pm)\b/i.test(t)
  if (!schedulingVerb && !explicitClock) return null
  const recurrence = /\b(?:weekdays?|monday\s*(?:-|to|through|–)\s*friday|mon\s*-\s*fri|work(?:ing)?\s*days)\b/i.test(t)
    ? 'weekdays'
    : 'daily'
  const time = clockFromText(t) || undefined
  return { action: 'set', ...(time ? { time } : {}), recurrence, label: recurrence === 'weekdays' ? 'Weekday morning digest' : 'Morning digest' }
}

export type DigestManageResult = {
  ok: boolean
  action?: string
  note?: string
  digest?: Array<{ text?: string; scheduledAt?: string; recurrence?: string; status?: string }>
}

/** Set/pause/resume the [digest] reminder through the internal route. */
/** Said when the brief build came back with nothing. "Your brief is ready"
 * over an empty message promises content that does not exist; the card is still
 * minted so tapping rebuilds it. */
export function briefBuildFailedLine(morning: boolean): string {
  return morning
    ? "I couldn't pull your brief this morning. Tap the card and I'll try again."
    : "I couldn't pull your evening wrap. Tap the card and I'll try again."
}

export async function manageDigest(
  phone: string,
  persona: string,
  control: DigestControl,
): Promise<DigestManageResult | null> {
  const base = apiBase()
  if (!base) return null
  try {
    const res = await fetch(`${base}/api/internal/digest/manage`, {
      signal: AbortSignal.timeout(10000),
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({
        phone,
        persona,
        action: control.action,
        ...(control.action === 'set' ? { time: control.time, recurrence: control.recurrence, label: control.label } : {}),
      }),
    })
    if (!res.ok) return null
    return (await res.json()) as DigestManageResult
  } catch {
    return null
  }
}

/** Human line for a digest manage result, so the reply states the real state. */
export function digestManageReply(control: DigestControl, result: DigestManageResult, timezone: string): string {
  if (control.action === 'pause') {
    return result.note ? "There wasn't a digest running, so nothing to pause. Say set up my morning digest and I will arm one." : "Paused the morning digest. Say resume my digest whenever you want it back."
  }
  if (control.action === 'resume') {
    const at = result.digest?.[0]?.scheduledAt
    const when = at ? digestWhenLabel(at, timezone) : 'the next morning'
    return `Back on. Next digest ${when}.`
  }
  const row = result.digest?.[0]
  const cadence = row?.recurrence === 'weekdays' ? 'Weekdays' : 'Daily'
  const time = row?.scheduledAt ? digestClockLabel(row.scheduledAt, timezone) : control.time || '8:00'
  const next = row?.scheduledAt ? digestWhenLabel(row.scheduledAt, timezone) : ''
  return `Set. ${cadence} at ${time} (${timezone}): your calendar, emails still owed a reply, and the weather. Pause or move it any time${next ? `. Next one: ${next}` : ''}.`
}

function digestClockLabel(iso: string, timezone: string): string {
  try {
    return new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      hour: 'numeric',
      minute: '2-digit',
      hour12: true,
    }).format(new Date(iso))
  } catch {
    return ''
  }
}

function digestWhenLabel(iso: string, timezone: string): string {
  try {
    return new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      weekday: 'short',
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      hour12: true,
    }).format(new Date(iso))
  } catch {
    return ''
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
export function nextRecurrence(prevUtc: string, recurrence: 'daily' | 'weekly' | 'weekdays', timezone: string): string {
  const local = formatLocalAt(prevUtc, timezone)
  const wall = parseWallClock(local)
  if (recurrence === 'weekdays') {
    wall.setUTCDate(wall.getUTCDate() + 1)
    while (wall.getUTCDay() === 0 || wall.getUTCDay() === 6) wall.setUTCDate(wall.getUTCDate() + 1)
  } else {
    wall.setUTCDate(wall.getUTCDate() + (recurrence === 'daily' ? 1 : 7))
  }
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
      signal: AbortSignal.timeout(10000),
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify(input),
    })
    return res.ok
  } catch {
    return false
  }
}

/** Arm a real recurring page watch. The loop already exists server-side
 * (`browser_watch`: re-visits one page on an interval until the goal's
 * condition is met, retires after 28 checks, reports through the run it
 * enqueues) — what was missing was a way for a turn to create one, so an
 * explicit "watch the price for me" could only be answered with a promise. The
 * reminder capability's own description forbids standing in for a watch, which
 * left the ask with no path at all: live, 2026-09-19, "watch the sonos era 100
 * price for me and text me if it drops under 180" was answered "I can't watch
 * the price continuously in the background … want me to set that up?" while
 * the same ask answered by hand committed to an hourly check. */
export async function createWatch(input: {
  phone: string
  persona: string
  url: string
  goal: string
  title?: string
  intervalHours?: number
}): Promise<{ ok: boolean; intervalHours?: number }> {
  const base = apiBase()
  if (!base) return { ok: false }
  try {
    const res = await fetch(`${base}/api/internal/loops/watch`, {
      signal: AbortSignal.timeout(10000),
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify(input),
    })
    if (!res.ok) return { ok: false }
    const data = (await res.json().catch(() => ({}))) as { ok?: boolean; intervalHours?: number }
    return data.ok ? { ok: true, ...(data.intervalHours ? { intervalHours: data.intervalHours } : {}) } : { ok: false }
  } catch {
    return { ok: false }
  }
}

export async function listReminders(phone: string, persona: string): Promise<Array<{ text: string; scheduledAt: string; recurrence: string; status: string }>> {  const base = apiBase()
  if (!base) return []
  try {
    const res = await fetch(
      `${base}/api/internal/reminders/list?phone=${encodeURIComponent(phone)}&persona=${encodeURIComponent(persona)}`,
      { headers: authHeaders(), signal: AbortSignal.timeout(10000) },
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

export async function markReminderDone(
  id: string,
  nextAt?: string,
  revert = false,
): Promise<{ claimed: boolean; rescheduled?: boolean }> {
  const base = apiBase()
  if (!base) return { claimed: false }
  try {
    const res = await fetch(`${base}/api/internal/reminders/${encodeURIComponent(id)}/done`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify(nextAt ? { nextAt, revert } : { revert }),
    })
    if (!res.ok) return { claimed: false }
    const data = (await res.json()) as { claimed?: boolean; rescheduled?: boolean }
    return { claimed: data.claimed !== false, rescheduled: data.rescheduled === true }
  } catch {
    return { claimed: false }
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
  send: (phone: string, text: string, card?: MiniAppCard) => Promise<void>
}) {
  const pollMs = opts.pollMs ?? PROACTIVE_POLL_MS
  // A failed nudge reverts to due instantly, and the 30s poll re-fired the same
  // Photon SetTyping rejection every cycle all night (dinner check-in, 09-15).
  // Back each failing key off for ten minutes so one dead RPC degrades to two
  // honest retries an hour instead of ~1200.
  const nudgeBackoff = new Map<string, number>()
  const NUDGE_BACKOFF_MS = SEND_FAILURE_BACKOFF_MS
  // A reminder whose send failed for a reason that is not a blocked recipient
  // reverts to due, so a fast poll would retry it every cycle. Same backoff
  // idea as the nudges above, keyed by reminder id.
  const sendBackoff = new Map<string, number>()
  const timer = setInterval(async () => {
    try {
      const nudges = await fetchDueEventNudges(opts.persona as AgentId)
      for (const n of nudges) {
        if ((nudgeBackoff.get(n.key) || 0) > Date.now()) continue
        if (await killSwitchBlocksSend(n.phone)) continue
        try {
          let card: MiniAppCard | undefined
          if (n.cardKind) {
            try {
              card = (await mintMiniAppCard(n.phone, opts.persona as AgentId, n.cardKind as any)) || undefined
            } catch {}
          }
          try {
            await opts.send(n.phone, n.text, card)
          } catch (sendErr) {
            // Photon's new-user gate rejects the whole send inside SetTyping for
            // a few seconds; respondWithRetry does the same dance for inbound
            // turns. Nudges get one 3s-delayed retry before anything reverts.
            const gateMsg = sendErr instanceof Error ? sendErr.message : String(sendErr)
            if (!/Target not allowed|SetTyping/i.test(gateMsg)) throw sendErr
            await new Promise((r) => setTimeout(r, 3000))
            await opts.send(n.phone, n.text, card)
          }
          nudgeBackoff.delete(n.key)
          await recordProactiveSent(n.phone, opts.persona as AgentId, n.topic)
          // Pushed trigger events get a hard finalizer: the inbox row was
          // claimed (marked sent) at fetch time, so ack closes the loop on a
          // successful delivery instead of trusting the claim alone.
          if (n.key.startsWith('evt:')) await ackEventNudge(n.key)
        } catch (err) {
          if (isRecipientSendBlocked(err)) {
            console.warn(`[reminders:${opts.persona}] recipient blocked ${n.phone}, freezing until reply`)
            await freezeProactiveUntilReply(n.phone, opts.persona as AgentId)
            continue
          }
          console.warn(`[reminders:${opts.persona}] nudge send failed, reverting ${n.key}`, err)
          nudgeBackoff.set(n.key, Date.now() + NUDGE_BACKOFF_MS)
          await revertEventNudge(n.phone, opts.persona as AgentId, n.key)
        }
      }

      const due = await fetchDueReminders(opts.persona)
      for (const r of due) {
        if (!r.phone) continue
        if ((sendBackoff.get(r.id) || 0) > Date.now()) continue
        // Armed kill switch skips the send and leaves the reminder due.
        if (await killSwitchBlocksSend(r.phone)) continue
        const tz = r.timezone || 'America/Los_Angeles'
        const nextAt =
          r.recurrence === 'daily' || r.recurrence === 'weekly' || r.recurrence === 'weekdays'
            ? nextRecurrence(r.scheduledAt, r.recurrence, tz)
            : undefined
        // Atomically claim before sending so overlapping poll cycles (or
        // slow sends) can never double-fire the same reminder.
        const claim = await markReminderDone(r.id, nextAt)
        if (!claim.claimed) {
          console.warn(`[reminders:${opts.persona}] skip ${r.id} — claimed by another poll`)
          continue
        }
        let text = r.text
        let card: MiniAppCard | undefined
        let judgedTopic: string | undefined
        if (isJudgeTick(r.text)) {
          if (isBriefTick(r.text)) {
            // Morning and evening briefs are an expected daily touch. Unlike a
            // poke, they are never gated on "did the person go quiet" or "did
            // we just text them". They only hold when the person is actively
            // mid conversation (texted within the last ~10 minutes) or a
            // recipient-level kill switch is armed; both re-arm the tick for
            // later instead of silently losing the day's brief.
            const briefTime = briefTimeOf(r.text)
            const inConversation = await wasRecentInbound(r.phone, opts.persona as AgentId, 10)
            if (inConversation) {
              const retryAt = new Date(Date.now() + 75 * 60_000).toISOString()
              await markReminderDone(r.id, retryAt).catch(() => undefined)
              console.log(`[reminders:${opts.persona}] brief ${r.id} mid conversation, re-armed +75min`)
              continue
            }
            try {
              const briefing = await buildDigestBriefing(r.phone, opts.persona as AgentId)
              if (briefing) {
                card = briefing.card
                const preview = briefing.preview?.trim()
                const meta = briefing.meta
                // The server stamps morning vs evening from the wall clock at
                // build time; fall back to the reminder text when absent.
                const morning =
                  meta?.brief !== undefined
                    ? meta.brief === 'morning'
                    : briefTime === 'morning'
                const sleepMissing = morning && meta?.sleepLogged === false
                if (sleepMissing) {
                  // Sleep is asked inside the card, never in the text — the
                  // text stays a plain "brief's ready" so it reads like a
                  // person, not a survey. The card's lead already prompts the
                  // sleep log (no fake hours).
                  text = morningReadyLine(true)
                } else if (morning && preview) {
                  // Real preview content rides under the warm line for the
                  // morning digest. The evening wrap is skipped: its card opens
                  // the pick_night screen, whose payload differs from the digest
                  // preview the server returned, so only the warm line rides it.
                  text = `${morningReadyLine(true)}\n\n${preview}`.slice(0, 700)
                } else {
                  text = morningReadyLine(morning)
                }
                judgedTopic = 'daily_brief'
              } else {
                const fallbackCardKind = briefTime === 'evening' ? 'pick_night' : 'digest'
                card = await mintMiniAppCard(r.phone, opts.persona as AgentId, fallbackCardKind)
                // The build returned nothing: say that, rather than "your brief
                // is ready" over an empty text. The card still lets them tap to
                // try again.
                text = briefBuildFailedLine(briefTime === 'morning')
                judgedTopic = 'daily_brief'
              }
            } catch (err) {
              console.warn(`[reminders:${opts.persona}] brief card mint failed ${r.id}`, err)
              const fallbackCardKind = briefTime === 'evening' ? 'pick_night' : 'digest'
              card = await mintMiniAppCard(r.phone, opts.persona as AgentId, fallbackCardKind)
              text = briefBuildFailedLine(briefTime === 'morning')
              judgedTopic = 'daily_brief'
            }
          } else {
            const judged = await runJudgmentLoop({
              phone: r.phone,
              persona: opts.persona as AgentId,
              reminderText: r.text,
            })
            if (!judged) {
              continue
            }
            text = judged.text
            judgedTopic = judged.topic
            if (judged.cardKind) {
              try {
                if (judged.cardKind === 'digest') {
                  const briefing = await buildDigestBriefing(r.phone, opts.persona as AgentId)
                  if (briefing) {
                    card = briefing.card
                    const preview = briefing.preview?.trim()
                    if (preview) {
                      text = `${judged.text}\n\n${preview}`.slice(0, 700)
                    }
                  } else {
                    card = await mintMiniAppCard(r.phone, opts.persona as AgentId, judged.cardKind)
                  }
                } else {
                  card = await mintMiniAppCard(r.phone, opts.persona as AgentId, judged.cardKind)
                }
              } catch (err) {
                console.warn(`[reminders:${opts.persona}] card mint failed`, err)
              }
            }
          }
        }
        try {
          await opts.send(r.phone, text, card)
          if (judgedTopic) {
            await recordProactiveSent(r.phone, opts.persona as AgentId, judgedTopic)
          }
        } catch (err) {
          if (isRecipientSendBlocked(err)) {
            console.warn(`[reminders:${opts.persona}] recipient blocked ${r.phone}, freezing until reply`)
            await freezeProactiveUntilReply(r.phone, opts.persona as AgentId)
            continue
          }
          console.warn(`[reminders:${opts.persona}] send failed for ${r.id}, reverting claim`, err)
          // Reverting makes the reminder due again at once. Without this the
          // 10s poll re-sent it every cycle: one RateLimitError became ~360
          // attempts an hour, all against the same small shared send budget.
          // Back the key off before reverting so the retry is an honest one.
          sendBackoff.set(r.id, Date.now() + SEND_FAILURE_BACKOFF_MS)
          await markReminderDone(r.id, undefined, true).catch(() => undefined)
        }
      }
    } catch (err) {
      console.warn(`[reminders:${opts.persona}] scheduler error`, err)
    }
  }, pollMs)
  timer.unref?.()
  console.log(`[reminders:${opts.persona}] scheduler started every ${pollMs / 1000}s`)
}

/** Which brief a tick text carries: "morning" for [digest]/[judge]morning,
 * "evening" for [judge]evening. Defaults to morning (most briefs are the 8am
 * digest; the standalone [digest]Daily brief seed is the morning one). */
function briefTimeOf(text: string): 'morning' | 'evening' {
  return /evening|night/i.test(text) ? 'evening' : 'morning'
}

/** True when the person last texted within `minutes`. Briefs hold only for a
 * genuine mid conversation; the judgment state fetch is the single source. */
async function wasRecentInbound(
  phone: string,
  persona: AgentId,
  minutes: number,
): Promise<boolean> {
  try {
    const state = await fetchJudgmentState(phone, persona, 'digest')
    if (!state) return false
    const m = state.lastInboundMinutesAgo
    return m != null && m < minutes
  } catch {
    return false
  }
}

/** Warm line that rides with the brief card. No system language, no dashes. */
function morningReadyLine(morning: boolean): string {
  const hour = Number(
    new Intl.DateTimeFormat('en-US', { hour: 'numeric', hour12: false }).format(new Date()),
  )
  if (morning && hour < 12) return 'Morning brief is ready. Open the card when you get a sec.'
  if (morning) return 'Your morning brief is ready. Open the card when you get a sec.'
  return 'Evening brief is ready. Open the card when you get a sec.'
}
