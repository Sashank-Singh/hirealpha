import type { AgentId } from '../../src/agents/types'
import { PROACTIVE_POLL_MS } from './delivery'
import { fetchJudgmentState, inQuietHours, isRecipientSendBlocked } from './judgment'
import { buildApprovalText, needsApproval, pickFlavor } from './proactiveFlavors'
import { buildCommitmentRescueText } from './commitmentRescue'

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
  persona?: AgentId
}

export type LoopOutcome = 'done' | 'failed' | 'snoozed'

export interface LoopHandlerResult {
  text?: string
  outcome: LoopOutcome
  next_run?: string
  note?: string
  /** Replacement payload stored with the loop on re-arm (e.g. decrementing a
   * remaining-runs counter so a watch cannot run forever). */
  nextPayload?: Record<string, unknown>
  /** Screenshot to deliver with the text, as a data URL. Browser runs only. */
  image?: { dataUrl: string; caption?: string }
}
export type LoopHandler = (task: LoopTask) => LoopHandlerResult | Promise<LoopHandlerResult>

/** A screenshot the loop wants delivered with its text, as a data URL
 * (`data:image/jpeg;base64,...`). Only browser runs produce these: the worker
 * captures the page it is looking at, and "here is what I'm seeing" is the
 * difference between a user trusting the run and guessing at it. */
export type LoopImage = { dataUrl: string; caption?: string }

export interface LoopSendContext {
  persona: string
  send: (phone: string, text: string, image?: LoopImage) => Promise<void>
  /** Injectable for tests. Default posts kill-switch/check. */
  checkKillSwitch?: (phone: string) => Promise<boolean>
  /** Injectable for tests. Default reads judgment state. Returns true when the
   * send must wait for the quiet window to close. */
  checkQuietHours?: (task: LoopTask) => Promise<boolean>
  /** Injectable for tests. Default posts loops/result. */
  postResult?: (id: string, result: { outcome: LoopOutcome; note?: string; next_run?: string; payload?: Record<string, unknown> }) => Promise<void>
}

/** Kinds whose text is a direct answer to something the user did (a browser
 * run they launched, an onboarding welcome) — holding those until morning
 * would break a promise instead of respecting a boundary. Every other loop is
 * a discretionary touch and waits out quiet hours. */
const QUIET_EXEMPT_KINDS = new Set([
  'browser_result',
  /* browser_watch is NOT here: it used to be, and every routine tick texted
   * "Scheduled check ran for …" every six hours including 5am. A watch reports
   * its finding through the run's own result, so its remaining texts are
   * failures and the end of its run — discretionary, and held at night. */
  'onboard_done',
  'save_contact',
])

/** Imminent flights are the one time-critical case: a gate/delay ping that
 * waits for morning is worthless, so a departure inside 3 hours is exempt
 * from the quiet hold (it is still subject to the kill switch). */
export function taskObeysQuietHours(task: LoopTask, now = new Date()): boolean {
  if (QUIET_EXEMPT_KINDS.has(task.kind)) return false
  if (task.kind === 'flight_checkin') {
    const payload = parseLoopPayload(task.payload) as { date?: unknown }
    const depart = new Date(String(payload.date || '')).getTime()
    const delta = depart - now.getTime()
    if (Number.isFinite(depart) && delta >= 0 && delta <= 3 * 3_600_000) return false
  }
  return true
}

/** Quiet-hours hold for one loop. Fail-open on a state fetch failure: an
 * unknown clock must not mute every scheduled text forever, while the kill
 * switch (a stop request) stays fail-closed because that one is an order. */
export async function quietHoursHoldForTask(task: LoopTask, persona: string): Promise<boolean> {
  if (!taskObeysQuietHours(task)) return false
  try {
    const state = await fetchJudgmentState(task.phone, persona as AgentId, 'judge')
    if (!state) return false
    return inQuietHours(state.localTime, state.quietHours)
  } catch {
    return false
  }
}

function apiBase() {
  return (process.env.HIREALPHA_API_URL || '').replace(/\/$/, '')
}

function authHeaders() {
  return {
    Authorization: `Bearer ${process.env.HIREALPHA_INTERNAL_KEY || ''}`,
    Accept: 'application/json',
    'Content-Type': 'application/json',
    // Fresh connection per call: a reused keep-alive socket the server closed
    // shows up as a DOMException timeout and the whole poll cycle is skipped.
    Connection: 'close',
  }
}

/** Unknown stop-switch state blocks proactive sends until it can be checked. */
export async function isKillSwitchArmed(phone: string): Promise<boolean> {
  const base = apiBase()
  if (!base || !process.env.HIREALPHA_INTERNAL_KEY) return true
  try {
    const res = await fetch(`${base}/api/internal/kill-switch/check`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ phone }),
      signal: AbortSignal.timeout(5000),
    })
    if (!res.ok) return true
    const data = (await res.json()) as { armed?: boolean }
    return data.armed !== false
  } catch {
    return true
  }
}

const loggedArmed = new Set<string>()

/**
 * Coerce a claimed loop's payload into the object every handler expects.
 *
 * Postgres `jsonb` comes back from the API as a JSON *string* (Bun SQL does
 * not parse jsonb), so `task.payload?.text` on a browser_result was silently
 * undefined: the user got the generic "Browser task finished." fallback and
 * the screenshot was dropped. Parse it once on the way in; anything
 * unparseable becomes {} rather than crashing the send.
 */
export function parseLoopPayload(raw: unknown): Record<string, unknown> {
  let value: unknown = raw
  // Two peels: one for the JSON-string jsonb representation, a second for a
  // double-encoded jsonb string scalar an older driver version could store.
  for (let depth = 0; depth < 2; depth++) {
    if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>
    if (typeof value !== 'string' || !value.trim()) return {}
    try {
      value = JSON.parse(value)
    } catch {
      return {}
    }
  }
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

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
  result: { outcome: LoopOutcome; note?: string; next_run?: string; payload?: Record<string, unknown> },
): Promise<void> {
  const base = apiBase()
  if (!base) return
  // The send already happened by the time this runs. A swallowed ack leaves
  // the task 'running' until lease expiry, where the retry re-sends it — a
  // duplicate to the user. Retry the ack with backoff before giving up; each
  // failure is loud because the next tick WILL duplicate the send.
  const delays = [0, 2_000, 8_000, 20_000]
  let lastErr: unknown
  for (const wait of delays) {
    if (wait) await new Promise((r) => setTimeout(r, wait))
    try {
      const res = await fetch(`${base}/api/internal/loops/result`, {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({ id, ...result }),
        signal: AbortSignal.timeout(8000),
      })
      if (!res.ok) throw new Error(`Loop acknowledgement returned HTTP ${res.status}`)
      return
    } catch (err) {
      lastErr = err
      console.warn(`[taskLoops] result post failed for ${id} (will retry)`, err)
    }
  }
  console.error(`[taskLoops] result post EXHAUSTED for ${id} — task may re-send:`, lastErr)
}

/** Run one claimed loop: gate gated actions, honor the kill switch, send,
 * then post the outcome. The outcome posts even when the send is skipped so
 * the server never re-claims a handled task. */
export async function runLoopTask(task: LoopTask, handler: LoopHandler, ctx: LoopSendContext): Promise<void> {
  const check = ctx.checkKillSwitch || killSwitchBlocksSend
  const post = ctx.postResult || postLoopResult
  try {
    // Claimed payloads arrive as JSON strings (see parseLoopPayload); every
    // kind reads fields off the object, so normalize before gating/handling.
    task.payload = parseLoopPayload(task.payload)
    // Gated actions ask first and never execute inside a loop.
    const action = typeof task.payload?.action === 'string' ? task.payload.action : ''
    if (needsApproval(action)) {
      const detail = typeof task.payload?.detail === 'string' ? task.payload.detail : undefined
      const text = buildApprovalText(action, detail)
      if (await check(task.phone)) {
        await post(task.id, { outcome: 'snoozed', note: 'kill switch armed', next_run: new Date(Date.now() + 60 * 60 * 1000).toISOString() })
        return
      }
      /* An approval request is still an unprompted text: this branch used to
       * send before the quiet-hours check below, so a queued approval could
       * land at 3am. It holds the same way every other discretionary loop text
       * does — the ask does not expire because the night passed. */
      const approvalQuiet = ctx.checkQuietHours || ((t: LoopTask) => quietHoursHoldForTask(t, String(ctx.persona || t.persona || '')))
      if (await approvalQuiet(task)) {
        console.log(`[taskLoops] ${task.kind} approval held for quiet hours ${task.phone}`)
        await post(task.id, { outcome: 'snoozed', note: 'quiet hours', next_run: new Date(Date.now() + 90 * 60 * 1000).toISOString() })
        return
      }
      await ctx.send(task.phone, text)
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
      // Discretionary loop texts hold through quiet hours. The handler already
      // ran (its window math is stored nowhere else), so re-run on the next
      // claim after the hold; 90 minutes keeps re-checks cheap and cannot
      // outlast a normal night.
      const quietCheck = ctx.checkQuietHours || ((t: LoopTask) => quietHoursHoldForTask(t, String(ctx.persona || t.persona || '')))
      if (await quietCheck(task)) {
        console.log(`[taskLoops] ${task.kind} held for quiet hours ${task.phone}`)
        await post(task.id, {
          outcome: 'snoozed',
          note: 'quiet hours',
          next_run: new Date(Date.now() + 90 * 60 * 1000).toISOString(),
        })
        return
      }
      await ctx.send(task.phone, result.text, result.image)
    }
    await post(task.id, {
      outcome: result.outcome, note: result.note, next_run: result.next_run,
      ...(result.nextPayload ? { payload: result.nextPayload } : {}),
    })
  } catch (err) {
    console.warn(`[taskLoops] ${task.kind} task ${task.id} failed`, err)
    // A recipient the carrier line is refusing (new-contact cap, blocked
    // target) is not a transient failure: re-arming in seconds turns one dead
    // contact into a log flood and wasted sends. Snooze half a day; a reply
    // from them re-opens the door naturally.
    if (isRecipientSendBlocked(err)) {
      await post(task.id, {
        outcome: 'snoozed',
        note: 'recipient send blocked — waiting for their reply',
        next_run: new Date(Date.now() + 12 * 60 * 60 * 1000).toISOString(),
      }).catch(() => undefined)
      return
    }
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

/** Airline check-in pages, by carrier name or IATA code. A reminder that says
 * "check in on the Delta site" without the page leaves the person (and the
 * browser run) to find it; the scored travel tasks both end at this link. */
const AIRLINE_CHECKIN: Record<string, string> = {
  delta: 'https://www.delta.com/checkin', dl: 'https://www.delta.com/checkin',
  united: 'https://www.united.com/en/us/checkin', ua: 'https://www.united.com/en/us/checkin',
  american: 'https://www.aa.com/checkin', 'american airlines': 'https://www.aa.com/checkin', aa: 'https://www.aa.com/checkin',
  southwest: 'https://www.southwest.com/air/check-in/', wn: 'https://www.southwest.com/air/check-in/',
  alaska: 'https://www.alaskaair.com/checkin', as: 'https://www.alaskaair.com/checkin',
  jetblue: 'https://www.jetblue.com/check-in', b6: 'https://www.jetblue.com/check-in',
  spirit: 'https://www.spirit.com/check-in', nk: 'https://www.spirit.com/check-in',
  frontier: 'https://www.flyfrontier.com/check-in', f9: 'https://www.flyfrontier.com/check-in',
}

/** The carrier's own check-in page from the payload, or null. */
export function airlineCheckinUrl(payload: FlightPayload): string | null {
  const name = String(payload.airline || '').trim().toLowerCase()
  if (AIRLINE_CHECKIN[name]) return AIRLINE_CHECKIN[name]!
  const code = String(payload.flight || '').trim().split(/\s+/)[0]?.toLowerCase() || ''
  return AIRLINE_CHECKIN[code] || null
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
  const checkinUrl = payload.confirmation_url || airlineCheckinUrl(payload)
  const base = checkinUrl
    ? `Check in now: ${checkinUrl}`
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
  return { ...(texts.checkin ? { text: texts.checkin } : {}), outcome: 'done' }
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
 * endpoint or env is missing. The route names the array `mail`; reading
 * `mails` here silently returned nothing and the refund hunter never found a
 * candidate for anyone. Accept either key so a rename cannot do that again. */
async function fetchMailContext(phone: string): Promise<MailRow[]> {
  const base = apiBase()
  if (!base) return []
  try {
    const res = await fetch(`${base}/api/internal/mail/context?phone=${encodeURIComponent(phone)}`, {
      headers: authHeaders(),
    })
    if (!res.ok) return []
    const data = (await res.json()) as { mail?: MailRow[]; mails?: MailRow[] }
    return data.mail || data.mails || []
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
export function buildWakeupText(topItems: string[] = [], seed = ''): string {
  const items = topItems.filter((i) => String(i || '').trim()).slice(0, 2)
  if (items.length === 2) {
    return pickFlavor([
      `Morning. First up, ${items[0]!}. Then ${items[1]!}, and I'll check in tonight.`,
      `Morning. Two things today: ${items[0]!}, then ${items[1]!}. I'll ask how it went tonight.`,
      `Morning. ${items[0]!} first, ${items[1]!} after. Check in later.`,
    ], seed, 11)
  }
  if (items.length === 1) {
    return pickFlavor([
      `Morning. One thing matters today, ${items[0]!}. I'll check in tonight to see how it went.`,
      `Morning. Today it's just ${items[0]!}. Nothing else needs you. I'll ask tonight.`,
      `Morning. ${items[0]!} is the whole list today. Check in tonight.`,
    ], seed, 12)
  }
  return pickFlavor([
    "Morning. Nothing is on fire, so pick the one thing that matters and start there. I'll check in tonight.",
    "Morning. Clear day. Pick the one thing that matters and start there. I'll check in tonight.",
    "Morning. Nothing urgent. Pick one thing worth doing and go. I'll ask about it tonight.",
  ], seed, 13)
}

/* ---- Calendar defense ----
 * The server arms this the evening before a day that has clashes, tight
 * turnarounds or a first-thing meeting worth prepping, and puts the analysis in
 * the payload (`analyzeDayDefense`). It shipped with NO handler here, so every
 * armed row failed five attempts and nobody was ever told — the arming was real
 * and the warning was not. The payload carries everything the text needs, so
 * this is a pure formatter: one text, then the loop retires (tomorrow's arming
 * creates a fresh one). */
export function buildDayDefenseText(payload: {
  date?: unknown
  conflicts?: unknown
  tights?: unknown
  prep?: unknown
  firstOut?: unknown
}): string {
  const day = String(payload.date || '').trim()
  const conflicts = Array.isArray(payload.conflicts) ? payload.conflicts : []
  const tights = Array.isArray(payload.tights) ? payload.tights : []
  const prep = (payload.prep || null) as { title?: string; time?: string; who?: string; place?: string } | null
  const firstOut = (payload.firstOut || null) as { title?: string; time?: string; place?: string } | null
  const lines: string[] = []
  for (const raw of conflicts.slice(0, 2)) {
    const c = raw as { a?: string; b?: string }
    if (c?.a && c?.b) lines.push(`${c.a} overlaps ${c.b}.`)
  }
  for (const raw of tights.slice(0, 2)) {
    const t = raw as { from?: string; to?: string; gapMin?: number }
    if (t?.from && t?.to) lines.push(`${t.from} to ${t.to} is only ${t.gapMin} minutes.`)
  }
  const head = conflicts.length || tights.length
    ? `Tomorrow needs a look${day ? ` (${day})` : ''}:`
    : `One thing about tomorrow${day ? ` (${day})` : ''}:`
  if (firstOut?.title) lines.push(`First out: ${firstOut.title}${firstOut.time ? ` at ${firstOut.time}` : ''}${firstOut.place ? `, ${firstOut.place}` : ''}.`)
  if (prep?.title) lines.push(`Worth prep: ${prep.title}${prep.time ? ` at ${prep.time}` : ''}${prep.who ? ` with ${prep.who}` : ''}.`)
  if (!lines.length) return ''
  return `${head}\n\n${lines.join('\n')}`
}

const dayDefenseHandler: LoopHandler = (task) => {
  const text = buildDayDefenseText((task.payload || {}) as Record<string, unknown>)
  // A payload with nothing to say must not become an empty text.
  return { text, outcome: 'done' }
}

const wakeupHandler: LoopHandler = (task) => {
  const raw = task.payload?.top_items
  const items = Array.isArray(raw) ? (raw as unknown[]).map(String) : []
  return { text: buildWakeupText(items, task.phone), outcome: 'done' }
}

/* ---- Birthday reminder (#33) ----
 * Server arms one birthday_reminder loop per (user, today) when any of their
 * contacts shares today's month-day in the user's zone. The handler asks the
 * server which contacts match and texts once per person, never the whole
 * list. A short marker in the loop's last_result keeps dedupe honest across
 * rerun. */

async function fetchLoopContext(
  phone: string,
  kind: string,
  extra?: Record<string, string>,
): Promise<Record<string, unknown>> {
  const base = apiBase()
  if (!base) return {}
  const qs = new URLSearchParams({ phone, kind })
  for (const [k, v] of Object.entries(extra || {})) qs.set(k, v)
  try {
    const res = await fetch(`${base}/api/internal/loops/context?${qs.toString()}`, {
      headers: authHeaders(),
    })
    if (!res.ok) return {}
    const body = (await res.json()) as { data?: Record<string, unknown> }
    return body.data || {}
  } catch {
    return {}
  }
}

export function buildBirthdayText(name: string): string {
  const safe = String(name || '').trim().split(/\s+/)[0] || 'them'
  return `It's ${safe}'s birthday. Want a card idea or a call?`
}

const birthdayReminderHandler: LoopHandler = async (task) => {
  const date = String(task.payload?.date || '').trim()
  const data = await fetchLoopContext(task.phone, 'birthday_reminder', date ? { date } : {})
  const people = Array.isArray(data.people) ? (data.people as Array<{ id: string; name: string }>) : []
  if (people.length === 0) return { outcome: 'done', note: 'no birthday matches' }
  const first = people[0]!
  const text = buildBirthdayText(first.name)
  const remaining = people.length - 1
  const note = remaining > 0
    ? `birthday ${first.id.slice(0, 8)}${remaining > 0 ? ` +${remaining} more` : ''}`
    : `birthday ${first.id.slice(0, 8)}`
  return { text, outcome: 'done', note }
}

/* ---- Memory resurface ----
 * Seeded weekly for every account, but the handler was missing so every run
 * died as "no handler" and the user never heard from it. Now the server picks
 * the durable memory untouched longest; no stale memory = silent run, never a
 * filler text. */

export function buildMemoryResurfaceText(value: string, seed = ''): string {
  const v = String(value || '').trim().replace(/\s+/g, ' ')
  if (!v) return ''
  const short = v.length > 80 ? `${v.slice(0, 77).trimEnd()}…` : v
  return pickFlavor([
    `You told me to keep this: "${short}". Still true, or can I let it go?`,
    `Old note of yours: "${short}". Still a thing, or should I drop it?`,
    `You once told me: "${short}". Still true? Happy to let it go if not.`,
  ], seed, 21)
}

const memoryResurfaceHandler: LoopHandler = async (task) => {
  const data = await fetchLoopContext(task.phone, 'memory_resurface')
  const mem = (data.memory || null) as { key?: string; value?: string; updatedAt?: string } | null
  const value = String(mem?.value || '').trim()
  if (!value) return { outcome: 'done', note: 'memory_resurface nothing stale to resurface' }
  const text = buildMemoryResurfaceText(value, task.phone)
  if (!text) return { outcome: 'done', note: 'memory_resurface empty value' }
  const when = mem?.updatedAt ? ` ${String(mem.updatedAt).slice(0, 10)}` : ''
  return { text, outcome: 'done', note: `memory_resurface ${String(mem?.key || '').slice(0, 30)}${when}` }
}

/* ---- Streak ended (#25) ----
 * Server finds habits with a past streak of at least 21 days where the user
 * has not logged in 3+ days, and arms a single row per (user, habit). The
 * handler trusts the payload the server wrote: streak count, last logged
 * date, and habit name. No data call needed; one warm text, no shame. */

export function buildStreakEndedText(habitName: string, streak: number, seed = ''): string {
  const name = String(habitName || '').trim() || 'your habit'
  const n = Math.max(1, Math.floor(Number(streak) || 0))
  return pickFlavor([
    `You went ${n} days on ${name} and stopped. That was a real run. New target or a break?`,
    `${n} days on ${name}, then a stop. Real run either way. New target, or a break?`,
    `${n} straight days on ${name}. That counted. Want a new target or a break?`,
  ], seed, 31)
}

const streakEndedHandler: LoopHandler = (task) => {
  const streak = Math.max(1, Math.floor(Number(task.payload?.streak) || 0))
  const habitName = String(task.payload?.habitName || '').trim()
  const lastDate = String(task.payload?.lastDate || '').trim()
  const text = buildStreakEndedText(habitName, streak, task.phone)
  const note = lastDate ? `streak_ended ${habitName.slice(0, 30)} ${lastDate}` : `streak_ended ${habitName.slice(0, 30)}`
  return { text, outcome: 'done', note }
}

/* ---- Overwork check (#48/#80) ----
 * Server arms a row once it sees clear late-evidence (4+ distinct log touches
 * after 8pm in the user's zone, or any inbound after 8pm). The handler stays
 * conservative: if the server armed it, send the warm acknowledgment. If the
 * arming side ever lies, the text is still small and never shaming. */

export function buildOverworkText(seed = ''): string {
  return pickFlavor([
    'You have been at it late. That is load, not laziness. What can wait till tomorrow?',
    'Late night again. That is load, not laziness. What can slide to tomorrow?',
    'You are still going. That is a lot of load, not a character flaw. What can wait till morning?',
  ], seed, 41)
}

const overworkCheckHandler: LoopHandler = (task) => {
  const note = `overwork_check ${String(task.payload?.date || '').trim()}`
  return { text: buildOverworkText(task.phone), outcome: 'done', note }
}

/* ---- Cross-domain quiet check (#93) ----
 * Server arms when the user has gone silent on every surface (no inbound, no
 * habit/nutrition/workout/spend logs) for 3+ days but was previously active.
 * One warm text per quiet window; the marker in the payload is the window
 * start, not the day, so the bot can stay quiet across multiple silent days
 * without a follow-up. */

export function buildQuietCheckText(seed = ''): string {
  return pickFlavor([
    "You've gone quiet everywhere this week, not just one thing. Everything ok?",
    'Quiet on every front this week, not just the usual one. You good?',
    "Haven't heard from you anywhere this week. Everything ok?",
  ], seed, 51)
}

const quietCheckHandler: LoopHandler = (task) => {
  const windowStart = String(task.payload?.windowStart || '').trim()
  const note = windowStart ? `quiet_check ${windowStart}` : 'quiet_check'
  return { text: buildQuietCheckText(task.phone), outcome: 'done', note }
}

/* ---- Save-contact nudge ----
 * The server arms one of these per (user, persona) after the intro lands.
 * Bots that override it (friend) send the native card; everyone else
 * sends the plain-text nudge so the task never fails with "no handler". */

export function buildSaveContactText(seed = ''): string {
  return pickFlavor([
    "If you haven't saved my number yet, add it to your contacts so I always reach you.",
    "Save my number when you get a sec, so I'm not just some unknown texter.",
    "Worth adding me to your contacts, otherwise I show up as a stranger every time.",
  ], seed, 61)
}

const saveContactHandler: LoopHandler = (task) => {
  return { text: buildSaveContactText(task.phone), outcome: 'done', note: 'save_contact' }
}

/* ---- Day-1 check-in ----
 * Enqueued by scheduleDay1Checkin 24h after a successful intro. Previously no
 * bot registered this kind, so every one failed with "no handler". */

export function buildDay1CheckinText(seed = ''): string {
  return pickFlavor([
    'Day one check-in: how are we doing so far? Anything you want me to start tracking for you?',
    'First day in. How is it going so far? Anything you want me to start keeping track of?',
    'Checking in on day one. How are we doing, and is there anything I should start tracking?',
  ], seed, 71)
}

const day1CheckinHandler: LoopHandler = (task) => {
  return { text: buildDay1CheckinText(task.phone), outcome: 'done', note: 'day1_checkin' }
}

/* ---- Inbox ping (watchtower) ----
 * Payload carries the single confirmed hit: { mailId, from, subject, why, kind }.
 * Empty payload resolves done with no send so the server never re-claims. */

/** "Priya Sharma <priya@acme.com>" reads as a person; the address does not. A
 * bare address is kept whole — "billing" alone is worse than the domain that
 * makes it identifiable. */
export function senderDisplayName(from: string): string {
  const raw = String(from || '').trim()
  if (!raw) return ''
  const named = raw.replace(/<[^>]*>/g, '').replace(/"/g, '').trim()
  if (named) return named
  return raw.replace(/[<>]/g, '').trim()
}

/** What Alpha can actually do about each kind, offered only when it fits. A
 * ping that ends in an offer is a request for a decision; one that ends in a
 * period is a notification the user has to carry alone. */
const PING_OFFERS: Record<string, string[]> = {
  reply: ['Want the reply drafted?', 'Should I draft something back?'],
  money: ['Want me to pull up the details?', 'Want me to look at what it is?'],
  assessment: ['Want me to check the deadline and what it wants?', 'Should I open it and tell you what it needs?'],
  travel: ['Want it on your calendar?', 'Should I put it on your calendar?'],
}

function sentenceCase(text: string): string {
  const t = String(text || '').trim().replace(/[.\s]+$/, '')
  if (!t) return ''
  return `${t.charAt(0).toUpperCase()}${t.slice(1)}.`
}

/**
 * One confirmed email, three lines at most: who and what, why it matters, and
 * what Alpha can do about it. The reason line is the whole point — a ping with
 * no reason is indistinguishable from a notification the user did not ask for.
 */
export function buildInboxPingText(p: {
  from: string
  subject: string
  why: string
  kind?: string
  /** Stable per mail, so a retry sends the same wording. */
  seed?: string
}): string {
  const who = senderDisplayName(p.from) || 'Someone'
  const subj = String(p.subject || '').trim()
  const head = subj ? `${who} · ${subj}` : who
  const why = sentenceCase(p.why)
  const offers = PING_OFFERS[String(p.kind || '').trim().toLowerCase()] || []
  const offer = pickFlavor(offers, String(p.seed || ''), 81)
  return [head, why, offer].filter(Boolean).join('\n')
}

const inboxPingHandler: LoopHandler = (task) => {
  const p = (task.payload || {}) as { mailId?: unknown; from?: unknown; subject?: unknown; why?: unknown; kind?: unknown }
  const mailId = String(p.mailId || '').trim()
  if (!mailId) return { outcome: 'done', note: 'inbox_ping empty' }
  return {
    text: buildInboxPingText({
      from: String(p.from || ''),
      subject: String(p.subject || ''),
      why: String(p.why || ''),
      kind: String(p.kind || ''),
      seed: mailId,
    }),
    outcome: 'done',
    note: `inbox_ping ${mailId}`,
  }
}

/* ---- Inbox watch armed ----
 * The watchtower runs whether or not the user ever asked for it, so without
 * this the capability is invisible until the first hit. One text per user,
 * ever, on the day the watch first covers them. */

export function buildInboxWatchOnText(seed = ''): string {
  return pickFlavor([
    "Inbox watch is on. I'll text you when something actually needs you, and stay quiet for everything else.",
    "I'm watching your inbox now. You'll hear from me when a mail actually needs you, not for promos or newsletters.",
    'Watching your inbox from here. When something real lands you get a text, everything else I leave alone.',
  ], seed, 91)
}

const inboxWatchOnHandler: LoopHandler = (task) => {
  return { text: buildInboxWatchOnText(task.phone), outcome: 'done', note: 'inbox_watch_on' }
}

/* ---- Browser run result ----
 * The server queues one of these after a portal run completes (settings-UI
 * "Run" on a saved login, or the browser worker's report()). Payload carries
 * { text, portal, jobId?, imageDataUrl?, imageCaption? } — the bot only
 * delivers it, so all personas share the plain handler. The payload may
 * arrive stringified (see parseLoopPayload), so parse before reading text:
 * without that every browser result sent the generic fallback and lost its
 * screenshot. */

export function buildBrowserResultText(p: { text?: unknown }): string {
  return String(p.text || '').trim() || 'Browser task finished.'
}

const browserResultHandler: LoopHandler = (task) => {
  const payload = parseLoopPayload(task.payload)
  const text = buildBrowserResultText(payload)
  const dataUrl = typeof payload.imageDataUrl === 'string' ? payload.imageDataUrl : ''
  return {
    text,
    outcome: 'done',
    note: 'browser_result',
    // Only well-formed image data URLs are forwarded; anything else would make
    // the bot try to attach garbage.
    ...(dataUrl.startsWith('data:image/') ? { image: { dataUrl, caption: typeof payload.imageCaption === 'string' ? payload.imageCaption : undefined } } : {}),
  }
}

/* ---- Registry ---- */

export const LOOP_HANDLERS: Record<string, LoopHandler> = {
  calendar_defense: dayDefenseHandler,
  flight_checkin: flightCheckinHandler,
  refund_hunter: refundHunterHandler,
  trial_ending: trialEndingHandler,
  bill_increase: billIncreaseHandler,
  wakeup: wakeupHandler,
  birthday_reminder: birthdayReminderHandler,
  streak_ended: streakEndedHandler,
  overwork_check: overworkCheckHandler,
  quiet_check: quietCheckHandler,
  memory_resurface: memoryResurfaceHandler,
  save_contact: saveContactHandler,
  day1_checkin: day1CheckinHandler,
  inbox_ping: inboxPingHandler,
  inbox_watch_on: inboxWatchOnHandler,
  browser_result: browserResultHandler,
  commitment_rescue: (task) => ({
    text: buildCommitmentRescueText(parseLoopPayload(task.payload) as { title: string; dueAt?: unknown; timezone?: unknown }),
    outcome: 'done',
    note: 'commitment_rescue',
  }),
  /** Goal-conditioned watch: re-run the same visit on a schedule. The agent
   * itself judges the goal ("price under $400") because the condition is
   * language, not a number we can parse here. When it stages a checkout the
   * user gets the approval card; until then the loop re-arms. */
  browser_watch: async (task) => {
    const payload = (task.payload || {}) as {
      url?: unknown; goal?: unknown; intervalHours?: unknown; runs?: unknown
    }
    const intervalHours = Number(payload.intervalHours) || 6
    const runsLeft = Number(payload.runs)
    if (Number.isFinite(runsLeft) && runsLeft <= 0) {
      return { text: 'Watch ended: check limit reached.', outcome: 'done', note: 'browser_watch exhausted' }
    }
    // Re-arm uses 'snoozed' + next_run: 'done' would retire the loop, so a
    // recurring watch must come back as a snooze to be claimed again.
    // Each tick enqueues one read-only check. The agent judges the goal in the
    // page ("price under $400") because conditions are language. When it is
    // time to buy, the agent stages checkout and the user approves with Link —
    // the watch itself never spends.
    const base = apiBase()
    const key = process.env.HIREALPHA_INTERNAL_KEY || ''
    let note = 'browser_watch enqueued'
    // No text for a routine tick: the watch's finding arrives through the run's
    // own report, so "the check ran" is pure noise — and it was six-hourly.
    let text = ''
    if (base && key) {
      try {
        const res = await fetch(`${base}/api/internal/propose`, {
          method: 'POST',
          headers: authHeaders(),
          body: JSON.stringify({
            phone: task.phone,
            persona: task.persona || 'friend',
            kind: 'browser',
            url: payload.url,
            /* These are DIRECTIVES to the run, not a description of it. The
             * earlier wording ("This is an automated watch check with mock/test
             * data only") was read back to the user verbatim — live,
             * 2026-09-19, a PS5 price watch reported itself as "an automated
             * watch check with mock/test", attached a 404 screenshot, and asked
             * the user to save a PlayStation account in the Vault before a
             * public price page would be checked. A page that cannot be read
             * plainly is a failed check, not a reason to ask for a login. */
            body: `${String(payload.goal || '')}\n\nAutomated price/availability check — rules for this run: read the public page only. Do not sign in, do not enter credentials or personal details, do not buy anything. If the page cannot be read without an account, report that the check could not read the page and stop; never ask the user for a login for a public page. Report what the page actually shows, with the price and the date it was read.`,
            autoApprove: true,
          }),
          signal: AbortSignal.timeout(20_000),
        })
        const data = (await res.json().catch(() => ({}))) as { ok?: boolean; sessionUrl?: string; error?: string }
        if (res.ok && data.ok) {
          note = 'browser_watch run queued'
          text = ''
        } else {
          note = `browser_watch propose failed: ${data.error || res.status}`
          text = 'The scheduled check could not start this time. It will retry on the next interval.'
        }
      } catch (err) {
        note = `browser_watch enqueue error: ${err instanceof Error ? err.message : String(err)}`
        text = 'The scheduled check could not start this time. It will retry on the next interval.'
      }
    }
    /* A watch with no cap re-armed forever (the server never set `runs`). The
     * default is a week of six-hourly checks; when it runs out the user is told
     * once and can start another. */
    const DEFAULT_WATCH_RUNS = 28
    const hadCap = Number.isFinite(runsLeft)
    const cap = hadCap ? Number(runsLeft) : DEFAULT_WATCH_RUNS
    const nextRuns = Math.max(0, cap - 1)
    if (nextRuns === 0) {
      text = `That watch has run its course (${hadCap ? Number(runsLeft) : DEFAULT_WATCH_RUNS} checks). Say keep watching if you want it to keep going.`
    }
    return {
      text,
      // 'done' retires the loop when the cap is spent; anything else re-arms.
      outcome: nextRuns === 0 ? 'done' : 'snoozed',
      note,
      next_run: new Date(Date.now() + intervalHours * 3600_000).toISOString(),
      nextPayload: { ...payload, runs: nextRuns },
    }
  },
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
  const pollMs = opts.pollMs ?? PROACTIVE_POLL_MS
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
        { headers: authHeaders(), signal: AbortSignal.timeout(8000) },
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
      const handler = handlers[task.kind] || (task.kind.startsWith('commitment_rescue:') ? handlers.commitment_rescue : undefined)
      if (!handler) {
        await postLoopResult(task.id, { outcome: 'failed', note: `no handler for ${task.kind}` })
        continue
      }
      await runLoopTask(task, handler, { persona: String(opts.persona), send: opts.send })
    }
  }

  let running = false
  const run = () => {
    if (running) return
    running = true
    tick().catch((err) => console.warn(`[taskLoops:${opts.persona}] tick failed`, err))
      .finally(() => { running = false })
  }
  run()
  const timer = setInterval(run, pollMs)
  timer.unref?.()
  console.log(`[taskLoops:${opts.persona}] started every ${pollMs / 1000}s`)
  return () => clearInterval(timer)
}
