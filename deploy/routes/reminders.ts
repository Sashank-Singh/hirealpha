import type { SQL } from 'bun'
import { json } from '../utils/http'
import { resolveAuthedUser } from '../auth/session'
import { getUserByPhone } from '../db/users'
import { isPersona } from '../personas'
import { nextReminderAt } from '../timezones'
import { computeIdempotencyKey, withIdempotency } from '../utils/idempotency'

export interface ReminderRouteOptions {
  internalOk: (r: Request) => boolean
}

export async function handleReminderRoutes(
  req: Request,
  sql: SQL,
  options: ReminderRouteOptions,
): Promise<Response | null> {
  const url = new URL(req.url)
  const path = url.pathname

  if (path === '/api/reminders/action' && req.method === 'POST') {
    const body = (await req.json().catch(() => ({}))) as {
      token?: string; session?: string; email?: string; id?: string; action?: string; hours?: number
    }
    const remId = String(body.id || '').slice(0, 80)
    if (!remId) return json({ error: 'id required' }, 400)
    const { user, error } = await resolveAuthedUser(sql, { token: body.token, session: (body as { session?: string }).session, email: body.email })
    if (error) return error
    if (body.action === 'done') {
      await sql`
        UPDATE hire_reminders SET status = 'sent', updated_at = now()
        WHERE id = ${remId} AND user_id = ${user!.id}
      `
      return json({ ok: true })
    }
    if (body.action === 'snooze') {
      const hours = Number(body.hours) > 0 ? Number(body.hours) : 1
      await sql`
        UPDATE hire_reminders SET scheduled_at = now() + (${hours} * interval '1 hour'), updated_at = now()
        WHERE id = ${remId} AND user_id = ${user!.id}
      `
      return json({ ok: true })
    }
    return json({ error: 'invalid action' }, 400)
  }

  // Scheduled send-on-behalf (bench50 gap: "wish mom happy birthday at
  // midnight" could only be drafted). The bot's poller claims due rows,
  // registers the target with Photon if needed, sends, and acks.
  if (path === '/api/internal/scheduled_texts' && req.method === 'POST') {
    if (!options.internalOk(req)) return json({ error: 'Unauthorized' }, 401)
    const body = (await req.json().catch(() => ({}))) as { phone?: string; to?: string; text?: string; at?: string; persona?: string }
    const at = new Date(String(body.at || ''))
    if (!body.phone || !/^\+?\d{7,15}$/.test(String(body.to || '')) || !String(body.text || '').trim()
      || !Number.isFinite(at.getTime()) || at.getTime() <= Date.now()) {
      return json({ error: 'phone, to, text and a future ISO at are required' }, 400)
    }
    const user = await getUserByPhone(sql, body.phone)
    if (!user) return json({ error: 'User not found' }, 404)
    const row = (await sql`
      INSERT INTO hire_scheduled_texts (user_id, persona, to_phone, body, send_at)
      VALUES (${user.id}, ${body.persona === 'coworker' || body.persona === 'cofounder' ? body.persona : 'friend'},
              ${String(body.to)}, ${String(body.text).trim().slice(0, 1500)}, ${at.toISOString()})
      RETURNING id::text AS id, send_at
    `)[0]
    return json({ ok: true, id: row.id, sendAt: row.send_at })
  }

  if (path === '/api/internal/scheduled_texts/claim' && req.method === 'GET') {
    if (!options.internalOk(req)) return json({ error: 'Unauthorized' }, 401)
    const persona = url.searchParams.get('persona') || 'friend'
    const rows = await sql`
      UPDATE hire_scheduled_texts SET status = 'sending'
      WHERE id IN (
        SELECT id FROM hire_scheduled_texts
        WHERE status = 'pending' AND send_at <= now() AND persona = ${persona}
        ORDER BY send_at LIMIT 3
        FOR UPDATE SKIP LOCKED
      )
      RETURNING id::text AS id, to_phone AS "toPhone", body
    `
    return json({ due: rows })
  }

  if (path === '/api/internal/scheduled_texts/ack' && req.method === 'POST') {
    if (!options.internalOk(req)) return json({ error: 'Unauthorized' }, 401)
    const body = (await req.json().catch(() => ({}))) as { id?: string; ok?: boolean; error?: string }
    if (!/^[0-9a-f-]{36}$/i.test(String(body.id || ''))) return json({ error: 'id required' }, 400)
    await sql`
      UPDATE hire_scheduled_texts
      SET status = ${body.ok ? 'sent' : 'failed'}, sent_at = now(), error = ${body.ok ? null : String(body.error || 'send failed').slice(0, 300)}
      WHERE id = ${body.id}::uuid
    `
    return json({ ok: true })
  }

  if (path === '/api/internal/reminders' && req.method === 'POST') {
    if (!options.internalOk(req)) return json({ error: 'Unauthorized' }, 401)
    const body = (await req.json().catch(() => ({}))) as {
      phone?: string
      persona?: string
      text?: string
      scheduledAt?: string
      recurrence?: string
      timezone?: string
      idempotencyKey?: string
    }
    if (!body.phone || !body.persona || !isPersona(body.persona) || !body.text?.trim()) {
      return json({ error: 'phone, persona, and text required' }, 400)
    }
    const at = new Date(body.scheduledAt || '')
    if (Number.isNaN(at.getTime())) return json({ error: 'scheduledAt required' }, 400)
    const user = await getUserByPhone(sql, body.phone)
    if (!user) return json({ error: 'User not found' }, 404)
    const recurrence = body.recurrence === 'daily' || body.recurrence === 'weekly' || body.recurrence === 'weekdays' ? body.recurrence : 'once'

    const idempotencyKey =
      body.idempotencyKey ||
      req.headers.get('idempotency-key') ||
      req.headers.get('x-idempotency-key') ||
      computeIdempotencyKey('reminder', {
        userId: user.id,
        persona: body.persona,
        text: body.text.trim(),
        scheduledAt: at.toISOString(),
        recurrence,
      })

    const { result } = await withIdempotency(idempotencyKey, async () => {
      const existing = (await sql`
        SELECT id, scheduled_at AS "scheduledAt", recurrence, text FROM hire_reminders
        WHERE user_id = ${user.id} AND persona = ${body.persona} AND text = ${body.text!.trim()}
          AND (status = 'pending' OR recurrence = ${recurrence})
        LIMIT 1
      `) as Array<{ id: string; scheduledAt: Date; recurrence: string; text: string }>

      if (existing[0]) {
        return {
          ok: true,
          deduplicated: true,
          reminder: {
            id: existing[0].id,
            scheduledAt: new Date(existing[0].scheduledAt).toISOString(),
            recurrence: existing[0].recurrence,
            text: existing[0].text,
          },
        }
      }

      const id = crypto.randomUUID()
      await sql`
        INSERT INTO hire_reminders (id, user_id, persona, text, scheduled_at, recurrence, timezone, status)
        VALUES (${id}, ${user.id}, ${body.persona}, ${body.text!.trim()}, ${at.toISOString()}, ${recurrence}, ${body.timezone || null}, 'pending')
      `
      return { ok: true, reminder: { id, scheduledAt: at.toISOString(), recurrence, text: body.text!.trim() } }
    })

    return json(result)
  }

  if (path === '/api/internal/reminders/due' && req.method === 'GET') {
    if (!options.internalOk(req)) return json({ error: 'Unauthorized' }, 401)
    const persona = url.searchParams.get('persona') || ''
    if (!isPersona(persona)) return json({ error: 'persona required' }, 400)
    const rows = await sql`
      SELECT r.id, r.user_id AS "userId", u.phone_e164 AS phone, r.text, r.scheduled_at AS "scheduledAt", r.recurrence, r.timezone
      FROM hire_reminders r
      JOIN hire_users u ON u.id = r.user_id
      WHERE r.persona = ${persona} AND r.status = 'pending' AND r.scheduled_at <= now()
      ORDER BY r.scheduled_at ASC
      LIMIT 25
    `
    const reminders = rows.map((r: { id: string; userId: string; phone: string; text: string; scheduledAt: Date; recurrence: string; timezone: string | null }) => ({
      id: r.id,
      userId: r.userId,
      phone: r.phone,
      text: r.text,
      scheduledAt: new Date(r.scheduledAt).toISOString(),
      recurrence: r.recurrence,
      timezone: r.timezone,
    }))
    return json({ reminders })
  }

  if (path === '/api/internal/reminders/list' && req.method === 'GET') {
    if (!options.internalOk(req)) return json({ error: 'Unauthorized' }, 401)
    const phone = url.searchParams.get('phone') || ''
    const persona = url.searchParams.get('persona') || ''
    if (!phone || !isPersona(persona)) return json({ error: 'phone and persona required' }, 400)
    const user = await getUserByPhone(sql, phone)
    if (!user) return json({ reminders: [] })
    const rows = await sql`
      SELECT id, text, scheduled_at AS "scheduledAt", recurrence, status, timezone
      FROM hire_reminders
      WHERE user_id = ${user.id} AND persona = ${persona}
      ORDER BY scheduled_at ASC
      LIMIT 50
    `
    return json({
      reminders: rows.map((r: { id: string; text: string; scheduledAt: Date; recurrence: string; status: string; timezone: string | null }) => ({
        id: r.id,
        text: r.text,
        scheduledAt: new Date(r.scheduledAt).toISOString(),
        recurrence: r.recurrence,
        status: r.status,
        timezone: r.timezone,
      })),
    })
  }

  const reminderDone = path.match(/^\/api\/internal\/reminders\/([^/]+)\/done$/)
  if (reminderDone && req.method === 'POST') {
    if (!options.internalOk(req)) return json({ error: 'Unauthorized' }, 401)
    const body = (await req.json().catch(() => ({}))) as { nextAt?: string; revert?: boolean }
    // Atomic claim: only a poll that updates a still-pending row wins, so an
    // overlapping poll cycle can never double-fire the same reminder.
    const rows = await sql`
      SELECT id, recurrence, timezone, scheduled_at AS "scheduledAt" FROM hire_reminders WHERE id = ${reminderDone[1]} LIMIT 1
    `
    const row = rows[0] as
      | { id: string; recurrence: string; timezone: string | null; scheduledAt: Date }
      | undefined
    if (!row) return json({ error: 'Reminder not found' }, 404)
    if (body.revert) {
      /* Send failed after the claim. The claim already advanced a recurring
       * row's scheduled_at, so returning only the status deferred the attempt a
       * whole period — a failed 8am digest came back at 8am tomorrow, and the
       * comment here claimed otherwise. A retry window of ten minutes puts the
       * occurrence back on the next poll; the send path's own backoff bounds
       * how often that can happen. */
      await sql`
        UPDATE hire_reminders
        SET status = 'pending', scheduled_at = now() + interval '10 minutes', updated_at = now()
        WHERE id = ${row.id}
      `
      return json({ ok: true, claimed: true, reverted: true })
    }
    if (row.recurrence !== 'once') {
      const ts = new Date(row.scheduledAt).toISOString()
      const tz = row.timezone || 'America/Los_Angeles'
      let nextAt =
        body.nextAt && !Number.isNaN(new Date(body.nextAt).getTime())
          ? body.nextAt
          : nextReminderAt(ts, row.recurrence, tz)
      /* Step past NOW, not past the old scheduled time. A daily digest that was
       * due three days ago (a redeploy, a stalled poll) used to advance one
       * period per claim, so the next polls each found it due again and sent
       * three copies in half a minute. */
      for (let guard = 0; guard < 400 && new Date(nextAt).getTime() <= Date.now(); guard++) {
        nextAt = nextReminderAt(nextAt, row.recurrence, tz)
      }
      const upd = await sql`
        UPDATE hire_reminders
        SET scheduled_at = ${nextAt}, updated_at = now()
        WHERE id = ${row.id} AND status = 'pending'
      `
      if (upd && (upd as { count?: number }).count === 0) {
        return json({ ok: true, claimed: false, rescheduled: false })
      }
      return json({ ok: true, claimed: true, rescheduled: true, nextAt })
    }
    const upd = await sql`
      UPDATE hire_reminders SET status = 'sent' WHERE id = ${row.id} AND status = 'pending'
    `
    if (upd && (upd as { count?: number }).count === 0) {
      return json({ ok: true, claimed: false, rescheduled: false })
    }
    return json({ ok: true, claimed: true, rescheduled: false })
  }

  if (path === '/api/internal/reminders' && req.method === 'DELETE') {
    if (!options.internalOk(req)) return json({ error: 'Unauthorized' }, 401)
    const id = url.searchParams.get('id') || ''
    if (!id) return json({ error: 'id required' }, 400)
    await sql`DELETE FROM hire_reminders WHERE id = ${id}`
    return json({ ok: true })
  }

  return null
}
