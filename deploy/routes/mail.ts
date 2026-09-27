import type { SQL } from 'bun'
import { json } from '../utils/http'
import { normalizePhone } from '../utils/phone'
import { getUserByPhone } from '../db/users'
import { resolveAuthedUser } from '../auth/session'
import { isPersona } from '../personas'
import { googleTokenHasScope } from '../calendarEvents'
import {
  extractGmailBody,
  fillDraftName,
  importantMailQuery,
  isSubstantiveReply,
  pickReplyTarget,
  MAIL_READ_CAP,
  type GmailMimePart,
  type ReplyRead,
} from '../gmailHelpers'
import {
  googleConnected,
  composioConnected,
  composioMailBody,
  composioMailHeaders,
  googleAccessToken,
  loadGmailRich,
} from '../connectors/hub'
import { gmiBriefChat } from '../briefs/judgment'
import { gmailSendMessage } from '../google/actions'

export interface MailRouteOptions {
  internalOk: (req: Request) => boolean
}

export async function handleMailRoutes(
  req: Request,
  sql: SQL,
  options: MailRouteOptions,
): Promise<Response | null> {
  const url = new URL(req.url)
  const path = url.pathname

  // Mail rows for a hire that is about to act on the inbox (the refund hunter
  // asks before it drafts anything). Falls back to an empty list for a phone
  // with no connected Gmail so the caller can carry on gracefully.
  if (path === '/api/internal/mail/context' && req.method === 'GET') {
    if (!options.internalOk(req)) return json({ error: 'Unauthorized' }, 401)
    const phone = normalizePhone(url.searchParams.get('phone') || '')
    if (!phone) return json({ error: 'valid phone required' }, 400)
    const user = await getUserByPhone(sql, phone)
    if (!user) return json({ mail: [] })
    const limit = Math.min(Math.max(Number(url.searchParams.get('limit')) || MAIL_READ_CAP, 1), MAIL_READ_CAP)
    const rich = await loadGmailRich(sql, user.id, importantMailQuery('14d'), limit)
    const mail = rich.map((m) => ({
      subject: m.subject,
      snippet: m.snippet,
      from: m.from,
      threadId: m.id,
      receivedAt: m.date,
    }))
    return json({ mail })
  }

  if (path.startsWith('/api/mail/') && req.method === 'GET') {
    const msgId = path.slice('/api/mail/'.length).replace(/[^a-zA-Z0-9_-]/g, '')
    if (!msgId) return json({ ok: false, error: 'Message ID required' }, 400)
    const { user, error: authErr } = await resolveAuthedUser(sql, {
      token: url.searchParams.get('t') || undefined,
      session: url.searchParams.get('s') || undefined,
      email: url.searchParams.get('email') || undefined,
    })
    if (authErr) return authErr
    // The digest's text-only fallback parses mail out of lines and has no Gmail
    // ids to hand out, so it mints text-0, text-1. Those can never be opened;
    // say so instead of blaming the connection.
    if (/^text-\d+$/.test(msgId)) {
      return json({
        ok: false,
        error: 'This one came from a text only fallback, so there is no message to open.',
      })
    }
    const access = await googleAccessToken(sql, user!.id, 'gmail')
    if (!access) {
      // One null covers several different situations and "reconnect in Settings"
      // is only the right advice for some of them.
      const g = await googleConnected(sql, user!.id)
      const viaComposio = !g && (await composioConnected(user!.id)).includes('gmail')
      if (viaComposio) {
        const body = await composioMailBody(user!.id, msgId)
        if (body) {
          return json({
            ok: true,
            messageId: body.id || msgId,
            subject: body.subject,
            from: body.from,
            date: body.date,
            bodyText: body.bodyText,
            bodyHtml: body.bodyHtml,
            snippet: body.snippet,
          })
        }
      }
      const error = !g
        ? viaComposio
          ? 'Gmail is connected through Composio and it did not return this message. Sign in with Google in Settings for reliable full reads.'
          : 'Gmail is not connected. Connect it in Settings to read full messages.'
        : !googleTokenHasScope(g.scopes, 'gmail')
          ? 'This Google account is connected for calendar only. Reconnect it in Settings and allow Gmail.'
          : !g.hasRefresh
            ? 'The Google sign in expired and there is no refresh token. Reconnect it in Settings.'
            : 'Google refused the saved Gmail permission. Reconnect it in Settings.'
      return json({ ok: false, error })
    }
    const gmailRes = await fetch(
      `https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(msgId)}?format=full`,
      { headers: { Authorization: `Bearer ${access}` } },
    )
    if (!gmailRes.ok) {
      if (gmailRes.status === 404) return json({ ok: false, error: 'Message not found.' })
      return json({ ok: false, error: `Gmail returned ${gmailRes.status}. Try again.` })
    }
    const gmailMsg = (await gmailRes.json()) as {
      snippet?: string
      payload?: GmailMimePart & { headers?: Array<{ name: string; value: string }> }
    }
    const headers = gmailMsg.payload?.headers || []
    const h = (n: string) => headers.find((x) => x.name.toLowerCase() === n.toLowerCase())?.value || ''
    const { text: bodyText, html: bodyHtml } = extractGmailBody(gmailMsg.payload)
    return json({
      ok: true,
      messageId: msgId,
      subject: h('subject'),
      from: h('from'),
      date: h('date'),
      bodyText,
      bodyHtml,
      snippet: gmailMsg.snippet || '',
    })
  }

  if (path === '/api/mail/triage' && req.method === 'POST') {
    const body = (await req.json().catch(() => ({}))) as {
      token?: string; session?: string; email?: string
      id?: string; action?: string; sender?: string; kind?: string
    }
    const action = String(body.action || '')
    if (!['done', 'skip', 'drafted', 'opened', 'replied'].includes(action)) {
      return json({ error: 'action must be done, skip, drafted, opened, or replied' }, 400)
    }
    const { user, error } = await resolveAuthedUser(sql, { token: body.token, session: (body as { session?: string }).session, email: body.email })
    if (error) return error
    const gmailId = String(body.id || '').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 80)
    await sql`
      INSERT INTO hire_mail_feedback (user_id, gmail_id, sender, action, kind)
      VALUES (${user!.id}, ${gmailId}, ${String(body.sender || '').slice(0, 120)}, ${action}, ${String(body.kind || '').slice(0, 40)})
    `
    return json({ ok: true })
  }

  if (path === '/api/mail/draft' && req.method === 'POST') {
    const body = (await req.json().catch(() => ({}))) as {
      token?: string; session?: string; email?: string; persona?: string; id?: string
    }
    const msgId = String(body.id || '').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 80)
    if (!msgId) return json({ error: 'id required' }, 400)
    const { user, error } = await resolveAuthedUser(sql, { token: body.token, session: (body as { session?: string }).session, email: body.email })
    if (error) return error
    if (/^text-\d+$/.test(msgId)) {
      return json({ error: 'This one came from a text only fallback, so there is no message to reply to.' }, 404)
    }
    /* A reply needs a From address. Everything else — subject, a body to quote —
     * is nice to have, so each read below is allowed to contribute only what it
     * has and we stop as soon as an address turns up. The old version demanded a
     * full body read and refused to draft when a connector handed back headers
     * alone, which is the common Composio shape. */
    const reads: ReplyRead[] = []
    const access = await googleAccessToken(sql, user!.id, 'gmail')
    if (access) {
      const res = await fetch(
        `https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(msgId)}?format=full`,
        { headers: { Authorization: `Bearer ${access}` } },
      ).catch(() => null)
      if (res?.ok) {
        const data = (await res.json().catch(() => null)) as {
          snippet?: string
          payload?: GmailMimePart & { headers?: Array<{ name: string; value: string }> }
        } | null
        const h = (n: string) =>
          data?.payload?.headers?.find((x) => x.name.toLowerCase() === n.toLowerCase())?.value || ''
        reads.push({
          from: h('From'),
          subject: h('Subject'),
          bodyText: extractGmailBody(data?.payload).text,
          snippet: data?.snippet,
        })
      } else if (res) {
        console.warn('[mail/draft] gmail by-id returned', res.status, 'for', msgId)
      }
    }
    // Accounts that read Gmail through Composio have no direct token here; the
    // connector can still hand back the one message a reply needs.
    if (!pickReplyTarget(reads)) reads.push(await composioMailHeaders(user!.id, msgId))
    /* Last resort, and the one that saves a Gmail account whose by-id read 404s
     * because the id came out of a connector list: read the recent inbox the same
     * way the brief did and find the row again. */
    if (!pickReplyTarget(reads)) {
      const recent = await loadGmailRich(sql, user!.id, 'newer_than:14d', 25)
      reads.push(recent.find((m) => m.id === msgId))
    }
    const target = pickReplyTarget(reads)
    if (!target) {
      // Do not send them to the reader: it runs the same reads this just tried.
      return json(
        {
          error: reads.some((r) => r && (r.subject || r.snippet))
            ? 'This message has no reply address, so there is nobody to draft to.'
            : 'Gmail did not return this message, so there is nothing to reply to yet.',
        },
        404,
      )
    }
    const draftId = crypto.randomUUID()
    // No quoted-original tail: appending "They wrote:" + their text into the
    // OUTBOUND body mailed people their own words back. The reader shows the
    // original; the draft contains only the reply.
    /* The draft has to say something about the email, not just re-paste it:
     * Alpha writes the actual reply from the message content. A model that is
     * down, or that answers with a bare greeting or an echo of the original,
     * produces no draft at all — the old fallback saved "Hi <name>," plus the
     * quoted original, which is exactly the kind of draft a user sends by
     * accident. */
    const senderName = (user!.name || '').trim() || user!.email.split('@')[0]
    const firstName = senderName.split(/\s+/)[0] || 'me'
    let written = ''
    try {
      // The draft model needs headroom: 10s timed out on ordinary replies and
      // turned every first tap into an error. 22s, then one silent retry —
      // the client shows a writing state instead of bouncing the user.
      const draftSystem = `You are Alpha writing a reply email on behalf of ${senderName}. Reply to the email below on their behalf. Keep it natural, concise, and specific to what was said: answer any question, confirm or decline clearly, move it forward. Plain greeting, no bullet lists unless needed, close with a short signoff in their voice using the name ${firstName}, like "Best," then ${firstName} on the next line. Do not quote the original back. Never leave placeholders such as [Your Name]. Respond with ONLY the body text.`
      const draftUser = `To: ${target.toAddr}\nSubject: ${target.subject}\n\nTheir email:\n${target.original || target.subject}\n\nWrite the reply body now.`
      let writtenRaw = ''
      try {
        writtenRaw = String(await gmiBriefChat(draftSystem, draftUser, 500, 22_000, { plainText: true })) || ''
      } catch {
        writtenRaw = String(await gmiBriefChat(draftSystem, draftUser, 500, 22_000, { plainText: true })) || ''
      }
      written = writtenRaw.trim()
    } catch (err) {
      console.warn('[mail/draft] model draft failed', err)
    }
    if (!isSubstantiveReply(written, target.original)) {
      return json(
        { ok: false, error: 'Alpha could not write this reply right now. Try again in a moment.' },
        502,
      )
    }
    const replyBody = fillDraftName(written, firstName).slice(0, 4000)
    await sql`
      INSERT INTO hire_drafts (id, user_id, persona, kind, to_addr, subject, body)
      VALUES (
        ${draftId}, ${user!.id}, ${isPersona(body.persona || '') ? body.persona! : ''},
        'reply', ${target.toAddr}, ${target.subject}, ${replyBody}
      )
    `
    await sql`
      INSERT INTO hire_mail_feedback (user_id, gmail_id, sender, action, kind)
      VALUES (${user!.id}, ${msgId}, ${target.toAddr}, 'drafted', '')
    `
    return json({ ok: true, id: draftId, toAddr: target.toAddr, subject: target.subject, body: replyBody })
  }

  if (path === '/api/mail/draft/rewrite' && req.method === 'POST') {
    const body = (await req.json().catch(() => ({}))) as {
      token?: string; session?: string; email?: string; id?: string; instruction?: string
    }
    const draftId = String(body.id || '').slice(0, 80)
    const instruction = String(body.instruction || '').trim()
    if (!draftId) return json({ error: 'id required' }, 400)
    if (!instruction) return json({ error: 'instruction required' }, 400)
    const { user, error } = await resolveAuthedUser(sql, {
      token: body.token, session: (body as { session?: string }).session, email: body.email,
    })
    if (error) return error
    const rows = await sql`
      SELECT to_addr, subject, body FROM hire_drafts
      WHERE id = ${draftId} AND user_id = ${user!.id} LIMIT 1
    `
    const row = rows[0] as { to_addr: string; subject: string; body: string } | undefined
    if (!row) return json({ error: 'Draft not found.' }, 404)
    /* The model signs with a real name or not at all: left unnamed it emits
     * "[Your Name]", which is exactly what users then send by accident. */
    const senderName = (user!.name || '').trim() || user!.email.split('@')[0]
    const firstName = senderName.split(/\s+/)[0] || 'me'
    const rewritten = await gmiBriefChat(
      `You are Alpha writing a reply email on behalf of ${senderName}. Rewrite the draft body to follow the user's instruction. Keep it a natural, concise email reply with a plain greeting, and close with a short signoff in their voice using the name ${firstName}, like "Best," then ${firstName} on the next line. Never leave placeholders such as [Your Name]. Respond with ONLY the new body text — no preamble, labels, or quoting.`,
      `To: ${row.to_addr}\nSubject: ${row.subject}\n\nCurrent draft:\n${row.body}\n\nUser instruction: ${instruction}\n\nRewrite the draft body now.`,
      500,
      8000,
      { plainText: true },
    )
    if (!rewritten?.trim()) {
      return json({ ok: false, error: 'Alpha could not rewrite that right now. Try again.' }, 502)
    }
    const signed = fillDraftName(rewritten.trim(), firstName)
    const updated = await sql`
      UPDATE hire_drafts SET body = ${signed}, version = version + 1, updated_at = now()
      WHERE id = ${draftId} AND user_id = ${user!.id}
      RETURNING version
    `
    return json({ ok: true, body: signed, version: Number(updated[0]?.version || 1) })
  }

  /* Delegate fire: the bot retained an outreach draft for this user and the
   * user said "send it". Same send machinery the app's Send button uses. */
  if (path === '/api/internal/mail/send' && req.method === 'POST') {
    if (!options.internalOk(req)) return json({ error: 'Unauthorized' }, 401)
    const body = (await req.json().catch(() => ({}))) as {
      phone?: string; to?: string; subject?: string; body?: string
    }
    if (!body.phone || !body.to || !body.subject) return json({ error: 'phone, to, and subject required' }, 400)
    const user = await getUserByPhone(sql, body.phone || '')
    if (!user) return json({ error: 'User not found' }, 404)
    const sent = await gmailSendMessage(sql, user.id, {
      to: String(body.to).trim(),
      subject: String(body.subject).trim().slice(0, 200),
      body: String(body.body || '').slice(0, 8000),
    })
    if (!sent.ok) return json({ ok: false, error: sent.error }, 400)
    return json({ ok: true })
  }

  return null
}
