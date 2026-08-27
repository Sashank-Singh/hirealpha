import type { AgentId } from '../../src/agents/types'
import { buildApprovalText, needsApproval } from './proactiveFlavors'

/** Server owned task loops: the bot claims, acts, and reports the outcome.
 * Every claim result is posted back exactly once so a slow send can never
 * double fire a loop, and every proactive send respects the kill switch. */

export interface LoopTask {
  id: string
  phone: string
  kind: string
  title?: string
  next_run?: string
  payload?: Record<string, unknown>
}

export type LoopOutcome = 'done' | 'failed' | 'snoozed'

export interface LoopHandlerResult {
  text?: string
  outcome: LoopOutcome
  next_run?: string
  note?: string
}

export type LoopHandler = (task: LoopTask) => LoopHandlerResult | Promise<LoopHandlerResult>

export interface LoopSendContext {
  persona: string
  send: (phone: string, text: string) => Promise<void>
  /** Injectable for tests. Default posts kill-switch/check. */
  checkKillSwitch?: (phone: string) => Promise<boolean>
  /** Injectable for tests. Default posts loops/result. */
  postResult?: (id: string, result: { outcome: LoopOutcome; note?: string; next_run?: string }) => Promise<void>
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

/** True means armed: no proactive sends to this phone. Unreachable server or
 * missing env means not armed, so a broken check never silences the bot. */
export async function isKillSwitchArmed(phone: string): Promise<boolean> {
  const base = apiBase()
  if (!base) return false
  try {
    const res = await fetch(`${base}/api/internal/kill-switch/check`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ phone }),
    })
    if (!res.ok) return false
    const data = (await res.json()) as { armed?: boolean }
    return data.armed === true
  } catch {
    return false
  }
}

const loggedArmed = new Set<string>()

/** Skip sends quietly after the first warning per phone. */
export async function killSwitchBlocksSend(phone: string): Promise<boolean> {
  const armed = await isKillSwitchArmed(phone)
  if (!armed) return false
  if (!loggedArmed.has(phone)) {
    loggedArmed.add(phone)
    console.warn(`[taskLoops] kill switch armed for ${phone}, skipping sends`)
  }
  return true
}

async function postLoopResult(
  id: string,
  result: { outcome: LoopOutcome; note?: string; next_run?: string },
): Promise<void> {
  const base = apiBase()
  if (!base) return
  try {
    await fetch(`${base}/api/internal/loops/result`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ id, ...result }),
    })
  } catch (err) {
    console.warn(`[taskLoops] result post failed for ${id}`, err)
  }
}

/** Run one claimed loop: gate gated actions, honor the kill switch, send,
 * then post the outcome. The outcome posts even when the send is skipped so
 * the server never re-claims a handled task. */
export async function runLoopTask(task: LoopTask, handler: LoopHandler, ctx: LoopSendContext): Promise<void> {
  const check = ctx.checkKillSwitch || killSwitchBlocksSend
  const post = ctx.postResult || postLoopResult
  try {
    // Gated actions ask first and never execute inside a loop.
    const action = typeof task.payload?.action === 'string' ? task.payload.action : ''
    if (needsApproval(action)) {
      const detail = typeof task.payload?.detail === 'string' ? task.payload.detail : undefined
      const text = buildApprovalText(action, detail)
      if (!(await check(task.phone))) {
        await ctx.send(task.phone, text)
      }
      await post(task.id, { outcome: 'done', note: 'approval requested' })
      return
    }

    const result = await handler(task)
    if (result.text) {
      if (await check(task.phone)) {
        await post(task.id, {
          outcome: 'snoozed',
          note: 'kill switch armed',
          next_run: result.next_run || new Date(Date.now() + 60 * 60 * 1000).toISOString(),
        })
        return
      }
      await ctx.send(task.phone, result.text)
    }
    await post(task.id, { outcome: result.outcome, note: result.note, next_run: result.next_run })
  } catch (err) {
    console.warn(`[taskLoops] ${task.kind} task ${task.id} failed`, err)
    await post(task.id, { outcome: 'failed', note: err instanceof Error ? err.message : String(err) })
      .catch(() => undefined)
  }
}

/* ---- Flight check in ---- */

export interface FlightPayload {
  airline?: string
  flight?: string
  date?: string
  checkin_at?: string
  confirmation_url?: string
}

export interface FlightCheckinTexts {
  announce: string | null
  checkin: string | null
  windowAt: Date | null
}

/** Check in opens 24h before departure unless the payload says otherwise. */
export function buildFlightCheckinTexts(payload: FlightPayload, now: Date): FlightCheckinTexts {
  const explicit = payload.checkin_at ? new Date(payload.checkin_at).getTime() : NaN
  const departure = payload.date ? new Date(payload.date).getTime() : NaN
  const windowMs = Number.isFinite(explicit) ? explicit : Number.isFinite(departure) ? departure - 24 * 60 * 60 * 1000 : NaN
  if (!Number.isFinite(windowMs)) return { announce: null, checkin: null, windowAt: null }
  const windowAt = new Date(windowMs)
  const carrier = [payload.airline, payload.flight].filter(Boolean).join(' ').trim() || 'Your flight'
  if (now.getTime() < windowMs) {
    const h = String(windowAt.getHours()).padStart(2, '0')
    const m = String(windowAt.getMinutes()).padStart(2, '0')
    return {
      announce: `Check in window for ${carrier} opens at ${h}:${m}. I'll ping you.`,
      checkin: null,
      windowAt,
    }
  }
  return {
    announce: null,
    checkin: payload.confirmation_url
      ? `Check in now: ${payload.confirmation_url}`
      : `Check in now on the ${payload.airline || 'airline'} site, the window is open.`,
    windowAt,
  }
}

const flightCheckinHandler: LoopHandler = (task) => {
  const texts = buildFlightCheckinTexts((task.payload || {}) as FlightPayload, new Date())
  if (!texts.windowAt) return { outcome: 'failed', note: 'missing flight details' }
  if (texts.announce) {
    return { text: texts.announce, outcome: 'snoozed', next_run: texts.windowAt.toISOString() }
  }
  return { text: texts.checkin, outcome: 'done' }
}

/* ---- Refund hunter ---- */

export interface MailRow {
  subject?: string
  snippet?: string
  from?: string
  thread?: string
}

const REFUND_TERMS = /\b(refund|credit|rebate|comp)\b/i
const REFUND_DONE = /\brefund (?:processed|issued|completed|sent)\b/i

/** Rows worth chasing: refund flavored, with no processed notice anywhere in
 * the same thread. */
export function scanRefundCandidates(mailRows: MailRow[]): MailRow[] {
  const doneThreads = new Set(
    mailRows
      .filter((r) => REFUND_DONE.test(`${r.subject || ''} ${r.snippet || ''}`))
      .map((r) => r.thread || ''),
  )
  return mailRows.filter((r) => {
    const body = `${r.subject || ''} ${r.snippet || ''}`
    if (!REFUND_TERMS.test(body)) return false
    if (REFUND_DONE.test(body)) return false
    if (r.thread && doneThreads.has(r.thread)) return false
    return true
  })
}

export function buildRefundText(candidates: MailRow[]): string {
  const n = candidates.length
  if (n === 0) return ''
  const first = String(candidates[0]!.subject || 'an email').trim()
  return n === 1
    ? `Spotted a possible refund in your mail: ${first}. Want me to chase it?`
    : `Spotted ${n} possible refunds in your mail, starting with ${first}. Want me to chase them?`
}

/** Ask the server for this phone's mail context; graceful empty when the
 * endpoint or env is missing. */
async function fetchMailContext(phone: string): Promise<MailRow[]> {
  const base = apiBase()
  if (!base) return []
  try {
    const res = await fetch(`${base}/api/internal/mail/context?phone=${encodeURIComponent(phone)}`, {
      headers: authHeaders(),
    })
    if (!res.ok) return []
    const data = (await res.json()) as { mails?: MailRow[] }
    return data.mails || []
  } catch {
    return []
  }
}

const refundHunterHandler: LoopHandler = async (task) => {
  const rows = await fetchMailContext(task.phone)
  const candidates = scanRefundCandidates(rows)
  if (candidates.length === 0) return { outcome: 'done', note: 'no refund candidates' }
  return { text: buildRefundText(candidates), outcome: 'done' }
}

/* ---- Wake up ---- */

/** Text only for now. Real voice call wake ups come later. */
export function buildWakeupText(topItems: string[] = []): string {
  const items = topItems.filter((i) => String(i || '').trim()).slice(0, 2)
  if (items.length === 2) {
    return `Morning. First up, ${items[0]!}. Then ${items[1]!}, and I'll check in tonight.`
  }
  if (items.length === 1) {
    return `Morning. One thing matters today, ${items[0]!}. I'll check in tonight to see how it went.`
  }
  return "Morning. Nothing is on fire, so pick the one thing that matters and start there. I'll check in tonight."
}

const wakeupHandler: LoopHandler = (task) => {
  const raw = task.payload?.top_items
  const items = Array.isArray(raw) ? (raw as unknown[]).map(String) : []
  return { text: buildWakeupText(items), outcome: 'done' }
}

/* ---- Registry ---- */

export const LOOP_HANDLERS: Record<string, LoopHandler> = {
  flight_checkin: flightCheckinHandler,
  refund_hunter: refundHunterHandler,
  wakeup: wakeupHandler,
}

/**
 * Poll loops/claim for this persona and run each claimed task through its
 * handler. Missing env keeps it off, same as the intro poller.
 */
export function startTaskLoopPoller(opts: {
  persona: AgentId | string
  send: (phone: string, text: string) => Promise<void>
  /** Per kind handler overrides merged over the seeded registry. */
  runKind?: Record<string, LoopHandler>
  pollMs?: number
}) {
  const pollMs = opts.pollMs ?? 60_000
  const base = apiBase()
  if (!base || !process.env.HIREALPHA_INTERNAL_KEY) {
    console.log(`[taskLoops:${opts.persona}] off: HIREALPHA_API_URL or HIREALPHA_INTERNAL_KEY missing`)
    return
  }
  const handlers = { ...LOOP_HANDLERS, ...(opts.runKind || {}) }

  const tick = async () => {
    let tasks: LoopTask[] = []
    try {
      const res = await fetch(
        `${base}/api/internal/loops/claim?persona=${encodeURIComponent(String(opts.persona))}`,
        { headers: authHeaders() },
      )
      if (!res.ok) return
      const data = (await res.json()) as { loops?: LoopTask[] }
      tasks = data.loops || []
    } catch (err) {
      console.warn(`[taskLoops:${opts.persona}] claim failed`, err)
      return
    }
    for (const task of tasks) {
      if (!task || !task.id || !task.phone) continue
      const handler = handlers[task.kind]
      if (!handler) {
        await postLoopResult(task.id, { outcome: 'failed', note: `no handler for ${task.kind}` })
        continue
      }
      await runLoopTask(task, handler, { persona: String(opts.persona), send: opts.send })
    }
  }

  const run = () => {
    tick().catch((err) => console.warn(`[taskLoops:${opts.persona}] tick failed`, err))
  }
  run()
  const timer = setInterval(run, pollMs)
  timer.unref?.()
  console.log(`[taskLoops:${opts.persona}] started every ${pollMs / 1000}s`)
}
