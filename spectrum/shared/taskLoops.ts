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
  /** The person's home IANA timezone; used to detect a cross-zone flight. */
  home_tz?: string
  /** Destination city or region in plain text (already timezone-resolved by
   * the caller). Only drives the landing re-time note. */
  destination?: string
  /** Destination IANA timezone when known. */
  destination_tz?: string
}

export interface FlightCheckinTexts {
  announce: string | null
  checkin: string | null
  windowAt: Date | null
}

/** Known city/region → IANA zone for the landing re-time note. The carrier
 * payload normally carries an explicit destination_tz; this map only rescues
 * flights booked without one. Intentionally short: unresolvable stays null. */
const DESTINATION_TZ: Record<string, string> = {
  tokyo: 'Asia/Tokyo', osaka: 'Asia/Tokyo', kyoto: 'Asia/Tokyo',
  paris: 'Europe/Paris', london: 'Europe/London', barcelona: 'Europe/Madrid',
  madrid: 'Europe/Madrid', rome: 'Europe/Rome', berlin: 'Europe/Berlin',
  amsterdam: 'Europe/Amsterdam', dubai: 'Asia/Dubai', singapore: 'Asia/Singapore',
  nyc: 'America/New_York', 'new york': 'America/New_York',
  'san francisco': 'America/Los_Angeles', sf: 'America/Los_Angeles',
  la: 'America/Los_Angeles', 'los angeles': 'America/Los_Angeles',
  bali: 'Asia/Makassar', sydney: 'Australia/Sydney',
  'mexico city': 'America/Mexico_City', bangkok: 'Asia/Bangkok',
  'hong kong': 'Asia/Hong_Kong', seoul: 'Asia/Seoul',
  honolulu: 'Pacific/Honolulu', maui: 'Pacific/Honolulu',
}

function isValidZone(tz: string | undefined): tz is string {
  if (!tz) return false
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz }).format()
    return true
  } catch {
    return false
  }
}

/** UTC offset in minutes for a zone at an instant; NaN on any failure. */
function zoneOffsetMinutes(tz: string, at: Date): number {
  try {
    const fmt = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      timeZoneName: 'longOffset',
    })
    const name = fmt.formatToParts(at).find((p) => p.type === 'timeZoneName')?.value || ''
    const m = name.match(/GMT([+-])(\d{2}):(\d{2})/)
    if (!m) return NaN
    const sign = m[1] === '-' ? -1 : 1
    return sign * (Number(m[2]) * 60 + Number(m[3]))
  } catch {
    return NaN
  }
}

/** Resolve the destination zone from an explicit tz or a known city name. */
export function resolveDestinationZone(payload: FlightPayload): string | null {
  if (isValidZone(payload.destination_tz)) return payload.destination_tz
  const dest = String(payload.destination || '').trim().toLowerCase()
  if (!dest) return null
  return DESTINATION_TZ[dest] || null
}

/** True when the flight lands somewhere that runs on a different clock than
 * home: both zones resolvable and their offsets differ at the flight date. */
export function flightCrossesTimezones(payload: FlightPayload, at: Date): boolean {
  const home = payload.home_tz
  const dest = resolveDestinationZone(payload)
  if (!isValidZone(home) || !dest) return false
  if (home === dest) return false
  const homeOffset = zoneOffsetMinutes(home, at)
  const destOffset = zoneOffsetMinutes(dest, at)
  return Number.isFinite(homeOffset) && Number.isFinite(destOffset) && homeOffset !== destOffset
}

/** Warm one-liner appended to the check-in text when the trip lands in another
 * timezone: briefs and pings re-time to destination local time after landing.
 * Nothing here schedules or reschedules — the scheduler already shifts on the
 * stored travel_tz; this is the heads-up the person actually sees. */
export function flightLandingRetimeNote(payload: FlightPayload, at: Date): string {
  const dest = resolveDestinationZone(payload)
  if (!flightCrossesTimezones(payload, at) || !dest) return ''
  // Name the destination clock in plain words, city first.
  const city = String(payload.destination || '').trim()
  const place = city || dest.split('/').pop()?.replace(/_/g, ' ') || dest
  return `After you land, I will move briefs and reminders to ${place} time.`
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
  const base = payload.confirmation_url
    ? `Check in now: ${payload.confirmation_url}`
    : `Check in now on the ${payload.airline || 'airline'} site, the window is open.`
  const retime = flightLandingRetimeNote(payload, windowAt)
  let checkin = base
  if (retime) {
    checkin = /[.!?]$/.test(base) ? `${base} ${retime}` : `${base}. ${retime}`
  }
  return {
    announce: null,
    checkin,
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

/* ---- Trial ending (backlog #58) ----
 * The server arms a trial_ending loop for each subscription whose trial is
 * within the window (see armTrialEndingLoops in deploy/hire-api.ts). Fact
 * triggered only: the handler never guesses a trial date, it reads
 * payload.trial_end. One nudge per trial: the arm scan skips rows already
 * sent (done with a matching marker) so a re-run never double texts. */

export interface TrialEndingPayload {
  trial_end?: string
  tier?: string
  tz?: string
}

/** Weekday (e.g. "Thursday") the trial ends, in the user's zone when given.
 * Falls back to the product default zone (America/Los_Angeles) so a missing
 * tz still yields the true calendar weekday, never a guess. */
export function trialEndWeekday(payload: TrialEndingPayload): string | null {
  const end = payload.trial_end ? new Date(payload.trial_end) : null
  if (!end || Number.isNaN(end.getTime())) return null
  const zone = payload.tz && isValidZone(payload.tz) ? payload.tz : 'America/Los_Angeles'
  try {
    return new Intl.DateTimeFormat('en-US', { weekday: 'long', timeZone: zone }).format(end)
  } catch {
    return new Intl.DateTimeFormat('en-US', { weekday: 'long', timeZone: 'America/Los_Angeles' }).format(end)
  }
}

export function buildTrialEndingText(payload: TrialEndingPayload): string {
  const weekday = trialEndWeekday(payload)
  if (!weekday) return ''
  const tier = String(payload.tier || '').trim()
  const what = tier ? `Your ${tier} trial` : 'Your trial'
  return `${what} ends ${weekday}. Keep it or cancel?`
}

const trialEndingHandler: LoopHandler = (task) => {
  const payload = (task.payload || {}) as TrialEndingPayload
  const text = buildTrialEndingText(payload)
  if (!text) return { outcome: 'failed', note: 'missing trial_end payload' }
  const marker = (payload.trial_end || '').slice(0, 10)
  return { text, outcome: 'done', note: `trial_ending sent ${marker}` }
}

/* ---- Recurring bill went up (backlog #62) ----
 * Fact triggered only. There is no recurring-bill price history wired yet
 * (composio/plaid transactions or a similar source), so this handler never
 * invents an increase. It consumes a future `increases` payload when a real
 * data source lands; without one it no-ops with a console note. */

export interface BillIncreaseHit {
  merchant: string
  /** Previous charge amount; omitted when only the new price is known. */
  from?: number
  to: number
  period?: string
}

export function buildBillIncreaseText(hits: BillIncreaseHit[]): string {
  const n = hits.length
  if (n === 0) return ''
  const first = hits[0]!
  const merchant = String(first.merchant || 'a recurring bill').trim()
  const delta =
    first.from != null && Number.isFinite(first.from)
      ? ` from $${first.from} to $${first.to}`
      : ` to $${first.to}`
  return n === 1
    ? `${merchant} went up${delta}. Want me to draft the negotiation?`
    : `${n} recurring bills went up, starting with ${merchant}${delta}. Want me to draft the negotiation?`
}

function parseBillIncreaseHits(raw: unknown): BillIncreaseHit[] {
  if (!Array.isArray(raw)) return []
  const hits: BillIncreaseHit[] = []
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue
    const o = item as Record<string, unknown>
    const to = Number(o['to'])
    if (!Number.isFinite(to) || to <= 0) continue
    const from = o['from'] == null ? undefined : Number(o['from'])
    hits.push({
      merchant: String(o['merchant'] || '').trim().slice(0, 60),
      ...(from != null && Number.isFinite(from) ? { from } : {}),
      to,
      period: o['period'] == null ? undefined : String(o['period']).slice(0, 20),
    })
  }
  return hits
}

const billIncreaseHandler: LoopHandler = (task) => {
  const hits = parseBillIncreaseHits(task.payload?.increases)
  if (hits.length > 0) {
    return {
      text: buildBillIncreaseText(hits),
      outcome: 'done',
      note: `bill_increase ${hits.length} hit${hits.length === 1 ? '' : 's'}`,
    }
  }
  console.warn(
    `[taskLoops] bill_increase has no recurring-bill price-change data source wired yet, skipping a real text for ${task.phone}`,
  )
  return { outcome: 'done', note: 'bill_increase not wired: no price-change data source' }
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
  trial_ending: trialEndingHandler,
  bill_increase: billIncreaseHandler,
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
