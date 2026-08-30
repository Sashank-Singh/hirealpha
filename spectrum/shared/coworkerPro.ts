import { canFireDaily, captureFromChat, dayKey, defaultCapturePost } from './cofounderPro'
import type { CapturePost, CofounderDigest } from './cofounderPro'
import { killSwitchBlocksSend } from './taskLoops'

/**
 * Alpha (Coworker) proactive capture and daily digest.
 * Same contract as cofounderPro: pure precision first detectors (a false
 * positive logs junk into the user's pipeline, a miss only costs one manual
 * log), graceful no-op clients, at most one proactive text per day.
 */

export { canFireDaily, captureFromChat, defaultCapturePost } from './cofounderPro'
export type { CapturePost, CofounderDigest } from './cofounderPro'

/* ---- Pure detectors ---- */

/** Email ask: an explicit email-ish verb (email, draft, reply, follow up) plus
 * a capitalized name. "text Jordan" and "emailing Priya" never count, and a
 * bare noun "the draft to Priya" is not an ask, so articles are blocked. */
const EMAIL_ASK_RES: RegExp[] = [
  /(?<!\b(?:the|a|an|my|your) )(?:e-?mail|draft (?:a )?(?:reply|note|follow ?up)? ?to) ([A-Z][a-z]+)\b/i,
  /(?<!\b(?:the|a|an|my|your) )\b(?:follow ?up with|reply to) ([A-Z][a-z]+)\b/,
  /\b(?:send|write) (?:an |a )?e-?mail to ([A-Z][a-z]+)\b/i,
]

export interface EmailAskHit {
  name: string
  intent: 'draft'
}

/** The i flag keeps verb matching forgiving but would also lowercase the name
 * classes, so capitalization is re checked after the match. */
function isProperName(s: string | undefined | null): boolean {
  return /^[A-Z][a-z]+$/.test(s || '')
}

export function detectEmailAsk(text: string): EmailAskHit | null {
  for (const re of EMAIL_ASK_RES) {
    const name = (text.match(re)?.[1] || '').trim()
    if (isProperName(name)) return { name, intent: 'draft' }
  }
  return null
}

/** Scheduling ask: find/pick/set up/schedule a time|slot|call|meeting, with an
 * optional capitalized name. "reschedule" is deliberately excluded. */
const SCHED_ASK_RE =
  /\b(?:find|pick|set up|schedule) (?:an? )?(?:time|slot|call|meeting)\b(?: with ([A-Z][a-z]+))?/i
const FREE_RE = /\bwhen (?:is|works for) ([A-Z][a-z]+) free\b/i

export interface SchedAskHit {
  with?: string
}

export function detectSchedulingAsk(text: string): SchedAskHit | null {
  const free = text.match(FREE_RE)
  if (isProperName(free?.[1])) return { with: free![1]! }
  const m = text.match(SCHED_ASK_RE)
  if (!m) return null
  return isProperName(m[1]) ? { with: m[1]! } : {}
}

/** Meeting wrap: the caller injects wrap questions, nothing is logged here. */
const WRAP_RES: RegExp[] = [
  /\b(?:the )?(?:review|meeting|sync|standup) (?:went|is done|wrapped|just ended)\b/i,
  /\bwrap(?:ped)? (?:the )?(?:review|meeting|sync)\b/i,
]

export function detectMeetingWrap(text: string): Record<string, never> | null {
  return WRAP_RES.some((re) => re.test(text)) ? {} : null
}

/* ---- Capture: cofounder detectors plus the work detectors ---- */

export type CoworkerCapture =
  | { kind: 'promise' | 'decision' | 'person'; summary: string }
  | { kind: 'draft'; summary: string; name: string }
  | { kind: 'slots'; name?: string }
  | { kind: 'wrap' }

/** Run cofounder promise/decision/person detectors plus the work detectors.
 * Email ask POSTs a promise (a draft to make is a promise, no dueAt) and only
 * surfaces once the server confirms the create. Scheduling asks and meeting
 * wraps never POST anything. An explicit promise already covers an email ask,
 * so "I'll reply to Priya by tomorrow" is captured once, not twice. */
export async function coworkerCaptureFromChat(
  phone: string,
  persona: string,
  text: string,
  now: Date = new Date(),
  post?: CapturePost,
): Promise<CoworkerCapture[]> {
  const doPost = post || defaultCapturePost(phone, persona, text)
  const out: CoworkerCapture[] = []
  const base = await captureFromChat(phone, persona, text, now, doPost)
  for (const hit of base) out.push({ kind: hit.kind, summary: hit.summary })
  const email = detectEmailAsk(text)
  if (email && !base.some((h) => h.kind === 'promise')) {
    const res = await doPost('promise', { title: `draft reply to ${email.name}` })
    if (res?.created) {
      out.push({ kind: 'draft', summary: `draft reply to ${email.name}`, name: email.name })
    }
  }
  const sched = detectSchedulingAsk(text)
  if (sched) out.push({ kind: 'slots', ...(sched.with ? { name: sched.with } : {}) })
  if (detectMeetingWrap(text)) out.push({ kind: 'wrap' })
  return out
}

/* ---- Daily digest: pick the one highest signal item ---- */

export interface CoworkerDigest extends CofounderDigest {
  nextMeeting?: { title: string; startsInMin: number }
  draftsWaiting?: number
  /** True only once the standup is already handled; absent or false means the
   * drafted standup still wants a yes from the user. */
  standupReady?: boolean
}

export type CoworkerPick =
  | { kind: 'meeting'; title: string; startsInMin: number }
  | { kind: 'drafts'; count: number; name?: string }
  | { kind: 'standup' }
  | { kind: 'promise'; title: string; dueAt: string }

/** Priority: next meeting within 90 minutes, waiting drafts, standup not yet
 * confirmed, most overdue promise. Returns null when nothing clears the bar. */
export function pickCoworkerItem(digest: CoworkerDigest | null, now: Date = new Date()): CoworkerPick | null {
  if (!digest) return null
  const mtg = digest.nextMeeting
  const mins = Number(mtg?.startsInMin)
  if (mtg?.title && Number.isFinite(mins) && mins >= 0 && mins <= 90) {
    return { kind: 'meeting', title: String(mtg.title).slice(0, 120), startsInMin: mins }
  }
  const drafts = Number(digest.draftsWaiting)
  if (Number.isFinite(drafts) && drafts > 0) {
    // Best effort: name a queued draft when the promise list shows one.
    const named = (digest.duePromises || [])
      .map((p) => /^draft (?:reply|note|follow ?up) to ([A-Z][a-z]+)/.exec(p?.title || '')?.[1])
      .find(Boolean)
    return { kind: 'drafts', count: Math.floor(drafts), ...(named ? { name: named } : {}) }
  }
  if (digest.standupReady === false) return { kind: 'standup' }
  const t = (d: Date) => new Date(d).getTime()
  const overdue = (digest.duePromises || [])
    .filter((p) => p && p.title && p.dueAt && Number.isFinite(t(p.dueAt)) && t(p.dueAt) < now.getTime())
    .sort((a, b) => t(a.dueAt) - t(b.dueAt))
  if (overdue.length) {
    return { kind: 'promise', title: String(overdue[0]!.title).slice(0, 120), dueAt: overdue[0]!.dueAt }
  }
  return null
}

/** Channel rules: no dashes of any kind, one or two sentences. */
export function buildCoworkerText(pick: CoworkerPick, now: Date = new Date()): string {
  let text: string
  if (pick.kind === 'meeting') {
    const mins = Math.max(1, Math.round(pick.startsInMin))
    text = `${pick.title} starts in ${mins} ${mins === 1 ? 'minute' : 'minutes'}. I put the agenda in Meeting mode.`
  } else if (pick.kind === 'drafts') {
    const n = `${pick.count} ${pick.count === 1 ? 'draft is' : 'drafts are'} waiting in Approve and send.`
    text = pick.name ? `${n} One is to ${pick.name}.` : n
  } else if (pick.kind === 'standup') {
    text = 'Standup is drafted from yesterday and today. Want it?'
  } else {
    const overdueDays = Math.floor((now.getTime() - new Date(pick.dueAt).getTime()) / 86_400_000)
    text =
      overdueDays >= 1
        ? `"${pick.title}" is ${overdueDays} ${overdueDays === 1 ? 'day' : 'days'} overdue. Want a draft ready to send?`
        : `"${pick.title}" is due. Want a draft ready to send?`
  }
  return text.replace(/[\u2013\u2014]/g, ',').replace(/\s+-\s+/g, '. ').trim()
}

/* ---- Loop: check hourly, fire at most once per calendar day ---- */

const lastFiredByPersona = new Map<string, string>()

export function startCoworkerLoop(opts: {
  persona: string
  send: (phone: string, text: string) => Promise<void>
  pollMs?: number
  /** Best effort fire hour in local time. */
  startHour?: number
  /** Optional known user phone; appended to the digest query when set. */
  phone?: string
  /** Injectables for tests. */
  now?: () => Date
  fetchDigest?: (persona: string) => Promise<CoworkerDigest | null>
  checkKillSwitch?: (phone: string) => Promise<boolean>
}) {
  const pollMs = opts.pollMs ?? 60 * 60 * 1000
  const startHour = opts.startHour ?? 9
  const nowFn = opts.now || (() => new Date())
  const checkKillSwitch = opts.checkKillSwitch || killSwitchBlocksSend
  const base = (process.env.HIREALPHA_API_URL || '').replace(/\/$/, '')
  if (!base || !process.env.HIREALPHA_INTERNAL_KEY) {
    console.log(`[coworkerPro:${opts.persona}] off: HIREALPHA_API_URL or HIREALPHA_INTERNAL_KEY missing`)
    return { stop: () => undefined }
  }
  const authHeaders = () => ({
    Authorization: `Bearer ${process.env.HIREALPHA_INTERNAL_KEY || ''}`,
    Accept: 'application/json',
  })
  const fetchDigest =
    opts.fetchDigest ||
    (async (persona: string): Promise<CoworkerDigest | null> => {
      try {
        const q = new URLSearchParams({ persona })
        if (opts.phone) q.set('phone', opts.phone)
        const res = await fetch(`${base}/api/internal/coworker/digest?${q.toString()}`, {
          headers: authHeaders(),
        })
        if (!res.ok) return null
        return (await res.json()) as CoworkerDigest
      } catch (err) {
        console.warn(`[coworkerPro:${persona}] digest fetch failed`, err)
        return null
      }
    })

  const tick = async () => {
    const now = nowFn()
    if (!canFireDaily(lastFiredByPersona.get(opts.persona) || null, now, startHour)) return
    const digest = await fetchDigest(opts.persona)
    const pick = pickCoworkerItem(digest, now)
    // Nothing to say (or the server blipped): leave the day unfired so a
    // later hour can retry with a healthy digest.
    if (!pick) return
    const phone = opts.phone || digest?.phone || ''
    if (!phone) return
    if (await checkKillSwitch(phone)) {
      // Armed: burn the day's slot so the loop never spams once disarmed.
      lastFiredByPersona.set(opts.persona, dayKey(now))
      return
    }
    try {
      await opts.send(phone, buildCoworkerText(pick, now))
      lastFiredByPersona.set(opts.persona, dayKey(now))
    } catch (err) {
      console.warn(`[coworkerPro:${opts.persona}] daily send failed`, err)
    }
  }

  const run = () => {
    tick().catch((err) => console.warn(`[coworkerPro:${opts.persona}] tick failed`, err))
  }
  run()
  const timer = setInterval(run, pollMs)
  timer.unref?.()
  console.log(`[coworkerPro:${opts.persona}] started every ${pollMs / 1000}s, fires once daily after ${startHour}:00`)
  return { stop: () => clearInterval(timer) }
}

/** Test hook: forget the fired day for a persona. */
export function resetCoworkerLoopState(persona?: string) {
  if (persona) lastFiredByPersona.delete(persona)
  else lastFiredByPersona.clear()
}
