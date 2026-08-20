/**
 * HireAlpha live config + connectors API (Postgres).
 * Dashboard writes here. iMessage bots read here.
 */
import { Composio } from '@composio/core'
import { createHmac, timingSafeEqual } from 'node:crypto'
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
  isWalkIn,
  parseComposioCalendarData,
  parseFormattedEventLine,
  parseGoogleCalendarItems,
  selectNextEvents,
  serializeCalItems,
  type CalItem,
} from './calendarEvents'
import { COMPOSIO_READ, composioLooksFailed, formatComposioData } from './composioPlugins'
import {
  pickUserTimezone,
  resolveIanaTimezone,
  timezoneFromCoords,
  timezoneFromText,
} from './timezones'
import {
  cleanMailSnippet,
  decodeGmailBody,
  extractGmailBody,
  formatBriefPreview,
  importantMailQuery,
  mailJudgePrompt,
  MAIL_JUDGE_SYSTEM,
  parseMailJudgeKeepIds,
  type GmailMimePart,
  type MailJudgeItem,
} from './gmailHelpers'

export const PERSONAS = ['friend', 'coworker', 'cofounder'] as const
export type Persona = (typeof PERSONAS)[number]

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

function isPersona(v: string): v is Persona {
  return (PERSONAS as readonly string[]).includes(v)
}

function json(data: unknown, status = 200, extra?: HeadersInit) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      ...extra,
    },
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
      sleep_bedtime TEXT NOT NULL DEFAULT '23:00',
      sleep_wake TEXT NOT NULL DEFAULT '07:00',
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `
  await sql`ALTER TABLE hire_mini_prefs ADD COLUMN IF NOT EXISTS workout_move_count INTEGER NOT NULL DEFAULT 4`
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
  sleepBedtime: string
  sleepWake: string
}

function isClock(v: string): boolean {
  return /^\d{2}:\d{2}$/.test(v)
}

function clampWorkoutMoveCount(v: unknown): 4 | 5 | 6 {
  const n = typeof v === 'number' ? v : Number(v)
  return n === 5 || n === 6 ? n : 4
}

async function loadMiniPrefs(sql: SQL, userId: string): Promise<MiniPrefs> {
  const rows = await sql`
    SELECT workout_place AS "workoutPlace", workout_move_count AS "workoutMoveCount",
           sleep_bedtime AS "sleepBedtime", sleep_wake AS "sleepWake"
    FROM hire_mini_prefs WHERE user_id = ${userId} LIMIT 1
  `
  const row = rows[0] as (MiniPrefs & { workoutMoveCount?: unknown }) | undefined
  const place = row?.workoutPlace === 'home' ? 'home' : 'gym'
  return {
    workoutPlace: place,
    workoutMoveCount: clampWorkoutMoveCount(row?.workoutMoveCount),
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
    sleepBedtime: isClock(patch.sleepBedtime || '') ? patch.sleepBedtime! : cur.sleepBedtime,
    sleepWake: isClock(patch.sleepWake || '') ? patch.sleepWake! : cur.sleepWake,
  }
  await sql`
    INSERT INTO hire_mini_prefs (user_id, workout_place, workout_move_count, sleep_bedtime, sleep_wake, updated_at)
    VALUES (${userId}, ${next.workoutPlace}, ${next.workoutMoveCount}, ${next.sleepBedtime}, ${next.sleepWake}, now())
    ON CONFLICT (user_id) DO UPDATE SET
      workout_place = excluded.workout_place,
      workout_move_count = excluded.workout_move_count,
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
function todayWindowUtc(timezone: string): { start: Date; end: Date } {
  const tz = timezone || 'America/Los_Angeles'
  const dtf = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  })
  const [y, mo, d] = dtf.format(new Date()).split('-').map(Number)
  const wallStart = Date.UTC(y!, mo! - 1, d!)
  const offset = tzOffsetMs(wallStart, tz)
  return { start: new Date(wallStart - offset), end: new Date(wallStart - offset + 86_400_000) }
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

function extractJson(text: string): Record<string, unknown> | null {
  const fence = text.match(/\{[\s\S]*\}/)
  if (!fence) return null
  try {
    return JSON.parse(fence[0]) as Record<string, unknown>
  } catch {
    return null
  }
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

  const model = imageBase64 ? cfg.visionModel : cfg.textModel
  const system =
    'You are a nutrition estimator. Estimate the macronutrients of the described meal. ' +
    'Reply with JSON only: {"guess":"<short name>","calories":N,"protein":N,"carbs":N,"fat":N}. ' +
    'protein/carbs/fat are grams, calories is kcal. Use realistic single-serving estimates.'

  const userContent: unknown[] = imageBase64
    ? [
        { type: 'text', text: description.trim() || 'Estimate the macros of the meal in this photo.' },
        { type: 'image_url', image_url: { url: `data:${imageMimeFromBase64(imageBase64)};base64,${imageBase64}` } },
      ]
    : [{ type: 'text', text: description.trim() }]

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
        model,
        reasoning_effort: 'none',
        temperature: 0,
        max_tokens: 320,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: userContent },
        ],
      }),
    })
    if (!res.ok) {
      const t = await res.text().catch(() => '')
      return { ok: false, error: `Estimator error ${res.status}: ${t.slice(0, 160)}` }
    }
    const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> }
    const content = data.choices?.[0]?.message?.content || ''
    const parsed = extractJson(content)
    if (!parsed) return { ok: false, error: 'Could not parse the estimate. Try a clearer description.' }
    return {
      ok: true,
      guess: String(parsed.guess || description.slice(0, 60)),
      calories: clampNum(parsed.calories),
      protein: clampNum(parsed.protein),
      carbs: clampNum(parsed.carbs),
      fat: clampNum(parsed.fat),
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return { ok: false, error: msg.slice(0, 180) }
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
  const cap = Math.max(1, Math.min(20, maxResults))
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
  const items = Array.isArray(data)
    ? data
    : Array.isArray((data as { messages?: unknown[] } | null)?.messages)
      ? (data as { messages: unknown[] }).messages
      : []
  if (!items.length) return 'No emails matched the query.'
  const lines = items.map((raw) => {
    const m = (raw || {}) as Record<string, unknown>
    const subject = String(m.subject ?? m.subject_header ?? '')
    const from =
      String(m.from ?? m.sender ?? m.from_email ?? m.sender_email ?? '').replace(/<[^>]+>/g, '').trim()
    const date = String(m.date ?? m.internalDate ?? m.receivedAt ?? m.timestamp ?? '')
    const snippet = String(m.snippet ?? m.body_preview ?? '')
    return `- ${from || '?'} | ${date || '?'} | ${subject || '(no subject)'} | ${snippet}`
  })
  return `Important email:\n${lines.join('\n')}`
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
  return /\b(search (?:the )?(?:web|internet|online)|web search|look online|look up|browse|for accuracy|latest news|news about|how (?:much|many|do|to|old|far)|what (?:is|are|was|were|does)|when (?:is|does|did|was)|where (?:is|are|was|did)|who (?:is|was|are)|why (?:is|does|did)|define|meaning of|price of|recipe for|nutrition(?:al)? (?:info|facts|value|content)|calories? in|protein in)\b/i.test(text)
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

async function runComposioPlugin(userId: string, id: string, message: string): Promise<string> {
  const spec = COMPOSIO_READ[id]
  if (!spec) return `${id} is not wired. Do not invent a result.`
  const out = await composioFirst(userId, spec.slugs, spec.args(message))
  if (!out || composioLooksFailed(out)) return spec.empty
  return out
}

/** Structured Gmail fetch: returns message id + headers, no text formatting. */
async function fetchGmailRich(
  access: string,
  query: string,
  maxResults = 8,
): Promise<Array<{ id: string; from: string; date: string; subject: string; snippet: string }>> {
  const cap = Math.max(1, Math.min(20, maxResults))
  const listUrl = new URL('https://gmail.googleapis.com/gmail/v1/users/me/messages')
  listUrl.searchParams.set('maxResults', String(cap))
  listUrl.searchParams.set('q', query)
  const list = await fetch(listUrl, { headers: { Authorization: `Bearer ${access}` } })
  if (!list.ok) return []
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

/** Like loadGmail but returns structured items with Gmail message IDs. Falls back to [] if Google token unavailable. */
async function loadGmailRich(
  sql: SQL,
  userId: string,
  query: string,
  maxResults = 8,
): Promise<Array<{ id: string; from: string; date: string; subject: string; snippet: string }>> {
  try {
    const access = await googleAccessToken(sql, userId, 'gmail')
    if (!access) return []
    return await fetchGmailRich(access, query, maxResults)
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
  try {
    const url = new URL('https://html.duckduckgo.com/html/')
    url.searchParams.set('q', q)
    const res = await fetchPublic(url, {
      headers: { Accept: 'text/html', 'User-Agent': 'HireAlpha/1.0 (https://hirealpha.chat)' },
    })
    if (!res.ok) return `Web search unavailable (${res.status}).`
    const html = await res.text()
    const results: string[] = []
    const pattern = /<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi
    for (const match of html.matchAll(pattern)) {
      let href = decodeHtml(match[1] || '')
      try {
        const parsed = new URL(href.startsWith('//') ? `https:${href}` : href)
        href = parsed.searchParams.get('uddg') || href
      } catch {
        /* keep the original link */
      }
      const title = decodeHtml(stripHtml(match[2] || ''))
      if (title && href) results.push(`- ${title}\n  ${href}`)
      if (results.length >= 5) break
    }
    return results.length ? `Web results for "${q}":\n${results.join('\n')}` : 'No web results found.'
  } catch {
    return 'Web search unavailable right now.'
  }
}

const FOREIGN_PLACE = /\b(bali|jakarta|thailand|indonesia|london|paris|tokyo|kyoto|athens|rome|madrid|berlin|amsterdam|sydney|melbourne|mumbai|delhi|bangkok|marrakech|dubai|singapore|hong\s?kong|europe|asia|africa|mexico city|canada|australia|india|france|italy|spain|germany|brazil|argentina|colombia|philippines|panama|uk|england|scotland|ireland)\b/i

function timezoneCountry(tz?: string) {
  if (!tz) return ''
  if (/^America\//.test(tz)) return 'us'
  if (tz === 'Europe/London' || tz === 'UTC') return 'gb'
  return ''
}

async function fetchMapSearch(query: string, countryHint = '', location: LocationRow | null = null) {
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

function notConnectedNote(tool: string) {
  return `${tool} is not connected. Tell them to open hirealpha.chat/app, open this hire, and tap Connect. Do not pretend you already did the action.`
}

export async function runToolsForMessage(
  sql: SQL,
  input: {
    userId: string
    persona: Persona
    message: string
    connected: string[]
    want?: 'maps' | 'web'
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
    results.push(notConnectedNote(id))
  }
  const askedAllowed = (id: string, hit: boolean) => {
    if (!hit) return
    if (denied.has(id)) return
    asked(id, hit)
  }

  const mailHit = wantsEmail(input.message)
  const calHit = wantsCalendar(input.message)
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
  if (wantsDrive(input.message) && can('drive')) {
    results.push(await loadDrive(sql, input.userId, input.message.slice(0, 40)))
  } else {
    askedAllowed('drive', wantsDrive(input.message))
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
  const calendarConnected = connected.includes('calendar')
  if (!calendarConnected) return { meets: [], stay: null, calendarConnected: false }

  const myName = user.name || null

  function itemsToResult(items: CalItem[]): TodayResult {
    let stay: { title: string; place: string } | null = null
    const meets: TodayMeet[] = []
    for (const e of items) {
      if (e.allDay) {
        if (isHotelStayEvent(e) && !stay) {
          const calParsed = parseCalMeet(e.title)
          stay = { title: e.title, place: calParsed.place }
        }
        continue
      }
      const who = extractOtherPerson(e.title, myName)
      const calParsed = parseCalMeet(e.title)
      meets.push({
        time: formatClock(e.start, tz),
        title: e.title,
        who: who || calParsed.who || e.title,
        place: calParsed.place,
        kind: e.kind,
      })
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
  const meets: TodayMeet[] = calMeets.map(({ time, title, who, place }) => ({
    time,
    title,
    who: extractOtherPerson(title, myName) || who || title,
    place,
    kind: 'Meeting',
  }))
  return { meets, stay: null, calendarConnected: true }
}

/**
 * Morning/evening-brief payload: calendar (direct Google, no error strings),
 * important + medium mail, reminders. `brief` tells the frontend which variant.
 * Calendar uses fetchCalendarItems directly so "Calendar is not connected" error
 * strings never leak into the event list.
 */
async function gmiBriefChat(system: string, user: string, maxTokens = 180): Promise<string | null> {
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
            reasoning_effort: 'none',
            temperature: 0.1,
            max_tokens: maxTokens,
            messages: [
              { role: 'system', content: system },
              { role: 'user', content: user },
            ],
          }),
        })
        if (!res.ok) return ''
        const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> }
        return (data.choices?.[0]?.message?.content || '').trim()
      })(),
      5000,
      '',
    )
    return raw || null
  } catch {
    return null
  }
}

/** Model judges a recent inbox batch. Empty on failure so we never dump promo. */
async function judgeBriefMail<T extends { id: string; from: string; subject: string; snippet?: string }>(
  items: T[],
  limit = 5,
): Promise<T[]> {
  if (!items.length) return []
  const batch: MailJudgeItem[] = items.slice(0, 12).map((m) => ({
    id: m.id,
    from: m.from,
    subject: m.subject,
    snippet: m.snippet || '',
  }))
  const raw = await gmiBriefChat(MAIL_JUDGE_SYSTEM, mailJudgePrompt(batch))
  if (!raw) return []
  const keep = new Set(parseMailJudgeKeepIds(raw, batch))
  return items.filter((m) => keep.has(m.id)).slice(0, limit)
}

async function digestPayload(
  sql: SQL,
  user: { id: string; timezone: string | null; name?: string | null },
  persona: Persona,
) {
  const tz = user.timezone || 'America/Los_Angeles'
  const connected = (await connectedForUser(sql, user.id)).filter(
    (id) => !PERSONA_DENIED[persona].has(id),
  )

  const todayStart = startOfLocalDay(tz)
  const tomorrowStart = startOfLocalDay(tz, 1)
  const dayAfterStart = startOfLocalDay(tz, 2)
  const todayYmd = todayStart.toLocaleDateString('en-CA', { timeZone: tz })
  const tomorrowYmd = tomorrowStart.toLocaleDateString('en-CA', { timeZone: tz })

  // Fetch calendar directly — never via runToolsForMessage which can return
  // "Calendar is not connected" error strings that pollute the event list.
  const todayCalItems: CalItem[] = []
  const tomorrowCalItems: CalItem[] = []

  if (connected.includes('calendar')) {
    const access = await googleAccessToken(sql, user.id, 'calendar')
    if (access) {
      const got = await fetchCalendarItems(access, {
        timeMin: todayStart,
        timeMax: dayAfterStart,
        maxResults: 20,
      })
      if (got.ok) {
        for (const e of got.items) {
          const ymd = e.start.toLocaleDateString('en-CA', { timeZone: tz })
          if (ymd === todayYmd) todayCalItems.push(e)
          else if (ymd === tomorrowYmd) tomorrowCalItems.push(e)
        }
      }
    }
  }

  const myName = user.name || null
  const todayCal = todayCalItems
    .filter((e) => eventStartsByEightPm(e, tz))
    .map((e) => formatDigestEventLabel(e, tz, myName))
  const tomorrowCal = tomorrowCalItems
    .filter((e) => !isHotelStayEvent(e))
    .map((e) => formatDigestEventLabel(e, tz, myName))

  // Pass empty events[] so the frontend never shows Yes/No RSVP buttons.
  // The brief is a read-only view; calendar is already in todayCal.
  const events: Array<{ id: string; label: string }> = []

  // Email: modest recent inbox, then a model judges what is actually useful.
  let finalEmailItems: Array<{ id: string; label: string; snippet?: string }> = []
  let finalEmails: string[] = []

  if (connected.includes('gmail')) {
    try {
      const richItems = await withTimeout(
        loadGmailRich(
          sql,
          user.id,
          importantMailQuery('16h'),
          12,
        ),
        6000,
        [] as Array<{ id: string; from: string; date: string; subject: string; snippet: string }>,
      )
      const kept = await judgeBriefMail(richItems, 5)
      if (kept.length) {
        finalEmailItems = kept.map((m) => ({
          id: m.id,
          label: formatMailLineFromParts(m.from, m.subject),
          snippet: cleanMailSnippet(m.snippet),
        }))
        finalEmails = finalEmailItems.map((e) => e.label)
      }
    } catch {
      // best-effort
    }
  }
  if (!finalEmails.length && connected.includes('gmail')) {
    try {
      const mailBlock = await withTimeout(
        loadGmail(
          sql,
          user.id,
          importantMailQuery('16h'),
          12,
        ),
        6000,
        '',
      )
      const rows = digestLines(mailBlock).map((line, i) => {
        const [from, , subject] = line.replace(/^-\s*/, '').split(' | ')
        return {
          id: `text-${i}`,
          from: from || '',
          subject: subject || formatMailLine(line),
          snippet: '',
        }
      })
      const kept = await judgeBriefMail(rows, 5)
      finalEmails = kept.map((m) => formatMailLineFromParts(m.from, m.subject))
    } catch {
      // best-effort
    }
  }

  const reminderRows = await sql`
    SELECT text, scheduled_at AS "scheduledAt" FROM hire_reminders
    WHERE user_id = ${user.id} AND persona = ${persona} AND status = 'pending'
    ORDER BY scheduled_at ASC LIMIT 8
  `
  const reminders = (reminderRows as { text: string; scheduledAt: Date }[])
    .filter((r) => !/^\[(judge|poke)\]/i.test(r.text))
    .map((r) => ({
      time: formatCalTime(new Date(r.scheduledAt).toISOString(), tz),
      text: r.text.replace(/^\[digest\]/i, '').trim() || r.text,
    }))

  const loopRows = await sql`
    SELECT title, due_at AS "dueAt" FROM hire_loops
    WHERE user_id = ${user.id} AND status = 'open'
    ORDER BY created_at DESC LIMIT 8
  `
  const loops = (loopRows as { title: string; dueAt: Date | null }[]).map((r) => {
    const due = r.dueAt ? formatCalTime(new Date(r.dueAt).toISOString(), tz) : ''
    return due ? `${r.title} · ${due}` : r.title
  })

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

  const section = (title: string, items: string[]) =>
    items.length ? `${title}\n${items.join('\n')}` : null

  const mailSection = finalEmails.length ? section('Important mail', finalEmails) : 'Important mail\nNo important mail'

  const text = [
    `${PERSONA_LABEL[persona]} · ${wrapTitle} · ${dateLabel}`,
    section('Today', todayCal) || 'Today\nNothing on the calendar.',
    section('Tomorrow', tomorrowCal),
    mailSection,
    section('Reminders', reminders.map((r) => `${r.time} · ${r.text}`)),
    section('Promises', loops),
  ]
    .filter(Boolean)
    .join('\n\n')

  const preview = formatBriefPreview({ calendar: todayCal, emails: finalEmails, tomorrow: tomorrowCal })

  // calendar = today events only (tomorrow is separate)
  return { date: dateLabel, calendar: todayCal, emails: finalEmails, emailItems: finalEmailItems, reminders, loops, tomorrow: tomorrowCal, events, text, preview, brief }
}

/** Mini apps each hire can offer, mirroring src/agents/skills.ts. */
const PERSONA_MINI_APPS: Record<Persona, string[]> = {
  friend: [
    'digest', 'next_move', 'check_in', 'pick_night', 'open_loops', 'drop_zone',
    'nutrition', 'habit_streak', 'mood_tracker', 'workout_log', 'learning_queue', 'weekly_review',
    'networking_crm', 'sleep_tracker', 'spending_snapshot', 'mirror', 'gratitude_journal', 'spiral_options', 'relationship_radar',
  ],
  coworker: [
    'digest', 'next_move', 'approve_send', 'pick_slot', 'standup_paste', 'linear_triage', 'open_loops',
    'meeting_mode', 'drop_zone', 'learning_queue', 'weekly_review', 'networking_crm',
  ],
  cofounder: [
    'digest', 'next_move', 'kill_keep_park', 'hire_decision', 'weekly_review', 'approve_investor_note',
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
  user: { id: string; timezone: string | null },
  persona: Persona,
  context: Record<string, string>,
) {
  const tz = context.timezone || user.timezone || 'America/Los_Angeles'
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

async function judgmentStatePayload(
  sql: SQL,
  user: { id: string; timezone: string | null; name?: string | null },
  persona: Persona,
  tick: string,
) {
  const tz = user.timezone || 'America/Los_Angeles'
  const context = await loadContext(sql, user.id, persona)
  const today = localDateStrInTz(new Date(), tz)
  const weekStart = userMonday(user)
  const weekEnd = shiftDateStr(weekStart, 7)
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
    WHERE user_id = ${user.id} AND eaten_at >= ${today}::date AND eaten_at < ${shiftDateStr(today, 1)}::date
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
    (r) => String(r.sleepDate || '').slice(0, 10) === lastNight && r.bedtime && r.wake,
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
    WHERE user_id = ${user.id} AND logged_at >= ${today}::date AND logged_at < ${shiftDateStr(today, 1)}::date
  `
  const workoutsToday = Number((workoutTodayRows[0] as { n?: number })?.n || 0)


  const duePeople = await sql`
    SELECT name, context, phone, last_touch AS "lastTouch", cadence_days AS "cadenceDays"
    FROM hire_network WHERE user_id = ${user.id}
    ORDER BY coalesce(last_touch, '1970-01-01'::timestamptz) ASC LIMIT 8
  `
  const peopleDue = (duePeople as Array<{ name: string; context: string; phone: string; lastTouch: Date | null; cadenceDays: number }>)
    .map((p) => {
      const days = p.lastTouch ? Math.floor((Date.now() - new Date(p.lastTouch).getTime()) / 86400000) : 999
      const bits = [p.phone, p.context].filter(Boolean)
      return { name: p.name, days, note: bits.join('. ') || undefined, due: days >= (p.cadenceDays || 14) }
    })
    .filter((p) => p.due)
    .slice(0, 3)
    .map(({ name, days, note }) => ({ name, days, note }))

  const radar = await sql`
    SELECT name, last_touch_at AS "lastTouch", cadence_days AS "cadenceDays"
    FROM hire_relationships WHERE user_id = ${user.id} LIMIT 8
  `
  for (const p of radar as Array<{ name: string; lastTouch: Date | null; cadenceDays: number }>) {
    const days = p.lastTouch ? Math.floor((Date.now() - new Date(p.lastTouch).getTime()) / 86400000) : 999
    if (days >= (p.cadenceDays || 14) && !peopleDue.some((x) => x.name === p.name)) {
      peopleDue.push({ name: p.name, days })
    }
  }

  const spendRow = await sql`
    SELECT coalesce(sum(amount), 0)::real AS total FROM hire_spending
    WHERE user_id = ${user.id} AND spent_at >= ${weekStart}::date AND spent_at < ${weekEnd}::date
  `
  const budgetRow = await sql`SELECT weekly_budget AS "weeklyBudget" FROM hire_spending_budget WHERE user_id = ${user.id}`
  const loops = await sql`
    SELECT title FROM hire_loops WHERE user_id = ${user.id} AND status = 'open' ORDER BY created_at DESC LIMIT 5
  `

  let calendar: string[] = []
  let mail: string[] = []
  if (tick === 'digest' || tick === 'morning' || tick === 'evening' || tick === 'night' || tick === 'digest_evening') {
    try {
      const payload = await digestPayload(sql, user, persona)
      calendar = (payload.calendar || []).slice(0, 4)
      mail = (payload.emails || []).slice(0, 3)
    } catch (err) {
      console.warn('[judgment] digest slice failed', err)
    }
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
      FROM hire_nutrition_logs WHERE user_id = ${user.id} AND eaten_at >= ${weekStart}::date AND eaten_at < ${weekEnd}::date
    `
    const wkMoods = await sql`
      SELECT count(*)::int AS logs, coalesce(avg(energy), 0)::real AS energy
      FROM hire_moods WHERE user_id = ${user.id} AND created_at >= ${weekStart}::date AND created_at < ${weekEnd}::date
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
      WHERE user_id = ${user.id} AND logged_at >= ${weekStart}::date AND logged_at < ${weekEnd}::date
    `
    const wkLearning = await sql`
      SELECT count(*)::int AS n FROM hire_learning
      WHERE user_id = ${user.id} AND status = 'done' AND created_at >= ${weekStart}::date AND created_at < ${weekEnd}::date
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
      WHERE user_id = ${user.id} AND created_at >= ${weekStart}::date AND created_at < ${weekEnd}::date
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
    peopleDue: peopleDue.slice(0, 3),
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
  const context = await loadContext(sql, user.id, persona)
  const connected = (await connectedForUser(sql, user.id)).filter((id) => !PERSONA_DENIED[persona].has(id))
  const dateLabel = new Date().toLocaleDateString('en-US', {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    timeZone: tz,
  })

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

    if (connected.includes('calendar')) {
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
    }

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

    // Mail since morning: recent inbox minus Promotions, then a model judges.
    let mailItems: Array<{ id: string; label: string; snippet?: string }> = []
    if (connected.includes('gmail')) {
      try {
        const richMail = await withTimeout(
          loadGmailRich(sql, user.id, importantMailQuery('12h'), 12),
          5000,
          [] as Array<{ id: string; from: string; date: string; subject: string; snippet: string }>,
        )
        const kept = await judgeBriefMail(richMail, 5)
        mailItems = kept.map((m) => ({
          id: m.id,
          label: formatMailLineFromParts(m.from, m.subject),
          snippet: cleanMailSnippet(m.snippet),
        }))
      } catch {
        // best-effort
      }
    }

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

    return { kind, title: 'Evening brief', date: dateLabel, sections, text: '' }
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

function rfc822Raw(to: string, subject: string, body: string) {
  const raw = [`To: ${to}`, `Subject: ${subject}`, 'MIME-Version: 1.0', 'Content-Type: text/plain; charset=utf-8', '', body].join('\r\n')
  return Buffer.from(raw).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

async function gmailSendMessage(
  sql: SQL,
  userId: string,
  draft: { to: string; subject: string; body: string },
): Promise<{ ok: boolean; error?: string }> {
  const access = await googleAccessToken(sql, userId, 'gmail')
  if (access) {
    const res = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
      method: 'POST',
      headers: { Authorization: `Bearer ${access}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ raw: rfc822Raw(draft.to, draft.subject, draft.body) }),
    })
    if (res.ok) return { ok: true }
    const err = await res.text().catch(() => '')
    if (res.status !== 403 && res.status !== 401) {
      return { ok: false, error: `Gmail send failed (${res.status}). ${err.slice(0, 120)}` }
    }
  }
  const out = await composioFirst(
    userId,
    ['GMAIL_SEND_EMAIL', 'GMAIL_SEND_MESSAGE', 'GMAIL_CREATE_EMAIL_DRAFT'],
    {
      to: draft.to,
      recipient_email: draft.to,
      subject: draft.subject,
      body: draft.body,
      message: draft.body,
    },
  )
  if (out && !/failed/i.test(out)) return { ok: true }
  return {
    ok: false,
    error: 'Could not send. Reconnect Gmail and allow send, or Connect Gmail in Settings.',
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
  const live = pipes.filter((p) => p.stage !== 'lost')
  const lines = [
    'Update',
    '',
    live.length ? `Pipeline: ${live.map((p) => `${p.title}${p.company ? ` @ ${p.company}` : ''} (${p.stage})`).join('; ')}` : 'Pipeline: quiet this week.',
    `Spend this week: $${Math.round(weekSpend)}.`,
    decisions[0] ? `Call: ${decisions[0].decision}${decisions[0].reason ? ` because ${decisions[0].reason}` : ''}.` : '',
    '',
    'Ask:',
  ]
  return lines.filter(Boolean).join('\n')
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
    drafts = (await sql`
      SELECT id, to_addr AS "toAddr", subject FROM hire_drafts
      WHERE user_id = ${user.id} AND status = 'pending'
      ORDER BY created_at DESC LIMIT 3
    `) as Array<{ id: string; toAddr: string; subject: string }>
  } catch {
    drafts = []
  }
  for (const d of drafts) {
    items.push({
      id: `draft-${d.id}`,
      kicker: 'Send',
      title: d.subject || 'Draft',
      hint: d.toAddr,
      hot: true,
      action: 'send',
      doLabel: 'Send',
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

  if (persona === 'friend') {
    const hour = Number(new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', hour12: false }).format(new Date()))
    if (hour < 12) {
      const lastNight = await sql`
        SELECT id FROM hire_sleep
        WHERE user_id = ${user.id} AND sleep_date = (current_date - 1)
        LIMIT 1
      `
      if (!lastNight[0]) {
        items.push({
          id: 'sleep-last',
          kicker: 'Morning',
          title: 'Log last night',
          hint: 'Two numbers. Bed and wake.',
          action: 'open',
          doLabel: 'Log',
          openKind: 'sleep_tracker',
        })
      }
    }
  }

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
      const payload = await digestPayload(sql, user, persona)
      return String(payload.preview || '').trim() || null
    }
    if (kind === 'pick_night') {
      const payload = await miniPayload(sql, user, persona, 'pick_night')
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
  if (!path.startsWith('/api/')) return null
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
    return json({ user })
  }

  if (path === '/api/me/roster' && req.method === 'PUT') {
    const body = (await req.json().catch(() => ({}))) as { email?: string; agentIds?: string[] }
    const email = String(body.email || '')
      .trim()
      .toLowerCase()
    const user = await getUserByEmail(sql, email)
    if (!user) return json({ error: 'Sign in first' }, 401)
    const ids = (body.agentIds || []).filter(isPersona)
    await sql`DELETE FROM hire_roster WHERE user_id = ${user.id}`
    for (const persona of ids) {
      await sql`
        INSERT INTO hire_roster (user_id, persona) VALUES (${user.id}, ${persona})
        ON CONFLICT (user_id, persona) DO NOTHING
      `
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
    const results = await runToolsForMessage(sql, {
      userId: live.userId,
      persona: body.persona,
      message,
      connected: live.connected,
      want: body.want === 'maps' || body.want === 'web' ? body.want : undefined,
      timezone: tz,
      location: loc,
    })
    return json({ results })
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
    const access = await googleAccessToken(sql, user!.id, 'gmail')
    if (!access) {
      return json({
        ok: false,
        error: 'Gmail is not connected. Reconnect it in Settings to read full messages.',
      })
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
      const payload = await digestPayload(sql, user, persona)
      return json({ ...payload, cardUrl: `${appBase(req)}/app/mini/${persona}/digest` })
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
    const drafts = (await sql`
      SELECT id, kind, to_addr AS "toAddr", subject, body, status, created_at AS "createdAt"
      FROM hire_drafts WHERE user_id = ${user!.id}
      ${kind ? sql`AND kind = ${kind}` : sql``}
      ORDER BY created_at DESC LIMIT 20
    `) as Array<{ id: string; kind: string; toAddr: string; subject: string; body: string; status: string; createdAt: Date }>
    let rows = drafts
    if (!rows.some((d) => d.status === 'pending')) {
      const suggested = await suggestedMailDrafts(sql, user!.id)
      for (const s of suggested) {
        const id = crypto.randomUUID()
        await sql`
          INSERT INTO hire_drafts (id, user_id, persona, kind, to_addr, subject, body)
          VALUES (${id}, ${user!.id}, ${isPersona(persona) ? persona : ''}, 'email', ${s.toAddr}, ${s.subject}, ${s.body})
        `
      }
      if (suggested.length) {
        rows = (await sql`
          SELECT id, kind, to_addr AS "toAddr", subject, body, status, created_at AS "createdAt"
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
    if (body.id) {
      const rows = await sql`
        SELECT to_addr, subject, body FROM hire_drafts WHERE id = ${body.id} AND user_id = ${user!.id} LIMIT 1
      `
      const row = rows[0] as { to_addr: string; subject: string; body: string } | undefined
      if (row) {
        toAddr = toAddr || row.to_addr
        subject = subject || row.subject
        text = text || row.body
      }
    }
    if (!toAddr || !subject) return json({ ok: false, error: 'To and subject required' }, 400)
    const sent = await gmailSendMessage(sql, user!.id, { to: toAddr, subject, body: text })
    if (!sent.ok) return json({ ok: false, error: sent.error }, 400)
    if (body.id) {
      await sql`UPDATE hire_drafts SET status = 'sent', updated_at = now() WHERE id = ${body.id} AND user_id = ${user!.id}`
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
      token?: string; email?: string; title?: string; start?: string; end?: string
    }
    const { user, error } = await resolveAuthedUser(sql, { token: body.token, session: body.session, email: body.email })
    if (error) return error
    const start = String(body.start || '')
    const end = String(body.end || '')
    if (!start || !end) return json({ ok: false, error: 'start and end required' }, 400)
    const held = await calendarHold(sql, user!.id, {
      title: String(body.title || 'Hold').slice(0, 160),
      start,
      end,
    })
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
      SELECT id, name, kind, notes, cadence_days AS "cadenceDays",
             last_touch_at AS "lastTouchAt", updated_at AS "updatedAt"
      FROM hire_relationships WHERE user_id = ${user!.id}
      ORDER BY updated_at DESC LIMIT 60
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
      INSERT INTO hire_relationships (id, user_id, name, kind, notes, cadence_days)
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
        UPDATE hire_relationships SET last_touch_at = now(), updated_at = now()
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
    const estimate = await estimateNutrition(description, '')
    if (!estimate.ok) return json(estimate)
    const id = crypto.randomUUID()
    await sql`
      INSERT INTO hire_nutrition_logs (id, user_id, description, image_url, calories, protein, carbs, fat, eaten_at)
      VALUES (${id}, ${user.id}, ${estimate.guess || description.slice(0, 300)}, NULL,
        ${clampNum(estimate.calories)}, ${clampNum(estimate.protein)}, ${clampNum(estimate.carbs)}, ${clampNum(estimate.fat)}, now())
    `
    return json({ ...estimate, logged: true, id })
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
    const has = await sql`SELECT 1 FROM hire_moods WHERE user_id = ${user.id} AND created_at::date = ${ds} LIMIT 1`
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
    const id = crypto.randomUUID()
    await sql`
      INSERT INTO hire_spending (id, user_id, amount, category, description)
      VALUES (${id}, ${user.id}, ${parsed.amount}, ${parsed.category}, ${parsed.description})
    `
    return json({ ok: true, logged: true, id, ...parsed })
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
      phone?: string; persona?: string; name?: string; place?: string; text?: string
    }
    const name = String(body.name || '').trim().slice(0, 80)
    if (!body.phone || !isPersona(body.persona || '') || !name) {
      return json({ error: 'phone, persona, and name required' }, 400)
    }
    const user = await getUserByPhone(sql, body.phone)
    if (!user) return json({ error: 'User not found' }, 404)
    const whereMet = String(body.place || '').trim().slice(0, 120)
    const context = String(body.text || '').trim().slice(0, 400)
    const id = crypto.randomUUID()
    await sql`
      INSERT INTO hire_network (id, user_id, name, where_met, context, last_touch, cadence_days)
      VALUES (${id}, ${user.id}, ${name}, ${whereMet}, ${context}, now(), 14)
    `
    return json({ ok: true, logged: true, id, name, place: whereMet })
  }

  if (path === '/api/internal/digest' && req.method === 'GET') {
    if (!internalOk(req)) return json({ error: 'Unauthorized' }, 401)
    const phone = url.searchParams.get('phone') || ''
    const persona = url.searchParams.get('persona') || ''
    if (!phone || !isPersona(persona)) return json({ error: 'phone and persona required' }, 400)
    const user = await getUserByPhone(sql, phone)
    if (!user) return json({ error: 'User not found' }, 404)
    const payload = await digestPayload(sql, user, persona)
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
    return json({ logs, prs: prRows, workoutPlace: prefs.workoutPlace, workoutMoveCount: prefs.workoutMoveCount })
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

    const nutr = await sql`
      SELECT count(*)::int AS meals, coalesce(sum(calories), 0)::real AS calories
      FROM hire_nutrition_logs WHERE user_id = ${user!.id} AND eaten_at >= ${weekStart}::date AND eaten_at < ${weekEndStr}::date
    `
    const moods = await sql`
      SELECT count(*)::int AS logs, coalesce(avg(energy), 0)::real AS energy
      FROM hire_moods WHERE user_id = ${user!.id} AND created_at >= ${weekStart}::date AND created_at < ${weekEndStr}::date
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
      WHERE user_id = ${user!.id} AND spent_at >= ${weekStart}::date AND spent_at < ${weekEndStr}::date
    `
    const gratitude = await sql`
      SELECT count(*)::int AS n FROM hire_gratitude
      WHERE user_id = ${user!.id} AND created_at >= ${weekStart}::date AND created_at < ${weekEndStr}::date
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

  /* ---- Mirror (life reflection dashboard) ---- */
  if (path === '/api/mirror' && req.method === 'GET') {
    const { user, error } = await resolveAuthedUser(sql, {
      token: url.searchParams.get('t') || undefined,
      session: url.searchParams.get('s') || undefined,
      email: url.searchParams.get('email') || undefined,
    })
    if (error) return error
    const weekStart = userMonday(user!)
    const weekEndStr = shiftDateStr(weekStart, 7)
    const dayStart = shiftDateStr(weekStart, -14)
    const tzMirror = user!.timezone || 'America/Los_Angeles'
    const todayMirror = localDateStrInTz(new Date(), tzMirror)

    const nutr = await sql`
      SELECT count(*)::int AS meals, coalesce(sum(calories), 0)::real AS calories
      FROM hire_nutrition_logs WHERE user_id = ${user!.id} AND eaten_at >= ${weekStart}::date AND eaten_at < ${weekEndStr}::date
    `
    const nutrToday = await sql`
      SELECT coalesce(sum(protein), 0)::real AS protein, coalesce(sum(calories), 0)::real AS calories, count(*)::int AS meals
      FROM hire_nutrition_logs WHERE user_id = ${user!.id} AND eaten_at >= ${todayMirror}::date AND eaten_at < ${shiftDateStr(todayMirror, 1)}::date
    `
    const nutrGoals = await sql`
      SELECT protein_goal AS "proteinGoal", calorie_goal AS "calorieGoal" FROM hire_nutrition_goals WHERE user_id = ${user!.id} LIMIT 1
    `
    const workoutsTodayRows = await sql`
      SELECT count(*)::int AS n FROM hire_workouts
      WHERE user_id = ${user!.id} AND logged_at >= ${todayMirror}::date AND logged_at < ${shiftDateStr(todayMirror, 1)}::date
    `
    const moods = await sql`
      SELECT count(*)::int AS logs, coalesce(avg(energy), 0)::real AS energy
      FROM hire_moods WHERE user_id = ${user!.id} AND created_at >= ${weekStart}::date AND created_at < ${weekEndStr}::date
    `
    const habitRows = await sql`
      SELECT id, name FROM hire_habits WHERE user_id = ${user!.id} ORDER BY created_at ASC LIMIT 12
    `
    const habitLogs = await sql`
      SELECT habit_id AS "habitId", date FROM hire_habit_logs
      WHERE user_id = ${user!.id} AND date >= ${weekStart} AND date < ${weekEndStr}
    `
    const habitChecks = (habitLogs as Array<{ habitId: string }>).length
    const habitNames = (habitRows as Array<{ name: string }>).map((h) => h.name)
    const sleep = await sql`
      SELECT sleep_date AS "sleepDate", bedtime, wake, quality FROM hire_sleep
      WHERE user_id = ${user!.id} AND sleep_date >= ${weekStart} AND sleep_date < ${weekEndStr}
    `
    let sleepHours = 0
    const sleepRows = sleep as Array<{ sleepDate: string; bedtime: string; wake: string; quality: number }>
    if (sleepRows.length) {
      sleepHours = sleepRows.reduce((sum, r) => sum + sleepHoursBetween(r.bedtime, r.wake), 0) / sleepRows.length
    }
    const spend = await sql`
      SELECT coalesce(sum(amount), 0)::real AS total FROM hire_spending
      WHERE user_id = ${user!.id} AND spent_at >= ${weekStart}::date AND spent_at < ${weekEndStr}::date
    `
    const spendByCat = await sql`
      SELECT category, coalesce(sum(amount), 0)::real AS amount FROM hire_spending
      WHERE user_id = ${user!.id} AND spent_at >= ${weekStart}::date AND spent_at < ${weekEndStr}::date
      GROUP BY category ORDER BY amount DESC
    `
    const budgetRow = await sql`SELECT weekly_budget AS "weeklyBudget" FROM hire_spending_budget WHERE user_id = ${user!.id}`
    const workouts = await sql`
      SELECT count(*)::int AS n FROM hire_workouts
      WHERE user_id = ${user!.id} AND logged_at >= ${weekStart}::date AND logged_at < ${weekEndStr}::date
    `
    const prs = await sql`
      SELECT exercise, max(weight) AS weight FROM hire_workouts
      WHERE user_id = ${user!.id} AND weight > 0
      GROUP BY exercise ORDER BY weight DESC LIMIT 5
    `
    const learning = await sql`
      SELECT status, count(*)::int AS n, coalesce(sum(minutes), 0)::int AS mins FROM hire_learning
      WHERE user_id = ${user!.id} GROUP BY status
    `
    const learningNext = await sql`
      SELECT title FROM hire_learning WHERE user_id = ${user!.id} AND status = 'queued'
      ORDER BY created_at ASC LIMIT 1
    `
    const gratitude = await sql`
      SELECT count(*)::int AS n FROM hire_gratitude
      WHERE user_id = ${user!.id} AND created_at >= ${weekStart}::date AND created_at < ${weekEndStr}::date
    `
    const decisions = await sql`
      SELECT count(*) FILTER (WHERE outcome IS NULL)::int AS open,
             count(*) FILTER (WHERE outcome IS NOT NULL)::int AS resolved
      FROM hire_decisions WHERE user_id = ${user!.id}
    `
    const moodTrend = await sql`
      SELECT emoji, energy, created_at AS "createdAt" FROM hire_moods
      WHERE user_id = ${user!.id} AND created_at >= ${dayStart}::date
      ORDER BY created_at ASC LIMIT 60
    `
    const moodTrendRows = moodTrend as Array<{ emoji: string; energy: number; createdAt: Date }>
    const sleepTrend = await sql`
      SELECT sleep_date AS "sleepDate", bedtime, wake, quality FROM hire_sleep
      WHERE user_id = ${user!.id} AND sleep_date >= ${dayStart} AND sleep_date < ${weekEndStr}
      ORDER BY sleep_date ASC LIMIT 21
    `
    const reviews = await sql`
      SELECT id, week_start AS "weekStart", done_text AS "doneText", slipped_text AS "slippedText",
             focus_text AS "focusText", created_at AS "createdAt"
      FROM hire_weekly_reviews WHERE user_id = ${user!.id}
      ORDER BY week_start DESC LIMIT 4
    `
    const currentReview = (reviews as Array<{ weekStart: string }>).find((r) => r.weekStart === weekStart) || null
    const lrn = learning as Array<{ status: string; n: number; mins: number }>
    const queued = lrn.find((l) => l.status === 'queued')?.n || 0
    const done = lrn.find((l) => l.status === 'done')?.n || 0

    const sortedSleep = [...sleepRows].sort((a, b) => String(a.sleepDate).localeCompare(String(b.sleepDate)))
    const sleepHoursList = sortedSleep.map((r) => sleepHoursBetween(r.bedtime, r.wake))
    const lastNightHours = sleepHoursList.length ? sleepHoursList[sleepHoursList.length - 1]! : 0
    const shortNights = sleepHoursList.filter((h) => h < 6.5).length
    const gToday = nutrGoals[0] as { proteinGoal?: number; calorieGoal?: number } | undefined
    const nToday = nutrToday[0] as { protein?: number; calories?: number; meals?: number } | undefined

    return json({
      weekStart,
      window: {
        meals: Number((nutr[0] as { meals: number })?.meals || 0),
        calories: Number((nutr[0] as { calories: number })?.calories || 0),
        proteinToday: Math.round(Number(nToday?.protein) || 0),
        proteinGoal: Math.round(Number(gToday?.proteinGoal) || 150),
        caloriesToday: Math.round(Number(nToday?.calories) || 0),
        calorieGoal: Math.round(Number(gToday?.calorieGoal) || 2200),
        lastNightHours: Math.round(lastNightHours * 10) / 10,
        shortNights,
        workoutsToday: Number((workoutsTodayRows[0] as { n?: number })?.n || 0),
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
        date: localDateStrInTz(new Date(m.createdAt), tzMirror),
      })),
      sleepTrend: sleepRows.map((r) => ({
        date: String(r.sleepDate).slice(0, 10),
        hours: sleepHoursBetween(r.bedtime, r.wake),
        quality: r.quality,
      })),
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
    const people = await sql`
      SELECT id, name, where_met AS "whereMet", context, last_touch AS "lastTouch",
             cadence_days AS "cadenceDays", created_at AS "createdAt",
             phone, email AS "contactEmail", company
      FROM hire_network WHERE user_id = ${user!.id}
      ORDER BY coalesce(last_touch, '1970-01-01'::timestamptz) ASC
    `
    const persona = url.searchParams.get('persona') || 'friend'
    const calResult = isPersona(persona)
      ? await todayCalendarMeets(sql, user!, persona).catch(() => ({ meets: [], stay: null, calendarConnected: false }))
      : { meets: [], stay: null, calendarConnected: false }
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
    const cadenceDays = Math.max(3, Math.min(90, Math.round(body.cadenceDays || 14)))
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
      const cadenceDays = Math.max(3, Math.min(90, Math.round(body.cadenceDays || 14)))
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
      SELECT id, title, company, stage, notes, created_at AS "createdAt", updated_at AS "updatedAt"
      FROM hire_pipeline WHERE user_id = ${user!.id}
      ORDER BY updated_at DESC
    `
    return json({ items })
  }

  if (path === '/api/pipeline' && req.method === 'POST') {
    const body = (await req.json().catch(() => ({}))) as {
      token?: string; email?: string; title?: string; company?: string; stage?: string; notes?: string
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
    const id = crypto.randomUUID()
    await sql`
      INSERT INTO hire_pipeline (id, user_id, title, company, stage, notes)
      VALUES (${id}, ${user!.id}, ${title}, ${company}, ${stage}, ${notes})
    `
    return json({ ok: true, id })
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
    const weekCount = await sql`
      SELECT count(*)::int AS n FROM hire_gratitude
      WHERE user_id = ${user!.id} AND created_at >= ${monday}::date
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
    const logs = await sql`
      SELECT id, amount, category, description, spent_at AS "spentAt"
      FROM hire_spending WHERE user_id = ${user!.id}
      ORDER BY spent_at DESC LIMIT 40
    `
    const week = await sql`
      SELECT category, coalesce(sum(amount), 0)::real AS total
      FROM hire_spending
      WHERE user_id = ${user!.id} AND spent_at >= ${weekStart}::date AND spent_at < ${weekEndStr}::date
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
      workoutPlace?: string; workoutMoveCount?: number
      sleepBedtime?: string; sleepWake?: string
    }
    const { user, error } = await resolveAuthedUser(sql, { token: body.token, session: body.session, email: body.email })
    if (error) return error
    const prefs = await saveMiniPrefs(sql, user!.id, {
      workoutPlace: body.workoutPlace === 'home' || body.workoutPlace === 'gym' ? body.workoutPlace : undefined,
      workoutMoveCount: body.workoutMoveCount === 4 || body.workoutMoveCount === 5 || body.workoutMoveCount === 6
        ? body.workoutMoveCount
        : undefined,
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
