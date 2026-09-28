/**
 * Bot-side ops for the experience-gap pass: durable turn anchors, waiting-on
 * thread state, inbox actions, forward, attachment reads, and calendar
 * conflict checks. Every helper fails open (null / ok:false) — a server miss
 * degrades to the old behaviour, it never invents a result.
 */

function apiBase(): string {
  return (process.env.HIREALPHA_API_URL || process.env.HIREALPHA_BASE_URL || '').trim().replace(/\/$/, '')
}

function authHeaders(): Record<string, string> {
  return { 'content-type': 'application/json', authorization: `Bearer ${process.env.HIREALPHA_INTERNAL_KEY || ''}` }
}

async function call<T>(path: string, init: RequestInit, ms: number): Promise<T | null> {
  const base = apiBase()
  const key = process.env.HIREALPHA_INTERNAL_KEY || ''
  if (!base || !key) return null
  try {
    const res = await fetch(`${base}${path}`, { ...init, headers: authHeaders(), signal: AbortSignal.timeout(ms) })
    const data = (await res.json().catch(() => ({}))) as T
    return res.ok ? data : null
  } catch {
    return null
  }
}

/* ---- Turn anchors ---- */

export type TurnAnchor = {
  kind: string
  ref: Record<string, unknown>
  createdAt: string
  expiresAt: string
}

export function anchorKinds() {
  return [
    'draft', 'event', 'thread', 'person', 'browser_job',
    'reminder', 'selection', 'build', 'pending_event_action', 'pending_followup_ask',
  ] as const
}

export async function fetchTurnAnchors(phone: string, persona: string): Promise<TurnAnchor[]> {
  const data = await call<{ anchors?: TurnAnchor[] }>(
    `/api/internal/anchors?phone=${encodeURIComponent(phone)}&persona=${encodeURIComponent(persona)}`,
    { method: 'GET' }, 4000,
  )
  return Array.isArray(data?.anchors) ? data!.anchors! : []
}

export async function setTurnAnchorRemote(
  phone: string, persona: string, kind: string, ref: Record<string, unknown>, ttlHours?: number,
): Promise<boolean> {
  const data = await call<{ ok?: boolean }>(
    '/api/internal/anchors',
    { method: 'POST', body: JSON.stringify({ phone, persona, kind, ref, ttlHours }) }, 4000,
  )
  return !!data?.ok
}

export async function clearTurnAnchorRemote(phone: string, persona: string, kind: string): Promise<void> {
  await call('/api/internal/anchors', { method: 'DELETE', body: JSON.stringify({ phone, persona, kind }) }, 4000)
}

/* ---- Canonical draft fetch (anchor -> store) ---- */

export type PendingDraft = {
  id: string
  kind: string
  toAddr: string
  toName?: string
  subject: string
  body: string
  threadId?: string
  status: string
  version: number
}

/** The current content of a pending draft, straight from the canonical store.
 * status 'sent'/'canceled'/'outcome_unknown' comes back for fencing. */
export async function fetchPendingDraft(phone: string, draftId: string): Promise<PendingDraft | { status: string; version?: number } | null> {
  const data = await call<{ ok?: boolean; draft?: PendingDraft; status?: string; version?: number }>(
    `/api/internal/mail/draft/${encodeURIComponent(draftId)}?phone=${encodeURIComponent(phone)}`,
    { method: 'GET' }, 6000,
  )
  if (!data) return null
  if (data.ok && data.draft) return data.draft
  return { status: data.status || 'not_found', version: data.version }
}

/* ---- Waiting-on thread state ---- */

export type ThreadStateRow = {
  threadId: string
  participant: string
  subject: string
  direction: 'inbound' | 'outbound'
  awaiting: 'them' | 'me' | 'none'
  lastActivityAt: string
}

export async function fetchMailState(
  phone: string, persona: string,
  opts: { kind?: 'waiting_on_them' | 'waiting_on_me' | 'all'; refreshThreadId?: string } = {},
): Promise<{ rows: ThreadStateRow[]; refresh?: { awaiting: string; lastFrom: string; lastDate: string; lastFromMatchesParticipant?: boolean; messages: Array<{ from: string; date: string; subject: string }> } } | null> {
  const params = new URLSearchParams({ phone, persona, kind: opts.kind || 'all' })
  if (opts.refreshThreadId) params.set('refreshThreadId', opts.refreshThreadId)
  const data = await call<{ rows?: ThreadStateRow[]; refresh?: { awaiting: string; lastFrom: string; lastDate: string; lastFromMatchesParticipant?: boolean; messages: Array<{ from: string; date: string; subject: string }> } }>(
    `/api/internal/mail/state?${params.toString()}`, { method: 'GET' }, 8000,
  )
  if (!data || !Array.isArray(data.rows)) return null
  return { rows: data.rows, refresh: data.refresh }
}

/* ---- Inbox actions / forward / attachments ---- */

export async function mailInboxAction(
  phone: string, persona: string,
  ids: string[], action: 'mark_read' | 'mark_unread' | 'archive' | 'unarchive' | 'label' | 'trash', label?: string,
): Promise<{ ok: boolean; applied: string[]; failed: Array<{ id: string; error?: string }>; error?: string }> {
  const data = await call<{ ok?: boolean; results?: Array<{ id: string; ok: boolean; error?: string }>; error?: string }>(
    '/api/internal/mail/actions',
    { method: 'POST', body: JSON.stringify({ phone, persona, ids, action, label }) }, 9000,
  )
  if (!data) return { ok: false, applied: [], failed: [], error: 'The mail action did not go through; nothing was changed. Try again.' }
  const results = data.results || []
  return {
    ok: !!data.ok,
    applied: results.filter((r) => r.ok).map((r) => r.id),
    failed: results.filter((r) => !r.ok).map((r) => ({ id: r.id, error: r.error })),
    error: data.error,
  }
}

export async function forwardEmailLive(
  phone: string, persona: string,
  input: { messageId: string; to: string; comment?: string },
): Promise<{ ok: boolean; outcomeUnknown?: boolean; subject?: string; attachedCount?: number; skippedAttachments?: number; error?: string }> {
  const data = await call<{ ok?: boolean; outcomeUnknown?: boolean; subject?: string; attachedCount?: number; skippedAttachments?: number; error?: string }>(
    '/api/internal/mail/forward',
    { method: 'POST', body: JSON.stringify({ phone, persona, ...input }) }, 15000,
  )
  if (!data) return { ok: false, error: 'The forward did not go through; nothing was sent. Try again.' }
  return { ...data, ok: !!data.ok }
}

export async function fetchMailAttachmentLive(
  phone: string, messageId: string, attachmentId: string,
): Promise<{ ok: boolean; status?: string; filename?: string; mimeType?: string; size?: number; text?: string; note?: string; subject?: string; from?: string; threadId?: string; error?: string }> {
  const data = await call<{ ok?: boolean; status?: string; meta?: { filename: string; mimeType: string; size: number }; text?: string; note?: string; source?: { subject: string; from: string; threadId: string }; error?: string }>(
    '/api/internal/mail/attachment',
    { method: 'POST', body: JSON.stringify({ phone, messageId, attachmentId }) }, 12000,
  )
  if (!data) return { ok: false, error: 'The attachment could not be read right now. Ask again in a moment.' }
  return {
    ok: !!data.ok,
    status: data.status,
    filename: data.meta?.filename,
    mimeType: data.meta?.mimeType,
    size: data.meta?.size,
    text: data.text || '',
    note: data.note,
    subject: data.source?.subject,
    from: data.source?.from,
    threadId: data.source?.threadId,
    error: data.error,
  }
}

/* ---- Calendar conflicts ---- */

export async function fetchDayConflicts(phone: string, persona: string, day?: string): Promise<{ ok: boolean; day?: string; count?: number; text?: string; error?: string }> {
  const data = await call<{ ok?: boolean; day?: string; count?: number; text?: string }>(
    '/api/internal/calendar/conflicts',
    { method: 'POST', body: JSON.stringify({ phone, persona, day }) }, 9000,
  )
  if (!data) return { ok: false, error: 'The calendar check did not go through. Try again in a moment.' }
  return { ok: !!data.ok, day: data.day, count: data.count, text: data.text }
}

/* ---- Contacts ---- */

export async function upsertContactLive(
  phone: string, persona: string, person: { name: string; phone?: string; email?: string; note?: string },
): Promise<{ ok: boolean; merged?: boolean; error?: string }> {
  const data = await call<{ ok?: boolean; merged?: boolean; error?: string }>(
    '/api/internal/network',
    { method: 'POST', body: JSON.stringify({ phone, persona, name: person.name, contactPhone: person.phone || '', email: person.email || '', text: person.note || '' }) }, 6000,
  )
  if (!data) return { ok: false, error: 'The people list could not be updated right now.' }
  return { ok: !!data.ok, merged: data.merged }
}
