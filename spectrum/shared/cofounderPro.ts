import { killSwitchBlocksSend } from './taskLoops'

/**
 * Alpha (CoFounder) proactive capture and daily digest.
 * Detectors are pure and precision first: a false positive logs junk into the
 * user's pipeline, a miss only costs one manual log. Server clients stay
 * graceful: missing env or a non 200 is a no-op, never a throw.
 */

/* ---- Shared client plumbing (same shape as liveContext/taskLoops) ---- */

function apiBase() {
  return (process.env.HIREALPHA_API_URL || '').replace(/\/$/, '')
}

function authHeaders() {
  const key = process.env.HIREALPHA_INTERNAL_KEY || ''
  return {
    Authorization: `Bearer ${key}`,
    Accept: 'application/json',
    'Content-Type': 'application/json',
  }
}

async function timedFetch(url: string, init: RequestInit, ms: number) {
  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), ms)
  try {
    return await fetch(url, { ...init, signal: ctrl.signal })
  } finally {
    clearTimeout(t)
  }
}

/* ---- Pure detectors ---- */

export interface PromiseHit {
  title: string
  dueAt?: string
}

const PROMISE_VERBS = 'send|draft|reply|introduce|share|finish|review|call'
const PROMISE_RE = new RegExp(
  `\\bI'?ll\\s+(${PROMISE_VERBS})\\b([^.\\n!?]{0,80}?)\\bby\\s+(monday|tuesday|wednesday|thursday|friday|saturday|sunday|tomorrow|tonight|today|eod|end of day)\\b`,
  'i',
)

const DAY_INDEX: Record<string, number> = {
  sunday: 0,
  monday: 1,
  tuesday: 2,
  wednesday: 3,
  thursday: 4,
  friday: 5,
  saturday: 6,
}

function endOfBusiness(now: Date): Date {
  const d = new Date(now)
  d.setHours(17, 0, 0, 0)
  return d
}

/** Resolve a promise deadline word to a date. Weekday names mean the next
 * occurrence (today counts), tonight is 21:00, eod/today is 17:00. */
export function resolveDueWord(word: string, now: Date): Date | undefined {
  const w = word.toLowerCase()
  if (w === 'tonight') {
    const d = new Date(now)
    d.setHours(21, 0, 0, 0)
    return d
  }
  if (w === 'eod' || w === 'end of day' || w === 'today') return endOfBusiness(now)
  if (w === 'tomorrow') {
    const d = endOfBusiness(now)
    d.setDate(d.getDate() + 1)
    return d
  }
  const target = DAY_INDEX[w]
  if (target == null) return undefined
  const d = endOfBusiness(now)
  const ahead = (target - d.getDay() + 7) % 7
  d.setDate(d.getDate() + ahead)
  return d
}

export function detectPromise(text: string, now: Date = new Date()): PromiseHit | null {
  const m = text.match(PROMISE_RE)
  if (!m) return null
  const verb = (m[1] || '').toLowerCase()
  const middle = (m[2] || '').replace(/\s+/g, ' ').trim()
  const title = `${verb} ${middle}`.replace(/\s+/g, ' ').trim().slice(0, 120)
  if (!title) return null
  const due = resolveDueWord(m[3] || '', now)
  return { title, ...(due ? { dueAt: due.toISOString() } : {}) }
}

const DECISION_VERB_RE =
  /\bwe(?:'re| are)?\s+(?:passing|going with|hiring|declining|killing|choosing)\b/i
const DECIDED_RE = /\bdecided to\b/i
/** "we decided nothing", "we decided against it" are not decisions to log. */
const DECISION_NEGATIVE_RE = /\bdecided\s+(?:nothing|nobody|no one|not to|against)\b/i
/** "we're passing by the store" is directions, not a hiring call. */
const DECISION_PASSING_BY_RE = /\bpassing\s+by\b/i

export function detectDecision(text: string): { decision: string } | null {
  if (DECISION_NEGATIVE_RE.test(text)) return null
  if (DECISION_PASSING_BY_RE.test(text)) return null
  if (!DECISION_VERB_RE.test(text) && !DECIDED_RE.test(text)) return null
  // Keep the sentence that holds the call so the log reads cleanly.
  const sentence = text
    .split(/(?<=[.!?])\s+|\n/)
    .find((s) => DECISION_VERB_RE.test(s) || DECIDED_RE.test(s))
  const decision = (sentence || text).replace(/\s+/g, ' ').trim().slice(0, 200)
  if (!decision) return null
  return { decision }
}

const PERSON_RE = /\b[Mm]et (?:with )?([A-Z][a-z]+)\b/
/** Common nouns that read like "met with resistance", not a person. */
const PERSON_BLOCKLIST = new Set([
  'resistance', 'silence', 'expectations', 'success', 'failure', 'approval',
  'opposition', 'scrutiny', 'enthusiasm', 'deadline', 'deadlines', 'demand',
  'demands', 'criticism', 'skepticism', 'pushback',
])
/** "was met with silence" is narration, never a contact. */
const PERSON_NARRATED_RE = /\b(?:was|were|been|be|get|got)\s+met\b/i

export function detectPerson(text: string): { name: string } | null {
  if (PERSON_NARRATED_RE.test(text)) return null
  const m = text.match(PERSON_RE)
  const name = (m?.[1] || '').trim()
  if (!name) return null
  if (PERSON_BLOCKLIST.has(name.toLowerCase())) return null
  return { name }
}

const OPPORTUNITY_RE =
  /\b(talking|in talks|pitching|interviewing) (?:with|to) ([A-Z][\w&.]*(?: [A-Z][\w&.]*)*)/

export function detectOpportunity(text: string): { title: string; stage: string } | null {
  const m = text.match(OPPORTUNITY_RE)
  if (!m) return null
  const company = (m[2] || '').trim().replace(/[.\s]+$/, '')
  if (!company) return null
  const stage = m[1]!.toLowerCase() === 'pitching'
    ? 'pitching'
    : m[1]!.toLowerCase() === 'interviewing'
      ? 'interviewing'
      : 'talking'
  return { title: company, stage }
}

/* ---- Capture: run detectors and POST hits to the server ---- */

export type CaptureKind = 'promise' | 'decision' | 'person' | 'opportunity'

export interface CaptureResult {
  kind: CaptureKind
  summary: string
  id?: string
}

export type CapturePost = (
  kind: CaptureKind,
  fields: Record<string, unknown>,
) => Promise<{ created?: boolean; id?: string } | null>

export function defaultCapturePost(
  phone: string,
  persona: string,
  raw: string,
): CapturePost {
  return async (kind, fields) => {
    const base = apiBase()
    if (!base || !process.env.HIREALPHA_INTERNAL_KEY) return null
    try {
      const res = await timedFetch(
        `${base}/api/internal/cofounder/capture`,
        {
          method: 'POST',
          headers: authHeaders(),
          body: JSON.stringify({ phone, persona, kind, fields, raw: raw.slice(0, 500) }),
        },
        8000,
      )
      if (!res.ok) return null
      return (await res.json()) as { created?: boolean; id?: string }
    } catch (err) {
      console.warn('[cofounderPro] capture post failed', err)
      return null
    }
  }
}

/** Run every detector over one inbound text and POST each hit. Only confirmed
 * server creates come back, so the caller never confirms a log that failed. */
export async function captureFromChat(
  phone: string,
  persona: string,
  text: string,
  now: Date = new Date(),
  post?: CapturePost,
): Promise<CaptureResult[]> {
  const doPost = post || defaultCapturePost(phone, persona, text)
  const hits: Array<{ kind: CaptureKind; fields: Record<string, unknown>; summary: string }> = []
  const promise = detectPromise(text, now)
  if (promise) {
    hits.push({
      kind: 'promise',
      fields: { title: promise.title, ...(promise.dueAt ? { dueAt: promise.dueAt } : {}) },
      summary: `promise: ${promise.title}`,
    })
  }
  const decision = detectDecision(text)
  if (decision) {
    hits.push({ kind: 'decision', fields: { decision: decision.decision }, summary: `decision: ${decision.decision}` })
  }
  const person = detectPerson(text)
  if (person) {
    hits.push({ kind: 'person', fields: { name: person.name }, summary: `person: ${person.name}` })
  }
  const opportunity = detectOpportunity(text)
  if (opportunity) {
    hits.push({
      kind: 'opportunity',
      fields: { title: opportunity.title, stage: opportunity.stage },
      summary: `opportunity: ${opportunity.title} (${opportunity.stage})`,
    })
  }
  const out: CaptureResult[] = []
  for (const hit of hits) {
    const res = await doPost(hit.kind, hit.fields)
    if (res?.created) out.push({ kind: hit.kind, summary: hit.summary, ...(res.id ? { id: res.id } : {}) })
  }
  return out
}

/* ---- Daily digest: pick the one highest signal item and send it ---- */

export interface CofounderDigest {
  stalePipeline?: Array<{ id: string; title: string; stage: string; daysSinceTouch: number }>
  duePromises?: Array<{ id: string; title: string; dueAt: string }>
  decisionsToRevisit?: Array<{ id: string; decision: string; reviewAt: string }>
  newPeople?: Array<{ id: string; name: string; lastTouchAt: string }>
  pipelineMoves?: Record<string, number>
  noteReady?: boolean
  /** Optional: server may attach the hire's phone so the loop knows where to text. */
  phone?: string
}

export type DailyPick =
  | { kind: 'promise'; title: string; dueAt: string }
  | { kind: 'decision'; decision: string }
  | { kind: 'pipeline'; title: string; days: number }
  | { kind: 'person'; name: string }
  | { kind: 'note' }

/** Priority: overdue promises, decisions to revisit, stalest pipeline, newest
 * person, note ready. Returns null when nothing clears the bar. */
export function pickDailyItem(digest: CofounderDigest | null, now: Date = new Date()): DailyPick | null {
  if (!digest) return null
  const t = (d: Date) => d.getTime()
  const promises = (digest.duePromises || [])
    .filter((p) => p && p.title && p.dueAt)
    .sort((a, b) => t(new Date(a.dueAt)) - t(new Date(b.dueAt)))
  if (promises.length) {
    const p = promises[0]!
    return { kind: 'promise', title: String(p.title).slice(0, 120), dueAt: p.dueAt }
  }
  const decisions = (digest.decisionsToRevisit || [])
    .filter((d) => d && d.decision)
    .sort((a, b) => t(new Date(a.reviewAt || 0)) - t(new Date(b.reviewAt || 0)))
  if (decisions.length) {
    return { kind: 'decision', decision: String(decisions[0]!.decision).slice(0, 160) }
  }
  const stale = (digest.stalePipeline || [])
    .filter((s) => s && s.title && Number.isFinite(Number(s.daysSinceTouch)))
    .sort((a, b) => Number(b.daysSinceTouch) - Number(a.daysSinceTouch))
  if (stale.length) {
    return { kind: 'pipeline', title: String(stale[0]!.title).slice(0, 120), days: Number(stale[0]!.daysSinceTouch) }
  }
  const people = (digest.newPeople || [])
    .filter((p) => p && p.name)
    .sort((a, b) => t(new Date(b.lastTouchAt || 0)) - t(new Date(a.lastTouchAt || 0)))
  if (people.length) {
    return { kind: 'person', name: String(people[0]!.name).slice(0, 80) }
  }
  if (digest.noteReady) return { kind: 'note' }
  return null
}

/** Channel rules: no dashes of any kind, one or two sentences. */
export function buildDailyText(pick: DailyPick, now: Date = new Date()): string {
  let text: string
  if (pick.kind === 'promise') {
    const due = new Date(pick.dueAt)
    const overdueDays = Number.isFinite(due.getTime())
      ? Math.floor((now.getTime() - due.getTime()) / 86_400_000)
      : -1
    text =
      overdueDays >= 1
        ? `"${pick.title}" was due ${overdueDays} ${overdueDays === 1 ? 'day' : 'days'} ago. Send it now so it stops hanging over you?`
        : `"${pick.title}" is due today. Get it out before the day fills up?`
  } else if (pick.kind === 'decision') {
    text = `"${pick.decision}" was queued for a revisit. Still the right call, or has anything changed?`
  } else if (pick.kind === 'pipeline') {
    text = `${pick.title} has sat ${pick.days} days. I drafted the nudge. Want it?`
  } else if (pick.kind === 'person') {
    text = `You met ${pick.name} recently. Want a two line follow up drafted before it goes cold?`
  } else {
    text = "Yesterday's notes are ready to file. Want the one line summary?"
  }
  return text.replace(/[\u2013\u2014]/g, ',').replace(/\s+-\s+/g, '. ').trim()
}

/* ---- Loop: check hourly, fire at most once per calendar day ---- */

export function dayKey(now: Date): string {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
}

/** Best effort 9am local: no cron, so the hourly tick only fires once the
 * clock is past startHour and this calendar day has not fired yet. */
export function canFireDaily(lastFiredKey: string | null, now: Date, startHour = 9): boolean {
  if (now.getHours() < startHour) return false
  return dayKey(now) !== lastFiredKey
}

const lastFiredByPersona = new Map<string, string>()

export function startCofounderLoop(opts: {
  persona: string
  send: (phone: string, text: string) => Promise<void>
  pollMs?: number
  /** Best effort fire hour in local time. */
  startHour?: number
  /** Injectables for tests. */
  now?: () => Date
  fetchDigest?: (persona: string) => Promise<CofounderDigest | null>
  checkKillSwitch?: (phone: string) => Promise<boolean>
}) {
  const pollMs = opts.pollMs ?? 60 * 60 * 1000
  const startHour = opts.startHour ?? 9
  const nowFn = opts.now || (() => new Date())
  const checkKillSwitch = opts.checkKillSwitch || killSwitchBlocksSend
  const base = apiBase()
  if (!base || !process.env.HIREALPHA_INTERNAL_KEY) {
    console.log(`[cofounderPro:${opts.persona}] off: HIREALPHA_API_URL or HIREALPHA_INTERNAL_KEY missing`)
    return { stop: () => undefined }
  }
  const fetchDigest =
    opts.fetchDigest ||
    (async (persona: string): Promise<CofounderDigest | null> => {
      try {
        const res = await timedFetch(
          `${base}/api/internal/cofounder/digest?persona=${encodeURIComponent(persona)}`,
          { headers: authHeaders() },
          10000,
        )
        if (!res.ok) return null
        return (await res.json()) as CofounderDigest
      } catch (err) {
        console.warn(`[cofounderPro:${persona}] digest fetch failed`, err)
        return null
      }
    })

  const tick = async () => {
    const now = nowFn()
    if (!canFireDaily(lastFiredByPersona.get(opts.persona) || null, now, startHour)) return
    const digest = await fetchDigest(opts.persona)
    const pick = pickDailyItem(digest, now)
    // Nothing to say (or the server blipped): leave the day unfired so a
    // later hour can retry with a healthy digest.
    if (!pick) return
    const phone = digest?.phone || ''
    if (!phone) return
    if (await checkKillSwitch(phone)) {
      // Armed: burn the day's slot so the loop never spams once disarmed.
      lastFiredByPersona.set(opts.persona, dayKey(now))
      return
    }
    try {
      await opts.send(phone, buildDailyText(pick, now))
      lastFiredByPersona.set(opts.persona, dayKey(now))
    } catch (err) {
      console.warn(`[cofounderPro:${opts.persona}] daily send failed`, err)
    }
  }

  const run = () => {
    tick().catch((err) => console.warn(`[cofounderPro:${opts.persona}] tick failed`, err))
  }
  run()
  const timer = setInterval(run, pollMs)
  timer.unref?.()
  console.log(`[cofounderPro:${opts.persona}] started every ${pollMs / 1000}s, fires once daily after ${startHour}:00`)
  return { stop: () => clearInterval(timer) }
}

/** Test hook: forget the fired day for a persona. */
export function resetCofounderLoopState(persona?: string) {
  if (persona) lastFiredByPersona.delete(persona)
  else lastFiredByPersona.clear()
}
