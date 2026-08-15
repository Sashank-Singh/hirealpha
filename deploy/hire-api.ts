/**
 * HireAlpha live config + connectors API (Postgres).
 * Dashboard writes here. iMessage bots read here.
 */
import { Composio } from '@composio/core'
import { createHmac, timingSafeEqual } from 'node:crypto'
import type { SQL } from 'bun'

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

export const PERSONA_DENIED: Record<Persona, ReadonlySet<string>> = {
  friend: new Set(['slack', 'linear', 'github', 'stripe', 'figma', 'notion']),
  coworker: new Set(['spotify', 'uber']),
  cofounder: new Set(['uber', 'spotify']),
}

const GOOGLE_SCOPES = [
  'openid',
  'email',
  'https://www.googleapis.com/auth/gmail.readonly',
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
}

async function getUserByEmail(sql: SQL, email: string) {
  const rows = await sql`
    SELECT id, email, name, timezone, phone_e164 AS phone FROM hire_users WHERE email = ${email} LIMIT 1
  `
  return (rows[0] as { id: string; email: string; name: string | null; timezone: string | null; phone: string | null } | undefined) ?? null
}

async function getUserByPhone(sql: SQL, phone: string) {
  const e164 = normalizePhone(phone)
  if (!e164) return null
  const rows = await sql`
    SELECT id, email, name, timezone, phone_e164 AS phone FROM hire_users
    WHERE phone_e164 = ${e164}
       OR right(regexp_replace(phone_e164, '[^0-9]', '', 'g'), 10)
          = ${e164.replace(/\D/g, '').slice(-10)}
    LIMIT 1
  `
  return (rows[0] as { id: string; email: string; name: string | null; timezone: string | null; phone: string | null } | undefined) ?? null
}

type AuthedUser = { id: string; email: string; name: string | null; timezone: string | null; phone: string | null }

/** Resolve the caller from either a signed mini token or a session email. */
async function resolveAuthedUser(
  sql: SQL,
  input: { token?: string; email?: string },
): Promise<{ user: AuthedUser | null; error?: Response }> {
  const email = String(input.email || '').trim().toLowerCase()
  if (input.token) {
    const tok = verifyMiniToken(input.token)
    if (!tok) {
      return {
        user: null,
        error: json({ error: 'This link expired. Sign in to keep using it.', code: 'token_invalid' }, 401),
      }
    }
    const user = await getUserByPhone(sql, tok.phone)
    if (!user) return { user: null, error: json({ error: 'No account found for that phone' }, 404) }
    return { user }
  }
  if (email.includes('@')) {
    const user = await getUserByEmail(sql, email)
    if (!user) return { user: null, error: json({ error: 'No account found for that email' }, 404) }
    return { user }
  }
  return { user: null, error: json({ error: 'email or token required' }, 400) }
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
  const cleanTz = timezone?.trim() ? timezone.trim() : null
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
  const data = await composio.connectedAccounts.list({
    userIds: [userId],
    statuses: ['ACTIVE'],
    limit: 50,
  })
  return (data.items || [])
    .filter((i) => !i.isDisabled)
    .map((i) => (i.toolkit?.slug || '').toLowerCase())
    .filter(Boolean)
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
    const ui = Object.entries(UI_TO_COMPOSIO).find(([, v]) => v === slug)?.[0]
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

async function googleAccessToken(sql: SQL, userId: string): Promise<string | null> {
  const creds = googleCreds()
  const rows = await sql`
    SELECT access_token, refresh_token, expires_at FROM hire_google_tokens WHERE user_id = ${userId} LIMIT 1
  `
  const row = rows[0] as
    | { access_token: string; refresh_token: string | null; expires_at: Date | null }
    | undefined
  if (!row) return null
  const exp = row.expires_at ? new Date(row.expires_at).getTime() : 0
  if (exp > Date.now() + 60_000) return row.access_token
  if (!creds || !row.refresh_token) return row.access_token
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

async function fetchGmail(access: string, query: string) {
  const listUrl = new URL('https://gmail.googleapis.com/gmail/v1/users/me/messages')
  listUrl.searchParams.set('maxResults', '100')
  listUrl.searchParams.set('q', query)
  const list = await fetch(listUrl, { headers: { Authorization: `Bearer ${access}` } })
  if (!list.ok) return `Gmail error ${list.status}`
  const data = (await list.json()) as { messages?: Array<{ id: string }> }
  const ids = (data.messages || []).slice(0, 100)
  const lines: string[] = []
  for (const m of ids) {
    const got = await fetch(
      `https://gmail.googleapis.com/gmail/v1/users/me/messages/${m.id}?format=metadata&metadataHeaders=Subject&metadataHeaders=From&metadataHeaders=Date`,
      { headers: { Authorization: `Bearer ${access}` } },
    )
    if (!got.ok) continue
    const msg = (await got.json()) as {
      snippet?: string
      payload?: { headers?: Array<{ name: string; value: string }> }
    }
    const headers = msg.payload?.headers || []
    const h = (n: string) => headers.find((x) => x.name.toLowerCase() === n.toLowerCase())?.value || ''
    lines.push(`- ${h('From')} | ${h('Date')} | ${h('Subject')} | ${msg.snippet || ''}`)
  }
  return lines.length ? `Email:\n${lines.join('\n')}` : 'No matching email found.'
}

async function fetchCalendar(access: string) {
  const now = new Date()
  const end = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000)
  const url = new URL('https://www.googleapis.com/calendar/v3/calendars/primary/events')
  url.searchParams.set('timeMin', now.toISOString())
  url.searchParams.set('timeMax', end.toISOString())
  url.searchParams.set('singleEvents', 'true')
  url.searchParams.set('orderBy', 'startTime')
  url.searchParams.set('maxResults', '8')
  const res = await fetch(url, { headers: { Authorization: `Bearer ${access}` } })
  if (!res.ok) return `Calendar error ${res.status}`
  const data = (await res.json()) as {
    items?: Array<{ summary?: string; start?: { dateTime?: string; date?: string } }>
  }
  const items = data.items || []
  if (!items.length) return 'No events on the calendar in the next 7 days.'
  return `Upcoming events:\n${items
    .map((e) => `- ${e.start?.dateTime || e.start?.date || '?'} ${e.summary || '(no title)'}`)
    .join('\n')}`
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
    const text = JSON.stringify(res.data ?? {})
    return text.slice(0, 4000)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return `Tool ${tool} failed: ${msg.slice(0, 240)}`
  }
}

function wantsEmail(text: string) {
  return /\b(e-?mails?|inbox|gmail|unread)\b/i.test(text)
}
function wantsImportantEmail(text: string) {
  return /\b(important|flagged|priority)\b/i.test(text)
}
function wantsCalendar(text: string) {
  return /\b(calendar|meeting|meetings|schedule|free time|what.?s on|agenda|tomorrow|today|standup)\b/i.test(text)
}
function wantsMaps(text: string) {
  return /\b(dinner|restaurant|tonight|date night|place|places|booth|maps|hangout|where (?:should|can) we)\b/i.test(
    text,
  )
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
  input: { userId: string; persona: Persona; message: string; connected: string[] },
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

  if (wantsEmail(input.message) && can('gmail')) {
    const query = wantsImportantEmail(input.message) ? 'is:important newer_than:14d' : 'newer_than:5d'
    const access = await googleAccessToken(sql, input.userId)
    if (access) results.push(await fetchGmail(access, query))
    else {
      const c = await composioExecute(input.userId, 'GMAIL_FETCH_EMAILS', {
        max_results: 100,
        query,
        verbose: false,
      })
      if (c) results.push(c)
    }
  } else {
    asked('gmail', wantsEmail(input.message))
  }

  if (wantsCalendar(input.message) && can('calendar')) {
    const access = await googleAccessToken(sql, input.userId)
    if (access) results.push(await fetchCalendar(access))
    else {
      const c = await composioExecute(input.userId, 'GOOGLECALENDAR_FIND_EVENT', {
        max_results: 8,
      })
      if (c) results.push(c)
    }
  } else {
    asked('calendar', wantsCalendar(input.message))
  }

  if (input.persona === 'friend') {
    if (wantsMaps(input.message) && can('maps')) {
      const q =
        input.message.replace(/\b(tonight|dinner|restaurant|place|places|maps)\b/gi, ' ').trim().slice(0, 80) ||
        'quiet restaurant nearby'
      const c = await composioFirst(
        input.userId,
        ['GOOGLEMAPS_TEXT_SEARCH', 'GOOGLEMAPS_SEARCH_PLACES', 'GOOGLE_MAPS_SEARCH_PLACES'],
        { query: q, q },
      )
      results.push(c || 'Maps is connected but the search failed. Say that honestly. Do not invent a restaurant.')
    } else {
      asked('maps', wantsMaps(input.message))
    }
  }

  if (input.persona === 'coworker') {
    if (wantsSlack(input.message) && can('slack')) {
      const c = await composioFirst(
        input.userId,
        ['SLACK_SEARCH_MESSAGES', 'SLACK_LIST_CHANNELS', 'SLACK_FETCH_CONVERSATION_HISTORY'],
        { query: input.message.slice(0, 80), limit: 8 },
      )
      results.push(c || 'Slack is connected but nothing came back. Say that. Do not invent a thread.')
    } else {
      asked('slack', wantsSlack(input.message))
    }
    if (wantsLinear(input.message) && can('linear')) {
      const c = await composioFirst(
        input.userId,
        ['LINEAR_LIST_ISSUES', 'LINEAR_LIST_LINEAR_ISSUES', 'LINEAR_GET_ISSUES'],
        { limit: 8 },
      )
      results.push(c || 'Linear is connected but nothing came back. Say that. Do not invent tickets.')
    } else {
      asked('linear', wantsLinear(input.message))
    }
  }

  if (input.persona === 'cofounder') {
    if (wantsNotion(input.message) && can('notion')) {
      const c = await composioFirst(
        input.userId,
        ['NOTION_SEARCH', 'NOTION_SEARCH_NOTION_PAGE', 'NOTION_FETCH_DATA'],
        { query: input.message.slice(0, 80) },
      )
      results.push(c || 'Notion is connected but the search failed. Say that. Do not invent a page.')
    } else {
      asked('notion', wantsNotion(input.message))
    }
    if (wantsDrive(input.message) && can('drive')) {
      const access = await googleAccessToken(sql, input.userId)
      if (access) results.push(await fetchDrive(access, input.message.slice(0, 40)))
      else {
        const c = await composioFirst(
          input.userId,
          ['GOOGLEDRIVE_LIST_FILES', 'GOOGLEDRIVE_FIND_FILE', 'GOOGLE_DRIVE_LIST_FILES'],
          { pageSize: 8 },
        )
        results.push(c || 'Drive is connected but nothing came back. Say that. Do not invent a file.')
      }
    } else {
      asked('drive', wantsDrive(input.message))
    }
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

/**
 * Morning-brief payload: today's calendar, important mail, and pending
 * reminders for one hire. `text` is the plain-SMS briefing; the structured
 * fields feed the in-Messages app card.
 */
async function digestPayload(
  sql: SQL,
  user: { id: string; timezone: string | null },
  persona: Persona,
) {
  const tz = user.timezone || 'America/Los_Angeles'
  const connected = (await connectedForUser(sql, user.id)).filter(
    (id) => !PERSONA_DENIED[persona].has(id),
  )
  const results = await runToolsForMessage(sql, {
    userId: user.id,
    persona,
    message: 'calendar today and important email',
    connected,
  })
  const calendarBlock = results.find(
    (t) => t.startsWith('Upcoming events:') || t.startsWith('No events'),
  )
  const emailBlock = results.find(
    (t) =>
      t.startsWith('Email:') ||
      t.startsWith('Important email:') ||
      t.startsWith('No matching email'),
  )

  const calendar = digestLines(calendarBlock).map((l) => {
    const m = l.match(/^-\s+(\S+)\s+(.*)$/)
    return m ? `${formatCalTime(m[1]!, tz)} · ${m[2]!}` : l.replace(/^-\s*/, '')
  })
  const emails = digestLines(emailBlock).slice(0, 5).map(formatMailLine)

  const reminderRows = await sql`
    SELECT text, scheduled_at AS "scheduledAt" FROM hire_reminders
    WHERE user_id = ${user.id} AND persona = ${persona} AND status = 'pending'
    ORDER BY scheduled_at ASC LIMIT 8
  `
  const reminders = (reminderRows as { text: string; scheduledAt: Date }[]).map((r) => ({
    time: formatCalTime(new Date(r.scheduledAt).toISOString(), tz),
    text: r.text.startsWith('[digest]')
      ? r.text.slice(8).trim()
      : r.text.startsWith('[poke]')
        ? r.text.slice(6).trim()
        : r.text,
  }))

  const dateLabel = new Date().toLocaleDateString('en-US', {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    timeZone: tz,
  })

  const section = (title: string, items: string[]) =>
    items.length ? `${title}\n${items.map((i) => `- ${i}`).join('\n')}` : null

  const text = [
    `${PERSONA_LABEL[persona]} · Morning brief · ${dateLabel}`,
    section('On your calendar', calendar),
    section('Important mail', emails),
    section('Reminders', reminders.map((r) => `${r.time} · ${r.text}`)),
  ]
    .filter(Boolean)
    .join('\n\n')

  return { date: dateLabel, calendar, emails, reminders, text }
}

/** Mini apps each hire can offer, mirroring src/agents/skills.ts. */
const PERSONA_MINI_APPS: Record<Persona, string[]> = {
  friend: ['digest', 'check_in', 'pick_night', 'spiral_options', 'open_loops', 'relationship_radar', 'drop_zone', 'nutrition'],
  coworker: ['digest', 'approve_send', 'pick_slot', 'standup_paste', 'linear_triage', 'open_loops', 'meeting_mode', 'drop_zone'],
  cofounder: ['digest', 'kill_keep_park', 'hire_decision', 'weekly_focus', 'approve_investor_note', 'decision_ledger', 'relationship_radar', 'drop_zone', 'open_loops'],
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

async function armPokes(
  sql: SQL,
  user: { id: string; timezone: string | null },
  persona: Persona,
  context: Record<string, string>,
) {
  const existing = await sql`
    SELECT id FROM hire_reminders
    WHERE user_id = ${user.id} AND persona = ${persona} AND status = 'pending' AND text LIKE ${POKE_MARKER + '%'}
    LIMIT 1
  `
  if (existing[0]) return
  const tz = context.timezone || user.timezone || 'America/Los_Angeles'
  if (persona === 'friend') {
    await sql`
      INSERT INTO hire_reminders (id, user_id, persona, text, scheduled_at, recurrence, timezone, status)
      VALUES (
        ${crypto.randomUUID()}, ${user.id}, ${persona},
        ${POKE_MARKER + 'Want a 9pm debrief or space tonight?'},
        ${nextLocalTimeUtc(tz, 21, 0)}, 'daily', ${tz}, 'pending'
      )
    `
    return
  }
  if (persona === 'coworker') {
    const clock = parseStandupClock(context.standup_time)
    let minute = clock.minute - 12
    let hour = clock.hour
    if (minute < 0) {
      minute += 60
      hour = (hour + 23) % 24
    }
    await sql`
      INSERT INTO hire_reminders (id, user_id, persona, text, scheduled_at, recurrence, timezone, status)
      VALUES (
        ${crypto.randomUUID()}, ${user.id}, ${persona},
        ${POKE_MARKER + 'Standup in 12. Send raw notes if you want bullets.'},
        ${nextLocalTimeUtc(tz, hour, minute)}, 'daily', ${tz}, 'pending'
      )
    `
    return
  }
  const focus = (context.weekly_focus || '').trim().slice(0, 80)
  const text = focus
    ? `${POKE_MARKER}What's the real decision this week? You wrote: ${focus}`
    : `${POKE_MARKER}What's the real decision this week?`
  await sql`
    INSERT INTO hire_reminders (id, user_id, persona, text, scheduled_at, recurrence, timezone, status)
    VALUES (
      ${crypto.randomUUID()}, ${user.id}, ${persona}, ${text},
      ${nextWeekdayLocalUtc(tz, 0, 18, 0)}, 'weekly', ${tz}, 'pending'
    )
  `
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
  if (!first) return { armed: false, first: false }
  const context = await loadContext(sql, user.id, persona)
  await armPokes(sql, user, persona, context)
  return { armed: true, first: true }
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
    const people = splitList(context.people)
    const who = people[0] || 'whoever you are meeting'
    let places: string[] = []
    if (connected.includes('maps')) {
      const c = await composioFirst(
        user.id,
        ['GOOGLEMAPS_TEXT_SEARCH', 'GOOGLEMAPS_SEARCH_PLACES', 'GOOGLE_MAPS_SEARCH_PLACES'],
        { query: 'quiet restaurant nearby', q: 'quiet restaurant nearby' },
      )
      if (c && !/failed/i.test(c)) {
        places = c
          .split('\n')
          .map((l) => l.replace(/^[-*]\s*/, '').trim())
          .filter(Boolean)
          .slice(0, 3)
      }
    }
    const options = places.length
      ? places
      : [
          `Quiet booth. ${who} can hear you.`,
          'The loud one. Fun, then they cannot hear a thing.',
        ]
    const call = places[0] || 'Hold the quiet booth. Text me if you want the shouty one instead.'
    const connectHint = connected.includes('maps')
      ? []
      : ['Maps is not connected. Open this hire at hirealpha.chat/app and tap Connect if you want a real place, not a vibe.']
    const sections = [
      { heading: 'Options', items: options },
      { heading: 'The call', items: [call, ...connectHint] },
    ]
    const text = [`Tonight with ${who}.`, ...options.map((o) => `- ${o}`), `Call: ${call}`].join('\n')
    return { kind, title: "Tonight's plan", date: dateLabel, sections, paste: text, text }
  }

  if (kind === 'standup_paste') {
    const results = await runToolsForMessage(sql, {
      userId: user.id,
      persona,
      message: 'calendar today standup',
      connected,
    })
    const calendarBlock = results.find((t) => t.startsWith('Upcoming events:') || t.startsWith('No events'))
    const calItems = digestLines(calendarBlock).map((l) => l.replace(/^-\s*/, '')).slice(0, 4)
    const projects = splitList(context.projects)
    const yesterday = projects[0] ? `${projects[0]} moved` : 'Ship what actually merged. No theater.'
    const today = calItems[0] || (projects[1] ? `${projects[1]} today` : 'One thing on the critical path.')
    const blocked = projects[2] || 'Name the person or the spec. Not "waiting."'
    const paste = `Yesterday: ${yesterday}\nToday: ${today}\nBlocked: ${blocked}`
    const sections = [
      { heading: 'Paste this', items: [paste] },
      { heading: 'On the calendar', items: calItems.length ? calItems : ['Nothing on calendar.'] },
      { heading: 'Projects on file', items: projects.length ? projects : ['Add projects in Context so this is specific.'] },
    ]
    return { kind, title: 'Standup', date: dateLabel, sections, paste, text: paste }
  }

  if (kind === 'kill_keep_park') {
    const focus = (context.weekly_focus || '').trim()
    const nos = splitList(context.hard_nos)
    const stage = (context.stage || '').trim()
    const keep = focus || 'The thing that makes you a company this week, not a costume.'
    const kill = nos[0] || 'Whatever looks real to people who do not write checks.'
    const park = nos[1] || (stage ? `Park anything that is not ${stage}.` : 'Park the hire until the funnel is yours.')
    const sections = [
      { heading: 'Keep', items: [keep] },
      { heading: 'Kill', items: [kill] },
      { heading: 'Park', items: [park] },
    ]
    const paste = `Keep: ${keep}\nKill: ${kill}\nPark: ${park}`
    return { kind, title: 'Kill · Keep · Park', date: dateLabel, sections, paste, text: paste }
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
    }
  }
  const roster = await loadRoster(sql, user.id)
  const hired = roster.includes(persona)
  const context = hired ? await loadContext(sql, user.id, persona) : {}
  const connected = hired
    ? (await connectedForUser(sql, user.id)).filter((id) => !PERSONA_DENIED[persona].has(id))
    : []
  const memories = hired ? await loadMemories(sql, user.id, persona, 12) : []
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
  }
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
    return json({ user, roster, context, connected, memory })
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
    }
    if (!body.phone || !body.persona || !isPersona(body.persona)) {
      return json({ error: 'phone and persona required' }, 400)
    }
    const live = await livePayload(sql, body.phone, body.persona)
    if (!live.found || !live.hired || !live.userId) return json({ results: [] })
    const results = await runToolsForMessage(sql, {
      userId: live.userId,
      persona: body.persona,
      message: body.message || '',
      connected: live.connected,
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
    const payload = await digestPayload(sql, user, persona)
    return json({ ...payload, cardUrl: `${appBase(req)}/app/mini/${persona}/digest` })
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

    const { user, error } = await resolveAuthedUser(sql, { token: body.token, email: body.email })
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
    }

    return json({ ok: true, features: requested, setup: next, setupDone })
  }

  if (path === '/api/loops' && req.method === 'GET') {
    const { user, error } = await resolveAuthedUser(sql, {
      token: url.searchParams.get('t') || undefined,
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
    const { user, error } = await resolveAuthedUser(sql, { token: body.token, email: body.email })
    if (error) return error
    const id = crypto.randomUUID()
    await sql`
      INSERT INTO hire_loops (id, user_id, persona, title, context, due_at)
      VALUES (${id}, ${user!.id}, ${isPersona(body.persona || '') ? body.persona! : ''},
        ${title}, ${String(body.context || '').slice(0, 500)},
        ${body.dueAt ? new Date(body.dueAt).toISOString() : null})
    `
    return json({ ok: true, id })
  }

  if (path.startsWith('/api/loops/') && req.method === 'PATCH') {
    const id = path.slice('/api/loops/'.length)
    const body = (await req.json().catch(() => ({}))) as { token?: string; email?: string; status?: string }
    const status = body.status === 'done' || body.status === 'snoozed' ? body.status : 'open'
    const { user, error } = await resolveAuthedUser(sql, { token: body.token, email: body.email })
    if (error) return error
    await sql`
      UPDATE hire_loops SET status = ${status}, updated_at = now()
      WHERE id = ${id} AND user_id = ${user!.id}
    `
    return json({ ok: true })
  }

  if (path === '/api/decisions' && req.method === 'GET') {
    const { user, error } = await resolveAuthedUser(sql, {
      token: url.searchParams.get('t') || undefined,
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
    const { user, error } = await resolveAuthedUser(sql, { token: body.token, email: body.email })
    if (error) return error
    const id = crypto.randomUUID()
    await sql`
      INSERT INTO hire_decisions (id, user_id, persona, decision, reason, evidence, owner, review_at)
      VALUES (${id}, ${user!.id}, ${isPersona(body.persona || '') ? body.persona! : 'cofounder'},
        ${decision}, ${String(body.reason || '').slice(0, 500)}, ${String(body.evidence || '').slice(0, 500)},
        ${String(body.owner || '').slice(0, 120)}, ${body.reviewAt ? new Date(body.reviewAt).toISOString() : null})
    `
    return json({ ok: true, id })
  }

  if (path.startsWith('/api/decisions/') && req.method === 'PATCH') {
    const id = path.slice('/api/decisions/'.length)
    const body = (await req.json().catch(() => ({}))) as { token?: string; email?: string; outcome?: string }
    const { user, error } = await resolveAuthedUser(sql, { token: body.token, email: body.email })
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
    const { user, error } = await resolveAuthedUser(sql, { token: body.token, email: body.email })
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
    const { user, error } = await resolveAuthedUser(sql, { token: body.token, email: body.email })
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
    const { user, error } = await resolveAuthedUser(sql, { token: body.token, email: body.email })
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
    const { user, error } = await resolveAuthedUser(sql, { token: body.token, email: body.email })
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
      email: url.searchParams.get('email') || undefined,
    })
    if (error) return error
    const rows = await sql`
      SELECT id, title, starts_at AS "startsAt", phase, briefing, followups,
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
    const { user, error } = await resolveAuthedUser(sql, { token: body.token, email: body.email })
    if (error) return error
    const id = crypto.randomUUID()
    await sql`
      INSERT INTO hire_meetings (id, user_id, title, starts_at)
      VALUES (${id}, ${user!.id}, ${title}, ${body.startsAt ? new Date(body.startsAt).toISOString() : null})
    `
    return json({ ok: true, id })
  }

  if (path.startsWith('/api/meetings/') && req.method === 'PATCH') {
    const id = path.slice('/api/meetings/'.length)
    const body = (await req.json().catch(() => ({}))) as {
      token?: string; email?: string; briefing?: string
      followups?: unknown; phase?: string
    }
    const { user, error } = await resolveAuthedUser(sql, { token: body.token, email: body.email })
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

  if (path === '/api/nutrition' && req.method === 'GET') {
    const { user, error } = await resolveAuthedUser(sql, {
      token: url.searchParams.get('t') || undefined,
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
    const { user, error } = await resolveAuthedUser(sql, { token: body.token, email: body.email })
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
    const { user, error } = await resolveAuthedUser(sql, { token: body.token, email: body.email })
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
    const { user, error } = await resolveAuthedUser(sql, { token: body.token, email: body.email })
    if (error) return error
    void user
    const estimate = await estimateNutrition(String(body.description || '').slice(0, 500), body.imageBase64 || '')
    return json(estimate)
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
    const body = (await req.json().catch(() => ({}))) as { nextAt?: string }
    const rows = await sql`
      SELECT id, recurrence FROM hire_reminders WHERE id = ${reminderDone[1]} LIMIT 1
    `
    const row = rows[0] as { id: string; recurrence: string } | undefined
    if (!row) return json({ error: 'Reminder not found' }, 404)
    if (row.recurrence !== 'once' && body.nextAt) {
      const next = new Date(body.nextAt)
      if (!Number.isNaN(next.getTime())) {
        await sql`
          UPDATE hire_reminders SET scheduled_at = ${next.toISOString()}, updated_at = now() WHERE id = ${row.id}
        `
        return json({ ok: true, rescheduled: true, nextAt: next.toISOString() })
      }
    }
    await sql`UPDATE hire_reminders SET status = 'sent' WHERE id = ${row.id}`
    return json({ ok: true, rescheduled: false })
  }

  if (path === '/api/internal/reminders' && req.method === 'DELETE') {
    if (!internalOk(req)) return json({ error: 'Unauthorized' }, 401)
    const id = url.searchParams.get('id') || ''
    if (!id) return json({ error: 'id required' }, 400)
    await sql`DELETE FROM hire_reminders WHERE id = ${id}`
    return json({ ok: true })
  }

  return null
}
