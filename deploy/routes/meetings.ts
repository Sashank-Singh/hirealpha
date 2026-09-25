import type { SQL } from 'bun'
import { json } from '../utils/http'
import { resolveAuthedUser } from '../auth/session'
import { getUserByPhone } from '../db/users'
import { isPersona } from '../personas'
import { parseFlexibleWhen } from '../timezones'
import { transcribeAudio } from '../stt'

export interface MeetingRouteOptions {
  internalOk: (r: Request) => boolean
}

export async function handleMeetingRoutes(
  req: Request,
  sql: SQL,
  options: MeetingRouteOptions,
): Promise<Response | null> {
  const url = new URL(req.url)
  const path = url.pathname

  if (path === '/api/meetings' && req.method === 'GET') {
    const { user, error } = await resolveAuthedUser(sql, {
      token: url.searchParams.get('t') || undefined,
      session: url.searchParams.get('s') || undefined,
      email: url.searchParams.get('email') || undefined,
    })
    if (error) return error
    const rows = await sql`
      SELECT id, title, starts_at AS "startsAt", phase, briefing, notes, followups,
             created_at AS "createdAt"
      FROM hire_meetings WHERE user_id = ${user!.id}
      ORDER BY created_at DESC LIMIT 30
    `
    return json({ meetings: rows })
  }

  if (path === '/api/meetings' && req.method === 'POST') {
    const body = (await req.json().catch(() => ({}))) as {
      token?: string; email?: string; title?: string; startsAt?: string
    }
    const title = String(body.title || '').trim().slice(0, 200)
    if (!title) return json({ error: 'title required' }, 400)
    const { user, error } = await resolveAuthedUser(sql, { token: body.token, session: (body as { session?: string }).session, email: body.email })
    if (error) return error
    const id = crypto.randomUUID()
    const startsAt = parseFlexibleWhen(body.startsAt, user!.timezone || 'America/Los_Angeles')
    await sql`
      INSERT INTO hire_meetings (id, user_id, title, starts_at)
      VALUES (${id}, ${user!.id}, ${title}, ${startsAt})
    `
    return json({ ok: true, id })
  }

  if (path.startsWith('/api/meetings/') && req.method === 'PATCH') {
    const id = path.slice('/api/meetings/'.length)
    const body = (await req.json().catch(() => ({}))) as {
      token?: string; email?: string; briefing?: string
      followups?: unknown; phase?: string
    }
    const { user, error } = await resolveAuthedUser(sql, { token: body.token, session: (body as { session?: string }).session, email: body.email })
    if (error) return error
    const phase = body.phase === 'done' ? 'done' : body.phase === 'prep' ? 'prep' : undefined
    await sql`
      UPDATE hire_meetings
      SET briefing = COALESCE(${body.briefing ? String(body.briefing).slice(0, 2000) : null}, briefing),
          followups = COALESCE(${Array.isArray(body.followups) ? JSON.stringify(body.followups).slice(0, 4000) : null}::jsonb, followups),
          phase = COALESCE(${phase || null}, phase),
          updated_at = now()
      WHERE id = ${id} AND user_id = ${user!.id}
    `
    return json({ ok: true })
  }

  if (path.startsWith('/api/meetings/') && req.method === 'DELETE') {
    const id = path.slice('/api/meetings/'.length)
    const body = (await req.json().catch(() => ({}))) as { token?: string; email?: string }
    const { user, error } = await resolveAuthedUser(sql, { token: body.token, session: (body as { session?: string }).session, email: body.email })
    if (error) return error
    await sql`DELETE FROM hire_meetings WHERE id = ${id} AND user_id = ${user!.id}`
    return json({ ok: true })
  }

  if (path.startsWith('/api/meetings/') && path.endsWith('/transcribe') && req.method === 'POST') {
    const id = path.slice('/api/meetings/'.length, -'/transcribe'.length)
    const body = (await req.json().catch(() => ({}))) as {
      token?: string; email?: string; audioBase64?: string; mimeType?: string
    }
    const audio = body.audioBase64 ? Buffer.from(body.audioBase64, 'base64') : null
    if (!audio || audio.length < 512) return json({ error: 'voice memo is required' }, 400)
    const { user, error } = await resolveAuthedUser(sql, { token: body.token, session: (body as { session?: string }).session, email: body.email })
    if (error) return error
    const meets = await sql`SELECT id FROM hire_meetings WHERE id = ${id} AND user_id = ${user!.id} LIMIT 1`
    if (!meets[0]) return json({ error: 'Meeting not found' }, 404)
    let transcript: string
    try {
      const { text } = await transcribeAudio(body.mimeType || 'audio/m4a', audio)
      transcript = text
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      return json({ ok: false, error: msg.slice(0, 200) }, 502)
    }
    const cur = await sql`SELECT notes FROM hire_meetings WHERE id = ${id} LIMIT 1`
    const prev = String((cur[0] as { notes?: string } | undefined)?.notes || '').trim()
    const notes = prev ? `${prev}\n\n${transcript}` : transcript
    await sql`
      UPDATE hire_meetings
      SET notes = ${notes.slice(0, 6000)}, updated_at = now()
      WHERE id = ${id} AND user_id = ${user!.id}
    `
    return json({ ok: true, transcript })
  }

  if (path === '/api/internal/meetings' && req.method === 'POST') {
    if (!options.internalOk(req)) return json({ error: 'Unauthorized' }, 401)
    const body = (await req.json().catch(() => ({}))) as {
      phone?: string
      persona?: string
      title?: string
    }
    if (!body.phone || !isPersona(body.persona || '') || !String(body.title || '').trim()) {
      return json({ error: 'phone, persona, and title required' }, 400)
    }
    const user = await getUserByPhone(sql, body.phone)
    if (!user) return json({ error: 'User not found' }, 404)
    const id = crypto.randomUUID()
    await sql`
      INSERT INTO hire_meetings (id, user_id, title, phase, followups)
      VALUES (${id}, ${user.id}, ${String(body.title).trim().slice(0, 200)}, 'debrief',
        '[]'::jsonb)
    `
    return json({ ok: true, id })
  }

  return null
}
