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
import { gmailSendMessage, gmailForwardMessage, modifyGmailMessages, trashGmailMessages } from '../google/actions'
import { readGmailAttachment, attachmentResponseNote, formatBytes } from '../google/attachments'
import { listThreadState, refreshThreadState, upsertThreadState } from '../mailState'
import { withIdempotency } from '../utils/idempotency'

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

  /* Attachment read: metadata always rides on the message; the extracted text
   * is fetched on demand. Authed for the web reader, internal for the bot. */
  const attachmentRead = path.match(/^\/api\/mail\/([A-Za-z0-9_-]+)\/attachment\/([A-Za-z0-9_-]+)$/)
  if (attachmentRead && req.method === 'GET') {
    const { user, error: authErr } = await resolveAuthedUser(sql, {
      token: url.searchParams.get('t') || undefined,
      session: url.searchParams.get('s') || undefined,
      email: url.searchParams.get('email') || undefined,
    })
    if (authErr) return authErr
    const read = await readGmailAttachment(sql, user!.id, attachmentRead[1]!, attachmentRead[2]!)
    if (!read.ok) return json({ ok: false, error: `Attachment could not be read (${read.status}).` }, read.status === 'not_found' ? 404 : 400)
    const ex = read.extraction || { status: 'unsupported' as const }
    // Status-labeled extraction: the client (and the model) must never read a
    // partial result as complete. Encrypted / scanned / unsupported say so.
    const noteByStatus: Record<string, string> = {
      extracted: '',
      partial: `${read.meta!.filename}: ${ex.note || 'partially extracted'} Summarize only what is here and say it is partial.`,
      unsupported: `${read.meta!.filename} is a ${read.meta!.mimeType} file; its text cannot be extracted safely. Describe it by name and type; offer to forward it as-is.`,
      image_only: `${read.meta!.filename} looks like a scanned document (images, no text layer). It needs eyes on the page, not a text parse; offer to forward it or describe what the user already knows.`,
      encrypted: `${read.meta!.filename} is password-protected, so it cannot be read here. Say so plainly; never guess at the contents.`,
      malformed: `${read.meta!.filename} could not be parsed as a document. Say so; do not summarize.`,
      too_large: `${read.meta!.filename} is too large to read here (${read.meta!.size} bytes). Say so; offer to forward it.`,
      empty: `${read.meta!.filename} is a zero-byte file.`,
    }
    return json({
      ok: true,
      source: read.source,
      meta: read.meta,
      status: ex.status,
      text: ex.text || '',
      textAvailable: !!ex.text,
      note: noteByStatus[ex.status] || undefined,
    })
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
      threadId?: string
      payload?: GmailMimePart & { headers?: Array<{ name: string; value: string }> }
    }
    const headers = gmailMsg.payload?.headers || []
    const h = (n: string) => headers.find((x) => x.name.toLowerCase() === n.toLowerCase())?.value || ''
    const { text: bodyText, html: bodyHtml } = extractGmailBody(gmailMsg.payload)
    const { collectAttachments } = await import('../google/attachments')
    const attachments = collectAttachments(gmailMsg.payload).map((a) => ({
      attachmentId: a.attachmentId,
      filename: a.filename || '(unnamed)',
      mimeType: a.mimeType,
      size: a.size || 0,
      sizeLabel: formatBytes(a.size || 0),
      textReadable: true,
    }))
    return json({
      ok: true,
      messageId: msgId,
      threadId: gmailMsg.threadId || undefined,
      subject: h('subject'),
      from: h('from'),
      date: h('date'),
      bodyText,
      bodyHtml,
      snippet: gmailMsg.snippet || '',
      attachments,
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
    let replyThreadId = ''
    let inReplyTo = ''
    const access = await googleAccessToken(sql, user!.id, 'gmail')
    if (access) {
      const res = await fetch(
        `https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(msgId)}?format=full`,
        { headers: { Authorization: `Bearer ${access}` } },
      ).catch(() => null)
      if (res?.ok) {
        const data = (await res.json().catch(() => null)) as {
          snippet?: string
          threadId?: string
          payload?: GmailMimePart & { headers?: Array<{ name: string; value: string }> }
        } | null
        const h = (n: string) =>
          data?.payload?.headers?.find((x) => x.name.toLowerCase() === n.toLowerCase())?.value || ''
        replyThreadId = data?.threadId || ''
        inReplyTo = h('Message-ID') || h('Message-Id')
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
      const found = recent.find((m) => m.id === msgId)
      if (found) replyThreadId ||= found.threadId || ''
      reads.push(found)
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
      INSERT INTO hire_drafts (id, user_id, persona, kind, to_addr, subject, body, thread_id, in_reply_to, source_message_id)
      VALUES (
        ${draftId}, ${user!.id}, ${isPersona(body.persona || '') ? body.persona! : ''},
        'reply', ${target.toAddr}, ${target.subject}, ${replyBody}, ${replyThreadId}, ${inReplyTo}, ${msgId}
      )
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
  /* Send an EXISTING draft by id — object identity, not prose reconstruction.
   * "send it" must operate on the canonical hire_drafts row: load its latest
   * version (recipient corrections included), refuse on any status that is not
   * sendable, send once with the draft id as the provider idempotency
   * operation, then persist the send receipt. Typed states so the engine can
   * never collapse already_sent / outcome_unknown into "sent". */
  if (path === '/api/internal/mail/send-draft' && req.method === 'POST') {
    if (!options.internalOk(req)) return json({ error: 'Unauthorized' }, 401)
    const body = (await req.json().catch(() => ({}))) as { phone?: string; persona?: string; draftId?: string }
    if (!body.phone || !body.draftId) return json({ ok: false, state: 'not_cancellable', error: 'phone and draftId required' }, 400)
    const user = await getUserByPhone(sql, body.phone)
    if (!user) return json({ ok: false, state: 'outcome_unknown', error: 'User not found' }, 404)
    const rows = await sql`
      SELECT id, kind, to_addr, subject, body, status, provider_id, version, thread_id
      FROM hire_drafts WHERE id = ${body.draftId} AND user_id = ${user.id} LIMIT 1
    `
    const draft = rows[0] as {
      id: string; kind: string; to_addr: string; subject: string; body: string
      status: string; provider_id: string | null; version: number; thread_id: string | null
    } | undefined
    if (!draft) return json({ ok: false, state: 'not_cancellable', error: 'Draft not found.' }, 404)
    if (draft.status === 'sent') {
      return json({ ok: true, state: 'already_sent', providerId: draft.provider_id, toAddr: draft.to_addr })
    }
    if (draft.status === 'outcome_unknown') {
      return json({ ok: false, state: 'outcome_unknown', error: 'The earlier send has an unknown outcome and will not be repeated. Check the provider before retrying.' }, 409)
    }
    if (['canceled', 'cancelled'].includes(draft.status)) {
      return json({ ok: false, state: 'not_cancellable', error: 'That draft was cancelled.' }, 409)
    }
    if (draft.kind !== 'mail' && draft.kind !== 'reply') {
      return json({ ok: false, state: 'not_cancellable', error: `Draft kind ${draft.kind} is not sendable as mail.` }, 400)
    }
    const claimed = await sql`
      UPDATE hire_drafts SET status = 'sending', updated_at = now()
      WHERE id = ${draft.id} AND user_id = ${user.id} AND status IN ('pending', 'saved')
      RETURNING id`
    if (!claimed.length) {
      return json({ ok: false, state: 'outcome_unknown', error: 'The draft changed state while claiming. Check before retrying.' }, 409)
    }
    const sent = await gmailSendMessage(sql, user.id, {
      to: draft.to_addr,
      subject: draft.subject,
      body: draft.body,
      threadId: draft.thread_id || undefined,
      operationId: draft.id,
    })
    if (sent.ok && sent.providerId) {
      await sql`UPDATE hire_drafts SET status = 'sent', provider_id = ${sent.providerId}, updated_at = now() WHERE id = ${draft.id} AND user_id = ${user.id}`
      return json({ ok: true, state: 'sent', providerId: sent.providerId, toAddr: draft.to_addr, version: draft.version })
    }
    const unknown = (sent as { outcomeUnknown?: boolean }).outcomeUnknown === true
    await sql`UPDATE hire_drafts SET status = ${unknown ? 'outcome_unknown' : 'pending'}, updated_at = now() WHERE id = ${draft.id} AND user_id = ${user.id}`
    return json({ ok: false, state: unknown ? 'outcome_unknown' : 'send_failed', error: sent.error || 'Send failed.' }, unknown ? 409 : 400)
  }

  if (path === '/api/internal/mail/send' && req.method === 'POST') {
    if (!options.internalOk(req)) return json({ error: 'Unauthorized' }, 401)
    const body = (await req.json().catch(() => ({}))) as {
      phone?: string; persona?: string; to?: string; subject?: string; body?: string; threadId?: string
    }
    if (!body.phone || !body.to || !body.subject) return json({ error: 'phone, to, and subject required' }, 400)
    const user = await getUserByPhone(sql, body.phone || '')
    if (!user) return json({ error: 'User not found' }, 404)
    const sent = await gmailSendMessage(sql, user.id, {
      to: String(body.to).trim(),
      subject: String(body.subject).trim().slice(0, 200),
      body: String(body.body || '').slice(0, 8000),
      threadId: body.threadId || undefined,
    })
    if (!sent.ok) return json({ ok: false, error: sent.error }, 400)
    // Outbound send = durable "they owe the reply" state for waiting-on queries.
    await upsertThreadState(sql, user.id, String(body.persona || ''), {
      threadId: body.threadId || '',
      participant: String(body.to).trim(),
      subject: String(body.subject).trim(),
      direction: 'outbound',
      awaiting: 'them',
    }).catch(() => undefined)
    return json({ ok: true, providerId: sent.providerId || null })
  }

  /* Bot attachment read: binds the attachment back to its thread in the reply
   * so a summary can never float free of the email it came from. */
  if (path === '/api/internal/mail/attachment' && req.method === 'POST') {
    if (!options.internalOk(req)) return json({ error: 'Unauthorized' }, 401)
    const body = (await req.json().catch(() => ({}))) as { phone?: string; messageId?: string; attachmentId?: string }
    if (!body.phone || !body.messageId || !body.attachmentId) return json({ error: 'phone, messageId, attachmentId required' }, 400)
    const user = await getUserByPhone(sql, body.phone)
    if (!user) return json({ error: 'User not found' }, 404)
    const read = await readGmailAttachment(sql, user.id, body.messageId, body.attachmentId)
    if (!read.ok) return json({ ok: false, status: read.status, error: `Attachment could not be read (${read.status}).` }, read.status === 'not_found' ? 404 : 400)
    const ex = read.extraction || { status: 'unsupported' as const }
    return json({
      ok: true,
      source: read.source,
      meta: read.meta,
      status: ex.status,
      text: ex.text || '',
      textAvailable: !!ex.text,
      note: attachmentResponseNote(ex, read.meta!),
    })
  }

  /* Forward: a real forwarded message with attachments and the original header
   * block — never a "Re:" with pasted text. */
  if (path === '/api/internal/mail/forward' && req.method === 'POST') {
    if (!options.internalOk(req)) return json({ error: 'Unauthorized' }, 401)
    const body = (await req.json().catch(() => ({}))) as { phone?: string; persona?: string; messageId?: string; to?: string; comment?: string }
    if (!body.phone || !isPersona(body.persona || '') || !body.messageId || !body.to) {
      return json({ error: 'phone, persona, messageId, and recipient required' }, 400)
    }
    const user = await getUserByPhone(sql, body.phone)
    if (!user) return json({ error: 'User not found' }, 404)
    const operationId = computeForwardOperationId(user.id, body.messageId, String(body.to))
    // In-process idempotency: the operation id (Message-ID) makes the send
    // itself stable, and this wrapper collapses double-taps within the TTL.
    const idem = await withIdempotency(`mail_forward:${computeForwardOperationId(user.id, body.messageId, String(body.to))}`, async () =>
      gmailForwardMessage(sql, user.id, { messageId: body.messageId!, to: String(body.to).trim(), comment: body.comment, operationId }),
    )
    const result = idem.result as { ok: boolean; providerId?: string; error?: string; outcomeUnknown?: boolean; subject?: string; attachedCount?: number; skippedAttachments?: number }
    if (result.ok) {
      await upsertThreadState(sql, user.id, body.persona!, {
        participant: String(body.to).trim(),
        subject: result.subject || '',
        direction: 'outbound',
        awaiting: 'them',
        threadId: '',
      }).catch(() => undefined)
    }
    return json(result, result.ok ? 200 : result.outcomeUnknown ? 409 : 400)
  }

  /* Inbox filing: mark read/unread, archive, labels, trash. Per-id outcomes;
   * trash is only ever executed on ids the user confirmed. */
  const runMailActions = async (userId: string, persona: string, ids: string[], action: string, label?: string) => {
    const labelIds = label ? [String(label).replace(/^#/, '').trim()].filter(Boolean) : []
    let result: { ok: boolean; results: Array<{ id: string; ok: boolean; error?: string }>; error?: string }
    if (action === 'mark_read') result = await modifyGmailMessages(sql, userId, { ids, removeLabels: ['UNREAD'] })
    else if (action === 'mark_unread') result = await modifyGmailMessages(sql, userId, { ids, addLabels: ['UNREAD'] })
    else if (action === 'archive') result = await modifyGmailMessages(sql, userId, { ids, removeLabels: ['INBOX'] })
    else if (action === 'unarchive') result = await modifyGmailMessages(sql, userId, { ids, addLabels: ['INBOX'] })
    else if (action === 'label') result = labelIds.length
      ? await modifyGmailMessages(sql, userId, { ids, addLabels: labelIds })
      : { ok: false, results: [], error: 'A label name is required.' }
    else if (action === 'trash') result = await trashGmailMessages(sql, userId, ids)
    else return { ok: false, error: 'action must be mark_read, mark_unread, archive, unarchive, label, or trash' }
    if (action === 'archive' || action === 'trash') {
      for (const r of result.results) {
        if (r.ok) await sql`UPDATE hire_thread_state SET awaiting = 'none', updated_at = now() WHERE user_id = ${userId} AND persona = ${persona} AND (thread_id = ${r.id} OR last_message_id = ${r.id})`.catch(() => undefined)
      }
    }
    return result
  }

  if (path === '/api/internal/mail/actions' && req.method === 'POST') {
    if (!options.internalOk(req)) return json({ error: 'Unauthorized' }, 401)
    const body = (await req.json().catch(() => ({}))) as { phone?: string; persona?: string; ids?: string[]; action?: string; label?: string }
    const ids = (body.ids || []).map((i) => String(i).replace(/[^a-zA-Z0-9_-]/g, '')).filter(Boolean)
    if (!body.phone || !isPersona(body.persona || '') || !ids.length || !body.action) {
      return json({ error: 'phone, persona, ids, and action required' }, 400)
    }
    const user = await getUserByPhone(sql, body.phone)
    if (!user) return json({ error: 'User not found' }, 404)
    return json(await runMailActions(user.id, body.persona!, ids, String(body.action), body.label))
  }

  if (path === '/api/mail/actions' && req.method === 'POST') {
    const body = (await req.json().catch(() => ({}))) as { token?: string; session?: string; email?: string; persona?: string; ids?: string[]; action?: string; label?: string }
    const { user, error } = await resolveAuthedUser(sql, { token: body.token, session: body.session, email: body.email })
    if (error) return error
    const ids = (body.ids || []).map((i) => String(i).replace(/[^a-zA-Z0-9_-]/g, '')).filter(Boolean)
    if (!ids.length || !body.action) return json({ error: 'ids and action required' }, 400)
    return json(await runMailActions(user!.id, String(body.persona || ''), ids, String(body.action), body.label))
  }

  /* Canonical draft read for the bot's durable draft anchor. Anchors carry the
   * draft ID only; the body/version/recipient always come from hire_drafts at
   * send time, so a rewrite ("make it warmer") or a recipient correction before
   * a restart is what actually goes out. Only a still-pending draft resolves. */
  const draftRead = path.match(/^\/api\/internal\/mail\/draft\/([A-Za-z0-9_-]+)$/)
  if (draftRead && req.method === 'GET') {
    if (!options.internalOk(req)) return json({ error: 'Unauthorized' }, 401)
    const user = await getUserByPhone(sql, url.searchParams.get('phone') || '')
    if (!user) return json({ error: 'User not found' }, 404)
    const rows = await sql`
      SELECT id, kind, to_addr AS "toAddr", subject, body,
        thread_id AS "threadId", in_reply_to AS "inReplyTo", status, version
      FROM hire_drafts WHERE id = ${draftRead[1]} AND user_id = ${user.id}
      ORDER BY created_at DESC LIMIT 1
    `
    const row = rows[0] as { id: string; kind: string; toAddr: string; subject: string; body: string; threadId?: string; inReplyTo?: string; status: string; version: number } | undefined
    if (!row) return json({ ok: false, status: 'not_found' })
    if (row.status !== 'pending') return json({ ok: false, status: row.status, version: row.version })
    return json({ ok: true, draft: row })
  }

  /* Waiting-on state: durable per-thread reply state, optionally re-verified
   * against the live thread before it is stated. */
  if (path === '/api/internal/mail/state' && req.method === 'GET') {
    if (!options.internalOk(req)) return json({ error: 'Unauthorized' }, 401)
    const user = await getUserByPhone(sql, url.searchParams.get('phone') || '')
    if (!user) return json({ error: 'User not found' }, 404)
    const persona = url.searchParams.get('persona') || ''
    const kindParam = url.searchParams.get('kind') || 'all'
    const kind = kindParam === 'waiting_on_them' || kindParam === 'waiting_on_me' ? kindParam : 'all'
    const rows = await listThreadState(sql, user.id, persona, kind)
    const refreshThreadId = url.searchParams.get('refreshThreadId') || ''
    let refresh: Awaited<ReturnType<typeof refreshThreadState>> | null = null
    if (refreshThreadId) {
      const match = rows.find((r) => r.threadId === refreshThreadId)
      refresh = await refreshThreadState(sql, user.id, persona, user.email, refreshThreadId, match?.participant || '')
    }
    return json({ ok: true, kind, rows, refresh })
  }

  return null
}

function computeForwardOperationId(userId: string, messageId: string, to: string): string {
  return `fwd-${userId.slice(0, 8)}-${messageId.slice(0, 16)}-${to.replace(/[^a-z0-9]/gi, '').slice(0, 12)}`
}
