import type { SQL } from 'bun'
import { isPersona, type Persona } from '../personas'
import { json } from '../utils/http'
import { getUserByPhone, getUserByEmail } from '../db/users'
import { upsertContext, loadContext } from '../db/context'
import { nextLocalTimeUtc, localDateStrInTz } from '../timezones'
import { stripNudgeDashes } from '../nudges/formatters'
import { minutesAgo } from '../nudges/gating'
import type { EventNudge } from '../nudges/types'

export type NudgeRouteDeps = {
  internalOk: (req: Request) => boolean
  dueEventNudges: (sql: SQL, persona: Persona) => Promise<EventNudge[]>
  collectEventNudgesForUser: (
    sql: SQL,
    user: { id: string; phone: string | null; timezone: string | null; name?: string | null },
    persona: Persona,
  ) => Promise<EventNudge | null>
}

export async function handleNudgeRoutes(
  req: Request,
  sql: SQL,
  deps: NudgeRouteDeps,
): Promise<Response | null> {
  const url = new URL(req.url)
  const path = url.pathname

  if (path === '/api/internal/event-nudges' && req.method === 'GET') {
    if (!deps.internalOk(req)) return json({ error: 'Unauthorized' }, 401)
    const persona = url.searchParams.get('persona') || ''
    if (!isPersona(persona)) return json({ error: 'persona required' }, 400)
    const nudges = await deps.dueEventNudges(sql, persona)
    return json({ nudges })
  }

  if (path === '/api/internal/event-nudges/revert' && req.method === 'POST') {
    if (!deps.internalOk(req)) return json({ error: 'Unauthorized' }, 401)
    const body = (await req.json().catch(() => ({}))) as {
      phone?: string
      persona?: string
      key?: string
    }
    const persona = body.persona || ''
    if (!body.phone || !isPersona(persona) || !body.key) {
      return json({ error: 'phone, persona, and key required' }, 400)
    }
    const user = await getUserByPhone(sql, body.phone)
    if (!user) return json({ error: 'User not found' }, 404)
    await sql`
      DELETE FROM hire_nudge_log
      WHERE user_id = ${user.id} AND persona = ${persona} AND nudge_key = ${body.key}
    `
    // Inbox-keyed nudges: a failed send re-pends the row so the next poll
    // retries instead of silently dropping the trigger event.
    if (String(body.key).startsWith('evt:')) {
      await sql`
        UPDATE hire_event_inbox SET status = 'pending', sent_at = NULL
        WHERE user_id = ${user.id} AND key = ${String(body.key).slice(0, 220)} AND status = 'sent'
      `
    }
    return json({ ok: true })
  }

  if (path === '/api/internal/event-nudges/ack' && req.method === 'POST') {
    if (!deps.internalOk(req)) return json({ error: 'Unauthorized' }, 401)
    const body = (await req.json().catch(() => ({}))) as { key?: string }
    if (!body.key) return json({ error: 'key required' }, 400)
    await sql`
      UPDATE hire_event_inbox SET status = 'sent', sent_at = now()
      WHERE key = ${String(body.key).slice(0, 220)} AND status = 'pending'
    `
    return json({ ok: true })
  }

  if (path === '/api/internal/events/webhook' && req.method === 'POST') {
    if (!deps.internalOk(req)) return json({ error: 'Unauthorized' }, 401)
    const body = (await req.json().catch(() => ({}))) as {
      phone?: string
      email?: string
      persona?: string
      eventType?: string
      key?: string
      title?: string
      text?: string
      urgent?: boolean
    }
    const persona = body.persona || 'friend'
    if ((!body.phone && !body.email) || !isPersona(persona)) {
      return json({ error: 'phone or email, and persona required' }, 400)
    }
    const user = body.phone
      ? await getUserByPhone(sql, body.phone)
      : await getUserByEmail(sql, String(body.email).toLowerCase())
    if (!user) return json({ error: 'User not found' }, 404)
    if (body.text) {
      const key = body.key ? `evt:${String(body.key).slice(0, 200)}` : `evt:${crypto.randomUUID()}`
      const inserted = await sql`
        INSERT INTO hire_event_inbox (id, user_id, persona, topic, key, text, urgent)
        VALUES (${crypto.randomUUID()}, ${user.id}, ${persona},
          ${String(body.eventType || 'webhook_event').slice(0, 60)}, ${key},
          ${stripNudgeDashes(String(body.text)).slice(0, 500)}, ${body.urgent === true})
        ON CONFLICT (key) DO NOTHING
        RETURNING id
      `
      return json({ ok: true, queued: !!inserted[0], key })
    }
    const nudge = await deps.collectEventNudgesForUser(sql, user, persona)
    return json({ ok: true, nudge })
  }

  if (path === '/api/internal/proactive' && req.method === 'POST') {
    if (!deps.internalOk(req)) return json({ error: 'Unauthorized' }, 401)
    const body = (await req.json().catch(() => ({}))) as {
      phone?: string
      persona?: string
      proactive?: string
      quietHours?: string
      pausedUntil?: string | null
      pauseToday?: boolean
    }
    const persona = body.persona || ''
    if (!body.phone || !isPersona(persona)) {
      return json({ error: 'phone and persona required' }, 400)
    }
    const user = await getUserByPhone(sql, body.phone)
    if (!user) return json({ error: 'User not found' }, 404)
    const patch: Record<string, unknown> = {}
    const mode = String(body.proactive || '').toLowerCase()
    if (mode === 'on' || mode === 'paused' || mode === 'off') patch.proactive = mode
    const quiet = String(body.quietHours || '').trim()
    if (/^\d{1,2}:\d{2}\s*-\s*\d{1,2}:\d{2}$/.test(quiet)) {
      patch.quiet_hours = quiet.replace(/\s+/g, '')
    }
    if (body.pausedUntil === null || body.pausedUntil === '') {
      patch.paused_until = ''
    } else if (body.pausedUntil && !Number.isNaN(new Date(body.pausedUntil).getTime())) {
      patch.paused_until = new Date(body.pausedUntil).toISOString()
    }
    if (mode === 'on' || mode === 'off') patch.paused_until = ''
    if (body.pauseToday) {
      patch.proactive = 'paused'
      const tz = user.timezone || 'America/Los_Angeles'
      patch.paused_until = nextLocalTimeUtc(tz, 0, 0)
    }
    const fields = await upsertContext(sql, user.id, persona, patch)
    return json({
      ok: true,
      proactive: fields.proactive || 'on',
      quietHours: fields.quiet_hours || '22:00-08:00',
      pausedUntil: fields.paused_until || null,
    })
  }

  if (path === '/api/internal/last-proactive' && req.method === 'GET') {
    if (!deps.internalOk(req)) return json({ error: 'Unauthorized' }, 401)
    const phone = url.searchParams.get('phone') || ''
    const persona = url.searchParams.get('persona') || ''
    if (!phone || !isPersona(persona)) return json({ error: 'phone and persona required' }, 400)
    const user = await getUserByPhone(sql, phone)
    if (!user) return json({ error: 'User not found' }, 404)
    const fields = await loadContext(sql, user.id, persona)
    return json({
      topic: fields.last_proactive_topic || null,
      minutesAgo: minutesAgo(fields.last_proactive_at),
    })
  }

  if (path === '/api/internal/proactive/sent' && req.method === 'POST') {
    if (!deps.internalOk(req)) return json({ error: 'Unauthorized' }, 401)
    const body = (await req.json().catch(() => ({}))) as {
      phone?: string
      persona?: string
      topic?: string
      freeze?: boolean
    }
    const persona = body.persona || ''
    if (!body.phone || !isPersona(persona)) {
      return json({ error: 'phone and persona required' }, 400)
    }
    const user = await getUserByPhone(sql, body.phone)
    if (!user) return json({ error: 'User not found' }, 404)
    const tz = user.timezone || 'America/Los_Angeles'
    const today = localDateStrInTz(new Date(), tz)
    const fields = await loadContext(sql, user.id, persona)
    if (body.freeze) {
      await upsertContext(sql, user.id, persona, {
        unanswered_proactive: '2',
        last_proactive_topic: 'blocked',
      })
      return json({ ok: true, frozen: true })
    }
    const prevUnanswered = Math.max(0, Number(fields.unanswered_proactive) || 0)
    const sameDay = String(fields.last_proactive_day || '') === today
    const dayCount = sameDay ? Math.max(0, Number(fields.unanswered_day_count) || 0) : 0
    await upsertContext(sql, user.id, persona, {
      last_proactive_at: new Date().toISOString(),
      last_proactive_topic: String(body.topic || 'check_in').slice(0, 40),
      last_proactive_day: today,
      unanswered_proactive: String(prevUnanswered + 1),
      unanswered_day_count: String(dayCount + 1),
    })
    return json({ ok: true })
  }

  return null
}
