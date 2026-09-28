import type { SQL } from 'bun'
import { json } from '../utils/http'
import { getUserByPhone } from '../db/users'
import { isPersona } from '../personas'

/**
 * Typed turn anchors: what the conversation is currently about, durable across
 * process/container restarts. One active anchor per (user, persona, kind); a
 * new anchor of the same kind replaces the old one and rows expire. Refs hold
 * provider ids only (draft id, event id, thread id, contact id) — never
 * transcript text, so this is a pointer store, not a second conversation log.
 */
export const ANCHOR_KINDS = [
  'draft',
  'event',
  'thread',
  'person',
  'browser_job',
  'reminder',
  'selection',
  'build',
  'pending_event_action',
  'pending_followup_ask',
] as const
export type AnchorKind = (typeof ANCHOR_KINDS)[number]

export const DEFAULT_ANCHOR_TTL_HOURS: Record<AnchorKind, number> = {
  draft: 48,
  event: 7 * 24,
  thread: 30 * 24,
  person: 30 * 24,
  browser_job: 24,
  reminder: 30 * 24,
  selection: 24,
  build: 30 * 24,
  pending_event_action: 1,
  pending_followup_ask: 24,
}

export type TurnAnchor = { kind: AnchorKind; ref: Record<string, unknown>; createdAt: string; expiresAt: string }

export async function setTurnAnchor(
  sql: SQL, userId: string, persona: string, kind: AnchorKind, ref: Record<string, unknown>, ttlHours?: number,
): Promise<void> {
  const ttl = ttlHours ?? DEFAULT_ANCHOR_TTL_HOURS[kind] ?? 24
  const expires = new Date(Date.now() + ttl * 3_600_000).toISOString()
  await sql`
    INSERT INTO hire_turn_anchors (id, user_id, persona, kind, ref, expires_at)
    VALUES (${crypto.randomUUID()}, ${userId}, ${persona}, ${kind}, ${JSON.stringify(ref)}::jsonb, ${expires})
    ON CONFLICT (user_id, persona, kind)
    DO UPDATE SET ref = excluded.ref, created_at = now(), expires_at = excluded.expires_at
  `
}

export async function clearTurnAnchor(sql: SQL, userId: string, persona: string, kind: AnchorKind): Promise<void> {
  await sql`DELETE FROM hire_turn_anchors WHERE user_id = ${userId} AND persona = ${persona} AND kind = ${kind}`
}

export async function listTurnAnchors(sql: SQL, userId: string, persona: string): Promise<TurnAnchor[]> {
  await sql`DELETE FROM hire_turn_anchors WHERE expires_at < now()`
  const rows = await sql`
    SELECT kind, ref, created_at AS "createdAt", expires_at AS "expiresAt"
    FROM hire_turn_anchors
    WHERE user_id = ${userId} AND persona = ${persona}
    ORDER BY created_at DESC
  `
  return rows.map((r: Record<string, unknown>) => {
    const row = r as unknown as { kind: AnchorKind; ref: unknown; createdAt: Date; expiresAt: Date }
    return {
      kind: row.kind,
      ref: (row.ref && typeof row.ref === 'object' ? row.ref : {}) as Record<string, unknown>,
      createdAt: row.createdAt.toISOString(),
      expiresAt: row.expiresAt.toISOString(),
    }
  })
}

export interface AnchorRouteOptions {
  internalOk: (r: Request) => boolean
}

export async function handleAnchorRoutes(req: Request, sql: SQL, options: AnchorRouteOptions): Promise<Response | null> {
  const url = new URL(req.url)
  const path = url.pathname
  if (path !== '/api/internal/anchors') return null

  if (req.method === 'POST') {
    if (!options.internalOk(req)) return json({ error: 'Unauthorized' }, 401)
    const body = (await req.json().catch(() => ({}))) as { phone?: string; persona?: string; kind?: string; ref?: Record<string, unknown>; ttlHours?: number }
    if (!body.phone || !isPersona(body.persona || '') || !body.kind || !ANCHOR_KINDS.includes(body.kind as AnchorKind)) {
      return json({ error: 'phone, persona, and a known anchor kind required' }, 400)
    }
    const user = await getUserByPhone(sql, body.phone)
    if (!user) return json({ error: 'User not found' }, 404)
    await setTurnAnchor(sql, user.id, body.persona!, body.kind as AnchorKind, body.ref && typeof body.ref === 'object' ? body.ref : {}, body.ttlHours)
    return json({ ok: true })
  }

  if (req.method === 'GET') {
    if (!options.internalOk(req)) return json({ error: 'Unauthorized' }, 401)
    const user = await getUserByPhone(sql, url.searchParams.get('phone') || '')
    if (!user) return json({ error: 'User not found' }, 404)
    const persona = url.searchParams.get('persona') || ''
    if (!isPersona(persona)) return json({ error: 'persona required' }, 400)
    return json({ ok: true, anchors: await listTurnAnchors(sql, user.id, persona) })
  }

  if (req.method === 'DELETE') {
    if (!options.internalOk(req)) return json({ error: 'Unauthorized' }, 401)
    const body = (await req.json().catch(() => ({}))) as { phone?: string; persona?: string; kind?: string }
    if (!body.phone || !isPersona(body.persona || '') || !body.kind || !ANCHOR_KINDS.includes(body.kind as AnchorKind)) {
      return json({ error: 'phone, persona, and a known anchor kind required' }, 400)
    }
    const user = await getUserByPhone(sql, body.phone)
    if (!user) return json({ error: 'User not found' }, 404)
    await clearTurnAnchor(sql, user.id, body.persona!, body.kind as AnchorKind)
    return json({ ok: true })
  }

  return null
}
