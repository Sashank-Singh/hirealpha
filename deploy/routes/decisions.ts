import type { SQL } from 'bun'
import { json } from '../utils/http'
import { resolveAuthedUser } from '../auth/session'
import { getUserByPhone } from '../db/users'
import { isPersona } from '../personas'
import { parseFlexibleWhen } from '../timezones'
import { parseDecisionText } from '../habits/parsers'

export interface DecisionRouteOptions {
  internalOk: (r: Request) => boolean
}

export async function handleDecisionRoutes(
  req: Request,
  sql: SQL,
  options: DecisionRouteOptions,
): Promise<Response | null> {
  const url = new URL(req.url)
  const path = url.pathname

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
    const { user, error } = await resolveAuthedUser(sql, { token: body.token, session: (body as { session?: string }).session, email: body.email })
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
    const { user, error } = await resolveAuthedUser(sql, { token: body.token, session: (body as { session?: string }).session, email: body.email })
    if (error) return error
    await sql`
      UPDATE hire_decisions
      SET outcome = ${String(body.outcome || '').slice(0, 500)},
          status = 'reviewed', updated_at = now()
      WHERE id = ${id} AND user_id = ${user!.id}
    `
    return json({ ok: true })
  }

  if (path === '/api/internal/decisions' && req.method === 'POST') {
    if (!options.internalOk(req)) return json({ error: 'Unauthorized' }, 401)
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

  return null
}
