import type { SQL } from 'bun'
import { isDemoUserId } from '../demoData'
import { googleAccessToken, fetchCalendarItems, composioFirst } from '../connectors/hub'
import { hydrateCalItems, parseComposioCalendarData, type CalItem } from '../calendarEvents'

export function rfc822Raw(
  to: string,
  subject: string,
  body: string,
  extra?: { inReplyTo?: string; messageId?: string },
): string {
  const headers = [`To: ${to}`, `Subject: ${subject}`, 'MIME-Version: 1.0', 'Content-Type: text/plain; charset=utf-8']
  if (extra?.messageId) headers.push(`Message-ID: <${extra.messageId}@hirealpha.local>`)
  const replyTo = extra?.inReplyTo?.trim()
  if (replyTo) {
    headers.push(`In-Reply-To: ${replyTo}`, `References: ${replyTo}`)
  }
  const raw = [...headers, '', body].join('\r\n')
  return Buffer.from(raw).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function rfc822WithAttachment(to: string, subject: string, body: string, file: { name: string; mimeType: string; bytes: Uint8Array }, messageId?: string): string {
  const boundary = `alpha_${crypto.randomUUID().replaceAll('-', '')}`
  const headers = [`To: ${to}`, `Subject: ${subject}`, 'MIME-Version: 1.0', `Content-Type: multipart/mixed; boundary="${boundary}"`]
  if (messageId) headers.push(`Message-ID: <${messageId}@hirealpha.local>`)
  const encoded = Buffer.from(file.bytes).toString('base64').match(/.{1,76}/g)?.join('\r\n') || ''
  const raw = [...headers, '', `--${boundary}`, 'Content-Type: text/plain; charset=utf-8', '', body, `--${boundary}`, `Content-Type: ${file.mimeType}; name="${file.name.replace(/["\r\n]/g, '')}"`, 'Content-Transfer-Encoding: base64', `Content-Disposition: attachment; filename="${file.name.replace(/["\r\n]/g, '')}"`, '', encoded, `--${boundary}--`, ''].join('\r\n')
  return Buffer.from(raw).toString('base64url')
}

export async function sendDriveFile(
  sql: SQL, userId: string,
  input: { recipient: string; fileId: string; mode: 'attachment' | 'link'; subject: string; body: string; operationId: string },
): Promise<{ ok: boolean; providerId?: string; fileName?: string; error?: string; outcomeUnknown?: boolean }> {
  const drive = await googleAccessToken(sql, userId, 'drive'); const gmail = await googleAccessToken(sql, userId, 'gmail')
  if (!drive) return { ok: false, error: 'Drive is not connected.' }
  if (!gmail) return { ok: false, error: 'Gmail is not connected.' }
  const metaRes = await fetch(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(input.fileId)}?fields=id,name,mimeType,size,webViewLink`, { headers: { Authorization: `Bearer ${drive}` } })
  if (!metaRes.ok) return { ok: false, error: `The selected Drive file is unavailable (${metaRes.status}).` }
  const meta = await metaRes.json() as { name?: string; mimeType?: string; size?: string; webViewLink?: string }
  if (!meta.name || !meta.mimeType) return { ok: false, error: 'Drive returned malformed file metadata.' }
  if (input.mode === 'link') {
    const permission = await fetch(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(input.fileId)}/permissions?sendNotificationEmail=false`, { method: 'POST', headers: { Authorization: `Bearer ${drive}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ type: 'user', role: 'reader', emailAddress: input.recipient }) })
    if (!permission.ok) return { ok: false, error: `Drive could not grant ${input.recipient} access (${permission.status}); no email was sent.` }
    if (!meta.webViewLink) return { ok: false, error: 'Drive granted access but returned no share link.' }
    const sent = await gmailSendMessage(sql, userId, { to: input.recipient, subject: input.subject, body: `${input.body}\n\n${meta.webViewLink}`, operationId: input.operationId })
    return { ...sent, fileName: meta.name }
  }
  const size = Number(meta.size || 0)
  if (size > 25 * 1024 * 1024) return { ok: false, error: `${meta.name} is larger than Gmail's 25 MB attachment limit; choose a share link instead.` }
  const native = meta.mimeType.startsWith('application/vnd.google-apps.')
  const downloadUrl = native
    ? `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(input.fileId)}/export?mimeType=application/pdf`
    : `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(input.fileId)}?alt=media`
  const download = await fetch(downloadUrl, { headers: { Authorization: `Bearer ${drive}` } })
  if (!download.ok) return { ok: false, error: `Drive attachment download failed (${download.status}); no email was sent.` }
  const bytes = new Uint8Array(await download.arrayBuffer())
  if (bytes.byteLength > 25 * 1024 * 1024) return { ok: false, error: `${meta.name} exceeds Gmail's attachment limit after export; no email was sent.` }
  let res: Response
  try {
    res = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', { method: 'POST', headers: { Authorization: `Bearer ${gmail}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ raw: rfc822WithAttachment(input.recipient, input.subject, input.body, { name: native ? `${meta.name}.pdf` : meta.name, mimeType: native ? 'application/pdf' : meta.mimeType, bytes }, input.operationId) }) })
  } catch { return { ok: false, outcomeUnknown: true, error: 'Gmail did not confirm whether the attachment was sent.' } }
  if (!res.ok) return { ok: false, error: `Gmail attachment upload failed (${res.status}); no success was recorded.` }
  const receipt = await res.json().catch(() => ({})) as { id?: string }
  return receipt.id ? { ok: true, providerId: receipt.id, fileName: meta.name } : { ok: false, outcomeUnknown: true, error: 'Gmail accepted the attachment but returned no message ID.' }
}

/** MIME for a forward: the user's comment, the forwarded-header block, the
 * original text, and the original attachments re-attached. A forward is its
 * own message — never a "Re:" with pasted text. */
export function rfc822Forward(
  to: string,
  subject: string,
  comment: string,
  original: { from: string; date: string; to?: string; subject: string; body: string },
  atts: Array<{ name: string; mimeType: string; bytes: Uint8Array }>,
  extra?: { messageId?: string; threadId?: string },
): string {
  const forwardedBlock = [
    '---------- Forwarded message ---------',
    `From: ${original.from}`,
    `Date: ${original.date}`,
    original.to ? `To: ${original.to}` : '',
    `Subject: ${original.subject}`,
    '',
    original.body,
  ].filter((l) => l !== '').join('\r\n')
  const textBody = `${comment ? `${comment}\r\n\r\n` : ''}${forwardedBlock}`
  if (!atts.length) {
    const raw = [`To: ${to}`, `Subject: ${subject}`, 'MIME-Version: 1.0', 'Content-Type: text/plain; charset=utf-8']
    if (extra?.messageId) raw.push(`Message-ID: <${extra.messageId}@hirealpha.local>`)
    raw.push('', textBody, '')
    return Buffer.from(raw.join('\r\n')).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
  }
  const boundary = `alpha_fwd_${crypto.randomUUID().replaceAll('-', '')}`
  const headers = [`To: ${to}`, `Subject: ${subject}`, 'MIME-Version: 1.0', `Content-Type: multipart/mixed; boundary="${boundary}"`]
  if (extra?.messageId) headers.push(`Message-ID: <${extra.messageId}@hirealpha.local>`)
  const parts = [
    `--${boundary}`,
    'Content-Type: text/plain; charset=utf-8',
    '',
    textBody,
  ]
  let total = 0
  for (const file of atts) {
    total += file.bytes.byteLength
    if (total > 18 * 1024 * 1024) break
    const encoded = Buffer.from(file.bytes).toString('base64').match(/.{1,76}/g)?.join('\r\n') || ''
    const safeName = file.name.replace(/["\r\n]/g, '')
    parts.push(
      `--${boundary}`,
      `Content-Type: ${file.mimeType}; name="${safeName}"`,
      'Content-Transfer-Encoding: base64',
      `Content-Disposition: attachment; filename="${safeName}"`,
      '',
      encoded,
    )
  }
  parts.push(`--${boundary}--`, '')
  return Buffer.from([...headers, '', ...parts].join('\r\n')).toString('base64url')
}

/**
 * Forward a real message, attachments included, preserving the original
 * From/Date/Subject in the forwarded block and the thread identity when the
 * original thread is known. Success only on a Gmail message receipt; an
 * unknown outcome is reported as unknown, never as sent.
 */
export async function gmailForwardMessage(
  sql: SQL,
  userId: string,
  input: { messageId: string; to: string; comment?: string; operationId?: string },
): Promise<{ ok: boolean; providerId?: string; error?: string; outcomeUnknown?: boolean; subject?: string; attachedCount?: number; skippedAttachments?: number }> {
  if (isDemoUserId(userId)) return { ok: false, error: 'Demo account. Nothing was actually sent.' }
  const access = await googleAccessToken(sql, userId, 'gmail')
  if (!access) return { ok: false, error: 'Gmail is not connected.' }
  const { loadGmailFullMessage, fetchGmailAttachmentBytes } = await import('./attachments')
  const full = await loadGmailFullMessage(sql, userId, input.messageId)
  if (!full.ok || !full.message) {
    return { ok: false, error: full.status === 'auth_expired'
      ? 'Gmail authorization expired. Reconnect Gmail in Settings, then retry the forward.'
      : 'Gmail did not return that message, so there is nothing to forward.' }
  }
  const subject = full.message.subject
    ? /^fwd\s*:/i.test(full.message.subject) ? full.message.subject.slice(0, 200) : `Fwd: ${full.message.subject.slice(0, 190)}`
    : 'Fwd: (no subject)'
  const atts: Array<{ name: string; mimeType: string; bytes: Uint8Array }> = []
  let skipped = 0
  for (const meta of full.message.attachments.slice(0, 8)) {
    const got = await fetchGmailAttachmentBytes(sql, userId, input.messageId, meta.attachmentId)
    if (!got.ok || !got.bytes) { skipped++; continue }
    atts.push({ name: meta.filename || 'attachment', mimeType: meta.mimeType, bytes: got.bytes })
  }
  const raw = rfc822Forward(
    input.to,
    subject,
    String(input.comment || '').slice(0, 1500),
    { from: full.message.from, date: full.message.date, to: full.message.to, subject: full.message.subject, body: full.message.bodyText || full.message.snippet || '(no readable body)' },
    atts,
    { messageId: input.operationId, threadId: full.message.threadId || undefined },
  )
  let res: Response
  try {
    res = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
      method: 'POST',
      headers: { Authorization: `Bearer ${access}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ raw, ...(full.message.threadId ? { threadId: full.message.threadId } : {}) }),
    })
  } catch {
    return { ok: false, outcomeUnknown: true, error: 'Gmail did not confirm whether the forward was sent.' }
  }
  if (!res.ok) {
    const err = await res.text().catch(() => '')
    if (res.status === 403 || res.status === 401) {
      return { ok: false, error: 'Gmail needs the send permission to forward. Reconnect Gmail in Settings and allow send.' }
    }
    return { ok: false, error: `Gmail forward failed (${res.status}). ${err.slice(0, 120)}` }
  }
  const receipt = (await res.json().catch(() => ({}))) as { id?: string }
  if (!receipt.id) return { ok: false, outcomeUnknown: true, error: 'Gmail accepted the forward but returned no message receipt.' }
  return { ok: true, providerId: receipt.id, subject, attachedCount: atts.length, skippedAttachments: skipped }
}

/**
 * Label-level inbox actions on real message ids: mark read/unread, archive
 * (remove from INBOX), and labels via messages.modify. Trash is a separate
 * call because it is the one destructive step. Every id reports its own
 * outcome; a partial failure is reported as partial, never as done.
 */
export async function modifyGmailMessages(
  sql: SQL,
  userId: string,
  input: { ids: string[]; addLabels?: string[]; removeLabels?: string[] },
): Promise<{ ok: boolean; results: Array<{ id: string; ok: boolean; error?: string }>; error?: string }> {
  const access = await googleAccessToken(sql, userId, 'gmail')
  if (!access) return { ok: false, results: [], error: 'Gmail is not connected.' }
  const results: Array<{ id: string; ok: boolean; gone?: boolean; error?: string }> = []
  let fatal: string | undefined
  for (const id of input.ids.slice(0, 25)) {
    if (fatal) {
      // Expired/forbidden auth affects every remaining id identically; record
      // each one precisely instead of losing the tail of the batch.
      results.push({ id, ok: false, error: fatal })
      continue
    }
    try {
      const res = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(id)}/modify`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${access}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...(input.addLabels?.length ? { addLabelIds: input.addLabels } : {}),
          ...(input.removeLabels?.length ? { removeLabelIds: input.removeLabels } : {}),
        }),
      })
      if (res.status === 401) {
        fatal = 'Gmail authorization expired mid-batch.'
        results.push({ id, ok: false, error: fatal })
        continue
      }
      if (res.status === 403) {
        fatal = 'This Google grant is read/send only and cannot file mail (missing gmail.modify).'
        results.push({ id, ok: false, error: fatal })
        continue
      }
      if (res.status === 404) {
        // The message is already gone: the goal (out of the inbox / not unread)
        // is satisfied, so record it as applied-with-note, never as a failure.
        results.push({ id, ok: true, gone: true })
        continue
      }
      if (!res.ok) results.push({ id, ok: false, error: `Gmail refused (${res.status})` })
      else results.push({ id, ok: true })
    } catch {
      results.push({ id, ok: false, error: 'Gmail did not answer' })
    }
  }
  const ok = results.length > 0 && results.every((r) => r.ok)
  return { ok, results, ...(fatal ? { error: fatal } : {}) }
}

export async function trashGmailMessages(
  sql: SQL,
  userId: string,
  ids: string[],
): Promise<{ ok: boolean; results: Array<{ id: string; ok: boolean; error?: string }>; error?: string }> {
  const access = await googleAccessToken(sql, userId, 'gmail')
  if (!access) return { ok: false, results: [], error: 'Gmail is not connected.' }
  const results: Array<{ id: string; ok: boolean; gone?: boolean; error?: string }> = []
  let fatal: string | undefined
  for (const id of ids.slice(0, 25)) {
    if (fatal) {
      results.push({ id, ok: false, error: fatal })
      continue
    }
    try {
      const res = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(id)}/trash`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${access}` },
      })
      if (res.status === 401) {
        fatal = 'Gmail authorization expired mid-batch.'
        results.push({ id, ok: false, error: fatal })
        continue
      }
      if (res.status === 403) {
        fatal = 'This Google grant cannot trash mail (missing gmail.modify).'
        results.push({ id, ok: false, error: fatal })
        continue
      }
      // 404: already deleted — the user's goal is met, not an error.
      if (!res.ok && res.status !== 404) results.push({ id, ok: false, error: `Gmail refused (${res.status})` })
      else results.push({ id, ok: true })
    } catch {
      results.push({ id, ok: false, error: 'Gmail did not answer' })
    }
  }
  const ok = results.length > 0 && results.every((r) => r.ok)
  return { ok, results, ...(fatal ? { error: fatal } : {}) }
}

export async function gmailSendMessage(
  sql: SQL,
  userId: string,
  draft: { to: string; subject: string; body: string; threadId?: string; inReplyTo?: string; operationId?: string },
): Promise<{ ok: boolean; providerId?: string; error?: string; outcomeUnknown?: boolean }> {
  if (isDemoUserId(userId)) return { ok: false, error: 'Demo account. Nothing was actually sent.' }
  const access = await googleAccessToken(sql, userId, 'gmail')
  if (access) {
    const payload: { raw: string; threadId?: string } = {
      raw: rfc822Raw(draft.to, draft.subject, draft.body, { inReplyTo: draft.inReplyTo, messageId: draft.operationId }),
    }
    if (draft.threadId) payload.threadId = draft.threadId
    let res: Response
    try {
      res = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
        method: 'POST',
        headers: { Authorization: `Bearer ${access}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
    } catch {
      return { ok: false, outcomeUnknown: true, error: 'Gmail did not confirm whether the message was sent.' }
    }
    if (res.ok) {
      const receipt = (await res.json().catch(() => ({}))) as { id?: string }
      return receipt.id
        ? { ok: true, providerId: receipt.id }
        : { ok: false, outcomeUnknown: true, error: 'Gmail accepted the send but returned no message receipt.' }
    }
    const err = await res.text().catch(() => '')
    if (res.status !== 403 && res.status !== 401) {
      return { ok: false, error: `Gmail send failed (${res.status}). ${err.slice(0, 120)}` }
    }
  }
  const out = await composioFirst(
    userId,
    ['GMAIL_SEND_EMAIL', 'GMAIL_SEND_MESSAGE'],
    {
      to: draft.to,
      recipient_email: draft.to,
      subject: draft.subject,
      body: draft.body,
      message: draft.body,
      thread_id: draft.threadId,
      threadId: draft.threadId,
    },
  )
  if (out && !/failed/i.test(out)) {
    const providerId = /\b(?:message[_ ]?id|id)["':=\s]+([a-z0-9_-]{4,})/i.exec(out)?.[1]
    return providerId
      ? { ok: true, providerId }
      : { ok: false, outcomeUnknown: true, error: 'The mail provider returned no durable message receipt.' }
  }
  return {
    ok: false,
    error: 'Could not send. Reconnect Gmail and allow send (not just draft), or Connect Gmail in Settings.',
  }
}

/** Push a reply into Gmail's Drafts folder. This never sends: Google accounts
 * go through drafts.create, Composio accounts through the dedicated draft
 * action, so "save draft" can never be mistaken for a send on either path. */
export async function gmailCreateDraft(
  sql: SQL,
  userId: string,
  draft: { to: string; subject: string; body: string; threadId?: string },
): Promise<{ ok: boolean; error?: string }> {
  const access = await googleAccessToken(sql, userId, 'gmail')
  if (access) {
    const message: { raw: string; threadId?: string } = {
      raw: rfc822Raw(draft.to, draft.subject, draft.body),
    }
    if (draft.threadId) message.threadId = draft.threadId
    const res = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/drafts', {
      method: 'POST',
      headers: { Authorization: `Bearer ${access}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ message }),
    })
    if (res.ok) return { ok: true }
    const err = await res.text().catch(() => '')
    if (res.status === 403 || res.status === 401) {
      return { ok: false, error: 'Gmail needs the compose permission to save drafts. Reconnect Gmail in Settings.' }
    }
    return { ok: false, error: `Gmail draft save failed (${res.status}). ${err.slice(0, 120)}` }
  }
  const out = await composioFirst(userId, ['GMAIL_CREATE_EMAIL_DRAFT'], {
    to: draft.to,
    recipient_email: draft.to,
    subject: draft.subject,
    body: draft.body,
    message: draft.body,
    thread_id: draft.threadId,
    threadId: draft.threadId,
  })
  if (out && !/failed/i.test(out)) return { ok: true }
  return {
    ok: false,
    error: 'Could not save the draft to Gmail. Reconnect Gmail in Settings, or copy the text from here.',
  }
}

export function calItemsToNextRows(items: CalItem[], prefix: string): Array<{ id: string; title: string; start: string; end: string; allDay: boolean }> {
  return items.map((e, i) => ({
    id: e.providerId || `${prefix}-${e.rawStart || e.start.toISOString()}-${i}`,
    title: e.title,
    start: e.allDay ? e.rawStart || e.start.toISOString().slice(0, 10) : e.rawStart || e.start.toISOString(),
    end: '',
    allDay: e.allDay,
  }))
}

export async function googleEventsRaw(
  sql: SQL,
  userId: string,
  opts: { timeMin: Date; timeMax: Date; maxResults?: number; budgetMs?: number; failureSink?: { failed: boolean } },
): Promise<Array<{ id: string; title: string; start: string; end: string; allDay: boolean }>> {
  const access = await googleAccessToken(sql, userId, 'calendar')
  if (access) {
    const got = await fetchCalendarItems(access, opts)
    if (got.ok) return calItemsToNextRows(got.items, 'g')
  }
  const now = opts.timeMin
  const end = opts.timeMax
  const timeMin = now.toISOString()
  const timeMax = end.toISOString()
  const maxResults = opts.maxResults || 12
  const raw = await composioFirst(
    userId,
    ['GOOGLECALENDAR_EVENTS_LIST', 'GOOGLECALENDAR_FIND_EVENT'],
    {
      timeMin,
      timeMax,
      time_min: timeMin,
      time_max: timeMax,
      max_results: maxResults,
      maxResults,
      singleEvents: true,
      single_events: true,
      orderBy: 'startTime',
      calendarId: 'primary',
      calendar_id: 'primary',
    },
    opts.budgetMs ?? 15_000,
  )
  if (!raw || /failed/i.test(raw)) {
    if (opts.failureSink) opts.failureSink.failed = true
    return []
  }
  try {
    const parsed = JSON.parse(raw) as { __calItems?: Array<{ start: string; title: string; allDay?: boolean; kind?: string; rawStart?: string; description?: string }> }
    if (Array.isArray(parsed.__calItems)) return calItemsToNextRows(hydrateCalItems(parsed.__calItems), 'c')
    return calItemsToNextRows(parseComposioCalendarData(parsed), 'c')
  } catch {
    return []
  }
}

export function localHourParts(iso: string, timezone: string): string {
  const d = new Date(iso)
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    weekday: 'short',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  }).formatToParts(d)
  const get = (t: string) => parts.find((p) => p.type === t)?.value || ''
  return `${get('weekday')} ${get('hour')}:${get('minute')} ${get('dayPeriod')}`
}

export async function findFreeSlots(
  sql: SQL,
  userId: string,
  timezone: string,
): Promise<Array<{ start: string; end: string; label: string }>> {
  const access = await googleAccessToken(sql, userId, 'calendar')
  if (!access) return []
  const now = new Date()
  const end = new Date(now.getTime() + 5 * 24 * 60 * 60 * 1000)
  const res = await fetch('https://www.googleapis.com/calendar/v3/freeBusy', {
    method: 'POST',
    headers: { Authorization: `Bearer ${access}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      timeMin: now.toISOString(),
      timeMax: end.toISOString(),
      items: [{ id: 'primary' }],
    }),
  })
  if (!res.ok) return []
  const data = (await res.json()) as {
    calendars?: { primary?: { busy?: Array<{ start: string; end: string }> } }
  }
  const busy = (data.calendars?.primary?.busy || []).map((b) => ({
    start: new Date(b.start).getTime(),
    end: new Date(b.end).getTime(),
  }))
  const slots: Array<{ start: string; end: string; label: string }> = []
  const cursor = new Date(now)
  cursor.setMinutes(cursor.getMinutes() < 30 ? 30 : 60, 0, 0)
  while (slots.length < 3 && cursor.getTime() < end.getTime()) {
    const hour = Number(
      new Intl.DateTimeFormat('en-US', { timeZone: timezone, hour: 'numeric', hour12: false }).format(cursor),
    )
    const startMs = cursor.getTime()
    const endMs = startMs + 30 * 60 * 1000
    const overlap = busy.some((b) => startMs < b.end && endMs > b.start)
    if (hour >= 9 && hour < 17 && !overlap) {
      const startIso = new Date(startMs).toISOString()
      const endIso = new Date(endMs).toISOString()
      slots.push({ start: startIso, end: endIso, label: localHourParts(startIso, timezone) })
    }
    cursor.setMinutes(cursor.getMinutes() + 30)
  }
  return slots
}

export async function calendarHold(
  sql: SQL,
  userId: string,
  input: { title: string; start: string; end: string; operationId?: string; attendees?: string[] },
): Promise<{ ok: boolean; error?: string; eventId?: string; outcomeUnknown?: boolean; attendees?: string[] }> {
  const access = await googleAccessToken(sql, userId, 'calendar')
  if (!access) {
    const out = await composioFirst(
      userId,
      ['GOOGLECALENDAR_CREATE_EVENT', 'GOOGLECALENDAR_EVENTS_INSERT'],
      {
        summary: input.title,
        start_datetime: input.start,
        end_datetime: input.end,
        start: { dateTime: input.start },
        end: { dateTime: input.end },
        ...(input.attendees?.length ? { attendees: input.attendees.join(',') } : {}),
      },
    )
    if (out && !/failed/i.test(out)) {
      const eventId = /\b(?:event[_ ]?id|id)["':=\s]+([a-z0-9_-]{4,})/i.exec(out)?.[1]
      return eventId ? { ok: true, eventId } : { ok: false, outcomeUnknown: true, error: 'Calendar returned no durable event receipt.' }
    }
    return { ok: false, error: 'Calendar is not connected.' }
  }
  const stableId = input.operationId?.replace(/[^a-f0-9]/gi, '').toLowerCase().slice(0, 52)
  const attendees = (input.attendees || []).map((a) => a.trim()).filter((a) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(a)).slice(0, 20)
  let res: Response
  try {
    res = await fetch('https://www.googleapis.com/calendar/v3/calendars/primary/events', {
      method: 'POST',
      headers: { Authorization: `Bearer ${access}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...(stableId && stableId.length >= 5 ? { id: stableId } : {}),
        summary: input.title,
        start: { dateTime: input.start },
        end: { dateTime: input.end },
        status: 'tentative',
        ...(attendees.length ? { attendees: attendees.map((email) => ({ email })) } : {}),
      }),
    })
  } catch {
    if (stableId && stableId.length >= 5) {
      const check = await fetch(`https://www.googleapis.com/calendar/v3/calendars/primary/events/${stableId}`, { headers: { Authorization: `Bearer ${access}` } }).catch(() => null)
      if (check?.ok) return { ok: true, eventId: stableId }
    }
    return { ok: false, outcomeUnknown: true, error: 'Calendar did not confirm whether the event was created.' }
  }
  if (!res.ok) return { ok: false, error: `Calendar hold failed (${res.status}).` }
  const data = (await res.json()) as { id?: string }
  return data.id
    ? { ok: true, eventId: data.id }
    : { ok: false, outcomeUnknown: true, error: 'Calendar accepted the event but returned no durable receipt.' }
}

export async function mutateCalendarEvent(
  sql: SQL,
  userId: string,
  input: { eventId: string; action: 'inspect' | 'update' | 'cancel' | 'rsvp'; start?: string; end?: string; response?: 'accepted' | 'declined' | 'tentative'; scope?: 'occurrence' | 'series'; userEmail?: string; addAttendees?: string[] },
): Promise<{ ok: boolean; event?: Record<string, unknown>; error?: string; outcomeUnknown?: boolean }> {
  const access = await googleAccessToken(sql, userId, 'calendar')
  if (!access) return { ok: false, error: 'Calendar is not connected.' }
  const root = 'https://www.googleapis.com/calendar/v3/calendars/primary/events/'
  const read = async (id: string) => {
    const res = await fetch(`${root}${encodeURIComponent(id)}`, { headers: { Authorization: `Bearer ${access}` } })
    return res.ok ? await res.json() as Record<string, unknown> : null
  }
  const existing = await read(input.eventId)
  if (!existing) return { ok: false, error: 'The selected calendar event is stale or unavailable.' }
  const targetId = input.scope === 'series' && typeof existing.recurringEventId === 'string' ? existing.recurringEventId : input.eventId
  if (input.action === 'inspect') return { ok: true, event: existing }
  try {
    if (input.action === 'cancel') {
      const res = await fetch(`${root}${encodeURIComponent(targetId)}?sendUpdates=all`, { method: 'DELETE', headers: { Authorization: `Bearer ${access}` } })
      if (!res.ok && res.status !== 410) return { ok: false, error: `Calendar cancellation failed (${res.status}).` }
      return { ok: true, event: { ...existing, id: targetId, status: 'cancelled' } }
    }
    const patch: Record<string, unknown> = {}
    if (input.action === 'update') {
      if (!input.start || !input.end) return { ok: false, error: 'A new start and end are required.' }
      patch.start = { ...(existing.start as object || {}), dateTime: input.start }
      patch.end = { ...(existing.end as object || {}), dateTime: input.end }
    } else {
      const attendees = Array.isArray(existing.attendees) ? existing.attendees.map((a) => ({ ...(a as object) })) as Array<Record<string, unknown>> : []
      const self = attendees.find((a) => a.self === true || (input.userEmail && a.email === input.userEmail))
      if (!self) return { ok: false, error: 'The provider did not identify this user as an attendee.' }
      self.responseStatus = input.response || 'accepted'
      patch.attendees = attendees
    }
    // Invite guests: merged into the attendee list; the provider emails the
    // invitation because sendUpdates=all rides on the patch below.
    if (input.addAttendees?.length) {
      const attendees = Array.isArray(patch.attendees)
        ? (patch.attendees as Array<Record<string, unknown>>)
        : Array.isArray(existing.attendees)
          ? existing.attendees.map((a) => ({ ...(a as object) })) as Array<Record<string, unknown>>
          : []
      const known = new Set(attendees.map((a) => String(a.email || '').toLowerCase()))
      const added: string[] = []
      for (const raw of input.addAttendees.slice(0, 20)) {
        const email = raw.trim().toLowerCase()
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || known.has(email)) continue
        attendees.push({ email })
        added.push(email)
      }
      if (!added.length) return { ok: false, error: 'No new valid attendee emails to invite.' }
      patch.attendees = attendees
    }
    const res = await fetch(`${root}${encodeURIComponent(targetId)}?sendUpdates=all`, {
      method: 'PATCH', headers: { Authorization: `Bearer ${access}`, 'Content-Type': 'application/json' }, body: JSON.stringify(patch),
    })
    if (!res.ok) return { ok: false, error: `Calendar update failed (${res.status}).` }
    const readBack = await read(targetId)
    return readBack ? { ok: true, event: readBack } : { ok: false, outcomeUnknown: true, error: 'Calendar accepted the change but readback failed.' }
  } catch {
    return { ok: false, outcomeUnknown: true, error: 'Calendar did not confirm the final event state.' }
  }
}
