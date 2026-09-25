import type { SQL } from 'bun'
import { json } from '../utils/http'
import { normalizePhone } from '../utils/phone'
import { getUserByPhone } from '../db/users'
import { isPersona } from '../personas'
import { resolveAuthedUser } from '../auth/session'

async function openTodos(sql: SQL, userId: string): Promise<Array<{ id: string; text: string }>> {
  const rows = await sql`
    SELECT id::text AS id, text FROM hire_todos
    WHERE user_id = ${userId} AND done = false
    ORDER BY created_at DESC LIMIT 20
  `
  return rows as Array<{ id: string; text: string }>
}

export async function handleTaskRoutes(
  req: Request,
  sql: SQL,
  options: { internalOk: (r: Request) => boolean },
): Promise<Response | null> {
  const url = new URL(req.url)
  const path = url.pathname

  // Canonical task record readers (internal ops/debug only). The mirror writes
  // behind HIREALPHA_TASK_RECORD; these are how a run is verified from outside
  // the box, so the task trail is never a black box during Phase 1 dogfooding.
  if (path === '/api/internal/tasks' && req.method === 'GET') {
    if (!options.internalOk(req)) return json({ error: 'Unauthorized' }, 401)
    const { listTasksForAdmin } = await import('../../services/tasks/taskStore')
    const userId = url.searchParams.get('userId')
    const limit = Number(url.searchParams.get('limit')) || undefined
    const tasks = await listTasksForAdmin(sql, { userId: userId || null, limit })
    return json({ tasks })
  }

  if (path === '/api/internal/tasks/events' && req.method === 'GET') {
    if (!options.internalOk(req)) return json({ error: 'Unauthorized' }, 401)
    const taskId = url.searchParams.get('taskId') || ''
    const userId = url.searchParams.get('userId') || ''
    if (!taskId || !userId) return json({ error: 'taskId and userId required' }, 400)
    const { listEvents } = await import('../../services/tasks/taskStore')
    const afterSeq = Number(url.searchParams.get('afterSeq')) || 0
    const events = await listEvents(sql, { userId, taskId, afterSeq, limit: 500 })
    return json({ events })
  }

  // ── Numbered-choice surface (beat-instinct P1): offer publishes research
  // results as cards on a fresh task; open/choose resolve a bare reply like
  // "2" against the live selection. The bot calls proposeBrowserTask itself
  // with the returned option+goal, so the approval/auto-launch policy stays
  // in exactly one place. All state lives in hire_tasks - nothing here
  // guesses from prose; turnPath.interpretChoice returns 'ask-classifier'
  // for anything that is not the number grammar.
  if (path === '/api/internal/tasks/offer' && req.method === 'POST') {
    if (!options.internalOk(req)) return json({ error: 'Unauthorized' }, 401)
    const body = (await req.json().catch(() => ({}))) as {
      phone?: string; persona?: string; heading?: string; candidates?: unknown
    }
    if (!body.phone || !isPersona(body.persona || '') || !body.heading || !Array.isArray(body.candidates)) {
      return json({ error: 'phone, persona, heading, candidates[] required' }, 400)
    }
    const user = await getUserByPhone(sql, body.phone)
    if (!user) return json({ ok: false, error: 'no user for phone' }, 404)
    const heading = String(body.heading).slice(0, 300)
    const { createTask, appendEvent } = await import('../../services/tasks/taskStore')
    const { offerChoices } = await import('../../services/tasks/turnPath')
    const task = await createTask(sql, { userId: user.id, persona: body.persona, conversationId: body.phone, request: heading })
    let offer: Awaited<ReturnType<typeof offerChoices>> | null = null
    try {
      await appendEvent(sql, { userId: user.id, taskId: task.id, type: 'state_changed', payload: { to: 'RESEARCHING' }, actor: 'alpha', idempotencyKey: 'offer:researching' })
      offer = await offerChoices(sql, { userId: user.id, taskId: task.id, heading, candidates: body.candidates as never, now: new Date() })
    } catch (err) {
      await appendEvent(sql, { userId: user.id, taskId: task.id, type: 'state_changed', payload: { to: 'CANCELLED' }, actor: 'alpha', idempotencyKey: 'offer:error-cancel' }).catch(() => undefined)
      return json({ ok: false, error: err instanceof Error ? err.message.slice(0, 300) : 'offer failed' })
    }
    if (!offer.published) {
      // Nothing legal survived provenance checks: cancel the shell task so it
      // never dangles in RESEARCHING, and let the caller fall back to prose.
      await appendEvent(sql, { userId: user.id, taskId: task.id, type: 'state_changed', payload: { to: 'CANCELLED' }, actor: 'alpha', idempotencyKey: 'offer:empty-cancel' }).catch(() => undefined)
      return json({ ok: false, noCards: true, dropped: offer.dropped })
    }
    return json({ ok: true, taskId: task.id, rendered: offer.rendered, dropped: offer.dropped })
  }

  if (path === '/api/internal/tasks/open' && req.method === 'GET') {
    if (!options.internalOk(req)) return json({ error: 'Unauthorized' }, 401)
    const phone = url.searchParams.get('phone') || ''
    const persona = url.searchParams.get('persona') || ''
    if (!phone || !isPersona(persona)) return json({ error: 'phone and persona required' }, 400)
    const user = await getUserByPhone(sql, phone)
    if (!user) return json({ tasks: [] })
    const { listTasksForAdmin, loadProjection } = await import('../../services/tasks/taskStore')
    const rows = (await listTasksForAdmin(sql, { userId: user.id, limit: 10 })).filter((t) => t.persona === persona && t.state === 'WAITING_FOR_SELECTION')
    const out: unknown[] = []
    for (const t of rows.slice(0, 3)) {
      const projection = await loadProjection(sql, { userId: user.id, taskId: t.id })
      if (!projection || projection.state !== 'WAITING_FOR_SELECTION') continue
      out.push({
        taskId: t.id,
        heading: t.request,
        updatedAt: t.updated_at,
        options: projection.options.filter((o) => !o.rejected && o.available !== false)
          .map((o) => ({ id: o.id, title: o.title, price_cents: o.price_cents ?? null, source_url: o.source_url ?? null })),
      })
    }
    return json({ tasks: out })
  }

  if (path === '/api/internal/tasks/choose' && req.method === 'POST') {
    if (!options.internalOk(req)) return json({ error: 'Unauthorized' }, 401)
    const body = (await req.json().catch(() => ({}))) as {
      phone?: string; persona?: string; reply?: string; taskId?: string
    }
    if (!body.phone || !isPersona(body.persona || '') || !body.reply) return json({ error: 'phone, persona, reply required' }, 400)
    const user = await getUserByPhone(sql, body.phone)
    if (!user) return json({ ok: false, reason: 'no-user' })
    const { listTasksForAdmin, loadProjection } = await import('../../services/tasks/taskStore')
    const { interpretChoice } = await import('../../services/tasks/turnPath')
    const { selectOption, handOffToExecutor } = await import('../../services/tasks/choiceTurns')
    const candidates = (await listTasksForAdmin(sql, { userId: user.id, limit: 10 }))
      .filter((t) => t.persona === body.persona && t.state === 'WAITING_FOR_SELECTION' && (!body.taskId || t.id === body.taskId))
    const pick = candidates[0]
    if (!pick) return json({ ok: false, reason: 'no-open-choice' })
    const projection = await loadProjection(sql, { userId: user.id, taskId: pick.id })
    if (!projection) return json({ ok: false, reason: 'no-open-choice' })
    const verdict = interpretChoice(projection, String(body.reply), { now: new Date() })
    if (verdict.kind === 'ask-classifier') return json({ ok: false, reason: 'prose', taskId: pick.id })
    if (verdict.kind === 'stale') return json({ ok: false, reason: 'stale', taskId: pick.id, optionId: verdict.optionId })
    const chosen = projection.options.find((o) => o.id === verdict.optionId)
    if (!chosen?.source_url) return json({ ok: false, reason: 'no-source', taskId: pick.id })
    const selected = await selectOption(sql, { userId: user.id, taskId: pick.id, reply: String(body.reply), actor: 'user', now: new Date() })
    if (selected.outcome !== 'selected') return json({ ok: false, reason: selected.outcome, taskId: pick.id })
    await handOffToExecutor(sql, { userId: user.id, taskId: pick.id, enqueue: async () => 'pending-propose', actor: 'user' }).catch((err) =>
      console.warn('[tasks/choose] handoff marker failed', err instanceof Error ? err.message : String(err)))
    const price = chosen.price_cents == null ? '' : ` for $${(chosen.price_cents / 100).toFixed(2)}`
    const goal = `${pick.request}\n\nChosen option: ${chosen.title}${price}${chosen.cancellation ? ` (${chosen.cancellation})` : ''}. Continue exactly where this ask left off on ${chosen.source_url}; stop and ask before entering any password or making any payment.`
    return json({ ok: true, taskId: pick.id, option: { id: chosen.id, title: chosen.title, url: chosen.source_url, price_cents: chosen.price_cents ?? null }, goal })
  }

  if (path === '/api/internal/handoff' && req.method === 'POST') {
    if (!options.internalOk(req)) return json({ error: 'Unauthorized' }, 401)
    const body = (await req.json().catch(() => ({}))) as {
      fromPersona?: string
      toPersona?: string
      phone?: string
      note?: string
    }
    if (!isPersona(body.fromPersona || '') || !isPersona(body.toPersona || '') || !body.phone) {
      return json({ error: 'fromPersona, toPersona, and phone required' }, 400)
    }
    const phone = normalizePhone(body.phone)
    if (!phone) return json({ error: 'valid phone required' }, 400)
    const user = await getUserByPhone(sql, phone)
    if (!user) return json({ error: 'User not found' }, 404)
    // The receiving hire runs this on its next claim pass and texts first.
    await sql`
      INSERT INTO hire_task_loops (id, user_id, persona, phone_e164, kind, title, payload, status, next_run)
      VALUES (${crypto.randomUUID()}, ${user.id}, ${body.toPersona!}, ${phone}, 'handoff',
        'Follow up on the handoff from ${body.fromPersona!}',
        ${JSON.stringify({ note: String(body.note || '').slice(0, 500), from: body.fromPersona })}::jsonb,
        'pending', now())
      ON CONFLICT (user_id, persona, kind) DO UPDATE SET
        payload = excluded.payload,
        status = 'pending',
        next_run = excluded.next_run,
        updated_at = now()
    `
    return json({ ok: true })
  }

  if (path === '/api/internal/kill-switch/check' && req.method === 'POST') {
    if (!options.internalOk(req)) return json({ error: 'Unauthorized' }, 401)
    const body = (await req.json().catch(() => ({}))) as { phone?: string }
    const phone = normalizePhone(body.phone || '')
    if (!phone) return json({ error: 'valid phone required' }, 400)
    const rows = (await sql`
      SELECT armed FROM hire_kill_switch WHERE phone_e164 = ${phone} LIMIT 1
    `) as Array<{ armed: boolean }>
    return json({ armed: !!rows[0]?.armed })
  }

  if (path === '/api/internal/actions' && req.method === 'POST') {
    if (!options.internalOk(req)) return json({ error: 'Unauthorized' }, 401)
    const body = (await req.json().catch(() => ({}))) as {
      phone?: string
      persona?: string
      action?: string
      detail?: string
      undo_hint?: string
    }
    const action = String(body.action || '').trim().slice(0, 120)
    if (!body.phone || !isPersona(body.persona || '') || !action) {
      return json({ error: 'phone, persona, and action required' }, 400)
    }
    const phone = normalizePhone(body.phone)
    const user = phone ? await getUserByPhone(sql, phone) : null
    if (!phone || !user) return json({ error: 'User not found' }, 404)
    const id = crypto.randomUUID()
    await sql`
      INSERT INTO hire_action_log (id, user_id, persona, action, detail, undo_hint)
      VALUES (${id}, ${user.id}, ${body.persona!}, ${action},
        ${String(body.detail || '').slice(0, 500)}, ${String(body.undo_hint || '').slice(0, 300) || null})
    `
    return json({ ok: true, id })
  }

  if (path === '/api/actions' && req.method === 'GET') {
    const phone = normalizePhone(url.searchParams.get('phone') || '')
    if (!phone) return json({ error: 'valid phone required' }, 400)
    const user = await getUserByPhone(sql, phone)
    if (!user) return json({ actions: [] })
    const rows = await sql`
      SELECT id, persona, action, detail, undo_hint AS "undoHint", undone_at AS "undoneAt",
             created_at AS "createdAt"
      FROM hire_action_log WHERE user_id = ${user.id}
      ORDER BY created_at DESC LIMIT 20
    `
    return json({ actions: rows })
  }

  if (path.startsWith('/api/actions/') && path.endsWith('/undo') && req.method === 'POST') {
    const id = path.slice('/api/actions/'.length, -'/undo'.length)
    if (!id) return json({ error: 'id required' }, 400)
    // Undo semantics live with the bots; here a row just stops reading as done.
    const { user, error } = await resolveAuthedUser(sql, {})
    if (error) return error
    await sql`UPDATE hire_action_log SET undone_at = now() WHERE id = ${id} AND user_id = ${user!.id}`
    return json({ ok: true })
  }

  if (path === '/api/kill-switch' && req.method === 'POST') {
    const body = (await req.json().catch(() => ({}))) as { phone?: string; armed?: boolean }
    const phone = normalizePhone(body.phone || '')
    if (!phone) return json({ error: 'valid phone required' }, 400)
    const armed = body.armed !== false
    await sql`
      INSERT INTO hire_kill_switch (phone_e164, armed, updated_at)
      VALUES (${phone}, ${armed}, now())
      ON CONFLICT (phone_e164) DO UPDATE SET armed = excluded.armed, updated_at = now()
    `
    return json({ ok: true, armed })
  }

  if (path === '/api/kill-switch' && req.method === 'GET') {
    const phone = normalizePhone(url.searchParams.get('phone') || '')
    if (!phone) return json({ error: 'valid phone required' }, 400)
    const rows = (await sql`
      SELECT armed FROM hire_kill_switch WHERE phone_e164 = ${phone} LIMIT 1
    `) as Array<{ armed: boolean }>
    return json({ armed: !!rows[0]?.armed })
  }

  if (path === '/api/wishlist' && req.method === 'POST') {
    const body = (await req.json().catch(() => ({}))) as { phone?: string; vote?: string }
    const phone = normalizePhone(body.phone || '')
    const vote = String(body.vote || '').trim().slice(0, 120)
    if (!phone || !vote) return json({ error: 'valid phone and vote required' }, 400)
    await sql`
      INSERT INTO hire_wishlist (id, phone_e164, vote)
      VALUES (${crypto.randomUUID()}, ${phone}, ${vote})
      ON CONFLICT (phone_e164, vote) DO NOTHING
    `
    return json({ ok: true })
  }

  if (path === '/api/wishlist' && req.method === 'GET') {
    const rows = (await sql`
      SELECT vote, count(*) AS count FROM hire_wishlist
      GROUP BY vote ORDER BY count DESC, vote
    `) as Array<{ vote: string; count: string | number }>
    return json({ ideas: rows.map((r) => ({ vote: r.vote, count: Number(r.count) })) })
  }

  // Shared to-do list: add | list | complete by id or fuzzy text
  if (path === '/api/internal/todos' && req.method === 'POST') {
    if (!options.internalOk(req)) return json({ error: 'Unauthorized' }, 401)
    const body = (await req.json().catch(() => ({}))) as { phone?: string; action?: string; text?: string; id?: string }
    const action = body.action === 'list' || body.action === 'complete' ? body.action : 'add'
    if (!body.phone) return json({ error: 'phone required' }, 400)
    const user = await getUserByPhone(sql, body.phone)
    if (!user) return json({ error: 'User not found' }, 404)
    if (action === 'add') {
      const text = String(body.text || '').trim().slice(0, 300)
      if (!text) return json({ error: 'text required' }, 400)
      const row = (await sql`
        INSERT INTO hire_todos (user_id, text) VALUES (${user.id}, ${text})
        RETURNING id::text AS id, text, done
      `)[0]
      return json({ ok: true, todo: row, open: await openTodos(sql, user.id) })
    }
    if (action === 'complete') {
      const wanted = String(body.text || '').trim().toLowerCase()
      const id = /^[0-9a-f-]{36}$/i.test(String(body.id || '')) ? body.id : null
      if (!id && !wanted) return json({ error: 'id or text required' }, 400)
      const rows = await sql`
        SELECT id::text AS id, text FROM hire_todos
        WHERE user_id = ${user.id} AND done = false
          AND ((${id}::uuid IS NOT NULL AND id = ${id}::uuid)
               OR (${id}::uuid IS NULL AND lower(text) LIKE ${'%' + wanted + '%'}))
        ORDER BY created_at DESC LIMIT 1
      `
      if (!rows[0]) return json({ ok: false, error: wanted || 'no match' })
      await sql`UPDATE hire_todos SET done = true, completed_at = now() WHERE id = ${rows[0].id}::uuid`
      return json({ ok: true, completed: rows[0], open: await openTodos(sql, user.id) })
    }
    return json({ ok: true, open: await openTodos(sql, user.id) })
  }

  return null
}
