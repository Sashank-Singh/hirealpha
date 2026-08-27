/** Pure helpers for proactive bot flavors. No IO here; the pollers and
 * schedulers in taskLoops/reminders decide when these run. */

/* ---- Location nudge ---- */

export const NEARBY_RADIUS_M = 1500
export const NUDGE_MIN_MINUTES = 15
export const NUDGE_MAX_MINUTES = 45
export const NUDGE_COOLDOWN_MS = 3 * 60 * 60 * 1000

/** Nudge only when close, in the actionable window, and not recently pinged. */
export function shouldNudgeNearby(
  distanceMeters: number,
  minutesToAppointment: number,
  lastNudgeAt: number | string | null,
  now: number,
): boolean {
  if (!Number.isFinite(distanceMeters) || distanceMeters > NEARBY_RADIUS_M) return false
  if (!Number.isFinite(minutesToAppointment)) return false
  if (minutesToAppointment < NUDGE_MIN_MINUTES || minutesToAppointment > NUDGE_MAX_MINUTES) return false
  const last = lastNudgeAt == null ? NaN : new Date(lastNudgeAt).getTime()
  if (Number.isFinite(last) && now - last < NUDGE_COOLDOWN_MS) return false
  return true
}

/* ---- Reservation cancel watch ---- */

const CANCELLABLE_TITLE =
  /\b(reservations?|hotels?|stays?|bookings?|booked|classes|class)\b/i
const CANCEL_WINDOW_HOURS = 24
export const CANCEL_WARN_BEFORE_HOURS = 3

/** Cancellation deadlines only exist for things that can be cancelled. */
export function detectCancellationDeadline(
  eventTitle: string,
  eventStart: number | string | Date,
): { deadline: string; warnBeforeHours: number } | null {
  if (!CANCELLABLE_TITLE.test(eventTitle || '')) return null
  const start = new Date(eventStart as unknown as string | number | Date).getTime()
  if (!Number.isFinite(start)) return null
  const deadline = new Date(start - CANCEL_WINDOW_HOURS * 60 * 60 * 1000)
  return { deadline: deadline.toISOString(), warnBeforeHours: CANCEL_WARN_BEFORE_HOURS }
}

/* ---- Approval fence ---- */

const GATED_ACTIONS = new Set(['send_email', 'purchase', 'booking', 'cancel', 'password_change'])

const GATED_VERBS: Record<string, string> = {
  send_email: 'send that email',
  purchase: 'make that purchase',
  booking: 'make that booking',
  cancel: 'make that cancellation',
  password_change: 'change that password',
}

export function needsApproval(action: string): boolean {
  return GATED_ACTIONS.has(String(action || '').toLowerCase())
}

export function buildApprovalText(action: string, detail?: string): string {
  const verb = GATED_VERBS[String(action || '').toLowerCase()] || 'do that'
  const tail = detail ? ` ${detail}` : ''
  return `Quick check before I ${verb}${tail}. Reply yes and I will do it.`
}

/* ---- Cross hire delegation ---- */

export type HandoffTarget = 'coworker' | 'cofounder' | 'friend'

export function handoffIntent(text: string): HandoffTarget | null {
  const m = String(text || '').match(/(ask|have) (my )?(coworker|cofounder|friend)/i)
  return m && m[3] ? (m[3].toLowerCase() as HandoffTarget) : null
}

export interface HandoffPayload {
  fromPersona: string
  toPersona: HandoffTarget
  phone?: string
  note: string
}

export function buildHandoff(from: string, to: HandoffTarget, note: string): HandoffPayload {
  return { fromPersona: from, toPersona: to, note }
}

function apiBase() {
  return (process.env.HIREALPHA_API_URL || '').replace(/\/$/, '')
}

/** Post the delegation to the server. Missing env or any failure is a no-op. */
export async function postHandoff(payload: HandoffPayload): Promise<boolean> {
  const base = apiBase()
  if (!base || !process.env.HIREALPHA_INTERNAL_KEY) return false
  try {
    const res = await fetch(`${base}/api/internal/handoff`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.HIREALPHA_INTERNAL_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    })
    return res.ok
  } catch {
    return false
  }
}

/* ---- Abandoned thread revival ---- */

export interface RevivalThread {
  id: string
  /** True when the last message was ours and still unanswered. */
  awaitingUserReply: boolean
  lastActivityAt: number | string
}

export function findStaleThreads(
  threads: RevivalThread[],
  now: number,
  minHours = 48,
): RevivalThread[] {
  const cutoff = minHours * 60 * 60 * 1000
  return threads
    .filter((t) => {
      if (!t.awaitingUserReply) return false
      const at = new Date(t.lastActivityAt).getTime()
      return Number.isFinite(at) && now - at >= cutoff
    })
    .sort((a, b) => new Date(a.lastActivityAt).getTime() - new Date(b.lastActivityAt).getTime())
    .slice(0, 3)
}

/* ---- Memory resurfacing ---- */

export interface ResurfaceMemory {
  key: string
  value: string
  lastSeen: number
}

export const RESURFACE_AGE_MS = 21 * 24 * 60 * 60 * 1000

/** One stale memory at a time, oldest first, with a one line question. */
export function pickMemoryResurface(
  memories: ResurfaceMemory[],
  now: number,
): { memory: ResurfaceMemory; question: string } | null {
  const stale = memories
    .filter((m) => Number.isFinite(m.lastSeen) && now - m.lastSeen >= RESURFACE_AGE_MS)
    .sort((a, b) => a.lastSeen - b.lastSeen)
  const memory = stale[0]
  if (!memory) return null
  const value = String(memory.value || '').trim()
  return { memory, question: `Came across an old note, ${value}. Still a thing?` }
}

/* ---- Progress narration ---- */

export function formatProgressText(task: string, stepPct: number, nextStep: string): string {
  const pct = Math.max(0, Math.min(100, Math.round(Number.isFinite(stepPct) ? stepPct : 0)))
  return `${String(task || 'Task').trim()} is ${pct}% done, next up ${String(nextStep || 'the next step').trim()}`
}
