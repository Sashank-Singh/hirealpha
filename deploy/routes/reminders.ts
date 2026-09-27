import type { SQL } from 'bun'
import { json } from '../utils/http'
import { resolveAuthedUser } from '../auth/session'
import { getUserByPhone } from '../db/users'
import { isPersona } from '../personas'
import { nextReminderAt } from '../timezones'
import { computeIdempotencyKey, withIdempotency } from '../utils/idempotency'
import { readGmailThreadExact } from '../connectors/hub'

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

  if (path === '/api/internal/email_followups' && req.method === 'POST') {
    if (!options.internalOk(req)) return json({ error: 'Unauthorized' }, 401)
    const body = (await req.json().catch(() => ({}))) as { phone?: string; persona?: string; threadId?: string; expectedParticipant?: string; deadline?: string }
    const deadline = new Date(String(body.deadline || ''))
    if (!body.phone || !isPersona(body.persona || '') || !body.threadId || !body.expectedParticipant || !Number.isFinite(deadline.getTime())) return json({ error: 'phone, persona, threadId, expectedParticipant and deadline required' }, 400)
    const user = await getUserByPhone(sql, body.phone); if (!user) return json({ error: 'User not found' }, 404)
    const id = crypto.randomUUID()
    await sql.begin(async (tx) => {
      await tx`INSERT INTO hire_email_followups (id,user_id,persona,gmail_thread_id,expected_participant,deadline) VALUES (${id},${user.id},${body.persona},${body.threadId},${body.expectedParticipant},${deadline.toISOString()})`
      await tx`INSERT INTO hire_task_loops (id,user_id,persona,phone_e164,kind,title,payload,status,next_run) VALUES (${crypto.randomUUID()},${user.id},${body.persona},${body.phone},'email_followup',${`Reply from ${body.expectedParticipant}`},${JSON.stringify({ followupId: id })}::jsonb,'pending',${deadline.toISOString()})`
    })
    return json({ ok: true, followup: { id, threadId: body.threadId, expectedParticipant: body.expectedParticipant, deadline: deadline.toISOString(), status: 'pending' } })
  }

  if (path === '/api/internal/email_followups/evaluate' && req.method === 'POST') {
    if (!options.internalOk(req)) return json({ error: 'Unauthorized' }, 401)
    const body = (await req.json().catch(() => ({}))) as { id?: string }
    const rows = await sql`SELECT id,user_id AS "userId",gmail_thread_id AS "threadId",expected_participant AS "expectedParticipant",created_at AS "createdAt",status FROM hire_email_followups WHERE id=${body.id} LIMIT 1`
    const row = rows[0] as { id: string; userId: string; threadId: string; expectedParticipant: string; createdAt: Date; status: string } | undefined
    if (!row || row.status !== 'pending') return json({ ok: false, state: 'stale', error: 'Follow-up is no longer pending.' }, 409)
    const thread = await readGmailThreadExact(sql, row.userId, row.threadId)
    if (!thread.status.startsWith('success_')) {
      await sql`UPDATE hire_email_followups SET status='needs_reconciliation',last_error=${thread.status},updated_at=now() WHERE id=${row.id}`
      return json({ ok: true, state: 'needs_reconciliation', text: `I could not check that exact Gmail thread because the read failed (${thread.status}). Reconnect Gmail if needed, then ask me to check the same follow-up again.` })
    }
    const expected = row.expectedParticipant.toLowerCase()
    const replied = thread.messages.some((m) => new Date(m.date).getTime() > new Date(row.createdAt).getTime() && m.from.toLowerCase().includes(expected) && !/no-?reply|automated|mailer-daemon/i.test(m.from))
    await sql`UPDATE hire_email_followups SET status=${replied ? 'resolved' : 'due'},updated_at=now() WHERE id=${row.id}`
    return json({ ok: true, state: replied ? 'resolved' : 'due', text: replied ? '' : `${row.expectedParticipant} has not replied in the selected Gmail thread. Want me to prepare a follow-up?` })
  }

  const followupMutation = path.match(/^\/api\/internal\/email_followups\/([^/]+)$/)
  if (followupMutation && (req.method === 'PATCH' || req.method === 'DELETE')) {
    if (!options.internalOk(req)) return json({ error: 'Unauthorized' }, 401)
    const body = (await req.json().catch(() => ({}))) as { phone?: string; deadline?: string }
    const user = await getUserByPhone(sql, String(body.phone || '')); if (!user) return json({ error: 'User not found' }, 404)
    if (req.method === 'DELETE') await sql`UPDATE hire_email_followups SET status='cancelled',updated_at=now() WHERE id=${followupMutation[1]} AND user_id=${user.id}`
    else {
      const deadline = new Date(String(body.deadline || '')); if (!Number.isFinite(deadline.getTime())) return json({ error: 'deadline required' }, 400)
      await sql`UPDATE hire_email_followups SET deadline=${deadline.toISOString()},status='pending',updated_at=now() WHERE id=${followupMutation[1]} AND user_id=${user.id}`
      await sql`UPDATE hire_task_loops SET next_run=${deadline.toISOString()},status='pending',updated_at=now() WHERE user_id=${user.id} AND kind='email_followup' AND payload->>'followupId'=${followupMutation[1]}`
    }
    const rows = await sql`SELECT id,gmail_thread_id AS "threadId",expected_participant AS "expectedParticipant",deadline,status FROM hire_email_followups WHERE id=${followupMutation[1]} AND user_id=${user.id}`
    return rows[0] ? json({ ok: true, followup: rows[0] }) : json({ error: 'Follow-up not found' }, 404)
  }

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
    const persona = body.persona === 'coworker' || body.persona === 'cofounder' ? body.persona : 'friend'
    const text = String(body.text).trim().slice(0, 1500)
    const idempotencyKey = req.headers.get('idempotency-key') || computeIdempotencyKey('scheduled_text', {
      userId: user.id, persona, to: String(body.to), text, at: at.toISOString(),
    })
    const row = (await sql`
      INSERT INTO hire_scheduled_texts (user_id, persona, to_phone, body, send_at, idempotency_key)
      VALUES (${user.id}, ${body.persona === 'coworker' || body.persona === 'cofounder' ? body.persona : 'friend'},
              ${String(body.to)}, ${text}, ${at.toISOString()}, ${idempotencyKey})
      ON CONFLICT (idempotency_key) WHERE idempotency_key IS NOT NULL DO UPDATE
        SET idempotency_key = excluded.idempotency_key
      RETURNING id::text AS id, send_at
    `)[0]
    return json({ ok: true, id: row.id, sendAt: row.send_at })
  }

  if (path === '/api/internal/scheduled_texts/claim' && req.method === 'GET') {
    if (!options.internalOk(req)) return json({ error: 'Unauthorized' }, 401)
    const persona = url.searchParams.get('persona') || 'friend'
    const rows = await sql`
      WITH expired_preparing AS (
        UPDATE hire_scheduled_texts SET status = 'pending', lease_until = NULL, claim_token = NULL,
          error = 'worker lease expired before provider send', updated_at = now()
        WHERE status = 'preparing' AND lease_until < now()
      ), expired_sending AS (
        UPDATE hire_scheduled_texts SET status = 'outcome_unknown', lease_until = NULL,
          error = 'provider send may have committed before worker acknowledgment', updated_at = now()
        WHERE status = 'sending' AND lease_until < now()
      )
      UPDATE hire_scheduled_texts SET status = 'preparing', lease_until = now() + interval '5 minutes',
        claim_token = gen_random_uuid(), attempt_count = attempt_count + 1, updated_at = now()
      WHERE id IN (
        SELECT id FROM hire_scheduled_texts
        WHERE status = 'pending' AND send_at <= now() AND persona = ${persona}
        ORDER BY send_at LIMIT 3
        FOR UPDATE SKIP LOCKED
      )
      RETURNING id::text AS id, claim_token::text AS "claimToken", to_phone AS "toPhone", body,
        (SELECT phone_e164 FROM hire_users WHERE id = hire_scheduled_texts.user_id) AS "ownerPhone"
    `
    return json({ due: rows })
  }

  if (path === '/api/internal/scheduled_texts/begin' && req.method === 'POST') {
    if (!options.internalOk(req)) return json({ error: 'Unauthorized' }, 401)
    const body = (await req.json().catch(() => ({}))) as { id?: string; claimToken?: string }
    if (!/^[0-9a-f-]{36}$/i.test(String(body.id || '')) || !/^[0-9a-f-]{36}$/i.test(String(body.claimToken || ''))) {
      return json({ error: 'id and claimToken required' }, 400)
    }
    const rows = await sql`
      UPDATE hire_scheduled_texts SET status = 'sending', lease_until = now() + interval '5 minutes', updated_at = now()
      WHERE id = ${String(body.id || '')}::uuid AND claim_token = ${String(body.claimToken || '')}::uuid
        AND status = 'preparing' AND lease_until > now()
      RETURNING id
    `
    return rows.length ? json({ ok: true }) : json({ error: 'claim lease is no longer valid' }, 409)
  }

  if (path === '/api/internal/scheduled_texts/ack' && req.method === 'POST') {
    if (!options.internalOk(req)) return json({ error: 'Unauthorized' }, 401)
    const body = (await req.json().catch(() => ({}))) as { id?: string; claimToken?: string; ok?: boolean; error?: string; providerId?: string }
    if (!/^[0-9a-f-]{36}$/i.test(String(body.id || '')) || !/^[0-9a-f-]{36}$/i.test(String(body.claimToken || ''))) return json({ error: 'id and claimToken required' }, 400)
    const rows = await sql`
      UPDATE hire_scheduled_texts
      SET status = ${body.ok ? 'sent' : 'failed'}, sent_at = CASE WHEN ${Boolean(body.ok)} THEN now() ELSE sent_at END,
        error = ${body.ok ? null : String(body.error || 'send failed').slice(0, 300)},
        provider_delivery_id = COALESCE(${body.providerId ? String(body.providerId).slice(0, 200) : null}, provider_delivery_id),
        lease_until = NULL, updated_at = now()
      WHERE id = ${body.id}::uuid AND claim_token = ${String(body.claimToken || '')}::uuid AND status = 'sending'
      RETURNING id
    `
    return rows.length ? json({ ok: true }) : json({ error: 'delivery outcome is no longer claimable' }, 409)
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
        SELECT id, scheduled_at AS "scheduledAt", recurrence, text, status FROM hire_reminders
        WHERE user_id = ${user.id} AND persona = ${body.persona} AND text = ${body.text!.trim()}
          AND status = 'pending' AND scheduled_at = ${at.toISOString()} AND recurrence = ${recurrence}
        LIMIT 1
      `) as Array<{ id: string; scheduledAt: Date; recurrence: string; text: string; status: string }>

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

  const reminderMutation = path.match(/^\/api\/internal\/reminders\/([^/]+)$/)
  if (reminderMutation && (req.method === 'PATCH' || req.method === 'DELETE')) {
    if (!options.internalOk(req)) return json({ error: 'Unauthorized' }, 401)
    const body = (await req.json().catch(() => ({}))) as { phone?: string; persona?: string; scheduledAt?: string; scope?: string }
    if (!body.phone || !isPersona(body.persona || '')) return json({ error: 'phone and persona required' }, 400)
    const user = await getUserByPhone(sql, body.phone)
    if (!user) return json({ error: 'User not found' }, 404)
    const id = reminderMutation[1]!
    const current = (await sql`
      SELECT id, text, scheduled_at AS "scheduledAt", recurrence, status, timezone
      FROM hire_reminders WHERE id = ${id} AND user_id = ${user.id} AND persona = ${body.persona} LIMIT 1
    `) as Array<{ id: string; text: string; scheduledAt: Date; recurrence: string; status: string; timezone: string | null }>
    if (!current[0]) return json({ error: 'Reminder not found or selection is stale' }, 404)
    if (req.method === 'PATCH') {
      const at = new Date(String(body.scheduledAt || ''))
      if (!Number.isFinite(at.getTime()) || at.getTime() <= Date.now()) return json({ error: 'future scheduledAt required' }, 400)
      await sql`UPDATE hire_reminders SET scheduled_at = ${at.toISOString()}, status = 'pending', updated_at = now() WHERE id = ${id} AND user_id = ${user.id}`
    } else if (body.scope === 'occurrence' && current[0].recurrence !== 'once') {
      const nextAt = nextReminderAt(new Date(current[0].scheduledAt).toISOString(), current[0].recurrence, current[0].timezone || 'America/Los_Angeles')
      await sql`UPDATE hire_reminders SET scheduled_at = ${nextAt}, updated_at = now() WHERE id = ${id} AND user_id = ${user.id}`
    } else {
      await sql`UPDATE hire_reminders SET status = 'cancelled', updated_at = now() WHERE id = ${id} AND user_id = ${user.id}`
    }
    const rows = await sql`
      SELECT id, text, scheduled_at AS "scheduledAt", recurrence, status, timezone
      FROM hire_reminders WHERE id = ${id} AND user_id = ${user.id} LIMIT 1
    `
    const row = rows[0] as { id: string; text: string; scheduledAt: Date; recurrence: string; status: string; timezone: string | null }
    return json({ reminder: { ...row, scheduledAt: new Date(row.scheduledAt).toISOString() } })
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
