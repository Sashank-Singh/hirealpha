import type { SQL } from 'bun'
import { json } from '../utils/http'
import { resolveAuthedUser } from '../auth/session'
import { isPersona } from '../personas'

export async function handleDropzoneRoutes(req: Request, sql: SQL): Promise<Response | null> {
  const url = new URL(req.url)
  const path = url.pathname

  if (path === '/api/dropzone' && req.method === 'GET') {
    const { user, error } = await resolveAuthedUser(sql, {
      token: url.searchParams.get('t') || undefined,
      session: url.searchParams.get('s') || undefined,
      email: url.searchParams.get('email') || undefined,
    })
    if (error) return error
    const rows = await sql`
      SELECT id, persona, content, media_kind AS "mediaKind", summary, status,
             created_at AS "createdAt"
      FROM hire_dropzone WHERE user_id = ${user!.id}
      ORDER BY created_at DESC LIMIT 50
    `
    return json({ drops: rows })
  }

  if (path === '/api/dropzone' && req.method === 'POST') {
    const body = (await req.json().catch(() => ({}))) as {
      token?: string; email?: string; content?: string; mediaKind?: string
    }
    const content = String(body.content || '').trim().slice(0, 2000)
    if (!content) return json({ error: 'content required' }, 400)
    const { user, error } = await resolveAuthedUser(sql, { token: body.token, session: (body as { session?: string }).session, email: body.email })
    if (error) return error
    const id = crypto.randomUUID()
    const mediaKind = ['image', 'voice', 'link', 'text'].includes(body.mediaKind || '') ? body.mediaKind! : null
    await sql`
      INSERT INTO hire_dropzone (id, user_id, persona, content, media_kind)
      VALUES (${id}, ${user!.id}, '', ${content}, ${mediaKind})
    `
    return json({ ok: true, id })
  }

  if (path.startsWith('/api/dropzone/') && req.method === 'PATCH') {
    const id = path.slice('/api/dropzone/'.length)
    const body = (await req.json().catch(() => ({}))) as {
      token?: string; email?: string; persona?: string; summary?: string; status?: string
    }
    const { user, error } = await resolveAuthedUser(sql, { token: body.token, session: (body as { session?: string }).session, email: body.email })
    if (error) return error
    const status = ['new', 'routed', 'done'].includes(body.status || '') ? body.status! : undefined
    await sql`
      UPDATE hire_dropzone
      SET persona = COALESCE(${isPersona(body.persona || '') ? body.persona! : null}, persona),
          summary = COALESCE(${body.summary ? String(body.summary).slice(0, 500) : null}, summary),
          status = COALESCE(${status || null}, status)
      WHERE id = ${id} AND user_id = ${user!.id}
    `
    return json({ ok: true })
  }

  return null
}
