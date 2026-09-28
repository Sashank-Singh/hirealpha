import { Composio } from '@composio/core'
import type { SQL } from 'bun'
import { googleCreds } from '../auth/google'
import {
  googleTokenHasScope,
  formatUpcomingEvents,
  hydrateCalItems,
  parseComposioCalendarData,
  parseGoogleCalendarItems,
  serializeCalItems,
  type CalItem,
} from '../calendarEvents'
import { formatComposioData, COMPOSIO_READ, composioLooksFailed } from '../composioPlugins'
import { DEMO_COMPOSIO_TOOLKITS, DEMO_CONNECTED, demoComposioData, isDemoUserId } from '../demoData'
import {
  formatComposioMailBlock,
  parseComposioMailItems,
  parseComposioMailBody,
  MAIL_READ_WINDOW,
  type ComposioMailItem,
  type ComposioMailBody,
} from '../gmailHelpers'
import { fetchPublic } from '../utils/http'
import { withTimeout } from '../utils/async'

export const UI_TO_COMPOSIO: Record<string, string> = {
  gmail: 'gmail',
  calendar: 'googlecalendar',
  slack: 'slack',
  notion: 'notion',
  linear: 'linear',
  github: 'github',
  gitlab: 'gitlab',
  jira: 'jira',
  sentry: 'sentry',
  postman: 'postman',
  drive: 'googledrive',
  coda: 'coda',
  confluence: 'confluence',
  airtable: 'airtable',
  figma: 'figma',
  miro: 'miro',
  hubspot: 'hubspot',
  salesforce: 'salesforce',
  intercom: 'intercom',
  discord: 'discord',
  whatsapp: 'whatsapp',
  telegram: 'telegram',
  twitter: 'twitter',
  calendly: 'calendly',
  maps: 'googlemaps',
  spotify: 'spotify',
  youtube: 'youtube',
  twitch: 'twitch',
  vimeo: 'vimeo',
  loom: 'loom',
  zoom: 'zoom',
  meet: 'googlemeet',
  stripe: 'stripe',
  plaid: 'plaid',
  quickbooks: 'quickbooks',
}

export const COMPOSIO_SLUG_ALIASES: Record<string, string> = {
  googlemaps: 'maps',
  google_maps: 'maps',
  'google-maps': 'maps',
  googlecalendar: 'calendar',
  google_calendar: 'calendar',
  googledrive: 'drive',
  google_drive: 'drive',
  google_gmail: 'gmail',
}

export function composioKey(): string {
  return process.env.COMPOSIO_API_KEY?.trim() || ''
}

export function composioClient(): Composio | null {
  if (!composioKey()) return null
  return new Composio({ allowTracking: false })
}

/**
 * Delete extra ACTIVE connections for a toolkit, keeping the newest.
 */
export async function dropDuplicateConnections(ids: string[]): Promise<void> {
  const composio = composioClient()
  if (!composio) return
  for (const id of ids) {
    try {
      await composio.connectedAccounts.delete(id)
      console.warn(`[composio] dropped duplicate connected account ${id}`)
    } catch (err) {
      console.warn('[composio] duplicate cleanup failed', id, err)
    }
  }
}

export async function composioResolveAccountId(
  userId: string,
  toolkit: string,
): Promise<string | null> {
  const composio = composioClient()
  if (!composio) return null
  try {
    const data = await Promise.race([
      composio.connectedAccounts.list({
        userIds: [userId],
        statuses: ['ACTIVE'],
        limit: 50,
      }),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('composio list timeout')), 4000)),
    ])
    const items = (data.items || []) as Array<{
      id?: string
      isDisabled?: boolean
      toolkit?: { slug?: string }
      createdAt?: string | null
    }>
    const forToolkit = items
      .filter((i) => !i.isDisabled && (i.toolkit?.slug || '').toLowerCase() === toolkit.toLowerCase() && !!i.id)
      .sort((a, b) => Date.parse(b.createdAt || '') - Date.parse(a.createdAt || ''))
    if (forToolkit.length > 1) await dropDuplicateConnections(forToolkit.slice(1).map((i) => i.id!))
    if (forToolkit[0]?.id) return forToolkit[0].id
  } catch {
    // SDK list timed out or threw — fall through to the REST read below.
  }

  const key = composioKey()
  if (!key) return null
  try {
    const url = new URL('https://backend.composio.dev/api/v3/connected_accounts')
    url.searchParams.set('user_ids', userId)
    url.searchParams.set('statuses', 'ACTIVE')
    url.searchParams.set('limit', '50')
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${key}`, Accept: 'application/json' },
      signal: AbortSignal.timeout(3500),
    })
    if (!res.ok) return null
    const data = (await res.json()) as {
      items?: Array<{ id?: string; is_disabled?: boolean; toolkit?: { slug?: string }; created_at?: string | null }>
    }
    const forToolkit = (data.items || [])
      .filter((i) => !i.is_disabled && (i.toolkit?.slug || '').toLowerCase() === toolkit.toLowerCase() && !!i.id)
      .sort((a, b) => Date.parse(b.created_at || '') - Date.parse(a.created_at || ''))
    if (forToolkit.length > 1) await dropDuplicateConnections(forToolkit.slice(1).map((i) => i.id!))
    return forToolkit[0]?.id || null
  } catch {
    return null
  }
}

const composioPins = new Map<string, { id: string; at: number }>()
const COMPOSIO_PIN_TTL_MS = 10 * 60_000

export async function composioPinnedAccountId(userId: string, toolkit: string): Promise<string | null> {
  if (!toolkit) return null
  const key = `${userId}:${toolkit.toLowerCase()}`
  const hit = composioPins.get(key)
  if (hit && Date.now() - hit.at < COMPOSIO_PIN_TTL_MS) return hit.id
  const id = await composioResolveAccountId(userId, toolkit)
  if (id) {
    if (composioPins.size > 500) {
      const cutoff = Date.now() - COMPOSIO_PIN_TTL_MS
      for (const [k, v] of composioPins) if (v.at < cutoff) composioPins.delete(k)
    }
    composioPins.set(key, { id, at: Date.now() })
  }
  return id
}

export function composioInvalidatePin(userId: string, toolkit: string) {
  composioPins.delete(`${userId}:${toolkit.toLowerCase()}`)
}

const composioConnectedCache = new Map<string, { items: string[]; at: number }>()
const COMPOSIO_CONNECTED_TTL_MS = 3 * 60_000

export function clearComposioCache(userId?: string) {
  if (userId) composioConnectedCache.delete(userId)
  else composioConnectedCache.clear()
}

export async function composioConnected(userId: string): Promise<string[]> {
  if (isDemoUserId(userId)) return [...DEMO_COMPOSIO_TOOLKITS]
  const hit = composioConnectedCache.get(userId)
  if (hit && Date.now() - hit.at < COMPOSIO_CONNECTED_TTL_MS) {
    return hit.items
  }
  const composio = composioClient()
  if (!composio) return hit?.items || []
  const read = async () => {
    const data = await Promise.race([
      composio.connectedAccounts.list({
        userIds: [userId],
        statuses: ['ACTIVE'],
        limit: 50,
      }),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('composio list timeout')), 8000)),
    ])
    const items = (data.items || [])
      .filter((i) => !i.isDisabled)
      .map((i) => ((i.toolkit?.slug || (i as any).appName || (i as any).appUniqueId || (i as any).app || '') as string).toLowerCase())
      .filter(Boolean)
    if (items.length) composioConnectedCache.set(userId, { items, at: Date.now() })
    return items
  }
  try {
    return await read()
  } catch {
    try {
      return await read()
    } catch (err) {
      console.warn('[composio] connected list failed', err)
      return hit?.items || []
    }
  }
}

export async function composioDisconnect(userId: string, toolkit: string): Promise<boolean> {
  const composio = composioClient()
  if (!composio) return false
  const target = toolkit.toLowerCase()
  try {
    const data = await Promise.race([
      composio.connectedAccounts.list({
        userIds: [userId],
        statuses: ['ACTIVE'],
        limit: 50,
      }),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('composio list timeout')), 4000)),
    ])
    const items = (data.items || []) as Array<{ id?: string; isDisabled?: boolean; toolkit?: { slug?: string } }>
    const match = items.find((i) => !i.isDisabled && (i.toolkit?.slug || '').toLowerCase() === target && !!i.id)
    if (!match?.id) return false
    await composio.connectedAccounts.delete(match.id)
    composioInvalidatePin(userId, target)
    composioConnectedCache.delete(userId)
    return true
  } catch (err) {
    console.warn('[composio] disconnect failed', target, err)
    return false
  }
}

export function googleUiConnected(scopes: string): string[] {
  const out: string[] = []
  if (scopes.includes('gmail')) out.push('gmail')
  if (scopes.includes('calendar')) out.push('calendar')
  if (scopes.includes('drive')) out.push('drive')
  return out
}

export async function googleConnected(sql: SQL, userId: string): Promise<{ scopes: string; expiresAt: Date | null; hasRefresh: boolean } | null> {
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

export async function connectedForUser(sql: SQL, userId: string): Promise<string[]> {
  if (isDemoUserId(userId)) return [...DEMO_CONNECTED]
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

export async function composioAuthConfigId(sql: SQL, toolkit: string): Promise<string | null> {
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

export async function composioAuthorize(sql: SQL, userId: string, toolkit: string, callbackUrl: string): Promise<string | null> {
  const authConfigId = await composioAuthConfigId(sql, toolkit)
  if (!authConfigId) return null
  const composio = composioClient()
  if (!composio) return null
  const request = await composio.connectedAccounts.link(userId, authConfigId, {
    callbackUrl,
    allowMultiple: true,
  })
  composioInvalidatePin(userId, toolkit)
  return request.redirectUrl || null
}

export type ConnectorFailureReason = 'auth_expired' | 'timeout' | 'provider_error' | 'not_connected'
export type ConnectorStatus = ConnectorFailureReason | 'ok'

export type GoogleTokenStatus =
  | { ok: true; accessToken: string }
  | { ok: false; reason: ConnectorFailureReason; status?: number; error?: string }

export async function googleTokenWithStatus(
  sql: SQL,
  userId: string,
  need?: 'gmail' | 'calendar' | 'drive',
): Promise<GoogleTokenStatus> {
  const creds = googleCreds()
  const rows = await sql`
    SELECT access_token, refresh_token, expires_at, scopes FROM hire_google_tokens WHERE user_id = ${userId} LIMIT 1
  `
  const row = rows[0] as
    | { access_token: string; refresh_token: string | null; expires_at: Date | null; scopes: string | null }
    | undefined
  if (!row) return { ok: false, reason: 'not_connected' }
  if (need && !googleTokenHasScope(String(row.scopes || ''), need)) {
    return { ok: false, reason: 'not_connected' }
  }
  const exp = row.expires_at ? new Date(row.expires_at).getTime() : 0
  if (exp > Date.now() + 60_000) return { ok: true, accessToken: row.access_token }
  if (!creds || !row.refresh_token) return { ok: false, reason: 'auth_expired' }

  try {
    const res = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: creds.clientId,
        client_secret: creds.clientSecret,
        refresh_token: row.refresh_token,
        grant_type: 'refresh_token',
      }),
      signal: AbortSignal.timeout(8000),
    })
    if (!res.ok) {
      if (res.status === 400 || res.status === 401) {
        return { ok: false, reason: 'auth_expired', status: res.status }
      }
      return { ok: false, reason: 'provider_error', status: res.status }
    }
    const tok = (await res.json()) as { access_token: string; expires_in?: number }
    const expiresAt = new Date(Date.now() + (tok.expires_in || 3600) * 1000).toISOString()
    await sql`
      UPDATE hire_google_tokens
      SET access_token = ${tok.access_token}, expires_at = ${expiresAt}, updated_at = now()
      WHERE user_id = ${userId}
    `
    return { ok: true, accessToken: tok.access_token }
  } catch (err: any) {
    if (err?.name === 'AbortError' || /timeout/i.test(err?.message)) {
      return { ok: false, reason: 'timeout' }
    }
    return { ok: false, reason: 'provider_error', error: err?.message }
  }
}

export async function googleAccessToken(
  sql: SQL,
  userId: string,
  need?: 'gmail' | 'calendar' | 'drive',
): Promise<string | null> {
  const res = await googleTokenWithStatus(sql, userId, need)
  return res.ok ? res.accessToken : null
}

export async function fetchGmail(access: string, query: string, maxResults = 8): Promise<string> {
  const cap = Math.max(1, Math.min(40, maxResults))
  const listUrl = new URL('https://gmail.googleapis.com/gmail/v1/users/me/messages')
  listUrl.searchParams.set('maxResults', String(cap))
  listUrl.searchParams.set('q', query)
  const list = await fetchPublic(listUrl, { headers: { Authorization: `Bearer ${access}` } }, 4000)
  if (!list.ok) return `Gmail error ${list.status}`
  const data = (await list.json()) as { messages?: Array<{ id: string }> }
  const ids = (data.messages || []).slice(0, cap)
  const lines = (
    await Promise.all(
      ids.map(async (m) => {
        const got = await fetchPublic(
          new URL(
            `https://gmail.googleapis.com/gmail/v1/users/me/messages/${m.id}?format=metadata&metadataHeaders=Subject&metadataHeaders=From&metadataHeaders=Date`,
          ),
          { headers: { Authorization: `Bearer ${access}` } },
          3000,
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

export function startOfLocalDay(timezone: string, dayOffset = 0): Date {
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

export async function fetchCalendarItems(
  access: string,
  opts?: { timeMin?: Date; timeMax?: Date; maxResults?: number; checkSecondary?: boolean },
): Promise<{ ok: true; items: CalItem[] } | { ok: false; status: number; reason?: ConnectorFailureReason }> {
  const now = opts?.timeMin || new Date()
  const end = opts?.timeMax || new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000)
  const maxResults = opts?.maxResults || 50

  let primaryStatus = 200
  async function fetchEventsForCal(calId: string): Promise<CalItem[] | null> {
    const url = new URL(`https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calId)}/events`)
    url.searchParams.set('timeMin', now.toISOString())
    url.searchParams.set('timeMax', end.toISOString())
    url.searchParams.set('singleEvents', 'true')
    url.searchParams.set('orderBy', 'startTime')
    url.searchParams.set('conferenceDataVersion', '1')
    url.searchParams.set('maxResults', String(maxResults))
    try {
      const res = await fetch(url, {
        headers: { Authorization: `Bearer ${access}` },
        signal: AbortSignal.timeout(7000),
      })
      if (!res.ok) {
        primaryStatus = res.status
        return null
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
      return parseGoogleCalendarItems(data.items || [])
    } catch (err: any) {
      const isTimeout = err?.name === 'AbortError' || /timeout/i.test(err?.message)
      primaryStatus = isTimeout ? 504 : 502
      return null
    }
  }

  const primaryItems = await fetchEventsForCal('primary')
  if (primaryItems === null) {
    const reason: ConnectorFailureReason =
      primaryStatus === 401 ? 'auth_expired' : primaryStatus === 504 || primaryStatus === 408 ? 'timeout' : 'provider_error'
    return { ok: false, status: primaryStatus, reason }
  }

  if (opts?.checkSecondary) {
    try {
      const listRes = await fetch('https://www.googleapis.com/calendar/v3/users/me/calendarList', {
        headers: { Authorization: `Bearer ${access}` },
        signal: AbortSignal.timeout(4000),
      })
      if (listRes.ok) {
        const listData = (await listRes.json()) as { items?: Array<{ id: string; selected?: boolean; primary?: boolean }> }
        const secondaryCals = (listData.items || [])
          .filter((c) => !c.primary && c.selected && c.id)
          .slice(0, 4)
        if (secondaryCals.length > 0) {
          const extraItemsArrays = await Promise.all(secondaryCals.map((c) => fetchEventsForCal(c.id)))
          const allItems = [...primaryItems, ...extraItemsArrays.filter((x): x is CalItem[] => x !== null).flat()]
          const seen = new Set<string>()
          const deduped: CalItem[] = []
          for (const it of allItems) {
            const key = `${it.title}|${it.start.getTime()}`
            if (!seen.has(key)) {
              seen.add(key)
              deduped.push(it)
            }
          }
          deduped.sort((a, b) => a.start.getTime() - b.start.getTime())
          return { ok: true, items: deduped }
        }
      }
    } catch {
      // Fall back to primary if calendarList fails
    }
  }

  return { ok: true, items: primaryItems }
}

export function isCalendarToolResult(t: string): boolean {
  return t.startsWith('Upcoming events') || t.startsWith('No events')
}

export async function fetchCalendarViaComposio(
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
    10_000,
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

export async function loadCalendar(
  sql: SQL,
  userId: string,
  opts?: { timeMin?: Date; timeMax?: Date; maxResults?: number },
  timezone = 'America/Los_Angeles',
): Promise<string> {
  try {
    const access = await withTimeout(googleAccessToken(sql, userId, 'calendar'), 3000, null)
    if (access) {
      const got = await withTimeout(fetchCalendarItems(access, opts), 9000, null)
      if (got?.ok) return formatUpcomingEvents(got.items, timezone)
    }
  } catch {
    // fall through to the connector
  }
  return fetchCalendarViaComposio(userId, opts, timezone)
}

export function formatEmailOverview(data: unknown): string {
  return formatComposioMailBlock(parseComposioMailItems(data))
}

export function toolkitForToolSlug(tool: string): string {
  const m = /^(GMAIL|GOOGLECALENDAR|GOOGLEDRIVE|SLACK|LINEAR|NOTION|GITHUB|AIRTABLE|SERPAPI|FIRECRAWL|TWILIO)_/.exec(tool)
  if (!m) return ''
  const name = m[1]
  if (name === 'GOOGLECALENDAR') return 'googlecalendar'
  if (name === 'GOOGLEDRIVE') return 'googledrive'
  return name.toLowerCase()
}

export async function composioExecuteWithPin(
  userId: string,
  tool: string,
  args: Record<string, unknown>,
  timeoutMs = 8000,
): Promise<{ successful?: boolean; error?: unknown; data?: unknown }> {
  const composio = composioClient()
  if (!composio) throw new Error('composio not configured')
  const toolkit = toolkitForToolSlug(tool)
  const run = (connectedAccountId?: string | null) =>
    composio.tools.execute(tool, {
      userId,
      arguments: args,
      dangerouslySkipVersionCheck: true,
      ...(connectedAccountId ? { connectedAccountId } : {}),
    })
  const endAt = Date.now() + timeoutMs
  const race = <T,>(p: Promise<T>): Promise<T> => {
    const left = Math.max(250, endAt - Date.now())
    return Promise.race([
      p,
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(`Composio ${tool} timed out after ${timeoutMs}ms`)), left),
      ),
    ])
  }
  let pinned: string | null = null
  if (toolkit) {
    try {
      pinned = await Promise.race([
        composioPinnedAccountId(userId, toolkit),
        new Promise<null>((resolve) => setTimeout(() => resolve(null), 2500)),
      ])
    } catch {
      pinned = null
    }
  }
  try {
    return await race(run(pinned))
  } catch (err) {
    if (toolkit) {
      composioInvalidatePin(userId, toolkit)
      try {
        const accountId = await race(composioResolveAccountId(userId, toolkit))
        if (accountId && accountId !== pinned) return await race(run(accountId))
      } catch {
        /* budget spent — surface the original failure */
      }
    }
    throw err
  }
}

export async function composioExecuteData(
  userId: string,
  tool: string,
  args: Record<string, unknown>,
  timeoutMs = 8000,
): Promise<unknown> {
  const demo = demoComposioData(userId, tool, args)
  if (demo !== null) return demo
  try {
    const res = await composioExecuteWithPin(userId, tool, args, timeoutMs)
    if (!res?.successful || res.error) {
      console.warn(
        `[composio] ${tool} failed`,
        JSON.stringify({ error: res?.error, data: res?.data }).slice(0, 600),
      )
      return null
    }
    return res.data ?? null
  } catch (err) {
    const detail =
      err && typeof err === 'object'
        ? JSON.stringify({ message: (err as Error).message, code: (err as { code?: string }).code, data: (err as { data?: unknown }).data })
        : String(err)
    console.warn(`[composio] ${tool} threw`, detail.slice(0, 600))
    return null
  }
}

export async function composioExecute(
  userId: string,
  tool: string,
  args: Record<string, unknown>,
  timeoutMs = 8000,
): Promise<string> {
  const demo = demoComposioData(userId, tool, args)
  if (demo !== null) {
    if (tool === 'GMAIL_FETCH_EMAILS') return formatEmailOverview(demo)
    if (tool === 'GOOGLECALENDAR_EVENTS_LIST' || tool === 'GOOGLECALENDAR_FIND_EVENT') {
      return JSON.stringify({ __calItems: serializeCalItems(parseComposioCalendarData(demo)) })
    }
    const formatted = formatComposioData(demo)
    return formatted || JSON.stringify(demo ?? {}).slice(0, 4000)
  }
  try {
    const res = await composioExecuteWithPin(userId, tool, args, timeoutMs)
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

export async function composioFirst(
  userId: string,
  slugs: string[],
  args: Record<string, unknown>,
  timeoutMs = 15_000,
): Promise<string | null> {
  let last: string | null = null
  const endAt = Date.now() + timeoutMs
  for (const slug of slugs) {
    const left = endAt - Date.now()
    if (left <= 0) break
    const out = await composioExecute(userId, slug, args, Math.max(1000, left))
    if (!out) continue
    last = out
    if (!/failed/i.test(out)) return out
  }
  return last
}

export const GOOGLE_SCOPES = [
  'openid',
  'email',
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/gmail.send',
  'https://www.googleapis.com/auth/gmail.compose',
  'https://www.googleapis.com/auth/gmail.modify',
  'https://www.googleapis.com/auth/calendar.events',
  'https://www.googleapis.com/auth/drive.readonly',
].join(' ')

export const GOOGLE_READONLY_SCOPES = [
  'openid',
  'email',
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/calendar.readonly',
  'https://www.googleapis.com/auth/drive.readonly',
].join(' ')

export function googleScopesFor(readonly: boolean | string | null | undefined): string {
  return readonly === true || readonly === '1' || readonly === 'true' || readonly === 'readonly'
    ? GOOGLE_READONLY_SCOPES
    : GOOGLE_SCOPES
}

export async function runComposioPlugin(userId: string, id: string, message: string): Promise<string> {
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
export async function fetchGmailRichWithStatus(
  access: string,
  query: string,
  maxResults = 8,
): Promise<{ ok: true; items: Array<{ id: string; threadId: string; from: string; date: string; subject: string; snippet: string }> } | { ok: false; status: number; reason: ConnectorFailureReason }> {
  const cap = Math.max(1, Math.min(40, maxResults))
  const listUrl = new URL('https://gmail.googleapis.com/gmail/v1/users/me/messages')
  listUrl.searchParams.set('maxResults', String(cap))
  listUrl.searchParams.set('q', query)
  try {
    const list = await fetchPublic(listUrl, { headers: { Authorization: `Bearer ${access}` } }, 4000)
    if (!list.ok) {
      const reason: ConnectorFailureReason =
        list.status === 401 ? 'auth_expired' : list.status === 504 || list.status === 408 ? 'timeout' : 'provider_error'
      return { ok: false, status: list.status, reason }
    }
    const data = (await list.json()) as { messages?: Array<{ id: string; threadId?: string }> }
    const ids = (data.messages || []).slice(0, cap)
    const results = (
      await Promise.all(
        ids.map(async (m) => {
          const got = await fetchPublic(
            new URL(
              `https://gmail.googleapis.com/gmail/v1/users/me/messages/${m.id}?format=metadata&metadataHeaders=Subject&metadataHeaders=From&metadataHeaders=Date`,
            ),
            { headers: { Authorization: `Bearer ${access}` } },
            3000,
          )
          if (!got.ok) return null
          const msg = (await got.json()) as {
            snippet?: string
            payload?: { headers?: Array<{ name: string; value: string }> }
          }
          const headers = msg.payload?.headers || []
          const h = (n: string) => headers.find((x) => x.name.toLowerCase() === n.toLowerCase())?.value || ''
          return { id: m.id, threadId: m.threadId || '', from: h('From'), date: h('Date'), subject: h('Subject'), snippet: msg.snippet || '' }
        }),
      )
    ).filter((item): item is NonNullable<typeof item> => !!item)
    return { ok: true, items: results }
  } catch (err: any) {
    const isTimeout = err?.name === 'AbortError' || /timeout/i.test(err?.message)
    return { ok: false, status: isTimeout ? 504 : 502, reason: isTimeout ? 'timeout' : 'provider_error' }
  }
}

export async function fetchGmailRich(
  access: string,
  query: string,
  maxResults = 8,
): Promise<Array<{ id: string; threadId: string; from: string; date: string; subject: string; snippet: string }> | null> {
  const res = await fetchGmailRichWithStatus(access, query, maxResults)
  return res.ok ? res.items : null
}

/** The Gmail read slugs from the plugin spec; the first slug with a payload
 * wins. They are raced rather than awaited in order, so a second read slug (if
 * one is ever added) cannot add its latency on top of the first. */
export async function composioMailData(
  userId: string,
  args: Record<string, unknown>,
  timeoutMs = 8000,
): Promise<unknown> {
  const slugs = COMPOSIO_READ.gmail!.slugs
  if (slugs.length <= 1) return slugs[0] ? composioExecuteData(userId, slugs[0], args, timeoutMs) : null
  return await new Promise((resolve) => {
    let left = slugs.length
    for (const slug of slugs) {
      composioExecuteData(userId, slug, args, timeoutMs)
        .then((data) => {
          if (data != null) resolve(data)
          else if (--left === 0) resolve(null)
        })
        .catch(() => {
          if (--left === 0) resolve(null)
        })
    }
  })
}

/** Gmail through Composio, for accounts that connected it that way. `null` is a
 * refused read, `[]` is a query that genuinely matched nothing — the same
 * distinction the Google path makes, because conflating them is how a search
 * for "from:sam Thursday" came back with unrelated recent mail. */
export async function composioGmailRich(
  userId: string,
  query: string,
  maxResults = 8,
  timeoutMs = 8000,
): Promise<ComposioMailItem[] | null> {
  const data = await composioMailData(userId, { max_results: maxResults, query, verbose: false }, timeoutMs)
  if (data == null) return null
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
export async function composioMailBody(userId: string, msgId: string): Promise<ComposioMailBody | null> {
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
export async function composioMailHeaders(userId: string, msgId: string): Promise<ComposioMailBody | null> {
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

export function normalizeGmailQuery(raw: string): string {
  const trimmed = (raw || '').trim()
  if (!trimmed) return `newer_than:${MAIL_READ_WINDOW}`
  if (/\b(?:from:|to:|subject:|is:|label:|has:|newer_than:|older_than:|after:|before:)/i.test(trimmed)) {
    return trimmed
  }
  if (/^(?:what|any|check|read|get|pull|show|tell me about|do I have any|are there any)?\s*(?:new|unread|recent|latest|important|my)?\s*(?:e-?mails?|messages?|inbox|mail)(?:\s*(?:do I have|received|today|recently|for me))?[.?!]*$/i.test(trimmed)) {
    if (/\bunread\b/i.test(trimmed)) return `is:unread newer_than:${MAIL_READ_WINDOW}`
    if (/\bimportant\b/i.test(trimmed)) return `is:important newer_than:${MAIL_READ_WINDOW}`
    // A bare "show me my emails" covers the same window as everything else
    // rather than silently reaching back a week for the first eight.
    return `newer_than:${MAIL_READ_WINDOW}`
  }
  return trimmed
}

/**
 * The operator-only core of a Gmail query: "from:sam Thursday" -> "from:sam".
 * Gmail ANDs free-text terms with operators, so a plausible compound query
 * ("the Thursday email from Sam") can legitimately match nothing while Sam's
 * mail sits in the inbox. When the exact query is empty the caller runs this
 * one and labels the rows as a relaxation, so the assistant can honestly say
 * "no Thursday mail from Sam — here is what he did send" instead of reporting
 * that Sam never wrote. Returns '' when the query is already operator-only (no
 * relaxation) or has no operators at all (nothing to relax to).
 */
export function relaxedGmailQuery(raw: string): string {
  const parts = String(raw || '').trim().split(/\s+/).filter(Boolean)
  if (!parts.length) return ''
  const OPERATOR = /^(?:from|to|cc|bcc|subject|is|label|has|in|newer_than|older_than|after|before|filename|list|category):/i
  const ops = parts.filter((part) => OPERATOR.test(part))
  if (!ops.length || ops.length === parts.length) return ''
  return ops.join(' ')
}

/**
 * Gmail access for the read paths, with one retry after a short beat.
 *
 * A cold token refresh can outlive any wait worth putting on a page load, and
 * the request it started keeps running and writes the new row — so the second
 * look usually finds a warm token. Without the retry that race hands the whole
 * read to the connector, which spikes to 6-8s under load and then times out,
 * and the caller sees an empty inbox. Accounts with no Google row at all pay
 * one indexed lookup and nothing else.
 */
export async function gmailAccess(sql: SQL, userId: string): Promise<string | null> {
  const access = await withTimeout(googleAccessToken(sql, userId, 'gmail'), 3000, null)
  if (access) return access
  const rows = (await sql`
    SELECT 1 FROM hire_google_tokens WHERE user_id = ${userId} LIMIT 1
  `.catch(() => [])) as unknown[]
  if (!rows.length) return null
  await new Promise((resolve) => setTimeout(resolve, 600))
  return withTimeout(googleAccessToken(sql, userId, 'gmail'), 3000, null)
}

/**
 * Like loadGmail but returns structured items with Gmail message IDs. Google
 * first, then Composio for accounts connected that way — without the fallback
 * those accounts show an empty inbox on home and in the brief while Settings
 * says Gmail is connected.
 *
 * `failed` says the read itself was refused; `items: []` says the query ran and
 * genuinely matched nothing. Callers that answer a specific search need the
 * difference: an empty search must never be filled in with recent mail under
 * the search's name.
 */
export async function readGmailExact(
  sql: SQL,
  userId: string,
  query: string,
  maxResults = 8,
): Promise<{
  items: Array<{ id: string; threadId: string; from: string; date: string; subject: string; snippet: string }>
  failed: boolean
  status?: ConnectorStatus
}> {
  let knownReason: ConnectorFailureReason = 'provider_error'
  try {
    const tokenStatus = await googleTokenWithStatus(sql, userId, 'gmail')
    if (tokenStatus.ok) {
      const budget = maxResults > 10 ? 6500 : 5000
      const richRes = await withTimeout(
        fetchGmailRichWithStatus(tokenStatus.accessToken, query, maxResults),
        budget,
        { ok: false as const, status: 504, reason: 'timeout' as const },
      )
      if (richRes.ok) {
        return { items: richRes.items, failed: false, status: 'ok' }
      }
      knownReason = richRes.reason
    } else {
      knownReason = tokenStatus.reason
    }
  } catch (err: any) {
    const isTimeout = err?.name === 'AbortError' || /timeout/i.test(err?.message)
    knownReason = isTimeout ? 'timeout' : 'provider_error'
  }

  try {
    const items = await composioGmailRich(userId, query, maxResults, 8000)
    if (items !== null) {
      // Connector rows carry no Gmail thread id; the empty string keeps the
      // thread-state writers honest instead of inventing an id.
      return { items: items.map((m) => ({ ...m, threadId: '' })), failed: false, status: 'ok' }
    }
    return { items: [], failed: true, status: knownReason }
  } catch (err: any) {
    const isTimeout = err?.name === 'AbortError' || /timeout/i.test(err?.message)
    return { items: [], failed: true, status: isTimeout ? 'timeout' : knownReason }
  }
}

export async function loadGmailRich(
  sql: SQL,
  userId: string,
  query: string,
  maxResults = 8,
): Promise<Array<{ id: string; threadId: string; from: string; date: string; subject: string; snippet: string }>> {
  return (await readGmailExact(sql, userId, query, maxResults)).items
}

export async function loadGmail(sql: SQL, userId: string, query: string, maxResults = 8): Promise<string> {
  try {
    const access = await gmailAccess(sql, userId)
    if (access) {
      const out = await withTimeout(fetchGmail(access, query, maxResults), 5000, '')
      if (out && !/^Gmail error \d/.test(out)) return out
      if (out) console.warn('[gmail] google failed', out)
    }
  } catch {
    // fall through to the connector
  }
  const spec = COMPOSIO_READ.gmail!
  const out = await composioFirst(
    userId,
    spec.slugs,
    { max_results: maxResults, query, verbose: false },
    8000,
  )
  if (!out || composioLooksFailed(out)) return spec.empty
  return out
}

export async function fetchDrive(access: string, query: string): Promise<string> {
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

export async function loadDrive(sql: SQL, userId: string, query: string): Promise<string> {
  const access = await googleAccessToken(sql, userId, 'drive')
  if (access) {
    const out = await fetchDrive(access, query)
    if (!/^Drive error \d/.test(out)) return out
    console.warn('[drive] google failed', out)
  }
  return runComposioPlugin(userId, 'drive', query)
}

export type DriveFileRecord = { id: string; name: string; mimeType: string; size: number | null; webViewLink?: string }
export async function findDriveFiles(sql: SQL, userId: string, query: string): Promise<{ status: 'success_with_data' | 'success_empty' | 'not_connected' | 'auth_expired' | 'timeout' | 'provider_error' | 'malformed_response'; files: DriveFileRecord[] }> {
  const token = await googleTokenWithStatus(sql, userId, 'drive')
  if (!token.ok) return { status: token.reason, files: [] }
  const url = new URL('https://www.googleapis.com/drive/v3/files')
  url.searchParams.set('pageSize', '20'); url.searchParams.set('fields', 'files(id,name,mimeType,size,webViewLink)')
  url.searchParams.set('q', `trashed = false and name contains '${query.replace(/['\\]/g, '').slice(0, 80)}'`)
  try {
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token.accessToken}` }, signal: AbortSignal.timeout(10_000) })
    if (res.status === 401) return { status: 'auth_expired', files: [] }
    if (!res.ok) return { status: 'provider_error', files: [] }
    const data = await res.json().catch(() => null) as { files?: Array<Record<string, unknown>> } | null
    if (!data || !Array.isArray(data.files)) return { status: 'malformed_response', files: [] }
    const files = data.files.flatMap((f): DriveFileRecord[] => typeof f.id === 'string' && typeof f.name === 'string' && typeof f.mimeType === 'string' ? [{ id: f.id, name: f.name, mimeType: f.mimeType, size: f.size == null ? null : Number(f.size), ...(typeof f.webViewLink === 'string' ? { webViewLink: f.webViewLink } : {}) }] : [])
    return { status: files.length ? 'success_with_data' : 'success_empty', files }
  } catch (error) { return { status: error instanceof DOMException && error.name === 'TimeoutError' ? 'timeout' : 'provider_error', files: [] } }
}

export async function readGmailThreadExact(sql: SQL, userId: string, threadId: string): Promise<{ status: 'success_with_data' | 'success_empty' | 'not_connected' | 'auth_expired' | 'timeout' | 'provider_error' | 'malformed_response'; messages: Array<{ id: string; from: string; date: string; subject: string }> }> {
  const token = await googleTokenWithStatus(sql, userId, 'gmail')
  if (!token.ok) return { status: token.reason, messages: [] }
  try {
    const res = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/threads/${encodeURIComponent(threadId)}?format=metadata&metadataHeaders=From&metadataHeaders=Date&metadataHeaders=Subject`, { headers: { Authorization: `Bearer ${token.accessToken}` }, signal: AbortSignal.timeout(10_000) })
    if (res.status === 401) return { status: 'auth_expired', messages: [] }
    if (res.status === 404) return { status: 'success_empty', messages: [] }
    if (!res.ok) return { status: 'provider_error', messages: [] }
    const data = await res.json().catch(() => null) as { messages?: Array<{ id?: string; payload?: { headers?: Array<{ name?: string; value?: string }> } }> } | null
    if (!data || !Array.isArray(data.messages)) return { status: 'malformed_response', messages: [] }
    const messages = data.messages.flatMap((m) => {
      if (!m.id) return []
      const headers = m.payload?.headers || []; const h = (name: string) => headers.find(x => x.name?.toLowerCase() === name)?.value || ''
      return [{ id: m.id, from: h('from'), date: h('date'), subject: h('subject') }]
    })
    return { status: messages.length ? 'success_with_data' : 'success_empty', messages }
  } catch (error) { return { status: error instanceof DOMException && error.name === 'TimeoutError' ? 'timeout' : 'provider_error', messages: [] } }
}
