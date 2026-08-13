/**
 * HireAlpha live config + connectors API (Postgres).
 * Dashboard writes here. iMessage bots read here.
 */
import { Composio } from '@composio/core'
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

export async function ensureHireSchema(sql: SQL) {
  await sql`
    CREATE TABLE IF NOT EXISTS hire_users (
      id TEXT PRIMARY KEY,
      email TEXT NOT NULL UNIQUE,
      name TEXT,
      phone_e164 TEXT UNIQUE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `
  await sql`ALTER TABLE hire_users ADD COLUMN IF NOT EXISTS name TEXT`
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
}

async function getUserByEmail(sql: SQL, email: string) {
  const rows = await sql`
    SELECT id, email, name, phone_e164 AS phone FROM hire_users WHERE email = ${email} LIMIT 1
  `
  return (rows[0] as { id: string; email: string; name: string | null; phone: string | null } | undefined) ?? null
}

async function getUserByPhone(sql: SQL, phone: string) {
  const e164 = normalizePhone(phone)
  if (!e164) return null
  const rows = await sql`
    SELECT id, email, name, phone_e164 AS phone FROM hire_users
    WHERE phone_e164 = ${e164}
       OR right(regexp_replace(phone_e164, '[^0-9]', '', 'g'), 10)
          = ${e164.replace(/\D/g, '').slice(-10)}
    LIMIT 1
  `
  return (rows[0] as { id: string; email: string; name: string | null; phone: string | null } | undefined) ?? null
}

async function ensureUser(sql: SQL, email: string, phone?: string | null, name?: string | null) {
  const existing = await getUserByEmail(sql, email)
  const e164 = normalizePhone(phone || '')
  const cleanName = name?.trim() ? name.trim() : null
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
    if (changed) {
      await sql`
        UPDATE hire_users SET
          phone_e164 = ${existing.phone},
          name = ${existing.name},
          updated_at = now()
        WHERE id = ${existing.id}
      `
    }
    return existing
  }
  const id = crypto.randomUUID()
  await sql`
    INSERT INTO hire_users (id, email, name, phone_e164)
    VALUES (${id}, ${email}, ${cleanName}, ${e164})
  `
  return { id, email, name: cleanName, phone: e164 }
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
  return /\b(calendar|meeting|meetings|schedule|free time|what.?s on|agenda|tomorrow|today)\b/i.test(text)
}

export async function runToolsForMessage(
  sql: SQL,
  input: { userId: string; persona: Persona; message: string; connected: string[] },
): Promise<string[]> {
  const results: string[] = []
  const denied = PERSONA_DENIED[input.persona]
  const can = (id: string) => input.connected.includes(id) && !denied.has(id)

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
  }
  return results
}

async function livePayload(sql: SQL, phone: string, persona: Persona) {
  const user = await getUserByPhone(sql, phone)
  if (!user) {
    return {
      found: false,
      hired: false,
      context: {} as Record<string, string>,
      connected: [] as string[],
      email: null as string | null,
      name: null as string | null,
    }
  }
  const roster = await loadRoster(sql, user.id)
  const hired = roster.includes(persona)
  const context = hired ? await loadContext(sql, user.id, persona) : {}
  const connected = hired
    ? (await connectedForUser(sql, user.id)).filter((id) => !PERSONA_DENIED[persona].has(id))
    : []
  return { found: true, hired, context, connected, email: user.email, name: user.name, userId: user.id }
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
    const body = (await req.json().catch(() => ({}))) as { email?: string; phone?: string; name?: string }
    const email = String(body.email || '')
      .trim()
      .toLowerCase()
    if (!email.includes('@')) return json({ error: 'Enter a valid email' }, 400)
    try {
      const user = await ensureUser(sql, email, body.phone, body.name)
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
    for (const p of roster) context[p] = await loadContext(sql, user.id, p)
    const connected = await connectedForUser(sql, user.id)
    return json({ user, roster, context, connected })
  }

  if (path === '/api/me/phone' && req.method === 'PUT') {
    const body = (await req.json().catch(() => ({}))) as { email?: string; phone?: string; name?: string }
    const email = String(body.email || '')
      .trim()
      .toLowerCase()
    const phone = normalizePhone(body.phone || '')
    if (!email.includes('@') || !phone) return json({ error: 'email and phone required' }, 400)
    const user = await ensureUser(sql, email, phone, body.name)
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
    return json({ ok: true, fields })
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

  return null
}
