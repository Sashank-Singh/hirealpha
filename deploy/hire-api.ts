/**
 * HireAlpha live config + connectors API (Postgres).
 * Dashboard writes here. iMessage bots read here.
 */
import { Composio } from '@composio/core'
import { createHmac, timingSafeEqual } from 'node:crypto'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { gateWorkshopCode, runWorkshopCode, sweepExpiredArtifacts } from './workshop'
import type { SQL } from 'bun'
import {
  extractOtherPerson,
  eventStartsByEightPm,
  formatClock,
  formatDigestEventLabel,
  formatUpcomingEvents,
  googleTokenHasScope,
  hydrateCalItems,
  isHotelStayEvent,
  isPersonMeetSuggestion,
  isTravelOrStayTitle,
  isWalkIn,
  parseComposioCalendarData,
  parseFormattedEventLine,
  parseGoogleCalendarItems,
  selectNextEvents,
  serializeCalItems,
  type CalItem,
} from './calendarEvents'
import { COMPOSIO_READ, composioLooksFailed, formatComposioData } from './composioPlugins'
import { parseChatExport, scanSubscriptions } from '../spectrum/shared/smartFeatures'
import {
  isValidTimeZone,
  parseSpokenWhen,
  pickUserTimezone,
  resolveIanaTimezone,
  timezoneFromCoords,
  timezoneFromText,
  wallTimeToUtc,
} from './timezones'
import {
  cleanMailSnippet,
  decodeGmailBody,
  extractGmailBody,
  fillDraftName,
  formatBriefPreview,
  formatComposioMailBlock,
  importantMailQuery,
  mailJudgePrompt,
  MAIL_JUDGE_SYSTEM,
  parseComposioMailBody,
  parseComposioMailItems,
  parseMailJudgeVerdicts,
  groupBriefMail,
  groupMailByKind,
  isSubstantiveReply,
  mailTally,
  pickReplyTarget,
  scoreMail,
  topNeedsYou,
  type ComposioMailBody,
  type ComposioMailItem,
  type GmailMimePart,
  type MailJudgeItem,
  type MailJudgeVerdict,
  type MailKindItem,
  type ReplyRead,
} from './gmailHelpers'
import { extractJsonObject, extractNumericFields, modelReplyText, stripReasoning } from './modelJson'
import {
  JUDGE_ALL_SYSTEM,
  JUDGE_TTL_MS,
  JUDGE_MAIL_CAP,
  JUDGE_MEET_CAP,
  judgeAllPrompt,
  judgeRowCovers,
  judgeRowFresh,
  parseJudgeAll,
  type JudgeMailIn,
  type JudgeMeetIn,
  type JudgeAll,
  type MailVerdict,
  type MeetVerdict,
} from './aiJudge'
import { notModified, revalidateCacheControl, weakEtag } from './httpCache'
import { createStaleCache } from './staleCache'
import { composeWeekReview, spendWouldBreakCap, type WeekSnap } from './weekRun'

export const PERSONAS = ['friend', 'coworker', 'cofounder'] as const
export type Persona = (typeof PERSONAS)[number]

/** Personas a NEW signup can hire today. The rest render as coming soon — the
 * bots stay live for people who already hired them, but no new roster entries,
 * intros, or signups book them until they ship. One list, flipped per launch. */
export const HIRES_LIVE: readonly string[] = ['friend']
export function hireIsLive(p: string): boolean {
  return HIRES_LIVE.includes(p)
}

export const GOOGLE_CONNECTORS = new Set(['gmail', 'calendar', 'drive'])

export const UI_TO_COMPOSIO: Record<string, string> = {
  gmail: 'gmail',
  calendar: 'googlecalendar',
  slack: 'slack',
  notion: 'notion',
  linear: 'linear',
  github: 'github',
  drive: 'googledrive',
  figma: 'figma',
  maps: 'googlemaps',
  spotify: 'spotify',
  stripe: 'stripe',
  plaid: 'plaid',
}

const COMPOSIO_SLUG_ALIASES: Record<string, string> = {
  googlemaps: 'maps',
  google_maps: 'maps',
  'google-maps': 'maps',
  googlecalendar: 'calendar',
  google_calendar: 'calendar',
  googledrive: 'drive',
  google_drive: 'drive',
  google_gmail: 'gmail',
}

export const PERSONA_DENIED: Record<Persona, ReadonlySet<string>> = {
  friend: new Set(['slack', 'linear', 'github', 'stripe', 'figma', 'notion']),
  coworker: new Set(['spotify', 'uber']),
  cofounder: new Set(['uber', 'spotify']),
}

const GOOGLE_SCOPES = [
  'openid',
  'email',
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/gmail.send',
  'https://www.googleapis.com/auth/gmail.compose',
  'https://www.googleapis.com/auth/calendar.events',
  'https://www.googleapis.com/auth/drive.readonly',
].join(' ')

const LOGIN_SCOPES = 'openid email profile'
const LOGIN_STATE_USER = 'login'

export function normalizePhone(raw: string | null | undefined): string | null {
  if (!raw) return null
  const digits = raw.replace(/[^\d]/g, '')
  if (digits.length === 10) return `+1${digits}`
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`
  if (digits.length >= 8) return `+${digits}`
  return null
}

export function phonesMatch(a: string, b: string): boolean {
  const na = normalizePhone(a)
  const nb = normalizePhone(b)
  if (!na || !nb) return false
  return na === nb || na.slice(-10) === nb.slice(-10)
}

export function isPersona(v: string): v is Persona {
  return (PERSONAS as readonly string[]).includes(v)
}

/** Where built artifacts live on disk. Override with ARTIFACTS_DIR when the
 * runner moves to its own sandbox box. */
export function artifactsRoot(): string {
  return process.env.ARTIFACTS_DIR || join(process.cwd(), 'artifacts')
}
export { sweepExpiredArtifacts }

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
}

function json(data: unknown, status = 200, extra?: HeadersInit) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
      ...CORS,
      ...extra,
    },
  })
}

/**
 * A read the client is allowed to revalidate instead of re-fetching. Reopening
 * an app usually means the same bytes, and an `If-None-Match` that matches ends
 * as a 304 with no body — the payload here is ~20 kB. `stale-while-revalidate`
 * then lets the browser paint the copy it already has and refresh behind it.
 *
 * `swr` is passed 0 when the answer is knowingly incomplete: the client refetches
 * within two seconds in that case, and a stale hit would defeat it.
 */
function jsonRevalidated(req: Request, swrSeconds: number, data: unknown) {
  const body = JSON.stringify(data)
  const etag = weakEtag(body)
  const cache = revalidateCacheControl(swrSeconds)
  if (notModified(req.headers.get('if-none-match'), etag)) {
    return new Response(null, { status: 304, headers: { ETag: etag, 'Cache-Control': cache, ...CORS } })
  }
  return new Response(body, {
    headers: { 'Content-Type': 'application/json', ETag: etag, 'Cache-Control': cache, ...CORS },
  })
}

function appBase(req: Request) {
  return (process.env.APP_BASE_URL || new URL(req.url).origin).replace(/\/$/, '')
}

function googleCreds() {
  const clientId = process.env.GOOGLE_CLIENT_ID || ''
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET || ''
  if (!clientId || !clientSecret) return null
  return { clientId, clientSecret }
}

function composioKey() {
  return process.env.COMPOSIO_API_KEY?.trim() || ''
}

function internalOk(req: Request) {
  const key = process.env.HIREALPHA_INTERNAL_KEY || ''
  if (!key) return false
  const auth = req.headers.get('authorization') || ''
  return auth === `Bearer ${key}`
}

/** A bot stops retrying an intro after this many failed attempts; the signup
 * screen covers the rest by telling the person to text first. */
export const INTRO_MAX_ATTEMPTS = 5

/** Queue a first text: the bot for this persona picks the number up and says
 * hi before the person ever has to text first. No-op if already queued or
 * already greeted — a duplicate signup must not re-open the intro. */
export async function enqueueIntro(sql: SQL, phone: string, persona: Persona) {
  const e164 = normalizePhone(phone)
  if (!e164) throw new Error('invalid phone')
  if (!isPersona(persona)) throw new Error('invalid persona')
  await sql`
    INSERT INTO hire_intro_queue (id, phone_e164, persona)
    VALUES (${crypto.randomUUID()}, ${e164}, ${persona})
    ON CONFLICT (phone_e164, persona) DO NOTHING
  `
}

/** Hand pending intros for one persona to the bot that owns the line. A claim
 * bumps attempts immediately so a crashed bot cannot hold a row forever; rows
 * stuck in 'claiming' past the reset window go back to pending on the next
 * claim pass. */export async function claimIntros(sql: SQL, persona: Persona, limit: number) {
  await sql`
    UPDATE hire_intro_queue SET status = 'pending'
    WHERE status = 'claiming' AND created_at < now() - interval '10 minutes'
  `
  const rows = (await sql`
    UPDATE hire_intro_queue SET status = 'claiming', attempts = attempts + 1
    WHERE id IN (
      SELECT id FROM hire_intro_queue
      WHERE persona = ${persona} AND status = 'pending' AND attempts < ${INTRO_MAX_ATTEMPTS}
      ORDER BY created_at
      LIMIT ${limit}
      FOR UPDATE SKIP LOCKED
    )
    RETURNING id, phone_e164 AS phone
  `) as Array<{ id: string; phone: string }>
  return rows
}

export async function ackIntro(sql: SQL, id: string, ok: boolean, error?: string) {
  if (ok) {
    const rows = (await sql`
      UPDATE hire_intro_queue SET status = 'sent', sent_at = now(), last_error = NULL
      WHERE id = ${id} AND status = 'claiming'
      RETURNING phone_e164, persona
    `) as Array<{ phone_e164: string; persona: string }>
    const sent = rows[0]
    if (sent && isPersona(sent.persona)) {
      // The intro landed, so day 1 has started: arm the follow-up check-in.
      // A pre-migration database must not fail the ack over a missing table.
      try {
        await scheduleDay1Checkin(sql, sent.phone_e164, sent.persona)
      } catch (err) {
        console.warn('[hire] day1 checkin schedule failed', err)
      }
    }
    return
  }
  // Failed claims with attempts left go back to pending for the next poll;
  // spent ones park as terminal failures.
  await sql`
    UPDATE hire_intro_queue SET
      status = CASE WHEN attempts < ${INTRO_MAX_ATTEMPTS} THEN 'pending' ELSE 'failed' END,
      last_error = ${String(error || '').slice(0, 500)}
    WHERE id = ${id} AND status = 'claiming'
  `
}

/**
 * A phone-only signup gets an account before it has an email, so the intro is
 * followed by a real thread: touch, memory, and pokes attach on the first
 * reply. The email is a placeholder; when the person later signs in with
 * Google, ensureUser adopts this row by phone instead of colliding with the
 * phone_e164 unique index.
 */
export async function ensurePhoneUser(sql: SQL, phone: string, persona: Persona) {
  await enqueueIntro(sql, phone, persona)
  const e164 = normalizePhone(phone)
  if (!e164) return
  const existing = await getUserByPhone(sql, e164)
  let userId = existing?.id
  if (!userId) {
    const placeholder = `${e164.replace(/\D/g, '')}@phone.hirealpha.chat`
    const inserted = (await sql`
      INSERT INTO hire_users (id, email, phone_e164)
      VALUES (${crypto.randomUUID()}, ${placeholder}, ${e164})
      ON CONFLICT (phone_e164) DO UPDATE SET updated_at = now()
      RETURNING id
    `) as Array<{ id: string }>
    userId = inserted[0]?.id
  }
  if (!userId) return
  await sql`
    INSERT INTO hire_roster (user_id, persona) VALUES (${userId}, ${persona})
    ON CONFLICT (user_id, persona) DO NOTHING
  `
  // The number is armed: give this hire its default recurring jobs. No
  // timezone is known for a phone-only signup yet, so the wakeup lands at
  // 8am Pacific until the user's zone is learned.
  await seedDefaultLoops(sql, userId, e164, persona)
}

/* ---- Task loops ----
 * Recurring jobs a hire runs for one person: a morning wakeup, a weekly refund
 * hunt, a one-shot day 1 check-in, a handoff from another hire. Bots claim due
 * rows with the same protocol as the intro queue and report each run back, so
 * a crashed bot cannot hold a row and a flapping job cannot retry forever. */

export const TASK_LOOP_MAX_ATTEMPTS = 5

const DEFAULT_TIMEZONE = 'America/Los_Angeles'

function loopTimezone(tz: string | null | undefined): string {
  return tz && isValidTimeZone(tz) ? tz : DEFAULT_TIMEZONE
}

/** Local calendar day and weekday (0=Sunday) for an instant in a zone. */
function localWall(tz: string, at: Date): { ymd: string; weekday: number } {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    weekday: 'short',
  }).formatToParts(at)
  const get = (t: string) => parts.find((p) => p.type === t)?.value || ''
  const ymd = `${get('year')}-${get('month')}-${get('day')}`
  const weekday = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(get('weekday').slice(0, 3))
  return { ymd, weekday }
}

/** The next `hour`:00 local time in `tz` as a UTC ISO string. Unknown zones
 * fall back to the default so a bad timezone can never strand a loop. */
export function nextDailyUtc(tz: string | null | undefined, hour: number, from = new Date()): string {
  const zone = loopTimezone(tz)
  let when = wallTimeToUtc(localWall(zone, from).ymd, hour, 0, zone)
  if (when.getTime() <= from.getTime()) {
    const tomorrow = localWall(zone, new Date(from.getTime() + 24 * 60 * 60 * 1000)).ymd
    when = wallTimeToUtc(tomorrow, hour, 0, zone)
  }
  return when.toISOString()
}

/** The next `weekday` at `hour`:00 local time in `tz` as a UTC ISO string. */
export function nextWeeklyUtc(
  tz: string | null | undefined,
  hour: number,
  weekday: number,
  from = new Date(),
): string {
  const zone = loopTimezone(tz)
  const wall = localWall(zone, from)
  const add = (weekday - wall.weekday + 7) % 7
  let target = localWall(zone, new Date(from.getTime() + add * 24 * 60 * 60 * 1000)).ymd
  let when = wallTimeToUtc(target, hour, 0, zone)
  if (when.getTime() <= from.getTime()) {
    // Same weekday and the hour already passed: go a week out.
    target = localWall(zone, new Date(from.getTime() + (add + 7) * 24 * 60 * 60 * 1000)).ymd
    when = wallTimeToUtc(target, hour, 0, zone)
  }
  return when.toISOString()
}

/** Default loops armed when a phone joins a roster. Deduped per (user, persona,
 * kind), so re-arming the same number never grows the list. */
export async function seedDefaultLoops(
  sql: SQL,
  userId: string,
  phone: string,
  persona: Persona,
  timezone?: string | null,
) {
  const tz = loopTimezone(timezone)
  const seeds = [
    { kind: 'wakeup', title: 'Morning wakeup', nextRun: nextDailyUtc(tz, 8), payload: { hour: 8 } },
    { kind: 'refund_hunter', title: 'Hunt refunds and unused subscriptions', nextRun: nextWeeklyUtc(tz, 10, 2), payload: {} },
    { kind: 'memory_resurface', title: 'Resurface one saved memory', nextRun: nextWeeklyUtc(tz, 12, 5), payload: {} },
  ]
  for (const seed of seeds) {
    await sql`
      INSERT INTO hire_task_loops (id, user_id, persona, phone_e164, kind, title, payload, status, next_run)
      VALUES (${crypto.randomUUID()}, ${userId}, ${persona}, ${phone}, ${seed.kind}, ${seed.title},
        ${JSON.stringify(seed.payload)}::jsonb, 'pending', ${seed.nextRun})
      ON CONFLICT (user_id, persona, kind) DO NOTHING
    `
  }
}

/** Day 1 check-in: one day after the first text lands, the same hire follows
 * up to hear how the first day went. Needs the phone-only account to exist so
 * the loop has an owner; a waitlist-only number that never signed up is skipped. */
export async function scheduleDay1Checkin(sql: SQL, phone: string, persona: Persona) {
  const e164 = normalizePhone(phone)
  if (!e164) return
  const rows = (await sql`
    SELECT id FROM hire_users WHERE phone_e164 = ${e164} LIMIT 1
  `) as Array<{ id: string }>
  const userId = rows[0]?.id
  if (!userId) return
  await sql`
    INSERT INTO hire_task_loops (id, user_id, persona, phone_e164, kind, title, payload, status, next_run)
    VALUES (${crypto.randomUUID()}, ${userId}, ${persona}, ${e164}, 'day1_checkin',
      'Check how the first day went', '{}'::jsonb, 'pending',
      ${new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString()})
    ON CONFLICT (user_id, persona, kind) DO NOTHING
  `
}

/** Hand due loops for one persona to the bot that owns the line, same claim
 * protocol as the intro queue: attempts bump on claim, claims stuck in
 * 'running' past the reset window go back to pending on the next pass. */
export async function claimDueLoops(sql: SQL, persona: Persona, limit: number) {
  await sql`
    UPDATE hire_task_loops SET status = 'pending'
    WHERE status = 'running' AND updated_at < now() - interval '10 minutes'
  `
  const rows = (await sql`
    UPDATE hire_task_loops SET status = 'running', updated_at = now()
    WHERE id IN (
      SELECT id FROM hire_task_loops
      WHERE persona = ${persona} AND status = 'pending' AND attempts < ${TASK_LOOP_MAX_ATTEMPTS}
        AND (next_run IS NULL OR next_run <= now())
      ORDER BY next_run
      LIMIT ${limit}
      FOR UPDATE SKIP LOCKED
    )
    RETURNING id, user_id AS "userId", persona, phone_e164 AS phone, kind, title, payload
  `) as Array<{
    id: string
    userId: string
    persona: Persona
    phone: string
    kind: string
    title: string
    payload: unknown
  }>
  return rows
}

/** A claimed loop reports back: done ends it, a failure burns one of the five
 * attempts before parking as terminal, a snooze sets the next run. */
export async function finishTaskLoop(
  sql: SQL,
  id: string,
  outcome: 'done' | 'failed' | 'snoozed',
  note?: string,
  nextRun?: string | null,
) {
  const result = String(note || '').slice(0, 500)
  if (outcome === 'done') {
    await sql`
      UPDATE hire_task_loops SET status = 'done', last_result = ${result}, updated_at = now()
      WHERE id = ${id}
    `
    return
  }
  if (outcome === 'failed') {
    await sql`
      UPDATE hire_task_loops SET
        status = CASE WHEN attempts + 1 < ${TASK_LOOP_MAX_ATTEMPTS} THEN 'pending' ELSE 'failed' END,
        attempts = attempts + 1,
        last_result = ${result},
        updated_at = now()
      WHERE id = ${id}
    `
    return
  }
  const when = new Date(String(nextRun || ''))
  const snoozedTo = Number.isNaN(when.getTime())
    ? new Date(Date.now() + 60 * 60 * 1000).toISOString()
    : when.toISOString()
  await sql`
    UPDATE hire_task_loops SET status = 'pending', next_run = ${snoozedTo}, last_result = ${result}, updated_at = now()
    WHERE id = ${id}
  `
}

/* ---- Invites ----
 * Every armed phone gets three codes to hand out. The alphabet drops 0 O 1 I L
 * because codes get read out loud over iMessage and those five are the ones
 * people mishear. */

const INVITE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'

export function generateInviteCode(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(6))
  let suffix = ''
  for (const byte of bytes) suffix += INVITE_ALPHABET[byte % INVITE_ALPHABET.length]
  return `ALPHA-${suffix}`
}

/** Idempotently make sure a phone has its three codes. Re-reads after every
 * insert so a rare code collision with another phone cannot short the count. */
export async function ensureInvites(sql: SQL, phone: string): Promise<string[]> {
  const e164 = normalizePhone(phone)
  if (!e164) throw new Error('invalid phone')
  const codes = async () =>
    ((await sql`
      SELECT code FROM hire_invites WHERE phone_e164 = ${e164} ORDER BY created_at
    `) as Array<{ code: string }>).map((r) => r.code)
  let mine = await codes()
  for (let guard = 0; guard < 10 && mine.length < 3; guard++) {
    await sql`
      INSERT INTO hire_invites (code, phone_e164)
      VALUES (${generateInviteCode()}, ${e164})
      ON CONFLICT (code) DO NOTHING
    `
    mine = await codes()
  }
  return mine.slice(0, 3)
}

/* ---- Referral loop ----
 * One-use codes are the whole mechanic: the invite holder shares a code, the
 * friend enters it, the code is marked used, and the referrer earns one
 * hire_referral_credits row per converted code. Each credit is a free month
 * applied automatically at the referrer's next checkout. */

export type ClaimResult = { ok: boolean; error?: string; referrer?: string }

export async function claimInvite(sql: SQL, phone: string, code: string): Promise<ClaimResult> {
  const e164 = normalizePhone(phone)
  const clean = code.trim().toUpperCase()
  if (!e164) return { ok: false, error: 'valid phone required' }
  if (!clean) return { ok: false, error: 'code required' }
  const rows = (await sql`
    SELECT phone_e164 AS referrer, redeemed_by_phone AS redeemed
    FROM hire_invites WHERE code = ${clean} LIMIT 1
  `) as Array<{ referrer: string; redeemed: string | null }>
  const invite = rows[0]
  if (!invite) return { ok: false, error: 'Code not found' }
  if (invite.redeemed) return { ok: false, error: 'This code was already used' }
  await sql`
    UPDATE hire_invites SET redeemed_by_phone = ${e164}, redeemed_at = now()
    WHERE code = ${clean}
  `
  // Refer a friend, get a free month: the referrer earns one credit per
  // converted code. source_code UNIQUE is the idempotency guard.
  await sql`
    INSERT INTO hire_referral_credits (id, phone_e164, source_code)
    VALUES (${crypto.randomUUID()}, ${invite.referrer}, ${clean})
    ON CONFLICT (source_code) DO NOTHING
  `
  // One converted code is one credit; the old every-3 mechanic is retired.
  return { ok: true, referrer: invite.referrer }
}

/** Progress for the referrer's invite row: how many codes are used. */
export async function referralProgress(
  sql: SQL,
  phone: string,
): Promise<{ referrals: number }> {
  const e164 = normalizePhone(phone)
  if (!e164) return { referrals: 0 }
  const countRows = (await sql`
    SELECT count(*)::int AS n FROM hire_invites
    WHERE phone_e164 = ${e164} AND redeemed_by_phone IS NOT NULL
  `) as Array<{ n: number | string }>
  const n = Number(countRows[0]?.n ?? 0)
  return { referrals: Number.isFinite(n) ? n : 0 }
}

/** Unused referral credits for a phone, i.e. free months waiting to be
 * applied at checkout. Used rows no longer count. */
export async function referralFreeMonths(sql: SQL, phone: string): Promise<number> {
  const e164 = normalizePhone(phone)
  if (!e164) return 0
  const rows = (await sql`
    SELECT count(*)::int AS n FROM hire_referral_credits
    WHERE phone_e164 = ${e164} AND used_at IS NULL
  `) as Array<{ n: number | string }>
  const n = Number(rows[0]?.n ?? 0)
  return Number.isFinite(n) ? n : 0
}

/* ---- Billing ----
 * Stripe over plain fetch: one price per hire, checkout creates a
 * session, the webhook keeps hire_subscriptions honest. Nothing gates on it
 * until BILLING_ENFORCE=1 — ship the plumbing first, flip the switch when the
 * prices exist in the Stripe dashboard. */

function stripeSecret() {
  return process.env.STRIPE_SECRET_KEY?.trim() || ''
}

function stripePriceFor(persona: Persona) {
  const key = persona === 'friend' ? 'STRIPE_PRICE_FRIEND' : persona === 'coworker' ? 'STRIPE_PRICE_COWORKER' : 'STRIPE_PRICE_COFOUNDER'
  return process.env[key]?.trim() || ''
}

function stripePromoPrice() {
  return process.env.STRIPE_PRICE_FRIEND_PROMO?.trim() || ''
}

export function billingConfigured(persona: Persona) {
  return !!stripeSecret() && !!stripePriceFor(persona)
}

const STRIPE_ACTIVE_STATUSES = new Set(['active', 'trialing'])

export function subscriptionActive(status: string) {
  return STRIPE_ACTIVE_STATUSES.has(status)
}

/** Stripe signs webhooks as `t=timestamp,v1=hmac` over `${t}.${rawBody}`. */
export function verifyStripeSignature(payload: string, header: string, secret: string): boolean {
  const parts = Object.fromEntries(
    header.split(',').map((kv) => kv.split('=') as [string, string]),
  )
  const t = parts['t']
  const v1 = parts['v1']
  if (!t || !v1) return false
  // Replay window: Stripe recommends tolerating some clock skew; 5 minutes.
  if (Math.abs(Date.now() / 1000 - Number(t)) > 300) return false
  const expected = createHmac('sha256', secret).update(`${t}.${payload}`).digest('hex')
  const a = Buffer.from(expected)
  const b = Buffer.from(v1)
  return a.length === b.length && timingSafeEqual(a, b)
}

async function stripeRequest(path: string, params: URLSearchParams, method: 'POST' | 'GET' = 'POST') {
  const res = await fetch(`https://api.stripe.com/v1${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${stripeSecret()}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    // GET must not carry a body; params are for POST form data.
    ...(method === 'POST' ? { body: params } : {}),
  })
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>
  if (!res.ok) {
    const err = data['error'] as { message?: string; code?: string } | undefined
    const thrown = new Error(err?.message || `stripe ${path} failed (${res.status})`)
    // Stripe's machine-readable code (e.g. resource_already_exists) lets
    // callers do create-or-reuse; keep it attached to the error.
    if (err?.code) (thrown as Error & { code?: string }).code = err.code
    throw thrown
  }
  return data
}

async function upsertSubscription(
  sql: SQL,
  opts: {
    userId: string
    persona: Persona
    stripeSubscriptionId?: string | null
    stripeCustomerId?: string | null
    status: string
    priceId?: string | null
    currentPeriodEnd?: Date | null
    promoStartedAt?: Date | null
  },
) {
  await sql`
    INSERT INTO hire_subscriptions (id, user_id, persona, stripe_customer_id, stripe_subscription_id, status, price_id, current_period_end, promo_started_at)
    VALUES (${crypto.randomUUID()}, ${opts.userId}, ${opts.persona}, ${opts.stripeCustomerId || null}, ${opts.stripeSubscriptionId || null}, ${opts.status}, ${opts.priceId || null}, ${opts.currentPeriodEnd || null}, ${opts.promoStartedAt || null})
    ON CONFLICT (user_id, persona) DO UPDATE SET
      stripe_customer_id = EXCLUDED.stripe_customer_id,
      stripe_subscription_id = EXCLUDED.stripe_subscription_id,
      status = EXCLUDED.status,
      price_id = EXCLUDED.price_id,
      current_period_end = EXCLUDED.current_period_end,
      promo_started_at = COALESCE(EXCLUDED.promo_started_at, hire_subscriptions.promo_started_at),
      updated_at = now()
  `
}

async function handleBillingWebhook(req: Request, sql: SQL) {
  const secret = process.env.STRIPE_WEBHOOK_SECRET?.trim() || ''
  const payload = await req.text()
  if (!secret || !verifyStripeSignature(payload, req.headers.get('stripe-signature') || '', secret)) {
    return json({ error: 'Bad signature' }, 400)
  }
  let event: {
    type?: string
    data?: { object?: Record<string, unknown> }
  }
  try {
    event = JSON.parse(payload)
  } catch {
    return json({ error: 'Invalid JSON' }, 400)
  }

  const obj = event.data?.object || {}
  const type = event.type || ''
  if (type === 'checkout.session.completed') {
    // client_reference_id is `${userId}:${persona}` set at checkout creation.
    const ref = String(obj['client_reference_id'] || '')
    const [userId, persona] = ref.split(':')
    const subscriptionId = typeof obj['subscription'] === 'string' ? obj['subscription'] : null
    const customerId = typeof obj['customer'] === 'string' ? obj['customer'] : null
    // 'all' is the synthetic persona a bundle checkout writes; it owns one
    // subscription row that covers every hire.
    if (userId && persona && (isPersona(persona) || persona === 'all') && subscriptionId) {
      // The session completes before the subscription ticks active; fetch it
      // so the row starts in Stripe's own state rather than guessed state.
      let status = 'active'
      let currentPeriodEnd: Date | null = null
      try {
        const sub = (await stripeRequest(
          `/subscriptions/${subscriptionId}`,
          new URLSearchParams(),
        )) as { status?: string; current_period_end?: number }
        if (sub.status) status = sub.status
        if (sub.current_period_end) currentPeriodEnd = new Date(sub.current_period_end * 1000)
      } catch (err) {
        console.error('[billing] subscription fetch after checkout failed', err)
      }
      await upsertSubscription(sql, {
        userId,
        persona,
        stripeSubscriptionId: subscriptionId,
        stripeCustomerId: customerId,
        status,
        currentPeriodEnd,
        promoStartedAt: promoPrice ? new Date() : null,
      })
    }
  } else if (type === 'customer.subscription.updated' || type === 'customer.subscription.deleted') {
    const subscriptionId = String(obj['id'] || '')
    const status = String(obj['status'] || (type.endsWith('deleted') ? 'canceled' : ''))
    if (subscriptionId && status) {
      const periodEnd = typeof obj['current_period_end'] === 'number' ? new Date(obj['current_period_end'] * 1000) : null
      await sql`
        UPDATE hire_subscriptions SET status = ${status}, current_period_end = ${periodEnd}, updated_at = now()
        WHERE stripe_subscription_id = ${subscriptionId}
      `
    }
  }
  return json({ received: true })
}

/** How long a mini-app card URL token stays valid. */
const MINI_TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000

interface MiniToken {
  phone: string
  persona: string
  kind: string
  exp: number
}

function miniTokenSecret(): string | null {
  const key = process.env.HIREALPHA_INTERNAL_KEY || ''
  return key || null
}

function signMiniToken(payload: string, secret: string): string {
  return createHmac('sha256', secret).update(payload).digest('base64url')
}

/** Mint a signed, expiring identity token for a mini-app card URL. */
function mintMiniToken(phone: string, persona: Persona, kind: string): string | null {
  const secret = miniTokenSecret()
  if (!secret) return null
  const payload: MiniToken = { phone, persona, kind, exp: Date.now() + MINI_TOKEN_TTL_MS }
  const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url')
  return `${encoded}.${signMiniToken(encoded, secret)}`
}

/** Turn an existing unique index into a table UNIQUE constraint when missing. */
async function ensureUniqueConstraint(
  sql: SQL,
  table: string,
  constraint: string,
  index: string,
  columns: string,
) {
  const existing = await sql`
    SELECT 1 FROM pg_constraint WHERE conname = ${constraint} LIMIT 1
  `
  if (existing.length) return
  const unsafe = sql as SQL & { unsafe: (query: string) => Promise<unknown> }
  try {
    await unsafe.unsafe(
      `ALTER TABLE ${table} ADD CONSTRAINT ${constraint} UNIQUE USING INDEX ${index}`,
    )
  } catch {
    try {
      await unsafe.unsafe(`ALTER TABLE ${table} ADD CONSTRAINT ${constraint} UNIQUE (${columns})`)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      if (!/already exists|duplicate/i.test(msg)) {
        console.warn(`[hire] unique constraint ${constraint}`, msg)
      }
    }
  }
}

/** Verify + decode a mini-app token. Returns null when missing/invalid/expired. */
function verifyMiniToken(token: string): MiniToken | null {
  const secret = miniTokenSecret()
  if (!secret) return null
  const dot = token.lastIndexOf('.')
  if (dot <= 0) return null
  const encoded = token.slice(0, dot)
  const sig = token.slice(dot + 1)
  const expected = signMiniToken(encoded, secret)
  const a = Buffer.from(sig)
  const b = Buffer.from(expected)
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null
  let payload: MiniToken
  try {
    payload = JSON.parse(Buffer.from(encoded, 'base64url').toString()) as MiniToken
  } catch {
    return null
  }
  if (!payload.phone || !payload.persona || !payload.kind || typeof payload.exp !== 'number') {
    return null
  }
  if (payload.exp < Date.now()) return null
  return payload
}

/* Alpha's contact photo for the vCard, loaded once and cached. A missing file
 * just means a text-only card. */
let alphaContactB64: string | null = null
async function alphaContactPhoto(): Promise<string | null> {
  if (alphaContactB64 !== null) return alphaContactB64
  try {
    const png = await readFile(join(import.meta.dir, '..', 'public', 'alpha-contact.png'))
    alphaContactB64 = png.toString('base64')
  } catch {
    alphaContactB64 = ''
  }
  return alphaContactB64 || null
}

/** How long a signed web-session token stays valid. */
const SESSION_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000

interface SessionToken {
  email: string
  exp: number
}

/** HMAC secret for signed web sessions. Falls back to the mini-token secret. */
function sessionTokenSecret(): string | null {
  const dedicated = process.env.HIREALPHA_SESSION_SECRET || ''
  return dedicated || miniTokenSecret()
}

function signSessionToken(payload: string, secret: string): string {
  return createHmac('sha256', secret).update(payload).digest('base64url')
}

/** Mint a signed, expiring web-session token bound to an email. */
function mintSessionToken(email: string): string | null {
  const secret = sessionTokenSecret()
  if (!secret) return null
  const payload: SessionToken = { email, exp: Date.now() + SESSION_TOKEN_TTL_MS }
  const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url')
  return `${encoded}.${signSessionToken(encoded, secret)}`
}

/** Verify + decode a web-session token. Returns null when missing/invalid/expired. */
function verifySessionToken(token: string): SessionToken | null {
  const secret = sessionTokenSecret()
  if (!secret) return null
  const dot = token.lastIndexOf('.')
  if (dot <= 0) return null
  const encoded = token.slice(0, dot)
  const sig = token.slice(dot + 1)
  const expected = signSessionToken(encoded, secret)
  const a = Buffer.from(sig)
  const b = Buffer.from(expected)
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null
  let payload: SessionToken
  try {
    payload = JSON.parse(Buffer.from(encoded, 'base64url').toString()) as SessionToken
  } catch {
    return null
  }
  if (typeof payload.email !== 'string' || typeof payload.exp !== 'number') return null
  if (payload.exp < Date.now()) return null
  return payload
}

/* ---- Password auth ---- */

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

function isValidEmailFormat(email: string): boolean {
  return EMAIL_RE.test(email) && email.length <= 320
}

/**
 * Passwords are hashed with Bun's argon2id. The plaintext and the hash are
 * never logged anywhere; handlers only touch them through these helpers.
 */
async function hashPassword(password: string): Promise<string> {
  return Bun.password.hash(password)
}

/**
 * Constraint: the brute force brake is in memory and per process. After 8
 * wrong passwords for one email, that email is locked for 5 minutes. A
 * success clears the count. Failures only count when the account exists and
 * has a password, so never-registered addresses cannot be locked from outside.
 */
const LOGIN_MAX_FAILURES = 8
const LOGIN_LOCK_MS = 5 * 60 * 1000
const loginFailures = new Map<string, { count: number; lockedUntil: number }>()

function loginLockedRemainingMs(email: string): number {
  const entry = loginFailures.get(email)
  if (!entry) return 0
  return Math.max(0, entry.lockedUntil - Date.now())
}

function recordLoginFailure(email: string) {
  const entry = loginFailures.get(email) || { count: 0, lockedUntil: 0 }
  entry.count += 1
  if (entry.count >= LOGIN_MAX_FAILURES) {
    entry.lockedUntil = Date.now() + LOGIN_LOCK_MS
    entry.count = 0
  }
  loginFailures.set(email, entry)
}

function clearLoginFailures(email: string) {
  loginFailures.delete(email)
}

/** Test hook: resets the in-memory lockout table between test cases. */
export function resetLoginFailures() {
  loginFailures.clear()
}

/** The exact response shape the Google ticket exchange returns, plus the session token. */
function sessionTokenResponse(user: { email: string; name: string | null; phone: string | null }) {
  const session = mintSessionToken(user.email)
  return json({
    email: user.email,
    name: user.name,
    phone: user.phone,
    ...(session ? { session } : {}),
  })
}

/** Read only the stored hash for a user id. Never logged, never sent to clients. */
async function getPasswordHashById(sql: SQL, userId: string): Promise<string | null> {
  const rows = await sql`
    SELECT password_hash FROM hire_users WHERE id = ${userId} LIMIT 1
  `
  const hash = (rows[0] as { password_hash?: unknown } | undefined)?.password_hash
  return typeof hash === 'string' && hash ? hash : null
}

/** Guard for raw password input: string, 8 to 200 chars. */
function isPlausiblePassword(password: unknown): password is string {
  return typeof password === 'string' && password.length >= 8 && password.length <= 200
}

/**
 * Set a password on the account for an email, creating the account if needed.
 * Used by register and by the waitlist. Waitlist callers treat every outcome
 * as quiet: 'exists' means the account already has a password, and any storage
 * error resolves to 'skipped' rather than blocking the signup.
 */
export async function attachPasswordToAccount(
  sql: SQL,
  email: string,
  password: unknown,
  phone?: string | null,
): Promise<'set' | 'exists' | 'invalid' | 'skipped'> {
  const addr = String(email || '').trim().toLowerCase()
  if (!isValidEmailFormat(addr) || !isPlausiblePassword(password)) return 'invalid'
  try {
    const user = await ensureUser(sql, addr, phone || undefined)
    if (await getPasswordHashById(sql, user.id)) return 'exists'
    const hash = await hashPassword(password)
    await sql`
      UPDATE hire_users SET password_hash = ${hash}, updated_at = now()
      WHERE id = ${user.id}
    `
    return 'set'
  } catch {
    // Waitlist is not a conflict surface: a phone already owned by another
    // account (or any storage hiccup) just leaves the password unset.
    return 'skipped'
  }
}

export async function ensureHireSchema(sql: SQL) {
  await sql`
    CREATE TABLE IF NOT EXISTS hire_users (
      id TEXT PRIMARY KEY,
      email TEXT NOT NULL UNIQUE,
      name TEXT,
      timezone TEXT,
      phone_e164 TEXT UNIQUE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `
  await sql`ALTER TABLE hire_users ADD COLUMN IF NOT EXISTS name TEXT`
  await sql`ALTER TABLE hire_users ADD COLUMN IF NOT EXISTS timezone TEXT`
  await sql`ALTER TABLE hire_users ADD COLUMN IF NOT EXISTS password_hash TEXT`
  await sql`
    CREATE TABLE IF NOT EXISTS hire_reminders (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES hire_users(id) ON DELETE CASCADE,
      persona TEXT NOT NULL,
      text TEXT NOT NULL,
      scheduled_at TIMESTAMPTZ NOT NULL,
      recurrence TEXT NOT NULL DEFAULT 'once',
      timezone TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `
  await sql`ALTER TABLE hire_reminders ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ`
  await sql`CREATE INDEX IF NOT EXISTS idx_hire_reminders_due ON hire_reminders (persona, status, scheduled_at)`
  await sql`
    CREATE TABLE IF NOT EXISTS hire_roster (
      user_id TEXT NOT NULL REFERENCES hire_users(id) ON DELETE CASCADE,
      persona TEXT NOT NULL,
      hired_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (user_id, persona)
    )
  `
  await sql`
    CREATE TABLE IF NOT EXISTS hire_context (
      user_id TEXT NOT NULL REFERENCES hire_users(id) ON DELETE CASCADE,
      persona TEXT NOT NULL,
      fields JSONB NOT NULL DEFAULT '{}'::jsonb,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (user_id, persona)
    )
  `
  await sql`
    CREATE TABLE IF NOT EXISTS hire_google_tokens (
      user_id TEXT PRIMARY KEY REFERENCES hire_users(id) ON DELETE CASCADE,
      access_token TEXT NOT NULL,
      refresh_token TEXT,
      expires_at TIMESTAMPTZ,
      scopes TEXT NOT NULL DEFAULT '',
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `
  await sql`
    CREATE TABLE IF NOT EXISTS hire_oauth_state (
      state TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      redirect_after TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `
  await sql`
    CREATE TABLE IF NOT EXISTS hire_composio_auth (
      toolkit TEXT PRIMARY KEY,
      auth_config_id TEXT NOT NULL
    )
  `
  await sql`
    CREATE TABLE IF NOT EXISTS hire_login_tickets (
      ticket TEXT PRIMARY KEY,
      email TEXT NOT NULL,
      name TEXT,
      phone_e164 TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `
  await sql`ALTER TABLE hire_login_tickets ADD COLUMN IF NOT EXISTS name TEXT`
  await sql`ALTER TABLE hire_roster ADD COLUMN IF NOT EXISTS last_inbound_at TIMESTAMPTZ`
  await sql`
    CREATE TABLE IF NOT EXISTS hire_memories (
      user_id TEXT NOT NULL REFERENCES hire_users(id) ON DELETE CASCADE,
      persona TEXT NOT NULL,
      key TEXT NOT NULL,
      value TEXT NOT NULL,
      durable BOOLEAN NOT NULL DEFAULT false,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (user_id, persona, key)
    )
  `
  await sql`CREATE INDEX IF NOT EXISTS idx_hire_memories_user ON hire_memories (user_id, persona, durable, updated_at DESC)`

  await sql`
    CREATE TABLE IF NOT EXISTS hire_loops (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES hire_users(id) ON DELETE CASCADE,
      persona TEXT NOT NULL DEFAULT '',
      title TEXT NOT NULL,
      context TEXT NOT NULL DEFAULT '',
      due_at TIMESTAMPTZ,
      status TEXT NOT NULL DEFAULT 'open',
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `
  await sql`CREATE INDEX IF NOT EXISTS idx_hire_loops_user ON hire_loops (user_id, status, created_at DESC)`

  /* The LLM judgment layer's cache: one row per user holding the verdicts for
   * their current mail batch and today's meetings, rebuilt at most every 15
   * minutes so opening a brief costs zero model calls. */
  await sql`
    CREATE TABLE IF NOT EXISTS hire_judge_cache (
      user_id TEXT PRIMARY KEY REFERENCES hire_users(id) ON DELETE CASCADE,
      payload JSONB NOT NULL,
      day TEXT NOT NULL,
      built_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `

  await sql`
    CREATE TABLE IF NOT EXISTS hire_decisions (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES hire_users(id) ON DELETE CASCADE,
      persona TEXT NOT NULL DEFAULT '',
      decision TEXT NOT NULL,
      reason TEXT NOT NULL DEFAULT '',
      evidence TEXT NOT NULL DEFAULT '',
      owner TEXT NOT NULL DEFAULT '',
      review_at TIMESTAMPTZ,
      outcome TEXT,
      status TEXT NOT NULL DEFAULT 'open',
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `
  await sql`CREATE INDEX IF NOT EXISTS idx_hire_decisions_user ON hire_decisions (user_id, status, created_at DESC)`

  await sql`
    CREATE TABLE IF NOT EXISTS hire_relationships (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES hire_users(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      kind TEXT NOT NULL DEFAULT 'other',
      notes TEXT NOT NULL DEFAULT '',
      cadence_days INTEGER NOT NULL DEFAULT 30,
      last_touch_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `
  await sql`CREATE INDEX IF NOT EXISTS idx_hire_relationships_user ON hire_relationships (user_id, updated_at DESC)`

  await sql`
    CREATE TABLE IF NOT EXISTS hire_dropzone (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES hire_users(id) ON DELETE CASCADE,
      persona TEXT NOT NULL DEFAULT '',
      content TEXT NOT NULL,
      media_kind TEXT,
      summary TEXT,
      status TEXT NOT NULL DEFAULT 'new',
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `
  await sql`
    CREATE TABLE IF NOT EXISTS hire_standups (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES hire_users(id) ON DELETE CASCADE,
      day TEXT NOT NULL,
      notes TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (user_id, day)
    )
  `
  await sql`
    CREATE TABLE IF NOT EXISTS hire_runway_snapshots (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES hire_users(id) ON DELETE CASCADE,
      taken_on TEXT NOT NULL,
      cash REAL NOT NULL DEFAULT 0,
      burn REAL NOT NULL DEFAULT 0,
      months REAL NOT NULL DEFAULT 0,
      UNIQUE (user_id, taken_on)
    )
  `
  /* Workshop: things Alpha builds. Delivered artifacts auto-expire (7 days)
   * unless the user keeps them — nothing the sandbox makes persists by default. */
  await sql`
    CREATE TABLE IF NOT EXISTS hire_artifacts (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES hire_users(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      kind TEXT NOT NULL DEFAULT 'page',
      files JSONB NOT NULL DEFAULT '[]'::jsonb,
      state TEXT NOT NULL DEFAULT 'delivered',
      expires_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `
  /* Build files live in the database, not on the container disk: a deploy
   * replaces the container and every build made before it would vanish. */
  await sql`
    CREATE TABLE IF NOT EXISTS hire_artifact_files (
      artifact_id TEXT NOT NULL REFERENCES hire_artifacts(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      content TEXT NOT NULL,
      PRIMARY KEY (artifact_id, name)
    )
  `
  /* Dedup: one verified build serves every user who asks for the same thing.
   * template_key is the normalized ask; clones copy the files per user so
   * expiry and keep/toss stay personal. */
  await sql`ALTER TABLE hire_artifacts ADD COLUMN IF NOT EXISTS template_key TEXT`
  await sql`CREATE INDEX IF NOT EXISTS idx_hire_artifacts_template ON hire_artifacts (template_key, created_at DESC)`
  // Templates built before the phone-gate fix (2026-08-28) teach keyboard-only
  // apps to every future clone — ping pong shipped arrow keys to an iPhone.
  // Invalidate the old cache; new verified builds repopulate it.
  await sql`UPDATE hire_artifacts SET template_key = NULL WHERE template_key IS NOT NULL AND created_at < '2026-08-28'`
  await sql`
    CREATE TABLE IF NOT EXISTS hire_workshop_tasks (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES hire_users(id) ON DELETE CASCADE,
      prompt TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'done',
      error TEXT,
      artifact_id TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `
  await sql`CREATE INDEX IF NOT EXISTS idx_hire_dropzone_user ON hire_dropzone (user_id, status, created_at DESC)`

  await sql`
    CREATE TABLE IF NOT EXISTS hire_meetings (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES hire_users(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      starts_at TIMESTAMPTZ,
      phase TEXT NOT NULL DEFAULT 'prep',
      briefing TEXT,
      followups JSONB NOT NULL DEFAULT '[]'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `
  await sql`CREATE INDEX IF NOT EXISTS idx_hire_meetings_user ON hire_meetings (user_id, created_at DESC)`
  await sql`ALTER TABLE hire_meetings ADD COLUMN IF NOT EXISTS notes TEXT`

  await sql`
    CREATE TABLE IF NOT EXISTS hire_drafts (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES hire_users(id) ON DELETE CASCADE,
      persona TEXT NOT NULL DEFAULT '',
      kind TEXT NOT NULL DEFAULT 'email',
      to_addr TEXT NOT NULL DEFAULT '',
      subject TEXT NOT NULL DEFAULT '',
      body TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'pending',
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `
  await sql`ALTER TABLE hire_drafts ADD COLUMN IF NOT EXISTS thread_id TEXT NOT NULL DEFAULT ''`
  await sql`ALTER TABLE hire_drafts ADD COLUMN IF NOT EXISTS in_reply_to TEXT NOT NULL DEFAULT ''`
  await sql`ALTER TABLE hire_drafts ADD COLUMN IF NOT EXISTS start_at TEXT NOT NULL DEFAULT ''`
  await sql`ALTER TABLE hire_drafts ADD COLUMN IF NOT EXISTS end_at TEXT NOT NULL DEFAULT ''`
  await sql`CREATE INDEX IF NOT EXISTS idx_hire_drafts_user ON hire_drafts (user_id, status, created_at DESC)`

  await sql`
    CREATE TABLE IF NOT EXISTS hire_nudge_log (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES hire_users(id) ON DELETE CASCADE,
      persona TEXT NOT NULL,
      nudge_key TEXT NOT NULL,
      sent_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (user_id, nudge_key)
    )
  `
  await sql`CREATE INDEX IF NOT EXISTS idx_hire_nudge_log_user ON hire_nudge_log (user_id, persona, sent_at DESC)`

  await sql`
    CREATE TABLE IF NOT EXISTS hire_nutrition_logs (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES hire_users(id) ON DELETE CASCADE,
      description TEXT NOT NULL,
      image_url TEXT,
      calories REAL NOT NULL DEFAULT 0,
      protein REAL NOT NULL DEFAULT 0,
      carbs REAL NOT NULL DEFAULT 0,
      fat REAL NOT NULL DEFAULT 0,
      eaten_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `
  await sql`CREATE INDEX IF NOT EXISTS idx_hire_nutrition_user ON hire_nutrition_logs (user_id, eaten_at DESC)`

  /* The brief is the one screen Alpha texts a link to, and building it costs a
   * calendar fetch, an inbox pull, and a model pass. The in-memory cache loses
   * everything on a deploy, so the last build is persisted here per day: a cold
   * container can serve today's brief on the spot and rebuild behind it. */
  await sql`
    CREATE TABLE IF NOT EXISTS hire_brief_cache (
      user_id TEXT NOT NULL REFERENCES hire_users(id) ON DELETE CASCADE,
      persona TEXT NOT NULL,
      kind TEXT NOT NULL,
      day TEXT NOT NULL,
      payload TEXT NOT NULL,
      built_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (user_id, persona, kind)
    )
  `

  await sql`
    CREATE TABLE IF NOT EXISTS hire_nutrition_goals (
      user_id TEXT PRIMARY KEY REFERENCES hire_users(id) ON DELETE CASCADE,
      calorie_goal REAL NOT NULL DEFAULT 2200,
      protein_goal REAL NOT NULL DEFAULT 150,
      carbs_goal REAL NOT NULL DEFAULT 220,
      fat_goal REAL NOT NULL DEFAULT 70,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `

  await sql`
    CREATE TABLE IF NOT EXISTS hire_habits (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES hire_users(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      emoji TEXT NOT NULL DEFAULT '💪',
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `
  await sql`CREATE INDEX IF NOT EXISTS idx_hire_habits_user ON hire_habits (user_id)`

  await sql`
    CREATE TABLE IF NOT EXISTS hire_habit_logs (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES hire_users(id) ON DELETE CASCADE,
      habit_id TEXT NOT NULL REFERENCES hire_habits(id) ON DELETE CASCADE,
      date TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `
  await sql`CREATE UNIQUE INDEX IF NOT EXISTS idx_hire_habit_logs_unique ON hire_habit_logs (habit_id, date)`
  await sql`CREATE INDEX IF NOT EXISTS idx_hire_habit_logs_user ON hire_habit_logs (user_id, date)`

  await sql`
    CREATE TABLE IF NOT EXISTS hire_moods (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES hire_users(id) ON DELETE CASCADE,
      emoji TEXT NOT NULL,
      energy INTEGER NOT NULL DEFAULT 3,
      note TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `
  await sql`CREATE INDEX IF NOT EXISTS idx_hire_moods_user ON hire_moods (user_id, created_at DESC)`

  await sql`
    CREATE TABLE IF NOT EXISTS hire_workouts (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES hire_users(id) ON DELETE CASCADE,
      exercise TEXT NOT NULL,
      sets INTEGER NOT NULL DEFAULT 1,
      reps INTEGER NOT NULL DEFAULT 1,
      weight REAL NOT NULL DEFAULT 0,
      notes TEXT,
      logged_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `
  await sql`CREATE INDEX IF NOT EXISTS idx_hire_workouts_user ON hire_workouts (user_id, logged_at DESC)`

  await sql`
    CREATE TABLE IF NOT EXISTS hire_learning (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES hire_users(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      url TEXT,
      kind TEXT NOT NULL DEFAULT 'article',
      minutes INTEGER NOT NULL DEFAULT 10,
      status TEXT NOT NULL DEFAULT 'queued',
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `
  await sql`CREATE INDEX IF NOT EXISTS idx_hire_learning_user ON hire_learning (user_id, created_at DESC)`
  await sql`ALTER TABLE hire_learning ADD COLUMN IF NOT EXISTS notes TEXT`

  await sql`
    CREATE TABLE IF NOT EXISTS hire_weekly_reviews (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES hire_users(id) ON DELETE CASCADE,
      week_start TEXT NOT NULL,
      done_text TEXT NOT NULL DEFAULT '',
      slipped_text TEXT NOT NULL DEFAULT '',
      focus_text TEXT NOT NULL DEFAULT '',
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `
  await sql`CREATE UNIQUE INDEX IF NOT EXISTS idx_hire_weekly_reviews_week ON hire_weekly_reviews (user_id, week_start)`
  await ensureUniqueConstraint(sql, 'hire_weekly_reviews', 'hire_weekly_reviews_user_week', 'idx_hire_weekly_reviews_week', 'user_id, week_start')

  await sql`
    CREATE TABLE IF NOT EXISTS hire_network (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES hire_users(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      where_met TEXT NOT NULL DEFAULT '',
      context TEXT NOT NULL DEFAULT '',
      last_touch TIMESTAMPTZ,
      cadence_days INTEGER NOT NULL DEFAULT 14,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `
  await sql`CREATE INDEX IF NOT EXISTS idx_hire_network_user ON hire_network (user_id, last_touch)`
  await sql`ALTER TABLE hire_network ADD COLUMN IF NOT EXISTS phone TEXT NOT NULL DEFAULT ''`
  await sql`ALTER TABLE hire_network ADD COLUMN IF NOT EXISTS email TEXT NOT NULL DEFAULT ''`
  await sql`ALTER TABLE hire_network ADD COLUMN IF NOT EXISTS company TEXT NOT NULL DEFAULT ''`

  /* One people list, not two. The Relationship Radar used to keep its own
   * table so the mini app and the CRM could disagree about the same person —
   * that split-brain is gone now, and these legacy rows move over once. The old
   * table stays in place (never dropped) so nothing breaks mid-migration. */
  await sql`
    INSERT INTO hire_network (id, user_id, name, where_met, context, cadence_days, last_touch, created_at)
    SELECT r.id, r.user_id, r.name, '', r.notes, r.cadence_days, r.last_touch_at, r.created_at
    FROM hire_relationships r
    WHERE r.id NOT IN (SELECT id FROM hire_network WHERE user_id = r.user_id)
  `

  await sql`
    CREATE TABLE IF NOT EXISTS hire_sleep (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES hire_users(id) ON DELETE CASCADE,
      sleep_date TEXT NOT NULL,
      bedtime TEXT NOT NULL,
      wake TEXT NOT NULL,
      quality INTEGER NOT NULL DEFAULT 3,
      note TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `
  await sql`CREATE UNIQUE INDEX IF NOT EXISTS idx_hire_sleep_day ON hire_sleep (user_id, sleep_date)`
  await ensureUniqueConstraint(sql, 'hire_sleep', 'hire_sleep_user_night', 'idx_hire_sleep_day', 'user_id, sleep_date')
  await sql`ALTER TABLE hire_sleep ADD COLUMN IF NOT EXISTS source TEXT`

  await sql`
    CREATE TABLE IF NOT EXISTS hire_pipeline (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES hire_users(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      company TEXT NOT NULL DEFAULT '',
      stage TEXT NOT NULL DEFAULT 'lead',
      notes TEXT NOT NULL DEFAULT '',
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `
  await sql`CREATE INDEX IF NOT EXISTS idx_hire_pipeline_user ON hire_pipeline (user_id, updated_at DESC)`
  await sql`ALTER TABLE hire_pipeline ADD COLUMN IF NOT EXISTS value REAL NOT NULL DEFAULT 0`
  await sql`ALTER TABLE hire_pipeline ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'deal'`

  await sql`
    CREATE TABLE IF NOT EXISTS hire_gratitude (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES hire_users(id) ON DELETE CASCADE,
      text TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `
  await sql`CREATE INDEX IF NOT EXISTS idx_hire_gratitude_user ON hire_gratitude (user_id, created_at DESC)`

  await sql`
    CREATE TABLE IF NOT EXISTS hire_spending (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES hire_users(id) ON DELETE CASCADE,
      amount REAL NOT NULL,
      category TEXT NOT NULL DEFAULT 'other',
      description TEXT NOT NULL DEFAULT '',
      spent_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `
  await sql`CREATE INDEX IF NOT EXISTS idx_hire_spending_user ON hire_spending (user_id, spent_at DESC)`

  await sql`
    CREATE TABLE IF NOT EXISTS hire_spending_budget (
      user_id TEXT PRIMARY KEY REFERENCES hire_users(id) ON DELETE CASCADE,
      weekly_budget REAL NOT NULL DEFAULT 400,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `

  await sql`
    CREATE TABLE IF NOT EXISTS hire_user_locations (
      user_id TEXT NOT NULL REFERENCES hire_users(id) ON DELETE CASCADE,
      kind TEXT NOT NULL CHECK (kind IN ('current', 'home', 'work')),
      latitude DOUBLE PRECISION NOT NULL,
      longitude DOUBLE PRECISION NOT NULL,
      accuracy_m REAL,
      label TEXT NOT NULL DEFAULT '',
      source TEXT NOT NULL DEFAULT 'manual',
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (user_id, kind)
    )
  `
  await sql`CREATE INDEX IF NOT EXISTS idx_hire_user_locations_user ON hire_user_locations (user_id, updated_at DESC)`

  await sql`
    CREATE TABLE IF NOT EXISTS hire_mini_prefs (
      user_id TEXT PRIMARY KEY REFERENCES hire_users(id) ON DELETE CASCADE,
      workout_place TEXT NOT NULL DEFAULT 'gym',
      workout_move_count INTEGER NOT NULL DEFAULT 4,
      workout_days TEXT NOT NULL DEFAULT '1,2,3,4,5',
      sleep_bedtime TEXT NOT NULL DEFAULT '23:00',
      sleep_wake TEXT NOT NULL DEFAULT '07:00',
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `
  await sql`ALTER TABLE hire_mini_prefs ADD COLUMN IF NOT EXISTS workout_move_count INTEGER NOT NULL DEFAULT 4`
  await sql`ALTER TABLE hire_mini_prefs ADD COLUMN IF NOT EXISTS workout_days TEXT NOT NULL DEFAULT '1,2,3,4,5'`

  // The mail kinds this user's own inbox has produced. The judge names a pile per
  // mail; storing the names is what stops the brief's group headers reshuffling
  // every run, because last week's names are offered back as the preferred set.
  await sql`
    CREATE TABLE IF NOT EXISTS hire_mail_kinds (
      user_id TEXT NOT NULL REFERENCES hire_users(id) ON DELETE CASCADE,
      kind TEXT NOT NULL,
      label TEXT NOT NULL,
      uses INTEGER NOT NULL DEFAULT 0,
      last_used_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (user_id, kind)
    )
  `
  await sql`CREATE INDEX IF NOT EXISTS idx_hire_mail_kinds_top ON hire_mail_kinds (user_id, uses DESC)`

  // Triage actions from the brief: done, skip, drafted, opened. Skip is the
  // learning signal — two skips on a sender bury its future picks; replies and
  // drafts promote it. One row per action so history is replayable.
  await sql`
    CREATE TABLE IF NOT EXISTS hire_mail_feedback (
      id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
      user_id TEXT NOT NULL REFERENCES hire_users(id) ON DELETE CASCADE,
      gmail_id TEXT NOT NULL,
      sender TEXT NOT NULL DEFAULT '',
      action TEXT NOT NULL,
      kind TEXT NOT NULL DEFAULT '',
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `
  await sql`CREATE INDEX IF NOT EXISTS idx_hire_mail_feedback_user ON hire_mail_feedback (user_id, sender, created_at DESC)`

  // Signups that gave a phone number wait here for a bot to text them first.
  // Bots claim rows over the internal API, attempt the intro, and ack; failed
  // claims keep attempts so Photon lines that cannot cold-text a target do not
  // retry forever — the signup screen tells the person to text first instead.
  await sql`
    CREATE TABLE IF NOT EXISTS hire_intro_queue (
      id TEXT PRIMARY KEY,
      phone_e164 TEXT NOT NULL,
      persona TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      attempts INTEGER NOT NULL DEFAULT 0,
      last_error TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      sent_at TIMESTAMPTZ,
      UNIQUE (phone_e164, persona)
    )
  `
  await sql`CREATE INDEX IF NOT EXISTS idx_hire_intro_queue_due ON hire_intro_queue (persona, status, attempts, created_at)`

  // Phone numbers that asked for a hire that is not live yet. Not the intro
  // queue: nobody texts them today. This is the launch-day list — when a
  // persona flips live, these rows convert to intro-queue entries.
  await sql`
    CREATE TABLE IF NOT EXISTS hire_soon_waitlist (
      phone_e164 TEXT NOT NULL,
      persona TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (phone_e164, persona)
    )
  `

  // Billing. One row per user+persona; checked out through Stripe, state kept
  // here so the bots and the dashboard can read entitlements without calling
  // Stripe on every request.
  await sql`
    CREATE TABLE IF NOT EXISTS hire_subscriptions (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES hire_users(id) ON DELETE CASCADE,
      persona TEXT NOT NULL,
      stripe_customer_id TEXT,
      stripe_subscription_id TEXT UNIQUE,
      status TEXT NOT NULL DEFAULT 'incomplete',
      price_id TEXT,
      current_period_end TIMESTAMPTZ,
      promo_started_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (user_id, persona)
    )
  `
  await sql`ALTER TABLE hire_subscriptions ADD COLUMN IF NOT EXISTS promo_started_at TIMESTAMPTZ`
  await sql`CREATE INDEX IF NOT EXISTS idx_hire_subscriptions_user ON hire_subscriptions (user_id, status)`

  // Proactive jobs a hire runs on a schedule. status walks pending → running →
  // done, with paused and failed as parking states; attempts mirrors the intro
  // queue so a flapping job stops after TASK_LOOP_MAX_ATTEMPTS. One row per
  // (user, persona, kind) keeps seeded defaults and handoffs from piling up.
  await sql`
    CREATE TABLE IF NOT EXISTS hire_task_loops (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES hire_users(id) ON DELETE CASCADE,
      persona TEXT NOT NULL,
      phone_e164 TEXT NOT NULL,
      kind TEXT NOT NULL,
      title TEXT NOT NULL DEFAULT '',
      payload JSONB NOT NULL DEFAULT '{}'::jsonb,
      status TEXT NOT NULL DEFAULT 'pending',
      attempts INTEGER NOT NULL DEFAULT 0,
      next_run TIMESTAMPTZ,
      last_result TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (user_id, persona, kind)
    )
  `
  await sql`CREATE INDEX IF NOT EXISTS idx_hire_task_loops_due ON hire_task_loops (persona, status, next_run)`

  // Invite codes handed out by an armed phone. The referrer is the row owner;
  // a redemption records who came in through the code.
  await sql`
    CREATE TABLE IF NOT EXISTS hire_invites (
      code TEXT PRIMARY KEY,
      phone_e164 TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      redeemed_by_phone TEXT,
      redeemed_at TIMESTAMPTZ
    )
  `
  await sql`CREATE INDEX IF NOT EXISTS idx_hire_invites_phone ON hire_invites (phone_e164)`

  // Referral ledger: every full set of three redeemed invite codes earns the
  // referrer one free month (id `${phone}:${n}` keeps the rows idempotent).
  await sql`
    CREATE TABLE IF NOT EXISTS hire_referral_rewards (
      id TEXT PRIMARY KEY,
      referrer_phone TEXT NOT NULL,
      reward TEXT NOT NULL DEFAULT 'free_month',
      friends_hired INT NOT NULL,
      status TEXT NOT NULL DEFAULT 'earned',
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `
  await sql`CREATE INDEX IF NOT EXISTS idx_hire_referral_rewards_phone ON hire_referral_rewards (referrer_phone)`

  // Referral credits: one free month per redeemed invite code, spent as a
  // 100% off coupon on the referrer's next checkout. source_code UNIQUE makes
  // the ledger idempotent (codes are single-use, so re-redeem cannot double
  // credit); used_at marks a credit spent at checkout.
  await sql`
    CREATE TABLE IF NOT EXISTS hire_referral_credits (
      id TEXT PRIMARY KEY,
      phone_e164 TEXT NOT NULL,
      source_code TEXT NOT NULL UNIQUE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      used_at TIMESTAMPTZ,
      used_for_persona TEXT
    )
  `
  await sql`CREATE INDEX IF NOT EXISTS idx_hire_referral_credits_phone ON hire_referral_credits (phone_e164)`

  // Receipts for things a hire actually did on the user's behalf, one row per
  // action with an optional undo hint for the client to render.
  await sql`
    CREATE TABLE IF NOT EXISTS hire_action_log (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES hire_users(id) ON DELETE CASCADE,
      persona TEXT NOT NULL,
      action TEXT NOT NULL,
      detail TEXT NOT NULL DEFAULT '',
      undo_hint TEXT,
      undone_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `
  await sql`CREATE INDEX IF NOT EXISTS idx_hire_action_log_user ON hire_action_log (user_id, created_at DESC)`

  // A person can silence a hire before it texts: bots check this before every
  // proactive send.
  await sql`
    CREATE TABLE IF NOT EXISTS hire_kill_switch (
      phone_e164 TEXT PRIMARY KEY,
      armed BOOLEAN NOT NULL DEFAULT false,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `

  // Feature votes. One vote per phone per idea keeps the tally honest.
  await sql`
    CREATE TABLE IF NOT EXISTS hire_wishlist (
      id TEXT PRIMARY KEY,
      phone_e164 TEXT NOT NULL,
      vote TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (phone_e164, vote)
    )
  `

  // Status page: each hire beats here after its replies so /api/status can say
  // who is up without the bots exposing their hosts.
  await sql`
    CREATE TABLE IF NOT EXISTS hire_heartbeat (
      persona TEXT PRIMARY KEY,
      last_beat TIMESTAMPTZ NOT NULL DEFAULT now(),
      reply_ms INTEGER
    )
  `

  // Delivered-but-unkept artifacts die with the day count; the sweep also runs
  // hourly from the server so a long-lived process keeps purging.
  try {
    await sweepExpiredArtifacts(sql, artifactsRoot())
  } catch {
    /* first boot may have no dir yet */
  }
  // Chat memory retention, same cadence as the artifact sweep: every
  // ensureHireSchema pass (boot and each deploy restart). Off unless
  // RETENTION_DAYS is set to a positive number of days.
  try {
    await purgeExpiredChatData(sql)
  } catch (err) {
    console.warn('[hire] retention purge failed', err)
  }
}

/**
 * Chat memory retention. Off by default: nothing is ever deleted unless
 * RETENTION_DAYS is set to a positive number of days, and then only
 * hire_memories rows untouched for that long go. Runs from ensureHireSchema,
 * next to the artifact sweep.
 */
export async function purgeExpiredChatData(sql: SQL) {
  const days = Number(process.env.RETENTION_DAYS || '')
  if (!Number.isFinite(days) || days <= 0) return
  await sql`DELETE FROM hire_memories WHERE updated_at < now() - make_interval(days => ${days})`
}

export type MailSenderSignal = { replies: number; skips: number }

/** Per-sender reply/skip counts over the last 60 days, for brief mail scoring. */
async function loadMailSenderSignals(
  sql: SQL,
  userId: string,
): Promise<Map<string, MailSenderSignal>> {
  const out = new Map<string, MailSenderSignal>()
  try {
    const rows = await sql`
      SELECT sender,
             count(*) FILTER (WHERE action IN ('drafted', 'replied'))::int AS replies,
             count(*) FILTER (WHERE action = 'skip')::int AS skips
      FROM hire_mail_feedback
      WHERE user_id = ${userId} AND created_at > now() - interval '60 days'
      GROUP BY sender
    `
    for (const r of rows as Array<{ sender: string; replies: number; skips: number }>) {
      if (!r.sender) continue
      out.set(r.sender, { replies: Number(r.replies) || 0, skips: Number(r.skips) || 0 })
    }
  } catch {
    // A missing or mid-migration table must not take the brief down.
  }
  return out
}

/**
 * Gmail ids the user already triaged out of the brief. Done, skip, and drafted
 * all mean the same thing for ranking: this mail had its chance. Kept for 21
 * days so a newsletter skipped once stays gone without growing forever.
 */
async function triagedMailIds(sql: SQL, userId: string): Promise<Set<string>> {
  try {
    const rows = await sql`
      SELECT DISTINCT gmail_id FROM hire_mail_feedback
      WHERE user_id = ${userId}
        AND action IN ('done', 'skip', 'drafted')
        AND created_at > now() - interval '21 days'
    `
    return new Set((rows as Array<{ gmail_id: string }>).map((r) => r.gmail_id).filter(Boolean))
  } catch {
    return new Set()
  }
}

/** Kinds this user's mail keeps producing, most used first. Offered to the judge. */
async function loadMailKindVocab(sql: SQL, userId: string, limit = 12): Promise<string[]> {
  try {
    const rows = await sql`
      SELECT kind FROM hire_mail_kinds
      WHERE user_id = ${userId}
      ORDER BY uses DESC, last_used_at DESC
      LIMIT ${limit}
    `
    return (rows as { kind: string }[]).map((r) => r.kind).filter(Boolean)
  } catch {
    return []
  }
}

/**
 * Record the kinds a run actually used, then drop the ones that never caught on.
 * A label seen once or twice and not since is a model one-off, not vocabulary —
 * leaving it in would keep offering it back and make the set grow forever.
 */
async function saveMailKindVocab(
  sql: SQL,
  userId: string,
  groups: Array<{ kind: string; label: string; count: number }>,
): Promise<void> {
  const rows = groups.filter((g) => g.kind && g.kind !== 'other' && g.count > 0)
  if (!rows.length) return
  try {
    for (const g of rows) {
      await sql`
        INSERT INTO hire_mail_kinds (user_id, kind, label, uses, last_used_at)
        VALUES (${userId}, ${g.kind}, ${g.label}, ${g.count}, now())
        ON CONFLICT (user_id, kind) DO UPDATE
          SET uses = hire_mail_kinds.uses + ${g.count},
              label = EXCLUDED.label,
              last_used_at = now()
      `
    }
    await sql`
      DELETE FROM hire_mail_kinds
      WHERE user_id = ${userId} AND uses < 3 AND last_used_at < now() - interval '60 days'
    `
  } catch (err) {
    // Vocabulary is an optimisation. A write failure must not cost the brief.
    console.warn('[mail-kinds] save failed', err)
  }
}

type LocationRow = {
  user_id: string
  kind: 'current' | 'home' | 'work'
  latitude: number
  longitude: number
  accuracy_m: number | null
  label: string
  source: string | null
  updated_at: Date
}

const LOCATION_KINDS = new Set(['current', 'home', 'work'])

async function loadLocations(sql: SQL, userId: string): Promise<LocationRow[]> {
  const rows = await sql`
    SELECT user_id, kind, latitude, longitude, accuracy_m, label, source, updated_at
    FROM hire_user_locations
    WHERE user_id = ${userId}
    ORDER BY updated_at DESC
  `
  return rows as LocationRow[]
}

async function getLocation(sql: SQL, userId: string, kind: 'current' | 'home' | 'work') {
  const rows = await sql`
    SELECT user_id, kind, latitude, longitude, accuracy_m, label, source, updated_at
    FROM hire_user_locations
    WHERE user_id = ${userId} AND kind = ${kind}
    LIMIT 1
  `
  return (rows[0] as LocationRow | undefined) ?? null
}

type MiniPrefs = {
  workoutPlace: 'home' | 'gym'
  workoutMoveCount: 4 | 5 | 6
  workoutDays: number[]
  sleepBedtime: string
  sleepWake: string
}

const DEFAULT_WORKOUT_DAYS = [1, 2, 3, 4, 5]

function isClock(v: string): boolean {
  return /^\d{2}:\d{2}$/.test(v)
}

function clampWorkoutMoveCount(v: unknown): 4 | 5 | 6 {
  const n = typeof v === 'number' ? v : Number(v)
  return n === 5 || n === 6 ? n : 4
}

/** '1,2,3,5,6' from the column, or an array from JSON — always a usable day set. */
function clampWorkoutDays(v: unknown): number[] {
  const raw = typeof v === 'string' ? v.split(',').map((x) => Number(x.trim())) : Array.isArray(v) ? v.map(Number) : []
  const days = [...new Set(raw.filter((n) => Number.isInteger(n) && n >= 0 && n <= 6))].sort((a, b) => a - b)
  return days.length ? days : [...DEFAULT_WORKOUT_DAYS]
}

async function loadMiniPrefs(sql: SQL, userId: string): Promise<MiniPrefs> {
  const rows = await sql`
    SELECT workout_place AS "workoutPlace", workout_move_count AS "workoutMoveCount",
           workout_days AS "workoutDays", sleep_bedtime AS "sleepBedtime", sleep_wake AS "sleepWake"
    FROM hire_mini_prefs WHERE user_id = ${userId} LIMIT 1
  `
  const row = rows[0] as (MiniPrefs & { workoutMoveCount?: unknown }) | undefined
  const place = row?.workoutPlace === 'home' ? 'home' : 'gym'
  return {
    workoutPlace: place,
    workoutMoveCount: clampWorkoutMoveCount(row?.workoutMoveCount),
    workoutDays: clampWorkoutDays(row?.workoutDays),
    sleepBedtime: isClock(row?.sleepBedtime || '') ? row!.sleepBedtime : '23:00',
    sleepWake: isClock(row?.sleepWake || '') ? row!.sleepWake : '07:00',
  }
}

async function saveMiniPrefs(sql: SQL, userId: string, patch: Partial<MiniPrefs>): Promise<MiniPrefs> {
  const cur = await loadMiniPrefs(sql, userId)
  const next: MiniPrefs = {
    workoutPlace: patch.workoutPlace === 'home' || patch.workoutPlace === 'gym' ? patch.workoutPlace : cur.workoutPlace,
    workoutMoveCount: patch.workoutMoveCount === 4 || patch.workoutMoveCount === 5 || patch.workoutMoveCount === 6
      ? patch.workoutMoveCount
      : cur.workoutMoveCount,
    workoutDays: patch.workoutDays?.length ? clampWorkoutDays(patch.workoutDays) : cur.workoutDays,
    sleepBedtime: isClock(patch.sleepBedtime || '') ? patch.sleepBedtime! : cur.sleepBedtime,
    sleepWake: isClock(patch.sleepWake || '') ? patch.sleepWake! : cur.sleepWake,
  }
  await sql`
    INSERT INTO hire_mini_prefs (user_id, workout_place, workout_move_count, workout_days, sleep_bedtime, sleep_wake, updated_at)
    VALUES (${userId}, ${next.workoutPlace}, ${next.workoutMoveCount}, ${next.workoutDays.join(',')}, ${next.sleepBedtime}, ${next.sleepWake}, now())
    ON CONFLICT (user_id) DO UPDATE SET
      workout_place = excluded.workout_place,
      workout_move_count = excluded.workout_move_count,
      workout_days = excluded.workout_days,
      sleep_bedtime = excluded.sleep_bedtime,
      sleep_wake = excluded.sleep_wake,
      updated_at = now()
  `
  return next
}

const CURRENT_LOCATION_HOURS = 24

/** Server-side: pick the active location to bias map/data queries with. */
async function pickActiveLocation(sql: SQL, userId: string): Promise<LocationRow | null> {
  const locs = await loadLocations(sql, userId)
  if (!locs.length) return null
  const current = locs.find((l) => l.kind === 'current')
  if (
    current &&
    Date.now() - new Date(current.updated_at).getTime() < CURRENT_LOCATION_HOURS * 60 * 60 * 1000
  ) {
    return current
  }
  return locs.find((l) => l.kind === 'home') || locs.find((l) => l.kind === 'work') || null
}

/** Safe label the bot may see; never contains raw coordinates. */
function locationLabel(loc: LocationRow): string {
  if (loc.kind === 'current') return 'current location'
  if (loc.kind === 'home') return 'Home'
  if (loc.kind === 'work') return 'Work'
  return loc.label || 'known location'
}

function coordsUsable(lat: unknown, lng: unknown): lat is number {
  return (
    typeof lat === 'number' &&
    Number.isFinite(lat) &&
    typeof lng === 'number' &&
    Number.isFinite(lng) &&
    Math.abs(lat) <= 90 &&
    Math.abs(lng) <= 180
  )
}

type AuthedUser = { id: string; email: string; name: string | null; timezone: string | null; phone: string | null }

async function getUserByEmail(sql: SQL, email: string) {
  const rows = await sql`
    SELECT id, email, name, timezone, phone_e164 AS phone FROM hire_users WHERE email = ${email} LIMIT 1
  `
  return (rows[0] as AuthedUser | undefined) ?? null
}

async function linkPhoneIfMissing(sql: SQL, user: AuthedUser, e164: string) {
  if (user.phone || !e164) return user
  try {
    await sql`
      UPDATE hire_users SET phone_e164 = ${e164}, updated_at = now()
      WHERE id = ${user.id} AND phone_e164 IS NULL
    `
    user.phone = e164
  } catch {
    // Unique conflict: another account already owns this number.
  }
  return user
}

async function getUserByPhone(sql: SQL, phone: string) {
  const raw = String(phone || '').trim()
  if (raw.includes('@')) {
    const byEmail = await getUserByEmail(sql, raw.toLowerCase())
    if (byEmail) return byEmail
  }
  const e164 = normalizePhone(raw)
  if (!e164) return null
  const last10 = e164.replace(/\D/g, '').slice(-10)
  const rows = await sql`
    SELECT id, email, name, timezone, phone_e164 AS phone FROM hire_users
    WHERE phone_e164 = ${e164}
       OR right(regexp_replace(coalesce(phone_e164, ''), '[^0-9]', '', 'g'), 10) = ${last10}
    LIMIT 1
  `
  const byPhone = (rows[0] as AuthedUser | undefined) ?? null
  if (byPhone) return byPhone

  const ticket = await sql`
    SELECT email FROM hire_login_tickets
    WHERE phone_e164 = ${e164}
       OR right(regexp_replace(coalesce(phone_e164, ''), '[^0-9]', '', 'g'), 10) = ${last10}
    ORDER BY created_at DESC
    LIMIT 1
  `
  const ticketEmail = String((ticket[0] as { email?: string } | undefined)?.email || '')
    .trim()
    .toLowerCase()
  if (ticketEmail.includes('@')) {
    const fromTicket = await getUserByEmail(sql, ticketEmail)
    if (fromTicket) return linkPhoneIfMissing(sql, fromTicket, e164)
  }

  const mem = await sql`
    SELECT user_id AS id FROM hire_memories
    WHERE key IN ('phone', 'phone_e164', 'imessage', 'email')
      AND (
        right(regexp_replace(value, '[^0-9]', '', 'g'), 10) = ${last10}
        OR lower(btrim(value)) = ${raw.toLowerCase()}
      )
    LIMIT 1
  `
  const memId = (mem[0] as { id?: string } | undefined)?.id
  if (memId) {
    const urows = await sql`
      SELECT id, email, name, timezone, phone_e164 AS phone FROM hire_users WHERE id = ${memId} LIMIT 1
    `
    const fromMem = (urows[0] as AuthedUser | undefined) ?? null
    if (fromMem) return linkPhoneIfMissing(sql, fromMem, e164)
  }
  return null
}

/** Resolve the caller from a signed web session, a signed mini token, or a session email. */
async function resolveAuthedUser(
  sql: SQL,
  input: { token?: string; session?: string; email?: string },
): Promise<{ user: AuthedUser | null; error?: Response }> {
  const email = String(input.email || '').trim().toLowerCase()
  if (input.session) {
    const ses = verifySessionToken(input.session)
    if (!ses) {
      return {
        user: null,
        error: json({ error: 'Session expired. Sign in again.', code: 'session_invalid' }, 401),
      }
    }
    const user = await getUserByEmail(sql, ses.email)
    if (!user) return { user: null, error: json({ error: 'No account found for that email' }, 404) }
    return { user }
  }
  if (input.token) {
    const tok = verifyMiniToken(input.token)
    if (tok) {
      const user = await getUserByPhone(sql, tok.phone)
      if (!user) return { user: null, error: json({ error: 'No account found for that phone' }, 404) }
      return { user }
    }
  }
  if (email.includes('@')) {
    const user = await getUserByEmail(sql, email)
    if (!user) return { user: null, error: json({ error: 'No account found for that email' }, 404) }
    return { user }
  }
  if (input.token) {
    return {
      user: null,
      error: json({ error: 'This link expired. Sign in to keep using it.', code: 'token_invalid' }, 401),
    }
  }
  return { user: null, error: json({ error: 'session or token required' }, 400) }
}

function clampNum(v: unknown, fallback = 0): number {
  const n = Number(v)
  return Number.isFinite(n) ? n : fallback
}

/** Day window in the user's timezone as UTC [start,end] for "today". */
export function todayWindowUtc(timezone: string, now = new Date()): { start: Date; end: Date } {
  const tz = timezone || 'America/Los_Angeles'
  const dtf = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  })
  const [y, mo, d] = dtf.format(now).split('-').map(Number)
  const wallStart = Date.UTC(y!, mo! - 1, d!)
  const offset = tzOffsetMs(wallStart, tz)
  return { start: new Date(wallStart - offset), end: new Date(wallStart - offset + 86_400_000) }
}

/** Week window (the Monday `weekStart` in the user's timezone) as UTC [start,end]. */
export function weekWindowUtc(weekStart: string, timezone: string): { start: Date; end: Date } {
  const tz = timezone || 'America/Los_Angeles'
  const [y, m, d] = String(weekStart).split('-').map(Number)
  const wallStart = Date.UTC(y || 1970, (m || 1) - 1, d || 1)
  const offset = tzOffsetMs(wallStart, tz)
  const start = new Date(wallStart - offset)
  return { start, end: new Date(start.getTime() + 7 * 86_400_000) }
}

function localDateStrInTz(d = new Date(), timezone?: string | null): string {
  const tz = timezone || 'America/Los_Angeles'
  try {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: tz,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(d)
  } catch {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: 'America/Los_Angeles',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(d)
  }
}

function shiftDateStr(dateStr: string, days: number): string {
  const [y, m, d] = dateStr.split('-').map(Number)
  return new Date(Date.UTC(y || 1970, (m || 1) - 1, (d || 1) + days)).toISOString().slice(0, 10)
}

function ymdOf(value: unknown): string {
  if (!value) return ''
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value.toISOString().slice(0, 10)
  const m = String(value).match(/(\d{4}-\d{2}-\d{2})/)
  return m?.[1] || ''
}

function mondayOfDateStr(dateStr: string): string {
  const [y, m, d] = dateStr.split('-').map(Number)
  const day = new Date(Date.UTC(y || 1970, (m || 1) - 1, d || 1)).getUTCDay()
  const diff = day === 0 ? 6 : day - 1
  return shiftDateStr(dateStr, -diff)
}

function weekDaysFromMonday(weekStart: string): string[] {
  return Array.from({ length: 7 }, (_, i) => shiftDateStr(weekStart, i))
}

function userMonday(user: { timezone?: string | null }, d = new Date()): string {
  return mondayOfDateStr(localDateStrInTz(d, user.timezone))
}

/** Date-only inputs become 9am in the user's timezone so "Thursday" stays Thursday. */
function parseFlexibleWhen(raw: string | undefined, timezone: string): string | null {
  const s = String(raw || '').trim()
  if (!s) return null
  const day = s.match(/^(\d{4}-\d{2}-\d{2})$/)
  if (day) {
    const [y, m, d] = day[1]!.split('-').map(Number)
    const wall = Date.UTC(y || 1970, (m || 1) - 1, d || 1, 9, 0, 0)
    return new Date(wall - tzOffsetMs(wall, timezone || 'America/Los_Angeles')).toISOString()
  }
  const at = new Date(s)
  if (Number.isNaN(at.getTime())) return null
  return at.toISOString()
}

/** Same wall-clock (in the user's zone) one day/week later, as a UTC ISO string. */
function nextReminderAt(utcIso: string, recurrence: string, timezone: string): string {
  const tz = timezone || 'America/Los_Angeles'
  const dtf = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  })
  const at = new Date(utcIso)
  const parts = dtf.formatToParts(at)
  const get = (t: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === t)?.value || ''
  const wall = Date.UTC(
    Number(get('year')),
    Number(get('month')) - 1,
    Number(get('day')),
    Number(get('hour')),
    Number(get('minute')),
    Number(get('second')),
  )
  const nextWall = wall + (recurrence === 'weekly' ? 7 : 1) * 86_400_000
  return new Date(nextWall - tzOffsetMs(nextWall, tz)).toISOString()
}

async function ensureUser(
  sql: SQL,
  email: string,
  phone?: string | null,
  name?: string | null,
  timezone?: string | null,
) {
  const existing = await getUserByEmail(sql, email)
  const e164 = normalizePhone(phone || '')
  const cleanName = name?.trim() ? name.trim() : null
  const cleanTz = resolveIanaTimezone(timezone)
  if (existing) {
    let changed = false
    if (e164 && existing.phone !== e164) {
      existing.phone = e164
      changed = true
    }
    if (cleanName && existing.name !== cleanName) {
      existing.name = cleanName
      changed = true
    }
    if (cleanTz && existing.timezone !== cleanTz) {
      existing.timezone = cleanTz
      changed = true
    }
    if (changed) {
      await sql`
        UPDATE hire_users SET
          phone_e164 = ${existing.phone},
          name = ${existing.name},
          timezone = ${existing.timezone},
          updated_at = now()
        WHERE id = ${existing.id}
      `
    }
    return existing
  }
  // A phone-first signup already created a placeholder row keyed on the
  // number; adopt it so this sign-in becomes the same person rather than
  // bouncing off the phone_e164 unique index.
  if (e164) {
    const byPhone = await getUserByPhone(sql, e164)
    if (byPhone) {
      await sql`
        UPDATE hire_users SET
          email = ${email},
          name = ${cleanName || byPhone.name},
          timezone = ${cleanTz || byPhone.timezone},
          updated_at = now()
        WHERE id = ${byPhone.id}
      `
      return { id: byPhone.id, email, name: cleanName || byPhone.name, timezone: cleanTz || byPhone.timezone, phone: e164 }
    }
  }
  const id = crypto.randomUUID()
  await sql`
    INSERT INTO hire_users (id, email, name, timezone, phone_e164)
    VALUES (${id}, ${email}, ${cleanName}, ${cleanTz}, ${e164})
  `
  return { id, email, name: cleanName, timezone: cleanTz, phone: e164 }
}

async function rememberUserTimezone(sql: SQL, userId: string, raw: string, persona?: Persona) {
  const tz = resolveIanaTimezone(raw)
  if (!tz) return null
  await sql`UPDATE hire_users SET timezone = ${tz}, updated_at = now() WHERE id = ${userId}`
  if (persona) {
    const ctx = await loadContext(sql, userId, persona)
    if (ctx.timezone !== tz) await upsertContext(sql, userId, persona, { timezone: tz })
  }
  return tz
}

async function loadRoster(sql: SQL, userId: string): Promise<Persona[]> {
  const rows = await sql`SELECT persona FROM hire_roster WHERE user_id = ${userId}`
  return rows
    .map((r: { persona: string }) => r.persona)
    .filter(isPersona)
}

async function loadContext(sql: SQL, userId: string, persona: Persona) {
  const rows = await sql`
    SELECT fields FROM hire_context WHERE user_id = ${userId} AND persona = ${persona} LIMIT 1
  `
  const fields = rows[0]?.fields
  if (!fields) return {} as Record<string, string>
  if (typeof fields === 'string') {
    try {
      return JSON.parse(fields) as Record<string, string>
    } catch {
      return {}
    }
  }
  return (typeof fields === 'object' ? fields : {}) as Record<string, string>
}

/** Normalize the stored `setup` field (array, JSON string, or absent) into string[]. */
function parseSetupField(raw: unknown): string[] {
  if (Array.isArray(raw)) return raw.map(String).filter(Boolean)
  if (typeof raw === 'string' && raw.trim()) {
    try {
      const parsed = JSON.parse(raw) as unknown
      return Array.isArray(parsed) ? parsed.map(String).filter(Boolean) : []
    } catch {
      return []
    }
  }
  return []
}

/**
 * Model config for nutrition macro estimation. Uses the same GMI setup the
 * bots use (GMI_API_KEY / GMI_BASE_URL / GMI_MODEL) so no extra API key or
 * third-party service is needed. Optionally overridable via NUTRITION_* vars.
 */
function nutritionModelConfig() {
  const apiKey =
    process.env.GMI_API_KEY ||
    process.env.NUTRITION_API_KEY ||
    process.env.HIREALPHA_API_KEY
  if (!apiKey) return null
  const baseUrl = (
    process.env.NUTRITION_BASE_URL ||
    process.env.GMI_BASE_URL ||
    'https://api.gmi-serving.com/v1'
  ).replace(/\/$/, '')
  const textModel =
    process.env.NUTRITION_MODEL ||
    process.env.GMI_MODEL ||
    'deepseek-ai/DeepSeek-V4-Flash-0731'
  const visionModel = process.env.NUTRITION_VISION_MODEL || 'MiniMaxAI/MiniMax-M3'
  return { apiKey, baseUrl, textModel, visionModel }
}

/** Detect the image MIME type from base64 magic bytes (JPEG/PNG/WebP/GIF). */
function imageMimeFromBase64(base64: string): string {
  const head = base64.slice(0, 32)
  if (head.startsWith('/9j/')) return 'image/jpeg'
  if (head.startsWith('iVBORw0KGgo')) return 'image/png'
  if (head.startsWith('UklGR')) return 'image/webp'
  if (head.startsWith('R0lGOD')) return 'image/gif'
  return 'image/jpeg'
}

/** Macros out of a reply no parser could rescue. Null when there is no calorie number to stand on. */
function salvageMacros(text: string): { calories: number; protein: number; carbs: number; fat: number } | null {
  const nums = extractNumericFields(text, ['calories', 'protein', 'carbs', 'fat'])
  if (!('calories' in nums)) return null
  return { calories: nums.calories!, protein: nums.protein ?? 0, carbs: nums.carbs ?? 0, fat: nums.fat ?? 0 }
}

/**
 * Estimate calories/protein/carbs/fat for a meal. Uses the same GMI setup as
 * the bots — a vision model (MiniMax M3) for photos, the standard GMI model
 * for text descriptions. Returns needsKey=true when no GMI key is configured
 * so the UI can fall back to manual/description entry.
 */
async function estimateNutrition(
  description: string,
  imageBase64: string,
): Promise<{
  ok: boolean
  needsKey?: boolean
  calories?: number
  protein?: number
  carbs?: number
  fat?: number
  guess?: string
  error?: string
}> {
  const cfg = nutritionModelConfig()
  if (!cfg) return { ok: false, needsKey: true }
  if (!description.trim() && !imageBase64) return { ok: false, error: 'Describe or photograph the meal first.' }

  const system =
    'You are a nutrition estimator. Estimate the macronutrients of the described meal. ' +
    'Reply with JSON only: {"guess":"<short name>","calories":N,"protein":N,"carbs":N,"fat":N}. ' +
    'protein/carbs/fat are grams, calories is kcal. Use realistic single-serving estimates. ' +
    'Print the object and nothing else — no explanation, no markdown fence.'

  const userContent: unknown[] = imageBase64
    ? [
        { type: 'text', text: description.trim() || 'Estimate the macros of the meal in this photo.' },
        { type: 'image_url', image_url: { url: `data:${imageMimeFromBase64(imageBase64)};base64,${imageBase64}` } },
      ]
    : [{ type: 'text', text: description.trim() }]

  /* One parse is not a verdict: the vision model flakes intermittently, and a
   * named meal can go through the text model alone. Each attempt is a fresh
   * call, so a transient failure costs one extra request, not a dead end. */
  const attempt = async (m: string, parts: unknown[]) => {
    try {
      const res = await fetch(`${cfg.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${cfg.apiKey}`,
          'User-Agent': 'HireAlpha/0.1 (nutrition)',
          Accept: 'application/json',
        },
        body: JSON.stringify({
          model: m,
          temperature: 0,
          // A reasoning model that ignores reasoning_effort spends its budget
          // thinking; at 320 the object was landing truncated or not at all.
          max_tokens: 700,
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: parts },
          ],
        }),
      })
      if (!res.ok) return null
      const data = (await res.json()) as {
        choices?: Array<{ message?: { content?: string; reasoning_content?: string } }>
      }
      const content = modelReplyText(data.choices?.[0]?.message)
      const parsed = extractJsonObject(content, ['calories'])
      const macros = parsed
        ? { calories: clampNum(parsed.calories), protein: clampNum(parsed.protein), carbs: clampNum(parsed.carbs), fat: clampNum(parsed.fat) }
        : salvageMacros(content)
      if (!macros) return null
      return { macros, guess: String(parsed?.guess || '') }
    } catch {
      return null
    }
  }

  const model = imageBase64 ? cfg.visionModel : cfg.textModel
  let hit = await attempt(model, userContent)
  if (!hit && imageBase64 && description.trim()) {
    // A failed photo retries through the text model: named food parses there.
    hit = await attempt(cfg.textModel, [{ type: 'text', text: description.trim() }])
  }
  if (!hit) hit = await attempt(model, userContent)
  if (!hit) {
    return { ok: false, error: 'Could not read the estimate. Try naming the food and the portion.' }
  }
  return {
    ok: true,
    guess: hit.guess || description.slice(0, 60) || 'meal',
    ...hit.macros,
  }
}

/**
 * Self-hosted speech-to-text (faster-whisper-server, OpenAI-compatible).
 * Configure via STT_URL (defaults to an internal whisper service name on the
 * Coolify network) and STT_MODEL. Returns transcription text or throws.
 */
async function transcribeAudio(mimeType: string, audioBytes: Uint8Array): Promise<{ text: string }> {
  const baseUrl = (process.env.STT_URL || 'http://whisper-hkwfzdglv38jeqhzxys4xkvd:8000/v1').replace(/\/$/, '')
  const model = process.env.STT_MODEL || 'small'
  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), 120_000)
  try {
    const form = new FormData()
    const ext = mimeType.includes('mpeg') ? 'mpeg' : mimeType.includes('webm') ? 'webm' : 'm4a'
    form.append('file', new Blob([audioBytes], { type: mimeType }), `voice.${ext}`)
    form.append('model', model)
    const res = await fetch(`${baseUrl}/audio/transcriptions`, {
      method: 'POST',
      body: form,
      signal: ctrl.signal,
    })
    if (!res.ok) {
      const t2 = await res.text().catch(() => '')
      throw new Error(`Whisper ${res.status}: ${t2.slice(0, 160)}`)
    }
    const data = (await res.json()) as { text?: string }
    const text = String(data.text || '').trim()
    if (!text) throw new Error('Whisper returned empty transcript')
    return { text }
  } finally {
    clearTimeout(t)
  }
}

export type MemoryRow = { key: string; value: string; durable: boolean; updatedAt?: string }

const DURABLE_KEYS = new Set([
  'preferred_name',
  'people',
  'timezone',
  'check_ins',
  'company',
  'role_title',
  'projects',
  'standup_time',
  'company_name',
  'stage',
  'weekly_focus',
  'hard_nos',
  'name',
  'sister',
  'sister_flight',
  'partner',
  'city',
  'this_weeks_decision',
])

export function isDurableKey(key: string) {
  const k = key.trim().toLowerCase()
  if (DURABLE_KEYS.has(k)) return true
  return /^(people|name|sister|partner|family|company|weekly|timezone)/.test(k)
}

async function loadMemories(sql: SQL, userId: string, persona: Persona, limit = 12): Promise<MemoryRow[]> {
  const rows = await sql`
    SELECT key, value, durable, updated_at AS "updatedAt"
    FROM hire_memories
    WHERE user_id = ${userId} AND persona = ${persona}
    ORDER BY durable DESC, updated_at DESC
    LIMIT ${limit}
  `
  return (rows as { key: string; value: string; durable: boolean; updatedAt: Date }[]).map((r) => ({
    key: r.key,
    value: r.value,
    durable: !!r.durable,
    updatedAt: r.updatedAt ? new Date(r.updatedAt).toISOString() : undefined,
  }))
}

async function upsertMemories(
  sql: SQL,
  userId: string,
  persona: Persona,
  facts: Array<{ key: string; value: string; durable?: boolean }>,
) {
  for (const f of facts) {
    const key = String(f.key || '')
      .trim()
      .toLowerCase()
      .replace(/\s+/g, '_')
      .slice(0, 80)
    const value = String(f.value || '').trim().slice(0, 500)
    if (!key || !value) continue
    const durable = f.durable ?? isDurableKey(key)
    await sql`
      INSERT INTO hire_memories (user_id, persona, key, value, durable, updated_at)
      VALUES (${userId}, ${persona}, ${key}, ${value}, ${durable}, now())
      ON CONFLICT (user_id, persona, key)
      DO UPDATE SET value = excluded.value, durable = hire_memories.durable OR excluded.durable, updated_at = now()
    `
  }
}

async function syncContextMemories(sql: SQL, userId: string, persona: Persona, fields: Record<string, string>) {
  const facts = Object.entries(fields)
    .filter(([k, v]) => k !== 'setup' && typeof v === 'string' && v.trim())
    .map(([key, value]) => ({ key, value: value.trim(), durable: true }))
  if (facts.length) await upsertMemories(sql, userId, persona, facts)
}

async function googleConnected(sql: SQL, userId: string) {
  const rows = await sql`
    SELECT scopes, expires_at, refresh_token FROM hire_google_tokens WHERE user_id = ${userId} LIMIT 1
  `
  return rows[0]
    ? {
        scopes: String(rows[0].scopes || ''),
        expiresAt: rows[0].expires_at as Date | null,
        hasRefresh: !!rows[0].refresh_token,
      }
    : null
}

function composioClient(): Composio | null {
  if (!composioKey()) return null
  return new Composio({ allowTracking: false })
}

async function composioConnected(userId: string): Promise<string[]> {
  const composio = composioClient()
  if (!composio) return []
  try {
    const data = await Promise.race([
      composio.connectedAccounts.list({
        userIds: [userId],
        statuses: ['ACTIVE'],
        limit: 50,
      }),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('composio list timeout')), 4000)),
    ])
    return (data.items || [])
      .filter((i) => !i.isDisabled)
      .map((i) => (i.toolkit?.slug || '').toLowerCase())
      .filter(Boolean)
  } catch (err) {
    console.warn('[composio] connected list failed', err)
    return []
  }
}

function googleUiConnected(scopes: string): string[] {
  const out: string[] = []
  if (scopes.includes('gmail')) out.push('gmail')
  if (scopes.includes('calendar')) out.push('calendar')
  if (scopes.includes('drive')) out.push('drive')
  return out
}

async function connectedForUser(sql: SQL, userId: string): Promise<string[]> {
  const [g, c] = await Promise.all([googleConnected(sql, userId), composioConnected(userId)])
  const set = new Set<string>()
  if (g) googleUiConnected(g.scopes).forEach((id) => set.add(id))
  for (const slug of c) {
    const ui =
      COMPOSIO_SLUG_ALIASES[slug] ||
      Object.entries(UI_TO_COMPOSIO).find(([, v]) => v === slug)?.[0]
    if (ui) set.add(ui)
    else set.add(slug)
  }
  return [...set]
}

async function composioAuthConfigId(sql: SQL, toolkit: string): Promise<string | null> {
  const cached = await sql`
    SELECT auth_config_id FROM hire_composio_auth WHERE toolkit = ${toolkit} LIMIT 1
  `
  if (cached[0]?.auth_config_id) return String(cached[0].auth_config_id)

  const composio = composioClient()
  if (!composio) return null

  const listed = await composio.authConfigs.list({ toolkit })
  const id = listed.items?.[0]?.id
  if (id) {
    await sql`
      INSERT INTO hire_composio_auth (toolkit, auth_config_id)
      VALUES (${toolkit}, ${id})
      ON CONFLICT (toolkit) DO UPDATE SET auth_config_id = excluded.auth_config_id
    `
    return id
  }

  const created = await composio.authConfigs.create(toolkit, {
    type: 'use_composio_managed_auth',
  })
  if (!created?.id) return null
  await sql`
    INSERT INTO hire_composio_auth (toolkit, auth_config_id)
    VALUES (${toolkit}, ${created.id})
    ON CONFLICT (toolkit) DO UPDATE SET auth_config_id = excluded.auth_config_id
  `
  return created.id
}

async function composioAuthorize(sql: SQL, userId: string, toolkit: string, callbackUrl: string) {
  const authConfigId = await composioAuthConfigId(sql, toolkit)
  if (!authConfigId) return null
  const composio = composioClient()
  if (!composio) return null
  const request = await composio.connectedAccounts.link(userId, authConfigId, { callbackUrl })
  return request.redirectUrl || null
}

async function googleAccessToken(
  sql: SQL,
  userId: string,
  need?: 'gmail' | 'calendar' | 'drive',
): Promise<string | null> {
  const creds = googleCreds()
  const rows = await sql`
    SELECT access_token, refresh_token, expires_at, scopes FROM hire_google_tokens WHERE user_id = ${userId} LIMIT 1
  `
  const row = rows[0] as
    | { access_token: string; refresh_token: string | null; expires_at: Date | null; scopes: string | null }
    | undefined
  if (!row) return null
  if (need && !googleTokenHasScope(String(row.scopes || ''), need)) return null
  const exp = row.expires_at ? new Date(row.expires_at).getTime() : 0
  if (exp > Date.now() + 60_000) return row.access_token
  if (!creds || !row.refresh_token) return null
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: creds.clientId,
      client_secret: creds.clientSecret,
      refresh_token: row.refresh_token,
      grant_type: 'refresh_token',
    }),
  })
  if (!res.ok) return null
  const tok = (await res.json()) as { access_token: string; expires_in?: number }
  const expiresAt = new Date(Date.now() + (tok.expires_in || 3600) * 1000).toISOString()
  await sql`
    UPDATE hire_google_tokens
    SET access_token = ${tok.access_token}, expires_at = ${expiresAt}, updated_at = now()
    WHERE user_id = ${userId}
  `
  return tok.access_token
}

async function fetchGmail(access: string, query: string, maxResults = 8) {
  const cap = Math.max(1, Math.min(40, maxResults))
  const listUrl = new URL('https://gmail.googleapis.com/gmail/v1/users/me/messages')
  listUrl.searchParams.set('maxResults', String(cap))
  listUrl.searchParams.set('q', query)
  const list = await fetch(listUrl, { headers: { Authorization: `Bearer ${access}` } })
  if (!list.ok) return `Gmail error ${list.status}`
  const data = (await list.json()) as { messages?: Array<{ id: string }> }
  const ids = (data.messages || []).slice(0, cap)
  const lines = (
    await Promise.all(
      ids.map(async (m) => {
        const got = await fetch(
          `https://gmail.googleapis.com/gmail/v1/users/me/messages/${m.id}?format=metadata&metadataHeaders=Subject&metadataHeaders=From&metadataHeaders=Date`,
          { headers: { Authorization: `Bearer ${access}` } },
        )
        if (!got.ok) return null
        const msg = (await got.json()) as {
          snippet?: string
          payload?: { headers?: Array<{ name: string; value: string }> }
        }
        const headers = msg.payload?.headers || []
        const h = (n: string) => headers.find((x) => x.name.toLowerCase() === n.toLowerCase())?.value || ''
        return `- ${h('From')} | ${h('Date')} | ${h('Subject')} | ${msg.snippet || ''}`
      }),
    )
  ).filter((line): line is string => !!line)
  return lines.length ? `Email:\n${lines.join('\n')}` : 'No matching email found.'
}

function startOfLocalDay(timezone: string, dayOffset = 0): Date {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone || 'UTC',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).formatToParts(new Date())
  const get = (t: string) => parts.find((p) => p.type === t)?.value || '00'
  const localNow = `${get('year')}-${get('month')}-${get('day')}T${get('hour')}:${get('minute')}:${get('second')}`
  const ymd = new Date(
    Date.UTC(Number(get('year')), Number(get('month')) - 1, Number(get('day')) + dayOffset),
  )
    .toISOString()
    .slice(0, 10)
  const offsetMs = Date.now() - Date.parse(localNow + 'Z')
  return new Date(Date.parse(`${ymd}T00:00:00Z`) + offsetMs)
}

async function fetchCalendarItems(
  access: string,
  opts?: { timeMin?: Date; timeMax?: Date; maxResults?: number },
): Promise<{ ok: true; items: CalItem[] } | { ok: false; status: number }> {
  const now = opts?.timeMin || new Date()
  const end = opts?.timeMax || new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000)
  const url = new URL('https://www.googleapis.com/calendar/v3/calendars/primary/events')
  url.searchParams.set('timeMin', now.toISOString())
  url.searchParams.set('timeMax', end.toISOString())
  url.searchParams.set('singleEvents', 'true')
  url.searchParams.set('orderBy', 'startTime')
  url.searchParams.set('conferenceDataVersion', '1')
  url.searchParams.set('maxResults', String(opts?.maxResults || 8))
  const res = await fetch(url, { headers: { Authorization: `Bearer ${access}` } })
  if (!res.ok) {
    console.warn('[calendar] google list failed', res.status)
    return { ok: false, status: res.status }
  }
  const data = (await res.json()) as {
    items?: Array<{
      summary?: string
      description?: string
      location?: string
      hangoutLink?: string
      start?: { dateTime?: string; date?: string }
      conferenceData?: { entryPoints?: Array<{ entryPointType?: string; uri?: string }> }
    }>
  }
  return { ok: true, items: parseGoogleCalendarItems(data.items || []) }
}

function isCalendarToolResult(t: string) {
  return t.startsWith('Upcoming events') || t.startsWith('No events')
}

async function fetchCalendarViaComposio(
  userId: string,
  opts?: { timeMin?: Date; timeMax?: Date; maxResults?: number },
  timezone = 'America/Los_Angeles',
): Promise<string> {
  const now = opts?.timeMin || new Date()
  const end = opts?.timeMax || new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000)
  const timeMin = now.toISOString()
  const timeMax = end.toISOString()
  const maxResults = opts?.maxResults || 8
  const raw = await composioFirst(
    userId,
    ['GOOGLECALENDAR_EVENTS_LIST', 'GOOGLECALENDAR_FIND_EVENT'],
    {
      timeMin,
      timeMax,
      time_min: timeMin,
      time_max: timeMax,
      max_results: maxResults,
      maxResults,
      singleEvents: true,
      single_events: true,
      orderBy: 'startTime',
      calendarId: 'primary',
      calendar_id: 'primary',
    },
  )
  if (!raw) return 'Calendar lookup failed. Do not invent events. Tell them to reconnect Calendar in Settings.'
  if (isCalendarToolResult(raw)) return raw
  if (/failed/i.test(raw)) {
    return 'Calendar lookup failed. Do not invent events. Tell them to reconnect Calendar in Settings.'
  }
  try {
    const parsed = JSON.parse(raw) as { __calItems?: Array<{ start: string; title: string; allDay?: boolean; kind?: string; rawStart?: string; description?: string }> }
    if (Array.isArray(parsed.__calItems)) {
      return formatUpcomingEvents(hydrateCalItems(parsed.__calItems), timezone)
    }
    return formatUpcomingEvents(parseComposioCalendarData(parsed), timezone)
  } catch {
    return raw.slice(0, 4000)
  }
}

async function loadCalendar(
  sql: SQL,
  userId: string,
  opts?: { timeMin?: Date; timeMax?: Date; maxResults?: number },
  timezone = 'America/Los_Angeles',
): Promise<string> {
  const access = await googleAccessToken(sql, userId, 'calendar')
  if (access) {
    const got = await fetchCalendarItems(access, opts)
    if (got.ok) return formatUpcomingEvents(got.items, timezone)
  }
  return fetchCalendarViaComposio(userId, opts, timezone)
}

/** Compact one-line-per-email rendering so the model sees the whole batch. */
function formatEmailOverview(data: unknown): string {
  return formatComposioMailBlock(parseComposioMailItems(data))
}

/**
 * Composio's raw result for one tool, unformatted. `composioExecute` turns data
 * into prose for the model; the mail rows need the structure kept so a message
 * id survives to the client.
 */
async function composioExecuteData(userId: string, tool: string, args: Record<string, unknown>): Promise<unknown> {
  const composio = composioClient()
  if (!composio) return null
  try {
    const res = await composio.tools.execute(tool, {
      userId,
      arguments: args,
      dangerouslySkipVersionCheck: true,
    })
    if (!res?.successful || res.error) {
      console.warn(`[composio] ${tool} failed`, res?.error || 'unknown error')
      return null
    }
    return res.data ?? null
  } catch (err) {
    console.warn(`[composio] ${tool} threw`, err instanceof Error ? err.message : String(err))
    return null
  }
}

async function composioExecute(userId: string, tool: string, args: Record<string, unknown>) {
  const composio = composioClient()
  if (!composio) return null
  try {
    const res = await composio.tools.execute(tool, {
      userId,
      arguments: args,
      dangerouslySkipVersionCheck: true,
    })
    if (!res?.successful || res.error) {
      return `Tool ${tool} failed: ${res.error || 'unknown error'}`
    }
    if (tool === 'GMAIL_FETCH_EMAILS') return formatEmailOverview(res.data)
    if (tool === 'GOOGLECALENDAR_EVENTS_LIST' || tool === 'GOOGLECALENDAR_FIND_EVENT') {
      return JSON.stringify({ __calItems: serializeCalItems(parseComposioCalendarData(res.data)) })
    }
    const formatted = formatComposioData(res.data)
    return formatted || JSON.stringify(res.data ?? {}).slice(0, 4000)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return `Tool ${tool} failed: ${msg.slice(0, 240)}`
  }
}

function wantsEmail(text: string) {
  return /\b(e-?mails?|inbox|gmail|unread|debrief|digest|brief me)\b/i.test(text)
}
function wantsImportantEmail(text: string) {
  return /\b(important|flagged|priority|debrief|digest|brief)\b/i.test(text)
}
function wantsCalendar(text: string) {
  return /\b(calendar|meeting|meetings|schedule|free time|what.?s on|agenda|tomorrow|today|standup|debrief|digest|brief)\b/i.test(text)
}
function wantsMaps(text: string) {
  return /\b(dinner|restaurants?|cafes?|bars?|coffee shops?|tonight|date night|places?|booth|maps|hangout|where (?:should|can) we)\b/i.test(
    text,
  )
}
function wantsWebSearch(text: string) {
  return /\b(ticket|tickets|showtime|showtimes|imax|70\s?mm|movie|movies|theater|theatre|fandango|cinema|regal|amc|concert|flight|hotel|price|cost|search (?:the )?(?:web|internet|online)|web search|look online|look up|browse|for accuracy|latest news|news about|how (?:much|many|do|to|old|far)|what (?:is|are|was|were|does)|when (?:is|does|did|was)|where (?:is|are|was|did)|who (?:is|was|are)|why (?:is|does|did)|define|meaning of|price of|recipe for|nutrition(?:al)? (?:info|facts|value|content)|calories? in|protein in)\b/i.test(text)
}
function wantsSlack(text: string) {
  return /\b(slack|thread|channel|#\w+)\b/i.test(text)
}
function wantsLinear(text: string) {
  return /\b(linear|ticket|tickets|issue|issues|backlog|triage)\b/i.test(text)
}
function wantsNotion(text: string) {
  return /\b(notion|wiki|doc|docs|notes?)\b/i.test(text)
}
function wantsDrive(text: string) {
  return /\b(drive|deck|slides|spreadsheet|google doc)\b/i.test(text)
}
function wantsGithub(text: string) {
  return /\b(github|pull requests?|\bprs?\b|repos?)\b/i.test(text)
}
function wantsFigma(text: string) {
  return /\b(figma|design file|mockups?)\b/i.test(text)
}
function wantsSpotify(text: string) {
  return /\b(spotify|playlist|now playing|what.?s playing)\b/i.test(text)
}
function wantsStripe(text: string) {
  return /\b(stripe|revenue|mrr|arr|charges?|invoices?)\b/i.test(text)
}
function wantsPlaid(text: string) {
  return /\b(plaid|bank|bank account|checking account|savings account|bank balance|bank transactions|mercury|brex|chase|bofa|wells fargo|credit card balance)\b/i.test(text)
}

async function runComposioPlugin(userId: string, id: string, message: string): Promise<string> {
  const spec = COMPOSIO_READ[id]
  if (!spec) return `${id} is not wired. Do not invent a result.`
  const out = await composioFirst(userId, spec.slugs, spec.args(message))
  if (!out || composioLooksFailed(out)) return spec.empty
  return out
}

/**
 * Structured Gmail fetch: returns message id + headers, no text formatting.
 * `null` means Google refused the list — distinct from an empty inbox, which is
 * `[]`. The caller needs the difference to know whether to try Composio.
 */
async function fetchGmailRich(
  access: string,
  query: string,
  maxResults = 8,
): Promise<Array<{ id: string; from: string; date: string; subject: string; snippet: string }> | null> {
  const cap = Math.max(1, Math.min(40, maxResults))
  const listUrl = new URL('https://gmail.googleapis.com/gmail/v1/users/me/messages')
  listUrl.searchParams.set('maxResults', String(cap))
  listUrl.searchParams.set('q', query)
  const list = await fetch(listUrl, { headers: { Authorization: `Bearer ${access}` } })
  if (!list.ok) return null
  const data = (await list.json()) as { messages?: Array<{ id: string }> }
  const ids = (data.messages || []).slice(0, cap)
  const results = (
    await Promise.all(
      ids.map(async (m) => {
        const got = await fetch(
          `https://gmail.googleapis.com/gmail/v1/users/me/messages/${m.id}?format=metadata&metadataHeaders=Subject&metadataHeaders=From&metadataHeaders=Date`,
          { headers: { Authorization: `Bearer ${access}` } },
        )
        if (!got.ok) return null
        const msg = (await got.json()) as {
          snippet?: string
          payload?: { headers?: Array<{ name: string; value: string }> }
        }
        const headers = msg.payload?.headers || []
        const h = (n: string) => headers.find((x) => x.name.toLowerCase() === n.toLowerCase())?.value || ''
        return { id: m.id, from: h('From'), date: h('Date'), subject: h('Subject'), snippet: msg.snippet || '' }
      }),
    )
  ).filter((item): item is NonNullable<typeof item> => !!item)
  return results
}

/** The Gmail read slugs from the plugin spec, first one that answers wins. */
async function composioMailData(userId: string, args: Record<string, unknown>): Promise<unknown> {
  for (const slug of COMPOSIO_READ.gmail!.slugs) {
    const data = await composioExecuteData(userId, slug, args)
    if (data != null) return data
  }
  return null
}

/** Gmail through Composio, for accounts that connected it that way. */
async function composioGmailRich(
  userId: string,
  query: string,
  maxResults = 8,
): Promise<ComposioMailItem[]> {
  const data = await composioMailData(userId, { max_results: maxResults, query, verbose: false })
  if (data == null) return []
  // A row with no message id cannot be opened later, so it is not offered.
  return parseComposioMailItems(data)
    .filter((m) => m.id)
    .slice(0, maxResults)
}

/**
 * One full message through Composio. The by-id read is tried first; if the
 * connector does not expose it, fall back to a verbose recent-mail list and pick
 * the matching row. The list is only reached on a tap, never on a page load.
 */
async function composioMailBody(userId: string, msgId: string): Promise<ComposioMailBody | null> {
  const byId = await composioExecuteData(userId, 'GMAIL_FETCH_MESSAGE_BY_MESSAGE_ID', {
    message_id: msgId,
    user_id: 'me',
    format: 'full',
  })
  const hasBody = (b: ComposioMailBody | null) => !!b && !!(b.bodyText || b.bodyHtml || b.snippet)
  const direct = byId == null ? null : parseComposioMailBody(byId, msgId)
  if (hasBody(direct)) return direct
  const listed = await composioMailData(userId, { max_results: 25, query: 'newer_than:14d', verbose: true })
  if (listed == null) return null
  const found = parseComposioMailBody(listed, msgId)
  return hasBody(found) ? found : null
}

/**
 * The header half of one message through Composio. Separate from
 * composioMailBody because that one insists on a body — right for a reader,
 * wrong for a draft, which only needs a From line. A connector that returns
 * headers but no body used to fail a reply outright.
 */
async function composioMailHeaders(userId: string, msgId: string): Promise<ComposioMailBody | null> {
  const byId = await composioExecuteData(userId, 'GMAIL_FETCH_MESSAGE_BY_MESSAGE_ID', {
    message_id: msgId,
    user_id: 'me',
    format: 'full',
  })
  const direct = byId == null ? null : parseComposioMailBody(byId, msgId)
  if (direct?.from) return direct
  const listed = await composioMailData(userId, { max_results: 25, query: 'newer_than:14d', verbose: true })
  if (listed == null) return direct
  return parseComposioMailBody(listed, msgId) || direct
}

/**
 * Like loadGmail but returns structured items with Gmail message IDs. Google
 * first, then Composio for accounts connected that way — without the fallback
 * those accounts show an empty inbox on home and in the brief while Settings
 * says Gmail is connected.
 */
async function loadGmailRich(
  sql: SQL,
  userId: string,
  query: string,
  maxResults = 8,
): Promise<Array<{ id: string; from: string; date: string; subject: string; snippet: string }>> {
  try {
    const access = await googleAccessToken(sql, userId, 'gmail')
    if (access) {
      const rich = await fetchGmailRich(access, query, maxResults)
      if (rich) return rich
    }
    return await composioGmailRich(userId, query, maxResults)
  } catch {
    return []
  }
}

async function loadGmail(sql: SQL, userId: string, query: string, maxResults = 8): Promise<string> {
  const access = await googleAccessToken(sql, userId, 'gmail')
  if (access) {
    const out = await fetchGmail(access, query, maxResults)
    if (!/^Gmail error \d/.test(out)) return out
    console.warn('[gmail] google failed', out)
  }
  const spec = COMPOSIO_READ.gmail!
  const out = await composioFirst(userId, spec.slugs, {
    max_results: maxResults,
    query,
    verbose: false,
  })
  if (!out || composioLooksFailed(out)) return spec.empty
  return out
}

async function loadDrive(sql: SQL, userId: string, query: string): Promise<string> {
  const access = await googleAccessToken(sql, userId, 'drive')
  if (access) {
    const out = await fetchDrive(access, query)
    if (!/^Drive error \d/.test(out)) return out
    console.warn('[drive] google failed', out)
  }
  return runComposioPlugin(userId, 'drive', query)
}

async function fetchDrive(access: string, query: string) {
  const url = new URL('https://www.googleapis.com/drive/v3/files')
  url.searchParams.set('pageSize', '8')
  url.searchParams.set('orderBy', 'modifiedTime desc')
  url.searchParams.set('fields', 'files(id,name,mimeType,modifiedTime)')
  const q = query.replace(/['\\]/g, '').slice(0, 80)
  url.searchParams.set(
    'q',
    q ? `trashed = false and name contains '${q}'` : 'trashed = false',
  )
  const res = await fetch(url, { headers: { Authorization: `Bearer ${access}` } })
  if (!res.ok) return `Drive error ${res.status}`
  const data = (await res.json()) as {
    files?: Array<{ name?: string; mimeType?: string; modifiedTime?: string }>
  }
  const files = data.files || []
  if (!files.length) return 'No matching Drive files.'
  return `Drive files:\n${files
    .map((f) => `- ${f.name || '(untitled)'} (${f.mimeType || '?'}) ${f.modifiedTime || ''}`)
    .join('\n')}`
}

function stripHtml(text: string) {
  return text
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function decodeHtml(text: string) {
  return text
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
}

async function fetchPublic(url: URL, init: RequestInit, timeoutMs = 8000) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    return await fetch(url, { ...init, signal: controller.signal })
  } finally {
    clearTimeout(timer)
  }
}

async function fetchWebSearch(query: string) {
  const q = query.trim().slice(0, 180)
  if (!q) return 'Web search needs a query.'
  const results: string[] = []
  
  // 1. DuckDuckGo HTML & Lite Search with standard browser headers
  try {
    const url = new URL('https://html.duckduckgo.com/html/')
    url.searchParams.set('q', q)
    const res = await fetchPublic(url, {
      headers: {
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
        'Accept-Language': 'en-US,en;q=0.9',
      },
    })
    if (res.ok) {
      const html = await res.text()
      const pattern = /<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi
      for (const match of html.matchAll(pattern)) {
        let href = decodeHtml(match[1] || '')
        try {
          const parsed = new URL(href.startsWith('//') ? `https:${href}` : href)
          href = parsed.searchParams.get('uddg') || href
        } catch {
          /* keep original */
        }
        const title = decodeHtml(stripHtml(match[2] || ''))
        if (title && href && !href.includes('duckduckgo.com')) {
          results.push(`- ${title}\n  ${href}`)
        }
        if (results.length >= 6) break
      }
    }
  } catch {
    /* fallback to instant answer / wikipedia */
  }

  // 2. DuckDuckGo Instant Answer JSON API Fallback
  if (!results.length) {
    try {
      const apiUrl = new URL('https://api.duckduckgo.com/')
      apiUrl.searchParams.set('q', q)
      apiUrl.searchParams.set('format', 'json')
      apiUrl.searchParams.set('no_html', '1')
      apiUrl.searchParams.set('skip_disambig', '1')
      const apiRes = await fetchPublic(apiUrl, {
        headers: { Accept: 'application/json', 'User-Agent': 'HireAlpha/1.0 (https://hirealpha.chat)' },
      })
      if (apiRes.ok) {
        const data = (await apiRes.json()) as {
          AbstractText?: string
          AbstractURL?: string
          Heading?: string
          RelatedTopics?: Array<{ Text?: string; FirstURL?: string }>
        }
        if (data.AbstractText && data.AbstractURL) {
          results.push(`- ${data.Heading || q}: ${data.AbstractText}\n  ${data.AbstractURL}`)
        }
        if (Array.isArray(data.RelatedTopics)) {
          for (const topic of data.RelatedTopics.slice(0, 4)) {
            if (topic.Text && topic.FirstURL) {
              results.push(`- ${topic.Text}\n  ${topic.FirstURL}`)
            }
          }
        }
      }
    } catch {
      /* continue */
    }
  }

  return results.length ? `Web results for "${q}":\n${results.join('\n')}` : `No web results found for "${q}".`
}

const FOREIGN_PLACE = /\b(bali|jakarta|thailand|indonesia|london|paris|tokyo|kyoto|athens|rome|madrid|berlin|amsterdam|sydney|melbourne|mumbai|delhi|bangkok|marrakech|dubai|singapore|hong\s?kong|europe|asia|africa|mexico city|canada|australia|india|france|italy|spain|germany|brazil|argentina|colombia|philippines|panama|uk|england|scotland|ireland)\b/i

function timezoneCountry(tz?: string) {
  if (!tz) return ''
  if (/^America\//.test(tz)) return 'us'
  if (tz === 'Europe/London' || tz === 'UTC') return 'gb'
  return ''
}

// A category ask ("good coffee") has no proper noun to geocode. Words map to
// kinds, kinds to the Overpass tags that can match them.
const MAP_WORD_KINDS: Record<string, string[]> = {
  cafe: ['cafe'],
  coffee: ['cafe'],
  restaurant: ['restaurant'],
  dinner: ['restaurant'],
  supper: ['restaurant'],
  lunch: ['restaurant', 'cafe'],
  breakfast: ['cafe', 'restaurant'],
  brunch: ['cafe', 'restaurant'],
  food: ['restaurant', 'cafe', 'fast_food'],
  eat: ['restaurant', 'cafe', 'fast_food'],
  bar: ['bar'],
  bars: ['bar'],
  drink: ['bar'],
  drinks: ['bar'],
  pub: ['bar'],
  bakery: ['bakery'],
  bakeries: ['bakery'],
  fast_food: ['fast_food'],
  ice_cream: ['ice_cream'],
  sushi: ['restaurant'],
  ramen: ['restaurant'],
  pizza: ['restaurant'],
  burger: ['restaurant'],
  tacos: ['restaurant'],
  mexican: ['restaurant'],
  thai: ['restaurant'],
  vietnamese: ['restaurant'],
  chinese: ['restaurant'],
  japanese: ['restaurant'],
  korean: ['restaurant'],
  indian: ['restaurant'],
  italian: ['restaurant'],
  pasta: ['restaurant'],
  noodles: ['restaurant'],
  bbq: ['restaurant'],
  seafood: ['restaurant'],
  deli: ['restaurant'],
  diner: ['restaurant'],
  gym: ['gym'],
  gyms: ['gym'],
  fitness: ['gym'],
  grocery: ['grocery'],
  groceries: ['grocery'],
  supermarket: ['grocery'],
  pharmacy: ['pharmacy'],
  pharmacies: ['pharmacy'],
  drugstore: ['pharmacy'],
  park: ['park'],
  parks: ['park'],
  hangout: ['cafe', 'bar', 'park'],
}

const MAP_KIND_TAGS: Record<string, string[]> = {
  cafe: ['amenity=cafe'],
  restaurant: ['amenity=restaurant'],
  bar: ['amenity=bar', 'amenity=pub'],
  bakery: ['shop=bakery'],
  fast_food: ['amenity=fast_food'],
  ice_cream: ['amenity=ice_cream'],
  gym: ['leisure=fitness_centre', 'amenity=gym'],
  grocery: ['shop=supermarket', 'shop=convenience'],
  pharmacy: ['amenity=pharmacy'],
  park: ['leisure=park'],
}

const MAP_FILLER_WORDS = new Set([
  'find', 'show', 'recommend', 'where', 'should', 'could', 'can', 'would', 'get', 'grab',
  'want', 'need', 'some', 'any', 'good', 'best', 'great', 'cheap', 'quiet', 'nice', 'cozy',
  'cute', 'cool', 'fun', 'top', 'open', 'late', 'tonight', 'today', 'now', 'nearby', 'near',
  'around', 'in', 'at', 'by', 'me', 'us', 'we', 'i', 'my', 'our', 'a', 'an', 'the', 'for',
  'to', 'of', 'and', 'please', 'place', 'places', 'spot', 'spots', 'maps', 'map',
])

export function classifyMapQuery(query: string): { mode: 'nearby'; kinds: string[] } | { mode: 'named' } {
  const normalized = query
    .toLowerCase()
    .replace(/['’]s\b/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\bfast food\b/g, ' fast_food ')
    .replace(/\bice cream\b/g, ' ice_cream ')
    .replace(/\s+/g, ' ')
    .trim()
  const lookup = (token: string) =>
    MAP_WORD_KINDS[token] || (token.endsWith('s') ? MAP_WORD_KINDS[token.slice(0, -1)] : undefined)
  const tokens = normalized.split(' ').filter((t) => t && !MAP_FILLER_WORDS.has(t))
  // Leading word decides: "golden gate park" is a place, "park near me" is not.
  if (!tokens.length || !lookup(tokens[0])) return { mode: 'named' }
  const kinds: string[] = []
  for (const token of tokens) {
    for (const kind of lookup(token) || []) {
      if (!kinds.includes(kind)) kinds.push(kind)
    }
  }
  return { mode: 'nearby', kinds }
}

export function buildOverpassQuery(kinds: string[], lat: number, lon: number, radiusM = 1600): string {
  const tags: string[] = []
  for (const kind of kinds) {
    // Accept both category words ("coffee") and kind names ("cafe").
    const names = MAP_WORD_KINDS[kind] || [kind]
    for (const name of names) {
      for (const tag of MAP_KIND_TAGS[name] || []) {
        if (!tags.includes(tag)) tags.push(tag)
      }
    }
  }
  if (!tags.length) return ''
  const at = `(around:${Math.max(50, Math.round(radiusM))},${lat},${lon})`
  const bodies = tags.map((tag) => {
    const [key, value] = tag.split('=')
    return `  node["${key}"="${value}"]${at};\n  way["${key}"="${value}"]${at};`
  })
  return `[out:json][timeout:10];\n(\n${bodies.join('\n')}\n);\nout center 30;`
}

export function formatMapResults(
  rows: Array<{ name: string; addr?: string; cuisine?: string; lat?: number; lon?: number }>,
  label: string,
): string {
  const seen = new Set<string>()
  const lines: string[] = []
  for (const row of rows) {
    const name = String(row.name || '').trim()
    if (!name || seen.has(name.toLowerCase())) continue
    seen.add(name.toLowerCase())
    const cuisine = String(row.cuisine || '')
      .trim()
      .split(';')[0]
      .replace(/_/g, ' ')
    const link =
      typeof row.lat === 'number' && typeof row.lon === 'number'
        ? `https://www.openstreetmap.org/?mlat=${row.lat}&mlon=${row.lon}#map=16/${row.lat}/${row.lon}`
        : ''
    lines.push(`- ${name}${cuisine ? ` (${cuisine})` : ''}${link ? `\n  ${link}` : ''}`)
    if (lines.length >= 6) break
  }
  if (!lines.length) return `No map results found for "${label}".`
  return `Map results for "${label}":\n${lines.join('\n')}`
}

async function geocodeMapArea(area: string, countryHint: string) {
  try {
    const url = new URL('https://nominatim.openstreetmap.org/search')
    url.searchParams.set('q', area)
    url.searchParams.set('format', 'jsonv2')
    url.searchParams.set('limit', '1')
    if (countryHint && !FOREIGN_PLACE.test(area)) url.searchParams.set('countrycodes', countryHint)
    const res = await fetchPublic(url, {
      headers: { Accept: 'application/json', 'User-Agent': 'HireAlpha/1.0 (https://hirealpha.chat)' },
    })
    if (!res.ok) return null
    const rows = (await res.json()) as Array<{ lat?: string; lon?: string }>
    const lat = Number(rows[0]?.lat)
    const lon = Number(rows[0]?.lon)
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null
    return { lat, lon }
  } catch {
    return null
  }
}

// Overpass for category asks; a null return falls back to the Nominatim path.
async function fetchNearbyPlaces(
  query: string,
  kinds: string[],
  countryHint: string,
  location: LocationRow | null,
): Promise<string | null> {
  try {
    const area = (query.match(/\b(?:in|near|around|at|by)\s+([a-z0-9\s]+)$/i)?.[1] || '')
      .replace(/\b(?:me|us|tonight)\b/gi, '')
      .replace(/\s+/g, ' ')
      .trim()
    let lat: number | null = null
    let lon: number | null = null
    if (location && coordsUsable(location.latitude, location.longitude)) {
      lat = location.latitude
      lon = location.longitude
    } else if (area) {
      const geo = await geocodeMapArea(area, countryHint)
      if (geo) {
        lat = geo.lat
        lon = geo.lon
      }
    }
    if (lat === null || lon === null) return null
    const ql = buildOverpassQuery(kinds, lat, lon)
    if (!ql) return null
    const res = await fetchPublic(
      new URL('https://overpass-api.de/api/interpreter'),
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Accept: 'application/json',
          'User-Agent': 'HireAlpha/1.0 (https://hirealpha.chat)',
        },
        body: `data=${encodeURIComponent(ql)}`,
      },
      12000,
    )
    if (!res.ok) return null
    const data = (await res.json()) as {
      elements?: Array<{
        tags?: Record<string, string>
        lat?: number
        lon?: number
        center?: { lat: number; lon: number }
      }>
    }
    const rows = (data.elements || [])
      .map((el) => {
        const tags = el.tags || {}
        const elLat = el.lat ?? el.center?.lat
        const elLon = el.lon ?? el.center?.lon
        const street = tags['addr:street'] || ''
        const housenumber = tags['addr:housenumber'] || ''
        return {
          name: String(tags.name || '').trim(),
          addr: [housenumber, street].filter(Boolean).join(' ') || tags['addr:city'] || '',
          cuisine: tags.cuisine || '',
          lat: typeof elLat === 'number' ? elLat : undefined,
          lon: typeof elLon === 'number' ? elLon : undefined,
        }
      })
      .filter((row) => row.name)
    if (!rows.length) return null
    return formatMapResults(rows, query.trim().slice(0, 60))
  } catch {
    return null
  }
}

export async function fetchMapSearch(query: string, countryHint = '', location: LocationRow | null = null) {
  const classified = classifyMapQuery(query)
  if (classified.mode === 'nearby') {
    const nearby = await fetchNearbyPlaces(query, classified.kinds, countryHint, location)
    if (nearby) return nearby
    // Overpass miss, no coords, or empty result: the named place path below answers.
  }
  if (location && !/\b(?:near|around|in|at|by)\b/i.test(query)) {
    const marker = locationLabel(location)
    query = `${query} near ${marker}`
  }
  const cleaned = query
    .replace(/\b(find|search|show|recommend|tonight|maps|hangout|near me|near us|nearby|near\b|around|where should we|where can we)\b/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  if (!cleaned || /^(quiet|good|best|eat|food|dinner|lunch|breakfast|coffee|drink|drink|hangout)$/i.test(cleaned)) {
    return 'Maps search needs a city, neighborhood, or address. Ask for a place in a specific area.'
  }
  try {
    const url = new URL('https://nominatim.openstreetmap.org/search')
    url.searchParams.set('q', cleaned)
    url.searchParams.set('format', 'jsonv2')
    url.searchParams.set('limit', '5')
    url.searchParams.set('dedupe', '1')
    if (location && coordsUsable(location.latitude, location.longitude) && !FOREIGN_PLACE.test(cleaned)) {
      url.searchParams.set('lat', String(location.latitude))
      url.searchParams.set('lon', String(location.longitude))
    } else if (countryHint && !FOREIGN_PLACE.test(cleaned)) {
      url.searchParams.set('countrycodes', countryHint)
    }
    const res = await fetchPublic(url, {
      headers: { Accept: 'application/json', 'User-Agent': 'HireAlpha/1.0 (https://hirealpha.chat)' },
    })
    if (!res.ok) return `Maps search unavailable (${res.status}).`
    const rows = (await res.json()) as Array<{ display_name?: string; lat?: string; lon?: string; type?: string }>
    if (!rows.length) return `No map results found for "${cleaned}".`
    return `Map results for "${cleaned}":\n${rows
      .map((row) => {
        const label = String(row.display_name || '').split(',').slice(0, 3).join(',')
        const link = row.lat && row.lon ? `https://www.openstreetmap.org/?mlat=${row.lat}&mlon=${row.lon}#map=16/${row.lat}/${row.lon}` : ''
        return `- ${label}${row.type ? ` (${row.type})` : ''}${link ? `\n  ${link}` : ''}`
      })
      .join('\n')}`
  } catch {
    return 'Maps search unavailable right now.'
  }
}

async function composioFirst(
  userId: string,
  slugs: string[],
  args: Record<string, unknown>,
): Promise<string | null> {
  let last: string | null = null
  for (const slug of slugs) {
    const out = await composioExecute(userId, slug, args)
    if (!out) continue
    last = out
    if (!/failed/i.test(out)) return out
  }
  return last
}

function notConnectedNote(tool: string, persona: Persona = 'friend') {
  const directUrl = `https://hirealpha.chat/app/hires/${persona}?connect=${encodeURIComponent(tool)}`
  return `${tool} is not connected yet. Tell them: "You can connect ${tool} directly here: ${directUrl}" so they can tap and connect it instantly with one tap without searching the site. Never claim you already did the action.`
}

export async function runToolsForMessage(
  sql: SQL,
  input: {
    userId: string
    persona: Persona
    message: string
    connected: string[]
    want?: 'maps' | 'web' | 'gmail' | 'calendar' | 'drive'
    timezone?: string
    location?: LocationRow | null
  },
): Promise<string[]> {
  const results: string[] = []
  const denied = PERSONA_DENIED[input.persona]
  const can = (id: string) => input.connected.includes(id) && !denied.has(id)
  const asked = (id: string, hit: boolean) => {
    if (!hit) return
    if (can(id)) return
    if (denied.has(id)) {
      results.push(`${id} is off limits for this hire. Do not offer it.`)
      return
    }
    results.push(notConnectedNote(id, input.persona))
  }
  const askedAllowed = (id: string, hit: boolean) => {
    if (!hit) return
    if (denied.has(id)) return
    asked(id, hit)
  }

  const mailHit = input.want === 'gmail' || wantsEmail(input.message)
  const calHit = input.want === 'calendar' || wantsCalendar(input.message)
  const mailQuery = /\b(debrief|digest|brief)\b/i.test(input.message)
    ? '(newer_than:1d) OR (is:important newer_than:2d)'
    : wantsImportantEmail(input.message)
      ? 'is:important newer_than:14d'
      : 'newer_than:5d'
  if (mailHit && can('gmail') && calHit && can('calendar')) {
    const brief = /\b(debrief|digest|brief|today|calendar|agenda|schedule)\b/i.test(input.message)
    const tz = input.timezone || 'America/Los_Angeles'
    const calOpts = brief
      ? { timeMin: startOfLocalDay(tz), timeMax: startOfLocalDay(tz, 2), maxResults: 20 }
      : undefined
    const [mail, cal] = await Promise.all([
      loadGmail(sql, input.userId, mailQuery, 8),
      loadCalendar(sql, input.userId, calOpts, tz),
    ])
    if (mail) results.push(mail)
    if (cal) results.push(cal)
  } else {
    if (mailHit && can('gmail')) {
      results.push(await loadGmail(sql, input.userId, mailQuery, 8))
    } else {
      askedAllowed('gmail', mailHit)
    }

    if (calHit && can('calendar')) {
      const brief = /\b(debrief|digest|brief|today|calendar|agenda|schedule)\b/i.test(input.message)
      const tz = input.timezone || 'America/Los_Angeles'
      const calOpts = brief
        ? { timeMin: startOfLocalDay(tz), timeMax: startOfLocalDay(tz, 2), maxResults: 20 }
        : undefined
      results.push(await loadCalendar(sql, input.userId, calOpts, tz))
    } else {
      askedAllowed('calendar', calHit)
    }
  }

  const mapsHit = input.want === 'maps' || (wantsMaps(input.message) && !calHit)
  if (mapsHit) {
    let mapsOut = ''
    if (can('maps')) mapsOut = await runComposioPlugin(input.userId, 'maps', input.message)
    if (!mapsOut || composioLooksFailed(mapsOut) || mapsOut === COMPOSIO_READ.maps!.empty) {
      mapsOut = await fetchMapSearch(input.message, timezoneCountry(input.timezone), input.location)
    }
    results.push(mapsOut)
  }

  if ((wantsWebSearch(input.message) && !wantsMaps(input.message) && input.want !== 'maps') || input.want === 'web') {
    results.push(await fetchWebSearch(input.message))
  }

  if (wantsSlack(input.message) && can('slack')) {
    results.push(await runComposioPlugin(input.userId, 'slack', input.message))
  } else {
    askedAllowed('slack', wantsSlack(input.message))
  }
  if (wantsLinear(input.message) && can('linear')) {
    results.push(await runComposioPlugin(input.userId, 'linear', input.message))
  } else {
    askedAllowed('linear', wantsLinear(input.message))
  }
  if (wantsNotion(input.message) && can('notion')) {
    results.push(await runComposioPlugin(input.userId, 'notion', input.message))
  } else {
    askedAllowed('notion', wantsNotion(input.message))
  }
  const driveHit = input.want === 'drive' || wantsDrive(input.message)
  if (driveHit && can('drive')) {
    results.push(await loadDrive(sql, input.userId, input.message.slice(0, 40)))
  } else {
    askedAllowed('drive', driveHit)
  }
  if (wantsGithub(input.message) && can('github')) {
    results.push(await runComposioPlugin(input.userId, 'github', input.message))
  } else {
    askedAllowed('github', wantsGithub(input.message))
  }
  if (wantsFigma(input.message) && can('figma')) {
    results.push(await runComposioPlugin(input.userId, 'figma', input.message))
  } else {
    askedAllowed('figma', wantsFigma(input.message))
  }
  if (wantsSpotify(input.message) && can('spotify')) {
    results.push(await runComposioPlugin(input.userId, 'spotify', input.message))
  } else {
    askedAllowed('spotify', wantsSpotify(input.message))
  }
  if (wantsStripe(input.message) && can('stripe')) {
    results.push(await runComposioPlugin(input.userId, 'stripe', input.message))
  } else {
    askedAllowed('stripe', wantsStripe(input.message))
  }
  if (wantsPlaid(input.message) && can('plaid')) {
    results.push(await runComposioPlugin(input.userId, 'plaid', input.message))
  } else {
    askedAllowed('plaid', wantsPlaid(input.message))
  }

  return results
}

const PERSONA_LABEL: Record<Persona, string> = {
  friend: 'Alpha',
  coworker: 'Alpha (Coworker)',
  cofounder: 'Alpha (CoFounder)',
}

function digestLines(block?: string): string[] {
  if (!block) return []
  return block.split('\n').filter((l) => l.startsWith('- '))
}

function formatCalTime(iso: string, timezone: string): string {
  const allDay = !iso.includes('T')
  const d = new Date(allDay ? `${iso}T00:00:00` : iso)
  if (Number.isNaN(d.getTime())) return iso
  if (allDay) return 'All day'
  return new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  }).format(d)
}

function formatMailLine(line: string): string {
  const [from, , subject] = line.replace(/^-\s*/, '').split(' | ')
  const s = (subject || '(no subject)').slice(0, 60)
  return from ? `${s} · ${from}` : s
}

function formatMailLineFromParts(from: string, subject: string): string {
  const cleanFrom = from.replace(/<[^>]+>/g, '').trim()
  const s = (subject || '(no subject)').slice(0, 60)
  return cleanFrom ? `${s} · ${cleanFrom}` : s
}

function withTimeout<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve(fallback), ms)
    p.then((v) => {
      clearTimeout(t)
      resolve(v)
    }).catch(() => {
      clearTimeout(t)
      resolve(fallback)
    })
  })
}

function parseCalMeet(title: string): { who: string; place: string } {
  const t = title.replace(/\s+/g, ' ').trim()
  const at = t.match(
    /^(?:meet(?:ing)?(?:\s+with)?|call(?:\s+with)?|coffee|lunch|dinner|drinks|hang(?:out)?)\s+(.+?)\s+at\s+(.+)$/i,
  )
  if (at) return { who: at[1]!.trim(), place: at[2]!.trim() }
  const withAt = t.match(/^(.+?)\s+at\s+(.+)$/i)
  if (withAt) {
    const who = withAt[1]!.replace(/^(?:meet(?:ing)?|call)\s+(?:with\s+)?/i, '').trim()
    return { who: who || withAt[1]!.trim(), place: withAt[2]!.trim() }
  }
  const who = t.replace(/^(?:meet(?:ing)?|call)\s+(?:with\s+)?/i, '').trim()
  return { who: who || t, place: '' }
}

type CalMeet = { time: string; title: string; who: string; place: string; day: 'today' | 'tomorrow' }

function parseCalendarMeets(
  calendarBlock: string | undefined,
  tz: string,
): CalMeet[] {
  const tomorrowYmd = startOfLocalDay(tz, 1).toLocaleDateString('en-CA', { timeZone: tz })
  const todayYmd = startOfLocalDay(tz).toLocaleDateString('en-CA', { timeZone: tz })
  const out: CalMeet[] = []
  for (const line of digestLines(calendarBlock)) {
    const parsed = parseFormattedEventLine(line)
    if (!parsed) continue
    const iso = parsed.iso
    const title = parsed.title
    const raw = iso.includes('T') ? iso : `${iso}T12:00:00`
    const d = new Date(raw)
    if (Number.isNaN(d.getTime())) continue
    const day = d.toLocaleDateString('en-CA', { timeZone: tz })
    const meet = parseCalMeet(title)
    out.push({
      time: parsed.clock || formatCalTime(iso, tz),
      title,
      who: meet.who,
      place: meet.place,
      day: day === tomorrowYmd ? 'tomorrow' : day === todayYmd ? 'today' : 'today',
    })
  }
  return out
}

type TodayMeet = { time: string; title: string; who: string; place: string; kind: string }
type TodayResult = { meets: TodayMeet[]; stay: { title: string; place: string } | null; calendarConnected: boolean }

async function todayCalendarMeets(
  sql: SQL,
  user: { id: string; timezone: string | null; name?: string | null },
  persona: Persona,
): Promise<TodayResult> {
  const tz = user.timezone || 'America/Los_Angeles'
  const connected = (await connectedForUser(sql, user.id)).filter((id) => !PERSONA_DENIED[persona].has(id))
  const myName = user.name || null

  function stayWhere(title: string, place: string) {
    const hotel = place || title.replace(/^(stay(?:ing)?(?:\s+at)?)\s+/i, '').trim()
    return { title: hotel || title, place: place || hotel }
  }

  function itemsToResult(items: CalItem[]): TodayResult {
    let stay: { title: string; place: string } | null = null
    const meets: TodayMeet[] = []
    for (const e of items) {
      const calParsed = parseCalMeet(e.title)
      const travel = e.allDay || isTravelOrStayTitle(e.title, calParsed.place) || isHotelStayEvent(e)
      if (travel) {
        if (!stay && (isHotelStayEvent(e) || isTravelOrStayTitle(e.title, calParsed.place))) {
          stay = stayWhere(e.title, calParsed.place)
        }
        continue
      }
      const who = extractOtherPerson(e.title, myName) || calParsed.who || e.title
      const row = {
        time: formatClock(e.start, tz),
        title: e.title,
        who,
        place: calParsed.place,
        kind: e.kind,
      }
      if (!isPersonMeetSuggestion(row)) continue
      meets.push(row)
    }
    return { meets, stay, calendarConnected: true }
  }

  const access = await googleAccessToken(sql, user.id, 'calendar')
  if (access) {
    const got = await fetchCalendarItems(access, {
      timeMin: startOfLocalDay(tz),
      timeMax: startOfLocalDay(tz, 1),
      maxResults: 16,
    })
    if (got.ok) return itemsToResult(got.items)
  }
  const cached = await googleEventsRaw(sql, user.id, {
    timeMin: startOfLocalDay(tz),
    timeMax: startOfLocalDay(tz, 1),
    maxResults: 16,
  }).catch(() => [])
  if (cached.length) {
    return itemsToResult(
      cached.map((e) => ({
        start: new Date(e.start),
        title: e.title,
        description: '',
        allDay: !!e.allDay,
        kind: 'Meeting',
        rawStart: e.start,
      })),
    )
  }
  if (!connected.includes('calendar')) return { meets: [], stay: null, calendarConnected: false }
  const results = await withTimeout(
    runToolsForMessage(sql, {
      userId: user.id,
      persona,
      message: 'calendar today',
      connected,
      timezone: tz,
    }),
    6000,
    [] as string[],
  )
  const calendarBlock = results.find((t) => isCalendarToolResult(t))
  const calMeets = parseCalendarMeets(calendarBlock, tz).filter((e) => e.day === 'today')
  let stay: { title: string; place: string } | null = null
  const meets: TodayMeet[] = []
  for (const e of calMeets) {
    const who = extractOtherPerson(e.title, myName) || e.who || e.title
    const row = { time: e.time, title: e.title, who, place: e.place, kind: 'Meeting' }
    if (isTravelOrStayTitle(e.title, e.place) || isTravelOrStayTitle(who, e.place) || /^all day$/i.test(e.time)) {
      if (!stay && isTravelOrStayTitle(e.title, e.place)) stay = stayWhere(e.title, e.place)
      continue
    }
    if (!isPersonMeetSuggestion(row)) continue
    meets.push(row)
  }
  return { meets, stay, calendarConnected: true }
}

/**
 * Morning/evening-brief payload: calendar (direct Google, no error strings),
 * important + medium mail, reminders. `brief` tells the frontend which variant.
 * Calendar uses fetchCalendarItems directly so "Calendar is not connected" error
 * strings never leak into the event list.
 */
async function gmiBriefChat(
  system: string,
  user: string,
  maxTokens = 180,
  timeoutMs = 5000,
  opts: { plainText?: boolean } = {},
): Promise<string | null> {
  const cfg = nutritionModelConfig()
  if (!cfg) return null
  try {
    const raw = await withTimeout(
      (async () => {
        const res = await fetch(`${cfg.baseUrl}/chat/completions`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${cfg.apiKey}`,
            'User-Agent': 'HireAlpha/0.1 (brief-mail)',
            Accept: 'application/json',
          },
          body: JSON.stringify({
            model: cfg.textModel,
            temperature: 0.1,
            max_tokens: maxTokens,
            messages: [
              { role: 'system', content: system },
              { role: 'user', content: user },
            ],
          }),
        })
        if (!res.ok) return ''
        const data = (await res.json()) as {
          choices?: Array<{ message?: { content?: string; reasoning_content?: string } }>
        }
        const msg = data.choices?.[0]?.message
        // A visible reply must be the model's content, never its scratchpad. The
        // reasoning fallback exists for JSON extraction (judge), where a reasoning
        // model can put the answer in reasoning_content; a rewrite body is not that.
        if (opts.plainText) return stripReasoning(String(msg?.content ?? ''))
        return modelReplyText(msg)
      })(),
      timeoutMs,
      '',
    )
    return raw || null
  } catch {
    return null
  }
}

/**
 * One model pass over an inbox batch, answering keep-or-drop and a pile name per
 * mail. Returns a verdict per item the model reached; callers decide what to do
 * with the rest. Empty map on failure, so every caller degrades on its own terms.
 *
 * Batch cap 20 with room for a line each — the old 180 tokens only had to carry
 * a list of numbers.
 */
async function judgeMailBatch(
  items: Array<{ id: string; from: string; subject: string; snippet?: string }>,
  vocab: string[] = [],
  opts: { limit?: number; maxTokens?: number; timeoutMs?: number } = {},
): Promise<Map<string, MailJudgeVerdict>> {
  if (!items.length) return new Map()
  const batch: MailJudgeItem[] = items.slice(0, opts.limit ?? 20).map((m) => ({
    id: m.id,
    from: m.from,
    subject: m.subject,
    snippet: m.snippet || '',
  }))
  const raw = await gmiBriefChat(
    MAIL_JUDGE_SYSTEM,
    mailJudgePrompt(batch, vocab),
    opts.maxTokens ?? 700,
    opts.timeoutMs ?? 8000,
  )
  if (!raw) return new Map()
  return new Map(parseMailJudgeVerdicts(raw, batch).map((v) => [v.id, v]))
}

/** Model judges a recent inbox batch. Empty on failure so we never dump promo. */
async function judgeBriefMail<T extends { id: string; from: string; subject: string; snippet?: string }>(
  items: T[],
  limit = 5,
  vocab: string[] = [],
): Promise<Array<T & { kind: string }>> {
  const verdicts = await judgeMailBatch(items, vocab)
  if (!verdicts.size) return []
  return items
    .filter((m) => verdicts.get(m.id)?.keep)
    .slice(0, limit)
    .map((m) => ({ ...m, kind: verdicts.get(m.id)?.kind || '' }))
}

/* ---- One model call, one cache row ----
 * The judgment layer used to be regexes layered on the judge's pile names.
 * Now the same single call that names the piles also decides needs-you, urgency
 * scores, and meeting prep, and the verdicts persist in hire_judge_cache for
 * fifteen minutes. An open of any brief inside that window is cache-only: zero
 * model calls, whatever the request path. */

type JudgeCachePayload = {
  mails: MailVerdict[]
  meets: MeetVerdict[]
  mailIds: string[]
}

/** One model pass over the whole batch. Empty maps on failure, so callers keep
 * their regex fallback. */
async function judgeAllBatch(
  mails: JudgeMailIn[],
  meets: JudgeMeetIn[],
  vocab: string[],
): Promise<JudgeAll> {
  if (!mails.length && !meets.length) return { mails: new Map(), meets: new Map() }
  const raw = await gmiBriefChat(JUDGE_ALL_SYSTEM, judgeAllPrompt(mails.slice(0, JUDGE_MAIL_CAP), meets.slice(0, JUDGE_MEET_CAP), vocab), 1500, 12000)
  if (!raw) return { mails: new Map(), meets: new Map() }
  return parseJudgeAll(raw, mails.slice(0, JUDGE_MAIL_CAP), meets.slice(0, JUDGE_MEET_CAP))
}

async function readJudgeRow(sql: SQL, userId: string): Promise<{ payload: JudgeCachePayload; builtAt: number; day: string } | null> {
  try {
    const rows = (await sql`
      SELECT payload, built_at AS "builtAt", day FROM hire_judge_cache WHERE user_id = ${userId} LIMIT 1
    `) as Array<{ payload: JudgeCachePayload; builtAt: Date; day: string }>
    const row = rows[0]
    if (!row) return null
    return { payload: row.payload, builtAt: new Date(row.builtAt).getTime(), day: row.day }
  } catch {
    return null
  }
}

async function writeJudgeRow(sql: SQL, userId: string, day: string, payload: JudgeCachePayload) {
  try {
    await sql`
      INSERT INTO hire_judge_cache (user_id, payload, day, built_at)
      VALUES (${userId}, ${JSON.stringify(payload)}, ${day}, now())
      ON CONFLICT (user_id) DO UPDATE SET payload = excluded.payload, day = excluded.day, built_at = excluded.built_at
    `
  } catch {
    /* A cache write must never take a read down with it. */
  }
}

/**
 * Verdicts for the caller's mail and meetings, from the cache when it is fresh
 * and still covers most of the batch, otherwise from exactly one model call
 * that lands back in the cache. Null means the model answered nothing — the
 * caller falls back to the regex layers rather than showing an unjudged brief.
 */
export async function loadJudgeVerdicts(
  sql: SQL,
  userId: string,
  mails: JudgeMailIn[],
  meets: JudgeMeetIn[],
  tz?: string | null,
  vocab?: string[],
): Promise<JudgeAll | null> {
  const today = localDateStrInTz(new Date(), tz)
  const row = await readJudgeRow(sql, userId)
  if (
    row &&
    judgeRowFresh(row.builtAt, Date.now(), row.day, today) &&
    judgeRowCovers(row.payload.mailIds, mails.map((m) => m.id))
  ) {
    return {
      mails: new Map(row.payload.mails.map((m) => [m.id, m])),
      meets: new Map(row.payload.meets.map((m) => [m.id, m])),
    }
  }
  const verdicts = await judgeAllBatch(mails, meets, vocab ?? (await loadMailKindVocab(sql, userId)))
  if (!verdicts.mails.size && !verdicts.meets.size) return null
  await writeJudgeRow(sql, userId, today, {
    mails: [...verdicts.mails.values()],
    meets: [...verdicts.meets.values()],
    mailIds: mails.slice(0, JUDGE_MAIL_CAP).map((m) => m.id),
  })
  return verdicts
}

/** The attention slot, now judged by the model: the highest-urgency needs-you
 * mail with its own reason line. Null hands the slot back to the regex pick. */
export function judgedAttentionPick(
  verdicts: JudgeAll,
  lines: Map<string, { label: string; snippet?: string }>,
): { id: string; label: string; snippet?: string; why: string } | null {
  const scored = [...verdicts.mails.values()]
    .filter((v) => (v.needsYou || v.score >= 70) && v.keep && lines.has(v.id))
    .sort((a, b) => b.score - a.score)
  const best = scored[0]
  if (!best) return null
  const line = lines.get(best.id)!
  return { id: best.id, label: line.label, snippet: line.snippet, why: best.why || 'needs you' }
}

/** Stable id for a today-meeting: clock time plus the displayed title, the two
 * fields both the judge input and the digest row carry. */
export function meetJudgeKey(m: { time: string; title: string; who?: string }): string {
  return `${m.time}|${m.who || m.title}`
}

/**
 * Refresh the judgment cache ahead of any request, on a 15-minute clock. Users
 * with a brief built in the last six hours get their mail and meetings re-judged
 * if the cached row is stale, so an open of any brief inside the window is a
 * cache hit with zero model calls. Errors are per-user and swallowed: a failed
 * prewarm costs nothing, the on-demand path judges on first open anyway.
 */
export async function prewarmJudgeCaches(sql: SQL) {
  try {
    const rows = (await sql`
      SELECT DISTINCT user_id AS "userId" FROM hire_brief_cache
      WHERE built_at > now() - interval '6 hours'
      LIMIT 50
    `) as Array<{ userId: string }>
    for (const { userId } of rows) {
      try {
        const urows = (await sql`
          SELECT timezone AS tz, name FROM hire_users WHERE id = ${userId} LIMIT 1
        `) as Array<{ tz: string | null; name: string | null }>
        const tz = urows[0]?.tz
        const today = localDateStrInTz(new Date(), tz)
        const row = await readJudgeRow(sql, userId)
        if (row && judgeRowFresh(row.builtAt, Date.now(), row.day, today)) continue
        const rich = await withTimeout(loadGmailRich(sql, userId, importantMailQuery('2d'), JUDGE_MAIL_CAP), 9000, [])
        const cal = await todayMeetsCache
          .read(
            `${userId}|friend`,
            () => todayCalendarMeets(sql, { id: userId, timezone: tz, name: urows[0]?.name ?? undefined }, 'friend'),
            8000,
          )
          .then((r) => r.value ?? EMPTY_TODAY_RESULT)
        const judgeMeets: JudgeMeetIn[] = cal.meets.map((m) => ({
          id: meetJudgeKey(m),
          time: m.time,
          title: m.who || m.title,
        }))
        await loadJudgeVerdicts(sql, userId, rich, judgeMeets, tz)
      } catch {
        // One user's prewarm must not stop the others.
      }
    }
  } catch (err) {
    console.warn('[judge] prewarm failed', err)
  }
}

/* ---- Home's slow half ----
 * Everything on home that leaves this process: the calendar, the inbox, and the
 * model pass that names the mail piles. It used to run inside the request, so
 * opening home cost a Google round trip plus an LLM call every time even though
 * none of it changes minute to minute. Now it loads through a stale-while-
 * revalidate cache and the request only waits when there is nothing at all to
 * show.
 */
type HomeWorld = {
  upcoming: Array<{ time: string; title: string }>
  mail: Array<{ from: string; subject: string }>
  mailGroups: Array<{
    kind: string
    label: string
    count: number
    items: Array<{ id: string; from: string; subject: string; snippet?: string }>
  }>
  meetings: DigestMeeting[]
  attention: AttentionPick | null
}

const EMPTY_HOME_WORLD: HomeWorld = { upcoming: [], mail: [], mailGroups: [], meetings: [], attention: null }
const EMPTY_TODAY_RESULT: TodayResult = { meets: [], stay: null, calendarConnected: false }

/* Today's meetings, read by home and by every screen that lists who you are
 * seeing. One calendar fetch per user per minute and a half is plenty — an event
 * booked elsewhere shows up on the next pull. */
const todayMeetsCache = createStaleCache<TodayResult>({
  ttlMs: 90_000,
  maxWaitMs: 2_500,
  failureCooldownMs: 15_000,
  maxEntries: 200,
  onError: (key, err) => console.warn('[calendar] today fetch failed', key, err),
})

/* 90s is short enough that a meeting booked from another device shows up on the
 * next pull, and long enough that opening home twice in a minute is free. The
 * 1.5s cold wait is the one case a user waits at all: it beats a blank Today
 * section, and the load keeps going into the cache either way. */
const homeWorldCache = createStaleCache<HomeWorld>({
  ttlMs: 90_000,
  maxWaitMs: 1_500,
  failureCooldownMs: 15_000,
  maxEntries: 200,
  onError: (key, err) => console.warn('[home] world slice failed', key, err),
})

/* The brief is home's problem at a heavier weight: two calendar reads, an inbox
 * pull, a model pass over the mail, and a dozen small queries, all inside one
 * request that used to run them serially. Four minutes stays honest about mail
 * that landed since the last look; past that the refresh runs behind whatever
 * is already on screen.
 *
 * maxWaitMs is a floor on how long a first open can feel slow, not a deadline on
 * the work — the load keeps running into the cache after the wait expires, so a
 * short wait plus a retry a few hundred ms later gets the brief on screen sooner
 * than one long stare at a spinner ever did. 900ms is the crossover: a load that
 * finishes under it is served on the spot, and anything slower is better handed
 * to the client's retry ladder than held open. */
const digestCache = createStaleCache<Awaited<ReturnType<typeof digestPayload>>>({
  ttlMs: 240_000,
  maxWaitMs: 900,
  failureCooldownMs: 20_000,
  maxEntries: 200,
  onError: (key, err) => console.warn('[digest] load failed', key, err),
})

/* The evening brief is the same weight as the morning one — a two-day calendar
 * range, an inbox pull, a model pass, and eleven log queries — and until now it
 * was the only brief with no cache at all, so every open paid the whole bill.
 *
 * Its own cache rather than a shared one: the two briefs have different payload
 * shapes, and keying them together would let a morning read serve an evening
 * open. Same 4-minute window, since both are answering "what has landed". */
const eveningCache = createStaleCache<Awaited<ReturnType<typeof miniPayload>>>({
  ttlMs: 240_000,
  maxWaitMs: 900,
  failureCooldownMs: 20_000,
  maxEntries: 200,
  onError: (key, err) => console.warn('[evening] load failed', key, err),
})

/* Long enough to mean "this caller actually needs the value, not a fast paint".
 * Used by the paths that build the brief *text* Alpha sends: they have to wait
 * for the real payload anyway, and going through the cache means the card link
 * they are about to text is already warm when it gets tapped. */
const BRIEF_WARM_WAIT_MS = 60_000

/* ---- Persisted brief cache ----
 * The in-memory stale caches above live and die with the container. A brief is
 * still useful the moment a tap lands after a deploy, so the last successful
 * build of the day is kept in Postgres as a one-minute stand-in — anything the
 * client holds is a paint that must not be *served* as if it were current. */
/* The whole point of the client keeping a 4-hour copy is a fast paint; the
 * server must never serve that copy as current. Mail only stays true for
 * minutes, so a persisted row is trusted for a single minute and every later
 * open rebuilds (calendar + Gmail + model) behind the client's already-painted
 * screen — the retry ladder swaps in the fresh mail a couple of seconds later
 * instead of showing you three-hour-old mail as today's. The in-memory cache
 * above already makes repeat opens within four minutes free. */
const BRIEF_STALE_MS = 60_000

/** A persisted row is still worth a fast serve when it was built today and recently. */
export function briefRowFresh(rowAgeMs: number | null, today: string, rowDay: string | null): boolean {
  if (!rowAgeMs || rowDay !== today) return false
  return rowAgeMs < BRIEF_STALE_MS
}

async function readBriefDb(
  sql: SQL,
  userId: string,
  persona: string,
  kind: string,
): Promise<{ payload: unknown; day: string; builtAt: Date } | null> {
  try {
    const rows = (await sql`
      SELECT day, payload, built_at AS "builtAt" FROM hire_brief_cache
      WHERE user_id = ${userId} AND persona = ${persona} AND kind = ${kind}
      LIMIT 1
    `) as Array<{ day: string; payload: string; builtAt: Date }>
    const row = rows[0]
    if (!row) return null
    return { payload: JSON.parse(row.payload), day: row.day, builtAt: row.builtAt }
  } catch {
    return null
  }
}

async function writeBriefDb(sql: SQL, userId: string, persona: string, kind: string, day: string, payload: unknown) {
  try {
    await sql`
      INSERT INTO hire_brief_cache (user_id, persona, kind, day, payload, built_at)
      VALUES (${userId}, ${persona}, ${kind}, ${day}, ${JSON.stringify(payload)}, now())
      ON CONFLICT (user_id, persona, kind)
      DO UPDATE SET day = excluded.day, payload = excluded.payload, built_at = excluded.built_at
    `
  } catch {
    /* A cache row must never take a read down with it. */
  }
}

/**
 * Free tier rationing. With FREE_TIER_LIMIT unset the brief builds free, exactly
 * as before. When set, a user with no active subscription gets that many brief
 * kinds refreshed per rolling week: each build stamps built_at on its
 * (persona, kind) row in hire_brief_cache, so counting rows touched this week
 * counts builds. Past the cap the last cached build is served stale; a kind
 * with no cache row still builds once, because there is nothing to serve.
 */
async function briefBuildAllowed(sql: SQL, userId: string): Promise<boolean> {
  const limit = Number(process.env.FREE_TIER_LIMIT || '')
  if (!Number.isFinite(limit) || limit <= 0) return true
  try {
    const subs = (await sql`
      SELECT 1 FROM hire_subscriptions
      WHERE user_id = ${userId} AND status IN ('active', 'trialing')
      LIMIT 1
    `) as unknown[]
    if (subs.length) return true
    const counts = (await sql`
      SELECT count(*) AS n FROM hire_brief_cache
      WHERE user_id = ${userId} AND built_at > now() - interval '7 days'
    `) as Array<{ n: string | number }>
    return Number(counts[0]?.n ?? 0) < limit
  } catch {
    // Rationing must never take the brief down.
    return true
  }
}

/** Serve today's persisted brief when it is still fresh-ish; otherwise build and persist. */
async function briefLoader<T>(
  sql: SQL,
  userId: string,
  persona: string,
  kind: string,
  build: () => Promise<T>,
  day: string,
): Promise<T> {
  const row = await readBriefDb(sql, userId, persona, kind)
  if (row && briefRowFresh(Date.now() - new Date(row.builtAt).getTime(), day, row.day)) {
    return row.payload as T
  }
  if (row && !(await briefBuildAllowed(sql, userId))) return row.payload as T
  const payload = await build()
  await writeBriefDb(sql, userId, persona, kind, day, payload)
  return payload
}

async function loadHomeWorld(sql: SQL, user: AuthedUser, tzLocal: string): Promise<HomeWorld> {
  const world: HomeWorld = { upcoming: [], mail: [], mailGroups: [], meetings: [], attention: null }
  const jobs: Array<Promise<void>> = []
  jobs.push(
    (async () => {
      // Shared with /api/network, so opening home and the People list is one
      // calendar fetch between them rather than two.
      const cal = await withTimeout(
        todayMeetsCache
          .read(`${user.id}|friend`, () => todayCalendarMeets(sql, user, 'friend'))
          .then((r) => r.value ?? EMPTY_TODAY_RESULT),
        8000,
        EMPTY_TODAY_RESULT,
      )
      world.upcoming = cal.meets
        .filter((m) => isPersonMeetSuggestion(m))
        .map((m) => ({ time: m.time, title: m.who || m.title }))
      world.meetings = remainingTodayMeets(cal.meets, tzLocal)
      if (world.upcoming.length) return
      const rows = await withTimeout(loadWorldCalendar(sql, user, tzLocal), 8000, [] as string[])
      world.upcoming = rows
        .slice(0, 8)
        .map((line) => {
          const parts = line.split(' · ')
          return { time: parts[0] || '', title: parts.slice(1).join(' · ') || line }
        })
        .filter((e) => isPersonMeetSuggestion({ time: e.time, title: e.title, who: e.title }))
      world.meetings = remainingTodayMeets(
        world.upcoming.map((e) => ({ time: e.time, title: e.title, who: e.title })),
        tzLocal,
      )
    })(),
  )
  jobs.push(
    withTimeout(
      (async () => {
        const rich = await loadGmailRich(sql, user.id, importantMailQuery('2d'), 12)
        if (!rich.length) return []
        // One model call judged everything, from cache when fresh. The regex
        // pick stays only for the run where the model answers nothing.
        const [vocab, verdicts] = await Promise.all([
          loadMailKindVocab(sql, user.id),
          loadJudgeVerdicts(sql, user.id, rich, [], user.timezone),
        ])
        const labelled: MailKindItem[] = rich.map((m) => ({ ...m, kind: verdicts?.mails.get(m.id)?.kind }))
        // One email above the pile counts: the model's highest-urgency needs-you
        // mail, with its reason line. Regex pick is the model-down fallback.
        const attentionLines = new Map(
          rich.map((m) => [
            m.id,
            { label: formatMailLineFromParts(m.from, m.subject), snippet: cleanMailSnippet(m.snippet || '') },
          ]),
        )
        // When the model answered, its pick rules — even when it names nothing,
        // the slot drops quietly instead of regexes resurfacing a promo. Regex
        // pick only for the model-down run.
        world.attention = verdicts
          ? judgedAttentionPick(verdicts, attentionLines)
          : pickAttentionEmail(
            labelled.map((m) => ({
              id: m.id,
              label: formatMailLineFromParts(m.from, m.subject),
              snippet: cleanMailSnippet(m.snippet || ''),
              kind: m.kind,
              sender: m.from,
            })),
          )
        // Home shows the whole batch grouped rather than a judged top three:
        // the pile counts are what the section is for. Unjudged items still
        // land somewhere via the regex fallback inside groupMailByKind.
        const groups = groupMailByKind(labelled, { vocab, maxGroups: 4 })
        // Not awaited: the vocabulary is an optimisation for tomorrow's run,
        // and it must not spend this request's mail budget. It swallows its
        // own errors, so there is nothing here to reject.
        void saveMailKindVocab(sql, user.id, groups)
        return groups
      })(),
      8000,
      [] as ReturnType<typeof groupMailByKind>,
    ).then((groups) => {
      world.mailGroups = groups.map((g) => ({
        kind: g.kind,
        label: g.label,
        count: g.count,
        items: g.items.slice(0, 4).map((m) => ({
          id: m.id,
          from: m.from,
          subject: m.subject,
          snippet: cleanMailSnippet(m.snippet || ''),
        })),
      }))
      // The flat list stays alongside the groups so a client built before this
      // change still shows mail instead of an empty section.
      world.mail = groups
        .flatMap((g) => g.items)
        .slice(0, 3)
        .map((m) => ({ from: m.from, subject: m.subject }))
    }),
  )
  // One failing half must not throw away the other half, and a wholly failed
  // load must reject so the cache keeps the last good answer instead of caching
  // emptiness for ninety seconds.
  const settled = await Promise.allSettled(jobs)
  const failures = settled.filter((s) => s.status === 'rejected')
  if (failures.length === settled.length) throw (failures[0] as PromiseRejectedResult).reason
  for (const failure of failures) console.warn('[home] world job failed', (failure as PromiseRejectedResult).reason)
  return world
}

/** The work personas' morning pull: one boxed section set per hire, appended to
 * the digest text so the thread itself replaces opening Slack/Linear/Notion. */
export function workPullSections(input: {
  persona: 'coworker' | 'cofounder'
  linear?: Array<{ identifier: string; title: string; state?: string }>
  prs?: string[]
  draftsCount?: number
  pipeline?: Array<{ stage: string; value: number }>
  decisionsOpen?: number
  oldestDecisionDays?: number
  runway?: { cash: number; burn: number; months: number } | null
}): Array<{ title: string; lines: string[] }> {
  const sections: Array<{ title: string; lines: string[] }> = []
  if (input.persona === 'coworker') {
    const needsYou = (input.linear || []).filter((i) => !/done|canceled|closed/i.test(i.state || ''))
    if (needsYou.length) {
      sections.push({
        title: 'Linear',
        lines: needsYou.slice(0, 4).map((i) => `${i.identifier} ${i.title}`),
      })
    }
    if (input.prs?.length) {
      sections.push({ title: 'PRs needing your pass', lines: input.prs.slice(0, 4) })
    }
    if (input.draftsCount) {
      sections.push({ title: 'Drafts ready to send', lines: [`${input.draftsCount} waiting`] })
    }
  } else if (input.persona === 'cofounder') {
    const live = input.pipeline || []
    const total = live.reduce((s, p) => s + (p.value > 0 ? p.value : 0), 0)
    const offers = live.filter((p) => p.stage === 'offer').length
    if (live.length) {
      sections.push({
        title: 'Pipeline',
        lines: [
          `${live.length} live${total > 0 ? ` · $${Math.round(total / 1000)}k` : ''}${offers ? ` · ${offers} offers out` : ''}`,
        ],
      })
    }
    if (input.decisionsOpen) {
      sections.push({
        title: 'Decisions',
        lines: [`${input.decisionsOpen} open${input.oldestDecisionDays ? ` · oldest ${input.oldestDecisionDays}d` : ''}`],
      })
    }
    if (input.runway && input.runway.months > 0) {
      sections.push({
        title: 'Runway',
        lines: [
          `${Math.round(input.runway.months)} months ($${Math.round(input.runway.cash)} cash @ $${Math.round(input.runway.burn)}/mo)`,
        ],
      })
    }
  }
  return sections
}

/* ---- What is left of today, and the one email to look at ----
 * Both briefs and home already load the calendar and the inbox; these two pure
 * helpers package what those loads returned for the screens that show it. */

export type DigestMeeting = { time: string; title: string; startsInMin?: number; prep?: boolean; prepWhy?: string }

/** Minutes after midnight for "2:30 PM", "10am" or "14:05". NaN for anything else. */
function parseClockMinutes(value: string): number {
  const m = String(value || '')
    .trim()
    .match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/i)
  if (!m) return NaN
  let h = Number(m[1])
  const min = Number(m[2] || 0)
  const ap = m[3]?.toLowerCase()
  if (ap === 'pm' && h < 12) h += 12
  if (ap === 'am' && h === 12) h = 0
  if (h > 23 || min > 59) return NaN
  return h * 60 + min
}

function nowMinutesInTz(tz: string, now = new Date()): number {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hour: 'numeric',
      minute: '2-digit',
      hour12: false,
    }).formatToParts(now)
    const h = Number(parts.find((p) => p.type === 'hour')?.value) % 24
    const min = Number(parts.find((p) => p.type === 'minute')?.value)
    if (!Number.isFinite(h) || !Number.isFinite(min)) return NaN
    return h * 60 + min
  } catch {
    return NaN
  }
}

/**
 * Today's meetings still ahead of the user, soonest first, eight max. End times
 * are not carried on the meet rows, so a meeting that already started counts as
 * in progress for an hour and then leaves the list. Eight because the promise
 * this screen makes is that nothing on today's calendar goes unseen; a busy day
 * used to silently lose its tail past five.
 */
export function remainingTodayMeets(
  meets: Array<{ time: string; title: string; who?: string }>,
  tz: string,
  now = new Date(),
): DigestMeeting[] {
  const nowMin = nowMinutesInTz(tz, now)
  if (Number.isNaN(nowMin)) return []
  const out: DigestMeeting[] = []
  for (const m of meets) {
    if (/^all day$/i.test(String(m.time || '').trim())) continue
    const startMin = parseClockMinutes(m.time)
    if (Number.isNaN(startMin)) continue
    if (startMin < nowMin && nowMin - startMin > 60) continue
    out.push({ time: m.time, title: m.who || m.title, startsInMin: Math.max(0, startMin - nowMin) })
  }
  out.sort((a, b) => (a.startsInMin ?? 0) - (b.startsInMin ?? 0))
  return out.slice(0, 8)
}

export type AttentionCandidate = {
  id: string
  label: string
  snippet?: string
  kind?: string
  sender?: string
}
export type AttentionPick = { id: string; label: string; snippet?: string; why: string }

/* One pile name or sender is enough to call a mail money, but a bare receipt is
 * not — receipts only count when the text still owes something. */
const MONEY_KIND_RE = /money|bill|invoice|payment|due|expense|finance|statement|banking/i
const MONEY_SENDER_RE = /billing|invoic|payment|statement|utility|\bbank|accounts? receivable/i
const RECEIPT_RE = /receipt|order|confirmation/i
const OWED_RE = /amount due|balance|owed|past due|payment due|due by|\$\s?\d/i
const NEWSLETTER_RE = /newsletter|promo|deals?|digest|unsubscribe|no[- ]?reply|daily brief|notification/i
const URGENT_RE = /\b(today|tonight|eod|deadline|overdue|rsvp|expires?|final notice)\b/i

function attentionIsNewsletter(item: AttentionCandidate): boolean {
  return NEWSLETTER_RE.test(`${item.kind || ''} ${item.label} ${item.snippet || ''}`)
}

function attentionName(item: AttentionCandidate): string {
  const fromLabel = String(item.label || '').split(' · ').pop() || ''
  const raw = String(item.sender || fromLabel).replace(/<[^>]+>/g, '').trim()
  const name = raw.split('@')[0]!.replace(/[^\w '.-]/g, '').trim()
  return name.slice(0, 24)
}

/* Money: a pile or sender that bills, but a bare receipt only counts when the
 * text still owes something. Newsletters never count as money. */
function attentionMoneyWhy(item: AttentionCandidate): string | null {
  const kindSender = `${item.kind || ''} ${item.sender || ''}`
  if (attentionIsNewsletter(item)) return null
  const text = `${item.label} ${item.snippet || ''}`
  if (MONEY_KIND_RE.test(kindSender) && !RECEIPT_RE.test(kindSender)) {
    return /invoice/i.test(kindSender) ? 'invoice due' : 'bill due'
  }
  if (MONEY_SENDER_RE.test(item.sender || '') || (RECEIPT_RE.test(kindSender) && OWED_RE.test(text))) {
    return 'payment due'
  }
  return null
}

function attentionUrgentWhy(item: AttentionCandidate): string | null {
  const urgent = `${item.label} ${item.snippet || ''}`.match(URGENT_RE)
  if (!urgent) return null
  const w = urgent[1]!.toLowerCase()
  if (w === 'rsvp') return 'RSVP needed'
  if (w === 'overdue' || w === 'final notice') return 'past due'
  if (/expire/.test(w)) return 'expires soon'
  return 'deadline today'
}

function attentionPersonalWhy(item: AttentionCandidate): string | null {
  if (attentionIsNewsletter(item)) return null
  if (!item.snippet || !item.snippet.trim()) return null
  const name = attentionName(item)
  return name ? `from ${name}` : 'needs a reply'
}

/**
 * The one email worth putting above the pile counts. Priority over the whole
 * list: money that needs action, then deadline language, then the first mail
 * that reads like a person wrote it. Null when nothing qualifies, so screens
 * can drop the slot quietly.
 */
export function pickAttentionEmail(
  items: AttentionCandidate[],
  _now: Date = new Date(),
): AttentionPick | null {
  const tiers = [attentionMoneyWhy, attentionUrgentWhy, attentionPersonalWhy]
  for (const tier of tiers) {
    for (const item of items) {
      if (!item?.id) continue
      const why = tier(item)
      if (why) return { id: item.id, label: item.label, snippet: item.snippet, why }
    }
  }
  return null
}

/**
 * Promises found in judged mail become open loops: an email that carries a
 * commitment ("I'll send the deck Thursday") lands on the Promises card with
 * the mail it came from as context, instead of dying in the inbox. Deduped on
 * the loop title so the same email does not spawn a loop on every brief, and
 * capped at three per run so one noisy inbox cannot flood the card.
 */
async function saveMailPromiseLoops(
  sql: SQL,
  userId: string,
  persona: Persona,
  promises: Array<{ title: string; context: string }>,
) {
  for (const p of promises.slice(0, 3)) {
    const title = p.title.trim().slice(0, 200)
    if (!title) continue
    const existing = await sql`
      SELECT id FROM hire_loops
      WHERE user_id = ${userId} AND status = 'open' AND lower(title) = lower(${title})
      LIMIT 1
    `
    if (existing.length) continue
    await sql`
      INSERT INTO hire_loops (id, user_id, persona, title, context)
      VALUES (${crypto.randomUUID()}, ${userId}, ${persona}, ${title}, ${p.context.slice(0, 500)})
    `
  }
}

async function digestPayload(
  sql: SQL,
  user: { id: string; timezone: string | null; name?: string | null },
  persona: Persona,
) {
  const travelContext = await loadContext(sql, user.id, persona)
  const tz = effectiveTz(user.timezone, travelContext)

  const tomorrowStart = startOfLocalDay(tz, 1)
  const dayAfterStart = startOfLocalDay(tz, 2)
  const tomorrowYmd = tomorrowStart.toLocaleDateString('en-CA', { timeZone: tz })

  // Calendar and mail used to load one after another; both are slow and neither
  // needs the other. They race now, and inside the mail track the small reads
  // (vocab, triaged ids, sender signals) go out alongside the inbox pull rather
  // than queueing behind it.
  const [calToday, tomorrowCalItems, mail] = await Promise.all([
    /* Shared with home and the People list. The brief is reached from home's
     * dock, so by the time it is opened this is usually a warm hit and today's
     * calendar costs nothing instead of another second on Google. The long wait
     * is for the cold case: unlike home, the brief cannot paint around a missing
     * calendar, and a 2.5s timeout here would cache an empty day for a TTL. */
    todayMeetsCache
      .read(`${user.id}|${persona}`, () => todayCalendarMeets(sql, user, persona), 8000)
      .then((r) => r.value ?? EMPTY_TODAY_RESULT),
    (async () => {
      const items: CalItem[] = []
      try {
        const access = await googleAccessToken(sql, user.id, 'calendar')
        if (!access) return items
        const got = await withTimeout(
          fetchCalendarItems(access, {
            timeMin: tomorrowStart,
            timeMax: dayAfterStart,
            maxResults: 12,
          }),
          8000,
          { ok: false as const, status: 0 },
        )
        if (got.ok) {
          for (const e of got.items) {
            const ymd = e.start.toLocaleDateString('en-CA', { timeZone: tz })
            if (ymd === tomorrowYmd && !isHotelStayEvent(e)) items.push(e)
          }
        }
      } catch {
        // Tomorrow is decoration; never let it hold the brief.
      }
      return items
    })(),
    (async () => {
      type NeedsYouRowT = { id: string; label: string; snippet?: string; score: number; reasons: string[] }
      type GroupT = { kind: string; label: string; count: number; items: Array<{ id: string; label: string; snippet?: string }> }
      let ny: NeedsYouRowT[] = []
      let groups: GroupT[] = []
      let tallyLine = ''
      let judgeOut: JudgeAll | null = null
      try {
        // The judge decides keep-or-drop, the pile, needs-you, urgency, and
        // promises in one pass — from cache when it is fresh. A run where the
        // model is unavailable falls back to the regex kinds inside
        // groupMailByKind. The full batch is still shown either way.
        const [vocab, doneIds, signals, richItems] = await Promise.all([
          loadMailKindVocab(sql, user.id),
          triagedMailIds(sql, user.id),
          loadMailSenderSignals(sql, user.id),
          withTimeout(
            loadGmailRich(sql, user.id, importantMailQuery('3d'), 30),
            9000,
            [] as Array<{ id: string; from: string; date: string; subject: string; snippet: string }>,
          ),
        ])
        // Today's meetings ride in the same single model call. The extra
        // todayMeetsCache read is deduped with the calendar job racing in
        // parallel above, so this costs a fetch only in the cold case.
        const calForJudge = await todayMeetsCache
          .read(`${user.id}|${persona}`, () => todayCalendarMeets(sql, user, persona), 8000)
          .then((r) => r.value ?? EMPTY_TODAY_RESULT)
        const judgeMeets: JudgeMeetIn[] = calForJudge.meets.map((m) => ({
          id: meetJudgeKey(m),
          time: m.time,
          title: m.who || m.title,
        }))
        const allVerdicts = await loadJudgeVerdicts(sql, user.id, richItems, judgeMeets, tz, vocab)
        judgeOut = allVerdicts
        const verdicts = allVerdicts?.mails ?? new Map<string, MailVerdict>()
        const labelled: MailKindItem[] = richItems.map((m) => ({ ...m, kind: verdicts.get(m.id)?.kind }))
        // Promises: judged mail that carries a commitment becomes an open loop
        // on the Promises card. Best effort and fire and forget, so it never
        // holds or breaks the brief.
        const mailPromises = richItems
          .map((m) => ({ promise: verdicts.get(m.id)?.promise?.trim(), m }))
          .filter((r): r is { promise: string; m: (typeof richItems)[number] } => !!r.promise)
          .map(({ promise, m }) => ({
            title: promise,
            context: `From mail: ${formatMailLineFromParts(m.from, m.subject)}`,
          }))
        if (mailPromises.length) {
          void saveMailPromiseLoops(sql, user.id, persona, mailPromises).catch(() => {})
        }
        // Mail the user already handled leaves both Needs You and the piles. This
        // is what makes Done and Skip stick instead of popping back on reload.
        const visible: MailKindItem[] = labelled.filter((m) => !doneIds.has(m.id))
        // Needs You: the model's judgment now — the three needs-you mails with
        // the highest urgency, each with its own reason line. The regex scorer
        // runs only when the model answered nothing at all.
        type LeadT = { id: string; from: string; subject: string; snippet?: string; score: number; reasons: string[] }
        let leads: LeadT[] = allVerdicts
          ? visible
              .filter((m) => m.id && !m.id.startsWith('text-'))
              .map((m) => ({ m, v: verdicts.get(m.id) }))
              .filter((r): r is { m: (typeof visible)[number]; v: MailVerdict } => !!r.v && r.v.needsYou && r.v.keep)
              .sort((a, b) => b.v.score - a.v.score)
              .slice(0, 3)
              .map(({ m, v }) => ({
                id: m.id,
                from: m.from,
                subject: m.subject,
                snippet: m.snippet,
                score: v.score,
                reasons: [v.why].filter(Boolean),
              }))
          : []
        if (!leads.length) {
          leads = topNeedsYou(
            visible.filter((m) => m.id && !m.id.startsWith('text-')),
            (key) => signals.get(key),
            3,
          )
            .filter((m) => m.score >= 55)
            .map((m) => ({ ...m, reasons: m.reasons }))
        }
        const leadIds = new Set(leads.map((m) => m.id))
        ny = leads.map((m) => ({
          id: m.id,
          label: formatMailLineFromParts(m.from, m.subject),
          snippet: cleanMailSnippet(m.snippet || ''),
          score: Math.round(m.score),
          reasons: m.reasons,
        }))
        const grouped = groupMailByKind(
          visible.filter((m) => !leadIds.has(m.id)),
          { vocab },
        )
        groups = grouped.map((g) => ({
          kind: g.kind,
          label: g.label,
          count: g.count,
          items: g.items.map((m) => ({
            id: m.id,
            label: formatMailLineFromParts(m.from, m.subject),
            snippet: cleanMailSnippet(m.snippet || ''),
          })),
        }))
        tallyLine = mailTally(grouped)
        void saveMailKindVocab(sql, user.id, grouped).catch(() => {})
      } catch {
        // best-effort
      }
      return {
        needsYou: ny,
        groups,
        tally: tallyLine,
        verdicts: judgeOut
          ? { mails: [...judgeOut.mails.values()], meets: [...judgeOut.meets.values()] }
          : null,
      }
    })(),
  ])

  const beats = calToday.meets
    .filter((m) => isPersonMeetSuggestion(m))
    .map((m) => ({ time: m.time, name: m.who || m.title, kind: m.kind }))
  const todayCal = beats.map((b) =>
    b.kind && b.kind !== 'Meeting' ? `${b.time} · ${b.name} · ${b.kind}` : `${b.time} · ${b.name}`,
  )

  const myName = user.name || null
  const tomorrowCal = tomorrowCalItems.map((e) => formatDigestEventLabel(e, tz, myName))

  // Pass empty events[] so the frontend never shows Yes/No RSVP buttons.
  // The brief is a read-only view; calendar is already in todayCal.
  const events: Array<{ id: string; label: string }> = []

  let finalEmailItems: Array<{ id: string; label: string; snippet?: string }> = []
  let finalEmails: string[] = []
  let mailGroups: Array<{ kind: string; label: string; count: number; items: Array<{ id: string; label: string; snippet?: string }> }> = []
  let mailTallyLine = ''
  let needsYou: Array<{ id: string; label: string; snippet?: string; score: number; reasons: string[] }> = []
  needsYou = mail.needsYou
  mailGroups = mail.groups
  mailTallyLine = mail.tally
  const judgeVerdicts = mail.verdicts
  finalEmailItems = mailGroups.flatMap((g) => g.items)
  finalEmails = finalEmailItems.map((e) => e.label)

  if (!finalEmails.length) {
    try {
      const mailBlock = await withTimeout(
        loadGmail(sql, user.id, importantMailQuery('3d'), 20),
        8000,
        '',
      )
      const rows = digestLines(mailBlock)
        .map((line, i) => {
          const [from, , subject] = line.replace(/^-\s*/, '').split(' | ')
          return {
            id: `text-${i}`,
            from: from || '',
            subject: subject || formatMailLine(line),
            snippet: '',
          }
        })
        .filter((m) => m.from || m.subject)
      const grouped = groupBriefMail(rows)
      mailGroups = grouped.map((g) => ({
        kind: g.kind,
        label: g.label,
        count: g.count,
        items: g.items.map((m) => ({
          id: m.id,
          label: formatMailLineFromParts(m.from, m.subject),
          snippet: '',
        })),
      }))
      mailTallyLine = mailTally(grouped)
      finalEmailItems = mailGroups.flatMap((g) => g.items)
      finalEmails = finalEmailItems.map((e) => e.label)
    } catch {
      // best-effort
    }
  }

  const dateLabel = new Date().toLocaleDateString('en-US', {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    timeZone: tz,
  })

  const hour = Number(
    new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hour: 'numeric',
      hour12: false,
    }).format(new Date()),
  )
  const brief = hour >= 16 ? 'evening' : 'morning'
  const wrapTitle = brief === 'evening' ? 'Evening brief' : 'Morning brief'

  const todayLocal = localDateStrInTz(new Date(), tz)
  const weekStartLocal = mondayOfDateStr(todayLocal)
  const lastNightKey = shiftDateStr(todayLocal, -1)

  // The screens want two things the raw piles do not surface: what is left of
  // the day on the calendar, and the single mail to see before the counts.
  // Both come from the model's verdicts when it answered; the regex layers are
  // the model-down fallback. A meeting the model flagged prep:true carries its
  // reason onto the digest row.
  const meetsWithPrep = remainingTodayMeets(calToday.meets, tz).map((m) => {
    const v = judgeVerdicts?.meets.find((j) => j.id === meetJudgeKey(m))
    return v && v.prep ? { ...m, prep: true, prepWhy: v.why } : m
  })
  const meetings: DigestMeeting[] = meetsWithPrep
  const attentionLines = new Map(
    [
      ...needsYou.map((n) => ({ id: n.id, label: n.label, snippet: n.snippet })),
      ...mailGroups.flatMap((g) =>
        g.items.map((it) => ({ id: it.id, label: it.label, snippet: it.snippet })),
      ),
    ].map((l) => [l.id, { label: l.label, snippet: l.snippet }]),
  )
  const attention =
    (judgeVerdicts &&
      judgedAttentionPick({ mails: new Map(judgeVerdicts.mails.map((m) => [m.id, m])), meets: new Map() }, attentionLines)) ||
    pickAttentionEmail([
      ...needsYou.map((n) => ({ id: n.id, label: n.label, snippet: n.snippet })),
      ...mailGroups.flatMap((g) =>
        g.items.map((it) => ({ id: it.id, label: it.label, snippet: it.snippet, kind: g.kind })),
      ),
    ])

  // The half-dozen small reads used to run one after another; none depends on
  // the next, so they all leave together.
  const [reminderRows, loopRows, lastNightRow, duePeopleRows, factExtras] = await Promise.all([
    sql`
      SELECT id, text, scheduled_at AS "scheduledAt" FROM hire_reminders
      WHERE user_id = ${user.id} AND persona = ${persona} AND status = 'pending'
      ORDER BY scheduled_at ASC LIMIT 8
    `,
    sql`
      SELECT title, due_at AS "dueAt" FROM hire_loops
      WHERE user_id = ${user.id} AND status = 'open'
      ORDER BY created_at DESC LIMIT 8
    `,
    sql`
      SELECT sleep_date AS "sleepDate", bedtime, wake, quality FROM hire_sleep
      WHERE user_id = ${user.id} AND (sleep_date = ${lastNightKey} OR sleep_date = ${todayLocal})
      ORDER BY sleep_date DESC LIMIT 1
    `,
    sql`
      SELECT name, phone, last_touch AS "lastTouch", cadence_days AS "cadenceDays"
      FROM hire_network WHERE user_id = ${user.id}
      ORDER BY coalesce(last_touch, '1970-01-01'::timestamptz) ASC LIMIT 8
    `,
    (async () => {
      try {
        const [liftRows, spendRows, budgetRow, habitRows] = await Promise.all([
          sql`SELECT count(*)::int AS n FROM hire_workouts
            WHERE user_id = ${user.id} AND (logged_at AT TIME ZONE ${tz})::date >= ${weekStartLocal}`,
          sql`SELECT coalesce(sum(amount), 0)::float AS total FROM hire_spending
            WHERE user_id = ${user.id} AND (spent_at AT TIME ZONE ${tz})::date >= ${weekStartLocal}`,
          sql`SELECT weekly_budget AS "weeklyBudget" FROM hire_spending_budget WHERE user_id = ${user.id}`,
          sql`SELECT id FROM hire_habits WHERE user_id = ${user.id}`,
        ])
        const liftsThisWeek = Number((liftRows[0] as { n?: number })?.n) || 0
        const spendWeek = Number((spendRows[0] as { total?: number })?.total) || 0
        const budget = Math.round((budgetRow as { weeklyBudget?: number }[])[0]?.weeklyBudget || 0)
        let bestStreak = 0
        if ((habitRows as unknown[]).length) {
          const logRows = await sql`
            SELECT habit_id AS "habitId", date FROM hire_habit_logs
            WHERE user_id = ${user.id} AND date >= ${shiftDateStr(todayLocal, -180)}
          `
          const byHabit = new Map<string, Set<string>>()
          for (const lr of logRows as Array<{ habitId: string; date: string }>) {
            if (!byHabit.has(lr.habitId)) byHabit.set(lr.habitId, new Set())
            byHabit.get(lr.habitId)!.add(String(lr.date).slice(0, 10))
          }
          for (const dates of byHabit.values()) {
            let cursor = dates.has(todayLocal) ? todayLocal : shiftDateStr(todayLocal, -1)
            let streak = 0
            while (dates.has(cursor)) {
              streak++
              cursor = shiftDateStr(cursor, -1)
            }
            bestStreak = Math.max(bestStreak, streak)
          }
        }
        return { liftsThisWeek, spendWeek, budget, bestStreak }
      } catch {
        return null
      }
    })(),
  ])

  const reminders = (reminderRows as { id: string; text: string; scheduledAt: Date }[])
    .filter((r) => !/^\[(judge|poke)\]/i.test(r.text) && !/daily brief|morning brief|evening brief/i.test(r.text))
    .map((r) => ({
      id: r.id,
      time: formatCalTime(new Date(r.scheduledAt).toISOString(), tz),
      text: r.text.replace(/^\[digest\]/i, '').trim() || r.text,
    }))

  const loops = (loopRows as { title: string; dueAt: Date | null }[]).map((r) => {
    const due = r.dueAt ? formatCalTime(new Date(r.dueAt).toISOString(), tz) : ''
    return due ? `${r.title} · ${due}` : r.title
  })

  const lastNight = (lastNightRow as { bedtime?: string; wake?: string; quality?: number }[])[0]
  const lastNightLogged = !!(lastNight?.bedtime && lastNight?.wake)
  const lastNightHours = lastNightLogged
    ? sleepHoursBetween(lastNight!.bedtime!, lastNight!.wake!)
    : 0

  const peopleDue = (duePeopleRows as Array<{
    name: string; phone: string; lastTouch: Date | null; cadenceDays: number
  }>)
    .map((p) => {
      const days = p.lastTouch ? Math.floor((Date.now() - new Date(p.lastTouch).getTime()) / 86400000) : 999
      return { name: p.name, days, phone: p.phone || undefined, due: days >= (p.cadenceDays || 14) }
    })
    .filter((p) => p.due)
    .slice(0, 3)
    .map(({ name, days, phone }) => ({ name, days, phone }))

  // Fact strip: closed facts from the user's own logs, one source of truth per
  // fact. A gap never appears here and in the DO card at the same time.
  const factLine: Array<{ key: string; text: string; state: 'ok' | 'gap'; openKind?: string }> = []
  if (lastNightLogged) {
    const h = Math.floor(lastNightHours)
    const m = Math.round((lastNightHours - h) * 60)
    const q = lastNight!.quality && lastNight!.quality !== 3 ? `, quality ${lastNight!.quality}` : ''
    factLine.push({
      key: 'sleep',
      state: 'ok',
      text: `You slept ${h}${m ? `h ${m}m${q}` : 'h'}${m ? '' : q}`,
      openKind: 'sleep_tracker',
    })
  }
  if (factExtras) {
    if (factExtras.liftsThisWeek > 0) {
      factLine.push({ key: 'lifts', state: 'ok', text: `${factExtras.liftsThisWeek} lift${factExtras.liftsThisWeek === 1 ? '' : 's'} this week`, openKind: 'workout_log' })
    }
    if (factExtras.spendWeek > 0) {
      factLine.push(
        factExtras.budget > 0
          ? { key: 'spend', state: factExtras.spendWeek > factExtras.budget ? 'gap' : 'ok', text: `$${Math.round(factExtras.spendWeek)} of $${factExtras.budget} spent`, openKind: 'spending_snapshot' }
          : { key: 'spend', state: 'ok', text: `$${Math.round(factExtras.spendWeek)} spent this week`, openKind: 'spending_snapshot' },
      )
    }
    if (factExtras.bestStreak >= 2) {
      factLine.push({ key: 'habits', state: 'ok', text: `${factExtras.bestStreak} day habit best`, openKind: 'habit_streak' })
    }
  }

  const nextBeat = beats[0]
  const lead = nextBeat
    ? `${nextBeat.name} at ${nextBeat.time}`
    : peopleDue[0]
      ? `${peopleDue[0].name} is due`
      : lastNightLogged
        ? `Last night ${Math.round(lastNightHours * 10) / 10}h`
        : calToday.calendarConnected
          ? 'A quiet day so far'
          : 'Connect Calendar in Settings'
  const leadReason = (reasons: string[]): string => {
    if (reasons.includes('waiting_on_you')) return 'They are waiting on you.'
    if (reasons.includes('deadline')) return 'There is a deadline on this.'
    if (reasons.includes('vip_sender')) return 'You usually reply to them.'
    return 'This rose to the top of your mail.'
  }
  // One card, strict priority: an unlogged night before the day starts, then a
  // hot mail, then prep for the next commitment, then a person gone cold.
  const storyDo = !lastNightLogged && hour < 14
    ? {
        kicker: 'Last night',
        title: 'Log last night',
        hint: 'Bed and wake. Then the day can start.',
        cta: 'Log sleep',
        openKind: 'sleep_tracker',
        kind: 'sleep_log',
      }
    : needsYou[0]
      ? {
          kicker: 'Needs you',
          title: needsYou[0].label,
          hint: leadReason(needsYou[0].reasons),
          cta: 'Open mail',
          openKind: 'digest',
          kind: 'mail',
        }
      : nextBeat
        ? {
            kicker: 'Next',
            title: `${nextBeat.time}  ${nextBeat.name}`,
            hint: 'Show up ready.',
            cta: 'Prep me',
            openKind: 'digest',
            kind: 'prep',
            prepName: nextBeat.name,
          }
        : peopleDue[0]
          ? {
              kicker: 'Due',
              title: `Ping ${peopleDue[0].name}`,
              hint: 'They are due a follow up. Text Alpha to send it.',
              cta: 'Draft it',
              openKind: 'networking_crm',
              kind: 'ping',
            }
          : {
              kicker: 'Today',
              title: 'Nothing is on fire',
              hint: 'Text Alpha if you need a prep or a ping.',
              cta: 'Home',
              openKind: 'apps',
              kind: 'quiet',
            }

  /* ---- The work pull: the thread replacing Slack/Linear/ChatGPT ----
   * Both work personas get their own slice in the morning text — Linear and PRs
   * and drafts for coworker, pipeline and decisions and runway for cofounder —
   * so the brief is the reason you never open those tools. */
  let workSections: Array<{ title: string; lines: string[] }> = []
  let workData: Record<string, unknown> | null = null
  if (persona === 'coworker' || persona === 'cofounder') {
    const [linear, drafts, pipe, decAgg, runway, prs] = await Promise.all([
      persona === 'coworker'
        ? listLinearIssues(user.id).then((r) => r.issues || []).catch(() => [])
        : Promise.resolve([] as Array<{ identifier: string; title: string; state?: string }>),
      sql`SELECT count(*)::int AS n FROM hire_drafts WHERE user_id = ${user.id} AND status = 'pending'`,
      persona === 'cofounder'
        ? sql`SELECT stage, coalesce(value, 0)::real AS value FROM hire_pipeline
              WHERE user_id = ${user.id} AND stage NOT IN ('won', 'lost')`
        : Promise.resolve([] as Array<{ stage: string; value: number }>),
      persona === 'cofounder'
        ? sql`SELECT count(*) FILTER (WHERE outcome IS NULL)::int AS open,
                     max(created_at) AS oldest
              FROM hire_decisions WHERE user_id = ${user.id}`
        : Promise.resolve([{ open: 0, oldest: null }]),
      persona === 'cofounder'
        ? sql`SELECT cash, burn, months FROM hire_runway_snapshots
              WHERE user_id = ${user.id} ORDER BY taken_on DESC LIMIT 1`
        : Promise.resolve([] as Array<{ cash: number; burn: number; months: number }>),
      persona === 'coworker'
        ? (async () => {
            try {
              const raw = await composioFirst(user.id, ['GITHUB_LIST_PULL_REQUESTS'], { state: 'open' })
              return raw ? digestLines(raw).slice(0, 4) : []
            } catch {
              return []
            }
          })()
        : Promise.resolve([] as string[]),
    ])
    const draftsN = Number((drafts[0] as { n?: number })?.n || 0)
    const pipeRows = pipe as Array<{ stage: string; value: number }>
    const dec = (decAgg[0] as { open?: number; oldest?: Date | null }) || {}
    const run = (runway[0] as { cash?: number; burn?: number; months?: number }) || null
    const oldestDays = dec.oldest ? Math.floor((Date.now() - new Date(dec.oldest).getTime()) / 86400000) : 0
    workSections = workPullSections({
      persona,
      linear: linear as Array<{ identifier: string; title: string; state?: string }>,
      prs: prs as string[],
      draftsCount: persona === 'coworker' ? draftsN : undefined,
      pipeline: persona === 'cofounder' ? pipeRows : undefined,
      decisionsOpen: persona === 'cofounder' ? Number(dec.open) || 0 : undefined,
      oldestDecisionDays: oldestDays || undefined,
      runway: run
        ? { cash: Number(run.cash) || 0, burn: Number(run.burn) || 0, months: Number(run.months) || 0 }
        : null,
    })
    workData = {
      sections: workSections,
      linear: (linear as unknown[]).length,
      drafts: draftsN,
      pipeline: pipeRows.length,
      pipelineValue: pipeRows.reduce((s, p) => s + (p.value > 0 ? p.value : 0), 0),
      decisions: Number(dec.open) || 0,
      months: run ? Number(run.months) || 0 : 0,
    }
  }

  const section = (title: string, items: string[]) =>
    items.length ? `${title}\n${items.join('\n')}` : null

  const text = [
    `${PERSONA_LABEL[persona]} · ${wrapTitle} · ${dateLabel}`,
    lead,
    section('The day', todayCal),
    section('Tomorrow', tomorrowCal),
    ...workSections.map((s) => section(s.title, s.lines)),
    section('Mail', mailTallyLine ? [mailTallyLine, ...finalEmails] : finalEmails),
    section('Due a ping', peopleDue.map((p) => `${p.name} · ${p.days} days`)),
    section('Do not forget', reminders.map((r) => `${r.time} · ${r.text}`)),
    section('Promises', loops),
  ]
    .filter(Boolean)
    .join('\n\n')

  const preview = formatBriefPreview({ calendar: todayCal, emails: finalEmails, tomorrow: tomorrowCal, lead })

  return {
    date: dateLabel,
    calendar: todayCal,
    meetings,
    attention,
    emails: finalEmails,
    emailItems: finalEmailItems,
    mailGroups,
    mailTally: mailTallyLine,
    needsYou,
    factLine,
    reminders,
    loops,
    tomorrow: tomorrowCal,
    events,
    work: workData,
    text,
    preview,
    brief,
    story: {
      kicker: brief === 'evening' ? 'Evening' : 'Morning',
      date: dateLabel,
      lead,
      do: storyDo,
      beats,
      asks: finalEmailItems,
      mailGroups,
      mailTally: mailTallyLine,
      needsYou,
      factLine,
      due: peopleDue,
      later: tomorrowCal.slice(0, 2),
      calendarConnected: calToday.calendarConnected,
    },
  }
}

/** Mini apps each hire can offer, mirroring src/agents/skills.ts. */
const PERSONA_MINI_APPS: Record<Persona, string[]> = {
  friend: [
    'digest', 'home', 'tonight', 'pick_night', 'body', 'later', 'check_in', 'open_loops', 'drop_zone',
    'nutrition', 'habit_streak', 'mood_tracker', 'workout_log', 'learning_queue', 'weekly_review',
    'networking_crm', 'sleep_tracker', 'spending_snapshot', 'gratitude_journal', 'spiral_options', 'relationship_radar',
  ],
  coworker: [
    'digest', 'next_move', 'home', 'approve_send', 'pick_slot', 'standup_paste', 'linear_triage', 'open_loops',
    'meeting_mode', 'drop_zone', 'learning_queue', 'weekly_review', 'networking_crm',
  ],
  cofounder: [
    'digest', 'next_move', 'home', 'kill_keep_park', 'hire_decision', 'weekly_review', 'approve_investor_note',
    'decision_ledger', 'relationship_radar', 'drop_zone', 'open_loops', 'networking_crm', 'pipeline_board',
    'spending_snapshot',
  ],
}

/** UTC offset in ms for an IANA zone at a given instant. */
function tzOffsetMs(utcMs: number, timezone: string): number {
  try {
    const dtf = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      timeZoneName: 'longOffset',
      hour12: false,
    })
    const part = dtf
      .formatToParts(new Date(utcMs))
      .find((p) => p.type === 'timeZoneName')?.value
    const m = part?.match(/GMT([+-])(\d{2}):(\d{2})/)
    if (!m) return 0
    const sign = m[1] === '-' ? -1 : 1
    return sign * (Number(m[2]) * 60 + Number(m[3])) * 60 * 1000
  } catch {
    return 0
  }
}

/** Next local HH:MM (today or tomorrow) as a UTC ISO string for the given zone. */
function nextLocalTimeUtc(timezone: string, hour: number, minute = 0): string {
  const dtf = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  })
  const parts = dtf.formatToParts(new Date())
  const get = (t: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === t)?.value || '0'
  const wallNow = Date.UTC(
    Number(get('year')),
    Number(get('month')) - 1,
    Number(get('day')),
    Number(get('hour')),
    Number(get('minute')),
    Number(get('second')),
  )
  let wall = Date.UTC(
    Number(get('year')),
    Number(get('month')) - 1,
    Number(get('day')),
    hour,
    minute,
    0,
  )
  if (wall <= wallNow) wall += 86_400_000
  return new Date(wall - tzOffsetMs(wall, timezone)).toISOString()
}

/** weekday: 0 = Sunday ... 6 = Saturday */
function nextWeekdayLocalUtc(timezone: string, weekday: number, hour: number, minute = 0): string {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    weekday: 'short',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  })
  const parts = dtf.formatToParts(new Date())
  const get = (t: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === t)?.value || '0'
  const dayMap: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }
  const today = dayMap[get('weekday')] ?? 0
  const wallNow = Date.UTC(
    Number(get('year')),
    Number(get('month')) - 1,
    Number(get('day')),
    Number(get('hour')),
    Number(get('minute')),
    Number(get('second')),
  )
  let add = (weekday - today + 7) % 7
  let wall = Date.UTC(
    Number(get('year')),
    Number(get('month')) - 1,
    Number(get('day')),
    hour,
    minute,
    0,
  )
  if (add === 0 && wall <= wallNow) add = 7
  wall += add * 86_400_000
  return new Date(wall - tzOffsetMs(wall, timezone)).toISOString()
}

function parseStandupClock(raw: string | undefined): { hour: number; minute: number } {
  const m = (raw || '').match(/(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i)
  if (!m) return { hour: 9, minute: 30 }
  let h = Number(m[1])
  const min = Number(m[2] || '0')
  const ap = (m[3] || '').toLowerCase()
  if (ap === 'pm' && h < 12) h += 12
  if (ap === 'am' && h === 12) h = 0
  if (!ap && h < 7) h += 12
  return { hour: h, minute: min }
}

export const POKE_MARKER = '[poke]'
export const JUDGE_MARKER = '[judge]'

async function upsertContext(
  sql: SQL,
  userId: string,
  persona: Persona,
  patch: Record<string, unknown>,
) {
  const fields = await loadContext(sql, userId, persona)
  const next = { ...fields, ...patch }
  await sql`
    INSERT INTO hire_context (user_id, persona, fields, updated_at)
    VALUES (${userId}, ${persona}, ${JSON.stringify(next)}, now())
    ON CONFLICT (user_id, persona)
    DO UPDATE SET fields = ${JSON.stringify(next)}, updated_at = now()
  `
  return next as Record<string, string>
}

async function ensureJudgeTick(
  sql: SQL,
  userId: string,
  persona: Persona,
  text: string,
  scheduledAt: string,
  recurrence: 'daily' | 'weekly',
  timezone: string,
) {
  const existing = await sql`
    SELECT id FROM hire_reminders
    WHERE user_id = ${userId} AND persona = ${persona} AND text = ${text}
      AND (status = 'pending' OR recurrence = ${recurrence})
    LIMIT 1
  `
  if (existing[0]) return
  await sql`
    INSERT INTO hire_reminders (id, user_id, persona, text, scheduled_at, recurrence, timezone, status)
    VALUES (${crypto.randomUUID()}, ${userId}, ${persona}, ${text}, ${scheduledAt}, ${recurrence}, ${timezone}, 'pending')
  `
}

/** Heartbeats that wake the judgment loop. Canned poke copy is not sent. */
async function armPokes(
  sql: SQL,
  user: { id: string; timezone: string | null; phone?: string | null },
  persona: Persona,
  context: Record<string, string>,
) {
  const tz = context.timezone || user.timezone || 'America/Los_Angeles'

  // Renewal radar (A7): once a day, scan live mail for recurring charges and
  // turn anything renewing within 3 days into a reminder that shows up in the
  // morning brief's Do-not-forget list. Marker in context keeps it to one scan.
  const today = localDateStrInTz(new Date(), tz)
  if ((context.renewal_scan_day || '') !== today) {
    void (async () => {
      try {
        await sql`
          UPDATE hire_context
          SET fields = fields || ${JSON.stringify({ renewal_scan_day: today })}::jsonb, updated_at = now()
          WHERE user_id = ${user.id} AND persona = ${persona}
        `
        const live = await livePayload(sql, user.phone || '', persona)
        if (!live.found || !live.hired || !live.userId) return
        const bundle = await buildPrepBundle(
          sql,
          { id: live.userId, name: live.name, timezone: tz },
          'recurring charges subscription renewal',
        )
        const hits = scanSubscriptions(bundle?.text || '')
        const dueSoon = hits.filter((h) => {
          if (!h.date) return false
          const days = Math.ceil((new Date(h.date).getTime() - Date.now()) / 86_400_000)
          return days >= 0 && days <= 3
        })
        await sql`
          DELETE FROM hire_reminders
          WHERE user_id = ${user.id} AND persona = ${persona} AND status = 'pending' AND text LIKE '[renewal]%'
        `
        for (const h of dueSoon) {
          const amount = h.amount ? ` — $${h.amount}` : ''
          await sql`
            INSERT INTO hire_reminders (id, user_id, persona, text, scheduled_at, recurrence, timezone, status)
            VALUES (${crypto.randomUUID()}, ${user.id}, ${persona},
              ${(`[renewal] ${h.merchant} renews ${h.date}${amount}`).slice(0, 200)},
              ${nextLocalTimeUtc(tz, 8, 0)}, 'once', ${tz}, 'pending')
          `
        }
        if (dueSoon.length) console.log(`[renewals] ${persona}: ${dueSoon.length} due within 3 days`)
      } catch (err) {
        console.warn('[renewals] scan failed', err)
      }
    })()
  }
  if (persona === 'friend') {
    const digest = await sql`
      SELECT id FROM hire_reminders
      WHERE user_id = ${user.id} AND persona = ${persona}
        AND text LIKE '[digest]%'
        AND (status = 'pending' OR recurrence = 'daily')
      LIMIT 1
    `
    if (!digest[0]) {
      await ensureJudgeTick(sql, user.id, persona, `${JUDGE_MARKER}morning`, nextLocalTimeUtc(tz, 8, 0), 'daily', tz)
    }
    await ensureJudgeTick(sql, user.id, persona, `${JUDGE_MARKER}afternoon`, nextLocalTimeUtc(tz, 17, 0), 'daily', tz)
    await ensureJudgeTick(sql, user.id, persona, `${JUDGE_MARKER}evening`, nextLocalTimeUtc(tz, 21, 0), 'daily', tz)
    await ensureJudgeTick(sql, user.id, persona, `${JUDGE_MARKER}weekly`, nextWeekdayLocalUtc(tz, 0, 19, 0), 'weekly', tz)
  } else if (persona === 'coworker') {
    // The work personas get the same 8 AM morning digest friend does — the one
    // that now carries their Linear/PR/draft or pipeline/decision/runway pull.
    const morning = await sql`
      SELECT id FROM hire_reminders
      WHERE user_id = ${user.id} AND persona = ${persona}
        AND text LIKE '[digest]%'
        AND (status = 'pending' OR recurrence = 'daily')
      LIMIT 1
    `
    if (!morning[0]) {
      await ensureJudgeTick(sql, user.id, persona, `${JUDGE_MARKER}morning`, nextLocalTimeUtc(tz, 8, 0), 'daily', tz)
    }
    const clock = parseStandupClock(context.standup_time)
    let minute = clock.minute - 12
    let hour = clock.hour
    if (minute < 0) {
      minute += 60
      hour = (hour + 23) % 24
    }
    await ensureJudgeTick(
      sql,
      user.id,
      persona,
      `${JUDGE_MARKER}standup`,
      nextLocalTimeUtc(tz, hour, minute),
      'daily',
      tz,
    )
    await ensureJudgeTick(sql, user.id, persona, `${JUDGE_MARKER}weekly`, nextWeekdayLocalUtc(tz, 5, 17, 0), 'weekly', tz)
  } else {
    // Cofounder keeps its own 8 AM pull too.
    const morning = await sql`
      SELECT id FROM hire_reminders
      WHERE user_id = ${user.id} AND persona = ${persona}
        AND text LIKE '[digest]%'
        AND (status = 'pending' OR recurrence = 'daily')
      LIMIT 1
    `
    if (!morning[0]) {
      await ensureJudgeTick(sql, user.id, persona, `${JUDGE_MARKER}morning`, nextLocalTimeUtc(tz, 8, 0), 'daily', tz)
    }
    await ensureJudgeTick(
      sql,
      user.id,
      persona,
      `${JUDGE_MARKER}weekly`,
      nextWeekdayLocalUtc(tz, 0, 18, 0),
      'weekly',
      tz,
    )
  }
  await sql`
    DELETE FROM hire_reminders
    WHERE user_id = ${user.id} AND persona = ${persona} AND text LIKE ${POKE_MARKER + '%'}
  `
  if (!context.proactive || !context.quiet_hours) {
    await upsertContext(sql, user.id, persona, {
      proactive: context.proactive || 'on',
      quiet_hours: context.quiet_hours || '22:00-08:00',
    })
  }
}

function sleepHoursBetween(bedtime: string, wake: string): number {
  const [bh, bm] = bedtime.split(':').map(Number)
  const [wh, wm] = wake.split(':').map(Number)
  if ([bh, bm, wh, wm].some((n) => Number.isNaN(n))) return 0
  let mins = (wh || 0) * 60 + (wm || 0) - ((bh || 0) * 60 + (bm || 0))
  if (mins <= 0) mins += 24 * 60
  return Math.round((mins / 60) * 10) / 10
}

function minutesAgo(iso: string | Date | null | undefined): number | null {
  if (!iso) return null
  const t = new Date(iso).getTime()
  if (Number.isNaN(t)) return null
  return Math.max(0, Math.round((Date.now() - t) / 60_000))
}

function inQuietHoursLocal(localTime: string, quietHours: string): boolean {
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

function localClock(timezone: string) {
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

function stripNudgeDashes(text: string) {
  return text.replace(/[\u2013\u2014]/g, ',').replace(/\s+-\s+/g, '. ').trim()
}

function meetingWho(title: string) {
  const withM = title.match(/\bwith\s+([^,:(/]+)/i)
  if (withM?.[1]) return withM[1].trim().split(/\s+/).slice(0, 2).join(' ')
  const cleaned = title
    .replace(/\b(1\s*:\s*1|1-1|sync|meeting|call|zoom|standup|interview)\b/gi, ' ')
    .replace(/[/|·,]+/g, ' ')
    .trim()
  const parts = cleaned.split(/\s+/).filter(Boolean)
  return (parts[0] || title).slice(0, 40)
}

function loopNudgeText(title: string, weekday: string) {
  const who = title.match(/\b(?:to|with|for)\s+([A-Za-z][A-Za-z'-]+)/)?.[1]
  if (who) return `You told ${who} you'd get back by ${weekday}. It's ${weekday}.`
  const clipped = title.replace(/\.$/, '').slice(0, 80)
  return `${clipped}. That was due ${weekday}. It's ${weekday}.`
}

function decisionNudgeText(decision: string) {
  const clipped = decision.replace(/\.$/, '').slice(0, 80)
  const labeled = /^(the|a|an)\s/i.test(clipped) ? clipped : `the ${clipped}`
  return `Decision review date hit. How did ${labeled} turn out?`
}

function meetingNudgeText(title: string, mins: number) {
  const who = meetingWho(title)
  const wait = Math.max(1, mins)
  const unit = wait === 1 ? 'min' : 'mins'
  return `Meeting with ${who} in ${wait} ${unit}. Do you want to prep?`
}

function slugNudge(raw: string) {
  return raw.toLowerCase().replace(/[^a-z0-9]+/g, '').slice(0, 48) || 'x'
}

type EventNudge = {
  phone: string
  topic: string
  key: string
  text: string
  urgent: boolean
}

function outboundNudgeBlock(
  context: Record<string, string>,
  lastInboundAt: Date | string | null,
  timezone: string,
  urgent: boolean,
): string | null {
  const { localTime, today } = localClock(timezone)
  const pausedUntil = String(context.paused_until || '')
  let proactive = String(context.proactive || 'on').toLowerCase()
  if (proactive === 'paused' && pausedUntil && new Date(pausedUntil).getTime() < Date.now()) {
    proactive = 'on'
  }
  if (proactive === 'off') return 'proactive off'
  if (proactive === 'paused') return 'paused'
  if (!urgent && inQuietHoursLocal(localTime, String(context.quiet_hours || '22:00-08:00'))) return 'quiet hours'
  const inboundAgo = minutesAgo(lastInboundAt)
  if (inboundAgo != null && inboundAgo < 20) return 'in conversation'
  const unanswered = Math.max(0, Number(context.unanswered_proactive) || 0)
  if (unanswered >= 2) return 'awaiting reply'
  if (!urgent) {
    const lastAgo = minutesAgo(context.last_proactive_at)
    if (lastAgo != null && lastAgo < 60) return 'sent recently'
    const unansweredToday =
      String(context.last_proactive_day || '') === today ? Math.max(0, Number(context.unanswered_day_count) || 0) : 0
    if (unansweredToday >= 1) return 'already pinged today'
  }
  return null
}

async function claimNudge(sql: SQL, userId: string, persona: Persona, key: string) {
  const id = crypto.randomUUID()
  const rows = await sql`
    INSERT INTO hire_nudge_log (id, user_id, persona, nudge_key)
    VALUES (${id}, ${userId}, ${persona}, ${key})
    ON CONFLICT (user_id, nudge_key) DO NOTHING
    RETURNING id
  `
  return !!rows[0]
}

async function collectEventNudgesForUser(
  sql: SQL,
  user: { id: string; phone: string | null; timezone: string | null; name?: string | null },
  persona: Persona,
): Promise<EventNudge | null> {
  if (!user.phone) return null
  const tz = user.timezone || 'America/Los_Angeles'
  const context = await loadContext(sql, user.id, persona)
  const inbound = await sql`
    SELECT last_inbound_at AS "lastInboundAt" FROM hire_roster
    WHERE user_id = ${user.id} AND persona = ${persona} LIMIT 1
  `
  const lastInboundAt = (inbound[0] as { lastInboundAt?: Date | null } | undefined)?.lastInboundAt || null
  const { weekday, today } = localClock(tz)
  const sent = await sql`
    SELECT nudge_key AS "nudgeKey" FROM hire_nudge_log
    WHERE user_id = ${user.id} AND sent_at > now() - interval '14 days'
  `
  const sentKeys = new Set((sent as Array<{ nudgeKey: string }>).map((r) => r.nudgeKey))
  const candidates: Array<Omit<EventNudge, 'phone'> & { order: number }> = []
  const roster = await loadRoster(sql, user.id)
  const meetingOwner: Persona | null = roster.includes('coworker')
    ? 'coworker'
    : roster.includes('cofounder')
      ? 'cofounder'
      : null

  const now = Date.now()
  const meetFrom = new Date(now + 15 * 60_000)
  const meetTo = new Date(now + 45 * 60_000)

  const meetings = meetingOwner === persona
    ? await sql`
    SELECT id, title, starts_at AS "startsAt", phase, briefing
    FROM hire_meetings
    WHERE user_id = ${user.id}
      AND starts_at >= ${meetFrom.toISOString()}
      AND starts_at <= ${meetTo.toISOString()}
      AND phase <> 'done'
    ORDER BY starts_at ASC
    LIMIT 4
  `
    : []
  for (const m of meetings as Array<{ id: string; title: string; startsAt: Date; phase: string; briefing: string | null }>) {
    const briefing = String(m.briefing || '').trim()
    if (briefing) continue
    const key = `meeting:${m.id}`
    if (sentKeys.has(key)) continue
    const mins = Math.max(1, Math.round((new Date(m.startsAt).getTime() - now) / 60_000))
    candidates.push({
      order: 0,
      topic: 'meeting_soon',
      key,
      urgent: true,
      text: stripNudgeDashes(meetingNudgeText(m.title, mins)),
    })
  }

  if (meetingOwner === persona) {
    try {
      const access = await googleAccessToken(sql, user.id, 'calendar')
      if (access) {
        const got = await fetchCalendarItems(access, { timeMin: meetFrom, timeMax: meetTo, maxResults: 6 })
        const events = got.ok ? got.items : []
        const prepped = new Set(
          (meetings as Array<{ title: string; briefing: string | null }>).map((m) => m.title.trim().toLowerCase()),
        )
        for (const ev of events) {
          if (prepped.has(ev.title.trim().toLowerCase())) continue
          const key = `cal:${ev.start.toISOString().slice(0, 16)}:${slugNudge(ev.title)}`
          if (sentKeys.has(key)) continue
          const mins = Math.max(1, Math.round((ev.start.getTime() - now) / 60_000))
          candidates.push({
            order: 0,
            topic: 'meeting_soon',
            key,
            urgent: true,
            text: stripNudgeDashes(meetingNudgeText(ev.title, mins)),
          })
        }
      }
    } catch (err) {
      console.warn('[nudge] calendar scan failed', err)
    }
  }

  if (persona === 'friend') {
    try {
      const access = await googleAccessToken(sql, user.id, 'calendar')
      if (access) {
        const got = await fetchCalendarItems(access, { timeMin: meetFrom, timeMax: meetTo, maxResults: 6 })
        const events = got.ok ? got.items.filter((e) => !e.allDay && !isHotelStayEvent(e)) : []
        for (const ev of events) {
          const key = `cal:${ev.start.toISOString().slice(0, 16)}:${slugNudge(ev.title)}`
          if (sentKeys.has(key)) continue
          const mins = Math.max(1, Math.round((ev.start.getTime() - now) / 60_000))
          const who = meetingWho(ev.title)
          const prep = await withTimeout(
            buildPrepBundle(sql, { id: user.id, name: user.name, timezone: tz }, who),
            7000,
            null,
          )
          const body = prep?.text
            ? `Meeting with ${who} in ${mins} mins.\n${prep.text}`
            : `Meeting with ${who} in ${mins} mins.`
          candidates.push({
            order: 0,
            topic: 'meeting_soon',
            key,
            urgent: true,
            text: stripNudgeDashes(body).slice(0, 500),
          })
        }
      }
    } catch (err) {
      console.warn('[nudge] friend calendar scan failed', err)
    }
  }

  const loops = await sql`
    SELECT id, title, due_at AS "dueAt", persona FROM hire_loops
    WHERE user_id = ${user.id} AND status = 'open' AND due_at IS NOT NULL
    ORDER BY due_at ASC LIMIT 12
  `
  for (const loop of loops as Array<{ id: string; title: string; dueAt: Date; persona: string }>) {
    const owner = isPersona(loop.persona) ? loop.persona : roster.includes('friend') ? 'friend' : persona
    if (owner !== persona) continue
    const dueDay = localDateStrInTz(new Date(loop.dueAt), tz)
    if (dueDay !== today) continue
    if (new Date(loop.dueAt).getTime() > now + 5 * 60_000) continue
    const key = `loop:${loop.id}:${today}`
    if (sentKeys.has(key)) continue
    candidates.push({
      order: 1,
      topic: 'loop_due',
      key,
      urgent: false,
      text: stripNudgeDashes(loopNudgeText(loop.title, weekday)),
    })
  }

  if (persona === 'cofounder') {
    const decisions = await sql`
      SELECT id, decision, review_at AS "reviewAt" FROM hire_decisions
      WHERE user_id = ${user.id} AND status = 'open' AND review_at IS NOT NULL AND review_at <= now()
        AND (persona = ${persona} OR persona = '')
      ORDER BY review_at ASC LIMIT 8
    `
    for (const d of decisions as Array<{ id: string; decision: string; reviewAt: Date }>) {
      const key = `decision:${d.id}`
      if (sentKeys.has(key)) continue
      candidates.push({
        order: 2,
        topic: 'decision_review',
        key,
        urgent: false,
        text: stripNudgeDashes(decisionNudgeText(d.decision)),
      })
    }
  }

  candidates.sort((a, b) => a.order - b.order)
  for (const c of candidates) {
    const blocked = outboundNudgeBlock(context, lastInboundAt, tz, c.urgent)
    if (blocked) {
      console.log(`[nudge:${persona}] skip ${user.phone} ${c.topic}: ${blocked}`)
      continue
    }
    const claimed = await claimNudge(sql, user.id, persona, c.key)
    if (!claimed) continue
    return { phone: user.phone, topic: c.topic, key: c.key, text: c.text, urgent: c.urgent }
  }
  return null
}

async function dueEventNudges(sql: SQL, persona: Persona): Promise<EventNudge[]> {
  const rows = await sql`
    SELECT u.id, u.phone_e164 AS phone, u.timezone, u.name
    FROM hire_roster r
    JOIN hire_users u ON u.id = r.user_id
    WHERE r.persona = ${persona} AND u.phone_e164 IS NOT NULL
    LIMIT 40
  `
  const out: EventNudge[] = []
  for (const row of rows as Array<{ id: string; phone: string; timezone: string | null; name: string | null }>) {
    try {
      const nudge = await collectEventNudgesForUser(sql, row, persona)
      if (nudge) out.push(nudge)
    } catch (err) {
      console.warn('[nudge] collect failed', err)
    }
  }
  return out
}

const WORKOUT_DAY_NAME: Record<string, string> = {
  Monday: 'Push',
  Tuesday: 'Pull',
  Wednesday: 'Legs',
  Thursday: 'Upper',
  Friday: 'Lower',
}

function workoutTodayLabel(weekday: string, place: 'home' | 'gym'): { name: string; place: string; rest?: boolean } {
  const name = WORKOUT_DAY_NAME[weekday]
  if (!name) return { name: `${weekday} rest`, place: place === 'home' ? 'home bodyweight' : 'gym', rest: true }
  return {
    name: `${weekday} ${name}`,
    place: place === 'home' ? 'home bodyweight' : 'gym',
  }
}

function emailFromFromHeader(from: string): string {
  const angle = from.match(/<([^>]+)>/)
  if (angle?.[1]) return angle[1].trim()
  const bare = from.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i)
  return bare?.[0]?.trim() || ''
}

async function loadWorldCalendar(
  sql: SQL,
  user: { id: string; name?: string | null },
  tz: string,
): Promise<string[]> {
  const now = new Date()
  const eightHours = new Date(now.getTime() + 8 * 60 * 60 * 1000)
  const endOfDay = startOfLocalDay(tz, 1)
  const until = endOfDay.getTime() > eightHours.getTime() ? endOfDay : eightHours
  const myName = user.name || null
  const access = await googleAccessToken(sql, user.id, 'calendar')
  if (access) {
    const got = await fetchCalendarItems(access, { timeMin: now, timeMax: until, maxResults: 16 })
    if (got.ok) return got.items.map((e) => formatDigestEventLabel(e, tz, myName))
  }
  const rows = await googleEventsRaw(sql, user.id, { timeMin: now, timeMax: until, maxResults: 16 })
  return rows.map((e) => {
    const start = e.allDay ? 'All day' : formatClock(new Date(e.start), tz)
    return `${start} · ${e.title}`
  })
}

async function loadWorldMail(sql: SQL, userId: string): Promise<string[]> {
  const rich = await loadGmailRich(sql, userId, importantMailQuery('16h'), 12)
  if (!rich.length) return []
  const kept = await judgeBriefMail(rich, 3)
  return kept.map((m) => `id=${m.id} | ${formatMailLineFromParts(m.from, m.subject)}`)
}

async function gmailReplyMeta(
  sql: SQL,
  userId: string,
  messageId: string,
): Promise<{ to: string; subject: string; threadId: string; inReplyTo: string } | null> {
  const access = await googleAccessToken(sql, userId, 'gmail')
  if (!access) return null
  const res = await fetch(
    `https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(messageId)}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Message-ID`,
    { headers: { Authorization: `Bearer ${access}` } },
  )
  if (!res.ok) return null
  const data = (await res.json()) as {
    threadId?: string
    payload?: { headers?: Array<{ name: string; value: string }> }
  }
  const headers = data.payload?.headers || []
  const h = (n: string) => headers.find((x) => x.name.toLowerCase() === n.toLowerCase())?.value || ''
  const to = emailFromFromHeader(h('From'))
  const subjectRaw = h('Subject') || 'Re: '
  const subject = /^re:/i.test(subjectRaw) ? subjectRaw : `Re: ${subjectRaw}`
  const inReplyTo = h('Message-ID') || h('Message-Id')
  if (!to) return null
  return { to, subject, threadId: data.threadId || '', inReplyTo }
}

function prepNeedle(query: string): string {
  const raw = String(query || '').trim()
  const m = raw.match(
    /\b(?:prep(?: me)?(?: for)?|get me ready for|brief me (?:on|for)|read me in (?:on|for))\s+(?:the |my |our |this )?(.+?)$/i,
  )
  const rest = m?.[1] || raw
  const cleaned = rest
    .replace(/\b(meeting|call|1-?1|sync|interview|today|tomorrow)\b/gi, ' ')
    .replace(/\bwith\b/gi, ' ')
    .replace(/[.?!]+$/g, '')
    .replace(/["()]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  return (cleaned || rest.replace(/[.?!]+$/g, '').trim()).slice(0, 80)
}

function prepHayMatch(hay: string, needle: string) {
  const n = needle.toLowerCase().trim()
  const h = hay.toLowerCase()
  if (!n || n.length < 2) return false
  const variants = [n, n.replace(/1-1/g, '1:1'), n.replace(/1:1/g, '1-1')]
  if (variants.some((v) => h.includes(v))) return true
  const nFirst = n.split(/\s+/).find((w) => w.length >= 3) || n.split(/\s+/)[0] || ''
  if (nFirst.length >= 2 && h.includes(nFirst)) return true
  const hFirst = h.split(/\s+/)[0] || ''
  return hFirst.length >= 3 && n.includes(hFirst)
}

function firstNameOf(name: string) {
  return (name.split(/\s+/)[0] || name).trim()
}

async function loadGmailMessageBody(sql: SQL, userId: string, messageId: string): Promise<string> {
  const access = await googleAccessToken(sql, userId, 'gmail')
  if (!access) return ''
  const res = await fetch(
    `https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(messageId)}?format=full`,
    { headers: { Authorization: `Bearer ${access}` } },
  )
  if (!res.ok) return ''
  const data = (await res.json()) as { snippet?: string; payload?: GmailMimePart }
  const { text, html } = extractGmailBody(data.payload)
  const raw = (text || stripHtml(html) || data.snippet || '').replace(/\s+/g, ' ').trim()
  return raw.slice(0, 800)
}

/* The prep sheet format. Fixed sections so the sheet scans the same way every
 * time; the model only organizes what was gathered — it never invents. */
const PREP_FORMAT = [
  'You write a short pre-meeting prep sheet. Use ONLY the gathered context. Never invent facts, names, numbers, or dates.',
  'Format exactly, with these section lines:',
  'PREP · {person or meeting name}',
  'WHEN: {time · event} or "nothing matching in the next two days"',
  'WHO: {one line — role, context, where you met, last touch}',
  'LAST THREAD: {one line — the newest email: what was said, any ask left open} or "no email in the last 90 days"',
  'HISTORY:',
  '- {up to three one-line older threads, newest first}',
  'OUT THERE:',
  '- {up to two lines of public info from the web results, only if it matters for the meeting}',
  'OPEN LOOPS:',
  '- {asks either side left unanswered, if any} or "none spotted"',
  'SAY / ASK:',
  '- {two or three concrete talking points or questions for the meeting, drawn only from the context}',
  'Rules: short plain lines. No markdown. No hyphens or dashes in prose. If a section has nothing, say so in one honest line instead of filler.',
].join('\n')

async function buildPrepBundle(
  sql: SQL,
  user: { id: string; name?: string | null; timezone: string | null },
  query: string,
): Promise<{
  text: string
  draft?:
    | { kind: 'mail'; to: string; subject: string; body: string }
    | { kind: 'reply'; messageId: string; body: string }
} | null> {
  const needle = prepNeedle(query)
  const tz = user.timezone || 'America/Los_Angeles'
  const myName = user.name || null
  const now = new Date()
  const until = new Date(now.getTime() + 48 * 60 * 60 * 1000)

  const peopleRows = await sql`
    SELECT name, phone, email, context, where_met AS "whereMet", last_touch AS "lastTouch"
    FROM hire_network WHERE user_id = ${user.id}
    ORDER BY coalesce(last_touch, '1970-01-01'::timestamptz) DESC
    LIMIT 40
  `
  const people = peopleRows as Array<{
    name: string
    phone: string
    email: string
    context: string
    whereMet: string
    lastTouch: string | null
  }>
  const person =
    people.find((p) => needle && prepHayMatch(p.name, needle)) ||
    people.find((p) => needle && prepHayMatch(needle, p.name)) ||
    null

  const searchName = person?.name || needle

  let eventLabel = ''
  let eventTitle = ''
  const access = await googleAccessToken(sql, user.id, 'calendar')
  if (access) {
    const got = await withTimeout(
      fetchCalendarItems(access, { timeMin: now, timeMax: until, maxResults: 20 }),
      6000,
      { ok: false as const, status: 0 },
    )
    if (got.ok) {
      const hit =
        got.items.find((e) => {
          if (isHotelStayEvent(e) && !prepHayMatch(e.title, searchName)) return false
          return prepHayMatch(e.title, searchName) || prepHayMatch(e.description || '', searchName)
        }) ||
        (!needle
          ? got.items.find((e) => !e.allDay && !isHotelStayEvent(e))
          : undefined)
      if (hit) {
        eventTitle = extractOtherPerson(hit.title, myName) || hit.title
        eventLabel = formatDigestEventLabel(hit, tz, myName)
      }
    }
  }
  if (!eventLabel) {
    const rows = await withTimeout(
      googleEventsRaw(sql, user.id, { timeMin: now, timeMax: until, maxResults: 20 }),
      6000,
      [] as Array<{ id: string; title: string; start: string; end: string; allDay: boolean }>,
    )
    const hit = rows.find((e) => prepHayMatch(e.title, searchName) && !e.allDay)
    if (hit) {
      eventTitle = hit.title
      const start = formatClock(new Date(hit.start), tz)
      eventLabel = `${start} · ${hit.title}`
    }
  }

  const meetingRows = await sql`
    SELECT title, notes, briefing
    FROM hire_meetings
    WHERE user_id = ${user.id}
    ORDER BY created_at DESC
    LIMIT 20
  `
  const meeting = (meetingRows as Array<{ title: string; notes: string | null; briefing: string | null }>).find(
    (m) => prepHayMatch(m.title, searchName) && (m.notes || m.briefing),
  )
  const peopleNote = [person?.whereMet ? `Met at ${person.whereMet}` : '', person?.context || '']
    .filter(Boolean)
    .join('. ')
  const meetingNote = String(meeting?.notes || meeting?.briefing || '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 400)

  /* Full context pass: every recent thread with this person (bodies for the
   * two newest), plus a public-web search on the name. The old prep read one
   * email's first 220 characters and called that a brief. */
  let threadId = ''
  const email = (person?.email || '').trim()
  const gmailQ = email
    ? `(from:${email} OR to:${email}) newer_than:90d`
    : searchName
      ? `"${searchName.replace(/"/g, '')}" newer_than:90d`
      : ''
  const rich = gmailQ ? await withTimeout(loadGmailRich(sql, user.id, gmailQ, 8), 8000, []) : []
  const threadLines: string[] = []
  for (const [i, m] of rich.slice(0, 4).entries()) {
    let last = ''
    if (i < 2) {
      const body = await withTimeout(loadGmailMessageBody(sql, user.id, m.id), 6000, '')
      last = (body || m.snippet || '').replace(/\s+/g, ' ').trim().slice(0, 220)
    } else {
      last = (m.snippet || '').replace(/\s+/g, ' ').trim().slice(0, 150)
    }
    const when = String(m.date || '').slice(0, 16)
    threadLines.push(`${i + 1}. ${m.subject || 'Mail'} — ${m.from || 'unknown'}${when ? ` — ${when}` : ''}: ${last}`)
  }
  threadId = rich[0]?.id || ''

  let webText = ''
  if (searchName) {
    const q = [searchName, person?.context].filter(Boolean).join(' ').slice(0, 160)
    webText = await withTimeout(fetchWebSearch(q), 8000, '')
  }

  const who = person?.name || eventTitle || needle || 'that meeting'
  const lastTouch = person?.lastTouch
    ? `${Math.max(1, Math.floor((Date.now() - new Date(person.lastTouch).getTime()) / 86_400_000))} days ago`
    : ''

  const gathered = [
    `MEETING: ${eventLabel || 'nothing matching in the next two days'}`,
    `PERSON: ${[person?.name || searchName || 'unknown', person?.email || '', peopleNote || 'no notes on file', lastTouch ? `last touched ${lastTouch}` : '']
      .filter(Boolean)
      .join(' | ')}`,
    `MEETING NOTES: ${meetingNote || 'none'}`,
    `EMAIL THREADS (newest first):\n${threadLines.length ? threadLines.join('\n') : 'no email with them in the last 90 days'}`,
    webText ? `WEB:\n${webText}` : 'WEB: nothing found',
  ].join('\n\n')

  const hasAnything = !!(person || eventLabel || peopleNote || meetingNote || threadId || threadLines.length)
  if (!hasAnything) return null

  /* The sheet is a fixed format; the model organizes the gathered facts into
   * it. If the model is down, the raw gather is still an honest sheet. */
  const fallbackText = [
    `Prep for ${who}`,
    `When: ${eventLabel || 'nothing on the next two days that matches'}`,
    `People note: ${peopleNote || 'none on file'}`,
    meetingNote ? `Meeting notes: ${meetingNote}` : '',
    threadLines.length ? `Threads:\n${threadLines.join('\n')}` : 'Thread: none in the last 90 days',
    webText ? `Web:\n${webText}` : '',
  ]
    .filter(Boolean)
    .join('\n')

  let text = fallbackText
  try {
    const synthesized = await gmiBriefChat(PREP_FORMAT, gathered, 700, 14000, { plainText: true })
    if (synthesized?.trim()) text = synthesized.trim()
    else console.warn('[prep] synthesis empty, using raw gather')
  } catch (err) {
    console.warn('[prep] synthesis failed, using raw gather', err)
  }

  const first = firstNameOf(who)
  const whenBit = eventTitle || 'this'
  let draft:
    | { kind: 'mail'; to: string; subject: string; body: string }
    | { kind: 'reply'; messageId: string; body: string }
    | undefined
  if (threadId) {
    draft = {
      kind: 'reply',
      messageId: threadId,
      body: `Thanks ${first}. I am set for ${whenBit}.`,
    }
  } else if (email) {
    draft = {
      kind: 'mail',
      to: email,
      subject: eventTitle ? `Ahead of ${eventTitle}` : 'Checking in',
      body: `Hey ${first}, looking forward to ${whenBit}.`,
    }
  }

  return { text, draft }
}

async function loadWeekSnapshot(
  sql: SQL,
  userId: string,
  weekStart: string,
  timezone: string,
): Promise<WeekSnap> {
  const weekEnd = shiftDateStr(weekStart, 7)
  /* `::date` would read at the database's session timezone — off by the user's
   * UTC offset, so a Sunday-night log fell into next week. Use real instants. */
  const weekWindow = weekWindowUtc(weekStart, timezone)
  const nutr = await sql`
    SELECT count(*)::int AS meals FROM hire_nutrition_logs
    WHERE user_id = ${userId} AND eaten_at >= ${weekWindow.start.toISOString()} AND eaten_at < ${weekWindow.end.toISOString()}
  `
  const habits = await sql`
    SELECT count(*)::int AS checks FROM hire_habit_logs
    WHERE user_id = ${userId} AND date >= ${weekStart} AND date < ${weekEnd}
  `
  const sleep = await sql`
    SELECT bedtime, wake FROM hire_sleep
    WHERE user_id = ${userId} AND sleep_date >= ${weekStart} AND sleep_date < ${weekEnd}
  `
  const sleepRows = sleep as Array<{ bedtime: string; wake: string }>
  const avgSleepHours = sleepRows.length
    ? Math.round(
        (sleepRows.reduce((sum, r) => sum + sleepHoursBetween(r.bedtime, r.wake), 0) / sleepRows.length) * 10,
      ) / 10
    : 0
  const spend = await sql`
    SELECT coalesce(sum(amount), 0)::real AS total FROM hire_spending
    WHERE user_id = ${userId} AND spent_at >= ${weekWindow.start.toISOString()} AND spent_at < ${weekWindow.end.toISOString()}
  `
  const budget = await sql`SELECT weekly_budget AS "weeklyBudget" FROM hire_spending_budget WHERE user_id = ${userId}`
  const workouts = await sql`
    SELECT count(*)::int AS n FROM hire_workouts
    WHERE user_id = ${userId} AND logged_at >= ${weekWindow.start.toISOString()} AND logged_at < ${weekWindow.end.toISOString()}
  `
  const gratitude = await sql`
    SELECT count(*)::int AS n FROM hire_gratitude
    WHERE user_id = ${userId} AND created_at >= ${weekWindow.start.toISOString()} AND created_at < ${weekWindow.end.toISOString()}
  `
  const duePeople = await sql`
    SELECT count(*)::int AS n FROM hire_network
    WHERE user_id = ${userId}
      AND (last_touch IS NULL OR last_touch < now() - (cadence_days || ' days')::interval)
  `
  return {
    meals: Number((nutr[0] as { meals?: number })?.meals || 0),
    habitChecks: Number((habits[0] as { checks?: number })?.checks || 0),
    sleepNights: sleepRows.length,
    avgSleepHours,
    workouts: Number((workouts[0] as { n?: number })?.n || 0),
    spend: Number((spend[0] as { total?: number })?.total || 0),
    weeklyBudget: Math.round(Number((budget[0] as { weeklyBudget?: number })?.weeklyBudget) || 400),
    followUpsDue: Number((duePeople[0] as { n?: number })?.n || 0),
    gratitude: Number((gratitude[0] as { n?: number })?.n || 0),
  }
}

async function buildWeekBundle(
  sql: SQL,
  user: { id: string; name?: string | null; timezone: string | null },
): Promise<{
  text: string
  wroteReview: boolean
  spendOver: boolean
  ping?: { name: string; email?: string; phone?: string }
}> {
  const weekStart = userMonday(user)
  const snap = await loadWeekSnapshot(sql, user.id, weekStart, user.timezone || 'America/Los_Angeles')
  const wrote = composeWeekReview(snap)
  /* The weekly run is the natural moment to keep the runway honest: capture the
   * latest cash/burn the cofounder context knows about so home and the review
   * have a real number instead of a dash. */
  try {
    const ctx = await loadContext(sql, user.id, 'cofounder')
    const cash = Number(String(ctx.cash || ctx.runway_cash || '').replace(/[^0-9.]/g, ''))
    const burn = Number(String(ctx.burn || ctx.monthly_burn || '').replace(/[^0-9.]/g, ''))
    if (Number.isFinite(cash) && cash > 0 && Number.isFinite(burn) && burn > 0) {
      await sql`
        INSERT INTO hire_runway_snapshots (id, user_id, taken_on, cash, burn, months)
        VALUES (${crypto.randomUUID()}, ${user.id}, ${weekStart}, ${cash}, ${burn}, ${cash / burn})
        ON CONFLICT (user_id, taken_on) DO UPDATE SET cash = excluded.cash, burn = excluded.burn, months = excluded.months
      `
    }
  } catch (err) {
    console.warn('[weekly] runway snapshot failed', err)
  }
  const existing = await sql`
    SELECT id, done_text AS "doneText" FROM hire_weekly_reviews
    WHERE user_id = ${user.id} AND week_start = ${weekStart} LIMIT 1
  `
  const row = existing[0] as { id: string; doneText?: string } | undefined
  let wroteReview = false
  if (!row) {
    const id = crypto.randomUUID()
    await sql`
      INSERT INTO hire_weekly_reviews (id, user_id, week_start, done_text, slipped_text, focus_text)
      VALUES (${id}, ${user.id}, ${weekStart}, ${wrote.doneText}, ${wrote.slippedText}, ${wrote.focusText})
    `
    wroteReview = true
  }
  const due = await sql`
    SELECT name, phone, email FROM hire_network
    WHERE user_id = ${user.id}
      AND (last_touch IS NULL OR last_touch < now() - (cadence_days || ' days')::interval)
    ORDER BY coalesce(last_touch, '1970-01-01'::timestamptz) ASC
    LIMIT 1
  `
  const pingRow = due[0] as { name: string; phone: string; email: string } | undefined
  const ping = pingRow
    ? {
        name: pingRow.name,
        email: pingRow.email || undefined,
        phone: pingRow.phone || undefined,
      }
    : undefined
  return {
    text: wrote.text,
    wroteReview,
    spendOver: snap.weeklyBudget > 0 && snap.spend > snap.weeklyBudget,
    ping: ping?.email || ping?.phone ? ping : undefined,
  }
}

/** The timezone the user's day actually runs on: travel_tz when travel mode
 * is set, else home. One function so briefs and guards stay in sync. */
function effectiveTz(userTz: string | null | undefined, context: Record<string, string> | null | undefined): string {
  return (context?.travel_tz || '').trim() || userTz || 'America/Los_Angeles'
}

async function judgmentStatePayload(
  sql: SQL,
  user: { id: string; timezone: string | null; name?: string | null },
  persona: Persona,
  tick: string,
) {
  const context = await loadContext(sql, user.id, persona)
  const tz = effectiveTz(user.timezone, context)
  const today = localDateStrInTz(new Date(), tz)
  const weekStart = userMonday(user)
  const weekEnd = shiftDateStr(weekStart, 7)
  /* TIMESTAMPTZ columns compared to a bare `::date` read at midnight in the
   * database's session timezone — the user's day/week is minutes off that. */
  const dayWindow = todayWindowUtc(tz)
  const weekWindow = weekWindowUtc(weekStart, tz)
  const localTime = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(new Date()).replace(', ', 'T')
  const weekday = new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'long' }).format(new Date())

  const inbound = await sql`
    SELECT last_inbound_at AS "lastInboundAt" FROM hire_roster
    WHERE user_id = ${user.id} AND persona = ${persona} LIMIT 1
  `
  const lastInboundAt = (inbound[0] as { lastInboundAt?: Date | null } | undefined)?.lastInboundAt || null

  const nutrGoals = await sql`
    SELECT calorie_goal AS "calorieGoal", protein_goal AS "proteinGoal"
    FROM hire_nutrition_goals WHERE user_id = ${user.id} LIMIT 1
  `
  const nutrToday = await sql`
    SELECT count(*)::int AS meals, coalesce(sum(calories), 0)::real AS calories, coalesce(sum(protein), 0)::real AS protein
    FROM hire_nutrition_logs
    WHERE user_id = ${user.id} AND eaten_at >= ${dayWindow.start.toISOString()} AND eaten_at < ${dayWindow.end.toISOString()}
  `
  const g = (nutrGoals[0] as { calorieGoal?: number; proteinGoal?: number } | undefined) || {}
  const n = (nutrToday[0] as { meals?: number; calories?: number; protein?: number } | undefined) || {}

  const habitRows = await sql`
    SELECT id, name FROM hire_habits WHERE user_id = ${user.id} ORDER BY created_at ASC LIMIT 12
  `
  const habitLogs = await sql`
    SELECT habit_id AS "habitId", date FROM hire_habit_logs
    WHERE user_id = ${user.id} AND date >= ${shiftDateStr(today, -14)}
  `
  const logMap = new Map<string, Set<string>>()
  for (const lr of habitLogs as Array<{ habitId: string; date: string }>) {
    if (!logMap.has(lr.habitId)) logMap.set(lr.habitId, new Set())
    logMap.get(lr.habitId)!.add(String(lr.date).slice(0, 10))
  }
  const habits = (habitRows as Array<{ id: string; name: string }>).map((h) => {
    const dates = logMap.get(h.id) || new Set()
    let streak = 0
    const startEmpty = !dates.has(today)
    for (let i = startEmpty ? 1 : 0; i < 400; i++) {
      const ds = shiftDateStr(today, -i)
      if (dates.has(ds)) streak++
      else break
    }
    return { name: h.name, streak, todayDone: dates.has(today) }
  })

  const moodRows = await sql`
    SELECT emoji, energy, created_at AS "createdAt"
    FROM hire_moods WHERE user_id = ${user.id}
    ORDER BY created_at DESC LIMIT 1
  `
  const moodRow = moodRows[0] as { emoji?: string; energy?: number; createdAt?: Date } | undefined
  const mood = moodRow?.emoji
    ? {
        loggedToday: localDateStrInTz(new Date(moodRow.createdAt as Date), tz) === today,
        lastEmoji: moodRow.emoji,
        lastEnergy: moodRow.energy || null,
      }
    : null

  const lastNight = shiftDateStr(today, -1)
  const sleepRows = await sql`
    SELECT sleep_date AS "sleepDate", bedtime, wake, quality
    FROM hire_sleep WHERE user_id = ${user.id}
    ORDER BY sleep_date DESC LIMIT 7
  `
  const srow = (sleepRows as Array<{ sleepDate?: string; bedtime?: string; wake?: string; quality?: number }>).find(
    (r) => {
      const d = ymdOf(r.sleepDate)
      return (d === lastNight || d === today) && r.bedtime && r.wake
    },
  )
  const sleep = srow
    ? { hours: sleepHoursBetween(srow.bedtime!, srow.wake!), quality: srow.quality || 3, date: lastNight }
    : null
  const weekNights = (sleepRows as Array<{ bedtime?: string; wake?: string }>).filter((r) => r.bedtime && r.wake)
  const weekHours = weekNights.map((r) => sleepHoursBetween(r.bedtime!, r.wake!))
  const sleepWeek = weekHours.length
    ? {
        nights: weekHours.length,
        avgHours: Math.round((weekHours.reduce((a, b) => a + b, 0) / weekHours.length) * 10) / 10,
        shortNights: weekHours.filter((h) => h < 6.5).length,
      }
    : { nights: 0, avgHours: 0, shortNights: 0 }

  const workoutTodayRows = await sql`
    SELECT count(*)::int AS n FROM hire_workouts
    WHERE user_id = ${user.id} AND logged_at >= ${dayWindow.start.toISOString()} AND logged_at < ${dayWindow.end.toISOString()}
  `
  const workoutsToday = Number((workoutTodayRows[0] as { n?: number })?.n || 0)
  const prefs = await loadMiniPrefs(sql, user.id)
  const workoutToday = workoutTodayLabel(weekday, prefs.workoutPlace)


  const duePeople = await sql`
    SELECT name, context, phone, last_touch AS "lastTouch", cadence_days AS "cadenceDays"
    FROM hire_network WHERE user_id = ${user.id}
    ORDER BY coalesce(last_touch, '1970-01-01'::timestamptz) ASC LIMIT 8
  `
  const peopleDue = (duePeople as Array<{ name: string; context: string; phone: string; lastTouch: Date | null; cadenceDays: number }>)
    .map((p) => {
      const days = p.lastTouch ? Math.floor((Date.now() - new Date(p.lastTouch).getTime()) / 86400000) : 999
      const bits = [p.phone, p.context].filter(Boolean)
      return {
        name: p.name,
        days,
        note: bits.join('. ') || undefined,
        due: days >= (p.cadenceDays || 14),
        phone: p.phone || undefined,
      }
    })
    .filter((p) => p.due)
    .slice(0, 3)
    .map(({ name, days, note, phone }) => ({ name, days, note, phone }))

  const phoneRows = await sql`
    SELECT name, phone, email FROM hire_network
    WHERE user_id = ${user.id} AND (coalesce(phone, '') <> '' OR coalesce(email, '') <> '')
    ORDER BY coalesce(last_touch, '1970-01-01'::timestamptz) DESC
    LIMIT 12
  `
  const peoplePhones = (phoneRows as Array<{ name: string; phone: string; email: string }>).map((p) => ({
    name: p.name,
    phone: p.phone || undefined,
    email: p.email || undefined,
  }))

  const radar = await sql`
    SELECT name, last_touch_at AS "lastTouch", cadence_days AS "cadenceDays"
    FROM hire_network WHERE user_id = ${user.id} LIMIT 8
  `
  for (const p of radar as Array<{ name: string; lastTouch: Date | null; cadenceDays: number }>) {
    const days = p.lastTouch ? Math.floor((Date.now() - new Date(p.lastTouch).getTime()) / 86400000) : 999
    if (days >= (p.cadenceDays || 14) && !peopleDue.some((x) => x.name === p.name)) {
      peopleDue.push({ name: p.name, days })
    }
  }

  const spendRow = await sql`
    SELECT coalesce(sum(amount), 0)::real AS total FROM hire_spending
    WHERE user_id = ${user.id} AND spent_at >= ${weekWindow.start.toISOString()} AND spent_at < ${weekWindow.end.toISOString()}
  `
  const budgetRow = await sql`SELECT weekly_budget AS "weeklyBudget" FROM hire_spending_budget WHERE user_id = ${user.id}`
  const loops = await sql`
    SELECT title FROM hire_loops WHERE user_id = ${user.id} AND status = 'open' ORDER BY created_at DESC LIMIT 5
  `

  let calendar: string[] = []
  let mail: string[] = []
  const digestTick =
    tick === 'digest' || tick === 'morning' || tick === 'evening' || tick === 'night' || tick === 'digest_evening'
  try {
    if (digestTick) {
      /* Warms the same cache the brief link reads, so the digest text and the
       * screen it points at are one load rather than two. */
      const payload = (await digestCache.read(
        `${user.id}|${persona}`,
        () => briefLoader(sql, user.id, persona, 'digest', () => digestPayload(sql, user, persona), localDateStrInTz(new Date(), user.timezone || 'America/Los_Angeles')),
        BRIEF_WARM_WAIT_MS,
      )).value
      calendar = (payload?.calendar || []).slice(0, 4)
      mail = (payload?.emails || []).slice(0, 3)
    } else {
      const connected = await connectedForUser(sql, user.id)
      const jobs: Array<Promise<void>> = []
      if (connected.includes('calendar')) {
        jobs.push(
          withTimeout(loadWorldCalendar(sql, user, tz), 5000, [] as string[]).then((rows) => {
            calendar = rows
          }),
        )
      }
      if (connected.includes('gmail')) {
        jobs.push(
          withTimeout(loadWorldMail(sql, user.id), 8000, [] as string[]).then((rows) => {
            mail = rows
          }),
        )
      }
      if (jobs.length) await Promise.all(jobs)
    }
  } catch (err) {
    console.warn('[judgment] world model slice failed', err)
  }

  const pausedUntil = String(context.paused_until || '')
  let proactive = String(context.proactive || 'on')
  if (proactive === 'paused' && pausedUntil && new Date(pausedUntil).getTime() < Date.now()) {
    proactive = 'on'
  }

  let weekly: Record<string, number | string> | null = null
  if (tick === 'weekly') {
    const wkNutr = await sql`
      SELECT count(*)::int AS meals, coalesce(sum(calories), 0)::real AS calories
      FROM hire_nutrition_logs WHERE user_id = ${user.id} AND eaten_at >= ${weekWindow.start.toISOString()} AND eaten_at < ${weekWindow.end.toISOString()}
    `
    const wkMoods = await sql`
      SELECT count(*)::int AS logs, coalesce(avg(energy), 0)::real AS energy
      FROM hire_moods WHERE user_id = ${user.id} AND created_at >= ${weekWindow.start.toISOString()} AND created_at < ${weekWindow.end.toISOString()}
    `
    const wkHabits = await sql`
      SELECT count(*)::int AS checks FROM hire_habit_logs
      WHERE user_id = ${user.id} AND date >= ${weekStart} AND date < ${weekEnd}
    `
    const wkSleep = await sql`
      SELECT bedtime, wake FROM hire_sleep
      WHERE user_id = ${user.id} AND sleep_date >= ${weekStart} AND sleep_date < ${weekEnd}
    `
    let wkSleepHours = 0
    const wkSleepRows = wkSleep as Array<{ bedtime: string; wake: string }>
    if (wkSleepRows.length) {
      wkSleepHours =
        wkSleepRows.reduce((sum, r) => sum + sleepHoursBetween(r.bedtime, r.wake), 0) / wkSleepRows.length
    }
    const wkWorkouts = await sql`
      SELECT count(*)::int AS n FROM hire_workouts
      WHERE user_id = ${user.id} AND logged_at >= ${weekWindow.start.toISOString()} AND logged_at < ${weekWindow.end.toISOString()}
    `
    const wkLearning = await sql`
      SELECT count(*)::int AS n FROM hire_learning
      WHERE user_id = ${user.id} AND status = 'done' AND created_at >= ${weekWindow.start.toISOString()} AND created_at < ${weekWindow.end.toISOString()}
    `
    weekly = {
      meals: Number((wkNutr[0] as { meals?: number })?.meals || 0),
      calories: Math.round(Number((wkNutr[0] as { calories?: number })?.calories) || 0),
      moodLogs: Number((wkMoods[0] as { logs?: number })?.logs || 0),
      avgEnergy: Math.round((Number((wkMoods[0] as { energy?: number })?.energy) || 0) * 10) / 10,
      habitChecks: Number((wkHabits[0] as { checks?: number })?.checks || 0),
      sleepNights: wkSleepRows.length,
      avgSleepHours: Math.round(wkSleepHours * 10) / 10,
      spend: Math.round(Number((spendRow[0] as { total?: number })?.total) || 0),
      weeklyBudget: Math.round(Number((budgetRow[0] as { weeklyBudget?: number })?.weeklyBudget) || 400),
      workouts: Number((wkWorkouts[0] as { n?: number })?.n || 0),
      learningDone: Number((wkLearning[0] as { n?: number })?.n || 0),
      gratitude: 0,
    }
    const wkGratitude = await sql`
      SELECT count(*)::int AS n FROM hire_gratitude
      WHERE user_id = ${user.id} AND created_at >= ${weekWindow.start.toISOString()} AND created_at < ${weekWindow.end.toISOString()}
    `
    weekly.gratitude = Number((wkGratitude[0] as { n?: number })?.n || 0)
  }

  return {
    persona,
    name: user.name || null,
    localTime,
    weekday,
    timezone: tz,
    tick,
    proactive,
    quietHours: String(context.quiet_hours || '22:00-08:00'),
    lastInboundMinutesAgo: minutesAgo(lastInboundAt),
    lastProactiveMinutesAgo: minutesAgo(context.last_proactive_at),
    lastProactiveTopic: context.last_proactive_topic || null,
    unansweredProactive: Math.max(0, Number(context.unanswered_proactive) || 0),
    unansweredToday:
      String(context.last_proactive_day || '') === today
        ? Math.max(0, Number(context.unanswered_day_count) || 0)
        : 0,
    nutrition: {
      calories: Math.round(Number(n.calories) || 0),
      protein: Math.round(Number(n.protein) || 0),
      calorieGoal: Math.round(Number(g.calorieGoal) || 2200),
      proteinGoal: Math.round(Number(g.proteinGoal) || 150),
      meals: Number(n.meals) || 0,
    },
    habits,
    mood,
    sleep,
    sleepWeek,
    workoutsToday,
    workoutToday,
    peopleDue: peopleDue.slice(0, 3),
    peoplePhones,
    spend: {
      weekTotal: Math.round(Number((spendRow[0] as { total?: number })?.total) || 0),
      weeklyBudget: Math.round(Number((budgetRow[0] as { weeklyBudget?: number })?.weeklyBudget) || 400),
    },
    loops: (loops as Array<{ title: string }>).map((l) => l.title),
    calendar,
    mail,
    ...(weekly ? { weekly } : {}),
  }
}

async function touchInbound(sql: SQL, phone: string, persona: Persona) {
  const user = await getUserByPhone(sql, phone)
  if (!user) return { armed: false, first: false }
  const rows = await sql`
    SELECT last_inbound_at AS "lastInboundAt" FROM hire_roster
    WHERE user_id = ${user.id} AND persona = ${persona} LIMIT 1
  `
  const row = rows[0] as { lastInboundAt: Date | null } | undefined
  if (!row) return { armed: false, first: false }
  const first = !row.lastInboundAt
  await sql`
    UPDATE hire_roster SET last_inbound_at = now()
    WHERE user_id = ${user.id} AND persona = ${persona}
  `
  const context = await loadContext(sql, user.id, persona)
  await upsertContext(sql, user.id, persona, {
    unanswered_proactive: '0',
    unanswered_day_count: '0',
  })
  await armPokes(sql, user, persona, context)
  return { armed: true, first }
}

function splitList(raw: string | undefined) {
  return (raw || '')
    .split(/[,;\n]+/)
    .map((s) => s.trim())
    .filter(Boolean)
}

async function miniPayload(
  sql: SQL,
  user: { id: string; timezone: string | null },
  persona: Persona,
  kind: string,
) {
  const tz = user.timezone || 'America/Los_Angeles'
  // Two independent reads that every kind below needs. Serially they were two
  // round trips before any real work started.
  const [context, connectedAll] = await Promise.all([
    loadContext(sql, user.id, persona),
    connectedForUser(sql, user.id),
  ])
  const connected = connectedAll.filter((id) => !PERSONA_DENIED[persona].has(id))
  const dateLabel = new Date().toLocaleDateString('en-US', {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    timeZone: tz,
  })

  if (kind === 'tonight') {
    const location = await pickActiveLocation(sql, user.id)
    const mapsQuery = String(context.tonight_query || 'dinner restaurant').trim() || 'dinner restaurant'
    const mapsRaw = await fetchMapSearch(mapsQuery, timezoneCountry(tz), location)
    const places: Array<{ label: string; link?: string }> = []
    for (const line of mapsRaw.split('\n')) {
      if (!line.startsWith('- ')) continue
      const link = line.match(/https:\/\/\S+/)?.[0]
      const label = line
        .replace(/^- /, '')
        .replace(/\s+https:\/\/\S+/, '')
        .trim()
      if (label) places.push({ label, link })
    }
    const hour = Number(
      new Date().toLocaleString('en-US', { hour: 'numeric', hour12: false, timeZone: tz }),
    )
    const vibe =
      hour >= 21 ? 'Wind down early if last night was short.' : hour >= 17 ? 'Evening is open.' : 'Plan ahead while the day is light.'
    const sections = [
      {
        heading: places.length ? 'Places' : 'Tonight',
        items: places.length
          ? places.slice(0, 5).map((p) => (p.link ? `${p.label}\n${p.link}` : p.label))
          : [mapsRaw.split('\n').find(Boolean) || 'Tell Alpha in or out and a neighborhood.'],
      },
      { heading: 'The read', items: [vibe] },
    ]
    return { kind, title: 'Tonight', date: dateLabel, sections, text: mapsRaw }
  }

  if (kind === 'pick_night') {
    // Evening brief: what happened today, what's left, mail since morning, tomorrow.
    const nowMs = Date.now()
    const todayStart = startOfLocalDay(tz)
    const tomorrowStart = startOfLocalDay(tz, 1)
    const dayAfterStart = startOfLocalDay(tz, 2)
    const todayYmd = todayStart.toLocaleDateString('en-CA', { timeZone: tz })
    const tomorrowYmd = tomorrowStart.toLocaleDateString('en-CA', { timeZone: tz })

    interface EveningEvent {
      time: string
      title: string
      who: string
      meetKind: string
      allDay: boolean
      startMs: number
      dayYmd: string
    }

    const allEvents: EveningEvent[] = []

    function pushCalItems(items: CalItem[]) {
      for (const e of items) {
        const ymd = e.start.toLocaleDateString('en-CA', { timeZone: tz })
        allEvents.push({
          time: e.allDay ? 'All day' : formatClock(e.start, tz),
          title: e.title,
          who: extractOtherPerson(e.title, user.name || null) || parseCalMeet(e.title).who,
          meetKind: e.kind,
          allDay: e.allDay,
          startMs: e.start.getTime(),
          dayYmd: ymd,
        })
      }
    }

    /* The three things this brief is made of — the calendar, the inbox, and the
     * day's own logs — never read each other. Serially they were three waits
     * stacked end to end; started together the brief costs only the slowest. */
    const calJob = (async () => {
      if (!connected.includes('calendar')) return
      // Try direct Google Calendar first: fetch today + tomorrow together
      const access = await googleAccessToken(sql, user.id, 'calendar')
      if (access) {
        const got = await fetchCalendarItems(access, {
          timeMin: todayStart,
          timeMax: dayAfterStart,
          maxResults: 20,
        })
        if (got.ok) pushCalItems(got.items)
      }
      // Fallback via composio/runTools if direct fetch returned nothing
      if (!allEvents.length) {
        const calResults = await withTimeout(
          runToolsForMessage(sql, {
            userId: user.id,
            persona,
            message: 'calendar today tomorrow',
            connected,
            timezone: tz,
          }),
          8000,
          [] as string[],
        )
        const calendarBlock = calResults.find((t) => isCalendarToolResult(t))
        for (const line of digestLines(calendarBlock)) {
          const parsed = parseFormattedEventLine(line)
          if (!parsed) continue
          const raw = parsed.iso.includes('T') ? parsed.iso : `${parsed.iso}T12:00:00`
          const d = new Date(raw)
          if (Number.isNaN(d.getTime())) continue
          const ymd = d.toLocaleDateString('en-CA', { timeZone: tz })
          if (ymd !== todayYmd && ymd !== tomorrowYmd) continue
          allEvents.push({
            time: parsed.clock || formatCalTime(parsed.iso, tz),
            title: parsed.title,
            who: extractOtherPerson(parsed.title, user.name || null) || parseCalMeet(parsed.title).who,
            meetKind: parsed.kind || 'Meeting',
            allDay: parsed.clock === 'All day',
            startMs: d.getTime(),
            dayYmd: ymd,
          })
        }
      }
    })()

    // Mail since morning: recent inbox minus Promotions, then a model judges.
    // Keep enough to break into sub-category piles like the morning brief.
    let mailItems: Array<{ id: string; label: string; snippet?: string }> = []
    let mailGroups: Array<{
      kind: string
      label: string
      count: number
      items: Array<{ id: string; label: string; snippet?: string }>
    }> = []
    const mailJob = (async () => {
      if (!connected.includes('gmail')) return
      try {
        const richMail = await withTimeout(
          loadGmailRich(sql, user.id, importantMailQuery('12h'), 12),
          6000,
          [] as Array<{ id: string; from: string; date: string; subject: string; snippet: string }>,
        )
        const doneIdsE = await triagedMailIds(sql, user.id)
        const kept = (await judgeBriefMail(richMail, 12)).filter((m) => !doneIdsE.has(m.id))
        // A few lead the flat "Mail since this morning"; the rest become the
        // sub-category piles. Morning keeps these separate, and so does this —
        // otherwise every mail renders twice (flat + grouped).
        const leadIds = new Set(kept.slice(0, 3).map((m) => m.id))
        mailItems = kept.slice(0, 3).map((m) => ({
          id: m.id,
          label: formatMailLineFromParts(m.from, m.subject),
          snippet: cleanMailSnippet(m.snippet),
        }))
        mailGroups = groupMailByKind(kept.filter((m) => !leadIds.has(m.id))).map((g) => ({
          kind: g.kind,
          label: g.label,
          count: g.count,
          items: g.items.map((m) => ({
            id: m.id,
            label: formatMailLineFromParts(m.from, m.subject),
            snippet: cleanMailSnippet(m.snippet || ''),
          })),
        }))
      } catch {
        // best-effort
      }
    })()

    // The day, closed: every fact below comes from a log table, never invented.
    // The checklist and score let the evening brief answer "how did today go"
    // instead of only listing what is left on the calendar.
    interface EveningDayFact {
      key: string
      label: string
      detail: string
      state: 'done' | 'miss' | 'partial'
    }
    const dayFacts: EveningDayFact[] = []
    const habitsToday: Array<{ id: string; name: string; emoji: string; done: boolean }> = []
    const carryOver: Array<{ id: string; title: string; dueLabel?: string }> = []
    let dayScore: { points: number; verdict: string } | null = null
    const factsJob = (async () => {
      try {
        const weekStartNight = mondayOfDateStr(todayYmd)
        const yesterdayYmd = shiftDateStr(todayYmd, -1)
        /* Ten one-row reads that know nothing about each other — and they used to
         * run as ten round trips, one after the next, inside a single response.
         * Each keeps its own catch, so an unhappy table now costs one fact
         * instead of every fact after it, which is what one big try/catch did. */
        const rows = async <T>(q: Promise<T[]>): Promise<T[]> => {
          try {
            return (await q) || []
          } catch {
            return []
          }
        }
        const [
          workoutRows,
          nutRows,
          goalRows,
          habitRowsE,
          spendRowsE,
          budgetRows,
          gratRows,
          moodRows,
          nightRows,
          loopRowsE,
        ] = await Promise.all([
          rows<{ n?: number }>(sql`
            SELECT count(*)::int AS n FROM hire_workouts
            WHERE user_id = ${user.id} AND (logged_at AT TIME ZONE ${tz})::date = ${todayYmd}
          `),
          rows<{ calories?: number; protein?: number; meals?: number }>(sql`
            SELECT coalesce(sum(calories), 0)::float AS calories, coalesce(sum(protein), 0)::float AS protein,
                   count(*)::int AS meals
            FROM hire_nutrition_logs
            WHERE user_id = ${user.id} AND (eaten_at AT TIME ZONE ${tz})::date = ${todayYmd}
          `),
          rows<{ calorieGoal?: number; proteinGoal?: number }>(sql`
            SELECT calorie_goal AS "calorieGoal", protein_goal AS "proteinGoal"
            FROM hire_nutrition_goals WHERE user_id = ${user.id}
          `),
          rows<{ id: string; name: string; emoji: string; done: boolean }>(sql`
            SELECT h.id, h.name, h.emoji,
                   EXISTS (SELECT 1 FROM hire_habit_logs l WHERE l.habit_id = h.id AND l.date = ${todayYmd}) AS done
            FROM hire_habits h WHERE h.user_id = ${user.id} ORDER BY h.created_at ASC
          `),
          rows<{ total?: number }>(sql`
            SELECT coalesce(sum(amount), 0)::float AS total FROM hire_spending
            WHERE user_id = ${user.id} AND (spent_at AT TIME ZONE ${tz})::date >= ${weekStartNight}
          `),
          rows<{ weeklyBudget?: number }>(sql`
            SELECT weekly_budget AS "weeklyBudget" FROM hire_spending_budget WHERE user_id = ${user.id}
          `),
          rows<{ n?: number }>(sql`
            SELECT count(*)::int AS n FROM hire_gratitude
            WHERE user_id = ${user.id} AND (created_at AT TIME ZONE ${tz})::date = ${todayYmd}
          `),
          rows<{ n?: number }>(sql`
            SELECT count(*)::int AS n FROM hire_moods
            WHERE user_id = ${user.id} AND (created_at AT TIME ZONE ${tz})::date = ${todayYmd}
          `),
          rows<{ bedtime?: string; wake?: string }>(sql`
            SELECT bedtime, wake FROM hire_sleep
            WHERE user_id = ${user.id} AND sleep_date IN (${todayYmd}, ${yesterdayYmd})
            ORDER BY sleep_date DESC LIMIT 1
          `),
          rows<{ id: string; title: string; dueAt: Date }>(sql`
            SELECT id, title, due_at AS "dueAt" FROM hire_loops
            WHERE user_id = ${user.id} AND persona = ${persona} AND status = 'open'
              AND due_at IS NOT NULL AND (due_at AT TIME ZONE ${tz})::date <= ${todayYmd}
            ORDER BY due_at ASC LIMIT 5
          `),
        ])

        const workoutsToday = Number(workoutRows[0]?.n) || 0
        dayFacts.push(
          workoutsToday > 0
            ? { key: 'workout', label: 'Lifted', detail: `${workoutsToday} move${workoutsToday === 1 ? '' : 's'} logged`, state: 'done' }
            : { key: 'workout', label: 'No lift', detail: 'Nothing logged today', state: 'miss' },
        )

        const nut = nutRows[0]
        const mealsLogged = Number(nut?.meals) || 0
        if (mealsLogged > 0) {
          const cal = Math.round(Number(nut?.calories) || 0)
          const protein = Math.round(Number(nut?.protein) || 0)
          const calGoal = Math.round(goalRows[0]?.calorieGoal || 2200)
          const proteinGoal = Math.round(goalRows[0]?.proteinGoal || 150)
          dayFacts.push({
            key: 'food',
            label: 'Food',
            detail: `${protein}g protein of ${proteinGoal}, ${cal} of ${calGoal} calories`,
            state: protein >= proteinGoal * 0.6 ? 'done' : 'partial',
          })
        }

        for (const h of habitRowsE) {
          habitsToday.push({ id: h.id, name: h.name, emoji: h.emoji, done: !!h.done })
        }
        const habitsDone = habitsToday.filter((h) => h.done).length
        if (habitsToday.length) {
          dayFacts.push({
            key: 'habits',
            label: 'Habits',
            detail: `${habitsDone} of ${habitsToday.length}`,
            state: habitsDone === habitsToday.length ? 'done' : habitsDone > 0 ? 'partial' : 'miss',
          })
        }

        const spendWeekN = Number(spendRowsE[0]?.total) || 0
        if (spendWeekN > 0) {
          const budgetN = Math.round(budgetRows[0]?.weeklyBudget || 400)
          dayFacts.push({
            key: 'spend',
            label: 'Spent this week',
            detail: `$${Math.round(spendWeekN)} of $${budgetN}`,
            state: spendWeekN <= budgetN ? 'done' : 'miss',
          })
        }

        {
          const n = Number(gratRows[0]?.n) || 0
          dayFacts.push(
            n > 0
              ? { key: 'gratitude', label: 'Gratitude', detail: 'Logged', state: 'done' }
              : { key: 'gratitude', label: 'Gratitude not logged', detail: '', state: 'miss' },
          )
        }
        {
          const n = Number(moodRows[0]?.n) || 0
          dayFacts.push(
            n > 0
              ? { key: 'mood', label: 'Mood', detail: 'Logged', state: 'done' }
              : { key: 'mood', label: 'Mood not logged', detail: '', state: 'miss' },
          )
        }

        const lastNightE = nightRows[0]
        const nightHoursE =
          lastNightE?.bedtime && lastNightE?.wake ? sleepHoursBetween(lastNightE.bedtime, lastNightE.wake) : 0

        const hasSignal =
          workoutsToday > 0 || mealsLogged > 0 || habitsToday.length > 0 || nightHoursE > 0 ||
          dayFacts.some((f) => f.state === 'done')
        if (hasSignal) {
          let points = 50
          points += workoutsToday > 0 ? 15 : -10
          if (mealsLogged > 0) {
            const f = dayFacts.find((x) => x.key === 'food')
            points += f?.state === 'done' ? 10 : -5
          }
          if (habitsToday.length) {
            const ratio = habitsDone / habitsToday.length
            points += Math.round(ratio * 20 - 10)
          }
          const sf = dayFacts.find((x) => x.key === 'spend')
          if (sf) points += sf.state === 'done' ? 5 : -10
          points += dayFacts.some((f) => f.key === 'gratitude' && f.state === 'done') ? 5 : 0
          points += dayFacts.some((f) => f.key === 'mood' && f.state === 'done') ? 5 : 0
          if (nightHoursE >= 7) points += 10
          else if (nightHoursE > 0 && nightHoursE < 6) points -= 10
          points = Math.max(0, Math.min(100, points))
          const verdict = points >= 75 ? 'strong' : points >= 60 ? 'solid' : points >= 45 ? 'decent' : points >= 30 ? 'rough' : 'wrecked'
          dayScore = { points, verdict }
        }

        for (const l of loopRowsE) {
          carryOver.push({
            id: l.id,
            title: l.title,
            dueLabel: formatCalTime(new Date(l.dueAt).toISOString(), tz),
          })
        }
      } catch {
        // Debrief facts are best effort; the calendar sections still ship.
      }
    })()

    await Promise.all([calJob, mailJob, factsJob])

    const todayEvents = allEvents.filter((e) => e.dayYmd === todayYmd)
    const tomorrowEvents = allEvents.filter((e) => e.dayYmd === tomorrowYmd && !e.allDay)

    // Hotel/travel all-day = where you are
    const locationEvents = todayEvents.filter((e) =>
      isHotelStayEvent({ title: e.title, allDay: e.allDay }),
    )
    // Past timed events today (recap)
    const pastEvents = todayEvents
      .filter((e) => !e.allDay && e.startMs < nowMs - 5 * 60_000)
      .sort((a, b) => a.startMs - b.startMs)
    // Remaining timed events today
    const remainingEvents = todayEvents
      .filter((e) => !e.allDay && e.startMs >= nowMs - 5 * 60_000)
      .sort((a, b) => a.startMs - b.startMs)

    const formatEvent = (e: EveningEvent) => `${e.time}  ${e.who || e.title}  ${e.meetKind}`

    const sections: Array<{ heading: string; items: string[]; emailMeta?: Array<{ id: string; snippet?: string }> }> = []

    if (locationEvents.length) {
      const locs = locationEvents.map((e) =>
        e.title
          .replace(/^(?:stay(?:ing)?|checked?\s*in)\s+at\s+/i, '')
          .replace(/^at\s+/i, '')
          .trim(),
      )
      sections.push({ heading: 'Where you are', items: locs })
    }

    if (pastEvents.length) {
      sections.push({ heading: 'Earlier today', items: pastEvents.map(formatEvent) })
    }

    if (remainingEvents.length) {
      sections.push({ heading: 'Left this evening', items: remainingEvents.map(formatEvent) })
    } else if (connected.includes('calendar')) {
      sections.push({ heading: 'Left this evening', items: ['Nothing left on the calendar.'] })
    } else {
      sections.push({ heading: 'Left this evening', items: ['Calendar is not connected. Tap Settings to add it.'] })
    }

    if (mailItems.length) {
      sections.push({
        heading: 'Mail since this morning',
        items: mailItems.map((m) => m.label),
        emailMeta: mailItems.map((m) => ({ id: m.id, snippet: m.snippet })),
      })
    } else {
      sections.push({ heading: 'Mail since this morning', items: ['No important mail'] })
    }

    if (tomorrowEvents.length) {
      sections.push({ heading: 'Tomorrow', items: tomorrowEvents.slice(0, 5).map(formatEvent) })
    } else if (connected.includes('calendar')) {
      sections.push({ heading: 'Tomorrow', items: ['Nothing on the calendar.'] })
    }

    return { kind, title: 'Evening brief', date: dateLabel, sections, text: '', dayScore, dayFacts, habitsToday, carryOver, mailGroups }
  }

  if (kind === 'standup_paste') {
    const results = await runToolsForMessage(sql, {
      userId: user.id,
      persona,
      message: 'calendar today standup github pull requests linear issues',
      connected,
      timezone: tz,
    })
    const calendarBlock = results.find((t) => isCalendarToolResult(t))
    const calItems = digestLines(calendarBlock)
      .map((l) => {
        const p = parseFormattedEventLine(l)
        if (!p) return l.replace(/^-\s*/, '')
        return p.clock ? `${p.clock} ${p.title}` : p.title
      })
      .slice(0, 4)
    const gh = results.find((t) => /^github/i.test(t) || t.startsWith('- ') && /pull|pr\b|merged/i.test(t))
    const lin = results.find((t) => /linear/i.test(t) || (t.startsWith('- ') && /\b[A-Z]{2,}-\d+/.test(t)))
    const ghLines = digestLines(gh).slice(0, 3).map((l) => l.replace(/^-\s*/, ''))
    const linLines = digestLines(lin).slice(0, 4).map((l) => l.replace(/^-\s*/, ''))
    const yesterday = ghLines[0] || 'Nothing merged that I can see. Do not invent work.'
    const today = calItems[0] || linLines[0] || 'Nothing on calendar. Name the one Linear issue.'
    const blocked = linLines.find((l) => /block/i.test(l)) || 'None named in Linear.'
    const paste = `Yesterday: ${yesterday}\nToday: ${today}\nBlocked: ${blocked}`
    const sections = [
      { heading: 'Paste this', items: [paste] },
      { heading: 'On the calendar', items: calItems.length ? calItems : ['Nothing on calendar.'] },
      { heading: 'GitHub', items: ghLines.length ? ghLines : ['Connect GitHub for merged PRs.'] },
      { heading: 'Linear', items: linLines.length ? linLines : ['Connect Linear for issues.'] },
    ]
    return { kind, title: 'Standup', date: dateLabel, sections, paste, text: paste }
  }

  if (kind === 'kill_keep_park') {
    const pipes = (await sql`
      SELECT id, title, company, stage, notes, updated_at AS "updatedAt"
      FROM hire_pipeline WHERE user_id = ${user.id}
      ORDER BY updated_at DESC LIMIT 20
    `) as Array<{ id: string; title: string; company: string; stage: string; notes: string; updatedAt: Date }>
    const live = pipes.filter((p) => p.stage !== 'won' && p.stage !== 'lost')
    const keepRow = live.find((p) => p.stage === 'offer' || p.stage === 'interview') || live[0]
    const killRow = live.find((p) => p.stage === 'lead' && p.id !== keepRow?.id)
    const parkRow = live.find((p) => p.id !== keepRow?.id && p.id !== killRow?.id)
    const keep = keepRow
      ? `${keepRow.title}${keepRow.company ? ` @ ${keepRow.company}` : ''} (${keepRow.stage})`
      : (context.weekly_focus || '').trim() || 'Nothing on pipeline. Add a deal first.'
    const kill = killRow
      ? `${killRow.title}${killRow.company ? ` @ ${killRow.company}` : ''} — stale ${killRow.stage}`
      : 'No stale lead to kill.'
    const park = parkRow
      ? `${parkRow.title} — park until ${keepRow ? keepRow.title : 'the keep'} moves`
      : 'Nothing to park.'
    const sections = [
      { heading: 'Keep', items: [keep] },
      { heading: 'Kill', items: [kill] },
      { heading: 'Park', items: [park] },
    ]
    const paste = `Keep: ${keep}\nKill: ${kill}\nPark: ${park}`
    return { kind, title: 'Kill · Keep · Park', date: dateLabel, sections, paste, text: paste, pipeline: {
      keepId: keepRow?.id, killId: killRow?.id, parkId: parkRow?.id,
    } }
  }

  return { kind, title: kind, date: dateLabel, sections: [], text: '' }
}

async function livePayload(sql: SQL, phone: string, persona: Persona) {
  const user = await getUserByPhone(sql, phone)
  if (!user) {
    return {
      found: false,
      hired: false,
      context: {} as Record<string, string>,
      connected: [] as string[],
      memories: [] as MemoryRow[],
      email: null as string | null,
      name: null as string | null,
      timezone: null as string | null,
      lastInboundAt: null as string | null,
    }
  }
  const roster = await loadRoster(sql, user.id)
  const hired = roster.includes(persona)
  const context = hired ? await loadContext(sql, user.id, persona) : {}
  const connected = hired
    ? (await connectedForUser(sql, user.id)).filter((id) => !PERSONA_DENIED[persona].has(id))
    : []
  const memories = hired ? await loadMemories(sql, user.id, persona, 12) : []
  const active = hired ? await pickActiveLocation(sql, user.id) : null
  let lastInboundAt: string | null = null
  if (hired) {
    const inbound = await sql`
      SELECT last_inbound_at AS "lastInboundAt" FROM hire_roster
      WHERE user_id = ${user.id} AND persona = ${persona} LIMIT 1
    `
    const at = (inbound[0] as { lastInboundAt: Date | null } | undefined)?.lastInboundAt
    lastInboundAt = at ? new Date(at).toISOString() : null
  }
  return {
    found: true,
    hired,
    context,
    connected,
    memories,
    email: user.email,
    name: user.name,
    timezone: user.timezone,
    userId: user.id,
    lastInboundAt,
    location: active
      ? { kind: active.kind, label: locationLabel(active), label_text: active.label }
      : null,
  }
}

function rfc822Raw(
  to: string,
  subject: string,
  body: string,
  extra?: { inReplyTo?: string },
) {
  const headers = [`To: ${to}`, `Subject: ${subject}`, 'MIME-Version: 1.0', 'Content-Type: text/plain; charset=utf-8']
  const replyTo = extra?.inReplyTo?.trim()
  if (replyTo) {
    headers.push(`In-Reply-To: ${replyTo}`, `References: ${replyTo}`)
  }
  const raw = [...headers, '', body].join('\r\n')
  return Buffer.from(raw).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

async function gmailSendMessage(
  sql: SQL,
  userId: string,
  draft: { to: string; subject: string; body: string; threadId?: string; inReplyTo?: string },
): Promise<{ ok: boolean; error?: string }> {
  const access = await googleAccessToken(sql, userId, 'gmail')
  if (access) {
    const payload: { raw: string; threadId?: string } = {
      raw: rfc822Raw(draft.to, draft.subject, draft.body, { inReplyTo: draft.inReplyTo }),
    }
    if (draft.threadId) payload.threadId = draft.threadId
    const res = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
      method: 'POST',
      headers: { Authorization: `Bearer ${access}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })
    if (res.ok) return { ok: true }
    const err = await res.text().catch(() => '')
    if (res.status !== 403 && res.status !== 401) {
      return { ok: false, error: `Gmail send failed (${res.status}). ${err.slice(0, 120)}` }
    }
  }
  const out = await composioFirst(
    userId,
    ['GMAIL_SEND_EMAIL', 'GMAIL_SEND_MESSAGE'],
    {
      to: draft.to,
      recipient_email: draft.to,
      subject: draft.subject,
      body: draft.body,
      message: draft.body,
      thread_id: draft.threadId,
      threadId: draft.threadId,
    },
  )
  // GMAIL_CREATE_EMAIL_DRAFT is deliberately not in that list: a draft-only
  // connection must never make a "send" silently create a draft and report
  // success — that is the complaint that sending does nothing.
  if (out && !/failed/i.test(out)) return { ok: true }
  return {
    ok: false,
    error: 'Could not send. Reconnect Gmail and allow send (not just draft), or Connect Gmail in Settings.',
  }
}

/** Push a reply into Gmail's Drafts folder. This never sends: Google accounts
 * go through drafts.create, Composio accounts through the dedicated draft
 * action, so "save draft" can never be mistaken for a send on either path. */
async function gmailCreateDraft(
  sql: SQL,
  userId: string,
  draft: { to: string; subject: string; body: string; threadId?: string },
): Promise<{ ok: boolean; error?: string }> {
  const access = await googleAccessToken(sql, userId, 'gmail')
  if (access) {
    const message: { raw: string; threadId?: string } = {
      raw: rfc822Raw(draft.to, draft.subject, draft.body),
    }
    if (draft.threadId) message.threadId = draft.threadId
    const res = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/drafts', {
      method: 'POST',
      headers: { Authorization: `Bearer ${access}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ message }),
    })
    if (res.ok) return { ok: true }
    const err = await res.text().catch(() => '')
    if (res.status === 403 || res.status === 401) {
      return { ok: false, error: 'Gmail needs the compose permission to save drafts. Reconnect Gmail in Settings.' }
    }
    return { ok: false, error: `Gmail draft save failed (${res.status}). ${err.slice(0, 120)}` }
  }
  const out = await composioFirst(userId, ['GMAIL_CREATE_EMAIL_DRAFT'], {
    to: draft.to,
    recipient_email: draft.to,
    subject: draft.subject,
    body: draft.body,
    message: draft.body,
    thread_id: draft.threadId,
    threadId: draft.threadId,
  })
  if (out && !/failed/i.test(out)) return { ok: true }
  return {
    ok: false,
    error: 'Could not save the draft to Gmail. Reconnect Gmail in Settings, or copy the text from here.',
  }
}

function calItemsToNextRows(items: CalItem[], prefix: string) {
  return items.map((e, i) => ({
    id: `${prefix}-${e.rawStart || e.start.toISOString()}-${i}`,
    title: e.title,
    start: e.allDay ? e.rawStart || e.start.toISOString().slice(0, 10) : e.rawStart || e.start.toISOString(),
    end: '',
    allDay: e.allDay,
  }))
}

async function googleEventsRaw(
  sql: SQL,
  userId: string,
  opts: { timeMin: Date; timeMax: Date; maxResults?: number },
): Promise<Array<{ id: string; title: string; start: string; end: string; allDay: boolean }>> {
  const access = await googleAccessToken(sql, userId, 'calendar')
  if (access) {
    const got = await fetchCalendarItems(access, opts)
    if (got.ok) return calItemsToNextRows(got.items, 'g')
  }
  const now = opts.timeMin
  const end = opts.timeMax
  const timeMin = now.toISOString()
  const timeMax = end.toISOString()
  const maxResults = opts.maxResults || 12
  const raw = await composioFirst(
    userId,
    ['GOOGLECALENDAR_EVENTS_LIST', 'GOOGLECALENDAR_FIND_EVENT'],
    {
      timeMin,
      timeMax,
      time_min: timeMin,
      time_max: timeMax,
      max_results: maxResults,
      maxResults,
      singleEvents: true,
      single_events: true,
      orderBy: 'startTime',
      calendarId: 'primary',
      calendar_id: 'primary',
    },
  )
  if (!raw || /failed/i.test(raw)) return []
  try {
    const parsed = JSON.parse(raw) as { __calItems?: Array<{ start: string; title: string; allDay?: boolean; kind?: string; rawStart?: string; description?: string }> }
    if (Array.isArray(parsed.__calItems)) return calItemsToNextRows(hydrateCalItems(parsed.__calItems), 'c')
    return calItemsToNextRows(parseComposioCalendarData(parsed), 'c')
  } catch {
    return []
  }
}

function parseGmailOverview(block: string) {
  return block
    .split('\n')
    .filter((l) => l.startsWith('- '))
    .slice(0, 2)
    .map((line, i) => {
      const parts = line.replace(/^-\s*/, '').split(' | ')
      const from = (parts[0] || '').replace(/<[^>]+>/g, '').trim()
      const subject = (parts[2] || parts[1] || '(no subject)').trim()
      return { id: `mail-${i}-${subject.slice(0, 40)}`, from, subject }
    })
    .filter((m) => (m.subject && m.subject !== '(no subject)') || m.from)
}

function localHourParts(iso: string, timezone: string) {
  const d = new Date(iso)
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    weekday: 'short',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  }).formatToParts(d)
  const get = (t: string) => parts.find((p) => p.type === t)?.value || ''
  return `${get('weekday')} ${get('hour')}:${get('minute')} ${get('dayPeriod')}`
}

async function findFreeSlots(
  sql: SQL,
  userId: string,
  timezone: string,
): Promise<Array<{ start: string; end: string; label: string }>> {
  const access = await googleAccessToken(sql, userId, 'calendar')
  if (!access) return []
  const now = new Date()
  const end = new Date(now.getTime() + 5 * 24 * 60 * 60 * 1000)
  const res = await fetch('https://www.googleapis.com/calendar/v3/freeBusy', {
    method: 'POST',
    headers: { Authorization: `Bearer ${access}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      timeMin: now.toISOString(),
      timeMax: end.toISOString(),
      items: [{ id: 'primary' }],
    }),
  })
  if (!res.ok) return []
  const data = (await res.json()) as {
    calendars?: { primary?: { busy?: Array<{ start: string; end: string }> } }
  }
  const busy = (data.calendars?.primary?.busy || []).map((b) => ({
    start: new Date(b.start).getTime(),
    end: new Date(b.end).getTime(),
  }))
  const slots: Array<{ start: string; end: string; label: string }> = []
  const cursor = new Date(now)
  cursor.setMinutes(cursor.getMinutes() < 30 ? 30 : 60, 0, 0)
  while (slots.length < 3 && cursor.getTime() < end.getTime()) {
    const hour = Number(
      new Intl.DateTimeFormat('en-US', { timeZone: timezone, hour: 'numeric', hour12: false }).format(cursor),
    )
    const startMs = cursor.getTime()
    const endMs = startMs + 30 * 60 * 1000
    const overlap = busy.some((b) => startMs < b.end && endMs > b.start)
    if (hour >= 9 && hour < 17 && !overlap) {
      const startIso = new Date(startMs).toISOString()
      const endIso = new Date(endMs).toISOString()
      slots.push({ start: startIso, end: endIso, label: localHourParts(startIso, timezone) })
    }
    cursor.setMinutes(cursor.getMinutes() + 30)
  }
  return slots
}

async function calendarHold(
  sql: SQL,
  userId: string,
  input: { title: string; start: string; end: string },
): Promise<{ ok: boolean; error?: string; eventId?: string }> {
  const access = await googleAccessToken(sql, userId, 'calendar')
  if (!access) {
    const out = await composioFirst(
      userId,
      ['GOOGLECALENDAR_CREATE_EVENT', 'GOOGLECALENDAR_EVENTS_INSERT'],
      {
        summary: input.title,
        start_datetime: input.start,
        end_datetime: input.end,
        start: { dateTime: input.start },
        end: { dateTime: input.end },
      },
    )
    if (out && !/failed/i.test(out)) return { ok: true }
    return { ok: false, error: 'Calendar is not connected.' }
  }
  const res = await fetch('https://www.googleapis.com/calendar/v3/calendars/primary/events', {
    method: 'POST',
    headers: { Authorization: `Bearer ${access}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      summary: input.title,
      start: { dateTime: input.start },
      end: { dateTime: input.end },
      status: 'tentative',
    }),
  })
  if (!res.ok) return { ok: false, error: `Calendar hold failed (${res.status}).` }
  const data = (await res.json()) as { id?: string }
  return { ok: true, eventId: data.id }
}

function walkLinearIssues(data: unknown, out: Array<{ id: string; identifier: string; title: string; state?: string; team?: string }> = []) {
  if (out.length >= 12 || data == null) return out
  if (Array.isArray(data)) {
    for (const item of data) walkLinearIssues(item, out)
    return out
  }
  if (typeof data !== 'object') return out
  const o = data as Record<string, unknown>
  const id = String(o.id || o.issueId || o.issue_id || '')
  const title = String(o.title || o.name || '')
  const identifier = String(o.identifier || o.number || o.key || '')
  if (id && title) {
    const state = typeof o.state === 'object' && o.state
      ? String((o.state as { name?: string }).name || '')
      : String(o.state || o.status || '')
    const team = typeof o.team === 'object' && o.team
      ? String((o.team as { name?: string }).name || '')
      : String(o.team || '')
    if (!out.some((x) => x.id === id)) out.push({ id, identifier: identifier || title.slice(0, 8), title, state, team })
    return out
  }
  for (const v of Object.values(o)) walkLinearIssues(v, out)
  return out
}

async function listLinearIssues(userId: string) {
  const composio = composioClient()
  if (!composio) return { issues: [] as ReturnType<typeof walkLinearIssues>, needConnect: true }
  for (const slug of ['LINEAR_LIST_ISSUES', 'LINEAR_LIST_LINEAR_ISSUES', 'LINEAR_GET_ISSUES']) {
    try {
      const res = await composio.tools.execute(slug, {
        userId,
        arguments: { limit: 12 },
        dangerouslySkipVersionCheck: true,
      })
      if (!res?.successful) continue
      const issues = walkLinearIssues(res.data)
      if (issues.length) return { issues, needConnect: false }
    } catch {
      /* try next slug */
    }
  }
  return { issues: [] as ReturnType<typeof walkLinearIssues>, needConnect: false }
}

async function linearWrite(userId: string, id: string, action: 'done' | 'later' | 'cancel') {
  const state = action === 'done' ? 'Done' : action === 'cancel' ? 'Canceled' : 'Backlog'
  const out = await composioFirst(
    userId,
    ['LINEAR_UPDATE_ISSUE', 'LINEAR_UPDATE_ISSUE_STATUS', 'LINEAR_MARK_ISSUE_AS_DONE'],
    { id, issueId: id, issue_id: id, state, status: state },
  )
  return !!(out && !/failed/i.test(out))
}

/** Automated senders never get drafts — replying to a no-reply bot is the
 * single most embarrassing thing the work home ever did. */
const AUTOMATED_SENDER =
  /no[-_.]?reply|donotreply|do[_-]?not[_-]?reply|not[-_]?reply|notifications?@|newsletter|mailer-daemon|postmaster|auto[-_.]?(?:reply|confirm|respond|generated)|alerts?@|noreply|bounce|daemon@|feedback@/i

export function isAutomatedSender(addr: string): boolean {
  return AUTOMATED_SENDER.test(String(addr || '').toLowerCase())
}

/** Subjects that are machine notifications, not conversations. */
const AUTOMATED_SUBJECT =
  /^(?:unread message|reminder to|assessment|your (?:receipt|assessment|application|results))|(?:submitted for|testing for|complete .{0,24} for LLM|action required|verify your|confirm your)/i

export function isAutomatedSubject(subject: string): boolean {
  return AUTOMATED_SUBJECT.test(String(subject || '').trim())
}

async function suggestedMailDrafts(sql: SQL, userId: string) {
  const access = await googleAccessToken(sql, userId, 'gmail')
  if (!access) return [] as Array<{ toAddr: string; subject: string; body: string }>
  const listUrl = new URL('https://gmail.googleapis.com/gmail/v1/users/me/messages')
  listUrl.searchParams.set('maxResults', '5')
  listUrl.searchParams.set('q', 'is:unread newer_than:5d')
  const list = await fetch(listUrl, { headers: { Authorization: `Bearer ${access}` } })
  if (!list.ok) return []
  const data = (await list.json()) as { messages?: Array<{ id: string }> }
  const out: Array<{ toAddr: string; subject: string; body: string }> = []
  for (const m of (data.messages || []).slice(0, 3)) {
    const got = await fetch(
      `https://gmail.googleapis.com/gmail/v1/users/me/messages/${m.id}?format=metadata&metadataHeaders=Subject&metadataHeaders=From`,
      { headers: { Authorization: `Bearer ${access}` } },
    )
    if (!got.ok) continue
    const msg = (await got.json()) as {
      snippet?: string
      payload?: { headers?: Array<{ name: string; value: string }> }
    }
    const h = (n: string) => msg.payload?.headers?.find((x) => x.name.toLowerCase() === n.toLowerCase())?.value || ''
    const from = h('From')
    const email = from.match(/<([^>]+)>/)?.[1] || from
    const subject = h('Subject') || '(no subject)'
    if (!email) continue
    // Never suggest a reply to a machine, or to a machine-shaped subject —
    // "Re: Assessment submitted" addressed to do-not-reply@ was the junk that
    // filled the work home.
    if (isAutomatedSender(email) || isAutomatedSubject(subject)) continue
    out.push({
      toAddr: email,
      subject: subject.startsWith('Re:') ? subject : `Re: ${subject}`,
      body: '',
    })
  }
  return out
}

async function investorNoteBody(sql: SQL, userId: string) {
  const pipes = (await sql`
    SELECT title, company, stage FROM hire_pipeline WHERE user_id = ${userId}
    ORDER BY updated_at DESC LIMIT 8
  `) as Array<{ title: string; company: string; stage: string }>
  const decisions = (await sql`
    SELECT decision, reason FROM hire_decisions WHERE user_id = ${userId}
    ORDER BY created_at DESC LIMIT 5
  `) as Array<{ decision: string; reason: string }>
  const spend = await sql`
    SELECT coalesce(sum(amount), 0)::float AS n FROM hire_spending
    WHERE user_id = ${userId} AND spent_at >= date_trunc('week', now())
  `
  const weekSpend = Number((spend[0] as { n?: number } | undefined)?.n || 0)
  // Month over month: stage counts today vs the last touch before the 30 day
  // mark. Rows untouched since then are the state the investor last saw.
  const stageNow = (await sql`
    SELECT stage, count(*)::int AS n FROM hire_pipeline WHERE user_id = ${userId} GROUP BY stage
  `) as Array<{ stage: string; n: number }>
  const stageThen = (await sql`
    SELECT stage, count(*)::int AS n FROM hire_pipeline
    WHERE user_id = ${userId} AND updated_at < now() - interval '30 days'
    GROUP BY stage
  `) as Array<{ stage: string; n: number }>
  const runwayRows = (await sql`
    SELECT cash, burn, months FROM hire_runway_snapshots
    WHERE user_id = ${userId} ORDER BY taken_on DESC LIMIT 1
  `) as Array<{ cash: number; burn: number; months: number }>
  const openDecisionRows = await sql`
    SELECT count(*)::int AS n FROM hire_decisions WHERE user_id = ${userId} AND status = 'open'
  `
  const openDecisions = Number((openDecisionRows[0] as { n?: number } | undefined)?.n || 0)
  const live = pipes.filter((p) => p.stage !== 'lost')
  const tally = (rows: Array<{ stage: string; n: number }>) => {
    const out: Record<string, number> = {}
    for (const r of rows) out[r.stage] = Number(r.n)
    return out
  }
  const nowTally = tally(stageNow)
  const thenTally = tally(stageThen)
  const deltas = PIPELINE_STAGES
    .map((s) => ({ stage: s, d: (nowTally[s] || 0) - (thenTally[s] || 0) }))
    .filter((x) => x.d !== 0)
    .map((x) => `${x.stage} ${x.d > 0 ? `+${x.d}` : x.d}`)
  const runway = runwayRows[0]
  const money = (n: number) => `$${Math.round(Number(n) || 0).toLocaleString('en-US')}`
  const lines = [
    'Update',
    '',
    live.length ? `Pipeline: ${live.map((p) => `${p.title}${p.company ? ` @ ${p.company}` : ''} (${p.stage})`).join('; ')}` : 'Pipeline: quiet this week.',
    deltas.length ? `Month over month: ${deltas.join(', ')}.` : '',
    runway ? `Runway: ${Number(runway.months).toFixed(1)} months on ${money(runway.cash)} cash, ${money(runway.burn)} monthly burn.` : '',
    `Spend this week: $${Math.round(weekSpend)}.`,
    `Open decisions: ${openDecisions}.`,
    decisions[0] ? `Call: ${decisions[0].decision}${decisions[0].reason ? ` because ${decisions[0].reason}` : ''}.` : '',
    '',
    'Ask:',
    '  What I need from you:',
    '  One intro worth making:',
  ]
  return lines.filter(Boolean).join('\n')
}

/** Cofounder capture kinds. Each maps chat noise to one existing table. */
export type CofounderCaptureKind = 'decision' | 'promise' | 'person' | 'opportunity'

const COFOUNDER_KINDS: CofounderCaptureKind[] = ['decision', 'promise', 'person', 'opportunity']

function cofounderWhen(v: unknown): Date | null {
  if (!v) return null
  const d = v instanceof Date ? v : new Date(String(v))
  return Number.isNaN(d.getTime()) ? null : d
}

/** Capture one item the cofounder overheard in chat. Idempotent per user and
 * text inside 24 hours: a bot that retries or a story told twice updates the
 * row instead of cloning it. People and opportunities upsert by name, so a
 * second mention refreshes the row it already owns. */
export async function captureCofounderItem(
  sql: SQL,
  userId: string,
  persona: string,
  kind: CofounderCaptureKind,
  fields: Record<string, unknown>,
): Promise<{ created: boolean; id: string }> {
  const personaSafe = isPersona(persona) ? persona : 'cofounder'
  const raw = String(fields.raw || '').trim().slice(0, 500)

  if (kind === 'decision') {
    const decision = String(fields.decision || '').trim().slice(0, 300)
    if (!decision) throw new Error('decision required')
    const reason = String(fields.reason || '').trim().slice(0, 500) || raw
    const reviewAt = cofounderWhen(fields.reviewAt)
    const recent = (await sql`
      SELECT id FROM hire_decisions
      WHERE user_id = ${userId} AND lower(decision) = lower(${decision})
        AND created_at >= now() - interval '24 hours'
      ORDER BY created_at DESC LIMIT 1
    `) as Array<{ id: string }>
    if (recent[0]) {
      await sql`
        UPDATE hire_decisions SET reason = ${reason},
          review_at = COALESCE(${reviewAt}, review_at), updated_at = now()
        WHERE id = ${recent[0].id}
      `
      return { created: false, id: recent[0].id }
    }
    const id = crypto.randomUUID()
    await sql`
      INSERT INTO hire_decisions (id, user_id, persona, decision, reason, evidence, review_at)
      VALUES (${id}, ${userId}, ${personaSafe}, ${decision}, ${reason}, ${reason ? 'overheard in chat' : ''}, ${reviewAt})
    `
    return { created: true, id }
  }

  if (kind === 'promise') {
    const title = String(fields.title || '').trim().slice(0, 200)
    if (!title) throw new Error('title required')
    const dueAt = cofounderWhen(fields.dueAt)
    const recent = (await sql`
      SELECT id FROM hire_loops
      WHERE user_id = ${userId} AND lower(title) = lower(${title})
        AND created_at >= now() - interval '24 hours'
      ORDER BY created_at DESC LIMIT 1
    `) as Array<{ id: string }>
    if (recent[0]) {
      await sql`
        UPDATE hire_loops SET context = COALESCE(nullif(${raw}, ''), context),
          due_at = COALESCE(${dueAt}, due_at), updated_at = now()
        WHERE id = ${recent[0].id}
      `
      return { created: false, id: recent[0].id }
    }
    const id = crypto.randomUUID()
    await sql`
      INSERT INTO hire_loops (id, user_id, persona, title, context, due_at, status)
      VALUES (${id}, ${userId}, ${personaSafe}, ${title}, ${raw}, ${dueAt}, 'open')
    `
    return { created: true, id }
  }

  if (kind === 'person') {
    const name = String(fields.name || '').trim().slice(0, 120)
    if (!name) throw new Error('name required')
    const relKind = String(fields.kind || 'other').trim().slice(0, 40) || 'other'
    const notes = String(fields.notes || '').trim().slice(0, 500) || raw
    const existing = (await sql`
      SELECT id FROM hire_relationships
      WHERE user_id = ${userId} AND lower(name) = lower(${name})
      ORDER BY created_at LIMIT 1
    `) as Array<{ id: string }>
    if (existing[0]) {
      // A fresh mention is a touch: the cadence clock restarts.
      await sql`
        UPDATE hire_relationships SET kind = ${relKind},
          notes = COALESCE(nullif(${notes}, ''), notes),
          last_touch_at = now(), updated_at = now()
        WHERE id = ${existing[0].id}
      `
      return { created: false, id: existing[0].id }
    }
    const id = crypto.randomUUID()
    await sql`
      INSERT INTO hire_relationships (id, user_id, name, kind, notes, last_touch_at)
      VALUES (${id}, ${userId}, ${name}, ${relKind}, ${notes}, now())
    `
    return { created: true, id }
  }

  if (kind === 'opportunity') {
    const title = String(fields.title || '').trim().slice(0, 120)
    if (!title) throw new Error('title required')
    const company = String(fields.company || '').trim().slice(0, 80)
    const stage = PIPELINE_STAGES.includes(String(fields.stage) as (typeof PIPELINE_STAGES)[number])
      ? String(fields.stage)
      : 'lead'
    const value = Math.max(0, clampNum(fields.value))
    const oppKind = ['deal', 'job', 'fundraising', 'lead'].includes(String(fields.kind || ''))
      ? String(fields.kind)
      : 'deal'
    const notes = raw
    const existing = (await sql`
      SELECT id FROM hire_pipeline
      WHERE user_id = ${userId} AND lower(title) = lower(${title}) AND lower(company) = lower(${company})
      ORDER BY created_at LIMIT 1
    `) as Array<{ id: string }>
    if (existing[0]) {
      await sql`
        UPDATE hire_pipeline SET stage = ${stage}, kind = ${oppKind},
          value = CASE WHEN ${value} > 0 THEN ${value} ELSE value END,
          notes = COALESCE(nullif(${notes}, ''), notes), updated_at = now()
        WHERE id = ${existing[0].id}
      `
      return { created: false, id: existing[0].id }
    }
    const id = crypto.randomUUID()
    await sql`
      INSERT INTO hire_pipeline (id, user_id, title, company, stage, notes, value, kind)
      VALUES (${id}, ${userId}, ${title}, ${company}, ${stage}, ${notes}, ${value}, ${oppKind})
    `
    return { created: true, id }
  }

  throw new Error(`unknown capture kind: use ${COFOUNDER_KINDS.join(', ')}`)
}

/** The cofounder morning brief: everything already in the tables that needs a
 * human eye this week. Empty sections are fine; silence means healthy. */
export type CofounderDigestPayload = {
  stalePipeline: Array<{ id: string; title: string; stage: string; daysSinceTouch: number }>
  duePromises: Array<{ id: string; title: string; dueAt: Date | null }>
  decisionsToRevisit: Array<{ id: string; decision: string; reviewAt: Date | null }>
  newPeople: Array<{ id: string; name: string; lastTouchAt: Date | null }>
  pipelineMoves: Record<string, number>
  noteReady: boolean
}

export async function cofounderDigest(
  sql: SQL,
  userId: string,
  persona: string = 'cofounder',
): Promise<CofounderDigestPayload> {
  const stale = (await sql`
    SELECT id, title, stage, updated_at AS "updatedAt" FROM hire_pipeline
    WHERE user_id = ${userId} AND updated_at < now() - interval '10 days'
      AND stage NOT IN ('won', 'lost')
    ORDER BY updated_at ASC LIMIT 20
  `) as Array<{ id: string; title: string; stage: string; updatedAt: Date | string }>
  const promises = (await sql`
    SELECT id, title, due_at AS "dueAt" FROM hire_loops
    WHERE user_id = ${userId} AND status = 'open' AND due_at IS NOT NULL
      AND due_at <= now() + interval '72 hours'
    ORDER BY due_at ASC LIMIT 20
  `) as Array<{ id: string; title: string; dueAt: Date | string | null }>
  const revisits = (await sql`
    SELECT id, decision, review_at AS "reviewAt" FROM hire_decisions
    WHERE user_id = ${userId} AND status = 'open'
      AND review_at IS NOT NULL AND review_at <= now()
    ORDER BY review_at ASC LIMIT 20
  `) as Array<{ id: string; decision: string; reviewAt: Date | string | null }>
  const people = (await sql`
    SELECT id, name, last_touch_at AS "lastTouchAt" FROM hire_relationships
    WHERE user_id = ${userId}
      AND (last_touch_at IS NULL OR last_touch_at < now() - make_interval(days => cadence_days))
    ORDER BY last_touch_at ASC NULLS FIRST LIMIT 20
  `) as Array<{ id: string; name: string; lastTouchAt: Date | string | null }>
  const moves = (await sql`
    SELECT stage, count(*)::int AS n FROM hire_pipeline
    WHERE user_id = ${userId} AND updated_at >= now() - interval '7 days'
    GROUP BY stage
  `) as Array<{ stage: string; n: number }>
  const drafts = (await sql`
    SELECT count(*)::int AS n FROM hire_drafts
    WHERE user_id = ${userId} AND kind = 'investor' AND created_at >= date_trunc('month', now())
  `) as Array<{ n: number }>
  const asTime = (v: Date | string | null | undefined) => (v ? new Date(v as Date | string).getTime() : NaN)
  return {
    stalePipeline: stale.map((r) => ({
      id: r.id,
      title: r.title,
      stage: r.stage,
      daysSinceTouch: Math.max(0, Math.floor((Date.now() - asTime(r.updatedAt)) / 86_400_000)),
    })),
    duePromises: promises.map((r) => ({ id: r.id, title: r.title, dueAt: r.dueAt ? new Date(r.dueAt) : null })),
    decisionsToRevisit: revisits.map((r) => ({ id: r.id, decision: r.decision, reviewAt: r.reviewAt ? new Date(r.reviewAt) : null })),
    newPeople: people.map((r) => ({ id: r.id, name: r.name, lastTouchAt: r.lastTouchAt ? new Date(r.lastTouchAt) : null })),
    pipelineMoves: Object.fromEntries(moves.map((r) => [r.stage, Number(r.n)])),
    noteReady: Number(drafts[0]?.n || 0) === 0,
  }
}

/* ---- Coworker tools: meeting prep, auto standup, slots, linear triage ---- */

/** One calendar event that could be a meeting. Attendees stay null when the
 * source cannot say who is on the invite, so the picker does not drop it. */
export type PrepCandidate = {
  id: string
  title: string
  start: Date
  attendees: string[] | null
}

/** Google first so attendee lists survive; Composio calendars keep every event
 * because their payloads hide attendees. */
async function loadPrepCandidates(
  sql: SQL,
  userId: string,
  timeMin: Date,
  timeMax: Date,
): Promise<PrepCandidate[]> {
  const access = await googleAccessToken(sql, userId, 'calendar')
  if (access) {
    const url = new URL('https://www.googleapis.com/calendar/v3/calendars/primary/events')
    url.searchParams.set('timeMin', timeMin.toISOString())
    url.searchParams.set('timeMax', timeMax.toISOString())
    url.searchParams.set('singleEvents', 'true')
    url.searchParams.set('orderBy', 'startTime')
    url.searchParams.set('maxResults', '25')
    try {
      const res = await fetch(url, { headers: { Authorization: `Bearer ${access}` } })
      if (res.ok) {
        const data = (await res.json()) as {
          items?: Array<{
            id?: string
            summary?: string
            start?: { dateTime?: string; date?: string }
            attendees?: Array<{ email?: string }>
          }>
        }
        return (data.items || [])
          .map((it) => {
            const start = it.start?.dateTime
              ? new Date(it.start.dateTime)
              : it.start?.date
                ? new Date(`${it.start.date}T12:00:00Z`)
                : null
            if (!start || Number.isNaN(start.getTime())) return null
            return {
              id: it.id || crypto.randomUUID(),
              title: it.summary || '(untitled)',
              start,
              attendees: (it.attendees || [])
                .map((a) => String(a.email || '').toLowerCase())
                .filter(Boolean),
            }
          })
          .filter((e): e is PrepCandidate => !!e)
      }
    } catch (err) {
      console.warn('[meeting/prep] google list failed', err)
    }
  }
  const rows = await googleEventsRaw(sql, userId, { timeMin, timeMax, maxResults: 25 })
  return rows
    .filter((r) => !r.allDay)
    .map((r) => ({ id: r.id, title: r.title, start: new Date(r.start), attendees: null }))
    .filter((e) => Number.isFinite(e.start.getTime()))
}

/** Next event today that counts as a meeting: either someone else is on the
 * invite or the source could not tell us. */
export function nextSharedMeeting(
  events: PrepCandidate[],
  now: number = Date.now(),
  dayEnd: number = Infinity,
): PrepCandidate | null {
  const upcoming = events
    .filter((e) => Number.isFinite(e.start.getTime()))
    .filter((e) => e.start.getTime() >= now - 10 * 60_000)
    .filter((e) => e.start.getTime() < dayEnd)
    .filter((e) => e.attendees === null || e.attendees.length >= 1)
    .sort((a, b) => a.start.getTime() - b.start.getTime())
  return upcoming[0] ?? null
}

export type PrepThread = { subject: string; snippet: string; gmailId: string }

export type PrepBrief = {
  event: { id: string; title: string; startsInMin: number; attendees?: string[] } | null
  prep: { lastThread?: PrepThread; agenda: string[]; notes: string[] }
}

/** Deterministic skeleton: what the meeting is, who is on it, what to decide. */
export function buildPrepBrief(
  event: PrepCandidate,
  lastThread: PrepThread | null,
  now: number = Date.now(),
): PrepBrief {
  const startsInMin = Math.max(0, Math.round((event.start.getTime() - now) / 60_000))
  const who = (event.attendees || [])
    .map((a) => a.split('@')[0].replace(/[._]+/g, ' ').trim())
    .filter(Boolean)
  const first = who[0] ? who[0].replace(/\b\w/g, (c) => c.toUpperCase()) : 'them'
  const out: PrepBrief = {
    event: {
      id: event.id,
      title: event.title,
      startsInMin,
      ...(event.attendees && event.attendees.length ? { attendees: event.attendees } : {}),
    },
    prep: {
      agenda: [`Why: ${event.title}`, `Where ${first} stands`, 'Decisions to leave with'],
      notes: [
        startsInMin > 0 ? `Starts in ${startsInMin} min` : 'Starting now',
        who.length ? `With ${who.slice(0, 3).join(', ')}` : 'Attendee list unavailable',
      ],
    },
  }
  if (lastThread) out.prep.lastThread = lastThread
  return out
}

/** Most recent mail from the other side, so the prep can quote their last ask. */
async function findLastThread(
  sql: SQL,
  userId: string,
  attendees: string[] | null,
): Promise<PrepThread | null> {
  const primary = (attendees || [])[0] || ''
  if (!primary) return null
  const domain = primary.includes('@') ? primary.split('@')[1] : ''
  const term = domain || primary.split('@')[0]
  if (!term) return null
  const rows = await loadGmailRich(sql, userId, `from:${term} newer_than:90d`, 1).catch(() => [])
  const m = rows[0]
  if (!m) return null
  return {
    subject: m.subject || '(no subject)',
    snippet: cleanMailSnippet(m.snippet || '').slice(0, 200),
    gmailId: m.id,
  }
}

export async function buildMeetingPrep(
  sql: SQL,
  user: { id: string; timezone: string | null },
): Promise<PrepBrief> {
  const tz = pickUserTimezone({ userTz: user.timezone })
  const now = new Date()
  const dayEnd = startOfLocalDay(tz, 1)
  const events = await loadPrepCandidates(sql, user.id, now, dayEnd).catch(() => [])
  const meeting = nextSharedMeeting(events, now.getTime(), dayEnd.getTime())
  if (!meeting) return { event: null, prep: { agenda: [], notes: [] } }
  const lastThread = await findLastThread(sql, user.id, meeting.attendees)
  return buildPrepBrief(meeting, lastThread, now.getTime())
}

export type StandupFacts = {
  day: string
  meetings: string[]
  closedPromises: string[]
  draftsSent: string[]
  decisions: string[]
  blocked: string[]
}

/** Fixed sections: what closed since the last one, what is on today, what is
 * stuck. Empty day says so instead of printing bare headers. */
export function assembleStandupText(f: StandupFacts): string {
  const lines: string[] = [`Standup ${f.day}`]
  const done = [
    ...f.closedPromises.map((t) => `Closed: ${t}`),
    ...f.draftsSent.map((d) => `Sent: ${d}`),
  ]
  if (done.length) lines.push('Yesterday:', ...done.map((t) => `- ${t}`))
  const today = [
    ...f.meetings.map((m) => `Meeting: ${m}`),
    ...f.decisions.map((d) => `Decision: ${d}`),
  ]
  if (today.length) lines.push('Today:', ...today.map((t) => `- ${t}`))
  if (f.blocked.length) lines.push('Blocked:', ...f.blocked.map((t) => `- ${t}`))
  if (!done.length && !today.length && !f.blocked.length) lines.push('Quiet day. Nothing logged.')
  return lines.join('\n')
}

/** Standup from real rows only: calendar, loops closed today, drafts sent
 * today, decisions logged today. Blocked means a promise due today still open. */
export async function assembleAutoStandup(
  sql: SQL,
  user: { id: string; timezone: string | null },
): Promise<{ text: string; day: string }> {
  const tz = pickUserTimezone({ userTz: user.timezone })
  const day = localDateStrInTz(new Date(), tz)
  const win = todayWindowUtc(tz)
  const events = await loadPrepCandidates(sql, user.id, win.start, win.end).catch(() => [])
  const closed = (await sql`
    SELECT title FROM hire_loops
    WHERE user_id = ${user.id} AND status = 'done'
      AND updated_at >= ${win.start} AND updated_at < ${win.end}
    ORDER BY updated_at LIMIT 10
  `) as Array<{ title: string }>
  const drafts = (await sql`
    SELECT subject FROM hire_drafts
    WHERE user_id = ${user.id} AND status = 'sent'
      AND created_at >= ${win.start} AND created_at < ${win.end}
    ORDER BY created_at LIMIT 10
  `) as Array<{ subject: string }>
  const decisions = (await sql`
    SELECT decision FROM hire_decisions
    WHERE user_id = ${user.id} AND created_at >= ${win.start} AND created_at < ${win.end}
    ORDER BY created_at LIMIT 10
  `) as Array<{ decision: string }>
  const blocked = (await sql`
    SELECT title FROM hire_loops
    WHERE user_id = ${user.id} AND status = 'open'
      AND due_at >= ${win.start} AND due_at < ${win.end}
    ORDER BY due_at LIMIT 10
  `) as Array<{ title: string }>
  const text = assembleStandupText({
    day,
    meetings: events.map((e) => e.title).filter(Boolean).slice(0, 6),
    closedPromises: closed.map((r) => r.title),
    draftsSent: drafts.map((r) => r.subject || 'a draft'),
    decisions: decisions.map((r) => r.decision),
    blocked: blocked.map((r) => r.title),
  })
  await sql`
    INSERT INTO hire_standups (id, user_id, day, notes)
    VALUES (${crypto.randomUUID()}, ${user.id}, ${day}, ${text})
    ON CONFLICT (user_id, day) DO UPDATE SET notes = excluded.notes, created_at = now()
  `
  return { text, day }
}

/** Free gaps as labels, 30 min steps inside work hours, soonest first. */
export function formatSlotLabel(d: Date, timezone: string): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(d)
  const get = (t: string) => parts.find((p) => p.type === t)?.value || ''
  return `${get('weekday')} ${get('hour')}:${get('minute')}`
}

export function suggestSlotsFromBusy(
  busy: Array<{ start: number; end: number }>,
  opts: {
    now?: number
    windowDays?: number
    durationMin?: number
    timezone?: string
    workStartHour?: number
    workEndHour?: number
  } = {},
): string[] {
  const tz = opts.timezone || 'America/Los_Angeles'
  const now = opts.now ?? Date.now()
  const windowDays = Math.min(7, Math.max(1, Math.round(opts.windowDays || 3)))
  const durationMin = Math.min(240, Math.max(15, Math.round(opts.durationMin || 30)))
  const workStart = opts.workStartHour ?? 9
  const workEnd = opts.workEndHour ?? 18
  const firstYmd = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(now))
  const slots: string[] = []
  for (let d = 0; d < windowDays && slots.length < 3; d++) {
    const ymd = shiftDateStr(firstYmd, d)
    for (let minute = workStart * 60; minute + durationMin <= workEnd * 60 && slots.length < 3; minute += 30) {
      const start = wallTimeToUtc(ymd, Math.floor(minute / 60), minute % 60, tz).getTime()
      if (start < now) continue
      const end = start + durationMin * 60_000
      if (busy.some((b) => start < b.end && end > b.start)) continue
      slots.push(formatSlotLabel(new Date(start), tz))
    }
  }
  return slots
}

/** freeBusy when Google is wired, event times otherwise. */
async function loadBusyBlocks(
  sql: SQL,
  userId: string,
  timeMin: Date,
  timeMax: Date,
): Promise<Array<{ start: number; end: number }>> {
  const access = await googleAccessToken(sql, userId, 'calendar')
  if (access) {
    try {
      const res = await fetch('https://www.googleapis.com/calendar/v3/freeBusy', {
        method: 'POST',
        headers: { Authorization: `Bearer ${access}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ timeMin: timeMin.toISOString(), timeMax: timeMax.toISOString(), items: [{ id: 'primary' }] }),
      })
      if (res.ok) {
        const data = (await res.json()) as { calendars?: { primary?: { busy?: Array<{ start: string; end: string }> } } }
        const blocks = (data.calendars?.primary?.busy || [])
          .map((b) => ({ start: new Date(b.start).getTime(), end: new Date(b.end).getTime() }))
          .filter((b) => Number.isFinite(b.start) && Number.isFinite(b.end) && b.end > b.start)
        if (blocks.length) return blocks
      }
    } catch (err) {
      console.warn('[slots] freeBusy failed', err)
    }
  }
  const rows = await googleEventsRaw(sql, userId, { timeMin, timeMax, maxResults: 50 })
  return rows
    .filter((r) => !r.allDay)
    .map((r) => ({
      start: Date.parse(r.start),
      end: r.end ? Date.parse(r.end) : Date.parse(r.start) + 3_600_000,
    }))
    .filter((b) => Number.isFinite(b.start) && Number.isFinite(b.end) && b.end > b.start)
}

export type LinearIssueInput = {
  id: string
  title: string
  updatedAt: number | null
  priority: string
  lastCommentAt: number | null
}

function linearMs(v: unknown): number | null {
  if (!v) return null
  const t = new Date(String(v)).getTime()
  return Number.isFinite(t) ? t : null
}

const LINEAR_PRIORITY_NUMBERS: Record<number, string> = { 1: 'urgent', 2: 'high', 3: 'medium', 4: 'low' }

/** Loose parse of whatever the Composio list returned. Only rows with a title
 * count; anything else is noise the walk ignores. */
export function parseLinearIssues(raw: unknown): LinearIssueInput[] {
  let data = raw
  if (typeof raw === 'string') {
    const trimmed = raw.trim()
    if (!trimmed.startsWith('[') && !trimmed.startsWith('{')) return []
    try {
      data = JSON.parse(trimmed)
    } catch {
      return []
    }
  }
  const out: LinearIssueInput[] = []
  const walk = (node: unknown, depth: number) => {
    if (out.length >= 60 || depth > 5 || node == null) return
    if (Array.isArray(node)) {
      for (const item of node) walk(item, depth + 1)
      return
    }
    if (typeof node !== 'object') return
    const o = node as Record<string, unknown>
    const title = String(o.title || '').trim()
    if (title) {
      const prioRaw = o.priority ?? o.priorityLabel ?? ''
      const priority =
        typeof prioRaw === 'number' ? LINEAR_PRIORITY_NUMBERS[prioRaw] || '' : String(prioRaw).toLowerCase()
      const comments = Array.isArray(o.comments) ? (o.comments[o.comments.length - 1] as Record<string, unknown> | undefined) : undefined
      out.push({
        id: String(o.id || o.identifier || title).slice(0, 80),
        title: title.slice(0, 200),
        updatedAt: linearMs(o.updatedAt ?? o.updated_at),
        priority,
        lastCommentAt: linearMs(o.lastCommentAt ?? comments?.updatedAt),
      })
    }
    for (const v of Object.values(o)) walk(v, depth + 1)
  }
  walk(data, 0)
  return out
}

/** Stale first: age plus priority words plus a fresh comment. Top 3 are now,
 * the next 5 are next, the rest only show as a count. */
export function scoreLinearIssues(
  issues: LinearIssueInput[],
  now: number = Date.now(),
): { now: Array<{ id: string; title: string; score: number }>; next: Array<{ id: string; title: string; score: number }>; later: number } {
  const day = 86_400_000
  const scored = issues.map((i) => {
    let score = 0
    if (i.updatedAt) score += Math.max(0, Math.floor((now - i.updatedAt) / day))
    const text = `${i.title} ${i.priority}`.toLowerCase()
    if (/\burgent\b/.test(text)) score += 7
    else if (/\bhigh\b/.test(text)) score += 4
    if (i.lastCommentAt && now - i.lastCommentAt <= 2 * day) score += 3
    return { id: i.id, title: i.title, score }
  })
  scored.sort((a, b) => b.score - a.score || a.title.localeCompare(b.title))
  return {
    now: scored.slice(0, 3),
    next: scored.slice(3, 8),
    later: Math.max(0, scored.length - 8),
  }
}

type NextRow = {
  id: string
  kicker: string
  title: string
  hint?: string
  hot?: boolean
  action: string
  doLabel?: string
  draftId?: string
  loopId?: string
  personId?: string
  issueId?: string
  eventId?: string
  pipelineId?: string
  stage?: string
  start?: string
  end?: string
  sms?: string
  openKind?: string
  messageId?: string
}

async function buildNextStack(
  sql: SQL,
  user: { id: string; timezone: string | null },
  persona: Persona,
): Promise<{ items: NextRow[]; connected: string[]; missing: string[] }> {
  const tz = pickUserTimezone({ userTz: user.timezone })
  const connected = (await connectedForUser(sql, user.id)).filter((id) => !PERSONA_DENIED[persona].has(id))
  const want = persona === 'friend' ? ['gmail', 'calendar'] : persona === 'coworker' ? ['gmail', 'calendar', 'linear'] : ['gmail', 'calendar']
  const missing = want.filter((id) => !connected.includes(id))
  const items: NextRow[] = []
  const now = Date.now()

  let events: Array<{ id: string; title: string; start: string; end: string; allDay: boolean }> = []
  if (connected.includes('calendar')) {
    try {
      events = await googleEventsRaw(sql, user.id, {
        timeMin: new Date(now - 5 * 60_000),
        timeMax: startOfLocalDay(tz, 2),
        maxResults: 12,
      })
    } catch (err) {
      console.warn('[work/next] calendar failed', err)
    }
  }
  for (const ev of selectNextEvents(events, now)) {
    const walk = !ev.allDay && isWalkIn(ev.start, now)
    items.push({
      id: `meet-${ev.id}`,
      kicker: walk ? 'Now' : ev.allDay ? 'All day' : 'Next',
      title: ev.title,
      hint: ev.allDay ? 'On the calendar' : localHourParts(ev.start, tz),
      hot: walk,
      action: 'open',
      doLabel: walk ? 'Prep' : 'Open',
      openKind: persona === 'coworker' ? 'meeting_mode' : 'digest',
      eventId: ev.id,
    })
  }

  if (connected.includes('gmail')) {
    try {
      const richMail = await loadGmailRich(sql, user.id, importantMailQuery('2d'), 12)
      const keptMail = await judgeBriefMail(richMail, 3)
      for (const m of keptMail) {
        items.push({
          id: `mail-${m.id}`,
          kicker: 'Mail',
          title: m.subject || '(no subject)',
          hint: cleanMailSnippet(m.snippet) || m.from.replace(/<[^>]+>/g, '').trim(),
          action: 'open',
          doLabel: 'Read',
          openKind: 'digest',
          messageId: m.id,
        })
      }
    } catch (err) {
      console.warn('[work/next] mail failed', err)
    }
  }

  let drafts: Array<{ id: string; toAddr: string; subject: string }> = []
  try {
    drafts = ((await sql`
      SELECT id, to_addr AS "toAddr", subject FROM hire_drafts
      WHERE user_id = ${user.id} AND status = 'pending'
      ORDER BY created_at DESC LIMIT 3
    `) as Array<{ id: string; toAddr: string; subject: string }>).filter((d) => !isAutomatedSender(d.toAddr) && !isAutomatedSubject(d.subject))
  } catch {
    drafts = []
  }
  for (const d of drafts) {
    items.push({
      id: `draft-${d.id}`,
      kicker: 'Draft ready',
      title: d.subject || 'Draft',
      hint: `For ${d.toAddr}. Review before it goes out.`,
      hot: true,
      action: 'open',
      doLabel: 'Review',
      openKind: 'approve_send',
      draftId: d.id,
    })
  }

  let loops: Array<{ id: string; title: string; dueAt: Date | null }> = []
  try {
    loops = (await sql`
      SELECT id, title, due_at AS "dueAt" FROM hire_loops
      WHERE user_id = ${user.id} AND status = 'open'
      ORDER BY due_at ASC NULLS LAST LIMIT 6
    `) as Array<{ id: string; title: string; dueAt: Date | null }>
  } catch (err) {
    console.warn('[work/next] loops failed', err)
  }
  const dueLoop = loops.find((l) => l.dueAt && new Date(l.dueAt).getTime() <= now + 12 * 60 * 60 * 1000) || loops[0]
  if (dueLoop) {
    items.push({
      id: `loop-${dueLoop.id}`,
      kicker: 'Promise',
      title: dueLoop.title,
      hint: dueLoop.dueAt ? 'Due' : 'Open',
      hot: true,
      action: 'loop',
      doLabel: 'Close',
      loopId: dueLoop.id,
    })
  }

  let people: Array<{ id: string; name: string; context: string; lastTouch: Date | null; cadenceDays: number }> = []
  try {
    people = (await sql`
      SELECT id, name, context, last_touch AS "lastTouch", cadence_days AS "cadenceDays"
      FROM hire_network WHERE user_id = ${user.id}
      ORDER BY coalesce(last_touch, '1970-01-01'::timestamptz) ASC LIMIT 12
    `) as Array<{ id: string; name: string; context: string; lastTouch: Date | null; cadenceDays: number }>
  } catch (err) {
    console.warn('[work/next] network failed', err)
  }
  const overdue = people.find((p) => {
    const last = p.lastTouch ? new Date(p.lastTouch).getTime() : 0
    return (Date.now() - last) / 86400000 >= (p.cadenceDays || 14)
  })
  if (overdue) {
    const draft = `Hey ${overdue.name.split(' ')[0]} — ${overdue.context || 'wanted to reconnect'}`
    items.push({
      id: `person-${overdue.id}`,
      kicker: 'Ping',
      title: overdue.name,
      hint: overdue.context || 'Overdue',
      hot: true,
      action: 'person',
      doLabel: 'Talked',
      personId: overdue.id,
      sms: `sms:&body=${encodeURIComponent(draft)}`,
    })
  }

  if (persona === 'coworker' && connected.includes('linear')) {
    const lin = await listLinearIssues(user.id)
    if (lin.issues[0]) {
      items.push({
        id: `lin-${lin.issues[0].id}`,
        kicker: 'Linear',
        title: lin.issues[0].title,
        hint: lin.issues[0].identifier,
        action: 'linear',
        doLabel: 'Later',
        issueId: lin.issues[0].id,
      })
    }
  }

  if (persona === 'cofounder') {
    const pipe = (await sql`
      SELECT id, title, stage FROM hire_pipeline
      WHERE user_id = ${user.id} AND stage NOT IN ('won', 'lost')
      ORDER BY updated_at DESC LIMIT 1
    `) as Array<{ id: string; title: string; stage: string }>
    if (pipe[0]) {
      const nextStage = pipe[0].stage === 'lead' ? 'active' : pipe[0].stage === 'active' ? 'interview' : pipe[0].stage === 'interview' ? 'offer' : 'won'
      items.push({
        id: `pipe-${pipe[0].id}`,
        kicker: pipe[0].stage,
        title: pipe[0].title,
        action: 'pipeline',
        doLabel: 'Advance',
        pipelineId: pipe[0].id,
        stage: nextStage,
      })
    }
  }

  /* No friend branch. Friend is denied `next_move` in SKILLS and remapped to
   * `home` by canonicalMiniAppKind, so nothing ever reached one — and home now
   * builds friend's queue from the snapshot it already has rather than paying for
   * a second request here. */

  return { items, connected, missing }
}

/** Signed mini-app URL preview for iMessage OG. Real events and mail, not a slogan. */
export async function miniCardOgDescription(
  sql: SQL,
  token: string,
  persona: string,
  kind: string,
): Promise<string | null> {
  if (!isPersona(persona)) return null
  const tok = verifyMiniToken(token)
  if (!tok || tok.persona !== persona) return null
  const user = await getUserByPhone(sql, tok.phone)
  if (!user) return null
  try {
    if (kind === 'digest') {
      /* Through the cache, not around it. This runs to build the preview line for
       * the card Alpha is about to text — the same payload the link opens. Warming
       * it here is why tapping that link lands on a brief instead of building one. */
      const payload = (await digestCache.read(
        `${user.id}|${persona}`,
        () => briefLoader(sql, user.id, persona, 'digest', () => digestPayload(sql, user, persona), localDateStrInTz(new Date(), user.timezone || 'America/Los_Angeles')),
        BRIEF_WARM_WAIT_MS,
      )).value
      if (!payload) return null
      return String(payload.preview || '').trim() || null
    }
    if (kind === 'pick_night') {
      const payload = (await eveningCache.read(
        `${user.id}|${persona}`,
        () => briefLoader(sql, user.id, persona, 'pick_night', () => miniPayload(sql, user, persona, 'pick_night'), localDateStrInTz(new Date(), user.timezone || 'America/Los_Angeles')),
        BRIEF_WARM_WAIT_MS,
      )).value
      if (!payload) return null
      const sections = (payload as { sections?: Array<{ heading: string; items?: string[] }> }).sections || []
      const lines = sections
        .flatMap((s) => (s.items || []).slice(0, 3))
        .filter((item) => item && !/^no important mail$/i.test(item) && !/^nothing /i.test(item))
        .slice(0, 6)
      if (!lines.length) return 'No important mail'
      return lines.join('\n').slice(0, 320)
    }
  } catch (err) {
    console.warn('[mini] og preview failed', err)
  }
  return null
}

export async function handleHireApi(req: Request, sql: SQL | null): Promise<Response | null> {
  const url = new URL(req.url)
  const path = url.pathname
  // /b/ serves deployed builds, /a/ their legacy files — both are API-owned
  // routes that live outside the /api/ prefix.
  if (!path.startsWith('/api/') && !path.startsWith('/b/') && !path.startsWith('/a/')) return null
  if (path === '/api/waitlist') return null

  if (req.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      },
    })
  }

  if (!sql) return json({ error: 'Database unavailable' }, 503)

  if (path === '/api/connectors/status' && req.method === 'GET') {
    return json({
      google: !!googleCreds(),
      composio: !!composioKey(),
    })
  }

  if (path === '/api/auth/google' && req.method === 'GET') {
    const creds = googleCreds()
    if (!creds) {
      return Response.redirect(`${appBase(req)}/app/login?error=google`, 302)
    }
    const state = crypto.randomUUID()
    const afterLogin = `${appBase(req)}/app/login`
    await sql`
      INSERT INTO hire_oauth_state (state, user_id, redirect_after)
      VALUES (${state}, ${LOGIN_STATE_USER}, ${afterLogin})
    `
    const auth = new URL('https://accounts.google.com/o/oauth2/v2/auth')
    auth.searchParams.set('client_id', creds.clientId)
    auth.searchParams.set('redirect_uri', `${appBase(req)}/api/oauth/google/callback`)
    auth.searchParams.set('response_type', 'code')
    auth.searchParams.set('scope', LOGIN_SCOPES)
    auth.searchParams.set('access_type', 'online')
    auth.searchParams.set('prompt', 'select_account')
    auth.searchParams.set('state', state)
    return Response.redirect(auth.toString(), 302)
  }

  if (path === '/api/auth/ticket' && req.method === 'GET') {
    const ticket = url.searchParams.get('ticket') || ''
    if (!ticket) return json({ error: 'ticket required' }, 400)
    const rows = await sql`
      SELECT email, name, phone_e164 AS phone, created_at
      FROM hire_login_tickets
      WHERE ticket = ${ticket}
      LIMIT 1
    `
    const row = rows[0] as { email: string; name: string | null; phone: string | null; created_at: Date } | undefined
    if (!row) return json({ error: 'Sign in expired. Try Google again.' }, 400)
    await sql`DELETE FROM hire_login_tickets WHERE ticket = ${ticket}`
    if (Date.now() - new Date(row.created_at).getTime() > 10 * 60 * 1000) {
      return json({ error: 'Sign in expired. Try Google again.' }, 400)
    }
    return json({ email: row.email, name: row.name, phone: row.phone })
  }

  if (path === '/api/auth/register' && req.method === 'POST') {
    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>
    const email = String(body.email || '')
      .trim()
      .toLowerCase()
    const password = body.password
    const phone = typeof body.phone === 'string' ? body.phone : undefined
    const name = typeof body.name === 'string' ? body.name : undefined
    if (!isValidEmailFormat(email)) return json({ error: 'Enter a valid email' }, 400)
    if (!isPlausiblePassword(password)) {
      return json({ error: 'Password needs at least 8 characters' }, 400)
    }
    let user: AuthedUser
    try {
      user = await ensureUser(sql, email, phone, name)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      if (msg.toLowerCase().includes('unique') || msg.includes('hire_users_phone')) {
        return json({ error: 'That phone is already linked to another account' }, 409)
      }
      console.error('[hire] register user failed', err)
      return json({ error: 'Could not create account' }, 500)
    }
    if (await getPasswordHashById(sql, user.id)) {
      return json({ error: 'Already has a password. Sign in instead.' }, 409)
    }
    const hash = await hashPassword(password)
    await sql`
      UPDATE hire_users SET password_hash = ${hash}, updated_at = now()
      WHERE id = ${user.id}
    `
    return sessionTokenResponse(user)
  }

  if (path === '/api/auth/login' && req.method === 'POST') {
    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>
    const email = String(body.email || '')
      .trim()
      .toLowerCase()
    const password = body.password
    if (!email.includes('@') || typeof password !== 'string' || !password) {
      return json({ error: 'Email or password is wrong' }, 401)
    }
    const lockedMs = loginLockedRemainingMs(email)
    if (lockedMs > 0) {
      return json({ error: 'Too many attempts. Try again in a few minutes.' }, 429)
    }
    const rows = await sql`
      SELECT id, email, name, timezone, phone_e164 AS phone, password_hash
      FROM hire_users
      WHERE email = ${email}
      LIMIT 1
    `
    const row = rows[0] as
      | { id: string; email: string; name: string | null; timezone: string | null; phone: string | null; password_hash: unknown }
      | undefined
    const hash = typeof row?.password_hash === 'string' ? row.password_hash : ''
    if (!row || !hash) return json({ error: 'Email or password is wrong' }, 401)
    const ok = await Bun.password.verify(password, hash)
    if (!ok) {
      recordLoginFailure(email)
      return json({ error: 'Email or password is wrong' }, 401)
    }
    clearLoginFailures(email)
    return sessionTokenResponse(row)
  }

  if (path === '/api/me' && req.method === 'POST') {
    const body = (await req.json().catch(() => ({}))) as { email?: string; phone?: string; name?: string; timezone?: string }
    const email = String(body.email || '')
      .trim()
      .toLowerCase()
    if (!email.includes('@')) return json({ error: 'Enter a valid email' }, 400)
    try {
      const user = await ensureUser(sql, email, body.phone, body.name, body.timezone)
      const roster = await loadRoster(sql, user.id)
      return json({ user, roster })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      if (msg.toLowerCase().includes('unique') || msg.includes('hire_users_phone')) {
        return json({ error: 'That phone is already linked to another account' }, 409)
      }
      console.error('[hire] upsert user failed', err)
      return json({ error: 'Could not save account' }, 500)
    }
  }

  if (path === '/api/me' && req.method === 'GET') {
    const email = String(url.searchParams.get('email') || '')
      .trim()
      .toLowerCase()
    if (!email) return json({ error: 'email required' }, 400)
    const user = await getUserByEmail(sql, email)
    if (!user) return json({ user: null, roster: [], context: {}, connected: [] })
    const roster = await loadRoster(sql, user.id)
    const context: Record<string, Record<string, string>> = {}
    const memory: Record<string, MemoryRow[]> = {}
    for (const p of roster) {
      context[p] = await loadContext(sql, user.id, p)
      memory[p] = await loadMemories(sql, user.id, p, 40)
    }
    const connected = await connectedForUser(sql, user.id)
    const locations = (await loadLocations(sql, user.id)).map((l) => ({
      kind: l.kind,
      latitude: l.latitude,
      longitude: l.longitude,
      accuracy_m: l.accuracy_m,
      label: l.label,
      source: l.source,
      updated_at: l.updated_at,
    }))
    return json({ user, roster, context, connected, memory, locations })
  }

  if (path === '/api/me/phone' && req.method === 'PUT') {
    const body = (await req.json().catch(() => ({}))) as { email?: string; phone?: string; name?: string; timezone?: string }
    const email = String(body.email || '')
      .trim()
      .toLowerCase()
    const phone = normalizePhone(body.phone || '')
    if (!email.includes('@') || !phone) return json({ error: 'email and phone required' }, 400)
    const user = await ensureUser(sql, email, phone, body.name, body.timezone)
    // A number arriving on an account means the hires on that account can now
    // greet it — queue intros for everything in the roster that has not yet.
    // Each hire also gets its default recurring jobs, in the user's timezone
    // when the account has one.
    try {
      const roster = await loadRoster(sql, user.id)
      for (const persona of roster) {
        await enqueueIntro(sql, phone, persona)
        await seedDefaultLoops(sql, user.id, phone, persona, user.timezone)
      }
    } catch (err) {
      console.error('[hire] intro enqueue after phone set failed', err)
    }
    return json({ user })
  }

  if (path === '/api/me/roster' && req.method === 'PUT') {
    const body = (await req.json().catch(() => ({}))) as { email?: string; agentIds?: string[] }
    const email = String(body.email || '')
      .trim()
      .toLowerCase()
    const user = await getUserByEmail(sql, email)
    if (!user) return json({ error: 'Sign in first' }, 401)
    // Hires not live yet cannot be added — but anyone who already has one
    // keeps it, so this change never takes a working hire away from a user.
    const owned = await loadRoster(sql, user.id)
    const ids = (body.agentIds || [])
      .filter(isPersona)
      .filter((id) => hireIsLive(id) || owned.includes(id))
    await sql`DELETE FROM hire_roster WHERE user_id = ${user.id}`
    for (const persona of ids) {
      await sql`
        INSERT INTO hire_roster (user_id, persona) VALUES (${user.id}, ${persona})
        ON CONFLICT (user_id, persona) DO NOTHING
      `
      // New hire on an account with a number: that hire says hi first.
      if (user.phone) {
        try {
          await enqueueIntro(sql, user.phone, persona)
        } catch (err) {
          console.error('[hire] intro enqueue after roster change failed', err)
        }
      }
    }
    return json({ roster: ids })
  }

  if (path === '/api/me/locations' && req.method === 'GET') {
    const email = String(url.searchParams.get('email') || '')
      .trim()
      .toLowerCase()
    const user = await getUserByEmail(sql, email)
    if (!user) return json({ error: 'Sign in first' }, 401)
    const locations = (await loadLocations(sql, user.id)).map((l) => ({
      kind: l.kind,
      latitude: l.latitude,
      longitude: l.longitude,
      accuracy_m: l.accuracy_m,
      label: l.label,
      source: l.source,
      updated_at: l.updated_at,
    }))
    return json({ locations })
  }

  const locationMatch = path.match(/^\/api\/me\/locations\/(current|home|work)$/)
  if (locationMatch && req.method === 'PUT') {
    const kind = locationMatch[1] as 'current' | 'home' | 'work'
    const body = (await req.json().catch(() => ({}))) as {
      email?: string
      latitude?: number
      longitude?: number
      accuracy_m?: number | null
      label?: string
      source?: string
    }
    const user = await getUserByEmail(sql, String(body.email || '').trim().toLowerCase())
    if (!user) return json({ error: 'Sign in first' }, 401)
    const lat = Number(body.latitude)
    const lng = Number(body.longitude)
    if (!coordsUsable(lat, lng)) return json({ error: 'latitude and longitude required' }, 400)
    const label = String(body.label || '').trim()
    if (kind === 'home' || kind === 'work') {
      if (!label) return json({ error: `${kind} needs a confirmed label` }, 400)
    }
    const accuracy = body.accuracy_m == null ? null : Math.max(0, Number(body.accuracy_m))
    await sql`
      INSERT INTO hire_user_locations (user_id, kind, latitude, longitude, accuracy_m, label, source, updated_at)
      VALUES (${user.id}, ${kind}, ${lat}, ${lng}, ${accuracy}, ${label}, ${String(body.source || 'manual')}, now())
      ON CONFLICT (user_id, kind)
      DO UPDATE SET
        latitude = excluded.latitude,
        longitude = excluded.longitude,
        accuracy_m = excluded.accuracy_m,
        label = excluded.label,
        source = excluded.source,
        updated_at = now()
    `
    if (kind === 'current') {
      const geo = timezoneFromCoords(lat, lng)
      if (geo) await rememberUserTimezone(sql, user.id, geo)
    }
    const locations = (await loadLocations(sql, user.id)).map((l) => ({
      kind: l.kind,
      latitude: l.latitude,
      longitude: l.longitude,
      accuracy_m: l.accuracy_m,
      label: l.label,
      source: l.source,
      updated_at: l.updated_at,
    }))
    return json({ ok: true, locations })
  }

  if (locationMatch && req.method === 'DELETE') {
    const kind = locationMatch[1] as 'current' | 'home' | 'work'
    const email = String(url.searchParams.get('email') || '')
      .trim()
      .toLowerCase()
    const user = await getUserByEmail(sql, email)
    if (!user) return json({ error: 'Sign in first' }, 401)
    await sql`DELETE FROM hire_user_locations WHERE user_id = ${user.id} AND kind = ${kind}`
    const locations = (await loadLocations(sql, user.id)).map((l) => ({
      kind: l.kind,
      latitude: l.latitude,
      longitude: l.longitude,
      accuracy_m: l.accuracy_m,
      label: l.label,
      source: l.source,
      updated_at: l.updated_at,
    }))
    return json({ ok: true, locations })
  }

  const contextMatch = path.match(/^\/api\/me\/hires\/([^/]+)\/context$/)
  if (contextMatch && req.method === 'PUT') {
    const persona = contextMatch[1]
    if (!isPersona(persona)) return json({ error: 'Unknown hire' }, 400)
    const body = (await req.json().catch(() => ({}))) as {
      email?: string
      fields?: Record<string, string>
    }
    const email = String(body.email || '')
      .trim()
      .toLowerCase()
    const user = await getUserByEmail(sql, email)
    if (!user) return json({ error: 'Sign in first' }, 401)
    const fields = body.fields && typeof body.fields === 'object' ? body.fields : {}
    await sql`
      INSERT INTO hire_context (user_id, persona, fields, updated_at)
      VALUES (${user.id}, ${persona}, ${fields}, now())
      ON CONFLICT (user_id, persona)
      DO UPDATE SET fields = ${fields}, updated_at = now()
    `
    await syncContextMemories(sql, user.id, persona, fields)
    return json({ ok: true, fields })
  }

  const memoryMatch = path.match(/^\/api\/me\/hires\/([^/]+)\/memory$/)
  if (memoryMatch && req.method === 'GET') {
    const persona = memoryMatch[1]
    if (!isPersona(persona)) return json({ error: 'Unknown hire' }, 400)
    const email = String(url.searchParams.get('email') || '')
      .trim()
      .toLowerCase()
    const user = await getUserByEmail(sql, email)
    if (!user) return json({ error: 'Sign in first' }, 401)
    return json({ memories: await loadMemories(sql, user.id, persona, 40) })
  }
  if (memoryMatch && req.method === 'PUT') {
    const persona = memoryMatch[1]
    if (!isPersona(persona)) return json({ error: 'Unknown hire' }, 400)
    const body = (await req.json().catch(() => ({}))) as {
      email?: string
      facts?: Array<{ key?: string; value?: string; durable?: boolean }>
    }
    const email = String(body.email || '')
      .trim()
      .toLowerCase()
    const user = await getUserByEmail(sql, email)
    if (!user) return json({ error: 'Sign in first' }, 401)
    const facts = (body.facts || [])
      .filter((f) => f && f.key && f.value)
      .map((f) => ({
        key: String(f.key),
        value: String(f.value),
        durable: f.durable ?? isDurableKey(String(f.key)),
      }))
    await upsertMemories(sql, user.id, persona, facts)
    return json({ ok: true, memories: await loadMemories(sql, user.id, persona, 40) })
  }
  if (memoryMatch && req.method === 'DELETE') {
    const persona = memoryMatch[1]
    if (!isPersona(persona)) return json({ error: 'Unknown hire' }, 400)
    const email = String(url.searchParams.get('email') || '')
      .trim()
      .toLowerCase()
    const key = String(url.searchParams.get('key') || '').trim()
    const user = await getUserByEmail(sql, email)
    if (!user) return json({ error: 'Sign in first' }, 401)
    if (!key) return json({ error: 'key required' }, 400)
    await sql`DELETE FROM hire_memories WHERE user_id = ${user.id} AND persona = ${persona} AND key = ${key}`
    return json({ ok: true, memories: await loadMemories(sql, user.id, persona, 40) })
  }

  if (path.startsWith('/api/connect/') && req.method === 'GET') {
    const connector = path.slice('/api/connect/'.length)
    const email = String(url.searchParams.get('email') || '')
      .trim()
      .toLowerCase()
    const persona = url.searchParams.get('persona') || ''
    const redirectAfter =
      url.searchParams.get('redirect') || `${appBase(req)}/app/hires/${persona || 'friend'}`
    const user = await getUserByEmail(sql, email)
    if (!user) return json({ error: 'Sign in first' }, 401)
    if (isPersona(persona) && PERSONA_DENIED[persona].has(connector)) {
      return json({ error: 'This hire cannot use that tool' }, 403)
    }

    const toolkit = UI_TO_COMPOSIO[connector]
    const after = redirectAfter.startsWith('http')
      ? redirectAfter
      : `${appBase(req)}${redirectAfter}`
    const afterWithFlag = after.includes('?')
      ? `${after}&connected=${connector}`
      : `${after}?connected=${connector}`
    const asJson = url.searchParams.get('json') === '1'

    const sendUrl = (target: string) =>
      asJson ? json({ url: target }) : Response.redirect(target, 302)

    if (toolkit && composioKey()) {
      const urlOut = await composioAuthorize(sql, user.id, toolkit, afterWithFlag)
      if (urlOut) return sendUrl(urlOut)
    }

    if (GOOGLE_CONNECTORS.has(connector) && googleCreds()) {
      const state = crypto.randomUUID()
      await sql`
        INSERT INTO hire_oauth_state (state, user_id, redirect_after)
        VALUES (${state}, ${user.id}, ${afterWithFlag})
      `
      const creds = googleCreds()!
      const auth = new URL('https://accounts.google.com/o/oauth2/v2/auth')
      auth.searchParams.set('client_id', creds.clientId)
      auth.searchParams.set('redirect_uri', `${appBase(req)}/api/oauth/google/callback`)
      auth.searchParams.set('response_type', 'code')
      auth.searchParams.set('scope', GOOGLE_SCOPES)
      auth.searchParams.set('access_type', 'offline')
      auth.searchParams.set('prompt', 'consent')
      auth.searchParams.set('state', state)
      return sendUrl(auth.toString())
    }

    return json(
      {
        error: 'Connectors are not configured',
        message:
          'Set COMPOSIO_API_KEY on HireAlpha-Web for Gmail, Calendar, and the rest of the catalog. Or set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET for Google tools only.',
      },
      501,
    )
  }

  if (path === '/api/oauth/google/callback' && req.method === 'GET') {
    const code = url.searchParams.get('code')
    const state = url.searchParams.get('state')
    const creds = googleCreds()
    if (!code || !state || !creds) return json({ error: 'OAuth callback missing code' }, 400)
    const rows = await sql`
      SELECT user_id, redirect_after FROM hire_oauth_state WHERE state = ${state} LIMIT 1
    `
    const st = rows[0] as { user_id: string; redirect_after: string | null } | undefined
    if (!st) return json({ error: 'Invalid OAuth state' }, 400)
    await sql`DELETE FROM hire_oauth_state WHERE state = ${state}`
    const tokRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: creds.clientId,
        client_secret: creds.clientSecret,
        redirect_uri: `${appBase(req)}/api/oauth/google/callback`,
        grant_type: 'authorization_code',
      }),
    })
    if (!tokRes.ok) return json({ error: 'Google token exchange failed' }, 400)
    const tok = (await tokRes.json()) as {
      access_token: string
      refresh_token?: string
      expires_in?: number
      scope?: string
    }

    if (st.user_id === LOGIN_STATE_USER) {
      const infoRes = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
        headers: { Authorization: `Bearer ${tok.access_token}` },
      })
      if (!infoRes.ok) return json({ error: 'Could not read Google profile' }, 400)
      const info = (await infoRes.json()) as { email?: string; name?: string }
      const email = String(info.email || '')
        .trim()
        .toLowerCase()
      if (!email.includes('@')) return json({ error: 'Google did not return an email' }, 400)
      const user = await ensureUser(sql, email, null, info.name)
      const ticket = crypto.randomUUID()
      await sql`
        INSERT INTO hire_login_tickets (ticket, email, name, phone_e164)
        VALUES (${ticket}, ${user.email}, ${user.name}, ${user.phone})
      `
      return Response.redirect(`${appBase(req)}/app/login?google=${ticket}`, 302)
    }

    const expiresAt = new Date(Date.now() + (tok.expires_in || 3600) * 1000).toISOString()
    await sql`
      INSERT INTO hire_google_tokens (user_id, access_token, refresh_token, expires_at, scopes, updated_at)
      VALUES (
        ${st.user_id},
        ${tok.access_token},
        ${tok.refresh_token || null},
        ${expiresAt},
        ${tok.scope || GOOGLE_SCOPES},
        now()
      )
      ON CONFLICT (user_id) DO UPDATE SET
        access_token = excluded.access_token,
        refresh_token = COALESCE(excluded.refresh_token, hire_google_tokens.refresh_token),
        expires_at = excluded.expires_at,
        scopes = excluded.scopes,
        updated_at = now()
    `
    return Response.redirect(st.redirect_after || `${appBase(req)}/app`, 302)
  }

  if (path === '/api/internal/live' && req.method === 'GET') {
    if (!internalOk(req)) return json({ error: 'Unauthorized' }, 401)
    const phone = url.searchParams.get('phone') || ''
    const persona = url.searchParams.get('persona') || ''
    if (!isPersona(persona)) return json({ error: 'persona required' }, 400)
    return json(await livePayload(sql, phone, persona))
  }

  if (path === '/api/internal/intros/claim' && req.method === 'GET') {
    if (!internalOk(req)) return json({ error: 'Unauthorized' }, 401)
    const persona = url.searchParams.get('persona') || ''
    if (!isPersona(persona)) return json({ error: 'persona required' }, 400)
    const limit = Math.min(Math.max(Number(url.searchParams.get('limit')) || 3, 1), 10)
    const intros = await claimIntros(sql, persona, limit)
    return json({ intros })
  }

  if (path === '/api/internal/intros/ack' && req.method === 'POST') {
    if (!internalOk(req)) return json({ error: 'Unauthorized' }, 401)
    const body = (await req.json().catch(() => ({}))) as { id?: string; ok?: boolean; error?: string }
    if (!body.id) return json({ error: 'id required' }, 400)
    await ackIntro(sql, body.id, body.ok !== false, body.error)
    return json({ ok: true })
  }

  if (path === '/api/internal/loops/claim' && req.method === 'GET') {
    if (!internalOk(req)) return json({ error: 'Unauthorized' }, 401)
    const persona = url.searchParams.get('persona') || ''
    if (!isPersona(persona)) return json({ error: 'persona required' }, 400)
    const limit = Math.min(Math.max(Number(url.searchParams.get('limit')) || 3, 1), 10)
    const loops = await claimDueLoops(sql, persona, limit)
    return json({ loops })
  }

  if (path === '/api/internal/loops/result' && req.method === 'POST') {
    if (!internalOk(req)) return json({ error: 'Unauthorized' }, 401)
    const body = (await req.json().catch(() => ({}))) as {
      id?: string
      outcome?: string
      note?: string
      next_run?: string
    }
    const outcome = body.outcome === 'done' || body.outcome === 'failed' || body.outcome === 'snoozed'
      ? body.outcome
      : null
    if (!body.id || !outcome) return json({ error: 'id and outcome (done, failed, or snoozed) required' }, 400)
    await finishTaskLoop(sql, body.id, outcome, body.note, body.next_run)
    return json({ ok: true })
  }

  if (path === '/api/internal/handoff' && req.method === 'POST') {
    if (!internalOk(req)) return json({ error: 'Unauthorized' }, 401)
    const body = (await req.json().catch(() => ({}))) as {
      fromPersona?: string
      toPersona?: string
      phone?: string
      note?: string
    }
    if (!isPersona(body.fromPersona || '') || !isPersona(body.toPersona || '') || !body.phone) {
      return json({ error: 'fromPersona, toPersona, and phone required' }, 400)
    }
    const phone = normalizePhone(body.phone)
    if (!phone) return json({ error: 'valid phone required' }, 400)
    const user = await getUserByPhone(sql, phone)
    if (!user) return json({ error: 'User not found' }, 404)
    // The receiving hire runs this on its next claim pass and texts first.
    await sql`
      INSERT INTO hire_task_loops (id, user_id, persona, phone_e164, kind, title, payload, status, next_run)
      VALUES (${crypto.randomUUID()}, ${user.id}, ${body.toPersona!}, ${phone}, 'handoff',
        'Follow up on the handoff from ${body.fromPersona!}',
        ${JSON.stringify({ note: String(body.note || '').slice(0, 500), from: body.fromPersona })}::jsonb,
        'pending', now())
      ON CONFLICT (user_id, persona, kind) DO UPDATE SET
        payload = excluded.payload,
        status = 'pending',
        next_run = excluded.next_run,
        updated_at = now()
    `
    return json({ ok: true })
  }

  if (path === '/api/internal/kill-switch/check' && req.method === 'POST') {
    if (!internalOk(req)) return json({ error: 'Unauthorized' }, 401)
    const body = (await req.json().catch(() => ({}))) as { phone?: string }
    const phone = normalizePhone(body.phone || '')
    if (!phone) return json({ error: 'valid phone required' }, 400)
    const rows = (await sql`
      SELECT armed FROM hire_kill_switch WHERE phone_e164 = ${phone} LIMIT 1
    `) as Array<{ armed: boolean }>
    return json({ armed: !!rows[0]?.armed })
  }

  if (path === '/api/internal/actions' && req.method === 'POST') {
    if (!internalOk(req)) return json({ error: 'Unauthorized' }, 401)
    const body = (await req.json().catch(() => ({}))) as {
      phone?: string
      persona?: string
      action?: string
      detail?: string
      undo_hint?: string
    }
    const action = String(body.action || '').trim().slice(0, 120)
    if (!body.phone || !isPersona(body.persona || '') || !action) {
      return json({ error: 'phone, persona, and action required' }, 400)
    }
    const phone = normalizePhone(body.phone)
    const user = phone ? await getUserByPhone(sql, phone) : null
    if (!phone || !user) return json({ error: 'User not found' }, 404)
    const id = crypto.randomUUID()
    await sql`
      INSERT INTO hire_action_log (id, user_id, persona, action, detail, undo_hint)
      VALUES (${id}, ${user.id}, ${body.persona!}, ${action},
        ${String(body.detail || '').slice(0, 500)}, ${String(body.undo_hint || '').slice(0, 300) || null})
    `
    return json({ ok: true, id })
  }

  if (path === '/api/internal/heartbeat' && req.method === 'POST') {
    if (!internalOk(req)) return json({ error: 'Unauthorized' }, 401)
    const body = (await req.json().catch(() => ({}))) as { persona?: string; replyMs?: number }
    if (!isPersona(body.persona || '')) return json({ error: 'persona required' }, 400)
    const replyMs = Number.isFinite(Number(body.replyMs)) && Number(body.replyMs) >= 0
      ? Math.round(Number(body.replyMs))
      : null
    await sql`
      INSERT INTO hire_heartbeat (persona, last_beat, reply_ms)
      VALUES (${body.persona!}, now(), ${replyMs})
      ON CONFLICT (persona) DO UPDATE SET last_beat = now(), reply_ms = excluded.reply_ms
    `
    return json({ ok: true })
  }

  // Mail rows for a hire that is about to act on the inbox (the refund hunter
  // asks before it drafts anything). Falls back to an empty list for a phone
  // with no connected Gmail so the caller can carry on gracefully.
  if (path === '/api/internal/mail/context' && req.method === 'GET') {
    if (!internalOk(req)) return json({ error: 'Unauthorized' }, 401)
    const phone = normalizePhone(url.searchParams.get('phone') || '')
    if (!phone) return json({ error: 'valid phone required' }, 400)
    const user = await getUserByPhone(sql, phone)
    if (!user) return json({ mail: [] })
    const limit = Math.min(Math.max(Number(url.searchParams.get('limit')) || 10, 1), 30)
    const rich = await loadGmailRich(sql, user.id, importantMailQuery('14d'), limit)
    const mail = rich.map((m) => ({
      subject: m.subject,
      snippet: m.snippet,
      from: m.from,
      threadId: m.id,
      receivedAt: m.date,
    }))
    return json({ mail })
  }

  if (path === '/api/billing/webhook' && req.method === 'POST') {
    return handleBillingWebhook(req, sql)
  }

  if (path === '/api/billing/checkout' && req.method === 'POST') {
    const body = (await req.json().catch(() => ({}))) as {
      email?: string
      hire?: string
      plan?: string
      interval?: string
      trial_days?: number
      discount?: string
    }
    const email = String(body.email || '')
      .trim()
      .toLowerCase()
    // The landing page folds the billing period into the plan name ("bundle-annual");
    // accept both that shape and the split plan+interval form.
    const rawPlan = String(body.plan || '')
    const basePlan = rawPlan.endsWith('-annual') ? rawPlan.slice(0, -'-annual'.length) : rawPlan
    const plan = basePlan === 'bundle' || basePlan === 'ultra' || basePlan === 'free' ? basePlan : 'single'
    const annual = body.interval === 'annual' || rawPlan.endsWith('-annual')
    const persona = String(body.hire || '')
    if (!email.includes('@') || (plan === 'single' && !isPersona(persona))) {
      return json({ error: 'email and hire required' }, 400)
    }
    // Bundle and ultra are one subscription for every hire, stored under the
    // synthetic persona 'all'; single keeps the per-hire rows it always had.
    const effectivePersona = plan === 'single' ? (persona as Persona | 'all') : 'all'
    const priceFor = (per: string, isAnnual: boolean) => {
      const keys =
        plan === 'free'
          ? ['STRIPE_PRICE_FREE']
          : plan === 'bundle'
            ? ['STRIPE_PRICE_BUNDLE']
            : plan === 'ultra'
              ? ['STRIPE_PRICE_ULTRA']
              : [`STRIPE_PRICE_${per.toUpperCase()}`]
      const envs = isAnnual && plan !== 'free' ? keys.map((k) => `${k}_ANNUAL`) : keys
      return envs.map((k) => process.env[k]?.trim() || '').find(Boolean) || ''
    }
    let priceId = priceFor(persona, annual)
    // Promo: $5/mo for first 2 months on Friend monthly (non-annual, single plan)
    const promoPrice = stripePromoPrice()
    if (plan === 'single' && persona === 'friend' && !annual && promoPrice) {
      priceId = promoPrice
    }
    // An annual price that was never configured quietly falls back to monthly
    // rather than failing checkout; the response says so.
    let fallback = false
    if (!priceId && annual) {
      priceId = priceFor(persona, false)
      fallback = true
    }
    if (!stripeSecret() || !priceId) return json({ error: 'Billing is not set up yet' }, 503)
    const user = await getUserByEmail(sql, email)
    if (!user) return json({ error: 'Sign in first' }, 401)
    const trialDays = Number(body.trial_days) > 0 ? Math.floor(Number(body.trial_days)) : 7
    // A $0 plan with a trial attached is just a longer forms experience. Stripe
    // rejects trial_period_days of 0 outright, so the free plan omits the param.
    const effectiveTrialDays = plan === 'free' ? null : trialDays
    // Referral free month: an unspent credit becomes a 100% off coupon on the
    // first invoice. The credit is marked used at checkout creation, not at
    // completion, so an abandoned session burns it (accepted for v1).
    // trial_days stays as-is; the coupon already covers the first invoice and
    // a trial would double-free the same month. Email-only accounts have no
    // phone, earn nothing, and spend nothing.
    let referralCouponId = ''
    if (!body.discount && user.phone) {
      const creditRows = (await sql`
        SELECT id FROM hire_referral_credits
        WHERE phone_e164 = ${user.phone} AND used_at IS NULL
        ORDER BY created_at LIMIT 1
      `) as Array<{ id: string }>
      const credit = creditRows[0]
      if (credit) {
        const couponId = `referral-${user.id}`
        try {
          await stripeRequest(
            '/coupons',
            new URLSearchParams({
              id: couponId,
              percent_off: '100',
              duration: 'once',
              name: 'Referral free month',
            }),
          )
          referralCouponId = couponId
        } catch (err) {
          if ((err as Error & { code?: string }).code === 'resource_already_exists') {
            try {
              const coupon = await stripeRequest(`/coupons/${couponId}`, new URLSearchParams(), 'GET')
              if (coupon['id'] === couponId) referralCouponId = couponId
            } catch (fetchErr) {
              console.error('[billing] referral coupon fetch failed', fetchErr)
            }
          } else {
            console.error('[billing] referral coupon create failed', err)
          }
        }
        if (referralCouponId) {
          await sql`
            UPDATE hire_referral_credits SET used_at = now(), used_for_persona = ${effectivePersona}
            WHERE id = ${credit.id} AND used_at IS NULL
          `
        }
      }
    }
    const params = new URLSearchParams({
      mode: 'subscription',
      customer_email: email,
      client_reference_id: `${user.id}:${effectivePersona}`,
      'line_items[0][price]': priceId,
      'line_items[0][quantity]': '1',
      success_url: `${appBase(req)}/app?billing=done`,
      cancel_url: `${appBase(req)}/app?billing=cancelled`,
      'subscription_data[metadata][user_id]': user.id,
      'subscription_data[metadata][persona]': effectivePersona,
      ...(effectiveTrialDays !== null ? { 'subscription_data[trial_period_days]': String(effectiveTrialDays) } : {}),
    })
    if (referralCouponId) params.set('discounts[0][coupon]', referralCouponId)
    try {
      const session = await stripeRequest('/checkout/sessions', params)
      return json({ url: session['url'], fallback })
    } catch (err) {
      console.error('[billing] checkout session failed', err)
      return json({ error: 'Could not start checkout' }, 502)
    }
  }

  /* Save-the-contact: a vCard with the name, number, and face already filled
   * in. Photo is folded base64 per RFC 6350 so Android parsers do not choke. */
  if (path === '/api/contact/alpha.vcf' && req.method === 'GET') {
    const lines = [
      'BEGIN:VCARD',
      'VERSION:3.0',
      'N:;Alpha;;;',
      'FN:Alpha',
      'ORG:HireAlpha',
      'TEL;TYPE=CELL:+14155951440',
    ]
    const b64 = await alphaContactPhoto()
    if (b64) {
      // Fold counts the whole line, so the first chunk fits after the 26-char
      // property prefix and the rest continue at 74 with a leading space.
      const head = 'PHOTO;ENCODING=b;TYPE=PNG:'
      const rest = b64.match(/.{1,74}/g) || []
      lines.push(head + rest[0].slice(0, 75 - head.length))
      for (let i = 0; i < rest.length; i++) {
        const part = i === 0 ? rest[0].slice(75 - head.length) : rest[i]
        if (part) lines.push(' ' + part)
      }
    }
    lines.push('END:VCARD')
    return new Response(lines.join('\r\n'), {
      headers: {
        'Content-Type': 'text/vcard; charset=utf-8',
        'Content-Disposition': 'inline; filename="alpha.vcf"',
        'Cache-Control': 'public, max-age=3600',
      },
    })
  }

  if (path === '/api/billing/status' && req.method === 'GET') {
    const email = String(url.searchParams.get('email') || '')
      .trim()
      .toLowerCase()
    const user = email.includes('@') ? await getUserByEmail(sql, email) : null
    if (!user) return json({ error: 'Sign in first' }, 401)
    const rows = (await sql`
      SELECT persona, status, current_period_end AS "currentPeriodEnd"
      FROM hire_subscriptions WHERE user_id = ${user.id}
    `) as Array<{ persona: Persona; status: string; currentPeriodEnd: string | null }>
    const hires: Record<string, boolean> = {}
    for (const p of PERSONAS) hires[p] = false
    for (const row of rows) {
      if (row.persona === 'all') {
        // A bundle covers every hire at once.
        if (subscriptionActive(row.status)) for (const p of PERSONAS) hires[p] = true
        continue
      }
      hires[row.persona] = subscriptionActive(row.status)
    }
    return json({ hires })
  }

  if (path === '/api/invites/for-phone' && req.method === 'GET') {
    const phone = normalizePhone(url.searchParams.get('phone') || '')
    if (!phone) return json({ error: 'valid phone required' }, 400)
    try {
      const codes = await ensureInvites(sql, phone)
      const progress = await referralProgress(sql, phone)
      return json({ codes, ...progress })
    } catch (err) {
      console.error('[invites] ensure failed', err)
      return json({ error: 'Could not create invites' }, 500)
    }
  }

  if (path === '/api/invites/redeem' && req.method === 'POST') {
    const body = (await req.json().catch(() => ({}))) as { code?: string; phone?: string }
    const result = await claimInvite(sql, body.phone || '', body.code || '')
    if (!result.ok) {
      const status =
        result.error === 'Code not found' ? 404 : result.error === 'This code was already used' ? 409 : 400
      return json({ error: result.error }, status)
    }
    return json({ ok: true, referrer: result.referrer, reward: result.reward })
  }

  // Referral balance for a phone: its codes, how many are redeemed, and how
  // many free months are still unspent. Phone-only lookup, same as for-phone.
  if (path === '/api/invites/status' && req.method === 'GET') {
    const phone = normalizePhone(url.searchParams.get('phone') || '')
    if (!phone) return json({ error: 'valid phone required' }, 400)
    try {
      const codes = await ensureInvites(sql, phone)
      const progress = await referralProgress(sql, phone)
      const freeMonths = await referralFreeMonths(sql, phone)
      return json({ codes, redeemedCount: progress.referrals, freeMonths })
    } catch (err) {
      console.error('[invites] status failed', err)
      return json({ error: 'Could not read invites' }, 500)
    }
  }

  // Approximate waitlist spot: everyone who queued before this phone in the
  // intro queue, plus the email waitlist as one block. Good enough for a
  // "you are number N" screen; not an audit trail.
  if (path === '/api/invites/position' && req.method === 'GET') {
    const phone = normalizePhone(url.searchParams.get('phone') || '')
    if (!phone) return json({ error: 'valid phone required' }, 400)
    const rows = (await sql`
      SELECT
        (SELECT count(*) FROM hire_intro_queue WHERE created_at < COALESCE(
          (SELECT min(created_at) FROM hire_intro_queue WHERE phone_e164 = ${phone}), now())
        ) AS ahead,
        (SELECT count(*) FROM waitlist_emails) AS waiting
    `) as Array<{ ahead: string | number; waiting: string | number }>
    const ahead = Number(rows[0]?.ahead ?? 0)
    const waiting = Number(rows[0]?.waiting ?? 0)
    return json({ position: ahead + waiting })
  }

  if (path === '/api/actions' && req.method === 'GET') {
    const phone = normalizePhone(url.searchParams.get('phone') || '')
    if (!phone) return json({ error: 'valid phone required' }, 400)
    const user = await getUserByPhone(sql, phone)
    if (!user) return json({ actions: [] })
    const rows = await sql`
      SELECT id, persona, action, detail, undo_hint AS "undoHint", undone_at AS "undoneAt",
             created_at AS "createdAt"
      FROM hire_action_log WHERE user_id = ${user.id}
      ORDER BY created_at DESC LIMIT 20
    `
    return json({ actions: rows })
  }

  if (path.startsWith('/api/actions/') && path.endsWith('/undo') && req.method === 'POST') {
    const id = path.slice('/api/actions/'.length, -'/undo'.length)
    if (!id) return json({ error: 'id required' }, 400)
    // Undo semantics live with the bots; here a row just stops reading as done.
    await sql`
      UPDATE hire_action_log SET undone_at = now() WHERE id = ${id}
    `
    return json({ ok: true })
  }

  if (path === '/api/kill-switch' && req.method === 'POST') {
    const body = (await req.json().catch(() => ({}))) as { phone?: string; armed?: boolean }
    const phone = normalizePhone(body.phone || '')
    if (!phone) return json({ error: 'valid phone required' }, 400)
    const armed = body.armed !== false
    await sql`
      INSERT INTO hire_kill_switch (phone_e164, armed, updated_at)
      VALUES (${phone}, ${armed}, now())
      ON CONFLICT (phone_e164) DO UPDATE SET armed = excluded.armed, updated_at = now()
    `
    return json({ ok: true, armed })
  }

  if (path === '/api/kill-switch' && req.method === 'GET') {
    const phone = normalizePhone(url.searchParams.get('phone') || '')
    if (!phone) return json({ error: 'valid phone required' }, 400)
    const rows = (await sql`
      SELECT armed FROM hire_kill_switch WHERE phone_e164 = ${phone} LIMIT 1
    `) as Array<{ armed: boolean }>
    return json({ armed: !!rows[0]?.armed })
  }

  if (path === '/api/wishlist' && req.method === 'POST') {
    const body = (await req.json().catch(() => ({}))) as { phone?: string; vote?: string }
    const phone = normalizePhone(body.phone || '')
    const vote = String(body.vote || '').trim().slice(0, 120)
    if (!phone || !vote) return json({ error: 'valid phone and vote required' }, 400)
    await sql`
      INSERT INTO hire_wishlist (id, phone_e164, vote)
      VALUES (${crypto.randomUUID()}, ${phone}, ${vote})
      ON CONFLICT (phone_e164, vote) DO NOTHING
    `
    return json({ ok: true })
  }

  if (path === '/api/wishlist' && req.method === 'GET') {
    const rows = (await sql`
      SELECT vote, count(*) AS count FROM hire_wishlist
      GROUP BY vote ORDER BY count DESC, vote
    `) as Array<{ vote: string; count: string | number }>
    return json({ ideas: rows.map((r) => ({ vote: r.vote, count: Number(r.count) })) })
  }

  // Public status page: a hire is up while its heartbeats keep arriving.
  if (path === '/api/status' && req.method === 'GET') {
    const rows = (await sql`
      SELECT persona, last_beat AS "lastBeat", reply_ms AS "replyMs" FROM hire_heartbeat
    `) as Array<{ persona: string; lastBeat: string | Date; replyMs: number | null }>
    const hires: Record<string, { up: boolean; lastReplyMs: number | null }> = {}
    for (const p of PERSONAS) hires[p] = { up: false, lastReplyMs: null }
    for (const row of rows) {
      if (!isPersona(row.persona)) continue
      const beat = new Date(row.lastBeat).getTime()
      hires[row.persona] = {
        up: Number.isFinite(beat) && Date.now() - beat < 5 * 60 * 1000,
        lastReplyMs: row.replyMs ?? null,
      }
    }
    return json({ hires })
  }

  if (path === '/api/internal/live/tools' && req.method === 'POST') {
    if (!internalOk(req)) return json({ error: 'Unauthorized' }, 401)
    const body = (await req.json().catch(() => ({}))) as {
      phone?: string
      persona?: string
      message?: string
      want?: string
    }
    if (!body.phone || !body.persona || !isPersona(body.persona)) {
      return json({ error: 'phone and persona required' }, 400)
    }
    const live = await livePayload(sql, body.phone, body.persona)
    if (!live.found || !live.hired || !live.userId) return json({ results: [] })
    let message = body.message || ''
    if (
      body.want === 'maps' &&
      /near(?: me| us|by)?|around|where (?:should|can) we|tonight|dinner|lunch|breakfast|eat|food|restaurant|cafe|bar|coffee/i.test(message)
    ) {
      const city = live.memories.find((m) => m.key === 'city' && m.value)?.value
      if (city && !message.toLowerCase().includes(city.toLowerCase())) {
        message = `restaurants in ${city}`
      }
    }
    const loc = live.location ? await getLocation(sql, live.userId, live.location.kind) : null
    const locFresh = !!(
      loc &&
      loc.kind === 'current' &&
      Date.now() - new Date(loc.updated_at).getTime() < CURRENT_LOCATION_HOURS * 60 * 60 * 1000
    )
    const tz = pickUserTimezone({
      message,
      userTz: live.timezone,
      contextTz: typeof live.context?.timezone === 'string' ? live.context.timezone : '',
      memoryTz: live.memories.find((m) => m.key === 'timezone')?.value,
      latitude: loc?.latitude,
      longitude: loc?.longitude,
      locationFresh: locFresh,
    })
    const spokenTz = timezoneFromText(message)
    if (spokenTz) await rememberUserTimezone(sql, live.userId, spokenTz, body.persona)
    const want =
      body.want === 'maps' ||
      body.want === 'web' ||
      body.want === 'gmail' ||
      body.want === 'calendar' ||
      body.want === 'drive'
        ? body.want
        : undefined
    const results = await runToolsForMessage(sql, {
      userId: live.userId,
      persona: body.persona,
      message,
      connected: live.connected,
      want,
      timezone: tz,
      location: loc,
    })
    return json({ results })
  }

  if (path === '/api/internal/propose' && req.method === 'POST') {
    if (!internalOk(req)) return json({ error: 'Unauthorized' }, 401)
    const body = (await req.json().catch(() => ({}))) as {
      phone?: string
      persona?: string
      kind?: string
      to?: string
      subject?: string
      body?: string
      messageId?: string
      title?: string
      start?: string
      end?: string
    }
    if (!body.phone || !body.persona || !isPersona(body.persona)) {
      return json({ error: 'phone and persona required' }, 400)
    }
    const live = await livePayload(sql, body.phone, body.persona)
    if (!live.found || !live.hired || !live.userId) return json({ ok: false, error: 'not hired' }, 404)
    const tz = live.timezone || 'America/Los_Angeles'
    const id = crypto.randomUUID()
    const kind = body.kind === 'event' || body.kind === 'reply' ? body.kind : 'email'
    let toAddr = String(body.to || '').slice(0, 200)
    let subject = String(body.subject || body.title || '').slice(0, 200)
    let text = String(body.body || '').slice(0, 8000)
    let threadId = ''
    let inReplyTo = ''
    let startAt = ''
    let endAt = ''
    if (kind === 'reply') {
      const meta = await gmailReplyMeta(sql, live.userId, String(body.messageId || '').trim())
      if (!meta) return json({ ok: false, error: 'Could not load that mail to reply.' }, 400)
      toAddr = meta.to
      subject = meta.subject
      threadId = meta.threadId
      inReplyTo = meta.inReplyTo
      if (!text) return json({ ok: false, error: 'Reply body required' }, 400)
    } else if (kind === 'event') {
      const start = parseSpokenWhen(String(body.start || ''), tz) || new Date(Date.now() + 60 * 60 * 1000)
      const endParsed = parseSpokenWhen(String(body.end || ''), tz)
      const end = endParsed && endParsed.getTime() > start.getTime()
        ? endParsed
        : new Date(start.getTime() + 30 * 60 * 1000)
      startAt = start.toISOString()
      endAt = end.toISOString()
      subject = String(body.title || subject || 'Hold').slice(0, 160)
    } else if (!toAddr || !subject) {
      return json({ ok: false, error: 'to and subject required' }, 400)
    }
    await sql`
      INSERT INTO hire_drafts (
        id, user_id, persona, kind, to_addr, subject, body, thread_id, in_reply_to, start_at, end_at
      )
      VALUES (
        ${id}, ${live.userId}, ${body.persona}, ${kind},
        ${toAddr}, ${subject}, ${text}, ${threadId}, ${inReplyTo}, ${startAt}, ${endAt}
      )
    `
    return json({ ok: true, id, kind: kind === 'event' ? 'event' : 'email' })
  }

  if (path === '/api/internal/prep' && req.method === 'POST') {
    if (!internalOk(req)) return json({ error: 'Unauthorized' }, 401)
    const body = (await req.json().catch(() => ({}))) as {
      phone?: string
      persona?: string
      query?: string
    }
    if (!body.phone || !body.persona || !isPersona(body.persona)) {
      return json({ error: 'phone and persona required' }, 400)
    }
    const live = await livePayload(sql, body.phone, body.persona)
    if (!live.found || !live.hired || !live.userId) return json({ ok: false, error: 'not hired' }, 404)
    const bundle = await buildPrepBundle(
      sql,
      { id: live.userId, name: live.name, timezone: live.timezone },
      String(body.query || ''),
    )
    if (!bundle) return json({ ok: false, text: '' })
    return json({ ok: true, ...bundle })
  }

  if (path === '/api/internal/week' && req.method === 'POST') {
    if (!internalOk(req)) return json({ error: 'Unauthorized' }, 401)
    const body = (await req.json().catch(() => ({}))) as {
      phone?: string
      persona?: string
    }
    if (!body.phone || !body.persona || !isPersona(body.persona)) {
      return json({ error: 'phone and persona required' }, 400)
    }
    const live = await livePayload(sql, body.phone, body.persona)
    if (!live.found || !live.hired || !live.userId) return json({ ok: false, error: 'not hired' }, 404)
    const bundle = await buildWeekBundle(sql, {
      id: live.userId,
      name: live.name,
      timezone: live.timezone,
    })
    return json({ ok: true, ...bundle })
  }

  if (path === '/api/internal/touch' && req.method === 'POST') {
    if (!internalOk(req)) return json({ error: 'Unauthorized' }, 401)
    const body = (await req.json().catch(() => ({}))) as { phone?: string; persona?: string }
    if (!body.phone || !body.persona || !isPersona(body.persona)) {
      return json({ error: 'phone and persona required' }, 400)
    }
    return json(await touchInbound(sql, body.phone, body.persona))
  }

  if (path === '/api/internal/memory' && req.method === 'POST') {
    if (!internalOk(req)) return json({ error: 'Unauthorized' }, 401)
    const body = (await req.json().catch(() => ({}))) as {
      phone?: string
      persona?: string
      facts?: Array<{ key?: string; value?: string }>
    }
    if (!body.phone || !body.persona || !isPersona(body.persona)) {
      return json({ error: 'phone and persona required' }, 400)
    }
    const user = await getUserByPhone(sql, body.phone)
    if (!user) return json({ error: 'User not found' }, 404)
    const facts = (body.facts || [])
      .filter((f) => f && f.key && f.value)
      .map((f) => ({ key: String(f.key), value: String(f.value) }))
    await upsertMemories(sql, user.id, body.persona, facts)
    const tzFact = facts.find((f) => f.key.toLowerCase() === 'timezone')
    if (tzFact) await rememberUserTimezone(sql, user.id, tzFact.value, body.persona)
    return json({ ok: true, memories: await loadMemories(sql, user.id, body.persona, 12) })
  }

  if (path === '/api/internal/mini/run' && req.method === 'GET') {
    if (!internalOk(req)) return json({ error: 'Unauthorized' }, 401)
    const phone = url.searchParams.get('phone') || ''
    const persona = url.searchParams.get('persona') || ''
    const kind = url.searchParams.get('kind') || ''
    if (!phone || !isPersona(persona) || !kind) {
      return json({ error: 'phone, persona, and kind required' }, 400)
    }
    const user = await getUserByPhone(sql, phone)
    if (!user) return json({ error: 'User not found' }, 404)
    return json(await miniPayload(sql, user, persona, kind))
  }

  if (path === '/api/internal/mini/token' && req.method === 'GET') {
    if (!internalOk(req)) return json({ error: 'Unauthorized' }, 401)
    const phone = url.searchParams.get('phone') || ''
    const persona = url.searchParams.get('persona') || ''
    const kind = url.searchParams.get('kind') || ''
    if (!phone || !isPersona(persona) || !kind) {
      return json({ error: 'phone, persona, and kind required' }, 400)
    }
    const user = await getUserByPhone(sql, phone)
    if (!user) return json({ error: 'User not found' }, 404)
    const token = mintMiniToken(phone, persona, kind)
    if (!token) return json({ error: 'Mini tokens not configured' }, 503)
    return json({ token, url: `${appBase(req)}/app/mini/${persona}/${kind}?t=${token}` })
  }

  if (path.startsWith('/api/mail/') && req.method === 'GET') {
    const msgId = path.slice('/api/mail/'.length).replace(/[^a-zA-Z0-9_-]/g, '')
    if (!msgId) return json({ ok: false, error: 'Message ID required' }, 400)
    const { user, error: authErr } = await resolveAuthedUser(sql, {
      token: url.searchParams.get('t') || undefined,
      session: url.searchParams.get('s') || undefined,
      email: url.searchParams.get('email') || undefined,
    })
    if (authErr) return authErr
    // The digest's text-only fallback parses mail out of lines and has no Gmail
    // ids to hand out, so it mints text-0, text-1. Those can never be opened;
    // say so instead of blaming the connection.
    if (/^text-\d+$/.test(msgId)) {
      return json({
        ok: false,
        error: 'This one came from a text only fallback, so there is no message to open.',
      })
    }
    const access = await googleAccessToken(sql, user!.id, 'gmail')
    if (!access) {
      // One null covers several different situations and "reconnect in Settings"
      // is only the right advice for some of them.
      const g = await googleConnected(sql, user!.id)
      const viaComposio = !g && (await composioConnected(user!.id)).includes('gmail')
      if (viaComposio) {
        const body = await composioMailBody(user!.id, msgId)
        if (body) {
          return json({
            ok: true,
            messageId: body.id || msgId,
            subject: body.subject,
            from: body.from,
            date: body.date,
            bodyText: body.bodyText,
            bodyHtml: body.bodyHtml,
            snippet: body.snippet,
          })
        }
      }
      const error = !g
        ? viaComposio
          ? 'Gmail is connected through Composio and it did not return this message. Sign in with Google in Settings for reliable full reads.'
          : 'Gmail is not connected. Connect it in Settings to read full messages.'
        : !googleTokenHasScope(g.scopes, 'gmail')
          ? 'This Google account is connected for calendar only. Reconnect it in Settings and allow Gmail.'
          : !g.hasRefresh
            ? 'The Google sign in expired and there is no refresh token. Reconnect it in Settings.'
            : 'Google refused the saved Gmail permission. Reconnect it in Settings.'
      return json({ ok: false, error })
    }
    const gmailRes = await fetch(
      `https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(msgId)}?format=full`,
      { headers: { Authorization: `Bearer ${access}` } },
    )
    if (!gmailRes.ok) {
      if (gmailRes.status === 404) return json({ ok: false, error: 'Message not found.' })
      return json({ ok: false, error: `Gmail returned ${gmailRes.status}. Try again.` })
    }
    const gmailMsg = (await gmailRes.json()) as {
      snippet?: string
      payload?: GmailMimePart & { headers?: Array<{ name: string; value: string }> }
    }
    const headers = gmailMsg.payload?.headers || []
    const h = (n: string) => headers.find((x) => x.name.toLowerCase() === n.toLowerCase())?.value || ''
    const { text: bodyText, html: bodyHtml } = extractGmailBody(gmailMsg.payload)
    return json({
      ok: true,
      messageId: msgId,
      subject: h('subject'),
      from: h('from'),
      date: h('date'),
      bodyText,
      bodyHtml,
      snippet: gmailMsg.snippet || '',
    })
  }

  if (path === '/api/digest' && req.method === 'GET') {
    const t = url.searchParams.get('t') || ''
    const email = String(url.searchParams.get('email') || '')
      .trim()
      .toLowerCase()
    const persona = url.searchParams.get('persona') || ''
    if (!isPersona(persona)) return json({ error: 'persona required' }, 400)
    let user: { id: string; email: string; name: string | null; timezone: string | null; phone: string | null } | null = null
    if (t) {
      const tok = verifyMiniToken(t)
      if (!tok || tok.persona !== persona) {
        return json({ error: 'This link expired. Sign in to keep using it.', code: 'token_invalid' }, 401)
      }
      user = await getUserByPhone(sql, tok.phone)
    } else if (email.includes('@')) {
      user = await getUserByEmail(sql, email)
    } else {
      return json({ error: 'email required' }, 400)
    }
    if (!user) return json({ error: 'No account found for that phone/email' }, 404)
    try {
      const day = localDateStrInTz(new Date(), user!.timezone || 'America/Los_Angeles')
      const brief = await digestCache.read(`${user!.id}|${persona}`, () =>
        briefLoader(sql, user!.id, persona, 'digest', () => digestPayload(sql, user!, persona), day),
      )
      if (!brief.value && brief.pending) {
        /* Not an error — the load is still running behind this response and will
         * be in the cache shortly. Saying `error` here made the client stop and
         * tell the user to reopen the screen by hand; `pending` alone lets it
         * come back on its own. Never cached, or the retry reads this. */
        return json({ pending: true, note: 'Pulling your day together.' }, 200)
      }
      /* No value and nothing in flight means the build failed, or failed moments
       * ago and the cache is still in its cooldown. Claiming `pending` here would
       * send the client down a retry ladder shorter than the cooldown, so it would
       * ask six times, get this same answer six times, and then say "keep waiting"
       * — which isn't true. Fall into the catch below and say so instead. */
      if (!brief.value) throw new Error('digest payload unavailable')
      // A stale hit refreshing behind the response must not be served from the
      // browser cache on the next open, or the refresh would never be seen.
      return jsonRevalidated(req, brief.pending ? 0 : 120, {
        ...brief.value,
        cardUrl: `${appBase(req)}/app/mini/${persona}/digest`,
      })
    } catch (err) {
      console.warn('[digest] payload failed', err)
      const tz = user.timezone || 'America/Los_Angeles'
      const date = new Date().toLocaleDateString('en-US', {
        weekday: 'long',
        month: 'long',
        day: 'numeric',
        timeZone: tz,
      })
      return json({
        date,
        calendar: [],
        meetings: [],
        attention: null,
        emails: [],
        reminders: [],
        loops: [],
        tomorrow: [],
        text: `${date}. Calendar and mail did not load. Open again in a minute.`,
        cardUrl: `${appBase(req)}/app/mini/${persona}/digest`,
      })
    }
  }

  if (path === '/api/work/next' && req.method === 'GET') {
    const persona = url.searchParams.get('persona') || ''
    if (!isPersona(persona)) return json({ error: 'persona required' }, 400)
    const { user, error } = await resolveAuthedUser(sql, {
      token: url.searchParams.get('t') || undefined,
      session: url.searchParams.get('s') || undefined,
      email: url.searchParams.get('email') || undefined,
    })
    if (error) return error
    try {
      return json(await buildNextStack(sql, user!, persona))
    } catch (err) {
      console.warn('[work/next] failed', err)
      return json({ items: [], connected: [], missing: ['gmail', 'calendar'], error: 'Could not load Next.' }, 200)
    }
  }

  if (path === '/api/mail/triage' && req.method === 'POST') {
    const body = (await req.json().catch(() => ({}))) as {
      token?: string; session?: string; email?: string
      id?: string; action?: string; sender?: string; kind?: string
    }
    const action = String(body.action || '')
    if (!['done', 'skip', 'drafted', 'opened', 'replied'].includes(action)) {
      return json({ error: 'action must be done, skip, drafted, opened, or replied' }, 400)
    }
    const { user, error } = await resolveAuthedUser(sql, { token: body.token, session: body.session, email: body.email })
    if (error) return error
    const gmailId = String(body.id || '').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 80)
    await sql`
      INSERT INTO hire_mail_feedback (user_id, gmail_id, sender, action, kind)
      VALUES (${user!.id}, ${gmailId}, ${String(body.sender || '').slice(0, 120)}, ${action}, ${String(body.kind || '').slice(0, 40)})
    `
    return json({ ok: true })
  }

  if (path === '/api/mail/draft' && req.method === 'POST') {
    const body = (await req.json().catch(() => ({}))) as {
      token?: string; session?: string; email?: string; persona?: string; id?: string
    }
    const msgId = String(body.id || '').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 80)
    if (!msgId) return json({ error: 'id required' }, 400)
    const { user, error } = await resolveAuthedUser(sql, { token: body.token, session: body.session, email: body.email })
    if (error) return error
    if (/^text-\d+$/.test(msgId)) {
      return json({ error: 'This one came from a text only fallback, so there is no message to reply to.' }, 404)
    }
    /* A reply needs a From address. Everything else — subject, a body to quote —
     * is nice to have, so each read below is allowed to contribute only what it
     * has and we stop as soon as an address turns up. The old version demanded a
     * full body read and refused to draft when a connector handed back headers
     * alone, which is the common Composio shape. */
    const reads: ReplyRead[] = []
    const access = await googleAccessToken(sql, user!.id, 'gmail')
    if (access) {
      const res = await fetch(
        `https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(msgId)}?format=full`,
        { headers: { Authorization: `Bearer ${access}` } },
      ).catch(() => null)
      if (res?.ok) {
        const data = (await res.json().catch(() => null)) as {
          snippet?: string
          payload?: GmailMimePart & { headers?: Array<{ name: string; value: string }> }
        } | null
        const h = (n: string) =>
          data?.payload?.headers?.find((x) => x.name.toLowerCase() === n.toLowerCase())?.value || ''
        reads.push({
          from: h('From'),
          subject: h('Subject'),
          bodyText: extractGmailBody(data?.payload).text,
          snippet: data?.snippet,
        })
      } else if (res) {
        console.warn('[mail/draft] gmail by-id returned', res.status, 'for', msgId)
      }
    }
    // Accounts that read Gmail through Composio have no direct token here; the
    // connector can still hand back the one message a reply needs.
    if (!pickReplyTarget(reads)) reads.push(await composioMailHeaders(user!.id, msgId))
    /* Last resort, and the one that saves a Gmail account whose by-id read 404s
     * because the id came out of a connector list: read the recent inbox the same
     * way the brief did and find the row again. */
    if (!pickReplyTarget(reads)) {
      const recent = await loadGmailRich(sql, user!.id, 'newer_than:14d', 25)
      reads.push(recent.find((m) => m.id === msgId))
    }
    const target = pickReplyTarget(reads)
    if (!target) {
      // Do not send them to the reader: it runs the same reads this just tried.
      return json(
        {
          error: reads.some((r) => r && (r.subject || r.snippet))
            ? 'This message has no reply address, so there is nobody to draft to.'
            : 'Gmail did not return this message, so there is nothing to reply to yet.',
        },
        404,
      )
    }
    const draftId = crypto.randomUUID()
    const quoted = target.original
      ? `\n\nThey wrote:\n${target.original.split(/\s+/).slice(0, 90).join(' ')}…`
      : ''
    /* The draft has to say something about the email, not just re-paste it:
     * Alpha writes the actual reply from the message content. A model that is
     * down, or that answers with a bare greeting or an echo of the original,
     * produces no draft at all — the old fallback saved "Hi <name>," plus the
     * quoted original, which is exactly the kind of draft a user sends by
     * accident. */
    const senderName = (user!.name || '').trim() || user!.email.split('@')[0]
    const firstName = senderName.split(/\s+/)[0] || 'me'
    let written = ''
    try {
      written = String(
        (await gmiBriefChat(
          `You are Alpha writing a reply email on behalf of ${senderName}. Reply to the email below on their behalf. Keep it natural, concise, and specific to what was said: answer any question, confirm or decline clearly, move it forward. Plain greeting, no bullet lists unless needed, close with a short signoff in their voice using the name ${firstName}, like "Best," then ${firstName} on the next line. Do not quote the original back. Never leave placeholders such as [Your Name]. Respond with ONLY the body text.`,
          `To: ${target.toAddr}\nSubject: ${target.subject}\n\nTheir email:\n${target.original || target.subject}\n\nWrite the reply body now.`,
          500,
          10000,
          { plainText: true },
        )) || '',
      ).trim()
    } catch (err) {
      console.warn('[mail/draft] model draft failed', err)
    }
    if (!isSubstantiveReply(written, target.original)) {
      return json(
        { ok: false, error: 'Alpha could not write this reply right now. Try again in a moment.' },
        502,
      )
    }
    const replyBody = `${fillDraftName(written, firstName)}${quoted}`.slice(0, 4000)
    await sql`
      INSERT INTO hire_drafts (id, user_id, persona, kind, to_addr, subject, body)
      VALUES (
        ${draftId}, ${user!.id}, ${isPersona(body.persona || '') ? body.persona! : ''},
        'reply', ${target.toAddr}, ${target.subject}, ${replyBody}
      )
    `
    await sql`
      INSERT INTO hire_mail_feedback (user_id, gmail_id, sender, action, kind)
      VALUES (${user!.id}, ${msgId}, ${target.toAddr}, 'drafted', '')
    `
    return json({ ok: true, id: draftId, toAddr: target.toAddr, subject: target.subject, body: replyBody })
  }

  if (path === '/api/mail/draft/rewrite' && req.method === 'POST') {
    const body = (await req.json().catch(() => ({}))) as {
      token?: string; session?: string; email?: string; id?: string; instruction?: string
    }
    const draftId = String(body.id || '').slice(0, 80)
    const instruction = String(body.instruction || '').trim()
    if (!draftId) return json({ error: 'id required' }, 400)
    if (!instruction) return json({ error: 'instruction required' }, 400)
    const { user, error } = await resolveAuthedUser(sql, {
      token: body.token, session: body.session, email: body.email,
    })
    if (error) return error
    const rows = await sql`
      SELECT to_addr, subject, body FROM hire_drafts
      WHERE id = ${draftId} AND user_id = ${user!.id} LIMIT 1
    `
    const row = rows[0] as { to_addr: string; subject: string; body: string } | undefined
    if (!row) return json({ error: 'Draft not found.' }, 404)
    /* The model signs with a real name or not at all: left unnamed it emits
     * "[Your Name]", which is exactly what users then send by accident. */
    const senderName = (user!.name || '').trim() || user!.email.split('@')[0]
    const firstName = senderName.split(/\s+/)[0] || 'me'
    const rewritten = await gmiBriefChat(
      `You are Alpha writing a reply email on behalf of ${senderName}. Rewrite the draft body to follow the user's instruction. Keep it a natural, concise email reply with a plain greeting, and close with a short signoff in their voice using the name ${firstName}, like "Best," then ${firstName} on the next line. Never leave placeholders such as [Your Name]. Respond with ONLY the new body text — no preamble, labels, or quoting.`,
      `To: ${row.to_addr}\nSubject: ${row.subject}\n\nCurrent draft:\n${row.body}\n\nUser instruction: ${instruction}\n\nRewrite the draft body now.`,
      500,
      8000,
      { plainText: true },
    )
    if (!rewritten?.trim()) {
      return json({ ok: false, error: 'Alpha could not rewrite that right now. Try again.' }, 502)
    }
    const signed = fillDraftName(rewritten.trim(), firstName)
    await sql`UPDATE hire_drafts SET body = ${signed}, updated_at = now() WHERE id = ${draftId} AND user_id = ${user!.id}`
    return json({ ok: true, body: signed })
  }

  if (path === '/api/reminders/action' && req.method === 'POST') {
    const body = (await req.json().catch(() => ({}))) as {
      token?: string; session?: string; email?: string; id?: string; action?: string; hours?: number
    }
    const remId = String(body.id || '').slice(0, 80)
    if (!remId) return json({ error: 'id required' }, 400)
    const { user, error } = await resolveAuthedUser(sql, { token: body.token, session: body.session, email: body.email })
    if (error) return error
    if (body.action === 'done') {
      await sql`
        UPDATE hire_reminders SET status = 'sent', updated_at = now()
        WHERE id = ${remId} AND user_id = ${user!.id}
      `
      return json({ ok: true })
    }
    if (body.action === 'snooze') {
      const hours = Number(body.hours) > 0 ? Number(body.hours) : 1
      await sql`
        UPDATE hire_reminders SET scheduled_at = now() + (${hours} * interval '1 hour'), updated_at = now()
        WHERE id = ${remId} AND user_id = ${user!.id}
      `
      return json({ ok: true })
    }
    return json({ error: 'action must be done or snooze' }, 400)
  }

  if (path === '/api/prep' && req.method === 'POST') {
    const body = (await req.json().catch(() => ({}))) as {
      token?: string; session?: string; email?: string; name?: string
    }
    const query = String(body.name || '').trim().slice(0, 80)
    if (!query) return json({ error: 'name required' }, 400)
    const { user, error } = await resolveAuthedUser(sql, { token: body.token, session: body.session, email: body.email })
    if (error) return error
    const bundle = await buildPrepBundle(
      sql,
      { id: user!.id, name: user!.name, timezone: user!.timezone },
      query,
    )
    if (!bundle) return json({ ok: false, text: '' })
    return json({ ok: true, ...bundle })
  }

  if (path === '/api/work/drafts' && req.method === 'GET') {
    const persona = url.searchParams.get('persona') || ''
    const kind = url.searchParams.get('kind') || ''
    const { user, error } = await resolveAuthedUser(sql, {
      token: url.searchParams.get('t') || undefined,
      session: url.searchParams.get('s') || undefined,
      email: url.searchParams.get('email') || undefined,
    })
    if (error) return error
    const connected = await connectedForUser(sql, user!.id)
    /* Suggested drafts used to pile up forever: an empty-body suggestion stayed
     * "pending" after its email left the inbox window, and concurrent page
     * loads raced the "no pending drafts" check below and inserted the same
     * batch twice, which is how a quiet inbox showed eleven drafts. Expire
     * stale suggestions first, and never write a suggestion that already has a
     * pending twin. */
    await sql`
      UPDATE hire_drafts SET status = 'canceled', updated_at = now()
      WHERE user_id = ${user!.id} AND kind = 'email' AND status = 'pending'
        AND body = '' AND created_at < now() - interval '7 days'
    `
    const drafts = (await sql`
      SELECT id, kind, to_addr AS "toAddr", subject, body, status, created_at AS "createdAt",
        thread_id AS "threadId", in_reply_to AS "inReplyTo", start_at AS "startAt", end_at AS "endAt"
      FROM hire_drafts WHERE user_id = ${user!.id}
      ${kind ? sql`AND kind = ${kind}` : sql``}
      ORDER BY created_at DESC LIMIT 20
    `) as Array<{
      id: string; kind: string; toAddr: string; subject: string; body: string; status: string; createdAt: Date
      threadId?: string; inReplyTo?: string; startAt?: string; endAt?: string
    }>
    let rows = drafts.filter((d) => !isAutomatedSender(d.toAddr) && !isAutomatedSubject(d.subject))
    if (kind !== 'event' && !rows.some((d) => d.status === 'pending')) {
      const suggested = await suggestedMailDrafts(sql, user!.id)
      for (const s of suggested) {
        // One atomic statement: concurrent page loads each pass the
        // "no pending drafts" check above, so the twin check must live
        // inside the insert or the pile grows again.
        const id = crypto.randomUUID()
        const inserted = await sql`
          INSERT INTO hire_drafts (id, user_id, persona, kind, to_addr, subject, body)
          SELECT ${id}, ${user!.id}, ${isPersona(persona) ? persona : ''}, 'email', ${s.toAddr}, ${s.subject}, ${s.body}
          WHERE NOT EXISTS (
            SELECT 1 FROM hire_drafts
            WHERE user_id = ${user!.id} AND status = 'pending'
              AND lower(to_addr) = lower(${s.toAddr}) AND lower(subject) = lower(${s.subject})
          )
          RETURNING id
        `
        if (!inserted.length) continue
      }
      if (suggested.length) {
        rows = (await sql`
          SELECT id, kind, to_addr AS "toAddr", subject, body, status, created_at AS "createdAt",
            thread_id AS "threadId", in_reply_to AS "inReplyTo", start_at AS "startAt", end_at AS "endAt"
          FROM hire_drafts WHERE user_id = ${user!.id}
          ORDER BY created_at DESC LIMIT 20
        `) as typeof drafts
      }
    }
    const investorDraft = kind === 'investor' || persona === 'cofounder'
      ? { subject: 'Investor update', body: await investorNoteBody(sql, user!.id) }
      : undefined
    return json({
      drafts: rows,
      needConnect: !connected.includes('gmail'),
      investorDraft,
    })
  }

  if (path === '/api/work/drafts' && req.method === 'POST') {
    const body = (await req.json().catch(() => ({}))) as {
      token?: string; session?: string; email?: string; persona?: string
      kind?: string; toAddr?: string; subject?: string; body?: string
    }
    const { user, error } = await resolveAuthedUser(sql, { token: body.token, session: body.session, email: body.email })
    if (error) return error
    const id = crypto.randomUUID()
    await sql`
      INSERT INTO hire_drafts (id, user_id, persona, kind, to_addr, subject, body)
      VALUES (
        ${id}, ${user!.id}, ${isPersona(body.persona || '') ? body.persona! : ''},
        ${String(body.kind || 'email').slice(0, 40)},
        ${String(body.toAddr || '').slice(0, 200)},
        ${String(body.subject || '').slice(0, 200)},
        ${String(body.body || '').slice(0, 8000)}
      )
    `
    return json({ ok: true, id })
  }

  if (path === '/api/work/send' && req.method === 'POST') {
    const body = (await req.json().catch(() => ({}))) as {
      token?: string; session?: string; email?: string; id?: string
      toAddr?: string; subject?: string; body?: string
    }
    const { user, error } = await resolveAuthedUser(sql, { token: body.token, session: body.session, email: body.email })
    if (error) return error
    let toAddr = String(body.toAddr || '').trim()
    let subject = String(body.subject || '').trim()
    let text = String(body.body || '')
    let threadId = ''
    let inReplyTo = ''
    if (body.id) {
      const rows = await sql`
        SELECT to_addr, subject, body, thread_id, in_reply_to FROM hire_drafts WHERE id = ${body.id} AND user_id = ${user!.id} LIMIT 1
      `
      const row = rows[0] as {
        to_addr: string; subject: string; body: string; thread_id?: string; in_reply_to?: string
      } | undefined
      if (row) {
        toAddr = toAddr || row.to_addr
        subject = subject || row.subject
        text = text || row.body
        threadId = row.thread_id || ''
        inReplyTo = row.in_reply_to || ''
      }
    }
    if (!toAddr || !subject) return json({ ok: false, error: 'To and subject required' }, 400)
    const sent = await gmailSendMessage(sql, user!.id, {
      to: toAddr,
      subject,
      body: text,
      threadId: threadId || undefined,
      inReplyTo: inReplyTo || undefined,
    })
    if (!sent.ok) return json({ ok: false, error: sent.error }, 400)
    if (body.id) {
      await sql`UPDATE hire_drafts SET status = 'sent', updated_at = now() WHERE id = ${body.id} AND user_id = ${user!.id}`
    }
    return json({ ok: true })
  }

  /* Save the draft into Gmail's Drafts folder. Deliberately a different path
   * from /api/work/send: nothing here can transmit, so the compose screen's
   * safe default action can never fire an email. */
  if (path === '/api/work/draft/save' && req.method === 'POST') {
    const body = (await req.json().catch(() => ({}))) as {
      token?: string; session?: string; email?: string; id?: string
      toAddr?: string; subject?: string; body?: string
    }
    const { user, error } = await resolveAuthedUser(sql, { token: body.token, session: body.session, email: body.email })
    if (error) return error
    let toAddr = String(body.toAddr || '').trim()
    let subject = String(body.subject || '').trim()
    let text = String(body.body || '')
    let threadId = ''
    if (body.id) {
      const rows = await sql`
        SELECT to_addr, subject, body, thread_id FROM hire_drafts WHERE id = ${body.id} AND user_id = ${user!.id} LIMIT 1
      `
      const row = rows[0] as { to_addr: string; subject: string; body: string; thread_id?: string } | undefined
      if (row) {
        toAddr = toAddr || row.to_addr
        subject = subject || row.subject
        text = text || row.body
        threadId = row.thread_id || ''
      }
    }
    if (!toAddr) return json({ ok: false, error: 'To is required' }, 400)
    const saved = await gmailCreateDraft(sql, user!.id, {
      to: toAddr,
      subject,
      body: text,
      threadId: threadId || undefined,
    })
    if (!saved.ok) return json({ ok: false, error: saved.error }, 400)
    if (body.id) {
      await sql`UPDATE hire_drafts SET status = 'saved', updated_at = now() WHERE id = ${body.id} AND user_id = ${user!.id}`
    }
    return json({ ok: true })
  }

  if (path === '/api/work/slots' && req.method === 'GET') {
    const { user, error } = await resolveAuthedUser(sql, {
      token: url.searchParams.get('t') || undefined,
      session: url.searchParams.get('s') || undefined,
      email: url.searchParams.get('email') || undefined,
    })
    if (error) return error
    const connected = await connectedForUser(sql, user!.id)
    const slots = connected.includes('calendar')
      ? await findFreeSlots(sql, user!.id, user!.timezone || 'America/Los_Angeles')
      : []
    return json({ slots, needConnect: !connected.includes('calendar') })
  }

  if (path === '/api/work/hold' && req.method === 'POST') {
    const body = (await req.json().catch(() => ({}))) as {
      token?: string; email?: string; session?: string; title?: string; start?: string; end?: string; id?: string
    }
    const { user, error } = await resolveAuthedUser(sql, { token: body.token, session: body.session, email: body.email })
    if (error) return error
    let title = String(body.title || 'Hold').slice(0, 160)
    let start = String(body.start || '')
    let end = String(body.end || '')
    if (body.id) {
      const rows = await sql`
        SELECT subject, start_at, end_at FROM hire_drafts WHERE id = ${body.id} AND user_id = ${user!.id} LIMIT 1
      `
      const row = rows[0] as { subject?: string; start_at?: string; end_at?: string } | undefined
      if (row) {
        title = title === 'Hold' ? String(row.subject || title) : title
        start = start || String(row.start_at || '')
        end = end || String(row.end_at || '')
      }
    }
    if (!start || !end) return json({ ok: false, error: 'start and end required' }, 400)
    const held = await calendarHold(sql, user!.id, { title, start, end })
    if (held.ok && body.id) {
      await sql`UPDATE hire_drafts SET status = 'sent', updated_at = now() WHERE id = ${body.id} AND user_id = ${user!.id}`
    }
    return json(held, held.ok ? 200 : 400)
  }

  if (path === '/api/work/linear' && req.method === 'GET') {
    const { user, error } = await resolveAuthedUser(sql, {
      token: url.searchParams.get('t') || undefined,
      session: url.searchParams.get('s') || undefined,
      email: url.searchParams.get('email') || undefined,
    })
    if (error) return error
    const connected = await connectedForUser(sql, user!.id)
    if (!connected.includes('linear')) return json({ issues: [], needConnect: true })
    const lin = await listLinearIssues(user!.id)
    return json({ issues: lin.issues, needConnect: lin.needConnect })
  }

  if (path === '/api/work/linear' && req.method === 'POST') {
    const body = (await req.json().catch(() => ({}))) as {
      token?: string; email?: string; id?: string; action?: string
    }
    const { user, error } = await resolveAuthedUser(sql, { token: body.token, session: body.session, email: body.email })
    if (error) return error
    const id = String(body.id || '')
    const action = body.action === 'done' || body.action === 'cancel' ? body.action : 'later'
    if (!id) return json({ ok: false, error: 'id required' }, 400)
    const ok = await linearWrite(user!.id, id, action)
    return json({ ok, error: ok ? undefined : 'Linear did not update. Check the connector.' }, ok ? 200 : 400)
  }

  if (path === '/api/work/rsvp' && req.method === 'POST') {
    const body = (await req.json().catch(() => ({}))) as {
      token?: string; email?: string; eventId?: string; response?: string
    }
    const { user, error } = await resolveAuthedUser(sql, { token: body.token, session: body.session, email: body.email })
    if (error) return error
    const eventId = String(body.eventId || '')
    if (!eventId) return json({ ok: false, error: 'eventId required' }, 400)
    const access = await googleAccessToken(sql, user!.id, 'calendar')
    if (!access) return json({ ok: false, error: 'Calendar is not connected.' }, 400)
    const res = await fetch(
      `https://www.googleapis.com/calendar/v3/calendars/primary/events/${encodeURIComponent(eventId)}?sendUpdates=all`,
      {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${access}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          attendees: [{ email: user!.email, responseStatus: body.response === 'declined' ? 'declined' : 'accepted' }],
        }),
      },
    )
    return json({ ok: res.ok, error: res.ok ? undefined : `RSVP failed (${res.status}).` }, res.ok ? 200 : 400)
  }

  if (path === '/api/work/day' && req.method === 'GET') {
    const persona = url.searchParams.get('persona') || 'coworker'
    const { user, error } = await resolveAuthedUser(sql, {
      token: url.searchParams.get('t') || undefined,
      session: url.searchParams.get('s') || undefined,
      email: url.searchParams.get('email') || undefined,
    })
    if (error) return error
    const tz = user!.timezone || 'America/Los_Angeles'
    const events = await googleEventsRaw(sql, user!.id, {
      timeMin: startOfLocalDay(tz),
      timeMax: startOfLocalDay(tz, 1),
      maxResults: 12,
    })
    return json({
      events: events.map((e) => ({
        id: e.id,
        title: e.title,
        start: e.start,
        label: e.allDay ? 'All day' : localHourParts(e.start, tz),
      })),
    })
  }

  if (path === '/api/mini' && req.method === 'GET') {
    const t = url.searchParams.get('t') || ''
    const email = String(url.searchParams.get('email') || '')
      .trim()
      .toLowerCase()
    const persona = url.searchParams.get('persona') || ''
    const kind = url.searchParams.get('kind') || ''
    if (!isPersona(persona) || !kind) return json({ error: 'persona and kind required' }, 400)
    let user: { id: string; email: string; name: string | null; timezone: string | null; phone: string | null } | null =
      null
    if (t) {
      const tok = verifyMiniToken(t)
      if (!tok || tok.persona !== persona) {
        return json({ error: 'This link expired. Sign in to keep using it.', code: 'token_invalid' }, 401)
      }
      user = await getUserByPhone(sql, tok.phone)
    } else if (email.includes('@')) {
      user = await getUserByEmail(sql, email)
    } else {
      return json({ error: 'email required' }, 400)
    }
    if (!user) return json({ error: 'No account found for that phone/email' }, 404)
    /* The evening brief is the one mini heavy enough to be worth caching: a
     * two-day calendar range, an inbox pull, and a model pass. The rest are a
     * query or two and are cheaper to just run. */
    if (kind === 'pick_night') {
      const day = localDateStrInTz(new Date(), user!.timezone || 'America/Los_Angeles')
      const brief = await eveningCache.read(`${user!.id}|${persona}`, () =>
        briefLoader(sql, user!.id, persona, 'pick_night', () => miniPayload(sql, user!, persona, 'pick_night'), day),
      )
      if (!brief.value && brief.pending) {
        // Still loading behind this response. Never cached, or the retry reads it.
        return json({ pending: true, note: 'Closing out your day.' }, 200)
      }
      /* Nothing cached and nothing running: the build failed, or is inside the
       * failure cooldown. Only `pending` earns a retry — the ladder is shorter
       * than the cooldown, so promising one here would just stall and then lie. */
      if (!brief.value) {
        return json({ error: 'Your evening brief did not build. Open again in a minute.' }, 200)
      }
      // A stale hit refreshing behind the response must not come from the browser
      // cache next open, or that refresh would never be seen.
      return jsonRevalidated(req, brief.pending ? 0 : 120, brief.value)
    }
    return json(await miniPayload(sql, user, persona, kind))
  }

  if (path === '/api/setup/status' && req.method === 'GET') {
    const persona = url.searchParams.get('persona') || ''
    if (!isPersona(persona)) return json({ error: 'persona required' }, 400)
    const { user, error } = await resolveAuthedUser(sql, {
      token: url.searchParams.get('t') || undefined,
      session: url.searchParams.get('s') || undefined,
      email: url.searchParams.get('email') || undefined,
    })
    if (error) return error
    const fields = await loadContext(sql, user!.id, persona)
    const setup = parseSetupField(fields.setup)
    return json({ setup, setupDone: fields.setup_done === true || fields.setup_done === 'true' })
  }

  if (path === '/api/setup' && req.method === 'POST') {
    const body = (await req.json().catch(() => ({}))) as {
      email?: string
      token?: string
      persona?: string
      feature?: string
      features?: unknown
      done?: boolean
    }
    const persona = body.persona || ''
    if (!isPersona(persona)) return json({ error: 'persona required' }, 400)

    const requested = Array.isArray(body.features)
      ? body.features.map(String)
      : body.feature
        ? [body.feature]
        : []
    if (body.done !== true && requested.length === 0) {
      return json({ error: 'feature or features required' }, 400)
    }
    for (const f of requested) {
      if (!PERSONA_MINI_APPS[persona].includes(f)) {
        return json({ error: `Unknown feature for this hire: ${f}` }, 400)
      }
    }

    const { user, error } = await resolveAuthedUser(sql, { token: body.token, session: body.session, email: body.email })
    if (error) return error

    const fields = await loadContext(sql, user!.id, persona)
    const existing = parseSetupField(fields.setup)
    const next =
      body.done === true && requested.length > 0
        ? [...new Set(requested)]
        : body.done === true && requested.length === 0
          ? existing
          : [...new Set([...existing, ...requested])]
    const setupDone = body.done === true || fields.setup_done === true || fields.setup_done === 'true'
    await sql`
      INSERT INTO hire_context (user_id, persona, fields, updated_at)
      VALUES (${user!.id}, ${persona}, ${JSON.stringify({ ...fields, setup: next, setup_done: setupDone })}, now())
      ON CONFLICT (user_id, persona)
      DO UPDATE SET fields = ${JSON.stringify({ ...fields, setup: next, setup_done: setupDone })}, updated_at = now()
    `

    if (next.includes('digest')) {
      const tz = user!.timezone || 'America/Los_Angeles'
      const existingReminder = await sql`
        SELECT id FROM hire_reminders
        WHERE user_id = ${user!.id} AND persona = ${persona} AND recurrence = 'daily'
          AND text LIKE '[digest]%' LIMIT 1
      `
      if (!existingReminder[0]) {
        await sql`
          INSERT INTO hire_reminders (id, user_id, persona, text, scheduled_at, recurrence, timezone, status)
          VALUES (${crypto.randomUUID()}, ${user!.id}, ${persona}, '[digest]Daily brief',
            ${nextLocalTimeUtc(tz, 8, 0)}, 'daily', ${tz}, 'pending')
        `
      }
      await sql`
        DELETE FROM hire_reminders
        WHERE user_id = ${user!.id} AND persona = ${persona} AND text = ${JUDGE_MARKER + 'morning'}
      `
    }

    return json({ ok: true, features: requested, setup: next, setupDone })
  }

  // Phone lookup for the hires' own clients: every task loop on the number,
  // across all personas. The authed branch below stays for the dashboard.
  if (path === '/api/loops' && req.method === 'GET' && url.searchParams.has('phone')) {
    const phone = normalizePhone(url.searchParams.get('phone') || '')
    if (!phone) return json({ error: 'valid phone required' }, 400)
    const rows = await sql`
      SELECT id, persona, kind, title, payload, status, next_run AS "nextRun",
             last_result AS "lastResult", created_at AS "createdAt"
      FROM hire_task_loops WHERE phone_e164 = ${phone}
      ORDER BY created_at DESC LIMIT 50
    `
    return json({ loops: rows })
  }

  if (path === '/api/loops' && req.method === 'GET') {
    const { user, error } = await resolveAuthedUser(sql, {
      token: url.searchParams.get('t') || undefined,
      session: url.searchParams.get('s') || undefined,
      email: url.searchParams.get('email') || undefined,
    })
    if (error) return error
    const rows = await sql`
      SELECT id, persona, title, context, due_at AS "dueAt", status,
             created_at AS "createdAt"
      FROM hire_loops WHERE user_id = ${user!.id}
      ORDER BY (status = 'open') DESC, created_at DESC LIMIT 50
    `
    return json({ loops: rows })
  }

  if (path === '/api/loops' && req.method === 'POST') {
    const body = (await req.json().catch(() => ({}))) as {
      token?: string; email?: string; persona?: string
      title?: string; context?: string; dueAt?: string
      phone?: string; kind?: string; payload?: unknown; next_run?: string
    }
    // A body with a phone creates a proactive task loop for that hire; the
    // dashboard flow below keeps its email/token auth.
    if (body.phone) {
      const phone = normalizePhone(body.phone)
      const kind = String(body.kind || '').trim().slice(0, 60)
      if (!phone || !kind) return json({ error: 'valid phone and kind required' }, 400)
      const user = await getUserByPhone(sql, phone)
      if (!user) return json({ error: 'User not found' }, 404)
      const when = new Date(String(body.next_run || ''))
      const nextRun = Number.isNaN(when.getTime()) ? null : when.toISOString()
      const id = crypto.randomUUID()
      await sql`
        INSERT INTO hire_task_loops (id, user_id, persona, phone_e164, kind, title, payload, status, next_run)
        VALUES (${id}, ${user.id}, ${isPersona(body.persona || '') ? body.persona! : 'friend'},
          ${phone}, ${kind}, ${String(body.title || '').slice(0, 200)},
          ${JSON.stringify(body.payload ?? {})}::jsonb, 'pending', ${nextRun})
        ON CONFLICT (user_id, persona, kind) DO UPDATE SET
          title = excluded.title,
          payload = excluded.payload,
          status = 'pending',
          next_run = COALESCE(excluded.next_run, hire_task_loops.next_run),
          updated_at = now()
      `
      return json({ ok: true, id })
    }
    const title = String(body.title || '').trim().slice(0, 200)
    if (!title) return json({ error: 'title required' }, 400)
    const { user, error } = await resolveAuthedUser(sql, { token: body.token, session: body.session, email: body.email })
    if (error) return error
    const id = crypto.randomUUID()
    const dueAt = parseFlexibleWhen(body.dueAt, user!.timezone || 'America/Los_Angeles')
    await sql`
      INSERT INTO hire_loops (id, user_id, persona, title, context, due_at)
      VALUES (${id}, ${user!.id}, ${isPersona(body.persona || '') ? body.persona! : ''},
        ${title}, ${String(body.context || '').slice(0, 500)},
        ${dueAt})
    `
    return json({ ok: true, id })
  }

  const loopToggle = path.match(/^\/api\/loops\/([^/]+)\/(pause|resume)$/)
  if (loopToggle && req.method === 'POST') {
    const body = (await req.json().catch(() => ({}))) as { phone?: string }
    const phone = normalizePhone(body.phone || '')
    if (!phone) return json({ error: 'valid phone required' }, 400)
    const rows = (await sql`
      SELECT phone_e164 AS phone FROM hire_task_loops WHERE id = ${loopToggle[1]!} LIMIT 1
    `) as Array<{ phone: string }>
    const loop = rows[0]
    if (!loop || !phonesMatch(loop.phone, phone)) return json({ error: 'Loop not found' }, 404)
    if (loopToggle[2] === 'pause') {
      await sql`
        UPDATE hire_task_loops SET status = 'paused', updated_at = now()
        WHERE id = ${loopToggle[1]!}
      `
    } else {
      // Resume means run again on the next claim pass, so bump next_run.
      await sql`
        UPDATE hire_task_loops SET status = 'pending', next_run = now(), updated_at = now()
        WHERE id = ${loopToggle[1]!}
      `
    }
    return json({ ok: true })
  }

  if (path.startsWith('/api/loops/') && req.method === 'PATCH') {
    const id = path.slice('/api/loops/'.length)
    const body = (await req.json().catch(() => ({}))) as {
      token?: string; email?: string; status?: string; dueAt?: string
    }
    const status = body.status === 'done' || body.status === 'snoozed' ? body.status : 'open'
    const { user, error } = await resolveAuthedUser(sql, { token: body.token, session: body.session, email: body.email })
    if (error) return error
    const dueAt = body.dueAt
      ? parseFlexibleWhen(body.dueAt, user!.timezone || 'America/Los_Angeles')
      : undefined
    if (dueAt) {
      await sql`
        UPDATE hire_loops SET status = ${status}, due_at = ${dueAt}, updated_at = now()
        WHERE id = ${id} AND user_id = ${user!.id}
      `
    } else {
      await sql`
        UPDATE hire_loops SET status = ${status}, updated_at = now()
        WHERE id = ${id} AND user_id = ${user!.id}
      `
    }
    return json({ ok: true })
  }

  if (path === '/api/decisions' && req.method === 'GET') {
    const { user, error } = await resolveAuthedUser(sql, {
      token: url.searchParams.get('t') || undefined,
      session: url.searchParams.get('s') || undefined,
      email: url.searchParams.get('email') || undefined,
    })
    if (error) return error
    const rows = await sql`
      SELECT id, persona, decision, reason, evidence, owner, review_at AS "reviewAt",
             outcome, status, created_at AS "createdAt"
      FROM hire_decisions WHERE user_id = ${user!.id}
      ORDER BY created_at DESC LIMIT 50
    `
    return json({ decisions: rows })
  }

  if (path === '/api/decisions' && req.method === 'POST') {
    const body = (await req.json().catch(() => ({}))) as {
      token?: string; email?: string; persona?: string
      decision?: string; reason?: string; evidence?: string; owner?: string; reviewAt?: string
    }
    const decision = String(body.decision || '').trim().slice(0, 300)
    if (!decision) return json({ error: 'decision required' }, 400)
    const { user, error } = await resolveAuthedUser(sql, { token: body.token, session: body.session, email: body.email })
    if (error) return error
    const id = crypto.randomUUID()
    const reviewAt = parseFlexibleWhen(body.reviewAt, user!.timezone || 'America/Los_Angeles')
    await sql`
      INSERT INTO hire_decisions (id, user_id, persona, decision, reason, evidence, owner, review_at)
      VALUES (${id}, ${user!.id}, ${isPersona(body.persona || '') ? body.persona! : 'cofounder'},
        ${decision}, ${String(body.reason || '').slice(0, 500)}, ${String(body.evidence || '').slice(0, 500)},
        ${String(body.owner || '').slice(0, 120)}, ${reviewAt})
    `
    return json({ ok: true, id })
  }

  if (path.startsWith('/api/decisions/') && req.method === 'PATCH') {
    const id = path.slice('/api/decisions/'.length)
    const body = (await req.json().catch(() => ({}))) as { token?: string; email?: string; outcome?: string }
    const { user, error } = await resolveAuthedUser(sql, { token: body.token, session: body.session, email: body.email })
    if (error) return error
    await sql`
      UPDATE hire_decisions
      SET outcome = ${String(body.outcome || '').slice(0, 500)},
          status = 'reviewed', updated_at = now()
      WHERE id = ${id} AND user_id = ${user!.id}
    `
    return json({ ok: true })
  }

  if (path === '/api/relationships' && req.method === 'GET') {
    const { user, error } = await resolveAuthedUser(sql, {
      token: url.searchParams.get('t') || undefined,
      session: url.searchParams.get('s') || undefined,
      email: url.searchParams.get('email') || undefined,
    })
    if (error) return error
    const rows = await sql`
      SELECT id, name, where_met AS kind, context AS notes, cadence_days AS "cadenceDays",
             last_touch AS "lastTouchAt", created_at AS "updatedAt"
      FROM hire_network WHERE user_id = ${user!.id}
      ORDER BY last_touch ASC NULLS FIRST LIMIT 60
    `
    return json({ relationships: rows })
  }

  if (path === '/api/relationships' && req.method === 'POST') {
    const body = (await req.json().catch(() => ({}))) as {
      token?: string; email?: string
      name?: string; kind?: string; notes?: string; cadenceDays?: number
    }
    const name = String(body.name || '').trim().slice(0, 120)
    if (!name) return json({ error: 'name required' }, 400)
    const kind = ['personal', 'work', 'investor', 'candidate', 'partner', 'other'].includes(body.kind || '')
      ? body.kind!
      : 'other'
    const { user, error } = await resolveAuthedUser(sql, { token: body.token, session: body.session, email: body.email })
    if (error) return error
    const id = crypto.randomUUID()
    await sql`
      INSERT INTO hire_network (id, user_id, name, where_met, context, cadence_days)
      VALUES (${id}, ${user!.id}, ${name}, ${kind}, ${String(body.notes || '').slice(0, 500)},
        ${Math.min(Math.max(clampNum(body.cadenceDays, 30), 1), 365)})
    `
    return json({ ok: true, id })
  }

  if (path.startsWith('/api/relationships/') && req.method === 'PATCH') {
    const id = path.slice('/api/relationships/'.length)
    const body = (await req.json().catch(() => ({}))) as { token?: string; email?: string; touch?: boolean }
    const { user, error } = await resolveAuthedUser(sql, { token: body.token, session: body.session, email: body.email })
    if (error) return error
    if (body.touch) {
      await sql`
        UPDATE hire_network SET last_touch = now()
        WHERE id = ${id} AND user_id = ${user!.id}
      `
    }
    return json({ ok: true })
  }

  if (path === '/api/dropzone' && req.method === 'GET') {
    const { user, error } = await resolveAuthedUser(sql, {
      token: url.searchParams.get('t') || undefined,
      session: url.searchParams.get('s') || undefined,
      email: url.searchParams.get('email') || undefined,
    })
    if (error) return error
    const rows = await sql`
      SELECT id, persona, content, media_kind AS "mediaKind", summary, status,
             created_at AS "createdAt"
      FROM hire_dropzone WHERE user_id = ${user!.id}
      ORDER BY created_at DESC LIMIT 50
    `
    return json({ drops: rows })
  }

  if (path === '/api/dropzone' && req.method === 'POST') {
    const body = (await req.json().catch(() => ({}))) as {
      token?: string; email?: string; content?: string; mediaKind?: string
    }
    const content = String(body.content || '').trim().slice(0, 2000)
    if (!content) return json({ error: 'content required' }, 400)
    const { user, error } = await resolveAuthedUser(sql, { token: body.token, session: body.session, email: body.email })
    if (error) return error
    const id = crypto.randomUUID()
    const mediaKind = ['image', 'voice', 'link', 'text'].includes(body.mediaKind || '') ? body.mediaKind! : null
    await sql`
      INSERT INTO hire_dropzone (id, user_id, persona, content, media_kind)
      VALUES (${id}, ${user!.id}, '', ${content}, ${mediaKind})
    `
    return json({ ok: true, id })
  }

  if (path.startsWith('/api/dropzone/') && req.method === 'PATCH') {
    const id = path.slice('/api/dropzone/'.length)
    const body = (await req.json().catch(() => ({}))) as {
      token?: string; email?: string; persona?: string; summary?: string; status?: string
    }
    const { user, error } = await resolveAuthedUser(sql, { token: body.token, session: body.session, email: body.email })
    if (error) return error
    const status = ['new', 'routed', 'done'].includes(body.status || '') ? body.status! : undefined
    await sql`
      UPDATE hire_dropzone
      SET persona = COALESCE(${isPersona(body.persona || '') ? body.persona! : null}, persona),
          summary = COALESCE(${body.summary ? String(body.summary).slice(0, 500) : null}, summary),
          status = COALESCE(${status || null}, status)
      WHERE id = ${id} AND user_id = ${user!.id}
    `
    return json({ ok: true })
  }

  if (path === '/api/meetings' && req.method === 'GET') {
    const { user, error } = await resolveAuthedUser(sql, {
      token: url.searchParams.get('t') || undefined,
      session: url.searchParams.get('s') || undefined,
      email: url.searchParams.get('email') || undefined,
    })
    if (error) return error
    const rows = await sql`
      SELECT id, title, starts_at AS "startsAt", phase, briefing, notes, followups,
             created_at AS "createdAt"
      FROM hire_meetings WHERE user_id = ${user!.id}
      ORDER BY created_at DESC LIMIT 30
    `
    return json({ meetings: rows })
  }

  if (path === '/api/meetings' && req.method === 'POST') {
    const body = (await req.json().catch(() => ({}))) as {
      token?: string; email?: string; title?: string; startsAt?: string
    }
    const title = String(body.title || '').trim().slice(0, 200)
    if (!title) return json({ error: 'title required' }, 400)
    const { user, error } = await resolveAuthedUser(sql, { token: body.token, session: body.session, email: body.email })
    if (error) return error
    const id = crypto.randomUUID()
    const startsAt = parseFlexibleWhen(body.startsAt, user!.timezone || 'America/Los_Angeles')
    await sql`
      INSERT INTO hire_meetings (id, user_id, title, starts_at)
      VALUES (${id}, ${user!.id}, ${title}, ${startsAt})
    `
    return json({ ok: true, id })
  }

  if (path.startsWith('/api/meetings/') && req.method === 'PATCH') {
    const id = path.slice('/api/meetings/'.length)
    const body = (await req.json().catch(() => ({}))) as {
      token?: string; email?: string; briefing?: string
      followups?: unknown; phase?: string
    }
    const { user, error } = await resolveAuthedUser(sql, { token: body.token, session: body.session, email: body.email })
    if (error) return error
    const phase = body.phase === 'done' ? 'done' : body.phase === 'prep' ? 'prep' : undefined
    await sql`
      UPDATE hire_meetings
      SET briefing = COALESCE(${body.briefing ? String(body.briefing).slice(0, 2000) : null}, briefing),
          followups = COALESCE(${Array.isArray(body.followups) ? JSON.stringify(body.followups).slice(0, 4000) : null}::jsonb, followups),
          phase = COALESCE(${phase || null}, phase),
          updated_at = now()
      WHERE id = ${id} AND user_id = ${user!.id}
    `
    return json({ ok: true })
  }

  if (path.startsWith('/api/meetings/') && req.method === 'DELETE') {
    const id = path.slice('/api/meetings/'.length)
    const body = (await req.json().catch(() => ({}))) as { token?: string; email?: string }
    const { user, error } = await resolveAuthedUser(sql, { token: body.token, session: body.session, email: body.email })
    if (error) return error
    await sql`DELETE FROM hire_meetings WHERE id = ${id} AND user_id = ${user!.id}`
    return json({ ok: true })
  }

  if (path.startsWith('/api/meetings/') && path.endsWith('/transcribe') && req.method === 'POST') {
    const id = path.slice('/api/meetings/'.length, -'/transcribe'.length)
    const body = (await req.json({ maxSize: 24 * 1024 * 1024 }).catch(() => ({}))) as {
      token?: string; email?: string; audioBase64?: string; mimeType?: string
    }
    const audio = body.audioBase64 ? Buffer.from(body.audioBase64, 'base64') : null
    if (!audio || audio.length < 512) return json({ error: 'voice memo is required' }, 400)
    const { user, error } = await resolveAuthedUser(sql, { token: body.token, session: body.session, email: body.email })
    if (error) return error
    const meets = await sql`SELECT id FROM hire_meetings WHERE id = ${id} AND user_id = ${user!.id} LIMIT 1`
    if (!meets[0]) return json({ error: 'Meeting not found' }, 404)
    let transcript: string
    try {
      const { text } = await transcribeAudio(body.mimeType || 'audio/m4a', audio)
      transcript = text
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      return json({ ok: false, error: msg.slice(0, 200) }, 502)
    }
    const cur = await sql`SELECT notes FROM hire_meetings WHERE id = ${id} LIMIT 1`
    const prev = String((cur[0] as { notes?: string } | undefined)?.notes || '').trim()
    const notes = prev ? `${prev}\n\n${transcript}` : transcript
    await sql`
      UPDATE hire_meetings
      SET notes = ${notes.slice(0, 6000)}, updated_at = now()
      WHERE id = ${id} AND user_id = ${user!.id}
    `
    return json({ ok: true, transcript })
  }

  if (path === '/api/nutrition' && req.method === 'GET') {
    const { user, error } = await resolveAuthedUser(sql, {
      token: url.searchParams.get('t') || undefined,
      session: url.searchParams.get('s') || undefined,
      email: url.searchParams.get('email') || undefined,
    })
    if (error) return error
    const goalRows = await sql`
      SELECT calorie_goal AS "calorieGoal", protein_goal AS "proteinGoal",
             carbs_goal AS "carbsGoal", fat_goal AS "fatGoal"
      FROM hire_nutrition_goals WHERE user_id = ${user!.id} LIMIT 1
    `
    const goals = goalRows[0] as
      | { calorieGoal: number; proteinGoal: number; carbsGoal: number; fatGoal: number }
      | undefined
    const { start, end } = todayWindowUtc(user!.timezone || 'America/Los_Angeles')
    const logs = await sql`
      SELECT id, description, image_url AS "imageUrl", calories, protein, carbs, fat,
             eaten_at AS "eatenAt"
      FROM hire_nutrition_logs
      WHERE user_id = ${user!.id} AND eaten_at >= ${start.toISOString()} AND eaten_at < ${end.toISOString()}
      ORDER BY eaten_at ASC
    `
    const historyFrom = new Date(start.getTime() - 14 * 86_400_000)
    const history = await sql`
      SELECT id, description, image_url AS "imageUrl", calories, protein, carbs, fat,
             eaten_at AS "eatenAt"
      FROM hire_nutrition_logs
      WHERE user_id = ${user!.id}
        AND eaten_at >= ${historyFrom.toISOString()}
        AND eaten_at < ${start.toISOString()}
      ORDER BY eaten_at DESC
      LIMIT 40
    `
    const totals = (logs as Array<{ calories: number; protein: number; carbs: number; fat: number }>).reduce(
      (acc, l) => ({
        calories: acc.calories + clampNum(l.calories),
        protein: acc.protein + clampNum(l.protein),
        carbs: acc.carbs + clampNum(l.carbs),
        fat: acc.fat + clampNum(l.fat),
      }),
      { calories: 0, protein: 0, carbs: 0, fat: 0 },
    )
    return json({
      goals: goals || { calorieGoal: 2200, proteinGoal: 150, carbsGoal: 220, fatGoal: 70 },
      logs,
      history,
      totals,
    })
  }

  if (path === '/api/nutrition' && req.method === 'POST') {
    const body = (await req.json().catch(() => ({}))) as {
      token?: string; email?: string; description?: string
      calories?: number; protein?: number; carbs?: number; fat?: number
      eatenAt?: string; imageUrl?: string
    }
    const description = String(body.description || '').trim().slice(0, 300)
    if (!description) return json({ error: 'description required' }, 400)
    const { user, error } = await resolveAuthedUser(sql, { token: body.token, session: body.session, email: body.email })
    if (error) return error
    const id = crypto.randomUUID()
    await sql`
      INSERT INTO hire_nutrition_logs (id, user_id, description, image_url, calories, protein, carbs, fat, eaten_at)
      VALUES (${id}, ${user!.id}, ${description}, ${body.imageUrl || null},
        ${clampNum(body.calories)}, ${clampNum(body.protein)}, ${clampNum(body.carbs)}, ${clampNum(body.fat)},
        ${body.eatenAt ? new Date(body.eatenAt).toISOString() : new Date().toISOString()})
    `
    return json({ ok: true, id })
  }

  if (path === '/api/nutrition/goals' && req.method === 'PUT') {
    const body = (await req.json().catch(() => ({}))) as {
      token?: string; email?: string
      calorieGoal?: number; proteinGoal?: number; carbsGoal?: number; fatGoal?: number
    }
    const { user, error } = await resolveAuthedUser(sql, { token: body.token, session: body.session, email: body.email })
    if (error) return error
    const cal = clampNum(body.calorieGoal, 2200)
    const pro = clampNum(body.proteinGoal, 150)
    const carb = clampNum(body.carbsGoal, 220)
    const fat = clampNum(body.fatGoal, 70)
    await sql`
      INSERT INTO hire_nutrition_goals (user_id, calorie_goal, protein_goal, carbs_goal, fat_goal)
      VALUES (${user!.id}, ${cal}, ${pro}, ${carb}, ${fat})
      ON CONFLICT (user_id)
      DO UPDATE SET calorie_goal = ${cal}, protein_goal = ${pro}, carbs_goal = ${carb}, fat_goal = ${fat},
        updated_at = now()
    `
    return json({ ok: true })
  }

  if (path === '/api/nutrition/analyze' && req.method === 'POST') {
    const body = (await req.json().catch(() => ({}))) as {
      token?: string; email?: string; description?: string; imageBase64?: string
    }
    const { user, error } = await resolveAuthedUser(sql, { token: body.token, session: body.session, email: body.email })
    if (error) return error
    void user
    const estimate = await estimateNutrition(String(body.description || '').slice(0, 500), body.imageBase64 || '')
    return json(estimate)
  }

  if (path === '/api/nutrition/photo' && req.method === 'POST') {
    // Always log the photo. Estimate macros only when a model key exists;
    // otherwise the meal is still saved so it is never lost.
    const body = (await req.json().catch(() => ({}))) as {
      token?: string; email?: string; description?: string; imageBase64?: string
    }
    const imageBase64 = String(body.imageBase64 || '')
    if (imageBase64.length < 64) return json({ error: 'Photo is required' }, 400)
    const { user, error } = await resolveAuthedUser(sql, { token: body.token, session: body.session, email: body.email })
    if (error) return error
    const described = String(body.description || '').trim().slice(0, 300)
    let estimate: Awaited<ReturnType<typeof estimateNutrition>> = { ok: false, needsKey: true }
    if (nutritionModelConfig()) {
      try {
        estimate = await estimateNutrition(described || 'Estimate the macros of the meal in this photo.', imageBase64)
      } catch {
        estimate = { ok: false, error: 'Estimator unavailable' }
      }
    }
    const id = crypto.randomUUID()
    const detail = described || 'Meal from photo'
    const imageUrl = `data:${imageMimeFromBase64(imageBase64)};base64,${imageBase64}`
    const macros = estimate.ok
      ? {
          calories: clampNum(estimate.calories),
          protein: clampNum(estimate.protein),
          carbs: clampNum(estimate.carbs),
          fat: clampNum(estimate.fat),
        }
      : { calories: 0, protein: 0, carbs: 0, fat: 0 }
    await sql`
      INSERT INTO hire_nutrition_logs (id, user_id, description, image_url, calories, protein, carbs, fat, eaten_at)
      VALUES (${id}, ${user!.id}, ${estimate.ok ? (estimate.guess || detail) : `${detail} (estimate pending)`}, ${imageUrl},
        ${macros.calories}, ${macros.protein}, ${macros.carbs}, ${macros.fat}, now())
    `
    return json({ ok: true, id, imageUrl, estimated: estimate.ok, needsKey: estimate.needsKey === true })
  }

  if (path.startsWith('/api/nutrition/') && req.method === 'POST') {
    // Delete nutrition log: /api/nutrition/{id} with _delete body
    const body = (await req.json().catch(() => ({}))) as { token?: string; email?: string; _delete?: boolean }
    if (!body._delete) return json({ error: 'Not found' }, 404)
    const logId = path.split('/')[3]
    if (!logId) return json({ error: 'id required' }, 400)
    const { user, error } = await resolveAuthedUser(sql, { token: body.token, session: body.session, email: body.email })
    if (error) return error
    await sql`DELETE FROM hire_nutrition_logs WHERE id = ${logId} AND user_id = ${user!.id}`
    return json({ ok: true })
  }

  if (path === '/api/internal/nutrition' && req.method === 'POST') {
    if (!internalOk(req)) return json({ error: 'Unauthorized' }, 401)
    const body = (await req.json().catch(() => ({}))) as {
      phone?: string; persona?: string; description?: string
    }
    const description = String(body.description || '').trim().slice(0, 500)
    if (!body.phone || !isPersona(body.persona || '') || !description) {
      return json({ error: 'phone, persona, and description required' }, 400)
    }
    const user = await getUserByPhone(sql, body.phone)
    if (!user) return json({ error: 'User not found' }, 404)
    // Always log the meal. The estimator is a downstream model that can be
    // down or reply something unreadable — that is no reason to lose the log,
    // which is exactly what happened when this returned the error first.
    let estimate: Awaited<ReturnType<typeof estimateNutrition>> = { ok: false, needsKey: true }
    if (nutritionModelConfig()) {
      try {
        estimate = await estimateNutrition(description, '')
      } catch {
        estimate = { ok: false, error: 'Estimator unavailable' }
      }
    }
    const id = crypto.randomUUID()
    const saved = estimate.ok ? (estimate.guess || description).slice(0, 300) : `${description.slice(0, 300)} (estimate pending)`
    await sql`
      INSERT INTO hire_nutrition_logs (id, user_id, description, image_url, calories, protein, carbs, fat, eaten_at)
      VALUES (${id}, ${user.id}, ${saved}, NULL,
        ${clampNum(estimate.calories)}, ${clampNum(estimate.protein)}, ${clampNum(estimate.carbs)}, ${clampNum(estimate.fat)}, now())
    `
    return json({ ok: true, logged: true, id, estimated: estimate.ok, needsKey: estimate.needsKey === true, guess: estimate.guess || undefined })
  }

  if (path === '/api/internal/nutrition/photo' && req.method === 'POST') {
    // Bot-side photo upload: same always-log semantics as the dashboard
    // /api/nutrition/photo, but authenticated by phone + internal key.
    if (!internalOk(req)) return json({ error: 'Unauthorized' }, 401)
    const body = (await req.json().catch(() => ({}))) as {
      phone?: string; persona?: string; description?: string; imageBase64?: string
    }
    const imageBase64 = String(body.imageBase64 || '')
    if (!body.phone || !isPersona(body.persona || '') || imageBase64.length < 64) {
      return json({ error: 'phone, persona, and image required' }, 400)
    }
    const user = await getUserByPhone(sql, body.phone)
    if (!user) return json({ error: 'User not found' }, 404)
    const described = String(body.description || '').trim().slice(0, 300)
    let estimate: Awaited<ReturnType<typeof estimateNutrition>> = { ok: false, needsKey: true }
    if (nutritionModelConfig()) {
      try {
        estimate = await estimateNutrition(described || 'Estimate the macros of the meal in this photo.', imageBase64)
      } catch {
        estimate = { ok: false, error: 'Estimator unavailable' }
      }
    }
    const id = crypto.randomUUID()
    const detail = described || 'Meal from photo'
    const imageUrl = `data:${imageMimeFromBase64(imageBase64)};base64,${imageBase64}`
    const macros = estimate.ok
      ? {
          calories: clampNum(estimate.calories),
          protein: clampNum(estimate.protein),
          carbs: clampNum(estimate.carbs),
          fat: clampNum(estimate.fat),
        }
      : { calories: 0, protein: 0, carbs: 0, fat: 0 }
    await sql`
      INSERT INTO hire_nutrition_logs (id, user_id, description, image_url, calories, protein, carbs, fat, eaten_at)
      VALUES (${id}, ${user.id}, ${estimate.ok ? (estimate.guess || detail) : `${detail} (estimate pending)`}, ${imageUrl},
        ${macros.calories}, ${macros.protein}, ${macros.carbs}, ${macros.fat}, now())
    `
    return json({ ok: true, logged: true, id, estimated: estimate.ok, needsKey: estimate.needsKey === true, ...macros })
  }

  if (path === '/api/internal/workouts' && req.method === 'POST') {
    if (!internalOk(req)) return json({ error: 'Unauthorized' }, 401)
    const body = (await req.json().catch(() => ({}))) as { phone?: string; persona?: string; text?: string }
    if (!body.phone || !isPersona(body.persona || '') || !String(body.text || '').trim()) {
      return json({ error: 'phone, persona, and text required' }, 400)
    }
    const user = await getUserByPhone(sql, body.phone)
    if (!user) return json({ error: 'User not found' }, 404)
    const parsed = parseWorkoutText(String(body.text))
    if (!parsed) return json({ ok: false, logged: false, error: 'Could not parse workout' })
    const id = crypto.randomUUID()
    await sql`
      INSERT INTO hire_workouts (id, user_id, exercise, sets, reps, weight, notes)
      VALUES (${id}, ${user.id}, ${parsed.exercise}, ${parsed.sets}, ${parsed.reps}, ${parsed.weight}, NULL)
    `
    return json({ ok: true, logged: true, id, ...parsed })
  }

  if (path === '/api/internal/sleep' && req.method === 'POST') {
    if (!internalOk(req)) return json({ error: 'Unauthorized' }, 401)
    const body = (await req.json().catch(() => ({}))) as { phone?: string; persona?: string; text?: string }
    if (!body.phone || !isPersona(body.persona || '') || !String(body.text || '').trim()) {
      return json({ error: 'phone, persona, and text required' }, 400)
    }
    const user = await getUserByPhone(sql, body.phone)
    if (!user) return json({ error: 'User not found' }, 404)
    const parsed = parseSleepText(String(body.text))
    if (!parsed) return json({ ok: false, logged: false, error: 'Could not parse sleep times' })
    const sleepDate = shiftDateStr(localDateStrInTz(new Date(), user.timezone), -1)
    const id = crypto.randomUUID()
    await sql`
      INSERT INTO hire_sleep (id, user_id, sleep_date, bedtime, wake, quality, note)
      VALUES (${id}, ${user.id}, ${sleepDate}, ${parsed.bedtime}, ${parsed.wake}, 3, NULL)
      ON CONFLICT (user_id, sleep_date) DO UPDATE SET
        bedtime = excluded.bedtime, wake = excluded.wake
    `
    return json({ ok: true, logged: true, id, sleepDate, ...parsed })
  }

  if (path === '/api/internal/gratitude' && req.method === 'POST') {
    if (!internalOk(req)) return json({ error: 'Unauthorized' }, 401)
    const body = (await req.json().catch(() => ({}))) as { phone?: string; persona?: string; text?: string }
    if (!body.phone || !isPersona(body.persona || '') || !String(body.text || '').trim()) {
      return json({ error: 'phone, persona, and text required' }, 400)
    }
    const user = await getUserByPhone(sql, body.phone)
    if (!user) return json({ error: 'User not found' }, 404)
    const parsed = parseGratitudeText(String(body.text))
    if (!parsed) return json({ ok: false, logged: false, error: 'Could not parse gratitude' })
    const id = crypto.randomUUID()
    await sql`INSERT INTO hire_gratitude (id, user_id, text) VALUES (${id}, ${user.id}, ${parsed})`
    return json({ ok: true, logged: true, id, text: parsed })
  }

  if (path === '/api/internal/moods' && req.method === 'POST') {
    if (!internalOk(req)) return json({ error: 'Unauthorized' }, 401)
    const body = (await req.json().catch(() => ({}))) as {
      phone?: string; persona?: string; emoji?: string; energy?: number; text?: string; note?: string
    }
    if (!body.phone || !isPersona(body.persona || '')) {
      return json({ error: 'phone and persona required' }, 400)
    }
    const user = await getUserByPhone(sql, body.phone)
    if (!user) return json({ error: 'User not found' }, 404)
    const parsed = parseMoodReply(body.emoji || body.text || '')
    if (!parsed) return json({ ok: false, logged: false, error: 'Could not parse a mood' })
    const tz = user.timezone || 'America/Los_Angeles'
    const ds = localDateStrInTz(new Date(), tz)
    const has = await sql`SELECT 1 FROM hire_moods WHERE user_id = ${user.id} AND (created_at AT TIME ZONE ${tz})::date = ${ds} LIMIT 1`
    if (has[0]) return json({ ok: true, logged: true, id: crypto.randomUUID(), ...parsed, existing: true })
    const id = crypto.randomUUID()
    await sql`
      INSERT INTO hire_moods (id, user_id, emoji, energy, note)
      VALUES (${id}, ${user.id}, ${parsed.emoji}, ${parsed.energy}, ${parsed.note})
    `
    return json({ ok: true, logged: true, id, ...parsed })
  }

  if (path === '/api/internal/habits/done' && req.method === 'POST') {
    if (!internalOk(req)) return json({ error: 'Unauthorized' }, 401)
    const body = (await req.json().catch(() => ({}))) as {
      phone?: string; persona?: string; text?: string; date?: string
    }
    if (!body.phone || !isPersona(body.persona || '') || !String(body.text || '').trim()) {
      return json({ error: 'phone, persona, and text required' }, 400)
    }
    const user = await getUserByPhone(sql, body.phone)
    if (!user) return json({ error: 'User not found' }, 404)
    const tz = user.timezone || 'America/Los_Angeles'
    const dateStr = body.date || localDateStrInTz(new Date(), tz)
    const rows = await sql`SELECT id, name FROM hire_habits WHERE user_id = ${user.id} ORDER BY created_at ASC LIMIT 12`
    const text = String(body.text || '')
    const match =
      (rows as Array<{ id: string; name: string }>).find((h) =>
        text.toLowerCase().includes(h.name.toLowerCase()) || h.name.toLowerCase().includes(text.toLowerCase()),
      ) || (rows as Array<{ id: string; name: string }>)[0]
    if (!match) return json({ ok: false, logged: false, error: 'No habits set up yet' })
    const dup = await sql`
      SELECT 1 FROM hire_habit_logs WHERE user_id = ${user.id} AND habit_id = ${match.id} AND date = ${dateStr} LIMIT 1
    `
    if (!dup[0]) {
      await sql`
        INSERT INTO hire_habit_logs (id, user_id, habit_id, date)
        VALUES (${crypto.randomUUID()}, ${user.id}, ${match.id}, ${dateStr})
      `
    }
    return json({ ok: true, logged: true, habit: match.name, done: true, date: dateStr })
  }

  if (path === '/api/internal/spending' && req.method === 'POST') {
    if (!internalOk(req)) return json({ error: 'Unauthorized' }, 401)
    const body = (await req.json().catch(() => ({}))) as { phone?: string; persona?: string; text?: string }
    if (!body.phone || !isPersona(body.persona || '') || !String(body.text || '').trim()) {
      return json({ error: 'phone, persona, and text required' }, 400)
    }
    const user = await getUserByPhone(sql, body.phone)
    if (!user) return json({ error: 'User not found' }, 404)
    const parsed = parseSpendText(String(body.text))
    if (!parsed) return json({ ok: false, logged: false, error: 'Could not parse spend' })
    const weekStart = userMonday(user)
    const weekWindow = weekWindowUtc(weekStart, user.timezone || 'America/Los_Angeles')
    const spent = await sql`
      SELECT coalesce(sum(amount), 0)::real AS total FROM hire_spending
      WHERE user_id = ${user.id} AND spent_at >= ${weekWindow.start.toISOString()} AND spent_at < ${weekWindow.end.toISOString()}
    `
    const budget = await sql`SELECT weekly_budget AS "weeklyBudget" FROM hire_spending_budget WHERE user_id = ${user.id}`
    const weekTotal = Number((spent[0] as { total?: number })?.total || 0)
    const weeklyBudget = Math.round(Number((budget[0] as { weeklyBudget?: number })?.weeklyBudget) || 400)
    if (spendWouldBreakCap(weekTotal, weeklyBudget, parsed.amount)) {
      return json({
        ok: false,
        logged: false,
        overCap: true,
        amount: parsed.amount,
        weekTotal,
        weeklyBudget,
      })
    }
    const id = crypto.randomUUID()
    await sql`
      INSERT INTO hire_spending (id, user_id, amount, category, description)
      VALUES (${id}, ${user.id}, ${parsed.amount}, ${parsed.category}, ${parsed.description})
    `
    return json({ ok: true, logged: true, id, ...parsed })
  }

  if (path === '/api/internal/decisions' && req.method === 'POST') {
    if (!internalOk(req)) return json({ error: 'Unauthorized' }, 401)
    const body = (await req.json().catch(() => ({}))) as {
      phone?: string; persona?: string; text?: string
    }
    if (!body.phone || !isPersona(body.persona || '') || !String(body.text || '').trim()) {
      return json({ error: 'phone, persona, and text required' }, 400)
    }
    const user = await getUserByPhone(sql, body.phone)
    if (!user) return json({ error: 'User not found' }, 404)
    const parsed = parseDecisionText(String(body.text))
    if (!parsed) return json({ ok: false, logged: false, error: 'Could not parse a decision' })
    const reviewAt = parsed.review ? parseFlexibleWhen(parsed.review, user.timezone || 'America/Los_Angeles') : null
    const id = crypto.randomUUID()
    await sql`
      INSERT INTO hire_decisions (id, user_id, persona, decision, reason, owner, review_at, status)
      VALUES (${id}, ${user.id}, ${isPersona(body.persona || '') ? body.persona! : 'cofounder'}, ${parsed.decision.slice(0, 300)},
        ${(parsed.reason || '').slice(0, 500)}, ${(parsed.owner || '').slice(0, 120)}, ${reviewAt}, 'open')
    `
    return json({ ok: true, logged: true, id, decision: parsed.decision.slice(0, 300), reason: (parsed.reason || '').slice(0, 500), owner: (parsed.owner || '').slice(0, 120) })
  }

  if (path === '/api/internal/loops' && req.method === 'POST') {
    if (!internalOk(req)) return json({ error: 'Unauthorized' }, 401)
    const body = (await req.json().catch(() => ({}))) as {
      phone?: string
      persona?: string
      loops?: string[]
    }
    const titles = (body.loops || []).map((t) => String(t).trim().slice(0, 200)).filter(Boolean)
    if (!body.phone || !isPersona(body.persona || '') || !titles.length) {
      return json({ error: 'phone, persona, and at least one loop title required' }, 400)
    }
    const user = await getUserByPhone(sql, body.phone)
    if (!user) return json({ error: 'User not found' }, 404)
    for (const title of titles) {
      const id = crypto.randomUUID()
      await sql`
        INSERT INTO hire_loops (id, user_id, persona, title, context, status)
        VALUES (${id}, ${user.id}, ${isPersona(body.persona || '') ? body.persona! : ''}, ${title}, '', 'open')
      `
    }
    return json({ ok: true, logged: true, count: titles.length })
  }

  if (path === '/api/internal/chat-import' && req.method === 'POST') {
    if (!internalOk(req)) return json({ error: 'Unauthorized' }, 401)
    const body = (await req.json().catch(() => ({}))) as {
      phone?: string
      persona?: string
      text?: string
    }
    if (!body.phone || !isPersona(body.persona || '')) return json({ error: 'phone and persona required' }, 400)
    const user = await getUserByPhone(sql, body.phone)
    if (!user) return json({ error: 'User not found' }, 404)
    const people = parseChatExport(String(body.text || ''))
    let lines = 0
    for (const p of people) {
      // Per-person durable context, keyed chat:<name>, capped so recall/prep can
      // pull the thread back verbatim.
      const payload = p.lines.slice(0, 30).join('\n').slice(0, 3000)
      if (!payload.trim()) continue
      lines += p.lines.length
      const key = `chat:${p.name}`
      await upsertMemories(sql, user.id, body.persona!, [
        { key, value: payload, durable: true },
      ])
    }
    return json({ ok: true, people: people.length, lines })
  }

  if (path === '/api/internal/meetings' && req.method === 'POST') {
    if (!internalOk(req)) return json({ error: 'Unauthorized' }, 401)
    const body = (await req.json().catch(() => ({}))) as {
      phone?: string
      persona?: string
      title?: string
    }
    if (!body.phone || !isPersona(body.persona || '') || !String(body.title || '').trim()) {
      return json({ error: 'phone, persona, and title required' }, 400)
    }
    const user = await getUserByPhone(sql, body.phone)
    if (!user) return json({ error: 'User not found' }, 404)
    const id = crypto.randomUUID()
    await sql`
      INSERT INTO hire_meetings (id, user_id, title, phase, followups)
      VALUES (${id}, ${user.id}, ${String(body.title).trim().slice(0, 200)}, 'debrief',
        '[]'::jsonb)
    `
    return json({ ok: true, id })
  }

  if (path === '/api/internal/subscriptions' && req.method === 'POST') {
    if (!internalOk(req)) return json({ error: 'Unauthorized' }, 401)
    const body = (await req.json().catch(() => ({}))) as {
      phone?: string
      persona?: string
      query?: string
    }
    if (!body.phone || !isPersona(body.persona || '')) return json({ error: 'phone and persona required' }, 400)
    const live = await livePayload(sql, body.phone, body.persona)
    if (!live.found || !live.hired || !live.userId) return json({ ok: false, hits: [], error: 'not hired' }, 404)
    const bundle = await buildPrepBundle(
      sql,
      { id: live.userId, name: live.name, timezone: live.timezone },
      String(body.query || 'recurring charges'),
    )
    const kw = String(body.query || '').toLowerCase().trim()
    const hits = scanSubscriptions(bundle?.text || '')
      .filter((h) => !kw || `${h.merchant} ${h.period}`.toLowerCase().includes(kw))
    return json({ ok: true, hits })
  }

  if (path === '/api/internal/travel' && req.method === 'POST') {
    if (!internalOk(req)) return json({ error: 'Unauthorized' }, 401)
    const body = (await req.json().catch(() => ({}))) as {
      phone?: string
      persona?: string
      dest?: string
      tz?: string
    }
    if (!body.phone || !isPersona(body.persona || '') || !String(body.dest || '').trim()) {
      return json({ error: 'phone, persona, and dest required' }, 400)
    }
    const user = await getUserByPhone(sql, body.phone)
    if (!user) return json({ error: 'User not found' }, 404)
    const dest = String(body.dest).trim().slice(0, 80)
    const tz = String(body.tz || '').slice(0, 60)
    await upsertMemories(sql, user.id, body.persona!, [
      { key: 'travel_dest', value: dest, durable: true },
      ...(tz ? [{ key: 'travel_tz', value: tz, durable: true }] : []),
    ])
    return json({ ok: true, dest, tz })
  }

  if (path === '/api/internal/pipeline' && req.method === 'POST') {
    if (!internalOk(req)) return json({ error: 'Unauthorized' }, 401)
    const body = (await req.json().catch(() => ({}))) as {
      phone?: string; persona?: string; text?: string
    }
    if (!body.phone || !isPersona(body.persona || '') || !String(body.text || '').trim()) {
      return json({ error: 'phone, persona, and text required' }, 400)
    }
    const user = await getUserByPhone(sql, body.phone)
    if (!user) return json({ error: 'User not found' }, 404)
    const parsed = parsePipelineText(String(body.text))
    if (!parsed) return json({ ok: false, logged: false, error: 'Could not parse a pipeline move' })
    const id = crypto.randomUUID()
    // Upsert by a normalized title so "move Ravi to interview" adds it if new,
    // moves it if it already exists — the board reads the same table.
    await sql`
      INSERT INTO hire_pipeline (id, user_id, title, company, stage, notes)
      VALUES (${id}, ${user.id}, ${parsed.title.slice(0, 120)}, '' , ${parsed.stage}, ${(parsed.notes || '').slice(0, 400)})
      ON CONFLICT DO NOTHING
    `
    if (parsed.existing) {
      await sql`
        UPDATE hire_pipeline SET stage = ${parsed.stage}, updated_at = now()
        WHERE user_id = ${user.id} AND lower(title) = lower(${parsed.title.slice(0, 120)})
      `
    }
    return json({ ok: true, logged: true, id, title: parsed.title.slice(0, 120), stage: parsed.stage })
  }

  /* Cofounder capture: one structured item overheard in chat, deduped inside
   * 24 hours. The bot does the parsing; this endpoint only files the row. */
  if (path === '/api/internal/cofounder/capture' && req.method === 'POST') {
    if (!internalOk(req)) return json({ error: 'Unauthorized' }, 401)
    const body = (await req.json().catch(() => ({}))) as {
      phone?: string
      persona?: string
      kind?: string
      fields?: Record<string, unknown>
      raw?: string
    }
    if (!body.phone || !isPersona(body.persona || '')) return json({ error: 'phone and persona required' }, 400)
    const kind = String(body.kind || '') as CofounderCaptureKind
    if (!COFOUNDER_KINDS.includes(kind)) {
      return json({ error: 'kind must be decision, promise, person, or opportunity' }, 400)
    }
    const user = await getUserByPhone(sql, body.phone)
    if (!user) return json({ error: 'User not found' }, 404)
    try {
      const result = await captureCofounderItem(sql, user.id, body.persona!, kind, {
        ...(body.fields || {}),
        raw: String(body.raw || (body.fields as { raw?: string } | undefined)?.raw || ''),
      })
      return json({ ok: true, ...result })
    } catch (err) {
      return json({ error: err instanceof Error ? err.message : 'capture failed' }, 400)
    }
  }

  /* Cofounder digest: the staleness pass the bot reads before it says anything. */
  if (path === '/api/internal/cofounder/digest' && req.method === 'GET') {
    if (!internalOk(req)) return json({ error: 'Unauthorized' }, 401)
    const persona = url.searchParams.get('persona') || ''
    const phone = normalizePhone(url.searchParams.get('phone') || '')
    if (!isPersona(persona) || !phone) return json({ error: 'persona and phone required' }, 400)
    const user = await getUserByPhone(sql, phone)
    if (!user) return json({ error: 'User not found' }, 404)
    return json(await cofounderDigest(sql, user.id, persona))
  }

  /* Coworker digest: the shared staleness pass plus the live day view. */
  if (path === '/api/internal/coworker/digest' && req.method === 'GET') {
    if (!internalOk(req)) return json({ error: 'Unauthorized' }, 401)
    const phone = normalizePhone(url.searchParams.get('phone') || '')
    if (!phone) return json({ error: 'phone required' }, 400)
    const user = await getUserByPhone(sql, phone)
    if (!user) return json({ error: 'User not found' }, 404)
    const tz = pickUserTimezone({ userTz: user.timezone })
    const [base, waiting, standup, prep] = await Promise.all([
      cofounderDigest(sql, user.id, 'coworker'),
      sql`SELECT count(*)::int AS n FROM hire_drafts WHERE user_id = ${user.id} AND status = 'pending'`,
      sql`SELECT id FROM hire_standups WHERE user_id = ${user.id} AND day = ${localDateStrInTz(new Date(), tz)} LIMIT 1`,
      buildMeetingPrep(sql, user),
    ])
    return json({
      ...base,
      nextMeeting: prep.event,
      draftsWaiting: Number((waiting[0] as { n?: number } | undefined)?.n || 0),
      standupReady: !standup[0],
    })
  }

  /* Meeting prep: the next shared meeting today plus a skeleton brief. */
  if (path === '/api/meeting/prep' && (req.method === 'GET' || req.method === 'POST')) {
    const body = req.method === 'POST' ? ((await req.json().catch(() => ({}))) as Record<string, unknown>) : {}
    const { user, error } = await resolveAuthedUser(sql, {
      token: (url.searchParams.get('t') || String(body.token || '')) || undefined,
      session: (url.searchParams.get('s') || String(body.session || '')) || undefined,
      email: (url.searchParams.get('email') || String(body.email || '')) || undefined,
    })
    if (error) return error
    return json(await buildMeetingPrep(sql, user!))
  }

  /* Auto standup: today's facts from rows, written back for the day. */
  if (path === '/api/standup/auto' && req.method === 'POST') {
    const body = (await req.json().catch(() => ({}))) as { token?: string; session?: string; email?: string }
    const { user, error } = await resolveAuthedUser(sql, {
      token: (url.searchParams.get('t') || body.token) || undefined,
      session: (url.searchParams.get('s') || body.session) || undefined,
      email: (url.searchParams.get('email') || body.email) || undefined,
    })
    if (error) return error
    const out = await assembleAutoStandup(sql, user!)
    return json({ ok: true, ...out })
  }

  /* Slot suggest: free gaps the user can offer someone else. */
  if (path === '/api/slots/suggest' && req.method === 'POST') {
    const body = (await req.json().catch(() => ({}))) as {
      token?: string; session?: string; email?: string
      durationMin?: number; windowDays?: number; attendeeHint?: string
    }
    const { user, error } = await resolveAuthedUser(sql, {
      token: (url.searchParams.get('t') || body.token) || undefined,
      session: (url.searchParams.get('s') || body.session) || undefined,
      email: (url.searchParams.get('email') || body.email) || undefined,
    })
    if (error) return error
    const connected = (await connectedForUser(sql, user!.id)).includes('calendar')
    if (!connected) return json({ slots: [], connect: true })
    const tz = pickUserTimezone({ userTz: user!.timezone })
    const windowDays = Math.min(7, Math.max(1, Math.round(clampNum(body.windowDays, 3))))
    const busy = await loadBusyBlocks(sql, user!.id, new Date(), startOfLocalDay(tz, windowDays))
    const slots = suggestSlotsFromBusy(busy, {
      timezone: tz,
      windowDays,
      durationMin: Math.round(clampNum(body.durationMin, 30)),
    })
    return json({ slots, connect: false })
  }

  /* Linear triage: buckets only. Not connected is a 200 so the UI can deep
   * link straight into the connect flow. */
  if (path === '/api/linear/triage' && req.method === 'GET') {
    const { user, error } = await resolveAuthedUser(sql, {
      token: url.searchParams.get('t') || undefined,
      session: url.searchParams.get('s') || undefined,
      email: url.searchParams.get('email') || undefined,
    })
    if (error) return error
    const connected = (await connectedForUser(sql, user!.id)).includes('linear')
    if (!connected) return json({ connect: true })
    const raw = await composioFirst(user!.id, COMPOSIO_READ.linear!.slugs, { limit: 50, first: 50 })
    const issues = parseLinearIssues(raw)
    return json({ ...scoreLinearIssues(issues), count: issues.length })
  }

  if (path === '/api/internal/standup' && req.method === 'POST') {
    if (!internalOk(req)) return json({ error: 'Unauthorized' }, 401)
    const body = (await req.json().catch(() => ({}))) as {
      phone?: string; persona?: string; text?: string
    }
    const notes = String(body.text || '').trim().slice(0, 1000)
    if (!body.phone || !isPersona(body.persona || '') || !notes) {
      return json({ error: 'phone, persona, and text required' }, 400)
    }
    const user = await getUserByPhone(sql, body.phone)
    if (!user) return json({ error: 'User not found' }, 404)
    const day = localDateStrInTz(new Date(), user.timezone || 'America/Los_Angeles')
    await sql`
      INSERT INTO hire_standups (id, user_id, day, notes)
      VALUES (${crypto.randomUUID()}, ${user.id}, ${day}, ${notes})
      ON CONFLICT (user_id, day) DO UPDATE SET notes = excluded.notes, created_at = now()
    `
    return json({ ok: true, logged: true, day })
  }

  if (path === '/api/standup' && req.method === 'GET') {
    const { user, error } = await resolveAuthedUser(sql, {
      token: url.searchParams.get('t') || undefined,
      session: url.searchParams.get('s') || undefined,
      email: url.searchParams.get('email') || undefined,
    })
    if (error) return error
    const day = localDateStrInTz(new Date(), user!.timezone || 'America/Los_Angeles')
    const rows = await sql`
      SELECT id, day, notes FROM hire_standups
      WHERE user_id = ${user!.id} AND day = ${day}
    `
    return json({ today: (rows[0] as { notes?: string } | undefined)?.notes || null })
  }

  /* ---- Workshop: Alpha builds software ---- */

  const artifactDirFor = (userId: string, artifactId: string) => join(artifactsRoot(), userId, artifactId)

  async function storeArtifactFiles(userId: string, artifactId: string, files: Array<{ name: string; bytes: Uint8Array }>) {
    for (const f of files) {
      await sql`
        INSERT INTO hire_artifact_files (artifact_id, name, content)
        VALUES (${artifactId}, ${f.name}, ${Buffer.from(f.bytes).toString('base64')})
        ON CONFLICT (artifact_id, name) DO UPDATE SET content = excluded.content
      `
    }
  }

  async function deleteArtifactRow(userId: string, artifactId: string | undefined, persona: string) {
    let id = artifactId
    if (!id) {
      const rows = await sql`
        SELECT id FROM hire_artifacts
        WHERE user_id = ${userId} AND state = 'delivered'
        ORDER BY created_at DESC LIMIT 1
      `
      id = (rows[0] as { id?: string } | undefined)?.id
    }
    if (!id) return { ok: false, logged: false, error: 'No delivered artifact found' }
    const owned = await sql`
      SELECT id FROM hire_artifacts WHERE id = ${id} AND user_id = ${userId} LIMIT 1
    `
    if (!owned[0]) return { ok: false, logged: false, error: 'No delivered artifact found' }
    await sql`DELETE FROM hire_artifact_files WHERE artifact_id = ${id}`
    await rm(artifactDirFor(userId, id), { recursive: true, force: true })
    await sql`DELETE FROM hire_artifacts WHERE id = ${id} AND user_id = ${userId}`
    void persona
    return { ok: true, logged: true, id }
  }

  if (path === '/api/internal/workshop' && req.method === 'POST') {
    if (!internalOk(req)) return json({ error: 'Unauthorized' }, 401)
    if (process.env.WORKSHOP_ENABLED === '0') return json({ ok: false, logged: false, error: 'Workshop is disabled' })
    const body = (await req.json().catch(() => ({}))) as {
      phone?: string; persona?: string; prompt?: string; title?: string; code?: string; templateKey?: string
    }
    const code = String(body.code || '')
    const prompt = String(body.prompt || '').trim().slice(0, 500)
    const templateKey = String(body.templateKey || '').trim().slice(0, 60) || null
    if (!body.phone || !isPersona(body.persona || '') || !code) {
      return json({ error: 'phone, persona, and code required' }, 400)
    }
    try {
      // Schema guard: a build must never 500 on missing tables after a fresh
      // deploy — both creates are idempotent and cost nothing once warm.
      await sql`
        CREATE TABLE IF NOT EXISTS hire_artifact_files (
          artifact_id TEXT NOT NULL REFERENCES hire_artifacts(id) ON DELETE CASCADE,
          name TEXT NOT NULL,
          content TEXT NOT NULL,
          PRIMARY KEY (artifact_id, name)
        )
      `
      const user = await getUserByPhone(sql, body.phone)
    if (!user) return json({ error: 'User not found' }, 404)
    // Rate limit: ten finished builds a day is generous for a human and a
    // floor on abuse. Failed attempts (no artifact) don't consume quota —
    // otherwise a debugging session locks the builder for the day.
    const used = await sql`
      SELECT count(*)::int AS n FROM hire_workshop_tasks
      WHERE user_id = ${user.id} AND created_at >= date_trunc('day', now())
        AND artifact_id IS NOT NULL
    `
    if (Number((used[0] as { n?: number })?.n || 0) >= 10) {
      return json({ ok: false, logged: false, error: 'Build limit reached for today (10).' })
    }
    await sql`INSERT INTO hire_workshop_tasks (id, user_id, prompt, status) VALUES (${crypto.randomUUID()}, ${user.id}, ${prompt || 'build'}, 'running')`
    const gate = gateWorkshopCode(code)
    if (!gate.ok) {
      await sql`UPDATE hire_workshop_tasks SET status = 'failed', error = ${gate.reason} WHERE user_id = ${user.id} AND prompt = ${prompt || 'build'} AND status = 'running'`
      return json({ ok: false, logged: false, error: gate.reason })
    }
    const run = await runWorkshopCode(code)
    if (!run.ok || !run.files.length) {
      const error = run.error || 'The program produced no files.'
      await sql`UPDATE hire_workshop_tasks SET status = 'failed', error = ${error.slice(0, 500)} WHERE user_id = ${user.id} AND prompt = ${prompt || 'build'} AND status = 'running'`
      return json({ ok: false, logged: false, error: error.slice(0, 300) })
    }
    // The sandbox only proves the wrapper ran — the app's inline JavaScript
    // was never executed. The model loves unescaped apostrophes ('Time's
    // up!'), which kill the whole script: page renders, every button dead.
    // Parse-check every inline block; a failure feeds the repair pass.
    const htmlFile = run.files.find((f) => /\.html?$/i.test(f.name))
    if (htmlFile) {
      const builtHtml = Buffer.from(htmlFile.bytes).toString('utf8')
      const inlineScripts = [...builtHtml.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)]
        .map((m) => m[1])
        .filter((s) => s.trim())
      for (const inline of inlineScripts) {
        try {
          // Parse-only (never executes): the transpiler throws on syntax
          // errors without running a single line of app code.
          new Bun.Transpiler({ loader: 'js' }).transformSync(inline)
        } catch (e) {
          const msg = `the app's JavaScript does not parse: ${(e as Error).message}`.slice(0, 300)
          await sql`UPDATE hire_workshop_tasks SET status = 'failed', error = ${msg} WHERE user_id = ${user.id} AND prompt = ${prompt || 'build'} AND status = 'running'`
          return json({ ok: false, logged: false, error: msg })
        }
      }
    }
    const artifactId = crypto.randomUUID()
    const title = String(body.title || prompt || 'Built for you').slice(0, 120)
    // Parent row first: the file rows FK-reference hire_artifacts, so storing
    // files before the artifact exists violates the key and kills the build.
    const fileNames = run.files.map((f) => f.name)
    const expires = new Date(Date.now() + 7 * 86_400_000)
    await sql`
      INSERT INTO hire_artifacts (id, user_id, title, kind, files, state, expires_at, template_key)
      VALUES (${artifactId}, ${user.id}, ${title}, ${fileNames.some((f) => /\.html?$/i.test(f)) ? 'page' : 'file'},
        ${JSON.stringify(fileNames)}, 'delivered', ${expires.toISOString()}, ${templateKey})
    `
    await storeArtifactFiles(user.id, artifactId, run.files)
    await sql`
      UPDATE hire_workshop_tasks SET status = 'done', artifact_id = ${artifactId}
      WHERE user_id = ${user.id} AND prompt = ${prompt || 'build'} AND status = 'running'
    `
    return json({
      ok: true,
      logged: true,
      artifactId,
      title,
      files: fileNames,
      url: `${appBase(req)}/b/${artifactId}`,
    })
    } catch (err) {
      // Never a bare 500: the bot quotes this error back to the user, and the
      // stack lands in the container log for the real fix.
      console.error('[workshop] endpoint threw', err)
      return json({
        ok: false,
        logged: false,
        error: `server error: ${err instanceof Error ? err.message : String(err)}`.slice(0, 300),
      })
    }
  }

  /* Dedup lookup: has anyone already built this? Returns the newest verified
   * build with this template key from a DIFFERENT user (same-user re-asks get
   * a fresh build). */
  /* Delegate fire: the bot retained an outreach draft for this user and the
   * user said "send it". Same send machinery the app's Send button uses. */
  if (path === '/api/internal/mail/send' && req.method === 'POST') {
    if (!internalOk(req)) return json({ error: 'Unauthorized' }, 401)
    const body = (await req.json().catch(() => ({}))) as {
      phone?: string; to?: string; subject?: string; body?: string
    }
    if (!body.phone || !body.to || !body.subject) return json({ error: 'phone, to, and subject required' }, 400)
    const user = await getUserByPhone(sql, body.phone)
    if (!user) return json({ error: 'User not found' }, 404)
    const sent = await gmailSendMessage(sql, user.id, {
      to: String(body.to).trim(),
      subject: String(body.subject).trim().slice(0, 200),
      body: String(body.body || '').slice(0, 8000),
    })
    if (!sent.ok) return json({ ok: false, error: sent.error }, 400)
    return json({ ok: true })
  }

  if (path === '/api/internal/workshop/find' && req.method === 'GET') {
    if (!internalOk(req)) return json({ error: 'Unauthorized' }, 401)
    const phone = url.searchParams.get('phone') || ''
    const key = (url.searchParams.get('key') || '').trim()
    if (!phone || !key) return json({ artifact: null })
    const user = await getUserByPhone(sql, phone)
    if (!user) return json({ artifact: null })
    const rows = await sql`
      SELECT id, title FROM hire_artifacts
      WHERE template_key = ${key} AND user_id != ${user.id} AND state IN ('delivered', 'kept')
      ORDER BY created_at DESC LIMIT 1
    `
    const row = rows[0] as { id: string; title: string } | undefined
    return json({ artifact: row ? { artifactId: row.id, title: row.title } : null })
  }

  /* Clone a verified build for a new user: own artifact row, own 7-day
   * expiry, copied file rows. No planner, no sandbox — instant. */
  if (path === '/api/internal/workshop/clone' && req.method === 'POST') {
    if (!internalOk(req)) return json({ error: 'Unauthorized' }, 401)
    const body = (await req.json().catch(() => ({}))) as {
      phone?: string; persona?: string; artifactId?: string
    }
    if (!body.phone || !isPersona(body.persona || '') || !body.artifactId) {
      return json({ error: 'phone, persona, and artifactId required' }, 400)
    }
    const user = await getUserByPhone(sql, body.phone)
    if (!user) return json({ error: 'User not found' }, 404)
    const src = await sql`
      SELECT title, kind, files, template_key FROM hire_artifacts
      WHERE id = ${body.artifactId} AND state IN ('delivered', 'kept') LIMIT 1
    `
    const source = src[0] as { title: string; kind: string; files: string[] | string; template_key?: string } | undefined
    if (!source) return json({ ok: false, logged: false, error: 'source build no longer exists' })
    let fileList: string[] = []
    try {
      fileList = Array.isArray(source.files) ? source.files : JSON.parse(String(source.files || '[]'))
    } catch {
      fileList = []
    }
    const cloneId = crypto.randomUUID()
    const expires = new Date(Date.now() + 7 * 86_400_000)
    await sql`
      INSERT INTO hire_artifacts (id, user_id, title, kind, files, state, expires_at, template_key)
      VALUES (${cloneId}, ${user.id}, ${source.title}, ${source.kind},
        ${JSON.stringify(fileList)}, 'delivered', ${expires.toISOString()}, ${source.template_key || null})
    `
    const fileRows = await sql`
      SELECT name, content FROM hire_artifact_files WHERE artifact_id = ${body.artifactId}
    `
    for (const f of fileRows as Array<{ name: string; content: string }>) {
      await sql`
        INSERT INTO hire_artifact_files (artifact_id, name, content)
        VALUES (${cloneId}, ${f.name}, ${f.content})
        ON CONFLICT (artifact_id, name) DO UPDATE SET content = excluded.content
      `
    }
    await sql`
      INSERT INTO hire_workshop_tasks (id, user_id, prompt, status, artifact_id)
      VALUES (${crypto.randomUUID()}, ${user.id}, ${('shared: ' + source.title).slice(0, 500)}, 'done', ${cloneId})
    `
    return json({
      ok: true,
      logged: true,
      artifactId: cloneId,
      title: source.title,
      deduped: true,
      files: fileList,
      url: `${appBase(req)}/b/${cloneId}`,
    })
  }

  /* Source + iterate: the user can ask for changes to their build, and the
   * bot re-renders it. Source returns the current HTML; iterate stores the
   * updated version as a NEW artifact (old link stays = old version). */
  if (path === '/api/internal/workshop/source' && req.method === 'GET') {
    if (!internalOk(req)) return json({ error: 'Unauthorized' }, 401)
    const phone = url.searchParams.get('phone') || ''
    const artifactId = url.searchParams.get('artifactId') || ''
    if (!phone) return json({ error: 'phone required' }, 400)
    const user = await getUserByPhone(sql, phone)
    if (!user) return json({ error: 'User not found' }, 404)
    const rows = artifactId
      ? await sql`SELECT id, title, files, template_key FROM hire_artifacts WHERE id = ${artifactId} AND user_id = ${user.id} AND state IN ('delivered', 'kept') LIMIT 1`
      : await sql`SELECT id, title, files, template_key FROM hire_artifacts WHERE user_id = ${user.id} AND state IN ('delivered', 'kept') ORDER BY created_at DESC LIMIT 1`
    const row = rows[0] as { id: string; title: string; files: string[] | string; template_key: string | null } | undefined
    if (!row) return json({ error: 'No build on file' }, 404)
    let fileList: string[] = []
    try {
      fileList = Array.isArray(row.files) ? row.files : JSON.parse(String(row.files || '[]'))
    } catch {
      fileList = []
    }
    const htmlName = fileList.find((f) => /\.html?$/i.test(f)) || fileList[0] || ''
    const fileRows = await sql`
      SELECT content FROM hire_artifact_files WHERE artifact_id = ${row.id} AND name = ${htmlName} LIMIT 1
    `
    const content = (fileRows[0] as { content?: string } | undefined)?.content
    if (!content) return json({ error: 'Build file missing' }, 404)
    return json({
      artifactId: row.id,
      title: row.title,
      templateKey: row.template_key,
      html: Buffer.from(content, 'base64').toString('utf8'),
    })
  }

  if (path === '/api/internal/workshop/iterate' && req.method === 'POST') {
    if (!internalOk(req)) return json({ error: 'Unauthorized' }, 401)
    const body = (await req.json().catch(() => ({}))) as {
      phone?: string; persona?: string; artifactId?: string; title?: string; html?: string; instruction?: string
    }
    const html = String(body.html || '')
    const artifactId = String(body.artifactId || '')
    if (!body.phone || !isPersona(body.persona || '') || !artifactId || !html) {
      return json({ error: 'phone, persona, artifactId, and html required' }, 400)
    }
    try {
      const user = await getUserByPhone(sql, body.phone)
      if (!user) return json({ error: 'User not found' }, 404)
      const srcRows = await sql`
        SELECT title, template_key FROM hire_artifacts WHERE id = ${artifactId} AND user_id = ${user.id} LIMIT 1
      `
      const src = srcRows[0] as { title: string; template_key: string | null } | undefined
      if (!src) return json({ ok: false, logged: false, error: 'source build no longer exists' })
      // Same inline-JS parse gate as fresh builds: dead buttons never ship.
      const inlineScripts = [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)]
        .map((m) => m[1])
        .filter((s) => s.trim())
      for (const inline of inlineScripts) {
        try {
          new Bun.Transpiler({ loader: 'js' }).transformSync(inline)
        } catch (e) {
          return json({ ok: false, logged: false, error: `the updated app's JavaScript does not parse: ${(e as Error).message}`.slice(0, 300) })
        }
      }
      const newId = crypto.randomUUID()
      const title = String(body.title || src.title).slice(0, 120)
      const expires = new Date(Date.now() + 7 * 86_400_000)
      await sql`
        INSERT INTO hire_artifacts (id, user_id, title, kind, files, state, expires_at, template_key)
        VALUES (${newId}, ${user.id}, ${title}, 'page', ${JSON.stringify(['index.html'])}, 'delivered', ${expires.toISOString()}, ${src.template_key})
      `
      await sql`
        INSERT INTO hire_artifact_files (artifact_id, name, content)
        VALUES (${newId}, 'index.html', ${Buffer.from(html).toString('base64')})
      `
      await sql`
        INSERT INTO hire_workshop_tasks (id, user_id, prompt, status, artifact_id)
        VALUES (${crypto.randomUUID()}, ${user.id}, ${('iterate: ' + String(body.instruction || '')).slice(0, 500)}, 'done', ${newId})
      `
      return json({
        ok: true,
        logged: true,
        artifactId: newId,
        title,
        url: `${appBase(req)}/b/${newId}`,
      })
    } catch (err) {
      console.error('[workshop] iterate threw', err)
      return json({ ok: false, logged: false, error: `server error: ${err instanceof Error ? err.message : String(err)}`.slice(0, 300) })
    }
  }

  if (path === '/api/internal/workshop/last' && req.method === 'GET') {
    if (!internalOk(req)) return json({ error: 'Unauthorized' }, 401)
    const user = await getUserByPhone(sql, url.searchParams.get('phone') || '')
    if (!user) return json({ error: 'User not found' }, 404)
    const rows = await sql`
      SELECT id, title, state, expires_at AS "expiresAt" FROM hire_artifacts
      WHERE user_id = ${user.id} AND state = 'delivered'
      ORDER BY created_at DESC LIMIT 1
    `
    const row = rows[0] as { id: string; title: string; state: string; expiresAt: Date } | undefined
    return json({ artifact: row ? { id: row.id, title: row.title, expiresAt: row.expiresAt } : null })
  }

  /* Recent build attempts with their errors — the remote-debug view for when
   * a build fails in production and the reply only says "it failed". */
  if (path === '/api/internal/workshop/tasks' && req.method === 'GET') {
    if (!internalOk(req)) return json({ error: 'Unauthorized' }, 401)
    const phone = url.searchParams.get('phone') || ''
    const rows = await sql`
      SELECT t.prompt, t.status, t.error, t.created_at AS "createdAt"
      FROM hire_workshop_tasks t
      ${phone ? sql`JOIN hire_users u ON u.id = t.user_id WHERE u.phone_e164 = ${phone}` : sql``}
      ORDER BY t.created_at DESC LIMIT 10
    `
    return json({ tasks: rows })
  }

  if (path === '/api/internal/workshop/keep' && req.method === 'POST') {
    if (!internalOk(req)) return json({ error: 'Unauthorized' }, 401)
    const body = (await req.json().catch(() => ({}))) as { phone?: string; persona?: string; artifactId?: string }
    const user = await getUserByPhone(sql, body.phone)
    if (!user) return json({ error: 'User not found' }, 404)
    const result = await (async () => {
      const id = body.artifactId
      if (id) {
        await sql`UPDATE hire_artifacts SET state = 'kept', expires_at = NULL WHERE id = ${id} AND user_id = ${user.id}`
        return { ok: true, logged: true, id }
      }
      const rows = await sql`
        SELECT id FROM hire_artifacts WHERE user_id = ${user.id} AND state = 'delivered'
        ORDER BY created_at DESC LIMIT 1
      `
      const latest = (rows[0] as { id?: string } | undefined)?.id
      if (!latest) return { ok: false, logged: false, error: 'Nothing to keep' }
      await sql`UPDATE hire_artifacts SET state = 'kept', expires_at = NULL WHERE id = ${latest} AND user_id = ${user.id}`
      return { ok: true, logged: true, id: latest }
    })()
    return json(result)
  }

  if (path === '/api/internal/workshop/toss' && req.method === 'POST') {
    if (!internalOk(req)) return json({ error: 'Unauthorized' }, 401)
    const body = (await req.json().catch(() => ({}))) as { phone?: string; persona?: string; artifactId?: string }
    const user = await getUserByPhone(sql, body.phone)
    if (!user) return json({ error: 'User not found' }, 404)
    return json(await deleteArtifactRow(user.id, body.artifactId, body.persona || ''))
  }

  /* ---- Workshop public surface (the owner's views) ---- */

  if (path === '/api/artifacts' && req.method === 'GET') {
    const { user, error } = await resolveAuthedUser(sql, {
      token: url.searchParams.get('t') || undefined,
      session: url.searchParams.get('s') || undefined,
      email: url.searchParams.get('email') || undefined,
    })
    if (error) return error
    const rows = await sql`
      SELECT id, title, kind, files, state, expires_at AS "expiresAt", created_at AS "createdAt"
      FROM hire_artifacts WHERE user_id = ${user!.id}
      ORDER BY created_at DESC LIMIT 30
    `
    return json({ artifacts: rows })
  }

  if (path === '/api/artifacts' && req.method === 'DELETE') {
    const { user, error } = await resolveAuthedUser(sql, {
      token: url.searchParams.get('t') || undefined,
      session: url.searchParams.get('s') || undefined,
      email: url.searchParams.get('email') || undefined,
    })
    if (error) return error
    const id = url.searchParams.get('id') || ''
    return json(await deleteArtifactRow(user!.id, id || undefined, ''))
  }

  /* ---- Public build links: /b/{id} IS the deployed app ----
   * Builds are self-contained HTML; they need no viewer, no auth, no mini-app
   * shell. The link is the capability (an unguessable id, like a Vercel
   * preview): anyone with it opens the app straight from Postgres. */
  const gonePage = (msg: string) =>
    new Response(
      `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Gone</title><style>body{background:#0c0e11;color:#98a0ab;font-family:-apple-system,'Helvetica Neue',sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0}p{padding:0 32px}</style></head><body><p>${msg}</p></body></html>`,
      { headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' } },
    )
  const publicBuild = path.match(/^\/b\/([\w-]+)$/)
  if (publicBuild && req.method === 'GET') {
    try {
      const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
      const rows = await sql`
        SELECT title, files, state FROM hire_artifacts WHERE id = ${publicBuild[1]} LIMIT 1
      `
      const rawRow = rows[0] as { title: string; files: string[] | string; state: string } | undefined
      if (!rawRow || rawRow.state === 'tossed') {
        return gonePage('This build is gone. Ask Alpha to build it again.')
      }
      // JSONB can arrive as a parsed array or as raw JSON text depending on
      // the driver — normalize before touching it.
      let files: string[] = []
      try {
        files = Array.isArray(rawRow.files) ? rawRow.files : JSON.parse(String(rawRow.files || '[]'))
      } catch {
        files = []
      }
      const htmlName = files.find((f) => /\.html?$/i.test(f)) || files[0] || ''
      const fileRows = await sql`
        SELECT content FROM hire_artifact_files
        WHERE artifact_id = ${publicBuild[1]} AND name = ${htmlName} LIMIT 1
      `
      const content = (fileRows[0] as { content?: string } | undefined)?.content
      if (!content) return gonePage('This build is gone. Ask Alpha to build it again.')
      let html = Buffer.from(content, 'base64').toString('utf8')
      // Ensure mobile viewport with viewport-fit=cover
      if (!/<meta\s+name=["']viewport["']/i.test(html)) {
        const vp = '<meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no, viewport-fit=cover" />'
        html = html.includes('<head>') ? html.replace('<head>', `<head>${vp}`) : `${vp}${html}`
      } else if (!/viewport-fit=cover/i.test(html)) {
        html = html.replace(/(<meta\s+name=["']viewport["'][^>]*content=["'][^"']+)(["'])/i, '$1, viewport-fit=cover$2')
      }

      // Inject universal safe-area styling so top status bar / notch and bottom Safari search/tab bar never cover content
      const safeAreaStyle = `<style id="alpha-mobile-safe-area">
  :root {
    --sat: env(safe-area-inset-top, 0px);
    --sab: env(safe-area-inset-bottom, 0px);
    --sal: env(safe-area-inset-left, 0px);
    --sar: env(safe-area-inset-right, 0px);
  }
  html {
    box-sizing: border-box;
    min-height: 100dvh;
  }
  *, *::before, *::after {
    box-sizing: inherit;
  }
  body {
    min-height: 100dvh;
    padding-top: max(16px, env(safe-area-inset-top, 0px));
    padding-bottom: max(32px, env(safe-area-inset-bottom, 0px));
    padding-left: max(16px, env(safe-area-inset-left, 0px));
    padding-right: max(16px, env(safe-area-inset-right, 0px));
  }
</style>`
      if (!html.includes('id="alpha-mobile-safe-area"')) {
        html = html.includes('</head>') ? html.replace('</head>', `${safeAreaStyle}</head>`) : `${safeAreaStyle}${html}`
      }

      // Give the link preview a title even when the generated app has no meta.
      if (!/<meta\s+property="og:title"/i.test(html)) {
        const og = `<meta property="og:title" content="${esc(rawRow.title)}" /><meta property="og:description" content="Built by Alpha" />`
        html = html.includes('</head>') ? html.replace('</head>', `${og}</head>`) : `${og}${html}`
      }
      if (!/<title>/i.test(html)) {
        html = html.includes('<head') ? html.replace(/<head([^>]*)>/i, `<head$1><title>${esc(rawRow.title)}</title>`) : `<title>${esc(rawRow.title)}</title>${html}`
      }
      return new Response(html, {
        headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' },
      })
    } catch (err) {
      console.error('[builds] /b/ serve failed', err)
      return gonePage('This build is gone. Ask Alpha to build it again.')
    }
  }

  const artifactFile = path.match(/^\/a\/([\w-]+)\/([\w.-]+)$/)
  if (artifactFile && req.method === 'GET') {
    const [, artifactId, fileName] = artifactFile
    const { user, error } = await resolveAuthedUser(sql, {
      token: url.searchParams.get('t') || undefined,
      session: url.searchParams.get('s') || undefined,
      email: url.searchParams.get('email') || undefined,
    })
    if (error) return error
    const rows = await sql`
      SELECT files FROM hire_artifacts WHERE id = ${artifactId} AND user_id = ${user!.id} LIMIT 1
    `
    const rawRow = rows[0] as { files?: string[] | string } | undefined
    if (!rawRow) return json({ error: 'Not found' }, 404)
    let fileList: string[] = []
    try {
      fileList = Array.isArray(rawRow.files) ? rawRow.files : JSON.parse(String(rawRow.files || '[]'))
    } catch {
      fileList = []
    }
    const safeName = fileName.replace(/[\\/]/g, '')
    if (!fileList.includes(safeName)) return json({ error: 'Not found' }, 404)
    const types: Record<string, string> = {
      '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
      '.js': 'text/javascript; charset=utf-8', '.json': 'application/json',
      '.csv': 'text/csv; charset=utf-8', '.txt': 'text/plain; charset=utf-8',
      '.md': 'text/markdown; charset=utf-8', '.svg': 'image/svg+xml',
      '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
      '.pdf': 'application/pdf',
    }
    const type = types[safeName.slice(safeName.lastIndexOf('.'))] || 'application/octet-stream'
    // Builds live in the database so a redeploy can never wipe them; the disk
    // copy is only a legacy fallback from before the move.
    const dbRows = await sql`
      SELECT content FROM hire_artifact_files
      WHERE artifact_id = ${artifactId} AND name = ${safeName}
      LIMIT 1
    `
    const dbContent = (dbRows[0] as { content?: string } | undefined)?.content
    if (dbContent) {
      return new Response(Buffer.from(dbContent, 'base64'), {
        headers: { 'Content-Type': type, 'Cache-Control': 'no-store' },
      })
    }
    try {
      const bytes = await readFile(artifactDirFor(user!.id, artifactId) + '/' + safeName)
      return new Response(bytes, { headers: { 'Content-Type': type, 'Cache-Control': 'no-store' } })
    } catch {
      return json({ error: 'Not found' }, 404)
    }
  }

  const artifactGet = path.match(/^\/api\/artifacts\/([\w-]+)$/)
  if (artifactGet && req.method === 'GET') {
    const { user, error } = await resolveAuthedUser(sql, {
      token: url.searchParams.get('t') || undefined,
      session: url.searchParams.get('s') || undefined,
      email: url.searchParams.get('email') || undefined,
    })
    if (error) return error
    const rows = await sql`
      SELECT id, title, kind, files, state, expires_at AS "expiresAt"
      FROM hire_artifacts WHERE id = ${artifactGet[1]} AND user_id = ${user!.id} LIMIT 1
    `
    const row = rows[0] as
      | { id: string; title: string; kind: string; files: string[]; state: string; expiresAt: string | null }
      | undefined
    if (!row) return json({ error: 'Not found' }, 404)
    return json(row)
  }

  const artifactAction = path.match(/^\/api\/artifacts\/([\w-]+)\/(keep|delete)$/)
  if (artifactAction && req.method === 'POST') {
    const body = (await req.json().catch(() => ({}))) as { token?: string; email?: string }
    const { user, error } = await resolveAuthedUser(sql, { token: body.token, session: body.session, email: body.email })
    if (error) return error
    const [, id, action] = artifactAction
    if (action === 'keep') {
      await sql`UPDATE hire_artifacts SET state = 'kept', expires_at = NULL WHERE id = ${id} AND user_id = ${user!.id}`
      return json({ ok: true, state: 'kept' })
    }
    return json(await deleteArtifactRow(user!.id, id, ''))
  }

  if (path === '/api/standup' && req.method === 'GET') {
    const { user, error } = await resolveAuthedUser(sql, {
      token: url.searchParams.get('t') || undefined,
      session: url.searchParams.get('s') || undefined,
      email: url.searchParams.get('email') || undefined,
    })
    if (error) return error
    const day = localDateStrInTz(new Date(), user!.timezone || 'America/Los_Angeles')
    const rows = await sql`
      SELECT id, day, notes FROM hire_standups
      WHERE user_id = ${user!.id} AND day = ${day}
    `
    return json({ today: (rows[0] as { notes?: string } | undefined)?.notes || null })
  }

  if (path === '/api/internal/budget' && req.method === 'POST') {
    if (!internalOk(req)) return json({ error: 'Unauthorized' }, 401)
    const body = (await req.json().catch(() => ({}))) as { phone?: string; persona?: string; text?: string }
    if (!body.phone || !isPersona(body.persona || '') || !String(body.text || '').trim()) {
      return json({ error: 'phone, persona, and text required' }, 400)
    }
    const user = await getUserByPhone(sql, body.phone)
    if (!user) return json({ error: 'User not found' }, 404)
    const m = String(body.text).match(/\$?\s*(\d{2,6})/)
    if (!m) return json({ ok: false, logged: false, error: 'Could not read a budget amount' })
    const amount = Math.min(50000, Math.max(50, Number(m[1])))
    await sql`
      INSERT INTO hire_spending_budget (user_id, weekly_budget, updated_at)
      VALUES (${user.id}, ${amount}, now())
      ON CONFLICT (user_id) DO UPDATE SET weekly_budget = ${amount}, updated_at = now()
    `
    return json({ ok: true, logged: true, weeklyBudget: amount })
  }

  if (path === '/api/internal/prefs' && req.method === 'POST') {
    if (!internalOk(req)) return json({ error: 'Unauthorized' }, 401)
    const body = (await req.json().catch(() => ({}))) as { phone?: string; persona?: string; text?: string }
    if (!body.phone || !isPersona(body.persona || '') || !String(body.text || '').trim()) {
      return json({ error: 'phone, persona, and text required' }, 400)
    }
    const user = await getUserByPhone(sql, body.phone)
    if (!user) return json({ error: 'User not found' }, 404)
    const text = String(body.text)
    const patch: Partial<MiniPrefs> = {}

    const place = text.match(/\b(?:workout|train)\w*[\s\S]{0,24}?\b(home|gym)\b/i)
    if (place) patch.workoutPlace = place[1]!.toLowerCase() as 'home' | 'gym'
    const moves = text.match(/moves?\s*(?:per\s+day)?\s*(?:to|at)?\s*(4|5|6)\b/i) || text.match(/\b(4|5|6)\s+moves?\b/i)
    if (moves) patch.workoutMoveCount = Number(moves[1]) as 4 | 5 | 6

    const DAY_NUM: Record<string, number> = { sunday: 0, monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6 }
    if (/\bevery\s+day\b/i.test(text)) {
      patch.workoutDays = [0, 1, 2, 3, 4, 5, 6]
    } else {
      const named = Object.keys(DAY_NUM).filter((n) => new RegExp(`\\b${n}\\b`, 'i').test(text))
      if (named.length) patch.workoutDays = named.map((n) => DAY_NUM[n]!)
    }

    const clockAt = (label: string) => {
      const m = text.match(new RegExp(`${label}\\s*(?:at)?\\s*(\\d{1,2})(?::(\\d{2}))?\\s*(am|pm)?`, 'i'))
      if (!m) return ''
      let h = Number(m[1])
      const min = m[2] ? Number(m[2]) : 0
      const ap = (m[3] || '').toLowerCase()
      if (ap === 'pm' && h < 12) h += 12
      if (ap === 'am' && h === 12) h = 0
      if (h > 23 || min > 59) return ''
      return `${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}`
    }
    const bedtime = clockAt('bedtime') || clockAt('sleep')
    const wake = clockAt('wake')
    if (bedtime) patch.sleepBedtime = bedtime
    if (wake) patch.sleepWake = wake

    if (!Object.keys(patch).length) {
      return json({ ok: false, changed: false, error: 'Could not read a setting to change' })
    }
    const prefs = await saveMiniPrefs(sql, user.id, patch)
    return json({ ok: true, changed: true, ...prefs })
  }

  if (path === '/api/internal/learning' && req.method === 'POST') {
    if (!internalOk(req)) return json({ error: 'Unauthorized' }, 401)
    const body = (await req.json().catch(() => ({}))) as {
      phone?: string; persona?: string; url?: string; title?: string; text?: string
    }
    const itemUrl = String(body.url || '').trim().slice(0, 500)
    if (!body.phone || !isPersona(body.persona || '') || !itemUrl) {
      return json({ error: 'phone, persona, and url required' }, 400)
    }
    const user = await getUserByPhone(sql, body.phone)
    if (!user) return json({ error: 'User not found' }, 404)
    let title = String(body.title || '').replace(/https?:\/\/\S+/gi, '').trim().slice(0, 160)
    if (!title) {
      try {
        title = new URL(itemUrl).hostname.replace(/^www\./, '') || 'Saved link'
      } catch {
        title = 'Saved link'
      }
    }
    const kind = /\b(youtube|vimeo|watch)\b/i.test(itemUrl) ? 'video' : /\b(spotify|podcast|anchor)\b/i.test(itemUrl) ? 'podcast' : 'article'
    const id = crypto.randomUUID()
    await sql`
      INSERT INTO hire_learning (id, user_id, title, url, kind, minutes)
      VALUES (${id}, ${user.id}, ${title}, ${itemUrl}, ${kind}, 10)
    `
    return json({ ok: true, logged: true, id, title, url: itemUrl, kind })
  }

  if (path === '/api/internal/network' && req.method === 'POST') {
    if (!internalOk(req)) return json({ error: 'Unauthorized' }, 401)
    const body = (await req.json().catch(() => ({}))) as {
      phone?: string; persona?: string; name?: string; place?: string; text?: string; contactPhone?: string
    }
    const name = String(body.name || '').trim().slice(0, 80)
    if (!body.phone || !isPersona(body.persona || '') || !name) {
      return json({ error: 'phone, persona, and name required' }, 400)
    }
    const user = await getUserByPhone(sql, body.phone)
    if (!user) return json({ error: 'User not found' }, 404)
    const whereMet = String(body.place || '').trim().slice(0, 120)
    const contactPhone = String(body.contactPhone || '').trim().slice(0, 40)
    const context = String(body.text || '').trim().slice(0, 400)
    const id = crypto.randomUUID()
    await sql`
      INSERT INTO hire_network (id, user_id, name, where_met, context, last_touch, cadence_days, phone)
      VALUES (${id}, ${user.id}, ${name}, ${whereMet}, ${context}, now(), 14, ${contactPhone})
    `
    return json({ ok: true, logged: true, id, name, place: whereMet, phone: contactPhone })
  }

  if (path === '/api/internal/digest' && req.method === 'GET') {
    if (!internalOk(req)) return json({ error: 'Unauthorized' }, 401)
    const phone = url.searchParams.get('phone') || ''
    const persona = url.searchParams.get('persona') || ''
    if (!phone || !isPersona(persona)) return json({ error: 'phone and persona required' }, 400)
    const user = await getUserByPhone(sql, phone)
    if (!user) return json({ error: 'User not found' }, 404)
    const payload = (await digestCache.read(
      `${user.id}|${persona}`,
      () => digestPayload(sql, user, persona),
      BRIEF_WARM_WAIT_MS,
    )).value
    if (!payload) return json({ error: 'Could not build the brief' }, 502)
    return json({ ...payload, cardUrl: `${appBase(req)}/app/mini/${persona}/digest` })
  }

  if (path === '/api/internal/judgment-state' && req.method === 'GET') {
    if (!internalOk(req)) return json({ error: 'Unauthorized' }, 401)
    const phone = url.searchParams.get('phone') || ''
    const persona = url.searchParams.get('persona') || ''
    const tick = url.searchParams.get('tick') || 'judge'
    if (!phone || !isPersona(persona)) return json({ error: 'phone and persona required' }, 400)
    const user = await getUserByPhone(sql, phone)
    if (!user) return json({ error: 'User not found' }, 404)
    const context = await loadContext(sql, user.id, persona)
    await armPokes(sql, user, persona, context)
    const payload = await judgmentStatePayload(sql, user, persona, tick)
    return json(payload)
  }

  /* Recent spending logs for the bot's billguard: category, amount, note. */
  if (path === '/api/internal/spending' && req.method === 'GET') {
    if (!internalOk(req)) return json({ error: 'Unauthorized' }, 401)
    const phone = url.searchParams.get('phone') || ''
    if (!phone) return json({ error: 'phone required' }, 400)
    const user = await getUserByPhone(sql, phone)
    if (!user) return json({ logs: [], weekly: 0, budget: 0 })
    const rows = await sql`
      SELECT amount, category, description, spent_at AS "spentAt" FROM hire_spending
      WHERE user_id = ${user.id} AND spent_at >= now() - interval '60 days'
      ORDER BY spent_at DESC LIMIT 60
    `
    const week = await sql`
      SELECT coalesce(sum(amount), 0)::float AS total FROM hire_spending
      WHERE user_id = ${user.id} AND spent_at >= now() - interval '7 days'
    `
    const budgetRow = await sql`
      SELECT weekly_budget AS "weeklyBudget" FROM hire_spending_budget WHERE user_id = ${user.id} LIMIT 1
    `
    return json({
      logs: rows,
      weekly: Number((week[0] as { total?: number })?.total) || 0,
      budget: Number((budgetRow[0] as { weeklyBudget?: number })?.weeklyBudget) || 0,
    })
  }

  /* Contacts for the Tier 4 delegate: name + phone to draft outreach. */
  if (path === '/api/internal/network' && req.method === 'GET') {    if (!internalOk(req)) return json({ error: 'Unauthorized' }, 401)
    const phone = url.searchParams.get('phone') || ''
    if (!phone) return json({ error: 'phone required' }, 400)
    const user = await getUserByPhone(sql, phone)
    if (!user) return json({ contacts: [] })
    const rows = await sql`
      SELECT name, phone, email FROM hire_network
      WHERE user_id = ${user.id}
      ORDER BY coalesce(last_touch, '1970-01-01'::timestamptz) DESC LIMIT 50
    `
    return json({ contacts: rows })
  }

  /* Why are briefs (not) firing? One call: every reminder row for this
   * persona plus the exact judgment state the bot's guards evaluate. */
  if (path === '/api/internal/brief-debug' && req.method === 'GET') {
    if (!internalOk(req)) return json({ error: 'Unauthorized' }, 401)
    const phone = url.searchParams.get('phone') || ''
    const persona = url.searchParams.get('persona') || ''
    if (!phone || !isPersona(persona)) return json({ error: 'phone and persona required' }, 400)
    const user = await getUserByPhone(sql, phone)
    if (!user) return json({ error: 'User not found' }, 404)
    const reminders = await sql`
      SELECT text, status, recurrence, scheduled_at AS "scheduledAt", timezone
      FROM hire_reminders WHERE user_id = ${user.id} AND persona = ${persona}
      ORDER BY scheduled_at ASC LIMIT 12
    `
    let state: unknown = null
    try {
      state = await judgmentStatePayload(sql, user, persona, 'digest')
    } catch (err) {
      state = { error: String(err) }
    }
    return json({ reminders, state })
  }

  if (path === '/api/internal/event-nudges' && req.method === 'GET') {
    if (!internalOk(req)) return json({ error: 'Unauthorized' }, 401)
    const persona = url.searchParams.get('persona') || ''
    if (!isPersona(persona)) return json({ error: 'persona required' }, 400)
    const nudges = await dueEventNudges(sql, persona)
    return json({ nudges })
  }

  if (path === '/api/internal/event-nudges/revert' && req.method === 'POST') {
    if (!internalOk(req)) return json({ error: 'Unauthorized' }, 401)
    const body = (await req.json().catch(() => ({}))) as {
      phone?: string
      persona?: string
      key?: string
    }
    const persona = body.persona || ''
    if (!body.phone || !isPersona(persona) || !body.key) {
      return json({ error: 'phone, persona, and key required' }, 400)
    }
    const user = await getUserByPhone(sql, body.phone)
    if (!user) return json({ error: 'User not found' }, 404)
    await sql`
      DELETE FROM hire_nudge_log
      WHERE user_id = ${user.id} AND persona = ${persona} AND nudge_key = ${body.key}
    `
    return json({ ok: true })
  }

  if (path === '/api/internal/proactive' && req.method === 'POST') {
    if (!internalOk(req)) return json({ error: 'Unauthorized' }, 401)
    const body = (await req.json().catch(() => ({}))) as {
      phone?: string
      persona?: string
      proactive?: string
      quietHours?: string
      pausedUntil?: string | null
      pauseToday?: boolean
    }
    const persona = body.persona || ''
    if (!body.phone || !isPersona(persona)) {
      return json({ error: 'phone and persona required' }, 400)
    }
    const user = await getUserByPhone(sql, body.phone)
    if (!user) return json({ error: 'User not found' }, 404)
    const patch: Record<string, unknown> = {}
    const mode = String(body.proactive || '').toLowerCase()
    if (mode === 'on' || mode === 'paused' || mode === 'off') patch.proactive = mode
    const quiet = String(body.quietHours || '').trim()
    if (/^\d{1,2}:\d{2}\s*-\s*\d{1,2}:\d{2}$/.test(quiet)) {
      patch.quiet_hours = quiet.replace(/\s+/g, '')
    }
    if (body.pausedUntil === null || body.pausedUntil === '') {
      patch.paused_until = ''
    } else if (body.pausedUntil && !Number.isNaN(new Date(body.pausedUntil).getTime())) {
      patch.paused_until = new Date(body.pausedUntil).toISOString()
    }
    if (mode === 'on' || mode === 'off') patch.paused_until = ''
    if (body.pauseToday) {
      patch.proactive = 'paused'
      const tz = user.timezone || 'America/Los_Angeles'
      patch.paused_until = nextLocalTimeUtc(tz, 0, 0)
    }
    const fields = await upsertContext(sql, user.id, persona, patch)
    return json({
      ok: true,
      proactive: fields.proactive || 'on',
      quietHours: fields.quiet_hours || '22:00-08:00',
      pausedUntil: fields.paused_until || null,
    })
  }

  if (path === '/api/internal/last-proactive' && req.method === 'GET') {
    if (!internalOk(req)) return json({ error: 'Unauthorized' }, 401)
    const phone = url.searchParams.get('phone') || ''
    const persona = url.searchParams.get('persona') || ''
    if (!phone || !isPersona(persona)) return json({ error: 'phone and persona required' }, 400)
    const user = await getUserByPhone(sql, phone)
    if (!user) return json({ error: 'User not found' }, 404)
    const fields = await loadContext(sql, user.id, persona)
    return json({
      topic: fields.last_proactive_topic || null,
      minutesAgo: minutesAgo(fields.last_proactive_at),
    })
  }

  if (path === '/api/internal/proactive/sent' && req.method === 'POST') {
    if (!internalOk(req)) return json({ error: 'Unauthorized' }, 401)
    const body = (await req.json().catch(() => ({}))) as {
      phone?: string
      persona?: string
      topic?: string
      freeze?: boolean
    }
    const persona = body.persona || ''
    if (!body.phone || !isPersona(persona)) {
      return json({ error: 'phone and persona required' }, 400)
    }
    const user = await getUserByPhone(sql, body.phone)
    if (!user) return json({ error: 'User not found' }, 404)
    const tz = user.timezone || 'America/Los_Angeles'
    const today = localDateStrInTz(new Date(), tz)
    const fields = await loadContext(sql, user.id, persona)
    if (body.freeze) {
      await upsertContext(sql, user.id, persona, {
        unanswered_proactive: '2',
        last_proactive_topic: 'blocked',
      })
      return json({ ok: true, frozen: true })
    }
    const prevUnanswered = Math.max(0, Number(fields.unanswered_proactive) || 0)
    const sameDay = String(fields.last_proactive_day || '') === today
    const dayCount = sameDay ? Math.max(0, Number(fields.unanswered_day_count) || 0) : 0
    await upsertContext(sql, user.id, persona, {
      last_proactive_at: new Date().toISOString(),
      last_proactive_topic: String(body.topic || 'check_in').slice(0, 40),
      last_proactive_day: today,
      unanswered_proactive: String(prevUnanswered + 1),
      unanswered_day_count: String(dayCount + 1),
    })
    return json({ ok: true })
  }

  if (path === '/api/internal/reminders' && req.method === 'POST') {
    if (!internalOk(req)) return json({ error: 'Unauthorized' }, 401)
    const body = (await req.json().catch(() => ({}))) as {
      phone?: string
      persona?: string
      text?: string
      scheduledAt?: string
      recurrence?: string
      timezone?: string
    }
    if (!body.phone || !body.persona || !isPersona(body.persona) || !body.text?.trim()) {
      return json({ error: 'phone, persona, and text required' }, 400)
    }
    const at = new Date(body.scheduledAt || '')
    if (Number.isNaN(at.getTime())) return json({ error: 'scheduledAt required' }, 400)
    const user = await getUserByPhone(sql, body.phone)
    if (!user) return json({ error: 'User not found' }, 404)
    const recurrence = body.recurrence === 'daily' || body.recurrence === 'weekly' ? body.recurrence : 'once'
    const id = crypto.randomUUID()
    await sql`
      INSERT INTO hire_reminders (id, user_id, persona, text, scheduled_at, recurrence, timezone, status)
      VALUES (${id}, ${user.id}, ${body.persona}, ${body.text.trim()}, ${at.toISOString()}, ${recurrence}, ${body.timezone || null}, 'pending')
    `
    return json({ ok: true, reminder: { id, scheduledAt: at.toISOString(), recurrence, text: body.text.trim() } })
  }

  if (path === '/api/internal/reminders/due' && req.method === 'GET') {
    if (!internalOk(req)) return json({ error: 'Unauthorized' }, 401)
    const persona = url.searchParams.get('persona') || ''
    if (!isPersona(persona)) return json({ error: 'persona required' }, 400)
    const rows = await sql`
      SELECT r.id, r.user_id AS "userId", u.phone_e164 AS phone, r.text, r.scheduled_at AS "scheduledAt", r.recurrence, r.timezone
      FROM hire_reminders r
      JOIN hire_users u ON u.id = r.user_id
      WHERE r.persona = ${persona} AND r.status = 'pending' AND r.scheduled_at <= now()
      ORDER BY r.scheduled_at ASC
      LIMIT 25
    `
    const reminders = rows.map((r: { id: string; userId: string; phone: string; text: string; scheduledAt: Date; recurrence: string; timezone: string | null }) => ({
      id: r.id,
      userId: r.userId,
      phone: r.phone,
      text: r.text,
      scheduledAt: new Date(r.scheduledAt).toISOString(),
      recurrence: r.recurrence,
      timezone: r.timezone,
    }))
    return json({ reminders })
  }

  if (path === '/api/internal/reminders/list' && req.method === 'GET') {
    if (!internalOk(req)) return json({ error: 'Unauthorized' }, 401)
    const phone = url.searchParams.get('phone') || ''
    const persona = url.searchParams.get('persona') || ''
    if (!phone || !isPersona(persona)) return json({ error: 'phone and persona required' }, 400)
    const user = await getUserByPhone(sql, phone)
    if (!user) return json({ reminders: [] })
    const rows = await sql`
      SELECT id, text, scheduled_at AS "scheduledAt", recurrence, status, timezone
      FROM hire_reminders
      WHERE user_id = ${user.id} AND persona = ${persona}
      ORDER BY scheduled_at ASC
      LIMIT 50
    `
    return json({
      reminders: rows.map((r: { id: string; text: string; scheduledAt: Date; recurrence: string; status: string; timezone: string | null }) => ({
        id: r.id,
        text: r.text,
        scheduledAt: new Date(r.scheduledAt).toISOString(),
        recurrence: r.recurrence,
        status: r.status,
        timezone: r.timezone,
      })),
    })
  }

  const reminderDone = path.match(/^\/api\/internal\/reminders\/([^/]+)\/done$/)
  if (reminderDone && req.method === 'POST') {
    if (!internalOk(req)) return json({ error: 'Unauthorized' }, 401)
    const body = (await req.json().catch(() => ({}))) as { nextAt?: string; revert?: boolean }
    // Atomic claim: only a poll that updates a still-pending row wins, so an
    // overlapping poll cycle can never double-fire the same reminder.
    const rows = await sql`
      SELECT id, recurrence, timezone, scheduled_at AS "scheduledAt" FROM hire_reminders WHERE id = ${reminderDone[1]} LIMIT 1
    `
    const row = rows[0] as
      | { id: string; recurrence: string; timezone: string | null; scheduledAt: Date }
      | undefined
    if (!row) return json({ error: 'Reminder not found' }, 404)
    if (body.revert) {
      // Send failed after claim — return to 'pending' so the next poll retries
      // (same-time for once, current scheduled time for recurring).
      await sql`UPDATE hire_reminders SET status = 'pending', updated_at = now() WHERE id = ${row.id}`
      return json({ ok: true, claimed: true, reverted: true })
    }
    if (row.recurrence !== 'once') {
      const ts = new Date(row.scheduledAt).toISOString()
      const nextAt =
        body.nextAt && !Number.isNaN(new Date(body.nextAt).getTime())
          ? body.nextAt
          : nextReminderAt(ts, row.recurrence, row.timezone || 'America/Los_Angeles')
      const upd = await sql`
        UPDATE hire_reminders
        SET scheduled_at = ${nextAt}, updated_at = now()
        WHERE id = ${row.id} AND status = 'pending'
      `
      if (upd && (upd as { count?: number }).count === 0) {
        return json({ ok: true, claimed: false, rescheduled: false })
      }
      return json({ ok: true, claimed: true, rescheduled: true, nextAt })
    }
    const upd = await sql`
      UPDATE hire_reminders SET status = 'sent' WHERE id = ${row.id} AND status = 'pending'
    `
    if (upd && (upd as { count?: number }).count === 0) {
      return json({ ok: true, claimed: false, rescheduled: false })
    }
    return json({ ok: true, claimed: true, rescheduled: false })
  }

  if (path === '/api/internal/reminders' && req.method === 'DELETE') {
    if (!internalOk(req)) return json({ error: 'Unauthorized' }, 401)
    const id = url.searchParams.get('id') || ''
    if (!id) return json({ error: 'id required' }, 400)
    await sql`DELETE FROM hire_reminders WHERE id = ${id}`
    return json({ ok: true })
  }

  /* ---- Habits ---- */
  if (path === '/api/habits' && req.method === 'GET') {
    const { user, error } = await resolveAuthedUser(sql, {
      token: url.searchParams.get('t') || undefined,
      session: url.searchParams.get('s') || undefined,
      email: url.searchParams.get('email') || undefined,
    })
    if (error) return error
    const rows = await sql`
      SELECT id, name, emoji, created_at AS "createdAt"
      FROM hire_habits WHERE user_id = ${user!.id} ORDER BY created_at ASC
    `
    const tz = user!.timezone || 'America/Los_Angeles'
    const today = localDateStrInTz(new Date(), tz)
    const weekStart = mondayOfDateStr(today)
    const weekDays = weekDaysFromMonday(weekStart)
    const cutoff = shiftDateStr(today, -400)
    const logRows = await sql`
      SELECT habit_id AS "habitId", date FROM hire_habit_logs
      WHERE user_id = ${user!.id} AND date >= ${cutoff}
    `
    const logMap = new Map<string, Set<string>>()
    for (const lr of logRows as Array<{ habitId: string; date: string }>) {
      if (!logMap.has(lr.habitId)) logMap.set(lr.habitId, new Set())
      logMap.get(lr.habitId)!.add(lr.date.slice(0, 10))
    }
    const habits = (rows as Array<{ id: string; name: string; emoji: string; createdAt: string }>).map((h) => {
      const dates = logMap.get(h.id) || new Set()
      let cursor = dates.has(today) ? today : shiftDateStr(today, -1)
      let streak = 0
      while (dates.has(cursor)) {
        streak++
        cursor = shiftDateStr(cursor, -1)
      }
      const cutoff12w = shiftDateStr(today, -84)
      const logDates = [...dates].filter((d) => d >= cutoff12w).sort()
      return { ...h, streak, recentDays: weekDays.filter((d) => dates.has(d)), logDates }
    })
    return json({ habits, weekDays, weekStart })
  }

  if (path === '/api/habits' && req.method === 'POST') {
    const body = (await req.json().catch(() => ({}))) as {
      token?: string; email?: string; name?: string; emoji?: string
    }
    const name = String(body.name || '').trim().slice(0, 100)
    if (!name) return json({ error: 'name required' }, 400)
    const { user, error } = await resolveAuthedUser(sql, { token: body.token, session: body.session, email: body.email })
    if (error) return error
    const id = crypto.randomUUID()
    const emoji = String(body.emoji || '💪').slice(0, 8)
    await sql`INSERT INTO hire_habits (id, user_id, name, emoji) VALUES (${id}, ${user!.id}, ${name}, ${emoji})`
    return json({ ok: true, id })
  }

  if (path === '/api/habits/toggle' && req.method === 'POST') {
    const body = (await req.json().catch(() => ({}))) as {
      token?: string; email?: string; habitId?: string; date?: string
    }
    if (!body.habitId || !body.date) return json({ error: 'habitId and date required' }, 400)
    const { user, error } = await resolveAuthedUser(sql, { token: body.token, session: body.session, email: body.email })
    if (error) return error
    const dateStr = body.date.slice(0, 10)
    // Try to delete first; if nothing deleted, insert
    const del = await sql`DELETE FROM hire_habit_logs WHERE user_id = ${user!.id} AND habit_id = ${body.habitId} AND date = ${dateStr}`
    const done = !(del && (del as { count?: number }).count)
    if (done) {
      await sql`INSERT INTO hire_habit_logs (id, user_id, habit_id, date) VALUES (${crypto.randomUUID()}, ${user!.id}, ${body.habitId}, ${dateStr})`
    }
    return json({ ok: true, done })
  }

  if (path.startsWith('/api/habits/') && req.method === 'POST') {
    // Delete habit: /api/habits/{id} with _delete body
    const body = (await req.json().catch(() => ({}))) as { token?: string; email?: string; _delete?: boolean }
    if (!body._delete) return json({ error: 'Not found' }, 404)
    const habitId = path.split('/')[3]
    if (!habitId) return json({ error: 'habitId required' }, 400)
    const { user, error } = await resolveAuthedUser(sql, { token: body.token, session: body.session, email: body.email })
    if (error) return error
    await sql`DELETE FROM hire_habit_logs WHERE user_id = ${user!.id} AND habit_id = ${habitId}`
    await sql`DELETE FROM hire_habits WHERE id = ${habitId} AND user_id = ${user!.id}`
    return json({ ok: true })
  }

  /* ---- Moods ---- */
  if (path === '/api/moods' && req.method === 'GET') {
    const { user, error } = await resolveAuthedUser(sql, {
      token: url.searchParams.get('t') || undefined,
      session: url.searchParams.get('s') || undefined,
      email: url.searchParams.get('email') || undefined,
    })
    if (error) return error
    const entries = await sql`
      SELECT id, emoji, energy, note, created_at AS "createdAt"
      FROM hire_moods WHERE user_id = ${user!.id}
      ORDER BY created_at DESC LIMIT 30
    `
    const tz = user!.timezone || 'America/Los_Angeles'
    const days = new Set(
      (entries as Array<{ createdAt: Date | string }>).map((e) =>
        localDateStrInTz(new Date(e.createdAt), tz),
      ),
    )
    let streak = 0
    let cursor = localDateStrInTz(new Date(), tz)
    while (days.has(cursor) && streak < 30) {
      streak++
      cursor = shiftDateStr(cursor, -1)
    }
    return json({ entries, streak })
  }

  if (path === '/api/moods' && req.method === 'POST') {
    const body = (await req.json().catch(() => ({}))) as {
      token?: string; email?: string; emoji?: string; energy?: number; note?: string
    }
    if (!body.emoji) return json({ error: 'emoji required' }, 400)
    const { user, error } = await resolveAuthedUser(sql, { token: body.token, session: body.session, email: body.email })
    if (error) return error
    const id = crypto.randomUUID()
    const energy = Math.max(1, Math.min(5, Math.round(body.energy || 3)))
    const note = String(body.note || '').trim().slice(0, 500) || null
    const { start, end } = todayWindowUtc(user!.timezone || 'America/Los_Angeles')
    await sql`
      DELETE FROM hire_moods
      WHERE user_id = ${user!.id}
        AND created_at >= ${start.toISOString()}
        AND created_at < ${end.toISOString()}
    `
    await sql`INSERT INTO hire_moods (id, user_id, emoji, energy, note) VALUES (${id}, ${user!.id}, ${body.emoji}, ${energy}, ${note})`
    return json({ ok: true, id })
  }

  /* ---- Workouts ---- */
  if (path === '/api/workouts' && req.method === 'GET') {
    const { user, error } = await resolveAuthedUser(sql, {
      token: url.searchParams.get('t') || undefined,
      session: url.searchParams.get('s') || undefined,
      email: url.searchParams.get('email') || undefined,
    })
    if (error) return error
    const logs = await sql`
      SELECT id, exercise, sets, reps, weight, notes, logged_at AS "loggedAt"
      FROM hire_workouts WHERE user_id = ${user!.id}
      ORDER BY logged_at DESC LIMIT 40
    `
    const prRows = await sql`
      SELECT DISTINCT ON (lower(exercise)) exercise, weight, reps, logged_at AS "loggedAt"
      FROM hire_workouts WHERE user_id = ${user!.id} AND weight > 0
      ORDER BY lower(exercise), weight DESC, reps DESC
    `
    const prefs = await loadMiniPrefs(sql, user!.id)
    return json({
      logs,
      prs: prRows,
      workoutPlace: prefs.workoutPlace,
      workoutMoveCount: prefs.workoutMoveCount,
      workoutDays: prefs.workoutDays,
    })
  }

  if (path === '/api/workouts' && req.method === 'POST') {
    const body = (await req.json().catch(() => ({}))) as {
      token?: string; email?: string; exercise?: string; sets?: number; reps?: number; weight?: number; notes?: string
    }
    const exercise = String(body.exercise || '').trim().slice(0, 80)
    if (!exercise) return json({ error: 'exercise required' }, 400)
    const { user, error } = await resolveAuthedUser(sql, { token: body.token, session: body.session, email: body.email })
    if (error) return error
    const id = crypto.randomUUID()
    const sets = Math.max(1, Math.min(20, Math.round(body.sets || 1)))
    const reps = Math.max(1, Math.min(100, Math.round(body.reps || 1)))
    const weight = Math.max(0, Number(body.weight) || 0)
    const notes = String(body.notes || '').trim().slice(0, 300) || null
    await sql`
      INSERT INTO hire_workouts (id, user_id, exercise, sets, reps, weight, notes)
      VALUES (${id}, ${user!.id}, ${exercise}, ${sets}, ${reps}, ${weight}, ${notes})
    `
    return json({ ok: true, id })
  }

  if (path.startsWith('/api/workouts/') && req.method === 'POST') {
    const body = (await req.json().catch(() => ({}))) as { token?: string; email?: string; _delete?: boolean }
    if (!body._delete) return json({ error: 'Not found' }, 404)
    const id = path.split('/')[3]
    if (!id) return json({ error: 'id required' }, 400)
    const { user, error } = await resolveAuthedUser(sql, { token: body.token, session: body.session, email: body.email })
    if (error) return error
    await sql`DELETE FROM hire_workouts WHERE id = ${id} AND user_id = ${user!.id}`
    return json({ ok: true })
  }

  /* ---- Learning queue ---- */
  if (path === '/api/learning' && req.method === 'GET') {
    const { user, error } = await resolveAuthedUser(sql, {
      token: url.searchParams.get('t') || undefined,
      session: url.searchParams.get('s') || undefined,
      email: url.searchParams.get('email') || undefined,
    })
    if (error) return error
    const items = await sql`
      SELECT id, title, url, kind, minutes, notes, status, created_at AS "createdAt"
      FROM hire_learning WHERE user_id = ${user!.id}
      ORDER BY CASE WHEN status = 'queued' THEN 0 ELSE 1 END, minutes ASC, created_at DESC
    `
    return json({ items })
  }

  if (path === '/api/learning' && req.method === 'POST') {
    const body = (await req.json().catch(() => ({}))) as {
      token?: string; email?: string; title?: string; url?: string; kind?: string; minutes?: number; notes?: string
    }
    const title = String(body.title || '').trim().slice(0, 160)
    if (!title) return json({ error: 'title required' }, 400)
    const { user, error } = await resolveAuthedUser(sql, { token: body.token, session: body.session, email: body.email })
    if (error) return error
    const kind = ['article', 'video', 'podcast'].includes(String(body.kind)) ? String(body.kind) : 'article'
    const minutes = Math.max(1, Math.min(240, Math.round(body.minutes || 10)))
    const itemUrl = String(body.url || '').trim().slice(0, 500) || null
    const notes = String(body.notes || '').trim().slice(0, 500) || null
    const id = crypto.randomUUID()
    await sql`
      INSERT INTO hire_learning (id, user_id, title, url, kind, minutes, notes)
      VALUES (${id}, ${user!.id}, ${title}, ${itemUrl}, ${kind}, ${minutes}, ${notes})
    `
    return json({ ok: true, id })
  }

  if (path.startsWith('/api/learning/') && req.method === 'POST') {
    const body = (await req.json().catch(() => ({}))) as {
      token?: string; email?: string; _delete?: boolean; status?: string
    }
    const id = path.split('/')[3]
    if (!id) return json({ error: 'id required' }, 400)
    const { user, error } = await resolveAuthedUser(sql, { token: body.token, session: body.session, email: body.email })
    if (error) return error
    if (body._delete) {
      await sql`DELETE FROM hire_learning WHERE id = ${id} AND user_id = ${user!.id}`
      return json({ ok: true })
    }
    const status = body.status === 'done' ? 'done' : 'queued'
    await sql`UPDATE hire_learning SET status = ${status} WHERE id = ${id} AND user_id = ${user!.id}`
    return json({ ok: true })
  }

  /* ---- Weekly review ---- */
  if (path === '/api/weekly-review' && req.method === 'GET') {
    const { user, error } = await resolveAuthedUser(sql, {
      token: url.searchParams.get('t') || undefined,
      session: url.searchParams.get('s') || undefined,
      email: url.searchParams.get('email') || undefined,
    })
    if (error) return error
    const weekStart = userMonday(user!)
    const weekEndStr = shiftDateStr(weekStart, 7)
    const weekWindow = weekWindowUtc(weekStart, user!.timezone || 'America/Los_Angeles')

    const nutr = await sql`
      SELECT count(*)::int AS meals, coalesce(sum(calories), 0)::real AS calories
      FROM hire_nutrition_logs WHERE user_id = ${user!.id} AND eaten_at >= ${weekWindow.start.toISOString()} AND eaten_at < ${weekWindow.end.toISOString()}
    `
    const moods = await sql`
      SELECT count(*)::int AS logs, coalesce(avg(energy), 0)::real AS energy
      FROM hire_moods WHERE user_id = ${user!.id} AND created_at >= ${weekWindow.start.toISOString()} AND created_at < ${weekWindow.end.toISOString()}
    `
    const habits = await sql`
      SELECT count(*)::int AS checks FROM hire_habit_logs
      WHERE user_id = ${user!.id} AND date >= ${weekStart} AND date < ${weekEndStr}
    `
    const sleep = await sql`
      SELECT sleep_date AS "sleepDate", bedtime, wake FROM hire_sleep
      WHERE user_id = ${user!.id} AND sleep_date >= ${weekStart} AND sleep_date < ${weekEndStr}
    `
    const spend = await sql`
      SELECT coalesce(sum(amount), 0)::real AS total FROM hire_spending
      WHERE user_id = ${user!.id} AND spent_at >= ${weekWindow.start.toISOString()} AND spent_at < ${weekWindow.end.toISOString()}
    `
    const gratitude = await sql`
      SELECT count(*)::int AS n FROM hire_gratitude
      WHERE user_id = ${user!.id} AND created_at >= ${weekWindow.start.toISOString()} AND created_at < ${weekWindow.end.toISOString()}
    `
    const duePeople = await sql`
      SELECT count(*)::int AS n FROM hire_network
      WHERE user_id = ${user!.id}
        AND (last_touch IS NULL OR last_touch < now() - (cadence_days || ' days')::interval)
    `

    let sleepHours = 0
    const sleepRows = sleep as Array<{ bedtime: string; wake: string }>
    if (sleepRows.length) {
      sleepHours = sleepRows.reduce((sum, r) => sum + sleepHoursBetween(r.bedtime, r.wake), 0) / sleepRows.length
    }

    const reviews = await sql`
      SELECT id, week_start AS "weekStart", done_text AS "doneText", slipped_text AS "slippedText",
             focus_text AS "focusText", created_at AS "createdAt"
      FROM hire_weekly_reviews WHERE user_id = ${user!.id}
      ORDER BY week_start DESC LIMIT 8
    `
    const current = (reviews as Array<{ weekStart: string }>).find((r) => r.weekStart === weekStart) || null

    return json({
      weekStart,
      snapshot: {
        meals: Number((nutr[0] as { meals: number })?.meals || 0),
        calories: Number((nutr[0] as { calories: number })?.calories || 0),
        moodLogs: Number((moods[0] as { logs: number })?.logs || 0),
        avgEnergy: Number((moods[0] as { energy: number })?.energy || 0),
        habitChecks: Number((habits[0] as { checks: number })?.checks || 0),
        sleepNights: sleepRows.length,
        avgSleepHours: Math.round(sleepHours * 10) / 10,
        spend: Number((spend[0] as { total: number })?.total || 0),
        gratitude: Number((gratitude[0] as { n: number })?.n || 0),
        followUpsDue: Number((duePeople[0] as { n: number })?.n || 0),
      },
      current,
      reviews,
    })
  }

  if (path === '/api/weekly-review' && req.method === 'POST') {
    const body = (await req.json().catch(() => ({}))) as {
      token?: string; email?: string; weekStart?: string; doneText?: string; slippedText?: string; focusText?: string
    }
    const { user, error } = await resolveAuthedUser(sql, { token: body.token, session: body.session, email: body.email })
    if (error) return error
    const weekStart = String(body.weekStart || userMonday(user!)).slice(0, 10)
    const doneText = String(body.doneText || '').trim().slice(0, 800)
    const slippedText = String(body.slippedText || '').trim().slice(0, 800)
    const focusText = String(body.focusText || '').trim().slice(0, 400)
    const id = crypto.randomUUID()
    await sql`
      INSERT INTO hire_weekly_reviews (id, user_id, week_start, done_text, slipped_text, focus_text)
      VALUES (${id}, ${user!.id}, ${weekStart}, ${doneText}, ${slippedText}, ${focusText})
      ON CONFLICT (user_id, week_start) DO UPDATE SET
        done_text = excluded.done_text,
        slipped_text = excluded.slipped_text,
        focus_text = excluded.focus_text
    `
    return json({ ok: true })
  }

  /* ---- Home (the friend home screen) ---- */
  // '/api/mirror' is the old path for this screen. Keep answering it for one release
  // so a client build already loaded in someone's browser does not start failing.
  if ((path === '/api/home' || path === '/api/mirror') && req.method === 'GET') {
    const { user, error } = await resolveAuthedUser(sql, {
      token: url.searchParams.get('t') || undefined,
      session: url.searchParams.get('s') || undefined,
      email: url.searchParams.get('email') || undefined,
    })
    if (error) return error
    const weekStart = userMonday(user!)
    const weekEndStr = shiftDateStr(weekStart, 7)
    const dayStart = shiftDateStr(weekStart, -14)
    const tzLocal = user!.timezone || 'America/Los_Angeles'
    const todayLocal = localDateStrInTz(new Date(), tzLocal)

    const lastNightKey = shiftDateStr(todayLocal, -1)

    /* The tables below keep TIMESTAMPTZ timestamps. Comparing one against a
     * bare `::date` reads it at midnight in the database's own session timezone,
     * so "today" silently ended at 5 PM Pacific: a dinner logged at 11 PM never
     * reached Home's protein row. Compare against the true UTC instants instead. */
    const dayWindow = todayWindowUtc(tzLocal)
    const weekWindow = weekWindowUtc(weekStart, tzLocal)
    const trendStart = weekWindowUtc(shiftDateStr(weekStart, -14), tzLocal).start

    /* These were awaited one at a time: twenty-odd round trips to Postgres, in
     * series, before the page had a single number to paint. Nothing here reads
     * anything else here, so they go out together and the slice costs about as
     * long as its slowest query instead of the sum of all of them. */
    const [
      nutr,
      nutrToday,
      nutrGoals,
      workoutsTodayRows,
      moods,
      habitRows,
      habitLogs,
      sleep,
      spend,
      spendByCat,
      budgetRow,
      workouts,
      prs,
      learning,
      learningNext,
      gratitude,
      decisions,
      moodTrend,
      sleepTrendRows,
      reviews,
      lastNightRows,
      prefs,
      duePeopleRows,
      dueLoopRows,
      runwayRows,
    ] = await Promise.all([
      sql`
        SELECT count(*)::int AS meals, coalesce(sum(calories), 0)::real AS calories
        FROM hire_nutrition_logs WHERE user_id = ${user!.id} AND eaten_at >= ${weekWindow.start.toISOString()} AND eaten_at < ${weekWindow.end.toISOString()}
      `,
      sql`
        SELECT coalesce(sum(protein), 0)::real AS protein, coalesce(sum(calories), 0)::real AS calories, count(*)::int AS meals
        FROM hire_nutrition_logs WHERE user_id = ${user!.id} AND eaten_at >= ${dayWindow.start.toISOString()} AND eaten_at < ${dayWindow.end.toISOString()}
      `,
      sql`
        SELECT protein_goal AS "proteinGoal", calorie_goal AS "calorieGoal" FROM hire_nutrition_goals WHERE user_id = ${user!.id} LIMIT 1
      `,
      sql`
        SELECT count(*)::int AS n FROM hire_workouts
        WHERE user_id = ${user!.id} AND logged_at >= ${dayWindow.start.toISOString()} AND logged_at < ${dayWindow.end.toISOString()}
      `,
      sql`
        SELECT count(*)::int AS logs, coalesce(avg(energy), 0)::real AS energy
        FROM hire_moods WHERE user_id = ${user!.id} AND created_at >= ${weekWindow.start.toISOString()} AND created_at < ${weekWindow.end.toISOString()}
      `,
      sql`
        SELECT id, name FROM hire_habits WHERE user_id = ${user!.id} ORDER BY created_at ASC LIMIT 12
      `,
      sql`
        SELECT habit_id AS "habitId", date FROM hire_habit_logs
        WHERE user_id = ${user!.id} AND date >= ${weekStart} AND date < ${weekEndStr}
      `,
      sql`
        SELECT sleep_date AS "sleepDate", bedtime, wake, quality FROM hire_sleep
        WHERE user_id = ${user!.id} AND sleep_date >= ${weekStart} AND sleep_date < ${weekEndStr}
      `,
      sql`
        SELECT coalesce(sum(amount), 0)::real AS total FROM hire_spending
        WHERE user_id = ${user!.id} AND spent_at >= ${weekWindow.start.toISOString()} AND spent_at < ${weekWindow.end.toISOString()}
      `,
      sql`
        SELECT category, coalesce(sum(amount), 0)::real AS amount FROM hire_spending
        WHERE user_id = ${user!.id} AND spent_at >= ${weekWindow.start.toISOString()} AND spent_at < ${weekWindow.end.toISOString()}
        GROUP BY category ORDER BY amount DESC
      `,
      sql`SELECT weekly_budget AS "weeklyBudget" FROM hire_spending_budget WHERE user_id = ${user!.id}`,
      sql`
        SELECT count(*)::int AS n FROM hire_workouts
        WHERE user_id = ${user!.id} AND logged_at >= ${weekWindow.start.toISOString()} AND logged_at < ${weekWindow.end.toISOString()}
      `,
      sql`
        SELECT exercise, max(weight) AS weight FROM hire_workouts
        WHERE user_id = ${user!.id} AND weight > 0
        GROUP BY exercise ORDER BY weight DESC LIMIT 5
      `,
      sql`
        SELECT status, count(*)::int AS n, coalesce(sum(minutes), 0)::int AS mins FROM hire_learning
        WHERE user_id = ${user!.id} GROUP BY status
      `,
      sql`
        SELECT title FROM hire_learning WHERE user_id = ${user!.id} AND status = 'queued'
        ORDER BY created_at ASC LIMIT 1
      `,
      sql`
        SELECT count(*)::int AS n FROM hire_gratitude
        WHERE user_id = ${user!.id} AND created_at >= ${weekWindow.start.toISOString()} AND created_at < ${weekWindow.end.toISOString()}
      `,
      sql`
        SELECT count(*) FILTER (WHERE outcome IS NULL)::int AS open,
               count(*) FILTER (WHERE outcome IS NOT NULL)::int AS resolved
        FROM hire_decisions WHERE user_id = ${user!.id}
      `,
      sql`
        SELECT emoji, energy, created_at AS "createdAt" FROM hire_moods
        WHERE user_id = ${user!.id} AND created_at >= ${trendStart.toISOString()}
        ORDER BY created_at ASC LIMIT 60
      `,
      sql`
        SELECT sleep_date AS "sleepDate", bedtime, wake, quality FROM hire_sleep
        WHERE user_id = ${user!.id} AND sleep_date >= ${dayStart} AND sleep_date < ${weekEndStr}
        ORDER BY sleep_date ASC LIMIT 21
      `,
      sql`
        SELECT id, week_start AS "weekStart", done_text AS "doneText", slipped_text AS "slippedText",
               focus_text AS "focusText", created_at AS "createdAt"
        FROM hire_weekly_reviews WHERE user_id = ${user!.id}
        ORDER BY week_start DESC LIMIT 4
      `,
      // Ran only when the week rows missed last night. In parallel it is free,
      // and it is the row the Body page reads on a Monday.
      sql`
        SELECT sleep_date AS "sleepDate", bedtime, wake, quality FROM hire_sleep
        WHERE user_id = ${user!.id} AND (sleep_date = ${lastNightKey} OR sleep_date = ${todayLocal})
        ORDER BY sleep_date DESC LIMIT 1
      `,
      loadMiniPrefs(sql, user!.id),
      // `id` is what turns a person from a row you read into one you can act on:
      // without it home can name who is due but cannot mark them touched.
      sql`
        SELECT id, name, context, phone, last_touch AS "lastTouch", cadence_days AS "cadenceDays"
        FROM hire_network WHERE user_id = ${user!.id}
        ORDER BY coalesce(last_touch, '1970-01-01'::timestamptz) ASC LIMIT 8
      `,
      // The one promise closest to its deadline. Home only ever shows one, so
      // there is no reason to ship eight.
      sql`
        SELECT id, title, due_at AS "dueAt" FROM hire_loops
        WHERE user_id = ${user!.id} AND status = 'open'
        ORDER BY due_at ASC NULLS LAST LIMIT 1
      `,
      // The most recent runway snapshot (cofounder), so home can show real months.
      sql`
        SELECT cash, burn, months, taken_on AS "takenOn" FROM hire_runway_snapshots
        WHERE user_id = ${user!.id}
        ORDER BY taken_on DESC LIMIT 1
      `,
    ])

    const habitChecks = (habitLogs as Array<{ habitId: string }>).length
    const habitNames = (habitRows as Array<{ name: string }>).map((h) => h.name)
    let sleepHours = 0
    const sleepRows = sleep as Array<{ sleepDate: string; bedtime: string; wake: string; quality: number }>
    if (sleepRows.length) {
      sleepHours = sleepRows.reduce((sum, r) => sum + sleepHoursBetween(r.bedtime, r.wake), 0) / sleepRows.length
    }
    const moodTrendRows = moodTrend as Array<{ emoji: string; energy: number; createdAt: Date }>
    const currentReview = (reviews as Array<{ weekStart: string }>).find((r) => r.weekStart === weekStart) || null
    const lrn = learning as Array<{ status: string; n: number; mins: number }>
    const queued = lrn.find((l) => l.status === 'queued')?.n || 0
    const done = lrn.find((l) => l.status === 'done')?.n || 0

    const sortedSleep = [...sleepRows].sort((a, b) => String(a.sleepDate).localeCompare(String(b.sleepDate)))
    const sleepHoursList = sortedSleep.map((r) => sleepHoursBetween(r.bedtime, r.wake))
    const lastNightFromWeek = sleepRows.find((r) => {
      const d = ymdOf(r.sleepDate)
      return d === lastNightKey || d === todayLocal
    })
    const lastNightLookup =
      lastNightFromWeek || (lastNightRows[0] as { sleepDate?: string; bedtime?: string; wake?: string } | undefined)
    const lastNightHours = lastNightLookup?.bedtime && lastNightLookup?.wake
      ? sleepHoursBetween(lastNightLookup.bedtime, lastNightLookup.wake)
      : 0
    const lastNightLogged = !!(lastNightLookup?.bedtime && lastNightLookup?.wake)
    const shortNights = sleepHoursList.filter((h) => h < 6.5).length
    const gToday = nutrGoals[0] as { proteinGoal?: number; calorieGoal?: number } | undefined
    const nToday = nutrToday[0] as { protein?: number; calories?: number; meals?: number } | undefined

    const weekday = new Intl.DateTimeFormat('en-US', { timeZone: tzLocal, weekday: 'long' }).format(new Date())
    const dateLabel = new Intl.DateTimeFormat('en-US', {
      timeZone: tzLocal,
      weekday: 'long',
      month: 'short',
      day: 'numeric',
    }).format(new Date())
    let hour = Number(
      new Intl.DateTimeFormat('en-US', { timeZone: tzLocal, hour: 'numeric', hour12: false }).format(new Date()),
    )
    if (hour === 24) hour = 0

    const workoutLabel = workoutTodayLabel(weekday, prefs.workoutPlace)
    const workoutsTodayN = Number((workoutsTodayRows[0] as { n?: number })?.n || 0)

    const peopleDue = (duePeopleRows as Array<{
      id: string; name: string; context: string; phone: string; lastTouch: Date | null; cadenceDays: number
    }>)
      .map((p) => {
        const days = p.lastTouch ? Math.floor((Date.now() - new Date(p.lastTouch).getTime()) / 86400000) : 999
        return { id: p.id, name: p.name, days, phone: p.phone || undefined, context: p.context || undefined, due: days >= (p.cadenceDays || 14) }
      })
      .filter((p) => p.due)
      .slice(0, 3)
      .map(({ id, name, days, phone, context }) => ({ id, name, days, phone, context }))

    const dueLoopRow = (dueLoopRows as Array<{ id: string; title: string; dueAt: Date | null }>)[0]
    const dueLoop = dueLoopRow
      ? { id: dueLoopRow.id, title: dueLoopRow.title, dueAt: dueLoopRow.dueAt ? new Date(dueLoopRow.dueAt).toISOString() : null }
      : null
    const runwayRow = (runwayRows as Array<{ cash: number; burn: number; months: number; takenOn: string }>)[0]
    const runway = runwayRow
      ? { cash: Math.round(runwayRow.cash), burn: Math.round(runwayRow.burn), months: Math.round(runwayRow.months * 10) / 10, takenOn: runwayRow.takenOn }
      : null

    /* Calendar, Gmail and the mail-kind judge, off the critical path. A stale
     * answer paints instantly while the next one loads behind the response;
     * only a cold first open waits, and only briefly. */
    const world = await homeWorldCache.read(`${user!.id}|${tzLocal}`, () => loadHomeWorld(sql, user!, tzLocal))
    const { upcoming, mail, mailGroups, meetings, attention } = world.value ?? EMPTY_HOME_WORLD

    /* A repeat open is usually the same bytes, so let the browser revalidate
     * rather than re-download — unless the world slice is still filling in, in
     * which case the client's own refetch must not be answered from a cache. */
    return jsonRevalidated(req, world.pending ? 0 : 60, {
      weekStart,
      // The calendar and inbox are still loading, so what the client has is
      // incomplete: one quiet refetch fills it in.
      worldPending: world.pending,
      home: {
        weekday,
        dateLabel,
        hour,
        upcoming,
        mail,
        mailGroups,
        meetings,
        attention,
        peopleDue,
        dueLoop,
        runway,
        lastNight: {
          logged: lastNightLogged,
          hours: Math.round(lastNightHours * 10) / 10,
          bedtime: lastNightLookup?.bedtime,
          wake: lastNightLookup?.wake,
        },
        workout: {
          name: workoutLabel.name,
          rest: workoutLabel.rest,
          done: workoutsTodayN > 0,
        },
      },
      window: {
        meals: Number((nutr[0] as { meals: number })?.meals || 0),
        calories: Number((nutr[0] as { calories: number })?.calories || 0),
        proteinToday: Math.round(Number(nToday?.protein) || 0),
        proteinGoal: Math.round(Number(gToday?.proteinGoal) || 150),
        caloriesToday: Math.round(Number(nToday?.calories) || 0),
        calorieGoal: Math.round(Number(gToday?.calorieGoal) || 2200),
        lastNightHours: Math.round(lastNightHours * 10) / 10,
        shortNights,
        workoutsToday: workoutsTodayN,
        moodLogs: Number((moods[0] as { logs: number })?.logs || 0),
        avgEnergy: Number((moods[0] as { energy: number })?.energy || 0),
        habitChecks,
        habits: habitNames,
        sleepNights: sleepRows.length,
        avgSleepHours: Math.round(sleepHours * 10) / 10,
        spend: Number((spend[0] as { total: number })?.total || 0),
        weeklyBudget: Math.round(Number((budgetRow[0] as { weeklyBudget?: number })?.weeklyBudget) || 400),
        workouts: Number((workouts[0] as { n: number })?.n || 0),
        learningQueued: queued,
        learningDone: done,
        gratitude: Number((gratitude[0] as { n: number })?.n || 0),
        decisionsOpen: Number((decisions[0] as { open: number })?.open || 0),
        decisionsResolved: Number((decisions[0] as { resolved: number })?.resolved || 0),
      },
      moodTrend: moodTrendRows.map((m) => ({
        emoji: m.emoji,
        energy: m.energy,
        date: localDateStrInTz(new Date(m.createdAt), tzLocal),
      })),
      // The three-week ordered rows, not this week's: the client takes the last
      // seven of what it is given, so the week rows made the chart start over on
      // a Monday and drew whatever order Postgres happened to return.
      sleepTrend: (sleepTrendRows as Array<{ sleepDate: string; bedtime: string; wake: string; quality: number }>).map(
        (r) => ({
          date: ymdOf(r.sleepDate),
          hours: sleepHoursBetween(r.bedtime, r.wake),
          quality: r.quality,
        }),
      ),
      spendByCategory: spendByCat as Array<{ category: string; amount: number }>,
      prs: (prs as Array<{ exercise: string; weight: number }>).map((p) => ({ exercise: p.exercise, weight: p.weight })),
      nextLearning: (learningNext[0] as { title?: string } | undefined)?.title || null,
      currentReview,
      reviews,
    })
  }

  /* ---- Networking CRM ---- */
  if (path === '/api/network' && req.method === 'GET') {
    const { user, error } = await resolveAuthedUser(sql, {
      token: url.searchParams.get('t') || undefined,
      session: url.searchParams.get('s') || undefined,
      email: url.searchParams.get('email') || undefined,
    })
    if (error) return error
    const persona = url.searchParams.get('persona') || 'friend'
    /* The people list is one query; the calendar behind `today` is a hop into
     * Google that measured between one and three seconds. They no longer wait
     * for each other, and the calendar half comes from the same stale-while-
     * revalidate cache home uses — this endpoint is polled by every screen that
     * shows who you are seeing today. */
    const [people, calResult] = await Promise.all([
      sql`
        SELECT id, name, where_met AS "whereMet", context, last_touch AS "lastTouch",
               cadence_days AS "cadenceDays", created_at AS "createdAt",
               phone, email AS "contactEmail", company
        FROM hire_network WHERE user_id = ${user!.id}
        ORDER BY coalesce(last_touch, '1970-01-01'::timestamptz) ASC
      `,
      // `lazy=1` says the caller will come back for the calendar half: People is
      // one query and should paint instantly, while the Google hop can take up
      // to 2.5s when the cache is cold. The CRM uses this so the roster shows
      // immediately and today's meetings fill in behind it.
      isPersona(persona) && !url.searchParams.has('lazy')
        ? todayMeetsCache
            .read(`${user!.id}|${persona}`, () => todayCalendarMeets(sql, user!, persona))
            .then((r) => r.value ?? EMPTY_TODAY_RESULT)
            .catch(() => EMPTY_TODAY_RESULT)
        : Promise.resolve(EMPTY_TODAY_RESULT),
    ])
    if (url.searchParams.has('lazy')) {
      const connected = await connectedForUser(sql, user!.id)
      return json({
        people,
        today: [],
        stay: null,
        calendarConnected: connected.includes('calendar'),
      })
    }
    return json({ people, today: calResult.meets, stay: calResult.stay, calendarConnected: calResult.calendarConnected })
  }

  if (path === '/api/network' && req.method === 'POST') {
    const body = (await req.json().catch(() => ({}))) as {
      token?: string; session?: string; email?: string; name?: string; whereMet?: string; context?: string
      cadenceDays?: number; phone?: string; contactEmail?: string; company?: string
    }
    const name = String(body.name || '').trim().slice(0, 80)
    if (!name) return json({ error: 'name required' }, 400)
    const { user, error } = await resolveAuthedUser(sql, { token: body.token, session: body.session, email: body.email })
    if (error) return error
    const id = crypto.randomUUID()
    const whereMet = String(body.whereMet || '').trim().slice(0, 120)
    const context = String(body.context || '').trim().slice(0, 400)
    const cadenceDays = Math.max(3, Math.min(365, Math.round(body.cadenceDays || 14)))
    const phone = String(body.phone || '').trim().slice(0, 40)
    const contactEmail = String(body.contactEmail || '').trim().slice(0, 120)
    const company = String(body.company || '').trim().slice(0, 120)
    await sql`
      INSERT INTO hire_network (id, user_id, name, where_met, context, last_touch, cadence_days, phone, email, company)
      VALUES (${id}, ${user!.id}, ${name}, ${whereMet}, ${context}, now(), ${cadenceDays}, ${phone}, ${contactEmail}, ${company})
    `
    return json({ ok: true, id })
  }

  if (path.startsWith('/api/network/') && req.method === 'POST') {
    const body = (await req.json().catch(() => ({}))) as {
      token?: string; session?: string; email?: string; _delete?: boolean; touch?: boolean; context?: string
      name?: string; phone?: string; contactEmail?: string; company?: string; whereMet?: string
      cadenceDays?: number; save?: boolean
    }
    const id = path.split('/')[3]
    if (!id) return json({ error: 'id required' }, 400)
    const { user, error } = await resolveAuthedUser(sql, { token: body.token, session: body.session, email: body.email })
    if (error) return error
    if (body._delete) {
      await sql`DELETE FROM hire_network WHERE id = ${id} AND user_id = ${user!.id}`
      return json({ ok: true })
    }
    if (body.save) {
      const name = String(body.name || '').trim().slice(0, 80)
      if (!name) return json({ error: 'name required' }, 400)
      const phone = String(body.phone || '').trim().slice(0, 40)
      const contactEmail = String(body.contactEmail || '').trim().slice(0, 120)
      const company = String(body.company || '').trim().slice(0, 120)
      const whereMet = String(body.whereMet || '').trim().slice(0, 120)
      const context = String(body.context || '').trim().slice(0, 400)
      const cadenceDays = Math.max(3, Math.min(365, Math.round(body.cadenceDays || 14)))
      await sql`
        UPDATE hire_network
        SET name = ${name}, phone = ${phone}, email = ${contactEmail}, company = ${company},
            where_met = ${whereMet}, context = ${context}, cadence_days = ${cadenceDays}
        WHERE id = ${id} AND user_id = ${user!.id}
      `
      return json({ ok: true })
    }
    const context = body.context != null ? String(body.context).trim().slice(0, 400) : null
    if (context != null) {
      await sql`UPDATE hire_network SET last_touch = now(), context = ${context} WHERE id = ${id} AND user_id = ${user!.id}`
    } else {
      await sql`UPDATE hire_network SET last_touch = now() WHERE id = ${id} AND user_id = ${user!.id}`
    }
    return json({ ok: true })
  }

  /* ---- Sleep ---- */
  if (path === '/api/sleep' && req.method === 'GET') {
    const { user, error } = await resolveAuthedUser(sql, {
      token: url.searchParams.get('t') || undefined,
      session: url.searchParams.get('s') || undefined,
      email: url.searchParams.get('email') || undefined,
    })
    if (error) return error
    const nights = await sql`
      SELECT id, sleep_date AS "sleepDate", bedtime, wake, quality, note, source, created_at AS "createdAt"
      FROM hire_sleep WHERE user_id = ${user!.id}
      ORDER BY sleep_date DESC LIMIT 21
    `
    const prefs = await loadMiniPrefs(sql, user!.id)
    return json({ nights, sleepBedtime: prefs.sleepBedtime, sleepWake: prefs.sleepWake })
  }

  if (path === '/api/sleep' && req.method === 'POST') {
    const body = (await req.json().catch(() => ({}))) as {
      token?: string; email?: string; sleepDate?: string; bedtime?: string; wake?: string; quality?: number; note?: string
    }
    const bedtime = String(body.bedtime || '').trim()
    const wake = String(body.wake || '').trim()
    if (!bedtime || !wake) return json({ error: 'bedtime and wake required' }, 400)
    const { user, error } = await resolveAuthedUser(sql, { token: body.token, session: body.session, email: body.email })
    if (error) return error
    const sleepDate = String(body.sleepDate || shiftDateStr(localDateStrInTz(new Date(), user!.timezone), -1)).slice(0, 10)
    const quality = Math.max(1, Math.min(5, Math.round(body.quality || 3)))
    const note = String(body.note || '').trim().slice(0, 300) || null
    const id = crypto.randomUUID()
    await sql`
      INSERT INTO hire_sleep (id, user_id, sleep_date, bedtime, wake, quality, note)
      VALUES (${id}, ${user!.id}, ${sleepDate}, ${bedtime}, ${wake}, ${quality}, ${note})
      ON CONFLICT (user_id, sleep_date) DO UPDATE SET
        bedtime = excluded.bedtime, wake = excluded.wake, quality = excluded.quality, note = excluded.note
    `
    if (isClock(bedtime) && isClock(wake)) {
      await saveMiniPrefs(sql, user!.id, { sleepBedtime: bedtime, sleepWake: wake })
    }
    return json({ ok: true })
  }

  if (path.startsWith('/api/sleep/') && req.method === 'POST') {
    const sleepSegment = path.split('/')[3]

    if (sleepSegment === 'ingest') {
      const body = (await req.json().catch(() => ({}))) as {
        token?: string; email?: string; session?: string
        sleepDate?: string; bedtime?: string; wake?: string; hours?: number; source?: string
      }
      const bedtime = String(body.bedtime || '').trim()
      const wake = String(body.wake || '').trim()
      if (!isClock(bedtime) || !isClock(wake)) return json({ error: 'bedtime and wake required as HH:MM' }, 400)
      const { user, error } = await resolveAuthedUser(sql, { token: body.token, session: body.session, email: body.email })
      if (error) return error
      const sleepDate = String(body.sleepDate || shiftDateStr(localDateStrInTz(new Date(), user!.timezone), -1)).slice(0, 10)
      const source = String(body.source || 'apple_health').slice(0, 40)
      const id = crypto.randomUUID()
      await sql`
        INSERT INTO hire_sleep (id, user_id, sleep_date, bedtime, wake, quality, note, source)
        VALUES (${id}, ${user!.id}, ${sleepDate}, ${bedtime}, ${wake}, 3, NULL, ${source})
        ON CONFLICT (user_id, sleep_date) DO UPDATE SET
          bedtime = excluded.bedtime, wake = excluded.wake, source = excluded.source
      `
      if (isClock(bedtime) && isClock(wake)) {
        await saveMiniPrefs(sql, user!.id, { sleepBedtime: bedtime, sleepWake: wake })
      }
      return json({ ok: true, sleepDate, bedtime, wake })
    }

    const body = (await req.json().catch(() => ({}))) as { token?: string; email?: string; _delete?: boolean }
    if (!body._delete) return json({ error: 'Not found' }, 404)
    const id = path.split('/')[3]
    if (!id) return json({ error: 'id required' }, 400)
    const { user, error } = await resolveAuthedUser(sql, { token: body.token, session: body.session, email: body.email })
    if (error) return error
    await sql`DELETE FROM hire_sleep WHERE id = ${id} AND user_id = ${user!.id}`
    return json({ ok: true })
  }

  /* ---- Pipeline ---- */
  if (path === '/api/pipeline' && req.method === 'GET') {
    const { user, error } = await resolveAuthedUser(sql, {
      token: url.searchParams.get('t') || undefined,
      session: url.searchParams.get('s') || undefined,
      email: url.searchParams.get('email') || undefined,
    })
    if (error) return error
    const items = await sql`
      SELECT id, title, company, stage, notes, value, kind, created_at AS "createdAt", updated_at AS "updatedAt"
      FROM hire_pipeline WHERE user_id = ${user!.id}
      ORDER BY updated_at DESC
    `
    return json({ items })
  }

  if (path === '/api/pipeline' && req.method === 'POST') {
    const body = (await req.json().catch(() => ({}))) as {
      token?: string; email?: string; title?: string; company?: string; stage?: string; notes?: string; value?: number; kind?: string
    }
    const title = String(body.title || '').trim().slice(0, 120)
    if (!title) return json({ error: 'title required' }, 400)
    const { user, error } = await resolveAuthedUser(sql, { token: body.token, session: body.session, email: body.email })
    if (error) return error
    const stage = PIPELINE_STAGES.includes(String(body.stage) as (typeof PIPELINE_STAGES)[number])
      ? String(body.stage)
      : 'lead'
    const company = String(body.company || '').trim().slice(0, 80)
    const notes = String(body.notes || '').trim().slice(0, 400)
    const value = Math.max(0, clampNum(body.value))
    const kind = ['deal', 'job', 'fundraising', 'lead'].includes(String(body.kind || '')) ? String(body.kind) : 'deal'
    const id = crypto.randomUUID()
    await sql`
      INSERT INTO hire_pipeline (id, user_id, title, company, stage, notes, value, kind)
      VALUES (${id}, ${user!.id}, ${title}, ${company}, ${stage}, ${notes}, ${value}, ${kind})
    `
    return json({ ok: true, id })
  }

  if (path === '/api/pipeline/move' && req.method === 'POST') {
    const body = (await req.json().catch(() => ({}))) as {
      token?: string; session?: string; email?: string; id?: string; stage?: string
    }
    const id = String(body.id || '')
    if (!id) return json({ error: 'id required' }, 400)
    const stage = String(body.stage || '')
    if (!PIPELINE_STAGES.includes(stage as (typeof PIPELINE_STAGES)[number])) {
      return json({ error: 'valid stage required' }, 400)
    }
    const { user, error } = await resolveAuthedUser(sql, { token: body.token, session: body.session, email: body.email })
    if (error) return error
    const rows = (await sql`
      UPDATE hire_pipeline SET stage = ${stage}, updated_at = now()
      WHERE id = ${id} AND user_id = ${user!.id}
      RETURNING id
    `) as Array<{ id: string }>
    if (!rows.length) return json({ error: 'Not found' }, 404)
    return json({ ok: true, id: rows[0].id })
  }

  if (path.startsWith('/api/pipeline/') && req.method === 'POST') {
    const body = (await req.json().catch(() => ({}))) as {
      token?: string; email?: string; _delete?: boolean; stage?: string; notes?: string
    }
    const id = path.split('/')[3]
    if (!id) return json({ error: 'id required' }, 400)
    const { user, error } = await resolveAuthedUser(sql, { token: body.token, session: body.session, email: body.email })
    if (error) return error
    if (body._delete) {
      await sql`DELETE FROM hire_pipeline WHERE id = ${id} AND user_id = ${user!.id}`
      return json({ ok: true })
    }
    const stage = PIPELINE_STAGES.includes(String(body.stage) as (typeof PIPELINE_STAGES)[number])
      ? String(body.stage)
      : null
    if (stage) {
      await sql`UPDATE hire_pipeline SET stage = ${stage}, updated_at = now() WHERE id = ${id} AND user_id = ${user!.id}`
    }
    return json({ ok: true })
  }

  /* Draft the monthly investor note: the numbers are pulled, the asks are the
   * only blanks the user fills. Saved as a pending draft, never sent here. */
  if (path === '/api/investor-note/draft' && req.method === 'POST') {
    const body = (await req.json().catch(() => ({}))) as {
      token?: string; session?: string; email?: string; persona?: string
    }
    const { user, error } = await resolveAuthedUser(sql, { token: body.token, session: body.session, email: body.email })
    if (error) return error
    const subject = 'Investor update'
    const note = await investorNoteBody(sql, user!.id)
    const id = crypto.randomUUID()
    await sql`
      INSERT INTO hire_drafts (id, user_id, persona, kind, to_addr, subject, body, status)
      VALUES (${id}, ${user!.id}, ${isPersona(body.persona || '') ? body.persona! : 'cofounder'}, 'investor', '', ${subject}, ${note}, 'pending')
    `
    return json({ ok: true, draft: { id, kind: 'investor', subject, body: note, status: 'pending' } })
  }

  /* ---- Gratitude ---- */
  if (path === '/api/gratitude' && req.method === 'GET') {
    const { user, error } = await resolveAuthedUser(sql, {
      token: url.searchParams.get('t') || undefined,
      session: url.searchParams.get('s') || undefined,
      email: url.searchParams.get('email') || undefined,
    })
    if (error) return error
    const entries = await sql`
      SELECT id, text, created_at AS "createdAt"
      FROM hire_gratitude WHERE user_id = ${user!.id}
      ORDER BY created_at DESC LIMIT 40
    `
    const monday = userMonday(user!)
    const weekWindow = weekWindowUtc(monday, user!.timezone || 'America/Los_Angeles')
    const weekCount = await sql`
      SELECT count(*)::int AS n FROM hire_gratitude
      WHERE user_id = ${user!.id} AND created_at >= ${weekWindow.start.toISOString()} AND created_at < ${weekWindow.end.toISOString()}
    `
    return json({ entries, weekCount: Number((weekCount[0] as { n: number })?.n || 0) })
  }

  if (path === '/api/gratitude' && req.method === 'POST') {
    const body = (await req.json().catch(() => ({}))) as { token?: string; email?: string; text?: string }
    const text = String(body.text || '').trim().slice(0, 280)
    if (!text) return json({ error: 'text required' }, 400)
    const { user, error } = await resolveAuthedUser(sql, { token: body.token, session: body.session, email: body.email })
    if (error) return error
    const id = crypto.randomUUID()
    await sql`INSERT INTO hire_gratitude (id, user_id, text) VALUES (${id}, ${user!.id}, ${text})`
    return json({ ok: true, id })
  }

  if (path.startsWith('/api/gratitude/') && req.method === 'POST') {
    const body = (await req.json().catch(() => ({}))) as { token?: string; email?: string; _delete?: boolean }
    if (!body._delete) return json({ error: 'Not found' }, 404)
    const id = path.split('/')[3]
    if (!id) return json({ error: 'id required' }, 400)
    const { user, error } = await resolveAuthedUser(sql, { token: body.token, session: body.session, email: body.email })
    if (error) return error
    await sql`DELETE FROM hire_gratitude WHERE id = ${id} AND user_id = ${user!.id}`
    return json({ ok: true })
  }

  /* ---- Spending ---- */
  if (path === '/api/spending' && req.method === 'GET') {
    const { user, error } = await resolveAuthedUser(sql, {
      token: url.searchParams.get('t') || undefined,
      session: url.searchParams.get('s') || undefined,
      email: url.searchParams.get('email') || undefined,
    })
    if (error) return error
    const weekStart = userMonday(user!)
    const weekEndStr = shiftDateStr(weekStart, 7)
    const weekWindow = weekWindowUtc(weekStart, user!.timezone || 'America/Los_Angeles')
    const logs = await sql`
      SELECT id, amount, category, description, spent_at AS "spentAt"
      FROM hire_spending WHERE user_id = ${user!.id}
      ORDER BY spent_at DESC LIMIT 40
    `
    const week = await sql`
      SELECT category, coalesce(sum(amount), 0)::real AS total
      FROM hire_spending
      WHERE user_id = ${user!.id} AND spent_at >= ${weekWindow.start.toISOString()} AND spent_at < ${weekWindow.end.toISOString()}
      GROUP BY category
    `
    const budgetRow = await sql`SELECT weekly_budget AS "weeklyBudget" FROM hire_spending_budget WHERE user_id = ${user!.id}`
    const weeklyBudget = Number((budgetRow[0] as { weeklyBudget?: number })?.weeklyBudget || 400)
    const weekTotal = (week as Array<{ total: number }>).reduce((s, r) => s + Number(r.total), 0)
    return json({ logs, byCategory: week, weekTotal, weeklyBudget, weekStart })
  }

  if (path === '/api/spending' && req.method === 'POST') {
    const body = (await req.json().catch(() => ({}))) as {
      token?: string; email?: string; amount?: number; category?: string; description?: string
    }
    const amount = Number(body.amount)
    if (!Number.isFinite(amount) || amount <= 0) return json({ error: 'amount required' }, 400)
    const { user, error } = await resolveAuthedUser(sql, { token: body.token, session: body.session, email: body.email })
    if (error) return error
    const category = SPEND_CATEGORIES.includes(String(body.category) as (typeof SPEND_CATEGORIES)[number])
      ? String(body.category)
      : 'other'
    const description = String(body.description || '').trim().slice(0, 160)
    const id = crypto.randomUUID()
    await sql`
      INSERT INTO hire_spending (id, user_id, amount, category, description)
      VALUES (${id}, ${user!.id}, ${amount}, ${category}, ${description})
    `
    return json({ ok: true, id })
  }

  if (path === '/api/spending/budget' && req.method === 'PUT') {
    const body = (await req.json().catch(() => ({}))) as { token?: string; email?: string; weeklyBudget?: number }
    const { user, error } = await resolveAuthedUser(sql, { token: body.token, session: body.session, email: body.email })
    if (error) return error
    const weeklyBudget = Math.max(10, Number(body.weeklyBudget) || 400)
    await sql`
      INSERT INTO hire_spending_budget (user_id, weekly_budget) VALUES (${user!.id}, ${weeklyBudget})
      ON CONFLICT (user_id) DO UPDATE SET weekly_budget = excluded.weekly_budget, updated_at = now()
    `
    return json({ ok: true })
  }

  if (path.startsWith('/api/spending/') && req.method === 'POST') {
    const body = (await req.json().catch(() => ({}))) as { token?: string; email?: string; _delete?: boolean }
    if (!body._delete) return json({ error: 'Not found' }, 404)
    const id = path.split('/')[3]
    if (!id) return json({ error: 'id required' }, 400)
    const { user, error } = await resolveAuthedUser(sql, { token: body.token, session: body.session, email: body.email })
    if (error) return error
    await sql`DELETE FROM hire_spending WHERE id = ${id} AND user_id = ${user!.id}`
    return json({ ok: true })
  }

  if (path === '/api/mini-prefs' && req.method === 'GET') {
    const { user, error } = await resolveAuthedUser(sql, {
      token: url.searchParams.get('t') || undefined,
      session: url.searchParams.get('s') || undefined,
      email: url.searchParams.get('email') || undefined,
    })
    if (error) return error
    const prefs = await loadMiniPrefs(sql, user!.id)
    return json(prefs)
  }

  if (path === '/api/mini-prefs' && req.method === 'PUT') {
    const body = (await req.json().catch(() => ({}))) as {
      token?: string; email?: string
      workoutPlace?: string; workoutMoveCount?: number; workoutDays?: number[]
      sleepBedtime?: string; sleepWake?: string
    }
    const { user, error } = await resolveAuthedUser(sql, { token: body.token, session: body.session, email: body.email })
    if (error) return error
    const prefs = await saveMiniPrefs(sql, user!.id, {
      workoutPlace: body.workoutPlace === 'home' || body.workoutPlace === 'gym' ? body.workoutPlace : undefined,
      workoutMoveCount: body.workoutMoveCount === 4 || body.workoutMoveCount === 5 || body.workoutMoveCount === 6
        ? body.workoutMoveCount
        : undefined,
      workoutDays: Array.isArray(body.workoutDays) ? body.workoutDays : undefined,
      sleepBedtime: body.sleepBedtime,
      sleepWake: body.sleepWake,
    })
    return json({ ok: true, ...prefs })
  }

  if (path.startsWith('/api/')) return json({ error: 'Not found' }, 404)
  return null
}

const PIPELINE_STAGES = ['lead', 'active', 'interview', 'offer', 'won', 'lost'] as const
const SPEND_CATEGORIES = ['food', 'transport', 'subscriptions', 'housing', 'fun', 'other'] as const

function toHHMM(raw: string, mer: string | undefined): string | null {
  const [hPart, mPart] = raw.split(':')
  let h = Number(hPart)
  const m = Number(mPart || '0')
  if (!Number.isFinite(h) || !Number.isFinite(m) || h < 0 || h > 23 || m < 0 || m > 59) return null
  const merL = (mer || '').toLowerCase()
  if (merL === 'pm' && h < 12) h += 12
  if (merL === 'am' && h === 12) h = 0
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`
}

/** "log a decision: drop the agency" / "we decided X, because Y" / "decision: X, owner Ravi" —
 * the decision is what we decided, the rest of the sentence is the reason. An
 * optional "review <when>" becomes the review date. */
function parseDecisionText(text: string): { decision: string; reason?: string; owner?: string; review?: string } | null {
  const t = String(text || '')
    .replace(/[’']/g, "'")
    .trim()
    .replace(/^(?:log|record|keep|make)\s+(?:this|that|a|the)?\s*decision\s*[:.,-]?\s*/i, '')
    .replace(/^we\s+(?:decided|made the call|went with)\s*[:.,-]?\s*/i, '')
  if (!t) return null
  let decision = t
  let reason: string | undefined
  let owner: string | undefined
  let review: string | undefined

  // owner: "owner Ravi" / "Ravi owns it" / "Ravi to do it"
  const own = t.match(/\b(?:owner|owned by)\s+([\w]+)/i) || t.match(/\b([\w]+)\s+(?:owns|to do|will own)\b/i)
  if (own) owner = own[1]!

  // review: "review tomorrow" / "review in a week"
  const rev = t.match(/\breview\s+(.+)$/i)
  if (rev) review = rev[1]!.trim()

  // reason after a comma, colon, or "because"
  const m = decision.match(/^(.*?)(?:\s*[.,;：]\s+|\s+because\s+|\s+since\s+)(.*)$/i)
  if (m && m[2]!.trim()) {
    decision = m[1]!.trim()
    reason = m[2]!.trim()
  }

  decision = decision.replace(/\b(?:owner\s+[\w]+|[\w]+\s+owns\s+it|[\w]+\s+will own)\b/gi, '').trim()
  if (!decision) return null
  return { decision, reason, owner, review }
}

/** "move Ravi to interview" / "Raavi → offer" / "add Stripe as a lead" —
 * title + target stage + optional note after a comma/colon. */
function parsePipelineText(text: string): { title: string; stage: string; notes?: string; existing?: boolean } | null {
  const t = String(text || '')
    .replace(/[’']/g, "'")
    .trim()
  const STAGE_RAW: Array<[RegExp, string]> = [
    [/lead/, 'lead'], [/active/, 'active'], [/interview/, 'interview'], [/offer/, 'offer'], [/won/, 'won'], [/lost/, 'lost'],
  ]
  const stage = STAGE_RAW.find(([re]) => re.test(t))?.[1]
  if (!stage) return null

  const move = t.match(/\b(?:move|push|advance|add|put)\s+(.+?)\s+(?:to|into|as|at)\s+(?:the\s+)?(?:stage\s+)?(?:lead|active|interview|offer|won|lost)\b/i)
  let title = move?.[1]?.trim().replace(/["“”]/g, '').replace(/\s*[->]+\s*.*$/, '')
  if (!title) {
    const arrow = t.match(/^(.+?)\s*[->→]\s*(?:lead|active|interview|offer|won|lost)\b/i)
    title = arrow?.[1]?.trim()
  }
  if (!title) return null
  const notes = t.match(/,\s*(.+)$/i)?.[1]?.trim() || undefined
  const existing = /\b(?:move|push|advance|far|onto)\b/i.test(t)
  return { title, stage, notes, existing }
}

function parseWorkoutText(text: string): { exercise: string; sets: number; reps: number; weight: number } | null {
  const t = text.replace(/[’']/g, "'").trim()
  const patterns: Array<RegExp> = [
    /(?:log|track|logged)?\s*(?:my\s+)?(?:workout|lift|gym)?\s*(.+?)\s+(\d+)\s*[x×]\s*(\d+)(?:\s*[x×@]\s*|\s+@\s*|\s+at\s+|\s+)(\d+(?:\.\d+)?)(?:\s*(?:lbs?|pounds?))?\s*$/i,
    /(\d+)\s*[x×]\s*(\d+)\s+(?:on\s+|of\s+)?(.+?)\s+(?:@|at)\s+(\d+(?:\.\d+)?)/i,
    /(.+?)\s+(\d+)\s*sets?\s*(?:of\s*)?(\d+)\s*(?:reps?)?\s*(?:@|at|x)\s*(\d+(?:\.\d+)?)/i,
  ]
  for (const re of patterns) {
    const m = t.match(re)
    if (!m) continue
    let exercise: string
    let sets: number
    let reps: number
    let weight: number
    if (re === patterns[1]) {
      sets = Number(m[1])
      reps = Number(m[2])
      exercise = String(m[3] || '')
      weight = Number(m[4])
    } else {
      exercise = String(m[1] || '')
      sets = Number(m[2])
      reps = Number(m[3])
      weight = Number(m[4])
    }
    exercise = exercise
      .replace(/^(log|track|logged)\s+(my\s+)?(workout|lift|gym)?\s*/i, '')
      .replace(/\b(workout|lift|gym)\b/gi, '')
      .trim()
    if (exercise.length < 2 || !sets || !reps) continue
    return {
      exercise: exercise.slice(0, 80),
      sets: Math.max(1, Math.min(20, Math.round(sets))),
      reps: Math.max(1, Math.min(100, Math.round(reps))),
      weight: Math.max(0, weight || 0),
    }
  }
  return null
}

function parseSleepText(text: string): { bedtime: string; wake: string } | null {
  const m = text.match(
    /(\d{1,2}(?::\d{2})?)\s*(am|pm)?\s*(?:-|–|—|to|until)\s*(\d{1,2}(?::\d{2})?)\s*(am|pm)?/i,
  )
  if (!m) return null
  let bedtime = toHHMM(m[1]!, m[2])
  let wake = toHHMM(m[3]!, m[4])
  if (!bedtime || !wake) return null
  if (!m[2] && !m[4]) {
    const bh = Number(m[1]!.split(':')[0])
    const wh = Number(m[3]!.split(':')[0])
    if (bh <= 12 && bh >= 8) bedtime = toHHMM(m[1]!, 'pm') || bedtime
    if (wh <= 11) wake = toHHMM(m[3]!, 'am') || wake
  }
  return { bedtime, wake }
}

function parseGratitudeText(text: string): string | null {
  const m = text.match(/(?:i(?:'m| am)\s+)?grateful(?:\s+for)?\s*[:\-]?\s*(.+)$/i)
  const sentence = String(m?.[1] || '').trim().replace(/[.!?]+$/, '')
  if (sentence.length < 2) return null
  return sentence.slice(0, 280)
}

const MOOD_EMOJI_MAP: Array<[RegExp, string, number]> = [
  [/😄|:\)+$|:D|great|awesome|amazing|good!/, '😄', 5],
  [/🙂|:\)|good|fine|okay|ok$|alright/, '🙂', 4],
  [/😐|meh|neutral|blah/, '😐', 3],
  [/😔|:\(|sad|down|tired|exhausted|rough|bad|shitty|meh\s.*day/, '😔', 2],
  [/😤|angry|frustrated|annoyed|pissed|stressed/, '😤', 2],
]

/** Deterministic mood parse for emoji or short-text check-in replies. */
function parseMoodReply(text: string): { emoji: string; energy: number; note: string | null } | null {
  const clean = String(text || '').trim()
  if (!clean) return null
  for (const [re, emoji, energy] of MOOD_EMOJI_MAP) {
    if (re.test(clean)) return { emoji, energy, note: clean.length > 4 ? clean.slice(0, 200) : null }
  }
  return null
}

function parseSpendText(text: string): { amount: number; category: string; description: string } | null {
  const m = text.match(/\$\s*(\d+(?:\.\d{1,2})?)|(?:spent|spend|paid|cost)\s+\$?\s*(\d+(?:\.\d{1,2})?)|(\d+(?:\.\d{1,2})?)\s*(?:bucks|dollars)/i)
  const amount = Number(m?.[1] || m?.[2] || m?.[3])
  if (!Number.isFinite(amount) || amount <= 0) return null
  const lower = text.toLowerCase()
  let category = 'other'
  if (/\b(food|lunch|dinner|breakfast|coffee|uber\s*eats|doordash|restaurant|snack|grocer)/.test(lower)) category = 'food'
  else if (/\b(uber|lyft|gas|transit|train|bus|parking|taxi)/.test(lower)) category = 'transport'
  else if (/\b(netflix|spotify|subscription|prime|icloud)/.test(lower)) category = 'subscriptions'
  else if (/\b(rent|mortgage|housing|utilities)/.test(lower)) category = 'housing'
  else if (/\b(fun|movie|game|bar|drinks|concert)/.test(lower)) category = 'fun'
  const description = text.replace(/^(log|track|logged)\s+(my\s+)?(spend|spending|expense)?\s*/i, '').trim().slice(0, 160)
  return { amount, category, description }
}

function sleepHoursBetween(bedtime: string, wake: string): number {
  const [bh, bm] = bedtime.split(':').map(Number)
  const [wh, wm] = wake.split(':').map(Number)
  if ([bh, bm, wh, wm].some((n) => Number.isNaN(n))) return 0
  let mins = (wh * 60 + wm) - (bh * 60 + bm)
  if (mins <= 0) mins += 24 * 60
  return mins / 60
}

/** Upgrade promo subscriptions ($5/mo) to regular price ($19/mo) after 60 days.
 *  Called daily from the web server. Safe to run multiple times — only touches
 *  subscriptions where promo_started_at is older than 60 days. */
export async function upgradePromoSubscriptions(sql: SQL) {
  const promoPrice = stripePromoPrice()
  const regularPrice = stripePriceFor('friend')
  if (!promoPrice || !regularPrice || !stripeSecret()) return

  const stale = await sql`
    SELECT id, stripe_subscription_id, user_id
    FROM hire_subscriptions
    WHERE promo_started_at IS NOT NULL
      AND promo_started_at < now() - interval '60 days'
      AND status IN ('active', 'trialing')
      AND price_id = ${promoPrice}
  ` as Array<{ id: string; stripe_subscription_id: string; user_id: string }>

  for (const sub of stale) {
    try {
      await stripeRequest(
        `/subscriptions/${sub.stripe_subscription_id}`,
        new URLSearchParams({
          'items[0][id]': sub.stripe_subscription_id,
          'items[0][price]': regularPrice,
          'proration_behavior': 'create_prorations',
        }),
      )
      await sql`
        UPDATE hire_subscriptions
        SET price_id = ${regularPrice}, promo_started_at = NULL, updated_at = now()
        WHERE id = ${sub.id}
      `
      console.log(`[billing] upgraded promo sub ${sub.id} user ${sub.user_id} to ${regularPrice}`)
    } catch (err) {
      console.error(`[billing] promo upgrade failed for ${sub.id}`, err)
    }
  }
  if (stale.length) console.log(`[billing] promo upgrade check: ${stale.length} subscriptions upgraded`)
}
