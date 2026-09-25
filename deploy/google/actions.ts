import type { SQL } from 'bun'
import { isDemoUserId } from '../demoData'
import { googleAccessToken, fetchCalendarItems, composioFirst } from '../connectors/hub'
import { hydrateCalItems, parseComposioCalendarData, type CalItem } from '../calendarEvents'

export function rfc822Raw(
  to: string,
  subject: string,
  body: string,
  extra?: { inReplyTo?: string },
): string {
  const headers = [`To: ${to}`, `Subject: ${subject}`, 'MIME-Version: 1.0', 'Content-Type: text/plain; charset=utf-8']
  const replyTo = extra?.inReplyTo?.trim()
  if (replyTo) {
    headers.push(`In-Reply-To: ${replyTo}`, `References: ${replyTo}`)
  }
  const raw = [...headers, '', body].join('\r\n')
  return Buffer.from(raw).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

export async function gmailSendMessage(
  sql: SQL,
  userId: string,
  draft: { to: string; subject: string; body: string; threadId?: string; inReplyTo?: string },
): Promise<{ ok: boolean; error?: string }> {
  if (isDemoUserId(userId)) return { ok: false, error: 'Demo account. Nothing was actually sent.' }
  const access = await googleAccessToken(sql, userId, 'gmail')
  if (access) {
    const payload: { raw: string; threadId?: string } = {
      raw: rfc822Raw(draft.to, draft.subject, draft.body, { inReplyTo: draft.inReplyTo }),
    }
    if (draft.threadId) payload.threadId = draft.threadId
    const res = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
      method: 'POST',
      headers: { Authorization: `Bearer ${access}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })
    if (res.ok) return { ok: true }
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
  if (out && !/failed/i.test(out)) return { ok: true }
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
    id: `${prefix}-${e.rawStart || e.start.toISOString()}-${i}`,
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
  input: { title: string; start: string; end: string },
): Promise<{ ok: boolean; error?: string; eventId?: string }> {
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
      },
    )
    if (out && !/failed/i.test(out)) return { ok: true }
    return { ok: false, error: 'Calendar is not connected.' }
  }
  const res = await fetch('https://www.googleapis.com/calendar/v3/calendars/primary/events', {
    method: 'POST',
    headers: { Authorization: `Bearer ${access}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      summary: input.title,
      start: { dateTime: input.start },
      end: { dateTime: input.end },
      status: 'tentative',
    }),
  })
  if (!res.ok) return { ok: false, error: `Calendar hold failed (${res.status}).` }
  const data = (await res.json()) as { id?: string }
  return { ok: true, eventId: data.id }
}
