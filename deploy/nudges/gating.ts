import { localDateStrInTz } from '../timezones'
import { inQuietHours } from '../../spectrum/shared/judgment'

export function minutesAgo(iso: string | Date | null | undefined): number | null {
  if (!iso) return null
  const t = new Date(iso).getTime()
  if (Number.isNaN(t)) return null
  return Math.max(0, Math.round((Date.now() - t) / 60_000))
}

export function localClock(timezone: string): { localTime: string; weekday: string; today: string } {
  const formatted = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(new Date()).replace(', ', 'T')
  const weekday = new Intl.DateTimeFormat('en-US', { timeZone: timezone, weekday: 'long' }).format(new Date())
  return { localTime: formatted, weekday, today: localDateStrInTz(new Date(), timezone) }
}

export function isGenZUser(context: Record<string, string> = {}): boolean {
  const gen = String(context.generation || '').toLowerCase()
  if (gen === 'gen_z' || gen === 'genz') return true
  if (gen === 'boomer' || gen === 'gen_x' || gen === 'professional') return false
  if (context.tone === 'gen_z') return true
  if (context.tone === 'professional') return false

  const age = Number(context.age || context.user_age)
  if (age && age > 0) return age <= 28

  const byear = Number(context.birth_year || context.birthYear || context.born_in)
  if (byear && byear > 1900) return byear >= 1997

  const vibe = `${context.vibe || ''} ${context.style || ''} ${context.notes || ''}`.toLowerCase()
  if (vibe.includes('gen z') || vibe.includes('genz') || vibe.includes('slang')) return true
  return false
}

/* The 10s poll re-evaluates every candidate for every user, so a hard guard
 * that holds for hours (the Photon unanswered cap) produced one identical
 * skip line every 10s, per topic, all night — the log was the flood. Emit a
 * skip only when the reason changes or every 6h, so the guard stays auditable
 * without burying every other line. */
export const NUDGE_SKIP_LOG_INTERVAL_MS = 6 * 60 * 60 * 1000
export type NudgeSkipRecord = { reason: string; at: number }

export function shouldEmitNudgeSkip(
  prev: NudgeSkipRecord | undefined,
  reason: string,
  at: number,
  intervalMs = NUDGE_SKIP_LOG_INTERVAL_MS,
): boolean {
  if (!prev) return true
  if (prev.reason !== reason) return true
  return at - prev.at >= intervalMs
}

export const nudgeSkipLogMemo = new Map<string, NudgeSkipRecord>()

export function outboundNudgeBlock(
  context: Record<string, string>,
  lastInboundAt: Date | string | null,
  timezone: string,
  urgent: boolean,
  topic?: string,
  /** Set only by a caller that knows the item itself is imminent (e.g. a
   * flight departing within hours). Nothing else may break quiet hours. */
  imminent = false,
): string | null {
  const { today, localTime } = localClock(timezone)
  const pausedUntil = String(context.paused_until || '')
  let proactive = String(context.proactive || 'on').toLowerCase()
  if (proactive === 'paused' && pausedUntil && new Date(pausedUntil).getTime() < Date.now()) {
    proactive = 'on'
  }
  if (proactive === 'off') return 'proactive off'
  if (proactive === 'paused') return 'paused'
  // Quiet hours were stored and never checked here, so an urgent flag could
  // also text at 3 AM. Urgency buys a skip of the shared send-budget caps, not
  // of the person's night: only a genuinely imminent item passes quiet hours.
  if (!imminent && inQuietHours(localTime, context.quiet_hours)) return 'quiet hours'
  const inboundAgo = minutesAgo(lastInboundAt)
  if (inboundAgo != null && inboundAgo < 20) return 'in conversation'
  if (!urgent) {
    // The cap used to sit above the urgent branch, so a flight check-in or a
    // gate change was silently swallowed whenever two routine nudges were
    // unanswered. Time-critical items now bypass the capped budget; quiet
    // hours above still hold everything that is not provably imminent.
    const unanswered = Math.max(0, Number(context.unanswered_proactive) || 0)
    if (unanswered >= 2) return 'awaiting reply'
    const isRoutineCheckin = topic === 'meal_checkin' || topic === 'workout_checkin'
    const lastAgo = minutesAgo(context.last_proactive_at)
    const minSpacing = isRoutineCheckin ? 120 : 60
    if (lastAgo != null && lastAgo < minSpacing) return 'sent recently'
    if (!isRoutineCheckin) {
      const unansweredToday =
        String(context.last_proactive_day || '') === today ? Math.max(0, Number(context.unanswered_day_count) || 0) : 0
      if (unansweredToday >= 1) return 'already pinged today'
    }
  }
  return null
}
