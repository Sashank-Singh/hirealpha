import type { SQL } from 'bun'
import { isPersona } from '../personas'
import { normalizePhone, phonesMatch } from '../utils/phone'
import {
  loopTimezone,
  localWall,
  wallTimeToUtc,
  shiftDateStr,
  parseFlexibleWhen,
} from '../timezones'
import { json } from '../utils/http'
import { getUserByPhone } from '../db/users'
import { resolveAuthedUser } from '../auth/session'
import { claimDueLoops, finishTaskLoop } from '../loops/engine'

export async function handleLoopRoutes(
  req: Request,
  sql: SQL,
  options: { internalOk: (r: Request) => boolean },
): Promise<Response | null> {
  const url = new URL(req.url)
  const path = url.pathname

  if (path === '/api/internal/loops/watch' && req.method === 'POST') {
    if (!options.internalOk(req)) return json({ error: 'Unauthorized' }, 401)
    const body = (await req.json().catch(() => ({}))) as {
      phone?: string
      persona?: string
      url?: string
      goal?: string
      title?: string
      intervalHours?: number
      budgetDollars?: number
    }
    const portal = String(body.url || '').trim()
    const goal = String(body.goal || '').trim()
    if (!/^https:\/\//i.test(portal)) return json({ error: 'watch needs an https site URL' }, 400)
    if (goal.length < 8) return json({ error: 'watch needs a real goal' }, 400)
    if (!body.phone || !isPersona(body.persona || '')) {
      return json({ error: 'phone and persona required' }, 400)
    }
    const user = await getUserByPhone(sql, body.phone)
    if (!user) return json({ error: 'User not found' }, 404)
    const hours = Math.max(1, Math.min(168, Math.floor(Number(body.intervalHours) || 6)))
    const id = crypto.randomUUID()
    const payload = JSON.stringify({
      url: portal,
      goal: goal.slice(0, 400),
      intervalHours: hours,
      budgetDollars: Number(body.budgetDollars) || null,
    })
    await sql`
      INSERT INTO hire_task_loops (id, user_id, persona, phone_e164, kind, title, payload, status, next_run)
      VALUES (${id}, ${user.id}, ${body.persona!}, ${body.phone!}, 'browser_watch',
        ${String(body.title || `Watch: ${goal.slice(0, 60)}`).slice(0, 200)},
        ${payload}::jsonb, 'pending', now())
    `
    return json({ ok: true, id, intervalHours: hours })
  }

  if (path === '/api/internal/loops/claim' && req.method === 'GET') {
    if (!options.internalOk(req)) return json({ error: 'Unauthorized' }, 401)
    const persona = url.searchParams.get('persona') || ''
    if (!isPersona(persona)) return json({ error: 'persona required' }, 400)
    const limit = Math.min(Math.max(Number(url.searchParams.get('limit')) || 3, 1), 10)
    const loops = await claimDueLoops(sql, persona, limit)
    return json({ loops })
  }

  if (path === '/api/internal/loops/result' && req.method === 'POST') {
    if (!options.internalOk(req)) return json({ error: 'Unauthorized' }, 401)
    const body = (await req.json().catch(() => ({}))) as {
      id?: string
      outcome?: string
      note?: string
      next_run?: string
    }
    const outcome =
      body.outcome === 'done' || body.outcome === 'failed' || body.outcome === 'snoozed'
        ? body.outcome
        : null
    if (!body.id || !outcome) {
      return json({ error: 'id and outcome (done, failed, or snoozed) required' }, 400)
    }
    await finishTaskLoop(sql, body.id, outcome, body.note, body.next_run)
    return json({ ok: true })
  }

  if (path === '/api/internal/loops/context' && req.method === 'GET') {
    if (!options.internalOk(req)) return json({ error: 'Unauthorized' }, 401)
    const phone = normalizePhone(url.searchParams.get('phone') || '')
    const kind = String(url.searchParams.get('kind') || '')
    if (!phone) return json({ error: 'valid phone required' }, 400)
    if (!kind) return json({ error: 'kind required' }, 400)
    const user = await getUserByPhone(sql, phone)
    if (!user) return json({ ok: true, data: {} })

    if (kind === 'birthday_reminder') {
      const people = (await sql`
        SELECT id, name, birthday::text AS birthday
        FROM hire_network
        WHERE user_id = ${user.id} AND birthday IS NOT NULL
          AND to_char(birthday, 'MM-DD') = substr(COALESCE(${url.searchParams.get('date') || ''}::text, ''), 6, 5)
      `) as Array<{ id: string; name: string; birthday: string }>
      return json({ ok: true, data: { people } })
    }

    if (kind === 'memory_resurface') {
      const mem = (await sql`
        SELECT key, value, updated_at::text AS "updatedAt"
        FROM hire_memories
        WHERE user_id = ${user.id}
          AND persona = ${url.searchParams.get('persona') || 'friend'}
          AND value <> ''
          AND updated_at < now() - interval '21 days'
        ORDER BY durable DESC, updated_at ASC
        LIMIT 1
      `) as Array<{ key: string; value: string; updatedAt: string }>
      return json({ ok: true, data: { memory: mem[0] || null } })
    }

    if (kind === 'streak_ended') {
      const habits = (await sql`
        SELECT id, name FROM hire_habits WHERE user_id = ${user.id}
      `) as Array<{ id: string; name: string }>
      return json({ ok: true, data: { habits } })
    }

    if (kind === 'overwork_check') {
      const tz = loopTimezone(user.timezone)
      const todayYmd = localWall(tz, new Date()).ymd
      const eight = wallTimeToUtc(todayYmd, 20, 0, tz)
      const probe = (await sql`
        SELECT
          (SELECT count(*)::int FROM hire_spending
              WHERE user_id = ${user.id} AND spent_at >= ${eight.toISOString()}::timestamptz) AS spend_n,
          (SELECT count(*)::int FROM hire_workouts
              WHERE user_id = ${user.id} AND logged_at >= ${eight.toISOString()}::timestamptz) AS workout_n,
          (SELECT count(*)::int FROM hire_nutrition_logs
              WHERE user_id = ${user.id} AND eaten_at >= ${eight.toISOString()}::timestamptz) AS nutrition_n,
          (SELECT count(*)::int FROM hire_network
              WHERE user_id = ${user.id} AND last_touch >= ${eight.toISOString()}::timestamptz) AS network_n
      `) as Array<{
        spend_n: number
        workout_n: number
        nutrition_n: number
        network_n: number
      }>
      return json({
        ok: true,
        data: {
          touches: probe[0] || { spend_n: 0, workout_n: 0, nutrition_n: 0, network_n: 0 },
          after: eight.toISOString(),
        },
      })
    }

    if (kind === 'quiet_check') {
      const tz = loopTimezone(user.timezone)
      const todayYmd = localWall(tz, new Date()).ymd
      const threeAgo = shiftDateStr(todayYmd, -3)
      const probe = (await sql`
        SELECT
          (SELECT max(last_inbound_at)::text FROM hire_roster
              WHERE user_id = ${user.id}) AS "inboundMax",
          (SELECT count(*)::int FROM hire_habit_logs
              WHERE user_id = ${user.id} AND date >= ${threeAgo}) AS habits_n,
          (SELECT count(*)::int FROM hire_nutrition_logs
              WHERE user_id = ${user.id} AND eaten_at::date >= ${threeAgo}) AS nutrition_n,
          (SELECT count(*)::int FROM hire_workouts
              WHERE user_id = ${user.id} AND logged_at::date >= ${threeAgo}) AS workouts_n,
          (SELECT count(*)::int FROM hire_spending
              WHERE user_id = ${user.id} AND spent_at::date >= ${threeAgo}) AS spend_n
      `) as Array<{
        inboundMax: string | null
        habits_n: number
        nutrition_n: number
        workouts_n: number
        spend_n: number
      }>
      return json({ ok: true, data: { probe: probe[0] || null } })
    }

    return json({ error: `unknown kind ${kind}` }, 400)
  }

  if (path === '/api/internal/loops' && req.method === 'POST') {
    if (!options.internalOk(req)) return json({ error: 'Unauthorized' }, 401)
    const body = (await req.json().catch(() => ({}))) as {
      phone?: string
      persona?: string
      loops?: string[]
    }
    const titles = (body.loops || []).map((t) => String(t).trim().slice(0, 200)).filter(Boolean)
    if (!body.phone || !isPersona(body.persona || '') || !titles.length) {
      return json({ error: 'phone, persona, and at least one loop title required' }, 400)
    }
    const user = await getUserByPhone(sql, body.phone)
    if (!user) return json({ error: 'User not found' }, 404)
    for (const title of titles) {
      const id = crypto.randomUUID()
      await sql`
        INSERT INTO hire_loops (id, user_id, persona, title, context, status)
        VALUES (${id}, ${user.id}, ${isPersona(body.persona || '') ? body.persona! : ''}, ${title}, '', 'open')
      `
    }
    return json({ ok: true, logged: true, count: titles.length })
  }

  if (path === '/api/loops' && req.method === 'GET' && url.searchParams.has('phone')) {
    const phone = normalizePhone(url.searchParams.get('phone') || '')
    if (!phone) return json({ error: 'valid phone required' }, 400)
    const rows = await sql`
      SELECT id, persona, kind, title, payload, status, next_run AS "nextRun",
             last_result AS "lastResult", created_at AS "createdAt"
      FROM hire_task_loops WHERE phone_e164 = ${phone}
      ORDER BY created_at DESC LIMIT 50
    `
    return json({ loops: rows })
  }

  if (path === '/api/loops' && req.method === 'GET') {
    const { user, error } = await resolveAuthedUser(sql, {
      token: url.searchParams.get('t') || undefined,
      session: url.searchParams.get('s') || undefined,
      email: url.searchParams.get('email') || undefined,
    })
    if (error) return error
    const rows = await sql`
      SELECT id, persona, title, context, due_at AS "dueAt", status,
             created_at AS "createdAt"
      FROM hire_loops WHERE user_id = ${user!.id}
      ORDER BY (status = 'open') DESC, created_at DESC LIMIT 50
    `
    return json({ loops: rows })
  }

  if (path === '/api/loops' && req.method === 'POST') {
    const body = (await req.json().catch(() => ({}))) as {
      token?: string
      email?: string
      persona?: string
      title?: string
      context?: string
      dueAt?: string
      phone?: string
      kind?: string
      payload?: unknown
      next_run?: string
    }
    // A body with a phone creates a proactive task loop for that hire; the
    // dashboard flow below keeps its email/token auth.
    if (body.phone) {
      const phone = normalizePhone(body.phone)
      const kind = String(body.kind || '').trim().slice(0, 60)
      if (!phone || !kind) return json({ error: 'valid phone and kind required' }, 400)
      const user = await getUserByPhone(sql, phone)
      if (!user) return json({ error: 'User not found' }, 404)
      const when = new Date(String(body.next_run || ''))
      const nextRun = Number.isNaN(when.getTime()) ? null : when.toISOString()
      const id = crypto.randomUUID()
      await sql`
        INSERT INTO hire_task_loops (id, user_id, persona, phone_e164, kind, title, payload, status, next_run)
        VALUES (${id}, ${user.id}, ${isPersona(body.persona || '') ? body.persona! : 'friend'},
          ${phone}, ${kind}, ${String(body.title || '').slice(0, 200)},
          ${JSON.stringify(body.payload ?? {})}::jsonb, 'pending', ${nextRun})
        ON CONFLICT (user_id, persona, kind) DO UPDATE SET
          title = excluded.title,
          payload = excluded.payload,
          status = 'pending',
          next_run = COALESCE(excluded.next_run, hire_task_loops.next_run),
          updated_at = now()
      `
      return json({ ok: true, id })
    }
    const title = String(body.title || '').trim().slice(0, 200)
    if (!title) return json({ error: 'title required' }, 400)
    const { user, error } = await resolveAuthedUser(sql, {
      token: body.token,
      session: (body as { session?: string }).session,
      email: body.email,
    })
    if (error) return error
    const id = crypto.randomUUID()
    const dueAt = parseFlexibleWhen(body.dueAt, user!.timezone || 'America/Los_Angeles')
    await sql`
      INSERT INTO hire_loops (id, user_id, persona, title, context, due_at)
      VALUES (${id}, ${user!.id}, ${isPersona(body.persona || '') ? body.persona! : ''},
        ${title}, ${String(body.context || '').slice(0, 500)},
        ${dueAt})
    `
    return json({ ok: true, id })
  }

  const loopToggle = path.match(/^\/api\/loops\/([^/]+)\/(pause|resume)$/)
  if (loopToggle && req.method === 'POST') {
    const body = (await req.json().catch(() => ({}))) as { phone?: string }
    const phone = normalizePhone(body.phone || '')
    if (!phone) return json({ error: 'valid phone required' }, 400)
    const rows = (await sql`
      SELECT phone_e164 AS phone FROM hire_task_loops WHERE id = ${loopToggle[1]!} LIMIT 1
    `) as Array<{ phone: string }>
    const loop = rows[0]
    if (!loop || !phonesMatch(loop.phone, phone)) return json({ error: 'Loop not found' }, 404)
    if (loopToggle[2] === 'pause') {
      await sql`
        UPDATE hire_task_loops SET status = 'paused', updated_at = now()
        WHERE id = ${loopToggle[1]!}
      `
    } else {
      // Resume means run again on the next claim pass, so bump next_run.
      await sql`
        UPDATE hire_task_loops SET status = 'pending', next_run = now(), updated_at = now()
        WHERE id = ${loopToggle[1]!}
      `
    }
    return json({ ok: true })
  }

  if (path.startsWith('/api/loops/') && req.method === 'PATCH') {
    const id = path.slice('/api/loops/'.length)
    const body = (await req.json().catch(() => ({}))) as {
      token?: string
      email?: string
      status?: string
      dueAt?: string
    }
    const status = body.status === 'done' || body.status === 'snoozed' ? body.status : 'open'
    const { user, error } = await resolveAuthedUser(sql, {
      token: body.token,
      session: (body as { session?: string }).session,
      email: body.email,
    })
    if (error) return error
    const dueAt = body.dueAt
      ? parseFlexibleWhen(body.dueAt, user!.timezone || 'America/Los_Angeles')
      : undefined
    if (dueAt) {
      await sql`
        UPDATE hire_loops SET status = ${status}, due_at = ${dueAt}, updated_at = now()
        WHERE id = ${id} AND user_id = ${user!.id}
      `
    } else {
      await sql`
        UPDATE hire_loops SET status = ${status}, updated_at = now()
        WHERE id = ${id} AND user_id = ${user!.id}
      `
    }
    return json({ ok: true })
  }

  return null
}
