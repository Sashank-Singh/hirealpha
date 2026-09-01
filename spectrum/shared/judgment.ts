import type { AgentId } from '../../src/agents/types'
import { gmiChat } from './gmi'
import { isBannedTagline } from './outboundFilter'
import { pickProactiveInsight, tapHint, type LifeCardKind } from './lifeState'
import { fetchWeekBundle } from './liveContext'

export const JUDGE_MARKER = '[judge]'

/** Photon: more than 2 unanswered follow-ups flags the line. Never send the 3rd. */
export const MAX_UNANSWERED_PROACTIVE = 2
/** Morning plus night. Interrupt only if they already replied or nothing went out yet. */
export const MAX_UNANSWERED_PER_DAY = 2

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
  quietHours?: string
  lastInboundMinutesAgo: number | null
  lastProactiveMinutesAgo: number | null
  lastProactiveTopic: string | null
  unansweredProactive?: number
  unansweredToday?: number
  nutrition?: { calories: number; protein: number; calorieGoal: number; proteinGoal: number; meals: number }
  habits?: Array<{ name: string; streak: number; todayDone: boolean }>
  mood?: { loggedToday: boolean; lastEmoji?: string | null; lastEnergy?: number | null }
  sleep?: { hours: number; quality: number; date: string } | null
  sleepWeek?: { nights: number; avgHours: number; shortNights: number }
  workoutsToday?: number
  workoutToday?: { name: string; place: string; rest?: boolean }
  peopleDue?: Array<{ name: string; days: number; note?: string; phone?: string; email?: string }>
  peoplePhones?: Array<{ name: string; phone?: string; email?: string }>
  spend?: { weekTotal: number; weeklyBudget: number }
  loops?: string[]
  calendar?: string[]
  mail?: string[]
  weekly?: {
    meals: number; calories: number; moodLogs: number; avgEnergy: number; habitChecks: number
    sleepNights: number; avgSleepHours: number; spend: number; weeklyBudget: number
    workouts: number; learningDone: number; gratitude: number
  }
}

export type JudgmentResult = {
  send: boolean
  topic: string
  text: string
  cardKind?: LifeCardKind | null
}

type JudgeDecision = {
  reachOut: boolean
  topic: string
  message: string
  card: string | null
}

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
    const res = await timedFetch(`${base}/api/internal/judgment-state?${qs}`, { headers: authHeaders() }, 18000)
    if (!res.ok) return null
    return (await res.json()) as JudgmentState
  } catch (err) {
    console.warn('[judgment] state fetch failed', err)
    return null
  }
}

export async function fetchLastProactiveTopic(
  phone: string,
  persona: AgentId,
): Promise<{ topic: string | null; minutesAgo: number | null }> {
  const base = apiBase()
  const key = process.env.HIREALPHA_INTERNAL_KEY || ''
  if (!base || !key) return { topic: null, minutesAgo: null }
  try {
    const qs = new URLSearchParams({ phone, persona })
    const res = await timedFetch(`${base}/api/internal/last-proactive?${qs}`, { headers: authHeaders() }, 6000)
    if (!res.ok) return { topic: null, minutesAgo: null }
    return (await res.json()) as { topic: string | null; minutesAgo: number | null }
  } catch (err) {
    console.warn('[judgment] last-proactive fetch failed', err)
    return { topic: null, minutesAgo: null }
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

function hardGuard(state: JudgmentState): string | null {
  const mode = (state.proactive || 'on').toLowerCase()
  if (mode === 'off') return 'proactive off'
  if (mode === 'paused') return 'paused'
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

function judgePrompt(state: JudgmentState, insightLine: string, tap: string): string {
  return `${personaVoice(state.persona)}
You are considering whether to text first. This is not a briefing dump.

Right now it is ${state.weekday} at ${String(state.localTime || '').slice(11, 16) || 'unknown'} in ${state.timezone}. That is today. Do not guess the weekday.

Computed life state (do not invent numbers or events):
${JSON.stringify(state, null, 0)}

A deterministic read already picked the one thing worth saying:
"${insightLine}"
Tap they can answer with: "${tap}"

Sleep hours are last night only. If sleep is null they have not logged the night that just ended. Do not quote older nights. Do not invent hours.

Rewrite that in your voice. Keep the exact numbers. 1-2 short sentences. No markdown, no lists, no hyphens or dashes. No taglines.
End with the tap, so they can answer in one text.
If the computed read is empty or generic, set reachOut false.

topic: a short slug matching the computed topic
card: always null here (the server attaches the card)

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

  if (tick === 'weekly' && input.persona === 'friend') {
    const week = await fetchWeekBundle(input.phone, input.persona)
    if (week?.text) {
      return {
        send: true,
        topic: 'weekly_recap',
        text: week.text.replace(/[\u2013\u2014]/g, ',').replace(/\s+-\s+/g, '. ').slice(0, 700),
        cardKind: week.spendOver ? 'spending_snapshot' : 'weekly_review',
      }
    }
  }

  const insight = pickProactiveInsight(state, tick)
  if (!insight) {
    console.log(`[judgment:${input.persona}] skip ${input.phone}: no insight`)
    return null
  }
  const unansweredToday = Number(state.unansweredToday) || 0
  const unanswered = Number(state.unansweredProactive) || 0
  if (insight.loop === 'interrupt' && unansweredToday > 0 && unanswered > 0) {
    console.log(`[judgment:${input.persona}] skip ${input.phone}: save slot for night`)
    return null
  }
  if (state.lastProactiveTopic && insight.topic === state.lastProactiveTopic && tick !== 'digest' && tick !== 'weekly' && tick !== 'morning') {
    return null
  }

  const fallback = tapHint(insight)
  let decision: JudgeDecision | null = null
  try {
    const raw = await gmiChat({
      temperature: 0.4,
      maxTokens: 180,
      messages: [
        { role: 'system', content: judgePrompt(state, insight.line, insight.tap) },
        { role: 'user', content: `Tick: ${tick}. Rewrite the computed read. JSON only.` },
      ],
    })
    decision = parseDecision(raw)
  } catch (err) {
    console.warn(`[judgment:${input.persona}] llm failed, using computed read`, err)
  }

  let text = (decision?.reachOut && decision.message ? decision.message : fallback)
    .replace(/[\u2013\u2014]/g, ',')
    .replace(/\s+-\s+/g, '. ')
  if (isBannedTagline(text) || !text.trim()) text = fallback
  if (text.length > 420) text = text.slice(0, 417).trim() + '…'

  const attachCard = unanswered === 0 && !!insight.card

  return {
    send: true,
    topic: decision?.topic || insight.topic,
    text,
    cardKind: attachCard ? insight.card : null,
  }
}
