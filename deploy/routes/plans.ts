import type { SQL } from 'bun'
import { getUserByPhone } from '../db/users'

/**
 * Durable plans — the smallest representation that survives restarts and does
 * not depend on chat history:
 *
 *   goal          what the user asked for, in their words
 *   steps         ordered subtasks, each { text, state: pending|done|failed|blocked }
 *   operationIds  external artifact ids per step (draft/job/reminder ids)
 *   blocker       what currently stops progress (typed, not narrated)
 *   nextAction    the next step to take
 *   status        active | done | cancelled
 *
 * The engine reads the plan at turn start and injects its state into the
 * prompt; the `plan` capability lets the model mark steps done/failed/block as
 * receipts land. Nothing is reconstructed from the transcript.
 */

export type PlanStep = { text: string; state: 'pending' | 'done' | 'failed' | 'blocked' }

export type PlanRow = {
  id: string
  goal: string
  persona: string
  status: string
  blocker: string | null
  nextAction: string | null
  steps: PlanStep[]
  operationIds: Record<string, string>
  updatedAt: string
}

export type PlanDeps = {
  internalOk: (req: Request) => boolean
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

function normalizeSteps(raw: unknown): PlanStep[] {
  if (!Array.isArray(raw)) return []
  return (raw as Array<string | PlanStep>).map((item) =>
    typeof item === 'string'
      ? { text: item, state: 'pending' as const }
      : { text: String(item?.text || ''), state: item?.state === 'done' ? 'done' as const : item?.state === 'failed' ? 'failed' as const : item?.state === 'blocked' ? 'blocked' as const : 'pending' as const },
  ).filter((s) => s.text)
}

function rowToPlan(row: Record<string, unknown> | undefined): PlanRow | null {
  if (!row) return null
  return {
    id: String(row.id),
    goal: String(row.goal),
    persona: String(row.persona),
    status: String(row.status),
    blocker: (row.blocker as string | null) ?? null,
    nextAction: (row.next_action as string | null) ?? null,
    steps: Array.isArray(row.steps) ? (row.steps as PlanStep[]) : [],
    operationIds: (row.operation_ids as Record<string, string>) || {},
    updatedAt: String(row.updated_at),
  }
}

export async function handlePlanRoutes(req: Request, sql: SQL | null | undefined, deps: PlanDeps): Promise<Response | null> {
  const url = new URL(req.url)
  const path = url.pathname
  if (path !== '/api/internal/plans') return null
  if (!deps.internalOk(req)) return json({ error: 'Unauthorized' }, 401)
  if (!sql) return json({ ok: false, error: 'Database unavailable' }, 503)

  const body = req.method === 'POST' || req.method === 'PATCH'
    ? (await req.json().catch(() => ({}))) as Record<string, unknown> : {}
  const phone = String(body.phone || url.searchParams.get('phone') || '')
  const persona = String(body.persona || url.searchParams.get('persona') || 'friend')

  if (req.method === 'POST') {
    if (!phone) return json({ ok: false, error: 'phone required' }, 400)
    const goal = String(body.goal || '').trim()
    if (!goal) return json({ ok: false, error: 'goal required' }, 400)
    const user = await getUserByPhone(sql, phone)
    if (!user) return json({ ok: false, error: 'User not found' }, 404)
    const steps = normalizeSteps(body.steps)
    const nextAction = body.nextAction ? String(body.nextAction).slice(0, 300) : (steps.find((s) => s.state === 'pending')?.text ?? null)
    const rows = await sql`
      INSERT INTO hire_plans (user_id, persona, goal, steps, blocker, next_action, operation_ids)
      VALUES (${user.id}, ${persona}, ${goal.slice(0, 400)}, ${JSON.stringify(steps)}::jsonb,
              ${body.blocker ? String(body.blocker).slice(0, 300) : null},
              ${nextAction},
              ${JSON.stringify(body.operationIds || {})}::jsonb)
      ON CONFLICT (user_id, persona, goal) DO UPDATE
        SET steps = EXCLUDED.steps, blocker = EXCLUDED.blocker, next_action = EXCLUDED.next_action,
            status = 'active', updated_at = now()
      RETURNING id, goal, persona, status, blocker, next_action, steps, operation_ids, updated_at`
    return json({ ok: true, plan: rowToPlan(rows[0]) })
  }

  if (req.method === 'PATCH') {
    const planId = String(body.id || '')
    if (!phone || !planId) return json({ ok: false, error: 'phone and id required' }, 400)
    const user = await getUserByPhone(sql, phone)
    if (!user) return json({ ok: false, error: 'User not found' }, 404)
    if (Array.isArray(body.steps)) {
      await sql`UPDATE hire_plans SET steps = ${JSON.stringify(normalizeSteps(body.steps))}::jsonb, updated_at = now() WHERE id = ${planId} AND user_id = ${user.id}`
    }
    if (typeof body.blocker === 'string') {
      await sql`UPDATE hire_plans SET blocker = ${body.blocker.slice(0, 300)}, updated_at = now() WHERE id = ${planId} AND user_id = ${user.id}`
    }
    if (typeof body.nextAction === 'string') {
      await sql`UPDATE hire_plans SET next_action = ${body.nextAction.slice(0, 300)}, updated_at = now() WHERE id = ${planId} AND user_id = ${user.id}`
    }
    if (typeof body.status === 'string' && ['active', 'done', 'cancelled'].includes(body.status)) {
      await sql`UPDATE hire_plans SET status = ${body.status}, updated_at = now() WHERE id = ${planId} AND user_id = ${user.id}`
    }
    if (body.operationIds && typeof body.operationIds === 'object') {
      await sql`UPDATE hire_plans SET operation_ids = ${JSON.stringify(body.operationIds)}::jsonb, updated_at = now() WHERE id = ${planId} AND user_id = ${user.id}`
    }
    const rows = await sql`
      SELECT id, goal, persona, status, blocker, next_action, steps, operation_ids, updated_at
      FROM hire_plans WHERE id = ${planId} AND user_id = ${user.id} LIMIT 1`
    if (!rows.length) return json({ ok: false, error: 'Plan not found' }, 404)
    return json({ ok: true, plan: rowToPlan(rows[0]) })
  }

  // GET: latest plan for the phone+persona — the turn's rehydration read.
  if (!phone) return json({ ok: false, error: 'phone required' }, 400)
  const user = await getUserByPhone(sql, phone)
  if (!user) return json({ ok: false, error: 'User not found' }, 404)
  const rows = await sql`
    SELECT id, goal, persona, status, blocker, next_action, steps, operation_ids, updated_at
    FROM hire_plans WHERE user_id = ${user.id} AND persona = ${persona}
    ORDER BY (status = 'active') DESC, updated_at DESC LIMIT 1`
  return json({ ok: true, plan: rows.length ? rowToPlan(rows[0]) : null })
}
