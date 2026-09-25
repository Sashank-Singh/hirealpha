import type { SQL } from 'bun'
import { isPersona } from '../personas'
import { json } from '../utils/http'
import { getUserByPhone } from '../db/users'
import { PIPELINE_STAGES, clampNum } from '../habits/parsers'

/** Cofounder capture kinds. Each maps chat noise to one existing table. */
export type CofounderCaptureKind = 'decision' | 'promise' | 'person' | 'opportunity'

export const COFOUNDER_KINDS: CofounderCaptureKind[] = ['decision', 'promise', 'person', 'opportunity']

function cofounderWhen(v: unknown): Date | null {
  if (!v) return null
  const d = v instanceof Date ? v : new Date(String(v))
  return Number.isNaN(d.getTime()) ? null : d
}

/** Capture one item the cofounder overheard in chat. Idempotent per user and
 * text inside 24 hours: a bot that retries or a story told twice updates the
 * row instead of cloning it. People and opportunities upsert by name, so a
 * second mention refreshes the row it already owns. */
export async function captureCofounderItem(
  sql: SQL,
  userId: string,
  persona: string,
  kind: CofounderCaptureKind,
  fields: Record<string, unknown>,
): Promise<{ created: boolean; id: string }> {
  const personaSafe = isPersona(persona) ? persona : 'cofounder'
  const raw = String(fields.raw || '').trim().slice(0, 500)

  if (kind === 'decision') {
    const decision = String(fields.decision || '').trim().slice(0, 300)
    if (!decision) throw new Error('decision required')
    const reason = String(fields.reason || '').trim().slice(0, 500) || raw
    const reviewAt = cofounderWhen(fields.reviewAt)
    const recent = (await sql`
      SELECT id FROM hire_decisions
      WHERE user_id = ${userId} AND lower(decision) = lower(${decision})
        AND created_at >= now() - interval '24 hours'
      ORDER BY created_at DESC LIMIT 1
    `) as Array<{ id: string }>
    if (recent[0]) {
      await sql`
        UPDATE hire_decisions SET reason = ${reason},
          review_at = COALESCE(${reviewAt}, review_at), updated_at = now()
        WHERE id = ${recent[0].id}
      `
      return { created: false, id: recent[0].id }
    }
    const id = crypto.randomUUID()
    await sql`
      INSERT INTO hire_decisions (id, user_id, persona, decision, reason, evidence, review_at)
      VALUES (${id}, ${userId}, ${personaSafe}, ${decision}, ${reason}, ${reason ? 'overheard in chat' : ''}, ${reviewAt})
    `
    return { created: true, id }
  }

  if (kind === 'promise') {
    const title = String(fields.title || '').trim().slice(0, 200)
    if (!title) throw new Error('title required')
    const dueAt = cofounderWhen(fields.dueAt)
    const recent = (await sql`
      SELECT id FROM hire_loops
      WHERE user_id = ${userId} AND lower(title) = lower(${title})
        AND created_at >= now() - interval '24 hours'
      ORDER BY created_at DESC LIMIT 1
    `) as Array<{ id: string }>
    if (recent[0]) {
      await sql`
        UPDATE hire_loops SET context = COALESCE(nullif(${raw}, ''), context),
          due_at = COALESCE(${dueAt}, due_at), updated_at = now()
        WHERE id = ${recent[0].id}
      `
      return { created: false, id: recent[0].id }
    }
    const id = crypto.randomUUID()
    await sql`
      INSERT INTO hire_loops (id, user_id, persona, title, context, due_at, status)
      VALUES (${id}, ${userId}, ${personaSafe}, ${title}, ${raw}, ${dueAt}, 'open')
    `
    return { created: true, id }
  }

  if (kind === 'person') {
    const name = String(fields.name || '').trim().slice(0, 120)
    if (!name) throw new Error('name required')
    const relKind = String(fields.kind || 'other').trim().slice(0, 40) || 'other'
    const notes = String(fields.notes || '').trim().slice(0, 500) || raw
    const existing = (await sql`
      SELECT id FROM hire_relationships
      WHERE user_id = ${userId} AND lower(name) = lower(${name})
      ORDER BY created_at LIMIT 1
    `) as Array<{ id: string }>
    if (existing[0]) {
      await sql`
        UPDATE hire_relationships SET kind = ${relKind},
          notes = COALESCE(nullif(${notes}, ''), notes),
          last_touch_at = now(), updated_at = now()
        WHERE id = ${existing[0].id}
      `
      return { created: false, id: existing[0].id }
    }
    const id = crypto.randomUUID()
    await sql`
      INSERT INTO hire_relationships (id, user_id, name, kind, notes, last_touch_at)
      VALUES (${id}, ${userId}, ${name}, ${relKind}, ${notes}, now())
    `
    return { created: true, id }
  }

  if (kind === 'opportunity') {
    const title = String(fields.title || '').trim().slice(0, 120)
    if (!title) throw new Error('title required')
    const company = String(fields.company || '').trim().slice(0, 80)
    const stage = PIPELINE_STAGES.includes(String(fields.stage) as (typeof PIPELINE_STAGES)[number])
      ? String(fields.stage)
      : 'lead'
    const value = Math.max(0, clampNum(fields.value))
    const oppKind = ['deal', 'job', 'fundraising', 'lead'].includes(String(fields.kind || ''))
      ? String(fields.kind)
      : 'deal'
    const notes = raw
    const existing = (await sql`
      SELECT id FROM hire_pipeline
      WHERE user_id = ${userId} AND lower(title) = lower(${title}) AND lower(company) = lower(${company})
      ORDER BY created_at LIMIT 1
    `) as Array<{ id: string }>
    if (existing[0]) {
      await sql`
        UPDATE hire_pipeline SET stage = ${stage}, kind = ${oppKind},
          value = CASE WHEN ${value} > 0 THEN ${value} ELSE value END,
          notes = COALESCE(nullif(${notes}, ''), notes), updated_at = now()
        WHERE id = ${existing[0].id}
      `
      return { created: false, id: existing[0].id }
    }
    const id = crypto.randomUUID()
    await sql`
      INSERT INTO hire_pipeline (id, user_id, title, company, stage, notes, value, kind)
      VALUES (${id}, ${userId}, ${title}, ${company}, ${stage}, ${notes}, ${value}, ${oppKind})
    `
    return { created: true, id }
  }

  throw new Error(`unknown capture kind: use ${COFOUNDER_KINDS.join(', ')}`)
}

export async function handleCofounderRoutes(
  req: Request,
  sql: SQL,
  options: { internalOk: (r: Request) => boolean },
): Promise<Response | null> {
  const url = new URL(req.url)
  const path = url.pathname

  /* Cofounder capture: one structured item overheard in chat, deduped inside
   * 24 hours. The bot does the parsing; this endpoint only files the row. */
  if (path === '/api/internal/cofounder/capture' && req.method === 'POST') {
    if (!options.internalOk(req)) return json({ error: 'Unauthorized' }, 401)
    const body = (await req.json().catch(() => ({}))) as {
      phone?: string
      persona?: string
      kind?: string
      fields?: Record<string, unknown>
      raw?: string
    }
    if (!body.phone || !isPersona(body.persona || '')) return json({ error: 'phone and persona required' }, 400)
    const kind = String(body.kind || '') as CofounderCaptureKind
    if (!COFOUNDER_KINDS.includes(kind)) {
      return json({ error: 'kind must be decision, promise, person, or opportunity' }, 400)
    }
    const user = await getUserByPhone(sql, body.phone)
    if (!user) return json({ error: 'User not found' }, 404)
    try {
      const result = await captureCofounderItem(sql, user.id, body.persona!, kind, {
        ...(body.fields || {}),
        raw: String(body.raw || (body.fields as { raw?: string } | undefined)?.raw || ''),
      })
      return json({ ok: true, ...result })
    } catch (err) {
      return json({ error: err instanceof Error ? err.message : 'capture failed' }, 400)
    }
  }

  return null
}
