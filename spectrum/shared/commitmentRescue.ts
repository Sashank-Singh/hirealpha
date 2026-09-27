import { wallTimeToUtc } from '../../deploy/timezones'

export type CommitmentCandidate = {
  title: string
  dueAt: Date
  rescueAt: Date
  sourceText: string
}

const COMMITMENT_RE = /^\s*I\s*(?:'ll|will|am going to|plan to|promise to|committed to)\s+(.+?)\s+(?:by|before|on)\s+(.+?)(?:[.!?]|$)/i
const ACTION_RE = /^(?:send|email|share|submit|deliver|finish|complete|review|reply|follow up|call|text|pay|file|book|schedule|introduce|connect|prepare|draft|publish|ship|sign|return|upload|update)\b/i
const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday']

function localYmd(now: Date, timezone: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(now)
}

function addLocalDays(ymd: string, days: number): string {
  const [y, m, d] = ymd.split('-').map(Number)
  return new Date(Date.UTC(y!, m! - 1, d! + days)).toISOString().slice(0, 10)
}

function localWeekday(now: Date, timezone: string): number {
  const name = new Intl.DateTimeFormat('en-US', { timeZone: timezone, weekday: 'long' }).format(now).toLowerCase()
  return WEEKDAYS.indexOf(name)
}

/** Resolve deadline language without letting the host machine timezone leak in. */
export function resolveCommitmentDeadline(raw: string, timezone: string, now = new Date()): Date | null {
  const lower = raw.trim().toLowerCase().replace(/^this\s+/, '')
  let ymd = localYmd(now, timezone)
  let hour = /\b(?:tonight|eod|end of (?:the )?day)\b/.test(lower) ? 20 : 17
  let minute = 0
  const clock = lower.match(/(?:\bat\s+|\s)(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/)
  if (clock) {
    hour = Number(clock[1])
    minute = Number(clock[2] || 0)
    if (clock[3] === 'pm' && hour < 12) hour += 12
    if (clock[3] === 'am' && hour === 12) hour = 0
  }
  if (/\btomorrow\b/.test(lower)) ymd = addLocalDays(ymd, 1)
  else {
    const weekday = WEEKDAYS.findIndex((d) => new RegExp(`\\b${d}\\b`).test(lower))
    if (weekday >= 0) {
      let delta = (weekday - localWeekday(now, timezone) + 7) % 7
      if (delta === 0 && wallTimeToUtc(ymd, hour, minute, timezone) <= now) delta = 7
      ymd = addLocalDays(ymd, delta)
    } else {
      const iso = lower.match(/\b(\d{4}-\d{2}-\d{2})\b/)
      const monthDay = lower.match(/\b(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\s+(\d{1,2})(?:,?\s+(\d{4}))?\b/)
      if (iso) ymd = iso[1]!
      else if (monthDay) {
        const parsed = new Date(`${monthDay[1]} ${monthDay[2]}, ${monthDay[3] || now.getUTCFullYear()} 12:00:00Z`)
        if (Number.isNaN(parsed.getTime())) return null
        ymd = parsed.toISOString().slice(0, 10)
        if (!monthDay[3] && wallTimeToUtc(ymd, hour, minute, timezone) <= now) {
          ymd = `${now.getUTCFullYear() + 1}${ymd.slice(4)}`
        }
      }
    }
  }
  const dueAt = wallTimeToUtc(ymd, hour, minute, timezone)
  return dueAt > now ? dueAt : null
}

/** High precision by design: only explicit first-person, actionable promises with deadlines. */
export function detectCommitment(text: string, timezone: string, now = new Date()): CommitmentCandidate | null {
  const normalized = text.replace(/[\u2018\u2019]/g, "'")
  const commitment = normalized.match(COMMITMENT_RE)
  if (!commitment) return null
  const action = commitment[1]!.trim().replace(/\s+/g, ' ')
  if (!ACTION_RE.test(action) || /\b(?:maybe|might|try to|hopefully)\b/i.test(text)) return null
  const dueAt = resolveCommitmentDeadline(commitment[2]!, timezone, now)
  if (!dueAt) return null
  const title = action.charAt(0).toUpperCase() + action.slice(1)
  const leadMs = 24 * 60 * 60 * 1000
  const preferred = new Date(dueAt.getTime() - leadMs)
  const rescueAt = preferred > now ? preferred : new Date(now.getTime() + 60_000)
  return { title: title.slice(0, 200), dueAt, rescueAt, sourceText: text.trim().slice(0, 500) }
}

export function buildCommitmentRescueText(input: { title: string; dueAt?: unknown; timezone?: unknown }): string {
  const title = String(input.title || '').trim() || 'that promise'
  const due = new Date(String(input.dueAt || ''))
  const timezone = String(input.timezone || 'America/Los_Angeles')
  const when = Number.isNaN(due.getTime()) ? 'soon' : new Intl.DateTimeFormat('en-US', {
    timeZone: timezone, weekday: 'short', hour: 'numeric', minute: '2-digit',
  }).format(due)
  return `You promised to ${title.charAt(0).toLowerCase()}${title.slice(1)} by ${when}. Want me to help finish it before it slips?`
}
