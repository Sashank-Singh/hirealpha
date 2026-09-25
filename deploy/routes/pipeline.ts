import type { SQL } from 'bun'
import { json } from '../utils/http'
import { resolveAuthedUser } from '../auth/session'
import { getUserByPhone } from '../db/users'
import { isPersona } from '../personas'
import { parsePipelineText, PIPELINE_STAGES, clampNum } from '../habits/parsers'

export async function investorNoteBody(sql: SQL, userId: string) {
  const pipes = (await sql`
    SELECT title, company, stage FROM hire_pipeline WHERE user_id = ${userId}
    ORDER BY updated_at DESC LIMIT 8
  `) as Array<{ title: string; company: string; stage: string }>
  const decisions = (await sql`
    SELECT decision, reason FROM hire_decisions WHERE user_id = ${userId}
    ORDER BY created_at DESC LIMIT 5
  `) as Array<{ decision: string; reason: string }>
  const spend = await sql`
    SELECT coalesce(sum(amount), 0)::float AS n FROM hire_spending
    WHERE user_id = ${userId} AND spent_at >= date_trunc('week', now())
  `
  const weekSpend = Number((spend[0] as { n?: number } | undefined)?.n || 0)
  // Month over month: stage counts today vs the last touch before the 30 day
  // mark. Rows untouched since then are the state the investor last saw.
  const stageNow = (await sql`
    SELECT stage, count(*)::int AS n FROM hire_pipeline WHERE user_id = ${userId} GROUP BY stage
  `) as Array<{ stage: string; n: number }>
  const stageThen = (await sql`
    SELECT stage, count(*)::int AS n FROM hire_pipeline
    WHERE user_id = ${userId} AND updated_at < now() - interval '30 days'
    GROUP BY stage
  `) as Array<{ stage: string; n: number }>
  const runwayRows = (await sql`
    SELECT cash, burn, months FROM hire_runway_snapshots
    WHERE user_id = ${userId} ORDER BY taken_on DESC LIMIT 1
  `) as Array<{ cash: number; burn: number; months: number }>
  const openDecisionRows = await sql`
    SELECT count(*)::int AS n FROM hire_decisions WHERE user_id = ${userId} AND status = 'open'
  `
  const openDecisions = Number((openDecisionRows[0] as { n?: number } | undefined)?.n || 0)
  const live = pipes.filter((p) => p.stage !== 'lost')
  const tally = (rows: Array<{ stage: string; n: number }>) => {
    const out: Record<string, number> = {}
    for (const r of rows) out[r.stage] = Number(r.n)
    return out
  }
  const nowTally = tally(stageNow)
  const thenTally = tally(stageThen)
  const deltas = PIPELINE_STAGES
    .map((s) => ({ stage: s, d: (nowTally[s] || 0) - (thenTally[s] || 0) }))
    .filter((x) => x.d !== 0)
    .map((x) => `${x.stage} ${x.d > 0 ? `+${x.d}` : x.d}`)
  const runway = runwayRows[0]
  const money = (n: number) => `$${Math.round(Number(n) || 0).toLocaleString('en-US')}`
  const lines = [
    'Update',
    '',
    live.length ? `Pipeline: ${live.map((p) => `${p.title}${p.company ? ` @ ${p.company}` : ''} (${p.stage})`).join('; ')}` : 'Pipeline: quiet this week.',
    deltas.length ? `Month over month: ${deltas.join(', ')}.` : '',
    runway ? `Runway: ${Number(runway.months).toFixed(1)} months on ${money(runway.cash)} cash, ${money(runway.burn)} monthly burn.` : '',
    `Spend this week: $${Math.round(weekSpend)}.`,
    `Open decisions: ${openDecisions}.`,
    decisions[0] ? `Call: ${decisions[0].decision}${decisions[0].reason ? ` because ${decisions[0].reason}` : ''}.` : '',
    '',
    'Ask:',
    '  What I need from you:',
    '  One intro worth making:',
  ]
  return lines.filter(Boolean).join('\n')
}

export async function handlePipelineRoutes(
  req: Request,
  sql: SQL,
  options: { internalOk: (r: Request) => boolean },
): Promise<Response | null> {
  const url = new URL(req.url)
  const path = url.pathname

  if (path === '/api/internal/pipeline' && req.method === 'POST') {
    if (!options.internalOk(req)) return json({ error: 'Unauthorized' }, 401)
    const body = (await req.json().catch(() => ({}))) as {
      phone?: string; persona?: string; text?: string
    }
    if (!body.phone || !isPersona(body.persona || '') || !String(body.text || '').trim()) {
      return json({ error: 'phone, persona, and text required' }, 400)
    }
    const user = await getUserByPhone(sql, body.phone)
    if (!user) return json({ error: 'User not found' }, 404)
    const parsed = parsePipelineText(String(body.text))
    if (!parsed) return json({ ok: false, logged: false, error: 'Could not parse a pipeline move' })
    const id = crypto.randomUUID()
    // Upsert by a normalized title so "move Ravi to interview" adds it if new,
    // moves it if it already exists — the board reads the same table.
    await sql`
      INSERT INTO hire_pipeline (id, user_id, title, company, stage, notes)
      VALUES (${id}, ${user.id}, ${parsed.title.slice(0, 120)}, '' , ${parsed.stage}, ${(parsed.notes || '').slice(0, 400)})
      ON CONFLICT DO NOTHING
    `
    if (parsed.existing) {
      await sql`
        UPDATE hire_pipeline SET stage = ${parsed.stage}, updated_at = now()
        WHERE user_id = ${user.id} AND lower(title) = lower(${parsed.title.slice(0, 120)})
      `
    }
    return json({ ok: true, logged: true, id, title: parsed.title.slice(0, 120), stage: parsed.stage })
  }

  /* ---- Pipeline ---- */
  if (path === '/api/pipeline' && req.method === 'GET') {
    const { user, error } = await resolveAuthedUser(sql, {
      token: url.searchParams.get('t') || undefined,
      session: url.searchParams.get('s') || undefined,
      email: url.searchParams.get('email') || undefined,
    })
    if (error) return error
    const items = await sql`
      SELECT id, title, company, stage, notes, value, kind, created_at AS "createdAt", updated_at AS "updatedAt"
      FROM hire_pipeline WHERE user_id = ${user!.id}
      ORDER BY updated_at DESC
    `
    return json({ items })
  }

  if (path === '/api/pipeline' && req.method === 'POST') {
    const body = (await req.json().catch(() => ({}))) as {
      token?: string; email?: string; title?: string; company?: string; stage?: string; notes?: string; value?: number; kind?: string
    }
    const title = String(body.title || '').trim().slice(0, 120)
    if (!title) return json({ error: 'title required' }, 400)
    const { user, error } = await resolveAuthedUser(sql, { token: body.token, session: (body as { session?: string }).session, email: body.email })
    if (error) return error
    const stage = PIPELINE_STAGES.includes(String(body.stage) as (typeof PIPELINE_STAGES)[number])
      ? String(body.stage)
      : 'lead'
    const company = String(body.company || '').trim().slice(0, 80)
    const notes = String(body.notes || '').trim().slice(0, 400)
    const value = Math.max(0, clampNum(body.value))
    const kind = ['deal', 'job', 'fundraising', 'lead'].includes(String(body.kind || '')) ? String(body.kind) : 'deal'
    const id = crypto.randomUUID()
    await sql`
      INSERT INTO hire_pipeline (id, user_id, title, company, stage, notes, value, kind)
      VALUES (${id}, ${user!.id}, ${title}, ${company}, ${stage}, ${notes}, ${value}, ${kind})
    `
    return json({ ok: true, id })
  }

  if (path === '/api/pipeline/move' && req.method === 'POST') {
    const body = (await req.json().catch(() => ({}))) as {
      token?: string; session?: string; email?: string; id?: string; stage?: string
    }
    const id = String(body.id || '')
    if (!id) return json({ error: 'id required' }, 400)
    const stage = String(body.stage || '')
    if (!PIPELINE_STAGES.includes(stage as (typeof PIPELINE_STAGES)[number])) {
      return json({ error: 'valid stage required' }, 400)
    }
    const { user, error } = await resolveAuthedUser(sql, { token: body.token, session: (body as { session?: string }).session, email: body.email })
    if (error) return error
    const rows = (await sql`
      UPDATE hire_pipeline SET stage = ${stage}, updated_at = now()
      WHERE id = ${id} AND user_id = ${user!.id}
      RETURNING id
    `) as Array<{ id: string }>
    if (!rows.length) return json({ error: 'Not found' }, 404)
    return json({ ok: true, id: rows[0].id })
  }

  if (path.startsWith('/api/pipeline/') && req.method === 'POST') {
    const body = (await req.json().catch(() => ({}))) as {
      token?: string; email?: string; _delete?: boolean; stage?: string; notes?: string
    }
    const id = path.split('/')[3]
    if (!id) return json({ error: 'id required' }, 400)
    const { user, error } = await resolveAuthedUser(sql, { token: body.token, session: (body as { session?: string }).session, email: body.email })
    if (error) return error
    if (body._delete) {
      await sql`DELETE FROM hire_pipeline WHERE id = ${id} AND user_id = ${user!.id}`
      return json({ ok: true })
    }
    const stage = PIPELINE_STAGES.includes(String(body.stage) as (typeof PIPELINE_STAGES)[number])
      ? String(body.stage)
      : null
    if (stage) {
      await sql`UPDATE hire_pipeline SET stage = ${stage}, updated_at = now() WHERE id = ${id} AND user_id = ${user!.id}`
    }
    return json({ ok: true })
  }

  /* Draft the monthly investor note: the numbers are pulled, the asks are the
   * only blanks the user fills. Saved as a pending draft, never sent here. */
  if (path === '/api/investor-note/draft' && req.method === 'POST') {
    const body = (await req.json().catch(() => ({}))) as {
      token?: string; session?: string; email?: string; persona?: string
    }
    const { user, error } = await resolveAuthedUser(sql, { token: body.token, session: (body as { session?: string }).session, email: body.email })
    if (error) return error
    const subject = 'Investor update'
    const note = await investorNoteBody(sql, user!.id)
    const id = crypto.randomUUID()
    await sql`
      INSERT INTO hire_drafts (id, user_id, persona, kind, to_addr, subject, body, status)
      VALUES (${id}, ${user!.id}, ${isPersona(body.persona || '') ? body.persona! : 'cofounder'}, 'investor', '', ${subject}, ${note}, 'pending')
    `
    return json({ ok: true, draft: { id, kind: 'investor', subject, body: note, status: 'pending' } })
  }

  return null
}
