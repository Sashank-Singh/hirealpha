import type { SQL } from 'bun'
import { json } from '../utils/http'
import { resolveAuthedUser } from '../auth/session'
import { getUserByPhone, type AuthedUser } from '../db/users'
import { isPersona, type Persona } from '../personas'
import { clampNum } from '../habits/parsers'

export interface TodayResult {
  meets: unknown[]
  stay: unknown
  calendarConnected: boolean
}

const EMPTY_TODAY_RESULT: TodayResult = { meets: [], stay: null, calendarConnected: false }

export interface NetworkRouteOptions {
  internalOk: (r: Request) => boolean
  loadTodayMeets?: (user: AuthedUser, persona: string) => Promise<TodayResult>
  connectedForUser: (sql: SQL, userId: string) => Promise<string[]>
  touchInbound?: (sql: SQL, phone: string, persona: Persona) => Promise<any>
}

export async function handleNetworkRoutes(
  req: Request,
  sql: SQL,
  options: NetworkRouteOptions,
): Promise<Response | null> {
  const url = new URL(req.url)
  const path = url.pathname

  if (path === '/api/internal/touch' && req.method === 'POST') {
    if (!options.internalOk(req)) return json({ error: 'Unauthorized' }, 401)
    const body = (await req.json().catch(() => ({}))) as { phone?: string; persona?: string }
    if (!body.phone || !body.persona || !isPersona(body.persona)) {
      return json({ error: 'phone and persona required' }, 400)
    }
    if (!options.touchInbound) return json({ error: 'touchInbound unavailable' }, 500)
    return json(await options.touchInbound(sql, body.phone, body.persona))
  }

  if (path === '/api/internal/network' && req.method === 'POST') {
    if (!options.internalOk(req)) return json({ error: 'Unauthorized' }, 401)
    const body = (await req.json().catch(() => ({}))) as {
      phone?: string; persona?: string; name?: string; place?: string; text?: string; contactPhone?: string
    }
    const name = String(body.name || '').trim().slice(0, 80)
    if (!body.phone || !isPersona(body.persona || '') || !name) {
      return json({ error: 'phone, persona, and name required' }, 400)
    }
    const user = await getUserByPhone(sql, body.phone)
    if (!user) return json({ error: 'User not found' }, 404)
    const whereMet = String(body.place || '').trim().slice(0, 120)
    const contactPhone = String(body.contactPhone || '').trim().slice(0, 40)
    const context = String(body.text || '').trim().slice(0, 400)
    const id = crypto.randomUUID()
    await sql`
      INSERT INTO hire_network (id, user_id, name, where_met, context, last_touch, cadence_days, phone)
      VALUES (${id}, ${user.id}, ${name}, ${whereMet}, ${context}, now(), 14, ${contactPhone})
    `
    return json({ ok: true, logged: true, id, name, place: whereMet, phone: contactPhone })
  }

  /* Contacts for the Tier 4 delegate: name + phone to draft outreach. */
  if (path === '/api/internal/network' && req.method === 'GET') {
    if (!options.internalOk(req)) return json({ error: 'Unauthorized' }, 401)
    const phone = url.searchParams.get('phone') || ''
    if (!phone) return json({ error: 'phone required' }, 400)
    const user = await getUserByPhone(sql, phone)
    if (!user) return json({ contacts: [] })
    const rows = await sql`
      SELECT name, phone, email, last_touch FROM hire_network
      WHERE user_id = ${user.id}
      ORDER BY coalesce(last_touch, '1970-01-01'::timestamptz) DESC LIMIT 50
    `
    return json({ contacts: rows })
  }

  /* ---- Networking CRM ---- */
  if (path === '/api/network' && req.method === 'GET') {
    const { user, error } = await resolveAuthedUser(sql, {
      token: url.searchParams.get('t') || undefined,
      session: url.searchParams.get('s') || undefined,
      email: url.searchParams.get('email') || undefined,
    })
    if (error) return error
    const persona = url.searchParams.get('persona') || 'friend'
    /* The people list is one query; the calendar behind `today` is a hop into
     * Google that measured between one and three seconds. They no longer wait
     * for each other, and the calendar half comes from the same stale-while-
     * revalidate cache home uses — this endpoint is polled by every screen that
     * shows who you are seeing today. */
    const [people, calResult] = await Promise.all([
      sql`
        SELECT id, name, where_met AS "whereMet", context, last_touch AS "lastTouch",
               cadence_days AS "cadenceDays", created_at AS "createdAt",
               phone, email AS "contactEmail", company, birthday::text AS birthday
        FROM hire_network WHERE user_id = ${user!.id}
        ORDER BY coalesce(last_touch, '1970-01-01'::timestamptz) ASC
      `,
      // `lazy=1` says the caller will come back for the calendar half: People is
      // one query and should paint instantly, while the Google hop can take up
      // to 2.5s when the cache is cold. The CRM uses this so the roster shows
      // immediately and today's meetings fill in behind it.
      isPersona(persona) && !url.searchParams.has('lazy') && options.loadTodayMeets
        ? options.loadTodayMeets(user!, persona).catch(() => EMPTY_TODAY_RESULT)
        : Promise.resolve(EMPTY_TODAY_RESULT),
    ])
    if (url.searchParams.has('lazy')) {
      const connected = await options.connectedForUser(sql, user!.id)
      return json({
        people,
        today: [],
        stay: null,
        calendarConnected: connected.includes('calendar'),
      })
    }
    return json({ people, today: calResult.meets, stay: calResult.stay, calendarConnected: calResult.calendarConnected })
  }

  if (path === '/api/network' && req.method === 'POST') {
    const body = (await req.json().catch(() => ({}))) as {
      token?: string; session?: string; email?: string; name?: string; whereMet?: string; context?: string
      cadenceDays?: number; phone?: string; contactEmail?: string; company?: string; birthday?: string
    }
    const name = String(body.name || '').trim().slice(0, 80)
    if (!name) return json({ error: 'name required' }, 400)
    const { user, error } = await resolveAuthedUser(sql, { token: body.token, session: (body as { session?: string }).session, email: body.email })
    if (error) return error
    const id = crypto.randomUUID()
    const whereMet = String(body.whereMet || '').trim().slice(0, 120)
    const context = String(body.context || '').trim().slice(0, 400)
    const cadenceDays = Math.max(3, Math.min(365, Math.round(body.cadenceDays || 14)))
    const phone = String(body.phone || '').trim().slice(0, 40)
    const contactEmail = String(body.contactEmail || '').trim().slice(0, 120)
    const company = String(body.company || '').trim().slice(0, 120)
    /* Backlog #33: optional YYYY-MM-DD feeds the yearly birthday reminder.
     * The regex stops a bad input from reaching the DATE column. */
    const bdayRaw = String(body.birthday || '').trim()
    const birthday = /^\d{4}-\d{2}-\d{2}$/.test(bdayRaw) ? bdayRaw : null
    await sql`
      INSERT INTO hire_network (id, user_id, name, where_met, context, last_touch, cadence_days, phone, email, company, birthday)
      VALUES (${id}, ${user!.id}, ${name}, ${whereMet}, ${context}, now(), ${cadenceDays}, ${phone}, ${contactEmail}, ${company}, ${birthday})
    `
    return json({ ok: true, id })
  }

  if (path.startsWith('/api/network/') && req.method === 'POST') {
    const body = (await req.json().catch(() => ({}))) as {
      token?: string; session?: string; email?: string; _delete?: boolean; touch?: boolean; context?: string
      name?: string; phone?: string; contactEmail?: string; company?: string; whereMet?: string
      cadenceDays?: number; save?: boolean; birthday?: string
    }
    const id = path.split('/')[3]
    if (!id) return json({ error: 'id required' }, 400)
    const { user, error } = await resolveAuthedUser(sql, { token: body.token, session: (body as { session?: string }).session, email: body.email })
    if (error) return error
    if (body._delete) {
      await sql`DELETE FROM hire_network WHERE id = ${id} AND user_id = ${user!.id}`
      return json({ ok: true })
    }
    if (body.save) {
      const name = String(body.name || '').trim().slice(0, 80)
      if (!name) return json({ error: 'name required' }, 400)
      const phone = String(body.phone || '').trim().slice(0, 40)
      const contactEmail = String(body.contactEmail || '').trim().slice(0, 120)
      const company = String(body.company || '').trim().slice(0, 120)
      const whereMet = String(body.whereMet || '').trim().slice(0, 120)
      const context = String(body.context || '').trim().slice(0, 400)
      const cadenceDays = Math.max(3, Math.min(365, Math.round(body.cadenceDays || 14)))
      /* Backlog #33: optional YYYY-MM-DD feeds the yearly birthday reminder.
       * An empty string explicitly clears the birthday; a non-matching value
       * is ignored so the user can hit save without typing. */
      const bdayRaw = String(body.birthday || '').trim()
      const birthday = bdayRaw === '' ? null : (/^\d{4}-\d{2}-\d{2}$/.test(bdayRaw) ? bdayRaw : null)
      await sql`
        UPDATE hire_network
        SET name = ${name}, phone = ${phone}, email = ${contactEmail}, company = ${company},
            where_met = ${whereMet}, context = ${context}, cadence_days = ${cadenceDays},
            birthday = ${birthday}::date
        WHERE id = ${id} AND user_id = ${user!.id}
      `
      return json({ ok: true })
    }
    const context = body.context != null ? String(body.context).trim().slice(0, 400) : null
    if (context != null) {
      await sql`UPDATE hire_network SET last_touch = now(), context = ${context} WHERE id = ${id} AND user_id = ${user!.id}`
    } else {
      await sql`UPDATE hire_network SET last_touch = now() WHERE id = ${id} AND user_id = ${user!.id}`
    }
    return json({ ok: true })
  }

  if (path === '/api/relationships' && req.method === 'GET') {
    const { user, error } = await resolveAuthedUser(sql, {
      token: url.searchParams.get('t') || undefined,
      session: url.searchParams.get('s') || undefined,
      email: url.searchParams.get('email') || undefined,
    })
    if (error) return error
    const rows = await sql`
      SELECT id, name, where_met AS kind, context AS notes, cadence_days AS "cadenceDays",
             last_touch AS "lastTouchAt", created_at AS "updatedAt"
      FROM hire_network WHERE user_id = ${user!.id}
      ORDER BY last_touch ASC NULLS FIRST LIMIT 60
    `
    return json({ relationships: rows })
  }

  if (path === '/api/relationships' && req.method === 'POST') {
    const body = (await req.json().catch(() => ({}))) as {
      token?: string; email?: string
      name?: string; kind?: string; notes?: string; cadenceDays?: number
      birthday?: string
    }
    const name = String(body.name || '').trim().slice(0, 120)
    if (!name) return json({ error: 'name required' }, 400)
    const kind = ['personal', 'work', 'investor', 'candidate', 'partner', 'other'].includes(body.kind || '')
      ? body.kind!
      : 'other'
    const { user, error } = await resolveAuthedUser(sql, { token: body.token, session: (body as { session?: string }).session, email: body.email })
    if (error) return error
    const id = crypto.randomUUID()
    /* Backlog #33: an optional birthday (YYYY-MM-DD) feeds the friend hire's
     * yearly reminder. The string is regex-checked so a garbage value never
     * reaches the DATE column. Empty / missing stays NULL. */
    const bdayRaw = String(body.birthday || '').trim()
    const bday = /^\d{4}-\d{2}-\d{2}$/.test(bdayRaw) ? bdayRaw : null
    await sql`
      INSERT INTO hire_network (id, user_id, name, where_met, context, cadence_days, birthday)
      VALUES (${id}, ${user!.id}, ${name}, ${kind}, ${String(body.notes || '').slice(0, 500)},
        ${Math.min(Math.max(clampNum(body.cadenceDays, 30), 1), 365)}, ${bday})
    `
    return json({ ok: true, id })
  }

  if (path.startsWith('/api/relationships/') && req.method === 'PATCH') {
    const id = path.slice('/api/relationships/'.length)
    const body = (await req.json().catch(() => ({}))) as { token?: string; email?: string; touch?: boolean }
    const { user, error } = await resolveAuthedUser(sql, { token: body.token, session: (body as { session?: string }).session, email: body.email })
    if (error) return error
    if (body.touch) {
      await sql`
        UPDATE hire_network SET last_touch = now()
        WHERE id = ${id} AND user_id = ${user!.id}
      `
    }
    return json({ ok: true })
  }

  return null
}
