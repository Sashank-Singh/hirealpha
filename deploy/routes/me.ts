import type { SQL } from 'bun'
import { json } from '../utils/http'
import { normalizePhone } from '../utils/phone'
import { getUserByEmail, ensureUser } from '../db/users'
import { loadContext } from '../db/context'
import {
  loadMemories,
  syncContextMemories,
  isDurableKey,
  upsertMemories,
  getMemoryIndex,
  type MemoryRow,
} from '../memory/store'
import {
  deleteUserMemoryKey,
  ensureMemoryConsent,
} from '../../services/trust/memoryLifecycle'
import { memoryIndexStatusFromEnv } from '../../services/trust/memoryIndex'
import { loadLocations, coordsUsable } from '../db/locations'
import { timezoneFromCoords } from '../timezones'
import { PERSONAS, isPersona, type Persona } from '../personas'
import { googleCreds } from '../auth/google'
import { composioKey } from '../connectors/hub'
import { seedDefaultLoops } from '../loops/engine'
import { paymentsOn } from '../billing/stripe'
import { buildAlphaVcard } from '../../spectrum/shared/alphaContact'

export interface MeRouteOptions {
  connectedForUser: (sql: SQL, userId: string) => Promise<string[]>
  registerPhotonUser: (phone: string, name: string | null, email: string) => Promise<string | null>
  photonAssignedNumber: (phone: string) => Promise<string | null>
  enqueueIntro: (sql: SQL, phone: string, persona: Persona) => Promise<void>
  armMorningBrief: (sql: SQL, user: { id: string; timezone: string | null }, persona: Persona) => Promise<void>
  loadRoster: (sql: SQL, userId: string) => Promise<Persona[]>
  hireIsLive: (p: string) => boolean
  rememberUserTimezone: (sql: SQL, userId: string, raw: string, persona?: Persona) => Promise<string | null>
}

export async function handleMeRoutes(
  req: Request,
  sql: SQL,
  options: MeRouteOptions,
): Promise<Response | null> {
  const url = new URL(req.url)
  const path = url.pathname

  if (path === '/api/connectors/status' && req.method === 'GET') {
    return json({
      google: !!googleCreds(),
      composio: !!composioKey(),
    })
  }

  if (path === '/api/me' && req.method === 'POST') {
    const body = (await req.json().catch(() => ({}))) as { email?: string; phone?: string; name?: string; timezone?: string }
    const email = String(body.email || '')
      .trim()
      .toLowerCase()
    if (!email.includes('@')) return json({ error: 'Enter a valid email' }, 400)
    try {
      const user = await ensureUser(sql, email, body.phone, body.name, body.timezone)
      const roster = await options.loadRoster(sql, user.id)
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
    const roster = await options.loadRoster(sql, user.id)
    const context: Record<string, Record<string, string>> = {}
    const memory: Record<string, MemoryRow[]> = {}
    for (const p of roster) {
      context[p] = await loadContext(sql, user.id, p)
      memory[p] = await loadMemories(sql, user.id, p, 40)
    }
    const connected = await options.connectedForUser(sql, user.id)
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
    // when the account has one. And Photon must know this number NOW: the
    // webhook/guest path may have created the account without one, so this
    // endpoint is the guaranteed place the number meets the project.
    try {
      const assigned = await options.registerPhotonUser(phone, user.name || body.name || null, email)
      if (assigned) {
        await sql`
          UPDATE hire_users SET assigned_phone = ${assigned}, updated_at = now()
          WHERE id = ${user.id} AND (assigned_phone IS NULL OR assigned_phone <> ${assigned})
        `
      }
      const roster = await options.loadRoster(sql, user.id)
      for (const persona of roster) {
        await options.enqueueIntro(sql, phone, persona)
        await seedDefaultLoops(sql, user.id, phone, persona, user.timezone)
        await options.armMorningBrief(sql, { id: user.id, timezone: user.timezone }, persona)
      }
    } catch (err) {
      console.error('[hire] intro enqueue after phone set failed', err)
    }
    const fresh = { ...user, assignedPhone: await (async () => {
      const rows2 = (await sql`SELECT assigned_phone AS "assignedPhone" FROM hire_users WHERE id = ${user.id} LIMIT 1`) as Array<{ assignedPhone: string | null }>
      return rows2[0]?.assignedPhone ?? null
    })() }
    return json({ user: fresh })
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
    const owned = await options.loadRoster(sql, user.id)
    const ids = (body.agentIds || [])
      .filter(isPersona)
      .filter((id) => options.hireIsLive(id) || owned.includes(id))
    await sql`DELETE FROM hire_roster WHERE user_id = ${user.id}`
    for (const persona of ids) {
      await sql`
        INSERT INTO hire_roster (user_id, persona) VALUES (${user.id}, ${persona})
        ON CONFLICT (user_id, persona) DO NOTHING
      `
      // New hire on an account with a number: that hire says hi first and its
      // default morning brief arms right away (idempotent).
      if (user.phone) {
        try {
          await options.enqueueIntro(sql, user.phone, persona)
          await options.armMorningBrief(sql, { id: user.id, timezone: user.timezone }, persona)
        } catch (err) {
          console.error('[hire] intro enqueue after roster change failed', err)
        }
      }
      await ensureMemoryConsent(sql, { userId: user.id, persona, source: 'roster_change' }).catch((err: unknown) => {
        console.warn('[memory] consent grant on roster change failed', err)
      })
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
      if (geo) await options.rememberUserTimezone(sql, user.id, geo)
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
    return json({ memories: await loadMemories(sql, user.id, persona, 40), semanticMemory: memoryIndexStatusFromEnv() })
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
    return json({ ok: true, memories: await loadMemories(sql, user.id, persona, 40), semanticMemory: memoryIndexStatusFromEnv() })
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
    await deleteUserMemoryKey(sql, { userId: user.id, persona, key, index: getMemoryIndex() })
    await sql`DELETE FROM hire_memories WHERE user_id = ${user.id} AND persona = ${persona} AND key = ${key}`
    await sql`
      INSERT INTO hire_memory_tombstones (user_id, persona, key, deleted_at)
      VALUES (${user.id}, ${persona}, ${key.toLowerCase()}, now())
      ON CONFLICT (user_id, persona, key) DO UPDATE SET deleted_at = now()
    `
    return json({ ok: true, memories: await loadMemories(sql, user.id, persona, 40), semanticMemory: memoryIndexStatusFromEnv() })
  }

  /* Save-the-contact: a vCard with the name, number, and face already filled
   * in. Photo is folded base64 per RFC 6350 so Android parsers do not choke. */
  if (path === '/api/assigned-phone' && req.method === 'GET') {
    const phone = normalizePhone(url.searchParams.get('phone') || '')
    if (!phone) return json({ error: 'phone required' }, 400)
    const assigned = await options.photonAssignedNumber(phone)
    return json({ assignedPhone: assigned })
  }

  if (path === '/api/contact/alpha.vcf' && req.method === 'GET') {
    // The assigned shared line is per-user. Require the exact line Photon
    // provided; never manufacture a default or return a numberless card.
    const override = normalizePhone(url.searchParams.get('phone') || '')
    if (!override) return json({ error: 'assigned phone required' }, 400)
    const vcf = buildAlphaVcard(override)
    return new Response(vcf, {
      headers: {
        'Content-Type': 'text/vcard; charset=utf-8',
        'Content-Disposition': 'inline; filename="alpha.vcf"',
        'Cache-Control': 'public, max-age=3600',
      },
    })
  }

  /* What the marketing pages and the app need to know before they draw a
   * price: with payments off there is no price to show and no checkout to
   * open. Public on purpose — it is the same answer for everyone. */
  if (path === '/api/config' && req.method === 'GET') {
    return json({
      payments: paymentsOn(),
      free: !paymentsOn(),
      note: paymentsOn() ? null : 'Free while in beta. No card required.',
    })
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

  return null
}
