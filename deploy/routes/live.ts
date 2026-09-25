import type { SQL } from 'bun'
import { isPersona, PERSONA_DENIED, type Persona } from '../personas'
import { json } from '../utils/http'
import { getUserByPhone } from '../db/users'
import { getLocation, CURRENT_LOCATION_HOURS } from '../db/locations'
import { pickUserTimezone, timezoneFromText } from '../timezones'
import { fetchRowsForUnderstoodTrip } from '../travel/service'

/** Work connectors the model may select as a single targeted read (want=slack, want=linear, ...). */
export const WORK_READ_TOOLS: Record<string, string> = {
  slack: 'slack',
  linear: 'linear',
  github: 'github',
  notion: 'notion',
  stripe: 'stripe',
  hubspot: 'hubspot',
  plaid: 'plaid',
  quickbooks: 'quickbooks',
  intercom: 'intercom',
  salesforce: 'salesforce',
  jira: 'jira',
  sentry: 'sentry',
}

export type LiveToolWant = 'maps' | 'web' | 'gmail' | 'calendar' | 'drive' | keyof typeof WORK_READ_TOOLS

export interface LiveRouteOptions {
  internalOk: (req: Request) => boolean
  livePayload: (sql: SQL, phone: string, persona: Persona, query?: string) => Promise<any>
  loadRoster: (sql: SQL, userId: string) => Promise<Persona[]>
  connectedForUser: (sql: SQL, userId: string) => Promise<string[]>
  rememberUserTimezone: (sql: SQL, userId: string, raw: string, persona?: Persona) => Promise<any>
  runToolsForMessage: (sql: SQL, params: any) => Promise<any>
}

export async function handleLiveRoutes(
  req: Request,
  sql: SQL,
  options: LiveRouteOptions,
): Promise<Response | null> {
  const url = new URL(req.url)
  const path = url.pathname

  if (path === '/api/internal/live' && req.method === 'GET') {
    if (!options.internalOk(req)) return json({ error: 'Unauthorized' }, 401)
    const phone = url.searchParams.get('phone') || ''
    const persona = url.searchParams.get('persona') || ''
    if (!isPersona(persona)) return json({ error: 'persona required' }, 400)
    // `q` is the user's message, used only to rank recall. Absent, the payload
    // degrades to identity facts plus recency.
    const query = url.searchParams.get('q') || undefined
    // Hard budget. The payload now includes Vault-decrypted memory and live
    // connector state, either of which can stall for minutes; a hung read used
    // to hang the whole bot turn (its 12s abort turned every reply into "data
    // unavailable"). On timeout serve the identity-only shape so the turn
    // still works without memory or connector detail.
    const live = await Promise.race([
      options.livePayload(sql, phone, persona, query).catch(() => null),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 8_000)),
    ])
    if (live) return json(live)
    const user = await getUserByPhone(sql, phone).catch(() => null)
    const roster = user ? await options.loadRoster(sql, user.id).catch(() => [] as Persona[]) : []
    // Connector truth still matters in the degraded shape: saying "nothing
    // is connected" about a connected user is worse than a slow answer.
    const fallbackConnected = user
      ? await Promise.race([
          options.connectedForUser(sql, user.id).catch(() => []),
          new Promise<string[]>((resolve) => setTimeout(() => resolve([]), 2_500)),
        ])
      : []
    return json({
      found: !!user,
      hired: !!user && roster.includes(persona),
      context: {},
      connected: fallbackConnected.filter((id) => !PERSONA_DENIED[persona].has(id)),
      memories: [],
      email: user?.email ?? null,
      name: user?.name ?? null,
      timezone: user?.timezone ?? null,
      userId: user?.id ?? null,
      lastInboundAt: null,
      pro: false,
      location: null,
      degraded: true,
    })
  }

  if (path === '/api/internal/heartbeat' && req.method === 'POST') {
    if (!options.internalOk(req)) return json({ error: 'Unauthorized' }, 401)
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

  if (path === '/api/internal/live/tools' && req.method === 'POST') {
    if (!options.internalOk(req)) return json({ error: 'Unauthorized' }, 401)
    const body = (await req.json().catch(() => ({}))) as {
      phone?: string
      persona?: string
      message?: string
      want?: string
      /** What the classifier understood: airports and dates as data. The model
       * read the ask; nothing here re-guesses it from the sentence. */
      travel?: { kind?: string; from?: string; to?: string; place?: string; checkin?: string; checkout?: string; maxPrice?: number }
    }
    if (!body.phone || !body.persona || !isPersona(body.persona)) {
      return json({ error: 'phone and persona required' }, 400)
    }
    const live = await options.livePayload(sql, body.phone, body.persona)
    if (!live.found || !live.hired || !live.userId) return json({ results: [] })
    let message = body.message || ''
    if (
      body.want === 'maps' &&
      /near(?: me| us|by)?|around|where (?:should|can) we|tonight|dinner|lunch|breakfast|eat|food|restaurant|cafe|bar|coffee/i.test(message)
    ) {
      const city = live.memories.find((m: any) => m.key === 'city' && m.value)?.value
      if (city && !message.toLowerCase().includes(city.toLowerCase())) {
        // Preserve cuisine, budget, and explicit destinations. Only resolve
        // relative location words; never replace the entire request with a city.
        message = message.replace(/\b(?:near (?:me|us)|nearby|around (?:me|us|here))\b/gi, `in ${city}`)
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
      contextTz: typeof (live.context as Record<string, unknown>)?.timezone === 'string'
        ? String((live.context as Record<string, unknown>).timezone)
        : '',
      memoryTz: live.memories.find((m: any) => m.key === 'timezone')?.value,
      latitude: loc?.latitude,
      longitude: loc?.longitude,
      locationFresh: locFresh,
    })
    const spokenTz = timezoneFromText(message)
    if (spokenTz) await options.rememberUserTimezone(sql, live.userId, spokenTz, body.persona)
    const want = (
      [
        'maps',
        'web',
        'gmail',
        'calendar',
        'drive',
        ...Object.keys(WORK_READ_TOOLS),
      ] as string[]
    ).includes(body.want || '')
      ? (body.want as LiveToolWant)
      : undefined
    const understoodTrip =
      body.travel && (body.travel.kind === 'flight' || body.travel.kind === 'hotel') && (body.travel.from || body.travel.place)
        ? {
            kind: body.travel.kind as 'flight' | 'hotel',
            ...(body.travel.from ? { from: String(body.travel.from) } : {}),
            ...(body.travel.to ? { to: String(body.travel.to) } : {}),
            ...(body.travel.place ? { place: String(body.travel.place) } : {}),
            ...(body.travel.checkin ? { checkin: String(body.travel.checkin) } : {}),
            ...(body.travel.checkout ? { checkout: String(body.travel.checkout) } : {}),
            ...(Number(body.travel.maxPrice) > 0 ? { maxPrice: Number(body.travel.maxPrice) } : {}),
          }
        : null
    // The understood trip answers first; the text-driven path is the fallback,
    // for a classifier outage or a trip it did not carry.
    if (understoodTrip && (want === 'web' || want === 'maps' || want === undefined)) {
      const rows = await fetchRowsForUnderstoodTrip(sql, live.userId, understoodTrip).catch(() => [])
      if (rows.length) return json({ results: rows })
    }
    const results = await options.runToolsForMessage(sql, {
      userId: live.userId,
      persona: body.persona,
      phone: body.phone,
      message,
      connected: live.connected,
      want,
      timezone: tz,
      location: loc,
    })
    return json({ results })
  }

  return null
}
