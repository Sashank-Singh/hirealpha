import type { SQL } from 'bun'
import { json } from '../utils/http'
import { resolveAuthedUser } from '../auth/session'
import { getUserByPhone } from '../db/users'
import { isPersona } from '../personas'

export interface LearningRouteOptions {
  internalOk: (r: Request) => boolean
}

export async function handleLearningRoutes(
  req: Request,
  sql: SQL,
  options: LearningRouteOptions,
): Promise<Response | null> {
  const url = new URL(req.url)
  const path = url.pathname

  /* ---- Learning queue ---- */
  if (path === '/api/learning' && req.method === 'GET') {
    const { user, error } = await resolveAuthedUser(sql, {
      token: url.searchParams.get('t') || undefined,
      session: url.searchParams.get('s') || undefined,
      email: url.searchParams.get('email') || undefined,
    })
    if (error) return error
    const items = await sql`
      SELECT id, title, url, kind, minutes, notes, status, created_at AS "createdAt"
      FROM hire_learning WHERE user_id = ${user!.id}
      ORDER BY CASE WHEN status = 'queued' THEN 0 ELSE 1 END, created_at DESC
    `
    return json({ items })
  }

  if (path === '/api/learning' && req.method === 'POST') {
    const body = (await req.json().catch(() => ({}))) as {
      token?: string; email?: string; title?: string; url?: string; kind?: string; minutes?: number; notes?: string
    }
    const title = String(body.title || '').trim().slice(0, 240)
    if (!title) return json({ error: 'title required' }, 400)
    const { user, error } = await resolveAuthedUser(sql, { token: body.token, session: (body as { session?: string }).session, email: body.email })
    if (error) return error
    const allowedKinds = ['article', 'video', 'podcast', 'book', 'paper', 'thread']
    const kind = allowedKinds.includes(String(body.kind)) ? String(body.kind) : 'article'
    const minutes = Math.max(1, Math.min(360, Math.round(Number(body.minutes) || 10)))
    const itemUrl = String(body.url || '').trim().slice(0, 500) || null
    const notes = String(body.notes || '').trim().slice(0, 2000) || null
    const id = crypto.randomUUID()
    await sql`
      INSERT INTO hire_learning (id, user_id, title, url, kind, minutes, notes)
      VALUES (${id}, ${user!.id}, ${title}, ${itemUrl}, ${kind}, ${minutes}, ${notes})
    `
    return json({ ok: true, id })
  }

  if (path.startsWith('/api/learning/') && req.method === 'POST') {
    const body = (await req.json().catch(() => ({}))) as {
      token?: string; email?: string; _delete?: boolean; status?: string;
      title?: string; url?: string | null; kind?: string; minutes?: number; notes?: string | null;
      bumpTop?: boolean
    }
    const id = path.split('/')[3]
    if (!id) return json({ error: 'id required' }, 400)
    const { user, error } = await resolveAuthedUser(sql, { token: body.token, session: (body as { session?: string }).session, email: body.email })
    if (error) return error
    if (body._delete) {
      await sql`DELETE FROM hire_learning WHERE id = ${id} AND user_id = ${user!.id}`
      return json({ ok: true })
    }
    if (body.status !== undefined) {
      const status = body.status === 'done' ? 'done' : 'queued'
      await sql`UPDATE hire_learning SET status = ${status} WHERE id = ${id} AND user_id = ${user!.id}`
    }
    if (body.title !== undefined) {
      const title = String(body.title).trim().slice(0, 240)
      if (title) await sql`UPDATE hire_learning SET title = ${title} WHERE id = ${id} AND user_id = ${user!.id}`
    }
    if (body.url !== undefined) {
      const itemUrl = body.url ? String(body.url).trim().slice(0, 500) : null
      await sql`UPDATE hire_learning SET url = ${itemUrl} WHERE id = ${id} AND user_id = ${user!.id}`
    }
    if (body.kind !== undefined) {
      const kind = ['article', 'video', 'podcast', 'book', 'paper', 'thread'].includes(String(body.kind)) ? String(body.kind) : 'article'
      await sql`UPDATE hire_learning SET kind = ${kind} WHERE id = ${id} AND user_id = ${user!.id}`
    }
    if (body.minutes !== undefined) {
      const minutes = Math.max(1, Math.min(360, Math.round(Number(body.minutes) || 10)))
      await sql`UPDATE hire_learning SET minutes = ${minutes} WHERE id = ${id} AND user_id = ${user!.id}`
    }
    if (body.notes !== undefined) {
      const notes = body.notes ? String(body.notes).trim().slice(0, 2000) : null
      await sql`UPDATE hire_learning SET notes = ${notes} WHERE id = ${id} AND user_id = ${user!.id}`
    }
    if (body.bumpTop) {
      await sql`UPDATE hire_learning SET created_at = now() WHERE id = ${id} AND user_id = ${user!.id}`
    }
    return json({ ok: true })
  }

  if (path === '/api/internal/learning' && req.method === 'POST') {
    if (!options.internalOk(req)) return json({ error: 'Unauthorized' }, 401)
    const body = (await req.json().catch(() => ({}))) as {
      phone?: string; persona?: string; url?: string; title?: string; text?: string
    }
    const itemUrl = String(body.url || '').trim().slice(0, 500)
    if (!body.phone || !isPersona(body.persona || '') || !itemUrl) {
      return json({ error: 'phone, persona, and url required' }, 400)
    }
    const user = await getUserByPhone(sql, body.phone)
    if (!user) return json({ error: 'User not found' }, 404)
    let title = String(body.title || '').replace(/https?:\/\/\S+/gi, '').trim().slice(0, 160)
    if (!title) {
      try {
        title = new URL(itemUrl).hostname.replace(/^www\./, '') || 'Saved link'
      } catch {
        title = 'Saved link'
      }
    }
    const kind = /\b(youtube|vimeo|watch)\b/i.test(itemUrl) ? 'video' : /\b(spotify|podcast|anchor)\b/i.test(itemUrl) ? 'podcast' : 'article'
    const id = crypto.randomUUID()
    await sql`
      INSERT INTO hire_learning (id, user_id, title, url, kind, minutes)
      VALUES (${id}, ${user.id}, ${title}, ${itemUrl}, ${kind}, 10)
    `
    return json({ ok: true, logged: true, id, title, url: itemUrl, kind })
  }

  return null
}
