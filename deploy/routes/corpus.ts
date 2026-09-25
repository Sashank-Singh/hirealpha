import type { SQL } from 'bun'
import { isPersona } from '../personas'
import { json } from '../utils/http'
import { getUserByPhone } from '../db/users'

export async function handleCorpusRoutes(
  req: Request,
  sql: SQL,
  options: { internalOk: (r: Request) => boolean },
): Promise<Response | null> {
  const url = new URL(req.url)
  const path = url.pathname

  /* The corpus. One row per text the user sent and one per reply, written by
   * the turn path after delivery — so the material for improving the model
   * lives in Postgres instead of dying with a container volume. Best effort by
   * design: a logging failure must never cost a turn its answer. */
  if (path === '/api/internal/message-log' && req.method === 'POST') {
    if (!options.internalOk(req)) return json({ error: 'Unauthorized' }, 401)
    const body = (await req.json().catch(() => ({}))) as {
      phone?: string
      persona?: string
      turnId?: string
      replyMs?: number
      rows?: Array<{ role?: string; text?: string; source?: string }>
    }
    const rows = (body.rows || []).filter((r) => (r.role === 'user' || r.role === 'alpha') && String(r.text || '').trim())
    if (!body.phone || !isPersona(body.persona || '') || !rows.length) {
      return json({ error: 'phone, persona, and rows required' }, 400)
    }
    try {
      const user = await getUserByPhone(sql, body.phone)
      const turnId = String(body.turnId || crypto.randomUUID()).slice(0, 64)
      for (const row of rows) {
        await sql`
          INSERT INTO hire_message_log (user_id, phone, persona, role, text, source, turn_id, reply_ms)
          VALUES (${user?.id ?? null}, ${body.phone}, ${body.persona}, ${row.role},
            ${String(row.text).slice(0, 8000)}, ${row.source ? String(row.source).slice(0, 40) : null},
            ${turnId}, ${Number.isFinite(body.replyMs) ? Math.round(Number(body.replyMs)) : null})
        `
      }
      return json({ ok: true, logged: rows.length })
    } catch (err) {
      console.warn('[message-log] write failed', err)
      return json({ ok: false, logged: 0 }, 200)
    }
  }

  return null
}
