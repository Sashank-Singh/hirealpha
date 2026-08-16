import type { AgentId } from '../../src/agents/types'
import { gmiChat } from './gmi'
import type { MiniAppCard } from './miniApps'

export const JUDGE_MARKER = '[judge]'

/** Photon: more than 2–3 unanswered follow-ups flags the line. Never send the 3rd. */
export const MAX_UNANSWERED_PROACTIVE = 2
/** Don't burn the unanswered quota with morning + afternoon + evening in one day. */
export const MAX_UNANSWERED_PER_DAY = 1

export function isJudgeTick(text: string): boolean {
  return text.startsWith(JUDGE_MARKER) || text.startsWith('[poke]') || text.startsWith('[digest]')
}

export type JudgmentState = {
  persona: AgentId
  localTime: string
  weekday: string
  timezone: string
  tick: string
  proactive: string
  quietHours: string
  lastInboundMinutesAgo: number | null
  lastProactiveMinutesAgo: number | null
  lastProactiveTopic: string | null
  unansweredProactive?: number
  unansweredToday?: number
  nutrition?: { calories: number; protein: number; calorieGoal: number; proteinGoal: number; meals: number }
  habits?: Array<{ name: string; streak: number; todayDone: boolean }>
  sleep?: { hours: number; quality: number; date: string } | null
  peopleDue?: Array<{ name: string; days: number; note?: string }>
  spend?: { weekTotal: number; weeklyBudget: number }
  loops?: string[]
  calendar?: string[]
  mail?: string[]
}

export type JudgmentResult = {
  send: boolean
  topic: string
  text: string
  card?: MiniAppCard
}

type JudgeDecision = {
  reachOut: boolean
  topic: string
  message: string
  card: string | null
}

const THEATER =
  /\b(i'?m here\.?\s*the real part|not the polished version|unfiltered|no filter|keeping it real)\b/i

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

export async function fetchJudgmentState(
  phone: string,
  persona: AgentId,
  tick: string,
): Promise<JudgmentState | null> {
  const base = apiBase()
  const key = process.env.HIREALPHA_INTERNAL_KEY || ''
  if (!base || !key) return null
  try {
    const qs = new URLSearchParams({ phone, persona, tick })
    const res = await timedFetch(`${base}/api/internal/judgment-state?${qs}`, { headers: authHeaders() }, 12000)
    if (!res.ok) return null
    return (await res.json()) as JudgmentState
  } catch (err) {
    console.warn('[judgment] state fetch failed', err)
    return null
  }
}

export async function recordProactiveSent(phone: string, persona: AgentId, topic: string) {
  const base = apiBase()
  const key = process.env.HIREALPHA_INTERNAL_KEY || ''
  if (!base || !key) return
  try {
    await timedFetch(
      `${base}/api/internal/proactive/sent`,
      {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({ phone, persona, topic }),
      },
      5000,
    )
  } catch (err) {
    console.warn('[judgment] record sent failed', err)
  }
}

export async function freezeProactiveUntilReply(phone: string, persona: AgentId) {
  const base = apiBase()
  const key = process.env.HIREALPHA_INTERNAL_KEY || ''
  if (!base || !key) return
  try {
    await timedFetch(
      `${base}/api/internal/proactive/sent`,
      {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({ phone, persona, freeze: true }),
      },
      5000,
    )
  } catch (err) {
    console.warn('[judgment] freeze failed', err)
  }
}

export function isRecipientSendBlocked(err: unknown): boolean {
  const code =
    typeof err === 'object' && err && 'code' in err ? String((err as { code?: unknown }).code || '') : ''
  const msg = err instanceof Error ? err.message : String(err || '')
  const blob = `${code} ${msg}`.toLowerCase()
  return (
    /recipientcoolingdown|recipientlocked|recipientlimitexceeded|sendreceiveratioexceeded/.test(
      blob.replace(/[^a-z]/g, ''),
    ) || /cooling.?down|recipient.?locked|send.?receive.?ratio|recipient.?limit/.test(blob)
  )
}

export async function setProactiveMode(
  phone: string,
  persona: AgentId,
  patch: { proactive?: string; quietHours?: string; pausedUntil?: string | null; pauseToday?: boolean },
) {
  const base = apiBase()
  const key = process.env.HIREALPHA_INTERNAL_KEY || ''
  if (!base || !key) return false
  try {
    const res = await timedFetch(
      `${base}/api/internal/proactive`,
      {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({ phone, persona, ...patch }),
      },
      5000,
    )
    return res.ok
  } catch {
    return false
  }
}

function inQuietHours(localTime: string, quietHours: string): boolean {
  const m = quietHours.match(/^(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})$/)
  if (!m) return false
  const [lh, lm] = localTime.slice(11, 16).split(':').map(Number)
  const now = (lh || 0) * 60 + (lm || 0)
  const start = Number(m[1]) * 60 + Number(m[2])
  const end = Number(m[3]) * 60 + Number(m[4])
  if (start === end) return false
  if (start < end) return now >= start && now < end
  return now >= start || now < end
}

function hardGuard(state: JudgmentState): string | null {
  const mode = (state.proactive || 'on').toLowerCase()
  if (mode === 'off') return 'proactive off'
  if (mode === 'paused') return 'paused'
  if (inQuietHours(state.localTime, state.quietHours || '22:00-08:00')) return 'quiet hours'
  if (state.lastInboundMinutesAgo != null && state.lastInboundMinutesAgo < 20) return 'in conversation'
  if (state.lastProactiveMinutesAgo != null && state.lastProactiveMinutesAgo < 60) return 'sent recently'
  const unanswered = Number(state.unansweredProactive) || 0
  const unansweredToday = Number(state.unansweredToday) || 0
  if (unanswered >= MAX_UNANSWERED_PROACTIVE) return 'awaiting reply'
  if (unansweredToday >= MAX_UNANSWERED_PER_DAY) return 'already pinged today'
  return null
}

function personaVoice(persona: AgentId): string {
  if (persona === 'coworker') return 'You are Alpha (Coworker). Direct, useful, no fluff.'
  if (persona === 'cofounder') return 'You are Alpha (CoFounder). Push on the real decision. No pep talk.'
  return 'You are Alpha, a hired friend in iMessage. Warm, specific, never clingy.'
}

function judgePrompt(state: JudgmentState): string {
  return `${personaVoice(state.persona)}
You are considering whether to text first. This is not a briefing dump.

Ground truth (do not invent numbers or events):
${JSON.stringify(state, null, 0)}

Decide:
- reachOut true only if ONE specific thing is worth a text right now
- topic: a short slug (nutrition_gap, habit_risk, follow_up, sleep, digest, check_in, spend, loop, none)
- message: 1-2 short sentences. Opinionated. No markdown, no lists, no hyphens or dashes. No persona theater.
- card: always null

Stay silent (reachOut false) if nothing is actually useful, if you would only send a generic check in, or if lastProactiveTopic is the same topic again.
Stay silent if unansweredProactive is already 1 unless the thing is time sensitive and they can answer in a few words.

A digest tick means morning is a good time. Prefer a 2 sentence wrap of THE one thing that matters today over silence, unless they were just talking or there is truly nothing.

Never paste a calendar or inbox. Never say you are an AI.
Never attach a card. Unanswered iMessage follow ups cannot include links or media.
If you text, end with something they can answer in one text. Do not stack questions.

Reply JSON only: {"reachOut":boolean,"topic":"slug","message":"text","card":null}`
}

function parseDecision(raw: string): JudgeDecision | null {
  const start = raw.indexOf('{')
  const end = raw.lastIndexOf('}')
  if (start < 0 || end <= start) return null
  try {
    const data = JSON.parse(raw.slice(start, end + 1)) as Partial<JudgeDecision>
    const message = String(data.message || '').trim()
    return {
      reachOut: data.reachOut === true && !!message,
      topic: String(data.topic || 'none').slice(0, 40),
      message,
      card: data.card ? String(data.card) : null,
    }
  } catch {
    return null
  }
}

/**
 * Heartbeat already fired. Look at state, decide whether to reach out,
 * draft one short message, return null to stay silent.
 */
export async function runJudgmentLoop(input: {
  phone: string
  persona: AgentId
  reminderText: string
}): Promise<JudgmentResult | null> {
  const tick = input.reminderText.startsWith('[digest]')
    ? 'digest'
    : input.reminderText.replace(JUDGE_MARKER, '').replace('[poke]', '').trim() || 'judge'
  const state = await fetchJudgmentState(input.phone, input.persona, tick)
  if (!state) {
    console.warn(`[judgment:${input.persona}] no state for ${input.phone}`)
    return null
  }
  const blocked = hardGuard(state)
  if (blocked) {
    console.log(`[judgment:${input.persona}] skip ${input.phone}: ${blocked}`)
    return null
  }

  let decision: JudgeDecision | null = null
  try {
    const raw = await gmiChat({
      temperature: 0.4,
      maxTokens: 180,
      messages: [
        { role: 'system', content: judgePrompt(state) },
        { role: 'user', content: `Tick: ${tick}. Should you text? JSON only.` },
      ],
    })
    decision = parseDecision(raw)
  } catch (err) {
    console.warn(`[judgment:${input.persona}] llm failed`, err)
    return null
  }
  if (!decision?.reachOut || !decision.message) return null
  if (THEATER.test(decision.message)) return null
  if (state.lastProactiveTopic && decision.topic === state.lastProactiveTopic && tick !== 'digest') {
    return null
  }

  let text = decision.message.replace(/[\u2013\u2014]/g, ',').replace(/\s+-\s+/g, '. ')
  if (text.length > 420) text = text.slice(0, 417).trim() + '…'

  // Photon: unanswered follow-ups cannot include links or media. A card is a
  // second send and burns the unanswered quota. Text only until they reply.
  return { send: true, topic: decision.topic, text }
}
