import type { SQL } from 'bun'
import { getUserByPhone } from '../db/users'
import { buildReceipt, canTransition, parseCompletionEvidence, type CompletionKind, type CompletionState } from '../../spectrum/shared/completion'

/**
 * Canonical completion ledger — one durable row per delegated external
 * operation. The state machine lives in spectrum/shared/completion.ts; this
 * route enforces transitions against the DB row, stores receipts, exposes the
 * "what are you still working on?" dashboard query, and performs
 * exactly-once create (unique target_key per active operation).
 */

export type CompletionDeps = { internalOk: (req: Request) => boolean }

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

const KINDS: CompletionKind[] = ['subscription_cancel', 'reservation', 'check_in']

export async function handleCompletionRoutes(req: Request, sql: SQL | null | undefined, deps: CompletionDeps): Promise<Response | null> {
  const url = new URL(req.url)
  const path = url.pathname
  if (path !== '/api/internal/completions' && !path.startsWith('/api/internal/completions/')) return null
  if (!deps.internalOk(req)) return json({ error: 'Unauthorized' }, 401)
  if (!sql) return json({ ok: false, error: 'Database unavailable' }, 503)

  const body = req.method === 'POST' || req.method === 'PATCH'
    ? (await req.json().catch(() => ({}))) as Record<string, unknown> : {}
  const phone = String(body.phone || url.searchParams.get('phone') || '')
  const persona = String(body.persona || url.searchParams.get('persona') || 'friend')

  const user = phone ? await getUserByPhone(sql, phone) : null
  if (phone && !user) return json({ ok: false, error: 'User not found' }, 404)

  /* POST — idempotent create. Same (user, persona, kind, target) while an
   * operation is active returns the SAME row (exactly-once create). */
  if (req.method === 'POST') {
    if (!user) return json({ ok: false, error: 'phone required' }, 400)
    const kind = String(body.kind || '') as CompletionKind
    const target = String(body.target || '').trim()
    if (!KINDS.includes(kind)) return json({ ok: false, error: 'kind required' }, 400)
    if (!target) return json({ ok: false, error: 'target required' }, 400)
    const targetKey = target.toLowerCase().slice(0, 120)
    const existing = await sql`
      SELECT * FROM hire_completions
      WHERE user_id = ${user.id} AND persona = ${persona} AND kind = ${kind} AND target_key = ${targetKey}
        AND state NOT IN ('completed', 'failed', 'cancelled')
      ORDER BY created_at DESC LIMIT 1`
    if (existing.length) return json({ ok: true, completion: rowOut(existing[0]), duplicate: true })
    const rows = await sql`
      INSERT INTO hire_completions (user_id, persona, kind, target, target_key, requested_terms, state)
      VALUES (${user.id}, ${persona}, ${kind}, ${target.slice(0, 200)}, ${targetKey},
              ${JSON.stringify(body.requested_terms || {})}::jsonb, 'pending')
      RETURNING *`
    return json({ ok: true, completion: rowOut(rows[0]) })
  }

  if (req.method === 'PATCH') {
    const id = String(body.id || '')
    if (!id || !user) return json({ ok: false, error: 'id and phone required' }, 400)
    const rows = await sql`
      SELECT * FROM hire_completions WHERE id = ${id} AND user_id = ${user.id} LIMIT 1`
    const row = rows[0]
    if (!row) return json({ ok: false, error: 'Completion not found' }, 404)
    const current = String(row.state) as CompletionState

    const action = String(body.action || 'transition')

    /* Re-verify: parse fresh executor/provider output and move the state. */
    if (action === 'verify') {
      const kind = String(row.kind) as CompletionKind
      const observed = String(body.observed || '')
      const evidence = parseCompletionEvidence(kind, observed, String(row.target || ''))
      await sql`
        UPDATE hire_completions SET attempt_count = attempt_count + 1, updated_at = now()
        WHERE id = ${id} AND user_id = ${user.id}`
      if (!evidence) {
        const next = canTransition(current, 'outcome_unknown') ? 'outcome_unknown' : current
        if (next !== current) {
          await sql`UPDATE hire_completions SET state = ${next}, blocker = NULL, updated_at = now() WHERE id = ${id} AND user_id = ${user.id}`
        }
        return json({ ok: true, state: next, verified: false, evidence: null })
      }
      if (evidence.type === 'retention_offer') {
        const next = canTransition(current, 'needs_authorization') ? 'needs_authorization' : current
        if (next !== current) {
          await sql`UPDATE hire_completions SET state = ${next}, blocker = ${JSON.stringify({ type: 'retention_offer', offer: evidence.retentionOffer || '', message: evidence.summary })}::jsonb, updated_at = now() WHERE id = ${id} AND user_id = ${user.id}`
        }
        return json({ ok: true, state: next, verified: false, retentionOffer: evidence.retentionOffer || evidence.summary })
      }
      if (evidence.type === 'none') {
        const blockerText = evidence.summary.startsWith('blocked:') ? evidence.summary.slice(8).trim() : ''
        if (blockerText && canTransition(current, 'executing')) {
          await sql`UPDATE hire_completions SET state = 'executing', blocker = ${JSON.stringify({ type: blockerText, message: evidence.summary })}::jsonb, updated_at = now() WHERE id = ${id} AND user_id = ${user.id}`
          return json({ ok: true, state: 'executing', verified: false, blocker: blockerText })
        }
        return json({ ok: true, state: current, verified: false, blocker: blockerText || null })
      }
      /* Completion-grade evidence: only now may the state become completed.
       * Transitions through verification_pending keep the machine honest even
       * when the executor skipped it. */
      const receipt = buildReceipt({ kind, status: 'completed', evidence, resultSummary: evidence.summary, verifiedAt: new Date().toISOString() })
      await sql`
        UPDATE hire_completions SET state = 'completed', verification = ${JSON.stringify(evidence)}::jsonb,
          receipt = ${JSON.stringify(receipt)}::jsonb, external_object_id = ${evidence.confirmationNumber || null},
          result_summary = ${evidence.summary.slice(0, 400)}, updated_at = now()
        WHERE id = ${id} AND user_id = ${user.id}`
      return json({ ok: true, state: 'completed', verified: true, receipt })
    }

    /* Generic guarded transition (execute / authorize / cancel / fail …). */
    const to = String(body.state || '') as CompletionState
    if (!to) return json({ ok: false, error: 'state or action required' }, 400)
    if (!canTransition(current, to)) {
      return json({ ok: false, state: current, error: `Illegal transition ${current} → ${to}` }, 409)
    }
    await sql`
      UPDATE hire_completions SET state = ${to},
        executor = ${body.executor ? String(body.executor) : null},
        executor_id = ${body.executor_id ? String(body.executor_id) : null},
        blocker = ${body.blocker ? JSON.stringify(body.blocker) : null},
        updated_at = now()
      WHERE id = ${id} AND user_id = ${user.id}`
    return json({ ok: true, state: to })
  }

  /* GET — one completion, or the active dashboard ("what are you still working on?"). */
  if (!user) return json({ ok: false, error: 'phone required' }, 400)
  const rows = await sql`
    SELECT id, kind, target, state, blocker, result_summary, started_at, updated_at
    FROM hire_completions WHERE user_id = ${user.id} AND persona = ${persona}
    ORDER BY updated_at DESC LIMIT 20` as Array<Record<string, unknown>>
  return json({
    ok: true,
    completions: rows.map((r) => ({
      id: String(r.id), kind: r.kind, target: r.target, state: r.state,
      blocker: r.blocker ?? null, result_summary: r.result_summary ?? null, updatedAt: r.updated_at,
    })),
  })
}

function rowOut(row: Record<string, unknown>) {
  return {
    id: String(row.id), kind: row.kind, target: row.target, state: row.state,
    blocker: row.blocker ?? null, receipt: row.receipt ?? null,
    attemptCount: row.attempt_count, updatedAt: row.updated_at,
  }
}
