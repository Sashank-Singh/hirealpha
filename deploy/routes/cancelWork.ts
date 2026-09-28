import type { SQL } from 'bun'
import { getUserByPhone } from '../db/users'

/**
 * Durable-work cancellation routes — one typed surface for the whole
 * cancellation state model:
 *
 *   cancelled_before_execution   the durable row was never dispatched; cancel
 *                                is authoritative and complete.
 *   cancellation_requested       the operation was already dispatched; the
 *                                cancel row is written but the worker may have
 *                                committed steps before seeing it. Never
 *                                reported as a confirmed cancel.
 *   already_completed            the operation finished; nothing to cancel.
 *   not_cancellable              no such operation exists (or terminal state).
 *   outcome_unknown              the cancel write itself could not be read
 *                                back; never claim either way.
 *
 * Every route is internal-key guarded, phone-bound, and returns the prior
 * status so the engine can report exactly what it changed.
 */

type CancelState =
  | 'cancelled_before_execution'
  | 'cancellation_requested'
  | 'already_completed'
  | 'not_cancellable'
  | 'outcome_unknown'

export type CancelWorkDeps = {
  internalOk: (req: Request) => boolean
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

const ACTIVE_JOB_STATES = ['pending', 'queued', 'running', 'waiting', 'preparing', 'sending']

export async function handleCancelWorkRoutes(
  req: Request,
  sql: SQL | null | undefined,
  deps: CancelWorkDeps,
): Promise<Response | null> {
  const url = new URL(req.url)
  const path = url.pathname
  if (path !== '/api/internal/work/cancel') return null
  if (!deps.internalOk(req)) return json({ error: 'Unauthorized' }, 401)
  if (!sql) return json({ ok: false, state: 'outcome_unknown', error: 'Database unavailable' }, 503)
  const body = (await req.json().catch(() => ({}))) as {
    phone?: string
    persona?: string
    kind?: 'browser' | 'watch' | 'followup' | 'scheduled_text' | 'all'
    kinds?: Array<'browser' | 'watch' | 'followup' | 'scheduled_text'>
    id?: string
  }
  const kinds: string[] = body.kinds?.length ? body.kinds : body.kind && body.kind !== 'all' ? [body.kind] : ['browser', 'watch', 'followup', 'scheduled_text']
  if (!body.phone) return json({ ok: false, state: 'outcome_unknown', error: 'phone required' }, 400)
  const user = await getUserByPhone(sql, body.phone)
  if (!user) return json({ ok: false, state: 'outcome_unknown', error: 'User not found' }, 404)
  const results: Array<{ target: string; id: string | null; state: CancelState; priorStatus?: string | null }> = []

  const report = (target: string, id: string | null, state: CancelState, priorStatus?: string | null) =>
    results.push({ target, id, state, priorStatus: priorStatus ?? null })

  /* Browser jobs. 'pending' never reached a worker → authoritative cancel.
   * Dispatched states → row is cancelled but the worker may have committed:
   * cancellation_requested, never a plain "cancelled". */
  if (kinds.includes('browser')) {
    if (body.id) {
      const rows = await sql`
        UPDATE hire_browser_jobs SET status = 'failed', error = 'Cancelled by user', finished_at = now()
        WHERE id = ${body.id} AND user_id = ${user.id} AND status IN ('pending', 'queued', 'running', 'waiting', 'preparing', 'sending')
        RETURNING id, status`
      report('browser', body.id, rows.length ? 'cancelled_before_execution' : 'not_cancellable')
    } else {
      const rows = (await sql`
        SELECT id, status FROM hire_browser_jobs
        WHERE user_id = ${user.id}
        ORDER BY created_at DESC LIMIT 1`) as Array<{ id: string; status: string }>
      const row = rows[0]
      if (!row) report('browser', null, 'not_cancellable')
      else if (row.status === 'succeeded') report('browser', row.id, 'already_completed', row.status)
      else if (!ACTIVE_JOB_STATES.includes(row.status)) report('browser', row.id, 'not_cancellable', row.status)
      else {
        const prior = row.status
        const wasQueued = prior === 'pending' || prior === 'queued'
        await sql`
          UPDATE hire_browser_jobs SET status = 'failed', error = 'Cancelled by user', finished_at = now()
          WHERE id = ${row.id} AND user_id = ${user.id}`
        report('browser', row.id, wasQueued ? 'cancelled_before_execution' : 'cancellation_requested', prior)
      }
    }
  }

  /* Watch loops (hire_task_loops kind = 'watch:<id>' with a watch payload). */
  if (kinds.includes('watch')) {
    const rows = body.id
      ? (await sql`
          SELECT id, status FROM hire_task_loops
          WHERE id = ${body.id} AND user_id = ${user.id} AND kind LIKE 'watch:%' LIMIT 1`) as Array<{ id: string; status: string }>
      : (await sql`
          SELECT id, status FROM hire_task_loops
          WHERE user_id = ${user.id} AND kind LIKE 'watch:%' AND status IN ('pending', 'running')
          ORDER BY created_at DESC LIMIT 1`) as Array<{ id: string; status: string }>
    const row = rows[0]
    if (!row) report('watch', body.id ?? null, 'not_cancellable')
    else if (row.status === 'done') report('watch', row.id, 'already_completed', row.status)
    else {
      const prior = row.status
      await sql`UPDATE hire_task_loops SET status = 'cancelled', updated_at = now() WHERE id = ${row.id} AND user_id = ${user.id}`
      report('watch', row.id, prior === 'running' ? 'cancellation_requested' : 'cancelled_before_execution', prior)
    }
  }

  /* Email follow-up watches. */
  if (kinds.includes('followup')) {
    const rows = (await sql`
      SELECT id, status FROM hire_email_followups
      WHERE user_id = ${user.id} AND status = 'pending'
      ORDER BY created_at DESC LIMIT 1`) as Array<{ id: string; status: string }>
    const row = rows[0]
    if (!row) report('followup', null, 'not_cancellable')
    else {
      await sql`UPDATE hire_email_followups SET status = 'cancelled', updated_at = now() WHERE id = ${row.id} AND user_id = ${user.id}`
      report('followup', row.id, 'cancelled_before_execution', row.status)
    }
  }

  /* Scheduled texts: a pending row never left; preparing/sending may already
   * be in flight, so the cancel is a request whose outcome needs checking. */
  if (kinds.includes('scheduled_text')) {
    const rows = (await sql`
      SELECT id, status FROM hire_scheduled_texts
      WHERE user_id = ${user.id} AND status IN ('pending', 'preparing', 'sending')
      ORDER BY send_at ASC LIMIT 1`) as Array<{ id: string; status: string }>
    const row = rows[0]
    if (!row) report('scheduled_text', null, 'not_cancellable')
    else {
      const prior = row.status
      await sql`UPDATE hire_scheduled_texts SET status = 'cancelled', updated_at = now() WHERE id = ${row.id} AND user_id = ${user.id}`
      report('scheduled_text', row.id, prior === 'pending' ? 'cancelled_before_execution' : 'cancellation_requested', prior)
    }
  }

  return json({ ok: true, results })
}
