import type { SQL } from 'bun'
import { json } from '../utils/http'
import { getUserByPhone } from '../db/users'
import { isPersona, PERSONA_DENIED, type Persona } from '../personas'
import { resolveAuthedUser } from '../auth/session'
import {
  buildNextStack,
  isAutomatedSender,
  isAutomatedSubject,
  assembleAutoStandup,
  loadBusyBlocks,
  suggestSlotsFromBusy,
  parseLinearIssues,
  scoreLinearIssues,
  listLinearIssues,
  linearWrite,
} from '../work/stack'
import { buildPrepBundle, buildMeetingPrep } from '../work/prep'
import { googleAccessToken, startOfLocalDay, composioFirst } from '../connectors/hub'
import {
  googleEventsRaw,
  findFreeSlots,
  calendarHold,
  gmailSendMessage,
  gmailCreateDraft,
  localHourParts,
} from '../google/actions'
import {
  COMPOSIO_READ,
  COMPOSIO_WRITE,
  writeConnector,
  composioLooksFailed,
} from '../composioPlugins'
import { investorNoteBody } from './pipeline'
import { pickUserTimezone, localDateStrInTz } from '../timezones'
import { clampNum } from '../habits/parsers'
import { extractJsonObject } from '../modelJson'

export async function suggestedMailDrafts(sql: SQL, userId: string) {
  const access = await googleAccessToken(sql, userId, 'gmail')
  if (!access) return [] as Array<{ toAddr: string; subject: string; body: string; threadId: string; inReplyTo: string }>
  const listUrl = new URL('https://gmail.googleapis.com/gmail/v1/users/me/messages')
  listUrl.searchParams.set('maxResults', '5')
  listUrl.searchParams.set('q', 'is:unread newer_than:5d')
  const list = await fetch(listUrl, { headers: { Authorization: `Bearer ${access}` } })
  if (!list.ok) return []
  const data = (await list.json()) as { messages?: Array<{ id: string; threadId?: string }> }
  const out: Array<{ toAddr: string; subject: string; body: string; threadId: string; inReplyTo: string }> = []
  for (const m of (data.messages || []).slice(0, 3)) {
    /* Message-ID and threadId ride along, because a suggested REPLY that carries
     * neither starts a brand-new conversation: live, 2026-09-19, the founder
     * pressed Send on a drafted reply and it "happens to start a new thread".
     * The reply-draft path (`kind: 'reply'`) already threads properly through
     * `gmailReplyMeta`; the auto-suggestions did not, and they are what the card
     * usually shows. */
    const got = await fetch(
      `https://gmail.googleapis.com/gmail/v1/users/me/messages/${m.id}?format=metadata&metadataHeaders=Subject&metadataHeaders=From&metadataHeaders=Message-ID`,
      { headers: { Authorization: `Bearer ${access}` } },
    )
    if (!got.ok) continue
    const msg = (await got.json()) as {
      snippet?: string
      threadId?: string
      payload?: { headers?: Array<{ name: string; value: string }> }
    }
    const h = (n: string) => msg.payload?.headers?.find((x) => x.name.toLowerCase() === n.toLowerCase())?.value || ''
    const from = h('From')
    const email = from.match(/<([^>]+)>/)?.[1] || from
    const subject = h('Subject') || '(no subject)'
    if (!email) continue
    // Never suggest a reply to a machine, or to a machine-shaped subject —
    // "Re: Assessment submitted" addressed to do-not-reply@ was the junk that
    // filled the work home.
    if (isAutomatedSender(email) || isAutomatedSubject(subject)) continue
    out.push({
      toAddr: email,
      subject: subject.startsWith('Re:') ? subject : `Re: ${subject}`,
      body: '',
      threadId: msg.threadId || m.threadId || '',
      inReplyTo: h('Message-ID') || h('Message-Id'),
    })
  }
  return out
}

export interface WorkRouteOptions {
  internalOk: (r: Request) => boolean
  connectedForUser: (sql: SQL, userId: string) => Promise<string[]>
  livePayload?: (sql: SQL, phone: string, persona: Persona) => Promise<{ found: boolean; hired: boolean; userId?: string; name?: string | null; timezone?: string | null }>
}

export async function handleWorkRoutes(
  req: Request,
  sql: SQL,
  options: WorkRouteOptions,
): Promise<Response | null> {
  const url = new URL(req.url)
  const path = url.pathname

  if (path === '/api/internal/prep' && req.method === 'POST') {
    if (!options.internalOk(req)) return json({ error: 'Unauthorized' }, 401)
    const body = (await req.json().catch(() => ({}))) as {
      phone?: string
      persona?: string
      query?: string
    }
    if (!body.phone || !body.persona || !isPersona(body.persona)) {
      return json({ error: 'phone and persona required' }, 400)
    }
    if (!options.livePayload) return json({ ok: false, error: 'livePayload unavailable' }, 500)
    const live = await options.livePayload(sql, body.phone, body.persona)
    if (!live.found || !live.hired || !live.userId) return json({ ok: false, error: 'not hired' }, 404)
    const bundle = await buildPrepBundle(
      sql,
      { id: live.userId, name: live.name, timezone: live.timezone ?? null },
      String(body.query || ''),
    )
    if (!bundle) return json({ ok: false, text: '' })
    return json({ ok: true, ...bundle })
  }

  if (path === '/api/work/next' && req.method === 'GET') {
    const persona = url.searchParams.get('persona') || ''
    if (!isPersona(persona)) return json({ error: 'persona required' }, 400)
    const { user, error } = await resolveAuthedUser(sql, {
      token: url.searchParams.get('t') || undefined,
      session: url.searchParams.get('s') || undefined,
      email: url.searchParams.get('email') || undefined,
    })
    if (error) return error
    try {
      return json(await buildNextStack(sql, user!, persona))
    } catch (err) {
      console.warn('[work/next] failed', err)
      return json({ items: [], connected: [], missing: ['gmail', 'calendar'], error: 'Could not load Next.' }, 200)
    }
  }

  if (path === '/api/prep' && req.method === 'POST') {
    const body = (await req.json().catch(() => ({}))) as {
      token?: string; session?: string; email?: string; name?: string
    }
    const query = String(body.name || '').trim().slice(0, 80)
    if (!query) return json({ error: 'name required' }, 400)
    const { user, error } = await resolveAuthedUser(sql, { token: body.token, session: (body as { session?: string }).session, email: body.email })
    if (error) return error
    const bundle = await buildPrepBundle(
      sql,
      { id: user!.id, name: user!.name, timezone: user!.timezone },
      query,
    )
    if (!bundle) return json({ ok: false, text: '' })
    return json({ ok: true, ...bundle })
  }

  if (path === '/api/work/drafts' && req.method === 'GET') {
    const persona = url.searchParams.get('persona') || ''
    const kind = url.searchParams.get('kind') || ''
    const { user, error } = await resolveAuthedUser(sql, {
      token: url.searchParams.get('t') || undefined,
      session: url.searchParams.get('s') || undefined,
      email: url.searchParams.get('email') || undefined,
    })
    if (error) return error
    const connected = await options.connectedForUser(sql, user!.id)
    /* Suggested drafts used to pile up forever: an empty-body suggestion stayed
     * "pending" after its email left the inbox window, and concurrent page
     * loads raced the "no pending drafts" check below and inserted the same
     * batch twice, which is how a quiet inbox showed eleven drafts. Expire
     * stale suggestions first, and never write a suggestion that already has a
     * pending twin. */
    await sql`
      UPDATE hire_drafts SET status = 'canceled', updated_at = now()
      WHERE user_id = ${user!.id} AND kind = 'email' AND status = 'pending'
        AND body = '' AND created_at < now() - interval '7 days'
    `
    const drafts = (await sql`
      SELECT id, kind, to_addr AS "toAddr", subject, body, status, created_at AS "createdAt",
        thread_id AS "threadId", in_reply_to AS "inReplyTo", start_at AS "startAt", end_at AS "endAt"
      FROM hire_drafts WHERE user_id = ${user!.id}
      ${kind ? sql`AND kind = ${kind}` : sql``}
      ORDER BY created_at DESC LIMIT 20
    `) as Array<{
      id: string; kind: string; toAddr: string; subject: string; body: string; status: string; createdAt: Date
      threadId?: string; inReplyTo?: string; startAt?: string; endAt?: string
    }>
    let rows = drafts.filter((d) => !isAutomatedSender(d.toAddr) && !isAutomatedSubject(d.subject))
    if (kind !== 'event' && !rows.some((d) => d.status === 'pending')) {
      const suggested = await suggestedMailDrafts(sql, user!.id)
      for (const s of suggested) {
        // One atomic statement: concurrent page loads each pass the
        // "no pending drafts" check above, so the twin check must live
        // inside the insert or the pile grows again.
        const id = crypto.randomUUID()
        const inserted = await sql`
          INSERT INTO hire_drafts (id, user_id, persona, kind, to_addr, subject, body, thread_id, in_reply_to)
          SELECT ${id}, ${user!.id}, ${isPersona(persona) ? persona : ''}, 'email',
            ${s.toAddr}, ${s.subject}, ${s.body}, ${s.threadId || ''}, ${s.inReplyTo || ''}
          WHERE NOT EXISTS (
            SELECT 1 FROM hire_drafts
            WHERE user_id = ${user!.id} AND status = 'pending'
              AND lower(to_addr) = lower(${s.toAddr}) AND lower(subject) = lower(${s.subject})
          )
          RETURNING id
        `
        if (!inserted.length) continue
      }
      if (suggested.length) {
        rows = (await sql`
          SELECT id, kind, to_addr AS "toAddr", subject, body, status, created_at AS "createdAt",
            thread_id AS "threadId", in_reply_to AS "inReplyTo", start_at AS "startAt", end_at AS "endAt"
          FROM hire_drafts WHERE user_id = ${user!.id}
          ORDER BY created_at DESC LIMIT 20
        `) as typeof drafts
      }
    }
    const investorDraft = kind === 'investor' || persona === 'cofounder'
      ? { subject: 'Investor update', body: await investorNoteBody(sql, user!.id) }
      : undefined
    return json({
      drafts: rows,
      needConnect: !connected.includes('gmail'),
      investorDraft,
    })
  }

  if (path === '/api/work/drafts' && req.method === 'POST') {
    const body = (await req.json().catch(() => ({}))) as {
      token?: string; session?: string; email?: string; persona?: string
      kind?: string; toAddr?: string; subject?: string; body?: string
    }
    const { user, error } = await resolveAuthedUser(sql, { token: body.token, session: (body as { session?: string }).session, email: body.email })
    if (error) return error
    const id = crypto.randomUUID()
    await sql`
      INSERT INTO hire_drafts (id, user_id, persona, kind, to_addr, subject, body)
      VALUES (
        ${id}, ${user!.id}, ${isPersona(body.persona || '') ? body.persona! : ''},
        ${String(body.kind || 'email').slice(0, 40)},
        ${String(body.toAddr || '').slice(0, 200)},
        ${String(body.subject || '').slice(0, 200)},
        ${String(body.body || '').slice(0, 8000)}
      )
    `
    return json({ ok: true, id })
  }

  if (path === '/api/work/send' && req.method === 'POST') {
    const body = (await req.json().catch(() => ({}))) as {
      token?: string; session?: string; email?: string; id?: string
      toAddr?: string; subject?: string; body?: string
    }
    const { user, error } = await resolveAuthedUser(sql, { token: body.token, session: (body as { session?: string }).session, email: body.email })
    if (error) return error
    let toAddr = String(body.toAddr || '').trim()
    let subject = String(body.subject || '').trim()
    let text = String(body.body || '')
    let threadId = ''
    let inReplyTo = ''
    if (body.id) {
      const rows = await sql`
        SELECT to_addr, subject, body, thread_id, in_reply_to, status FROM hire_drafts WHERE id = ${body.id} AND user_id = ${user!.id} LIMIT 1
      `
      const row = rows[0] as {
        to_addr: string; subject: string; body: string; thread_id?: string; in_reply_to?: string; status?: string
      } | undefined
      /* A draft that has already gone is never transmitted again. The status
       * was written but never read, so a second press — or a stale card left
       * open behind the thread — sent the same email again. Live, 2026-09-19:
       * the founder's own test send, where the button stayed live after
       * "It went". */
      if (row?.status === 'sent') return json({ ok: true, alreadySent: true })
      if (row) {
        toAddr = toAddr || row.to_addr
        subject = subject || row.subject
        text = text || row.body
        threadId = row.thread_id || ''
        inReplyTo = row.in_reply_to || ''
      }
    }
    if (!toAddr || !subject) return json({ ok: false, error: 'To and subject required' }, 400)
    const sent = await gmailSendMessage(sql, user!.id, {
      to: toAddr,
      subject,
      body: text,
      threadId: threadId || undefined,
      inReplyTo: inReplyTo || undefined,
    })
    if (!sent.ok) return json({ ok: false, error: sent.error }, 400)
    if (body.id) {
      await sql`UPDATE hire_drafts SET status = 'sent', updated_at = now() WHERE id = ${body.id} AND user_id = ${user!.id}`
    }
    return json({ ok: true })
  }

  /* Save the draft into Gmail's Drafts folder. Deliberately a different path
   * from /api/work/send: nothing here can transmit, so the compose screen's
   * safe default action can never fire an email. */
  // AI-drafted new email: the user names the recipient + what it's about,
  // the model writes the draft, the client shows it for edits before the
  // normal two-click send. Same approve flow as reply drafts.
  if (path === '/api/work/draft/new' && req.method === 'POST') {
    const body = (await req.json().catch(() => ({}))) as {
      token?: string; session?: string; email?: string; persona?: string
      to?: string; about?: string
    }
    const { user, error } = await resolveAuthedUser(sql, { token: body.token, session: (body as { session?: string }).session, email: body.email })
    if (error) return error
    const to = String(body.to || '').trim().slice(0, 200)
    const about = String(body.about || '').trim().slice(0, 600)
    if (!/^[^\s@]+[^\s@]*@[^\s@]+\.[^\s@]+$/.test(to)) return json({ error: 'A valid recipient email is needed.' }, 400)
    if (about.length < 3) return json({ error: 'Say what the email is about.' }, 400)
    const { gmiChat } = await import('../../spectrum/shared/gmi')
    const name = user!.name ? ` The user's name is ${user!.name}.` : ''
    let subject = ''
    let text = ''
    try {
      const raw = await gmiChat({
        temperature: 0.4,
        maxTokens: 500,
        messages: [
          {
            role: 'system',
            content:
              'You draft short emails for the user. Given a recipient and what the email is about, write the email. ' +
              'Plain text only, no markdown, no signatures, no placeholders like [Name]. Keep it under 130 words unless the ask clearly needs more. ' +
              'Human, warm, direct. Match the intent (introduction, follow-up, application, question, RSVP).' + name +
              ' Reply with JSON only: {"subject":"...","body":"..."} — the body is the full email text.',
          },
          { role: 'user', content: `To: ${to}\nAbout: ${about}` },
        ],
      })
      const parsed = extractJsonObject(raw, ['subject', 'body'])
      subject = String(parsed?.subject || '').slice(0, 200)
      text = String(parsed?.body || '').slice(0, 6000)
    } catch {
      return json({ error: 'The draft writer is unreachable right now. Try again in a moment.' }, 502)
    }
    if (!subject || !text) return json({ error: 'The draft came back empty. Try rephrasing the ask.' }, 502)
    const id = crypto.randomUUID()
    await sql`
      INSERT INTO hire_drafts (id, user_id, persona, kind, to_addr, subject, body, status)
      VALUES (${id}, ${user!.id}, ${body.persona && isPersona(body.persona) ? body.persona : 'friend'}, 'email', ${to}, ${subject}, ${text}, 'pending')
    `
    return json({ ok: true, id, to, subject, body: text })
  }

  if (path === '/api/work/draft/save' && req.method === 'POST') {
    const body = (await req.json().catch(() => ({}))) as {
      token?: string; session?: string; email?: string; id?: string
      toAddr?: string; subject?: string; body?: string
    }
    const { user, error } = await resolveAuthedUser(sql, { token: body.token, session: (body as { session?: string }).session, email: body.email })
    if (error) return error
    let toAddr = String(body.toAddr || '').trim()
    let subject = String(body.subject || '').trim()
    let text = String(body.body || '')
    let threadId = ''
    if (body.id) {
      const rows = await sql`
        SELECT to_addr, subject, body, thread_id FROM hire_drafts WHERE id = ${body.id} AND user_id = ${user!.id} LIMIT 1
      `
      const row = rows[0] as { to_addr: string; subject: string; body: string; thread_id?: string } | undefined
      if (row) {
        toAddr = toAddr || row.to_addr
        subject = subject || row.subject
        text = text || row.body
        threadId = row.thread_id || ''
      }
    }
    if (!toAddr) return json({ ok: false, error: 'To is required' }, 400)
    const saved = await gmailCreateDraft(sql, user!.id, {
      to: toAddr,
      subject,
      body: text,
      threadId: threadId || undefined,
    })
    if (!saved.ok) return json({ ok: false, error: saved.error }, 400)
    if (body.id) {
      await sql`UPDATE hire_drafts SET status = 'saved', updated_at = now() WHERE id = ${body.id} AND user_id = ${user!.id}`
    }
    return json({ ok: true })
  }

  if (path === '/api/work/slots' && req.method === 'GET') {
    const { user, error } = await resolveAuthedUser(sql, {
      token: url.searchParams.get('t') || undefined,
      session: url.searchParams.get('s') || undefined,
      email: url.searchParams.get('email') || undefined,
    })
    if (error) return error
    const connected = await options.connectedForUser(sql, user!.id)
    const slots = connected.includes('calendar')
      ? await findFreeSlots(sql, user!.id, user!.timezone || 'America/Los_Angeles')
      : []
    return json({ slots, needConnect: !connected.includes('calendar') })
  }

  if (path === '/api/work/hold' && req.method === 'POST') {
    const body = (await req.json().catch(() => ({}))) as {
      token?: string; email?: string; session?: string; title?: string; start?: string; end?: string; id?: string
    }
    const { user, error } = await resolveAuthedUser(sql, { token: body.token, session: (body as { session?: string }).session, email: body.email })
    if (error) return error
    let title = String(body.title || 'Hold').slice(0, 160)
    let start = String(body.start || '')
    let end = String(body.end || '')
    if (body.id) {
      const rows = await sql`
        SELECT subject, start_at, end_at FROM hire_drafts WHERE id = ${body.id} AND user_id = ${user!.id} LIMIT 1
      `
      const row = rows[0] as { subject?: string; start_at?: string; end_at?: string } | undefined
      if (row) {
        title = title === 'Hold' ? String(row.subject || title) : title
        start = start || String(row.start_at || '')
        end = end || String(row.end_at || '')
      }
    }
    if (!start || !end) return json({ ok: false, error: 'start and end required' }, 400)
    const held = await calendarHold(sql, user!.id, { title, start, end })
    if (held.ok && body.id) {
      await sql`UPDATE hire_drafts SET status = 'sent', updated_at = now() WHERE id = ${body.id} AND user_id = ${user!.id}`
    }
    return json(held, held.ok ? 200 : 400)
  }

  if (path === '/api/work/linear' && req.method === 'GET') {
    const { user, error } = await resolveAuthedUser(sql, {
      token: url.searchParams.get('t') || undefined,
      session: url.searchParams.get('s') || undefined,
      email: url.searchParams.get('email') || undefined,
    })
    if (error) return error
    const connected = await options.connectedForUser(sql, user!.id)
    if (!connected.includes('linear')) return json({ issues: [], needConnect: true })
    const lin = await listLinearIssues(user!.id)
    return json({ issues: lin.issues, needConnect: lin.needConnect })
  }

  if (path === '/api/work/linear' && req.method === 'POST') {
    const body = (await req.json().catch(() => ({}))) as {
      token?: string; email?: string; id?: string; action?: string
    }
    const { user, error } = await resolveAuthedUser(sql, { token: body.token, session: (body as { session?: string }).session, email: body.email })
    if (error) return error
    const id = String(body.id || '')
    const action = body.action === 'done' || body.action === 'cancel' ? body.action : 'later'
    if (!id) return json({ ok: false, error: 'id required' }, 400)
    const ok = await linearWrite(user!.id, id, action)
    return json({ ok, error: ok ? undefined : 'Linear did not update. Check the connector.' }, ok ? 200 : 400)
  }

  if (path === '/api/work/rsvp' && req.method === 'POST') {
    const body = (await req.json().catch(() => ({}))) as {
      token?: string; email?: string; eventId?: string; response?: string
    }
    const { user, error } = await resolveAuthedUser(sql, { token: body.token, session: (body as { session?: string }).session, email: body.email })
    if (error) return error
    const eventId = String(body.eventId || '')
    if (!eventId) return json({ ok: false, error: 'eventId required' }, 400)
    const access = await googleAccessToken(sql, user!.id, 'calendar')
    if (!access) return json({ ok: false, error: 'Calendar is not connected.' }, 400)
    const res = await fetch(
      `https://www.googleapis.com/calendar/v3/calendars/primary/events/${encodeURIComponent(eventId)}?sendUpdates=all`,
      {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${access}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          attendees: [{ email: user!.email, responseStatus: body.response === 'declined' ? 'declined' : 'accepted' }],
        }),
      },
    )
    return json({ ok: res.ok, error: res.ok ? undefined : `RSVP failed (${res.status}).` }, res.ok ? 200 : 400)
  }

  if (path === '/api/work/day' && req.method === 'GET') {
    const { user, error } = await resolveAuthedUser(sql, {
      token: url.searchParams.get('t') || undefined,
      session: url.searchParams.get('s') || undefined,
      email: url.searchParams.get('email') || undefined,
    })
    if (error) return error
    const tz = user!.timezone || 'America/Los_Angeles'
    const events = await googleEventsRaw(sql, user!.id, {
      timeMin: startOfLocalDay(tz),
      timeMax: startOfLocalDay(tz, 1),
      maxResults: 12,
    })
    return json({
      events: events.map((e) => ({
        id: e.id,
        title: e.title,
        start: e.start,
        label: e.allDay ? 'All day' : localHourParts(e.start, tz),
      })),
    })
  }

  /* Meeting prep: the next shared meeting today plus a skeleton brief. */
  if (path === '/api/meeting/prep' && (req.method === 'GET' || req.method === 'POST')) {
    const body = req.method === 'POST' ? ((await req.json().catch(() => ({}))) as Record<string, unknown>) : {}
    const { user, error } = await resolveAuthedUser(sql, {
      token: (url.searchParams.get('t') || String(body.token || '')) || undefined,
      session: (url.searchParams.get('s') || String((body as { session?: string }).session || '')) || undefined,
      email: (url.searchParams.get('email') || String(body.email || '')) || undefined,
    })
    if (error) return error
    return json(await buildMeetingPrep(sql, user!))
  }

  /* Auto standup: today's facts from rows, written back for the day. */
  if (path === '/api/standup/auto' && req.method === 'POST') {
    const body = (await req.json().catch(() => ({}))) as { token?: string; session?: string; email?: string }
    const { user, error } = await resolveAuthedUser(sql, {
      token: (url.searchParams.get('t') || body.token) || undefined,
      session: (url.searchParams.get('s') || (body as { session?: string }).session) || undefined,
      email: (url.searchParams.get('email') || body.email) || undefined,
    })
    if (error) return error
    const out = await assembleAutoStandup(sql, user!)
    return json({ ok: true, ...out })
  }

  /* Slot suggest: free gaps the user can offer someone else. */
  if (path === '/api/slots/suggest' && req.method === 'POST') {
    const body = (await req.json().catch(() => ({}))) as {
      token?: string; session?: string; email?: string
      durationMin?: number; windowDays?: number; attendeeHint?: string
    }
    const { user, error } = await resolveAuthedUser(sql, {
      token: (url.searchParams.get('t') || body.token) || undefined,
      session: (url.searchParams.get('s') || (body as { session?: string }).session) || undefined,
      email: (url.searchParams.get('email') || body.email) || undefined,
    })
    if (error) return error
    const connected = (await options.connectedForUser(sql, user!.id)).includes('calendar')
    if (!connected) return json({ slots: [], connect: true })
    const tz = pickUserTimezone({ userTz: user!.timezone })
    const windowDays = Math.min(7, Math.max(1, Math.round(clampNum(body.windowDays, 3))))
    const busy = await loadBusyBlocks(sql, user!.id, new Date(), startOfLocalDay(tz, windowDays))
    const slots = suggestSlotsFromBusy(busy, {
      timezone: tz,
      windowDays,
      durationMin: Math.round(clampNum(body.durationMin, 30)),
    })
    return json({ slots, connect: false })
  }

  /* Linear triage: buckets only. Not connected is a 200 so the UI can deep
   * link straight into the connect flow. */
  if (path === '/api/linear/triage' && req.method === 'GET') {
    const { user, error } = await resolveAuthedUser(sql, {
      token: url.searchParams.get('t') || undefined,
      session: url.searchParams.get('s') || undefined,
      email: url.searchParams.get('email') || undefined,
    })
    if (error) return error
    const connected = (await options.connectedForUser(sql, user!.id)).includes('linear')
    if (!connected) return json({ connect: true })
    const raw = await composioFirst(user!.id, COMPOSIO_READ.linear!.slugs, { limit: 50, first: 50 })
    const issues = parseLinearIssues(raw)
    return json({ ...scoreLinearIssues(issues), count: issues.length })
  }

  if (path === '/api/internal/standup' && req.method === 'POST') {
    if (!options.internalOk(req)) return json({ error: 'Unauthorized' }, 401)
    const body = (await req.json().catch(() => ({}))) as {
      phone?: string; persona?: string; text?: string
    }
    const notes = String(body.text || '').trim().slice(0, 1000)
    if (!body.phone || !isPersona(body.persona || '') || !notes) {
      return json({ error: 'phone, persona, and text required' }, 400)
    }
    const user = await getUserByPhone(sql, body.phone)
    if (!user) return json({ error: 'User not found' }, 404)
    const day = localDateStrInTz(new Date(), user.timezone || 'America/Los_Angeles')
    await sql`
      INSERT INTO hire_standups (id, user_id, day, notes)
      VALUES (${crypto.randomUUID()}, ${user.id}, ${day}, ${notes})
      ON CONFLICT (user_id, day) DO UPDATE SET notes = excluded.notes, created_at = now()
    `
    return json({ ok: true, logged: true, day })
  }

  if (path === '/api/standup' && req.method === 'GET') {
    const { user, error } = await resolveAuthedUser(sql, {
      token: url.searchParams.get('t') || undefined,
      session: url.searchParams.get('s') || undefined,
      email: url.searchParams.get('email') || undefined,
    })
    if (error) return error
    const day = localDateStrInTz(new Date(), user!.timezone || 'America/Los_Angeles')
    const rows = await sql`
      SELECT id, day, notes FROM hire_standups
      WHERE user_id = ${user!.id} AND day = ${day}
    `
    return json({ today: (rows[0] as { notes?: string } | undefined)?.notes || null })
  }

  /* A write to a connected workspace (Notion page, Slack message). The bot's
   * capability layer decides WHEN this may run — the caller has to have asked
   * for it in this turn — and this route decides whether it CAN: the connector
   * must be connected for this user and persona, and every field the provider
   * requires must be present before anything reaches the workspace. A refusal
   * is phrased as a refusal, and success is only reported from a real result;
   * an invented "done" here would be a lie about someone else's workspace. */
  if (path === '/api/internal/work/write' && req.method === 'POST') {
    if (!options.internalOk(req)) return json({ error: 'Unauthorized' }, 401)
    const body = (await req.json().catch(() => ({}))) as {
      phone?: string
      persona?: string
      connector?: string
      title?: string
      body?: string
      channel?: string
      parent?: string
    }
    const persona = body.persona || ''
    const connector = writeConnector(String(body.connector || ''))
    if (!body.phone || !isPersona(persona) || !connector) {
      return json({ error: 'phone, persona, and a known connector required' }, 400)
    }
    const user = await getUserByPhone(sql, body.phone)
    if (!user) return json({ error: 'User not found' }, 404)
    const spec = COMPOSIO_WRITE[connector]!
    const input = { title: body.title, body: body.body, channel: body.channel, parent: body.parent }
    const missing = spec.needs.filter((field) => !String((input as Record<string, unknown>)[field] || '').trim())
    if (missing.length) {
      return json(
        {
          ok: false,
          error: `missing ${missing.join(', ')}`,
          message: `${connector} needs ${missing.join(' and ')} before anything can be written — resolve it with the ${connector === 'slack' ? 'slack_search' : 'notion_search'} lookup first. Nothing was written.`,
        },
        200,
      )
    }
    const connected = (await options.connectedForUser(sql, user.id)).filter((id) => !PERSONA_DENIED[persona as Persona].has(id))
    if (!connected.includes(connector)) {
      return json(
        { ok: false, error: 'not connected', message: `${connector} is not connected for this account, so nothing was written. Offer the connect link.` },
        200,
      )
    }
    const out = await composioFirst(user.id, spec.slugs, spec.args(input), 20_000)
    if (!out || composioLooksFailed(out)) {
      console.warn(`[write] ${connector} refused`, out?.slice(0, 160))
      return json({ ok: false, error: 'refused', message: spec.empty }, 200)
    }
    console.log(`[write] ${connector} ok for ${body.phone}`)
    return json({ ok: true, connector, message: spec.done(input), result: out.slice(0, 1200) })
  }

  return null
}
