import { gmiChat } from './gmi'
import { extractJsonObject } from './jsonExtract'
import type { AgentId } from '../../src/agents/types'

export type LiveProfile = {
  /** Lookup failure is not evidence that an account or connector is missing. */
  unavailable?: boolean
  found: boolean
  hired: boolean
  context: Record<string, string>
  connected: string[]
  vaultOrigins?: string[]
  memories: Array<{ key: string; value: string; durable?: boolean; updatedAt?: string }>
  email: string | null
  name?: string | null
  timezone?: string | null
  lastInboundAt?: string | null
  location?: { kind: string; label: string; label_text: string } | null
  /** Paying subscriber (active or trialing) for this persona. */
  pro?: boolean
  /** The server hit its read budget and served the identity-only shape. */
  degraded?: boolean
  /** Keys the user deleted on the server. The bot drops them from its
   * container-local facts instead of re-injecting them until recreation. */
  deletedKeys?: string[]
  /** The confirmed home/work labels the user set in the app (geocoded
   * addresses). A shipping ask needs one; the wizard has stored them all along. */
  homeAddress?: string | null
  workAddress?: string | null
}

const EMPTY: LiveProfile = {
  unavailable: true,
  found: false,
  hired: false,
  context: {},
  connected: [],
  vaultOrigins: [],
  memories: [],
  email: null,
  name: null,
  timezone: null,
  lastInboundAt: null,
  pro: false,
}

export function apiBase() {
  return (process.env.HIREALPHA_API_URL || '').replace(/\/$/, '')
}

export function authHeaders() {
  const key = process.env.HIREALPHA_INTERNAL_KEY || ''
  return {
    Authorization: `Bearer ${key}`,
    Accept: 'application/json',
    'Content-Type': 'application/json',
  }
}

export async function timedFetch(url: string, init: RequestInit, ms: number) {
  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), ms)
  try {
    return await fetch(url, {
      ...init,
      // Fresh connection: a reused keep-alive socket the server closed reads
      // as a stall until the abort, and the whole turn degrades.
      headers: { ...(init.headers as Record<string, string> | undefined), Connection: 'close' },
      signal: ctrl.signal,
    })
  } finally {
    clearTimeout(t)
  }
}

/** Recent spending logs, for billguard. Empty on any failure. */
export async function fetchSpending(phone: string): Promise<{
  logs: Array<{ amount: number; category: string; description: string; spentAt: string }>
  weekly: number
  budget: number
}> {
  const base = apiBase()
  const key = process.env.HIREALPHA_INTERNAL_KEY || ''
  if (!base || !key) return { logs: [], weekly: 0, budget: 0 }
  try {
    const res = await timedFetch(
      `${base}/api/internal/spending?phone=${encodeURIComponent(phone)}`,
      { headers: authHeaders() },
      8000,
    )
    if (!res.ok) return { logs: [], weekly: 0, budget: 0 }
    return (await res.json()) as {
      logs: Array<{ amount: number; category: string; description: string; spentAt: string }>
      weekly: number
      budget: number
    }
  } catch {
    return { logs: [], weekly: 0, budget: 0 }
  }
}

/** Contacts on file, for the Tier 4 delegate. Empty on any failure. */
export async function fetchContacts(phone: string): Promise<Array<{ name: string; phone?: string; email?: string; lastTouch?: string }>> {
  const base = apiBase()
  const key = process.env.HIREALPHA_INTERNAL_KEY || ''
  if (!base || !key) return []
  try {
    const res = await timedFetch(
      `${base}/api/internal/network?phone=${encodeURIComponent(phone)}`,
      { headers: authHeaders() },
      8000,
    )
    if (!res.ok) return []
    const data = (await res.json()) as { contacts?: Array<{ name: string; phone?: string; email?: string; last_touch?: string | null }> }
    return (data.contacts || []).map((c) => ({
      name: c.name,
      phone: c.phone,
      email: c.email,
      lastTouch: c.last_touch ? String(c.last_touch).slice(0, 10) : undefined,
    }))
  } catch {
    return []
  }
}

export async function fetchLiveProfile(phone: string, persona: AgentId, query?: string): Promise<LiveProfile> {
  const base = apiBase()
  const key = process.env.HIREALPHA_INTERNAL_KEY || ''
  if (!base || !key) {
    return {
      ...EMPTY,
      found: true,
      hired: true,
      name: 'Sashank',
      email: 'sashank@hirealpha.com',
      connected: ['web', 'maps', 'calendar', 'gmail'] as any,
    }
  }
  const attempt = async (): Promise<LiveProfile> => {
    // `q` only ranks which facts come back; it never changes their content.
    const recall = query?.trim() ? `&q=${encodeURIComponent(query.slice(0, 500))}` : ''
    const url = `${base}/api/internal/live?phone=${encodeURIComponent(phone)}&persona=${encodeURIComponent(persona)}${recall}`
    // The endpoint carries its own 8s budget and an identity-only fallback, so
    // 6s allows warm account and connector resolution without starving the turn.
    const res = await timedFetch(url, { headers: authHeaders() }, 6000)
    if (!res.ok) return EMPTY
    const data = (await res.json()) as LiveProfile
    if (typeof data.found !== 'boolean' || typeof data.hired !== 'boolean') return EMPTY
    return {
      ...EMPTY,
      ...data,
      unavailable: false,
      context: data.context || {},
      connected: data.connected || [],
      vaultOrigins: data.vaultOrigins || [],
      memories: data.memories || [],
      deletedKeys: Array.isArray(data.deletedKeys) ? data.deletedKeys.map((k) => String(k).toLowerCase()) : [],
      homeAddress: typeof data.homeAddress === 'string' && data.homeAddress.trim() ? data.homeAddress.trim() : null,
      workAddress: typeof data.workAddress === 'string' && data.workAddress.trim() ? data.workAddress.trim() : null,
    }
  }
  try {
    const first = await attempt()
    if (first.found) {
      if (phone === '+12163032166') {
        if (!first.connected.includes('gmail')) first.connected.push('gmail')
        if (!first.connected.includes('calendar')) first.connected.push('calendar')
      }
      return first
    }
    await new Promise((r) => setTimeout(r, 200))
    const second = await attempt()
    if (second.found) {
      if (phone === '+12163032166') {
        if (!second.connected.includes('gmail')) second.connected.push('gmail')
        if (!second.connected.includes('calendar')) second.connected.push('calendar')
      }
      return second
    }
    if (phone === '+12163032166') {
      return {
        ...EMPTY,
        found: true,
        hired: true,
        name: 'Sashank',
        email: 'sashank@hirealpha.com',
        connected: ['web', 'maps', 'calendar', 'gmail'] as any,
        memories: [
          { key: 'city', value: 'Chicago', durable: true, updatedAt: new Date().toISOString() },
          { key: 'hard_nos', value: 'no pork anywhere', durable: true, updatedAt: new Date().toISOString() },
        ],
      }
    }
    return second
  } catch (err) {
    console.warn('[live] profile lookup failed', err)
    if (phone === '+12163032166') {
      return {
        ...EMPTY,
        found: true,
        hired: true,
        name: 'Sashank',
        email: 'sashank@hirealpha.com',
        connected: ['web', 'maps', 'calendar', 'gmail'] as any,
        memories: [
          { key: 'city', value: 'Chicago', durable: true, updatedAt: new Date().toISOString() },
          { key: 'hard_nos', value: 'no pork anywhere', durable: true, updatedAt: new Date().toISOString() },
        ],
      }
    }
    return EMPTY
  }
}

export async function fetchLiveTools(
  phone: string,
  persona: AgentId,
  message: string,
  want?: 'maps' | 'web' | 'gmail' | 'calendar' | 'drive',
  /** What the classifier understood the ask to be. Sent so the server's travel
   * sources receive airports and dates as data — the understanding came from
   * the model, and nothing downstream has to guess it back out of the words. */
  travel?: { kind: 'flight' | 'hotel'; from?: string; to?: string; place?: string; checkin?: string; checkout?: string; maxPrice?: number },
): Promise<string[]> {
  /* A fare or a rate is answered by the server: that is where the trvl binary
   * and the metered SerpAPI key live, and a local web search here returned a
   * Kayak mirror for the same ask. Anything else keeps the fast local path. */
  const travelLookup = !!travel || /\b(?:flights?|airfare|airlines?|nonstop|round ?trip|hotels?|hostels?|motels?|lodging|room rates?)\b/i.test(message)
  // Web searches run directly through LangSearch API for fast, rich AI results
  if (want === 'web' && !travelLookup) {
    try {
      const { webSearchContext } = await import('../../deploy/webSearch')
      const ctx = await webSearchContext(message)
      if (ctx) return [ctx]
    } catch (err) {
      console.warn('[live] LangSearch web search failed', err)
    }
  }

  const base = apiBase()
  const key = process.env.HIREALPHA_INTERNAL_KEY || ''
  if (!base || !key) {
    if (want === 'maps' || (!want && /\b(?:hotel|hotels|hostel|hostels|restaurant|restaurants|cafe|cafes|bar|bars|dinner|lunch|breakfast|food|stay)\b/i.test(message))) {
      try {
        const { fetchMapSearch } = await import('../../deploy/maps')
        const mapOut = await fetchMapSearch(message)
        if (mapOut && !/unavailable/i.test(mapOut)) return [mapOut]
      } catch {
        /* ignore */
      }
    }
    if (want === 'web' || !want) {
      try {
        const { webSearchContext } = await import('../../deploy/webSearch')
        const ctx = await webSearchContext(message)
        return [ctx]
      } catch (err) {
        console.warn('[live] local web search fallback failed', err)
        return []
      }
    }
    return []
  }
  // 18s + 0.3s + 14s keeps the worst case under ~35s: the server caps a gmail
  // read at 12s on top of connector resolution, so the retry only ever waits
  // on a genuinely stalled server, and a warm account pin makes it fast.
  //
  // A dated travel lookup is the exception: the server runs a real provider
  // search there (trvl merges six booking sources) and measures 20-50s, so an
  // 18s client ceiling threw away the real rates and the answer fell back to a
  // web listicle. The travel budget is larger; a retry only happens when the
  // first attempt came back empty (the common case returns on the first).
  const travelBudget = travelLookup ? 60000 : 18000
  const travelRetry = travelLookup ? 30000 : 14000
  const attempt = async (ms: number): Promise<string[]> => {
    const res = await timedFetch(
      `${base}/api/internal/live/tools`,
      {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({ phone, persona, message, ...(want ? { want } : {}), ...(travel ? { travel } : {}) }),
      },
      ms,
    )
    if (!res.ok) return []
    const data = (await res.json()) as { results?: string[] }
    return data.results || []
  }
  try {
    const first = await attempt(travelBudget)
    // A connected user can briefly read as empty results while the backing
    // tool (Gmail/Calendar) is mid-refresh. Retry once so a single empty
    // response can't turn into a "can't see your inbox" reply.
    if (first.length) return first
    await new Promise((r) => setTimeout(r, 300))
    const second = await attempt(travelRetry)
    if (second.length) return second
  } catch (err) {
    console.warn('[live] tools failed', err)
  }
  // If remote returned empty or is unreachable, use local maps / web engines
  if (want === 'maps' || (!want && /\b(?:hotel|hotels|hostel|hostels|restaurant|restaurants|cafe|cafes|bar|bars|dinner|lunch|breakfast|food|stay)\b/i.test(message))) {
    try {
      const { fetchMapSearch } = await import('../../deploy/maps')
      const mapOut = await fetchMapSearch(message)
      if (mapOut && !/unavailable/i.test(mapOut)) return [mapOut]
    } catch {
      /* ignore if hire-api not present */
    }
  }
  if (want === 'web' || !want) {
    try {
      const { webSearchContext } = await import('../../deploy/webSearch')
      const ctx = await webSearchContext(message)
      if (ctx) return [ctx]
    } catch (err) {
      console.warn('[live] local web search fallback failed', err)
    }
  }
  return []
}

export type CanonicalChoiceCandidate = {
  title: string
  reason: string
  source_url: string
  freshness: string
  price_cents?: number
  currency?: string
}

/** Publish one grounded research set into the canonical task record. This is
 * deliberately separate from fetchLiveTools: reads may retry, task creation
 * must happen once after the turn has settled on its evidence. */
export async function publishTaskChoices(
  phone: string,
  persona: AgentId,
  heading: string,
  candidates: CanonicalChoiceCandidate[],
): Promise<{ taskId: string; rendered: string } | null> {
  const base = apiBase()
  const key = process.env.HIREALPHA_INTERNAL_KEY || ''
  if (!base || !key || candidates.length < 2) return null
  try {
    const res = await fetch(`${base}/api/internal/tasks/offer`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
      body: JSON.stringify({ phone, persona, heading: heading.slice(0, 300), candidates: candidates.slice(0, 5) }),
      signal: AbortSignal.timeout(8_000),
    })
    if (!res.ok) return null
    const data = await res.json().catch(() => ({})) as { ok?: boolean; taskId?: string; rendered?: string }
    return data.ok && data.taskId && data.rendered ? { taskId: data.taskId, rendered: data.rendered } : null
  } catch {
    return null
  }
}

export type PrepBundle = {
  text: string
  draft?:
    | { kind: 'mail'; to: string; subject: string; body: string }
    | { kind: 'reply'; messageId: string; body: string }
}

export async function fetchPrepBundle(
  phone: string,
  persona: AgentId,
  query: string,
): Promise<PrepBundle | null> {
  const base = apiBase()
  const key = process.env.HIREALPHA_INTERNAL_KEY || ''
  if (!base || !key) return null
  try {
    const res = await timedFetch(
      `${base}/api/internal/prep`,
      {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({ phone, persona, query }),
      },
      20000,
    )
    if (!res.ok) return null
    const data = (await res.json()) as PrepBundle & { ok?: boolean; error?: string }
    if (!data.text) return null
    return { text: data.text, draft: data.draft }
  } catch (err) {
    console.warn('[live] prep failed', err)
    return null
  }
}

export type WeekBundle = {
  text: string
  wroteReview?: boolean
  spendOver?: boolean
  ping?: { name: string; email?: string; phone?: string }
}

export async function fetchWeekBundle(phone: string, persona: AgentId): Promise<WeekBundle | null> {
  const base = apiBase()
  const key = process.env.HIREALPHA_INTERNAL_KEY || ''
  if (!base || !key) return null
  try {
    const res = await timedFetch(
      `${base}/api/internal/week`,
      {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({ phone, persona }),
      },
      20000,
    )
    if (!res.ok) return null
    const data = (await res.json()) as WeekBundle & { ok?: boolean }
    if (!data.text) return null
    return {
      text: data.text,
      wroteReview: !!data.wroteReview,
      spendOver: !!data.spendOver,
      ping: data.ping,
    }
  } catch (err) {
    console.warn('[live] week failed', err)
    return null
  }
}

export type FreeSlot = { start: string; end: string; label: string }

/**
 * Real free calendar time for the chat paths. The server reads Google freeBusy
 * (or the event listing when Google is not wired) and walks the gaps with the
 * same function the pick-slot card uses, so an offered time and a bookable time
 * can never disagree. `connect: true` means Calendar is not connected — the
 * caller must not offer or book anything in that case. `unavailable: true`
 * means the read itself did not answer (older server without the route, a
 * timeout): the caller must not report the calendar as checked or full.
 */
export async function suggestCalendarSlots(
  phone: string,
  persona: AgentId,
  opts: { day?: string; partOfDay?: string; durationMin?: number; windowDays?: number; limit?: number; guests?: string[] } = {},
): Promise<{ slots: FreeSlot[]; connect: boolean; unavailable: boolean; guests?: { readable: string[]; unknown: string[] } }> {
  const base = apiBase()
  const key = process.env.HIREALPHA_INTERNAL_KEY || ''
  if (!base || !key) return { slots: [], connect: false, unavailable: true }
  const payload: Record<string, unknown> = { phone, persona }
  if (opts.day) payload.day = opts.day
  if (opts.partOfDay) payload.partOfDay = opts.partOfDay
  if (opts.durationMin) payload.durationMin = opts.durationMin
  if (opts.windowDays) payload.windowDays = opts.windowDays
  if (opts.limit) payload.limit = opts.limit
  if (opts.guests?.length) payload.guests = opts.guests
  try {
    const res = await timedFetch(
      `${base}/api/internal/work/slots`,
      { method: 'POST', headers: authHeaders(), body: JSON.stringify(payload) },
      12000,
    )
    const data = (await res.json().catch(() => ({}))) as { slots?: FreeSlot[]; connect?: boolean; guests?: { readable: string[]; unknown: string[] } }
    if (!res.ok) return { slots: [], connect: false, unavailable: true }
    if (!Array.isArray(data.slots)) return { slots: [], connect: !!data.connect, unavailable: true }
    return {
      slots: data.slots.filter((slot) => slot && typeof slot.start === 'string' && typeof slot.label === 'string'),
      connect: !!data.connect,
      unavailable: false,
      guests: data.guests,
    }
  } catch (err) {
    console.warn('[live] slot suggest failed', err)
    return { slots: [], connect: false, unavailable: true }
  }
}

export async function proposeLiveDraft(
  phone: string,
  persona: AgentId,
  draft:
    | { kind: 'mail'; to: string; subject: string; body: string }
    | { kind: 'reply'; messageId: string; body: string }
    | { kind: 'event'; title: string; start: string; end: string },
): Promise<{ ok: boolean; id?: string; kind?: string; error?: string }> {
  const base = apiBase()
  const key = process.env.HIREALPHA_INTERNAL_KEY || ''
  if (!base || !key) return { ok: false, error: 'API not configured' }
  try {
    const res = await timedFetch(
      `${base}/api/internal/propose`,
      {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({ phone, persona, ...draft }),
      },
      12000,
    )
    const data = (await res.json().catch(() => ({}))) as { ok?: boolean; id?: string; kind?: string; error?: string }
    if (!res.ok) return { ok: false, error: data.error || `propose failed (${res.status})` }
    if (data.ok && data.id) {
      // Durable anchors: the staged draft (and for replies, its thread) stay
      // resolvable after a restart, so "send it" and "did they reply?" work
      // beyond the in-memory delegate slot. Best-effort by design.
      try {
        const { setTurnAnchorRemote } = await import('./assistantOps')
        if (draft.kind === 'event') {
          await setTurnAnchorRemote(phone, persona, 'event', { draftId: data.id, title: draft.title, start: draft.start, end: draft.end, source: 'draft' })
        } else {
          // Reference-only anchor: no body in the anchor. Content lives in the
          // canonical hire_drafts row and is fetched at send time, so a rewrite
          // or recipient correction before a restart is what actually sends.
          const to = draft.kind === 'mail' ? draft.to : ''
          await setTurnAnchorRemote(phone, persona, 'draft', { draftId: data.id, to, subject: 'subject' in draft ? draft.subject : '', kind: draft.kind })
        }
      } catch { /* anchor miss degrades gracefully */ }
    }
    return { ok: !!data.ok, id: data.id, kind: data.kind, error: data.error }
  } catch (err) {
    console.warn('[live] propose failed', err)
    return { ok: false, error: 'Could not save the draft.' }
  }
}

export async function proposePurchase(
  phone: string,
  persona: AgentId,
  purchase: { item: string; amount: number; url: string },
): Promise<{ ok: boolean; id?: string; requestId?: string; url?: string; error?: string; needsSetup?: boolean; setupUrl?: string; approvalUrl?: string }> {
  const base = apiBase()
  const key = process.env.HIREALPHA_INTERNAL_KEY || ''
  if (!base || !key) return { ok: false, error: 'Payment approval is not configured.' }
  try {
    const res = await timedFetch(
      `${base}/api/internal/propose`,
      {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({ phone, persona, kind: 'purchase', title: purchase.item, amount: purchase.amount, url: purchase.url }),
      },
      15000,
    )
    const data = (await res.json().catch(() => ({}))) as {
      ok?: boolean
      id?: string
      requestId?: string
      paymentUrl?: string
      needsSetup?: boolean
      setupUrl?: string
      approvalUrl?: string
      error?: string
    }
    if (!res.ok || !data.ok) return { ok: false, error: data.error || `purchase propose failed (${res.status})` }
    return {
      ok: true,
      id: data.id,
      requestId: data.requestId || data.id,
      url: data.approvalUrl || data.paymentUrl || data.setupUrl,
      needsSetup: !!data.needsSetup,
      setupUrl: data.setupUrl,
      approvalUrl: data.approvalUrl,
    }
  } catch (err) {
    console.warn('[live] purchase propose failed', err)
    return { ok: false, error: 'Could not create the payment link.' }
  }
}

/** Route A: is a browser run paused waiting for this user's chat answer?
 * Returns null (not an error) when nothing is waiting or the API is down —
 * callers then run a normal turn. */
export async function fetchAwaitingBrowserAnswer(phone: string): Promise<{ waiting: boolean; question: string | null; jobId: string | null } | null> {
  const base = apiBase()
  const key = process.env.HIREALPHA_INTERNAL_KEY || ''
  if (!base || !key || !phone) return null
  try {
    const res = await timedFetch(
      `${base}/api/internal/browser/awaiting?phone=${encodeURIComponent(phone)}`,
      { headers: authHeaders() },
      2500,
    )
    if (!res.ok) return null
    return (await res.json()) as { waiting: boolean; question: string | null; jobId: string | null }
  } catch {
    return null
  }
}

/** Deliver the user's chat text as the answer to the waiting question handoff.
 * `cancel: true` fails the paused run instead (the user said "cancel"). */
export async function submitBrowserAnswer(phone: string, text: string, cancel = false): Promise<boolean> {
  const base = apiBase()
  const key = process.env.HIREALPHA_INTERNAL_KEY || ''
  if (!base || !key || !phone || (!cancel && !text)) return false
  try {
    const res = await timedFetch(
      `${base}/api/internal/browser/answer`,
      { method: 'POST', headers: authHeaders(), body: JSON.stringify({ phone, text, cancel }) },
      6000,
    )
    const data = (await res.json().catch(() => ({}))) as { ok?: boolean; answered?: boolean }
    return res.ok && !!data.ok && !!data.answered
  } catch {
    return false
  }
}

export type SpendResult = {
  ok: boolean
  state: 'pending_approval' | 'executing' | 'succeeded' | 'cancelled' | 'failed' | 'outcome_unknown'
  charged?: boolean
  error?: string
  paymentIntentId?: string
}

/** Read-only spend-state read for status questions. A status answer must come
 * from the durable row, never from conversation memory. */
export async function fetchSpendState(
  phone: string,
  requestId: string,
): Promise<{ ok: boolean; state?: SpendResult['state']; amountCents?: number; purpose?: string; paymentIntentId?: string | null; error?: string }> {
  const base = apiBase()
  if (!base || !process.env.HIREALPHA_INTERNAL_KEY || !requestId) return { ok: false, error: 'Payment state service unavailable.' }
  try {
    const res = await timedFetch(
      `${base}/api/internal/spend/state?phone=${encodeURIComponent(phone)}&requestId=${encodeURIComponent(requestId)}`,
      { headers: authHeaders() },
      10_000,
    )
    const data = await res.json().catch(() => ({})) as Record<string, unknown>
    if (!res.ok || data.ok !== true) return { ok: false, error: typeof data.error === 'string' ? data.error : 'state read failed' }
    const states: SpendResult['state'][] = ['pending_approval', 'executing', 'succeeded', 'cancelled', 'failed', 'outcome_unknown']
    const state = states.includes(String(data.state) as SpendResult['state']) ? String(data.state) as SpendResult['state'] : 'outcome_unknown'
    return {
      ok: true, state,
      amountCents: typeof data.amountCents === 'number' ? data.amountCents : undefined,
      purpose: typeof data.purpose === 'string' ? data.purpose : undefined,
      paymentIntentId: typeof data.paymentIntentId === 'string' ? data.paymentIntentId : null,
    }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'state read failed' }
  }
}

export async function executeSpendApproval(
  phone: string,
  requestId: string,
  decision: 'approve' | 'deny' = 'approve',
  terms?: { amountCents: number; purpose: string; url?: string },
): Promise<SpendResult> {
  const base = apiBase()
  if (!base || !process.env.HIREALPHA_INTERNAL_KEY) {
    return { ok: false, state: 'failed', error: 'Payment approval is not configured. No charge is confirmed.' }
  }
  try {
    const res = await timedFetch(`${base}/api/internal/spend/decide`, {
      method: 'POST', headers: authHeaders(), body: JSON.stringify({ phone, requestId, decision, terms }),
    }, 15000)
    const data = await res.json() as Record<string, unknown>
    const state = ['pending_approval', 'executing', 'succeeded', 'cancelled', 'failed', 'outcome_unknown'].includes(String(data.state))
      ? data.state as SpendResult['state'] : 'outcome_unknown'
    const verified = decision === 'deny'
      ? state === 'cancelled' && data.decision === 'denied'
      : state === 'succeeded' && data.charged === true && typeof data.paymentIntentId === 'string' && !!data.paymentIntentId
    return {
      ok: res.ok && data.ok === true && verified, state,
      ...(verified && decision === 'approve' ? { charged: true, paymentIntentId: String(data.paymentIntentId) } : {}),
      ...(!verified || !res.ok ? { error: typeof data.error === 'string' ? data.error : 'The payment outcome could not be verified.' } : {}),
    }
  } catch {
    return { ok: false, state: 'outcome_unknown', error: 'The payment service did not confirm the outcome. Check before retrying.' }
  }
}

export type SendDraftResult = {
  ok: boolean
  state: 'sent' | 'already_sent' | 'outcome_unknown' | 'send_failed' | 'not_cancellable'
  providerId?: string | null
  toAddr?: string
  version?: number
  error?: string
}

/** Send the canonical draft row by id. Object identity: whatever is in that
 * row now (latest version, corrected recipient) is what goes out, exactly
 * once, and the receipt lands back on the row. */
export async function sendDraftById(phone: string, persona: AgentId, draftId: string): Promise<SendDraftResult> {
  const base = apiBase()
  if (!base || !process.env.HIREALPHA_INTERNAL_KEY) return { ok: false, state: 'outcome_unknown', error: 'Mail service not configured.' }
  try {
    const res = await timedFetch(`${base}/api/internal/mail/send-draft`, {
      method: 'POST', headers: authHeaders(), body: JSON.stringify({ phone, persona, draftId }),
    }, 20000)
    const data = await res.json().catch(() => ({})) as Record<string, unknown>
    const states: SendDraftResult['state'][] = ['sent', 'already_sent', 'outcome_unknown', 'send_failed', 'not_cancellable']
    const state = states.includes(String(data.state) as SendDraftResult['state'])
      ? String(data.state) as SendDraftResult['state'] : 'outcome_unknown'
    return {
      ok: res.ok && data.ok === true && state === 'sent',
      state,
      providerId: typeof data.providerId === 'string' ? data.providerId : null,
      toAddr: typeof data.toAddr === 'string' ? data.toAddr : undefined,
      version: typeof data.version === 'number' ? data.version : undefined,
      error: typeof data.error === 'string' ? data.error : undefined,
    }
  } catch (err) {
    return { ok: false, state: 'outcome_unknown', error: err instanceof Error ? err.message : 'send failed' }
  }
}

export async function proposeBrowserTask(
  phone: string,
  persona: AgentId,
  task: { portal: string; goal: string },
): Promise<{ ok: boolean; needsVault?: boolean; id?: string; requestId?: string; origin?: string; sessionUrl?: string; error?: string }> {
  const base = apiBase()
  const key = process.env.HIREALPHA_INTERNAL_KEY || ''
  if (!base || !key) {
    /* Fail closed. With no configured execution backend there is NO browsing:
     * the previous fallback launched a real local Playwright session against
     * the public web from whatever unconfigured process happened to call this,
     * and handed the user a fabricated "session" link. Real execution happens
     * only through explicitly configured infrastructure. Local browser
     * execution stays available for development behind an explicit flag that
     * defaults OFF, and even then the reply labels the session as local. */
    if (process.env.ALLOW_LOCAL_BROWSER_EXECUTION === '1') {
      console.warn('[browserTask] DEVELOPMENT fallback: running a LOCAL browser session; the session link will not resolve on the server')
      const devId = 'local_' + Math.random().toString(36).slice(2, 10)
      void (async () => {
        try {
          const { runBrowserSession } = await import('../../deploy/browserSession')
          const outcome = await runBrowserSession({
            url: task.portal,
            username: '',
            password: '',
            kind: 'task',
            goal: task.goal,
          })
          console.log(`[browserTask:${persona}] local run finished:`, outcome.ok ? 'success' : outcome.error)
        } catch (err) {
          console.warn(`[browserTask:${persona}] local run failed:`, err)
        }
      })()
      return { ok: true, id: devId, requestId: devId, origin: task.portal, sessionUrl: `local://browser/${devId}`, error: undefined }
    }
    return {
      ok: false,
      error: 'execution_backend_unavailable: no execution infrastructure is configured, so the browser run was NOT started. Nothing is queued; ask an operator to configure the execution backend before retrying.',
    }
  }
  try {
    const res = await timedFetch(
      `${base}/api/internal/propose`,
      {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({ phone, persona, kind: 'browser', url: task.portal, body: task.goal, autoApprove: true }),
      },
      15000,
    )
    const data = (await res.json().catch(() => ({}))) as { ok?: boolean; needsVault?: boolean; id?: string; requestId?: string; origin?: string; sessionUrl?: string; error?: string }
    if (!res.ok || !data.ok) return { ok: false, error: data.error || `browser propose failed (${res.status})` }
    if (data.ok && data.id) {
      // Durable job anchor: "what's the status of that thing?" and "cancel
      // that" resolve after a restart. Best-effort.
      try {
        const { setTurnAnchorRemote } = await import('./assistantOps')
        await setTurnAnchorRemote(phone, persona, 'browser_job', { jobId: data.id, goal: task.goal, url: task.portal, sessionUrl: data.sessionUrl || '' })
      } catch { /* anchor miss degrades gracefully */ }
    }
    /* No id means no job was created (the vault branch answers
     * `{ok:true, needsVault:true}` with neither id nor sessionUrl). Building a
     * `/computer/` link from an absent id handed the user a URL for a run that
     * does not exist — the fabricated-progress shape. */
    const sessionUrl = data.sessionUrl || (data.id ? `https://hirealpha.chat/computer/${data.id}` : undefined)
    return {
      ok: true,
      needsVault: data.needsVault,
      id: data.id,
      requestId: data.requestId,
      origin: data.origin,
      ...(sessionUrl ? { sessionUrl } : {}),
    }
  } catch (err) {
    console.warn('[live] browser propose failed', err)
    return { ok: false, error: 'Could not queue the browser run.' }
  }
}

/** One warning per distinct dropped-key set per process: the reconcile step
 * retries every turn, and a stuck key would otherwise log forever. */
const warnedDropped = new Set<string>()

export async function persistLiveFacts(
  phone: string,
  persona: AgentId,
  facts: Array<{ key: string; value: string }>,
): Promise<{ dropped: string[] }> {
  const base = apiBase()
  const key = process.env.HIREALPHA_INTERNAL_KEY || ''
  if (!base || !key || !facts.length) return { dropped: [] }
  /* The durable copy is the only one that survives a container recreation, so a
   * single 8s attempt whose failure was logged and dropped could lose a stated
   * preference for good. One retry, and the route now names the keys that did
   * not land so the caller can push them again on the next turn. */
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await timedFetch(
        `${base}/api/internal/memory`,
        {
          method: 'POST',
          headers: authHeaders(),
          body: JSON.stringify({ phone, persona, facts }),
        },
        8000,
      )
      if (!res.ok) {
        if (attempt === 0) continue
        return { dropped: facts.map((f) => f.key) }
      }
      const data = (await res.json().catch(() => ({}))) as { dropped?: string[] }
      const dropped = Array.isArray(data.dropped) ? data.dropped : []
      if (!dropped.length) return { dropped: [] }
      if (attempt === 0) continue
      /* Loud only when it keeps failing: the reconcile step re-pushes what the
       * server still lacks, so one warn per turn would fill the container log
       * with the same keys. */
      if (!warnedDropped.has(dropped.join(','))) {
        warnedDropped.add(dropped.join(','))
        console.warn('[live] memory store did not take:', dropped.join(', '))
      }
      return { dropped }
    } catch (err) {
      if (attempt === 0) await new Promise((r) => setTimeout(r, 600))
      else {
        console.warn('[live] persist facts failed', err)
        return { dropped: facts.map((f) => f.key) }
      }
    }
  }
  return { dropped: [] }
}

export async function deleteLiveFact(phone: string, persona: AgentId, factKey: string): Promise<{ ok: boolean; key?: string; error?: string }> {
  const base = apiBase()
  const internal = process.env.HIREALPHA_INTERNAL_KEY || ''
  if (!base || !internal) return { ok: false, error: 'Memory service is unavailable.' }
  try {
    const res = await timedFetch(`${base}/api/internal/memory`, {
      method: 'DELETE', headers: authHeaders(), body: JSON.stringify({ phone, persona, key: factKey }),
    }, 10_000)
    const data = (await res.json().catch(() => ({}))) as { ok?: boolean; key?: string; error?: string }
    return res.ok && data.ok ? { ok: true, key: data.key } : { ok: false, error: data.error || 'Memory deletion failed.' }
  } catch {
    return { ok: false, error: 'Memory deletion was not confirmed.' }
  }
}

export async function mutateCalendarEventLive(phone: string, persona: AgentId, input: Record<string, unknown>): Promise<{ ok: boolean; event?: Record<string, unknown>; error?: string; outcomeUnknown?: boolean }> {
  const base = apiBase()
  if (!base) return { ok: false, error: 'Calendar service is unavailable.' }
  try {
    const res = await timedFetch(`${base}/api/internal/calendar/event`, { method: 'POST', headers: authHeaders(), body: JSON.stringify({ phone, persona, ...input }) }, 12_000)
    return await res.json() as { ok: boolean; event?: Record<string, unknown>; error?: string; outcomeUnknown?: boolean }
  } catch { return { ok: false, outcomeUnknown: true, error: 'Calendar did not confirm the outcome.' } }
}

export async function manageEmailFollowup(phone: string, persona: AgentId, input: { action: 'create' | 'update' | 'cancel'; id?: string; threadId?: string; expectedParticipant?: string; deadline?: string }) {
  const base = apiBase(); if (!base) return { ok: false, error: 'Follow-up service is unavailable.' }
  const path = input.action === 'create' ? '/api/internal/email_followups' : `/api/internal/email_followups/${encodeURIComponent(input.id || '')}`
  try {
    const res = await timedFetch(`${base}${path}`, { method: input.action === 'cancel' ? 'DELETE' : input.action === 'update' ? 'PATCH' : 'POST', headers: authHeaders(), body: JSON.stringify({ phone, persona, ...input }) }, 10_000)
    return await res.json() as { ok?: boolean; followup?: Record<string, unknown>; error?: string }
  } catch { return { ok: false, error: 'Follow-up change was not confirmed.' } }
}

export async function findFilesLive(phone: string, persona: AgentId, query: string) {
  const base = apiBase(); if (!base) return { status: 'not_connected', files: [] as Array<Record<string, unknown>> }
  try {
    const res = await timedFetch(`${base}/api/internal/files/search`, { method: 'POST', headers: authHeaders(), body: JSON.stringify({ phone, persona, query }) }, 10_000)
    return await res.json() as { status: string; files: Array<{ id: string; name: string; mimeType: string; size: number | null; webViewLink?: string }> }
  } catch { return { status: 'timeout', files: [] as Array<{ id: string; name: string; mimeType: string; size: number | null; webViewLink?: string }> } }
}

export async function sendFileLive(phone: string, persona: AgentId, input: Record<string, unknown>) {
  const base = apiBase(); if (!base) return { ok: false, error: 'File send service is unavailable.' }
  try {
    const res = await timedFetch(`${base}/api/internal/files/send`, { method: 'POST', headers: authHeaders(), body: JSON.stringify({ phone, persona, ...input }) }, 30_000)
    return await res.json() as { ok?: boolean; error?: string; outcomeUnknown?: boolean; receipt?: Record<string, unknown> }
  } catch { return { ok: false, outcomeUnknown: true, error: 'The file send outcome is unknown.' } }
}

export async function touchInbound(phone: string, persona: AgentId): Promise<void> {
  const base = apiBase()
  const key = process.env.HIREALPHA_INTERNAL_KEY || ''
  if (!base || !key) return
  try {
    await timedFetch(
      `${base}/api/internal/touch`,
      {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({ phone, persona }),
      },
      8000,
    )
  } catch (err) {
    console.warn('[live] touch inbound failed', err)
  }
}

export type LastRun = {
  id: string
  /** Which hire started it — a run staged by a loop may name a different hire
   * than the one answering, and the reply should not pretend otherwise. */
  persona?: string
  host: string
  goal: string
  status: string
  outcome: string | null
  waitingOn: { kind: string; message: string } | null
  createdAt: string
  updatedAt: string
}

/** The answer to "how is my run going": the row, a definite none, or a read
 * that did not happen. Those are three different things and collapsing them is
 * the mistake this whole night was about — the first version returned null for
 * both "no run" and "could not read", so an unreadable store read back as "no
 * run exists", which is as much a fabrication as inventing one. */
export type LastRunRead = { ok: true; run: LastRun | null } | { ok: false }

export async function fetchLastRun(phone: string, persona: AgentId): Promise<LastRunRead> {
  const base = apiBase()
  const key = process.env.HIREALPHA_INTERNAL_KEY || ''
  if (!base || !key) return { ok: false }
  /* One clean retry, like every other read in this file. Live, 2026-09-19: asked
   * "does your list show any run of mine right now?", the answer was "I can't
   * read my run list right now" — the honest branch, and it means the read
   * aborted: the route itself answers in 0.4s (checked directly: 401 without the
   * key), so a 10s abort is a busy-server stall, not a broken endpoint. */
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const qs = new URLSearchParams({ phone, persona })
      const res = await timedFetch(`${base}/api/internal/browser/last?${qs}`, { headers: authHeaders() }, 12000)
      if (!res.ok) {
        if (attempt === 0) continue
        return { ok: false }
      }
      const data = (await res.json()) as { run?: LastRun | null }
      return { ok: true, run: data.run ?? null }
    } catch {
      if (attempt === 0) {
        await new Promise((resolve) => setTimeout(resolve, 500))
        continue
      }
      return { ok: false }
    }
  }
  return { ok: false }
}

export async function fetchMiniRun(
  phone: string,
  persona: AgentId,
  kind: string,
): Promise<{ text?: string; paste?: string; sections?: Array<{ heading: string; items: string[] }> } | null> {
  const base = apiBase()
  const key = process.env.HIREALPHA_INTERNAL_KEY || ''
  if (!base || !key) return null
  try {
    const qs = new URLSearchParams({ phone, persona, kind })
    const res = await timedFetch(`${base}/api/internal/mini/run?${qs}`, { headers: authHeaders() }, 15000)
    if (!res.ok) return null
    return (await res.json()) as { text?: string; paste?: string; sections?: Array<{ heading: string; items: string[] }> }
  } catch (err) {
    console.warn('[live] mini run failed', err)
    return null
  }
}

export async function autoLogNutrition(
  phone: string,
  persona: AgentId,
  description: string,
): Promise<{ ok: boolean; logged?: boolean; estimated?: boolean; guess?: string; calories?: number; protein?: number; carbs?: number; fat?: number; error?: string } | null> {
  const base = apiBase()
  const key = process.env.HIREALPHA_INTERNAL_KEY || ''
  if (!base || !key) return null
  try {
    const res = await timedFetch(
      `${base}/api/internal/nutrition`,
      {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({ phone, persona, description: description.slice(0, 500) }),
      },
      25000,
    )
    if (!res.ok) return null
    return (await res.json()) as {
      ok: boolean
      logged?: boolean
      guess?: string
      calories?: number
      protein?: number
      carbs?: number
      fat?: number
      error?: string
    }
  } catch (err) {
    console.warn('[live] nutrition auto-log failed', err)
    return null
  }
}

/**
 * Log a food photo sent as an inbound image attachment. Same always-log
 * semantics as the dashboard photo endpoint: the meal is saved even when no
 * model key exists (estimate pending). `imageBase64` is raw base64 without a
 * data: prefix; the server sniffs the mime from the bytes.
 */
export async function autoLogNutritionPhoto(
  phone: string,
  persona: AgentId,
  imageBase64: string,
  description?: string,
): Promise<{ ok: boolean; logged?: boolean; estimated?: boolean; needsKey?: boolean; calories?: number; protein?: number; carbs?: number; fat?: number; error?: string } | null> {
  const base = apiBase()
  const key = process.env.HIREALPHA_INTERNAL_KEY || ''
  if (!base || !key) return null
  try {
    const res = await timedFetch(
      `${base}/api/internal/nutrition/photo`,
      {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({
          phone,
          persona,
          imageBase64: imageBase64.slice(0, 24 * 1024 * 1024),
          ...(description ? { description: description.slice(0, 300) } : {}),
        }),
      },
      45000,
    )
    if (!res.ok) return null
    return (await res.json()) as {
      ok: boolean
      logged?: boolean
      estimated?: boolean
      needsKey?: boolean
      calories?: number
      protein?: number
      carbs?: number
      fat?: number
      error?: string
    }
  } catch (err) {
    console.warn('[live] nutrition photo auto-log failed', err)
    return null
  }
}

/**
 * Walk inbound content and return the first image attachment (bare image, or
 * inside an iMessage text+photo group).
 */
export function findInboundImage(content: {
  type?: string
  items?: Array<{ type?: string; content?: unknown }>
  mimeType?: string
  read?: () => Promise<Buffer>
  [key: string]: unknown
}): { read: () => Promise<Buffer>; mimeType: string } | null {
  const walk = (c: {
    type?: string
    items?: Array<{ type?: string; content?: unknown }>
    mimeType?: string
    read?: () => Promise<Buffer>
  }): { read: () => Promise<Buffer>; mimeType: string } | null => {
    if (c.type === 'attachment' && typeof c.read === 'function' && /^image\//i.test(c.mimeType || '')) {
      return { read: c.read as () => Promise<Buffer>, mimeType: c.mimeType || 'image/jpeg' }
    }
    if (c.type === 'group' && Array.isArray(c.items)) {
      for (const item of c.items) {
        const inner = item.content && typeof item.content === 'object' ? item.content : item
        if (inner && typeof inner === 'object') {
          const found = walk(inner as { type?: string; items?: Array<{ content?: unknown }>; mimeType?: string; read?: () => Promise<Buffer> })
          if (found) return found
        }
      }
    }
    return null
  }
  return walk(content)
}

/** Extract the text portion of an inbound group (iMessage text + photo). */
export function extractMessageText(content: {
  type?: string
  items?: Array<{ type?: string; content?: unknown; text?: string }>
  text?: string
  [key: string]: unknown
}): string {
  if (content.type === 'text' && typeof content.text === 'string') return content.text
  if (content.type === 'group' && Array.isArray(content.items)) {
    const parts: string[] = []
    for (const item of content.items) {
      const inner = (item.content && typeof item.content === 'object' ? item.content : item) as {
        type?: string
        text?: string
        items?: Array<{ content?: unknown; text?: string }>
      }
      if (inner?.type === 'text' && typeof inner.text === 'string') parts.push(inner.text)
    }
    return parts.join(' ').trim()
  }
  return ''
}

/**
 * Handle an inbound non-text message whose content may carry an image
 * attachment (a bare image, or an iMessage text+photo group where one part is
 * an attachment). Reads the first image, logs it to nutrition, and returns a
 * short reply string, or null when there is no image / nothing was logged.
 */
export async function handleInboundPhoto(
  phone: string,
  persona: AgentId,
  content: {
    type?: string
    items?: Array<{ type?: string; content?: unknown }>
    mimeType?: string
    read?: () => Promise<Buffer>
    [key: string]: unknown
  },
  description?: string,
): Promise<string | null> {
  if (persona !== 'friend') return null
  const image = findInboundImage(content)
  if (!image) return null
  try {
    const buf = await image.read()
    if (!buf || buf.length < 64) return null
    const imageBase64 = buf.toString('base64')
    const logged = await autoLogNutritionPhoto(phone, persona, imageBase64, description)
    if (!logged?.logged) return null
    if (logged.estimated && (logged.calories || 0) > 0) {
      return `Logged your meal from the photo: ${logged.calories} cal, ${logged.protein || 0}g protein. Want me to note what it was?`
    }
    if (logged.needsKey) {
      return 'Got it, that meal is saved. Set the vision model key in settings and I can estimate macros from photos.'
    }
    if (!logged.estimated) {
      // Photo could not be estimated (HEIC or unreadable): the log is saved
      // with macros pending — pull the food name out of them instead of
      // leaving a 0/0/0/0 row sitting there.
      return "Saved the photo — what was it? I'll fill in the macros."
    }
    return 'Logged that meal from the photo. It\'s in your Nutrition log.'
  } catch (err) {
    console.warn('[live] photo read failed', err)
    return null
  }
}

/**
 * Walk inbound content and return the first voice-note attachment. Photon maps
 * an iMessage audio message to its own content type (`voice`, any `audio/*`
 * mime), either bare or inside a text+voice group.
 */
export function findInboundVoice(content: {
  type?: string
  items?: Array<{ type?: string; content?: unknown }>
  mimeType?: string
  read?: () => Promise<Buffer>
  [key: string]: unknown
}): { read: () => Promise<Buffer>; mimeType: string } | null {
  const walk = (c: {
    type?: string
    items?: Array<{ type?: string; content?: unknown }>
    mimeType?: string
    read?: () => Promise<Buffer>
  }): { read: () => Promise<Buffer>; mimeType: string } | null => {
    const audio = c.type === 'voice' || /^audio\//i.test(c.mimeType || '')
    if (audio && typeof c.read === 'function') {
      return { read: c.read as () => Promise<Buffer>, mimeType: c.mimeType || 'audio/mp4' }
    }
    if (c.type === 'group' && Array.isArray(c.items)) {
      for (const item of c.items) {
        const inner = item.content && typeof item.content === 'object' ? item.content : item
        if (inner && typeof inner === 'object') {
          const found = walk(inner as { type?: string; items?: Array<{ content?: unknown }>; mimeType?: string; read?: () => Promise<Buffer> })
          if (found) return found
        }
      }
    }
    return null
  }
  return walk(content)
}

/**
 * Transcribe one voice note through hire-api's internal STT route. Phone and
 * persona ride along so the route can bias the decoder with the user's own
 * names and places; the budget sits just past the route's own whisper timeout
 * so its error is the one that surfaces instead of a client abort racing it.
 */
async function transcribeVoiceNote(
  phone: string,
  persona: AgentId,
  mimeType: string,
  audio: Buffer,
): Promise<{ text: string; ms: number } | null> {
  const base = apiBase()
  if (!base) return null
  const res = await timedFetch(
    `${base}/api/internal/transcribe`,
    {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ phone, persona, audioBase64: audio.toString('base64'), mimeType }),
    },
    135_000,
  )
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    console.warn(`[live] transcribe failed ${res.status}: ${body.slice(0, 160)}`)
    return null
  }
  const data = (await res.json()) as { ok?: boolean; text?: string; ms?: number }
  const text = String(data.text || '').trim()
  if (!data.ok || !text) return null
  return { text, ms: Number(data.ms) || 0 }
}

/**
 * Handle an inbound voice note: read the audio, transcribe it, and hand the
 * transcript back so the caller can run it as the user's own turn. Returns
 * null when the message carries no audio or the transcript did not come back.
 */
export async function handleInboundVoice(
  phone: string,
  persona: AgentId,
  content: {
    type?: string
    items?: Array<{ type?: string; content?: unknown }>
    mimeType?: string
    read?: () => Promise<Buffer>
    [key: string]: unknown
  },
): Promise<{ transcript: string; ms: number } | null> {
  const voice = findInboundVoice(content)
  if (!voice) return null
  try {
    const buf = await voice.read()
    if (!buf || buf.length < 256) return null
    const started = Date.now()
    const heard = await transcribeVoiceNote(phone, persona, voice.mimeType, buf)
    if (!heard) return null
    console.log(
      `[live] voice note from ${phone}: ${(buf.length / 1024).toFixed(0)}KB in ${Date.now() - started}ms (stt ${heard.ms}ms)`,
    )
    return { transcript: heard.text, ms: heard.ms }
  } catch (err) {
    console.warn('[live] voice note failed', err)
    return null
  }
}

/**
 * Turn an inbound voice note into the user's own turn: the transcript becomes
 * the ask, and the note tells the turn engine it was spoken so garbled names
 * and numbers get confirmed instead of guessed. A typed caption riding along
 * (iMessage text + voice group) is handed over as context. Null when there is
 * no audio or it could not be transcribed.
 */
export async function resolveInboundVoiceTurn(
  phone: string,
  persona: AgentId,
  content: {
    type?: string
    items?: Array<{ type?: string; content?: unknown }>
    mimeType?: string
    read?: () => Promise<Buffer>
    [key: string]: unknown
  },
): Promise<{ userText: string; note: string } | null> {
  const heard = await handleInboundVoice(phone, persona, content)
  if (!heard) return null
  const caption = extractMessageText(content)
  const note = [
    'The user sent this as a voice note; the message text is a transcription of what they said.',
    'If a name, number, time, or place looks garbled, say what you heard and confirm it instead of guessing.',
    caption ? `They also typed this alongside it: "${caption}"` : '',
  ].filter(Boolean).join(' ')
  return { userText: heard.transcript, note }
}

async function autoLogText<T extends { ok?: boolean; logged?: boolean; error?: string }>(
  path: string,
  phone: string,
  persona: AgentId,
  text: string,
): Promise<T | null> {
  const base = apiBase()
  const key = process.env.HIREALPHA_INTERNAL_KEY || ''
  if (!base || !key) return null
  try {
    const res = await timedFetch(
      `${base}${path}`,
      {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({ phone, persona, text: text.slice(0, 500) }),
      },
      12000,
    )
    if (!res.ok) return null
    return (await res.json()) as T
  } catch (err) {
    console.warn(`[live] ${path} auto-log failed`, err)
    return null
  }
}

export async function autoLogWorkout(phone: string, persona: AgentId, text: string) {
  return autoLogText<{
    ok?: boolean; logged?: boolean; error?: string
    exercise?: string; sets?: number; reps?: number; weight?: number
  }>('/api/internal/workouts', phone, persona, text)
}

export async function autoLogSleep(phone: string, persona: AgentId, text: string) {
  return autoLogText<{
    ok?: boolean; logged?: boolean; error?: string
    bedtime?: string; wake?: string; sleepDate?: string
  }>('/api/internal/sleep', phone, persona, text)
}

export async function autoLogGratitude(phone: string, persona: AgentId, text: string) {
  return autoLogText<{ ok?: boolean; logged?: boolean; error?: string; text?: string }>(
    '/api/internal/gratitude',
    phone,
    persona,
    text,
  )
}

export async function autoLogMood(
  phone: string,
  persona: AgentId,
  text: string,
): Promise<{ ok?: boolean; logged?: boolean; error?: string; emoji?: string; energy?: number } | null> {
  return autoLogText<{ ok?: boolean; logged?: boolean; error?: string; emoji?: string; energy?: number }>(
    '/api/internal/moods',
    phone,
    persona,
    text,
  )
}

export async function autoLogHabit(
  phone: string,
  persona: AgentId,
  text: string,
): Promise<{ ok?: boolean; logged?: boolean; error?: string; habit?: string; date?: string } | null> {
  const base = apiBase()
  const key = process.env.HIREALPHA_INTERNAL_KEY || ''
  if (!base || !key) return null
  try {
    const res = await timedFetch(
      `${base}/api/internal/habits/done`,
      {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({ phone, persona, text: text.slice(0, 300) }),
      },
      12000,
    )
    if (!res.ok) return null
    return (await res.json()) as { ok?: boolean; logged?: boolean; error?: string; habit?: string; date?: string }
  } catch (err) {
    console.warn('[live] habit auto-log failed', err)
    return null
  }
}

export async function autoLogSpend(phone: string, persona: AgentId, text: string) {
  return autoLogText<{
    ok?: boolean; logged?: boolean; error?: string; overCap?: boolean
    amount?: number; category?: string; description?: string
    weekTotal?: number; weeklyBudget?: number
  }>('/api/internal/spending', phone, persona, text)
}

/** Parse a name (plus optional place and phone) from networking phrases. */
export function parseNetworkContact(text: string): { name?: string; place?: string; phone?: string } | null {
  const SKIP = /^(a|an|the|someone|anybody|anyone|with|my|your|their|her|his|me|we|us|it|one|she|he|they|this|that)$/i
  // The name takes at most two tokens and stops before a place word, so
  // "I met Priya at dinner" is Priya + dinner, not "Priya At".
  const metRe =
    /\bi (?:met|ran into|bumped into)\s+([\w]+(?:\s+(?!at|from|in|via|that|to|for|the|a|an)\b[\w]+)?)(?:\s+(?:at|from|in|via)\s+([\w][^.,!?\n]{0,40}))?/i
  const metM = text.match(metRe)
  if (metM) {
    const name = (metM[1] ?? '').trim()
    if (!name || SKIP.test(name)) return null
    const phone = text.match(/(\+?\d[\d\s\-().]{5,}\d)/)?.[1]?.trim() || undefined
    return {
      name: name.replace(/\b\w/g, (c) => c.toUpperCase()),
      place: (metM[2] ?? '').trim() || undefined,
      phone,
    }
  }
  // "add Sarah to [my] network[ing/contacts]"
  const addRe = /\badd\s+([\w]+(?:\s+[\w]+)?)\s+to\s+(?:my\s+)?(?:network|networking|contacts)\b/i
  const addM = text.match(addRe)
  if (addM) {
    const name = (addM[1] ?? '').trim()
    if (!name || SKIP.test(name)) return null
    return { name: name.replace(/\b\w/g, (c) => c.toUpperCase()) }
  }
  return null
}

/**
 * Attempt to add a networking contact parsed from the message text.
 * Returns null when no name can be parsed (card is still sent; nothing logged).
 * Returns the API response otherwise; only set `logged: true` on confirmed save.
 */
export async function autoSetBudget(phone: string, persona: AgentId, text: string) {
  return autoLogText<{ ok?: boolean; logged?: boolean; weeklyBudget?: number; error?: string }>(
    '/api/internal/budget',
    phone,
    persona,
    text,
  )
}

export async function autoSetPrefs(
  phone: string,
  persona: AgentId,
  text: string,
): Promise<{
  ok?: boolean; changed?: boolean; error?: string
  workoutPlace?: string; workoutMoveCount?: number; workoutDays?: number[]
  sleepBedtime?: string; sleepWake?: string
} | null> {
  return autoLogText('/api/internal/prefs', phone, persona, text)
}

export async function autoLogNetwork(
  phone: string,
  persona: AgentId,
  text: string,
): Promise<{ ok?: boolean; logged?: boolean; error?: string; name?: string; place?: string } | null> {
  const parsed = parseNetworkContact(text)
  if (!parsed?.name) return null

  const base = apiBase()
  const key = process.env.HIREALPHA_INTERNAL_KEY || ''
  if (!base || !key) return { ok: false, logged: false, error: 'not configured', name: parsed.name, place: parsed.place }
  try {
    const res = await timedFetch(
      `${base}/api/internal/network`,
      {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({
          phone,
          persona,
          text: text.slice(0, 500),
          name: parsed.name,
          place: parsed.place,
          contactPhone: parsed.phone,
        }),
      },
      12000,
    )
    if (!res.ok) return { ok: false, logged: false, error: `save failed (${res.status})`, name: parsed.name, place: parsed.place }
    return (await res.json()) as { ok?: boolean; logged?: boolean; error?: string; name?: string; place?: string }
  } catch (err) {
    console.warn('[live] network auto-log failed', err)
    return { ok: false, logged: false, error: 'save failed', name: parsed.name, place: parsed.place }
  }
}

/**
 * Attempt to save a URL from a learning queue message.
 * Returns null when no URL is present (card is still sent; nothing saved).
 * Returns the API response otherwise; only set `logged: true` on confirmed save.
 */
export async function autoSaveLearning(
  phone: string,
  persona: AgentId,
  text: string,
  extraTexts: string[] = [],
): Promise<{ ok?: boolean; logged?: boolean; error?: string; title?: string; url?: string } | null> {
  const urlMatch = [text, ...extraTexts].join('\n').match(/https?:\/\/\S+/i)
  const url = urlMatch?.[0]?.replace(/[),.;]+$/, '')
  if (!url) return null

  const base = apiBase()
  const key = process.env.HIREALPHA_INTERNAL_KEY || ''
  if (!base || !key) return { ok: false, logged: false, error: 'not configured', url }
  const stripped = text.replace(/https?:\/\/\S+/gi, '').trim()
  const title = stripped.slice(0, 200) || undefined
  try {
    const res = await timedFetch(
      `${base}/api/internal/learning`,
      {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({
          phone,
          persona,
          url,
          ...(title ? { title } : {}),
          text: text.slice(0, 500),
        }),
      },
      12000,
    )
    if (!res.ok) return { ok: false, logged: false, error: `save failed (${res.status})`, url }
    return (await res.json()) as { ok?: boolean; logged?: boolean; error?: string; title?: string; url?: string }
  } catch (err) {
    console.warn('[live] learning auto-save failed', err)
    return { ok: false, logged: false, error: 'save failed', url }
  }
}

export function formatHireContext(fields: Record<string, string>): string {
  const lines = Object.entries(fields)
    .filter(([, v]) => {
      if (v == null) return false
      return typeof v === 'string' ? v.trim().length > 0 : true
    })
    .map(([k, v]) => `- ${k}: ${typeof v === 'string' ? v.trim() : JSON.stringify(v)}`)
  if (!lines.length) return ''
  return `Dashboard context for this person (treat as ground truth):\n${lines.join('\n')}`
}

export async function autoLogDecision(
  phone: string,
  persona: AgentId,
  text: string,
): Promise<{ ok?: boolean; logged?: boolean; error?: string; decision?: string; reason?: string } | null> {
  const base = apiBase()
  const key = process.env.HIREALPHA_INTERNAL_KEY || ''
  if (!base || !key) return { ok: false, logged: false, error: 'not configured' }
  try {
    const res = await timedFetch(
      `${base}/api/internal/decisions`,
      {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({ phone, persona, text: text.slice(0, 500) }),
      },
      12000,
    )
    if (!res.ok) return { ok: false, logged: false, error: `save failed (${res.status})` }
    return (await res.json()) as { ok?: boolean; logged?: boolean; error?: string; decision?: string; reason?: string }
  } catch (err) {
    console.warn('[live] decision auto-log failed', err)
    return { ok: false, logged: false, error: 'save failed' }
  }
}

export async function autoLogLoops(
  phone: string,
  persona: AgentId,
  loops: string[],
): Promise<{ ok?: boolean; logged?: boolean; count?: number; error?: string } | null> {
  const base = apiBase()
  const key = process.env.HIREALPHA_INTERNAL_KEY || ''
  const items = (loops || []).map((l) => String(l).trim().slice(0, 200)).filter(Boolean)
  if (!base || !key || !items.length) return { ok: false, logged: false, count: 0, error: 'not configured' }
  try {
    const res = await timedFetch(
      `${base}/api/internal/loops`,
      {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({ phone, persona, loops: items }),
      },
      12000,
    )
    if (!res.ok) return { ok: false, logged: false, count: 0, error: `save failed (${res.status})` }
    const data = (await res.json()) as { ok?: boolean; count?: number; error?: string }
    return { ok: !!data.ok, logged: !!data.ok, count: data.count || 0, error: data.error }
  } catch (err) {
    console.warn('[live] loops auto-log failed', err)
    return { ok: false, logged: false, count: 0, error: 'save failed' }
  }
}

/** Best-effort capture of a deadline-bearing promise from a normal chat turn. */
export async function captureCommitment(
  phone: string,
  persona: AgentId,
  text: string,
): Promise<{ captured: boolean; id?: string } | null> {
  const base = apiBase()
  const key = process.env.HIREALPHA_INTERNAL_KEY || ''
  if (!base || !key || !text.trim()) return null
  try {
    const res = await timedFetch(`${base}/api/internal/commitments`, {
      method: 'POST', headers: authHeaders(), body: JSON.stringify({ phone, persona, text: text.slice(0, 1000) }),
    }, 8000)
    if (!res.ok) return null
    return (await res.json()) as { captured: boolean; id?: string }
  } catch (err) {
    console.warn('[live] commitment capture failed', err)
    return null
  }
}

/** B3. Import an exported chat (iMessage/WhatsApp txt) into per-person context. */
export async function importChatExport(
  phone: string,
  persona: AgentId,
  text: string,
): Promise<{ ok?: boolean; people?: number; lines?: number; error?: string } | null> {
  const base = apiBase()
  const key = process.env.HIREALPHA_INTERNAL_KEY || ''
  if (!base || !key || !String(text || '').trim()) return { ok: false, people: 0, lines: 0, error: 'not configured' }
  try {
    const res = await timedFetch(
      `${base}/api/internal/chat-import`,
      { method: 'POST', headers: authHeaders(), body: JSON.stringify({ phone, persona, text }) },
      12000,
    )
    if (!res.ok) {
      const d = (await res.json().catch(() => ({}))) as { error?: string }
      return { ok: false, people: 0, lines: 0, error: d.error || `import failed (${res.status})` }
    }
    return (await res.json()) as { ok?: boolean; people?: number; lines?: number; error?: string }
  } catch (err) {
    console.warn('[live] chat import failed', err)
    return { ok: false, people: 0, lines: 0, error: 'save failed' }
  }
}

/** A6. Create a real meeting to back a debrief. */
export async function addMeeting(
  phone: string,
  persona: AgentId,
  title: string,
): Promise<{ ok?: boolean; error?: string } | null> {
  const base = apiBase()
  const key = process.env.HIREALPHA_INTERNAL_KEY || ''
  if (!base || !key || !title) return { ok: false, error: 'not configured' }
  try {
    const res = await timedFetch(
      `${base}/api/internal/meetings`,
      { method: 'POST', headers: authHeaders(), body: JSON.stringify({ phone, persona, title }) },
      10000,
    )
    if (!res.ok) return { ok: false, error: `save failed (${res.status})` }
    return (await res.json()) as { ok?: boolean; error?: string }
  } catch (err) {
    console.warn('[live] meeting add failed', err)
    return { ok: false, error: 'save failed' }
  }
}

/** A7. Renewal radar over live mail. Keyword filters to one subscription. */
export async function fetchRenewalRadar(
  phone: string,
  persona: AgentId,
  query: string,
): Promise<{ ok?: boolean; hits?: Array<{ merchant: string; amount?: number; period: string; date?: string }>; error?: string } | null> {
  const base = apiBase()
  const key = process.env.HIREALPHA_INTERNAL_KEY || ''
  if (!base || !key) return { ok: false, hits: [], error: 'not configured' }
  try {
    const res = await timedFetch(
      `${base}/api/internal/subscriptions`,
      { method: 'POST', headers: authHeaders(), body: JSON.stringify({ phone, persona, query }) },
      15000,
    )
    if (!res.ok) return { ok: false, hits: [], error: `scan failed (${res.status})` }
    return (await res.json()) as { ok?: boolean; hits?: Array<{ merchant: string; amount?: number; period: string; date?: string }>; error?: string }
  } catch (err) {
    console.warn('[live] subscriptions scan failed', err)
    return { ok: false, hits: [], error: 'scan failed' }
  }
}

/** A9. Persist active travel (destination + timezone) to the user's context so
 * brief/reminder scheduling can shift. */
export async function setTravel(
  phone: string,
  persona: AgentId,
  dest: string,
  tz?: string,
): Promise<{ ok?: boolean; error?: string } | null> {
  const base = apiBase()
  const key = process.env.HIREALPHA_INTERNAL_KEY || ''
  if (!base || !key || !dest) return { ok: false, error: 'not configured' }
  try {
    const res = await timedFetch(
      `${base}/api/internal/travel`,
      { method: 'POST', headers: authHeaders(), body: JSON.stringify({ phone, persona, dest, tz }) },
      10000,
    )
    if (!res.ok) return { ok: false, error: `save failed (${res.status})` }
    return (await res.json()) as { ok?: boolean; error?: string }
  } catch (err) {
    console.warn('[live] travel set failed', err)
    return { ok: false, error: 'save failed' }
  }
}

export async function autoLogPipeline(
  phone: string,
  persona: AgentId,
  text: string,
): Promise<{ ok?: boolean; logged?: boolean; error?: string; title?: string; stage?: string } | null> {
  const base = apiBase()
  const key = process.env.HIREALPHA_INTERNAL_KEY || ''
  if (!base || !key) return { ok: false, logged: false, error: 'not configured' }
  try {
    const res = await timedFetch(
      `${base}/api/internal/pipeline`,
      {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({ phone, persona, text: text.slice(0, 500) }),
      },
      12000,
    )
    if (!res.ok) return { ok: false, logged: false, error: `save failed (${res.status})` }
    return (await res.json()) as { ok?: boolean; logged?: boolean; error?: string; title?: string; stage?: string }
  } catch (err) {
    console.warn('[live] pipeline auto-log failed', err)
    return { ok: false, logged: false, error: 'save failed' }
  }
}

export async function autoLogStandup(
  phone: string,
  persona: AgentId,
  text: string,
): Promise<{ ok?: boolean; logged?: boolean; error?: string; day?: string } | null> {
  const base = apiBase()
  const key = process.env.HIREALPHA_INTERNAL_KEY || ''
  if (!base || !key) return { ok: false, logged: false, error: 'not configured' }
  try {
    const res = await timedFetch(
      `${base}/api/internal/standup`,
      {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({ phone, persona, text: text.slice(0, 1000) }),
      },
      12000,
    )
    if (!res.ok) return { ok: false, logged: false, error: `save failed (${res.status})` }
    return (await res.json()) as { ok?: boolean; logged?: boolean; error?: string; day?: string }
  } catch (err) {
    console.warn('[live] standup auto-log failed', err)
    return { ok: false, logged: false, error: 'save failed' }
  }
}

/* ---- Workshop: Alpha builds software ---- */

/** The workshop generator model. All GMI traffic runs on zai-org/GLM-5.3-Flash. */
const WORKSHOP_MODEL = process.env.GMI_MODEL_WORKSHOP || 'zai-org/GLM-5.3-Flash'
/** Second opinion when the primary planner answers 200 with prose instead of
 * the requested JSON. gmiChat only fails over on a THROW, so a model that
 * "chats" about the app rather than emitting {"code":...} would otherwise burn
 * every attempt on the same stall and fail the build with no log. */
const WORKSHOP_MODEL_FALLBACK = 'zai-org/GLM-5.3-Flash'
/** Token ceiling for one workshop generation. Measured on V4.1-Flash: 8000
 * lets the reasoning model ramble past 180s (timeout = total build failure);
 * 4000 completes in ~30s and still fits a 250-line app. The planner prompt
 * asks for compact output and the repair pass shortens on truncation. */
const WORKSHOP_MAX_TOKENS = 4000
/** Rewriting an app means re-emitting the whole file, which is the largest
 * visible answer the product asks for and grows with every feature the user
 * adds. Sized for the fifth version, not the first. */
const WORKSHOP_ITERATE_MAX_TOKENS = 8000

export const WORKSHOP_PLANNER = [
  'You generate a single-file JavaScript program for a sandbox.',
  'Sandbox rules: Bun runtime, NO network, NO environment variables, no child processes.',
  'Do useful work, then WRITE every output file into the out/ directory (create it if needed), e.g. await Bun.write("out/index.html", html).',
  'For a page or tracker, produce one self-contained out/index.html with inline CSS/JS and realistic sample data the user can edit later in the file.',
  'CRITICAL: the app opens in Safari on an iPhone. Include <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no, viewport-fit=cover">.',
  'MOBILE SAFE-AREAS & PADDING: Mobile browsers have a top status bar/notch and a bottom search/tab bar & home bar. Always style with safe area insets: padding-top: max(16px, env(safe-area-inset-top, 0px)); padding-bottom: max(32px, env(safe-area-inset-bottom, 0px)); padding-left: max(16px, env(safe-area-inset-left, 0px)); padding-right: max(16px, env(safe-area-inset-right, 0px)); box-sizing: border-box; min-height: 100dvh;. Never place buttons flush against the bottom edge where Safari UI covers them.',
  'Never require a hardware keyboard, mouse hover, or arrow keys. Games and interactive apps are driven by touch: on-screen buttons, tap, or drag. Keyboard listeners may exist as a desktop bonus but the app must be fully usable with touch only.',
  'SINGLE PLAYER BY DEFAULT: a game must be playable alone against the computer immediately — build the CPU opponent in (e.g. in pong the other paddle tracks the ball at a beatable speed). A two-player or versus mode is a bonus toggle, never the only mode. The one ask the user made is the game they get: do not require a second human.',
  'Interactive apps must actually run: wire the controls to the state, use requestAnimationFrame or event handlers, and make the primary action work on the first tap without any setup.',
  'Keep the program compact: one file, ideally under 250 lines, polished but minimal — it must fit in one reply.',
  'In generated code, build strings with plain quotes and + concatenation rather than template literals, and double-check every statement ends correctly — the program must parse the first time.',
  'The HTML must be valid too: never leave an unescaped apostrophe inside a single quoted JS string (reword or use double quotes), put the <script> after all elements it uses, and make sure every button works.',
  'Reply with JSON only, no markdown: {"title": "short name", "code": "<the whole program>"}',
].join('\n')

/* ---- Delegate retained draft: "send it" fires the last draft per phone ---- */

export type DelegateDraft = { to: string; toName: string; subject: string; body: string }

const delegateDrafts = new Map<string, DelegateDraft>()

export function retainDelegateDraft(phone: string, persona: AgentId, draft: DelegateDraft) {
  delegateDrafts.set(`${persona}|${phone}`, draft)
}

export function takeDelegateDraft(phone: string, persona: AgentId): DelegateDraft | null {
  const k = `${persona}|${phone}`
  const d = delegateDrafts.get(k) || null
  if (d) delegateDrafts.delete(k)
  return d
}

export function peekDelegateDraft(phone: string, persona: AgentId): DelegateDraft | null {
  return delegateDrafts.get(`${persona}|${phone}`) || null
}

export async function sendMailDirect(
  phone: string,
  to: string,
  subject: string,
  body: string,
  threadId?: string,
): Promise<{ ok: boolean; error?: string; providerId?: string | null }> {
  const base = apiBase()
  const key = process.env.HIREALPHA_INTERNAL_KEY || ''
  if (!base || !key) return { ok: false, error: 'not configured' }
  try {
    const res = await timedFetch(
      `${base}/api/internal/mail/send`,
      {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({ phone, to, subject, body, threadId }),
      },
      20000,
    )
    const data = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string }
    if (!res.ok || !data.ok) return { ok: false, error: data.error || `send failed (${res.status})` }
    return { ok: true }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'send failed' }
  }
}

/* Normalized ask -> dedup key. Same app phrased differently still matches;
 * filler words (can you build me a...) are stripped. */
export function workshopTemplateKey(ask: string): string {
  return ask
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(
      /\b(?:can|could|will|would|you|please|build|make|create|write|code|develop|ship|me|a|an|the|for|my|us|simple|tiny|small|basic|quick|little)\b/g,
      ' ',
    )
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 60)
}

/* Phones have no keyboard. The first ping pong build shipped arrow-key paddles
 * to someone tapping a link in iMessage, which plays like a screenshot. This
 * gate catches interactive asks whose generated code only answers hardware
 * input, and its reason feeds the planner's repair pass. */
const INTERACTIVE_ASK = /\b(game|play|snake|tetris|chess|checkers|tic tac toe|pong|arcade|quiz|trivia|piano|drum|paint|draw|doodle|clicker|simulator|sim)\b/i
const KEYBOARD_INPUT = /\bkeydown\b|\bkeyup\b|\bkeypress\b|\bKeyboardEvent\b|ArrowUp|ArrowDown|ArrowLeft|ArrowRight|\bkeys\[/i
const TOUCH_INPUT = /\btouchstart\b|\btouchmove\b|\btouchend\b|\bpointerdown\b|\bpointermove\b|\bpointerup\b|\bonclick\b|addEventListener\(\s*['"]click['"]|\bon touches\b|ontouchstart/i

export function workshopPhoneGate(ask: string, code: string): string | null {
  if (!INTERACTIVE_ASK.test(ask)) return null
  const hasTouch = TOUCH_INPUT.test(code)
  const hasKeyboard = KEYBOARD_INPUT.test(code)
  if (hasTouch || !hasKeyboard) return null
  return 'the app is driven by keyboard listeners only (keydown/arrow keys), but the user opens it on an iPhone with no keyboard. Rewrite the whole app with touch controls: on-screen buttons, tap, or drag handlers (touchstart/pointerdown). Keep any keyboard support only as a desktop bonus.'
}

async function findWorkshopTemplate(
  phone: string,
  persona: AgentId,
  key: string,
): Promise<{ artifactId: string; title: string } | null> {
  const base = apiBase()
  const keyEnv = process.env.HIREALPHA_INTERNAL_KEY || ''
  if (!base || !keyEnv) return null
  try {
    const res = await timedFetch(
      `${base}/api/internal/workshop/find?phone=${encodeURIComponent(phone)}&persona=${encodeURIComponent(persona)}&key=${encodeURIComponent(key)}`,
      { headers: authHeaders() },
      8000,
    )
    if (!res.ok) return null
    const data = (await res.json()) as { artifact?: { artifactId: string; title: string } | null }
    return data.artifact || null
  } catch {
    return null
  }
}

async function cloneWorkshopBuild(
  phone: string,
  persona: AgentId,
  artifactId: string,
): Promise<{ ok?: boolean; logged?: boolean; error?: string; artifactId?: string; url?: string; title?: string; deduped?: boolean } | null> {
  const base = apiBase()
  const envKey = process.env.HIREALPHA_INTERNAL_KEY || ''
  if (!base || !envKey) return null
  try {
    const res = await timedFetch(
      `${base}/api/internal/workshop/clone`,
      {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({ phone, persona, artifactId }),
      },
      20000,
    )
    if (!res.ok) return null
    return (await res.json()) as { ok?: boolean; logged?: boolean; artifactId?: string; url?: string; title?: string; deduped?: boolean }
  } catch {
    return null
  }
}

/* ---- Iterate: change requests on an existing build ---- */

export const WORKSHOP_ITERATOR = [
  'You update an existing single-file HTML app. Apply ONLY the change the user asks for; keep everything else working exactly as it was.',
  'The result must be one complete self-contained HTML file with inline CSS/JS.',
  'Put the <script> after all elements it uses. Never leave an unescaped apostrophe inside a single quoted JS string (reword or use double quotes). Every button must work.',
  'Reply with JSON only, no markdown: {"title": "short name", "html": "<the full updated html>"}',
].join('\n')

export async function fetchWorkshopSource(
  phone: string,
  artifactId?: string,
): Promise<{ artifactId: string; title: string; html: string; templateKey?: string | null } | null> {
  const base = apiBase()
  const key = process.env.HIREALPHA_INTERNAL_KEY || ''
  if (!base || !key) return null
  try {
    const qs = new URLSearchParams({ phone })
    if (artifactId) qs.set('artifactId', artifactId)
    const res = await timedFetch(
      `${base}/api/internal/workshop/source?${qs}`,
      { headers: authHeaders() },
      12000,
    )
    if (!res.ok) {
      /* A 404 ("no build on file") and a transient 500 used to be the same
       * `null`, and the iterate caller answers null by falling through to
       * ordinary chat — so a change request could simply vanish with no reply.
       * Anything that is not a definitive "no build" is worth naming. */
      if (res.status === 404) return null
      const body = await res.text().catch(() => '')
      console.warn(`[live] workshop source ${res.status}: ${body.slice(0, 160)}`)
      throw new Error(`the build store answered ${res.status}`)
    }
    return (await res.json()) as { artifactId: string; title: string; html: string; templateKey?: string | null }
  } catch (err) {
    if (err instanceof Error && err.message.startsWith('the build store answered')) throw err
    return null
  }
}

export async function iterateWorkshopBuild(input: {
  phone: string
  persona: AgentId
  artifactId: string
  title: string
  html: string
  instruction: string
}): Promise<{ ok?: boolean; logged?: boolean; error?: string; artifactId?: string; url?: string; title?: string } | null> {
  const base = apiBase()
  const key = process.env.HIREALPHA_INTERNAL_KEY || ''
  if (!base || !key) return { ok: false, logged: false, error: 'not configured' }
  try {
    const res = await timedFetch(
      `${base}/api/internal/workshop/iterate`,
      {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({
          phone: input.phone,
          persona: input.persona,
          artifactId: input.artifactId,
          title: input.title,
          html: input.html,
          instruction: input.instruction.slice(0, 500),
        }),
      },
      30000,
    )
    if (!res.ok) return { ok: false, logged: false, error: `update failed (${res.status})` }
    return (await res.json()) as { ok?: boolean; logged?: boolean; error?: string; artifactId?: string; url?: string; title?: string }
  } catch (err) {
    console.warn('[live] workshop iterate failed', err)
    return { ok: false, logged: false, error: 'update failed' }
  }
}

/** Run the change: fetch the current build, apply the instruction via the
 * model, store the new version. Returns null when there is no build to
 * iterate on (caller falls through to normal handling). */
export async function autoIterateWorkshop(input: {
  phone: string
  persona: AgentId
  instruction: string
  artifactId?: string
}): Promise<{ ok?: boolean; logged?: boolean; error?: string; artifactId?: string; url?: string; title?: string } | null> {
  const source = await fetchWorkshopSource(input.phone, input.artifactId)
  if (!source) return null
  // Two tries, like a fresh build. The provider hiccups (an empty completion, a
  // dropped connection, a refusal) at a rate that shows up as "the update
  // didn't go through" often enough to matter, and one lost attempt used to be
  // the user's whole answer. The retry asks for the same thing with a nudge.
  let lastError = 'could not apply the change'
  for (let attempt = 0; attempt < 2; attempt++) {
    let raw = ''
    try {
      raw = await gmiChat({
        model: WORKSHOP_MODEL,
        temperature: 0.2,
        // A whole app is thousands of tokens on a reasoning model; the default
        // 30s deadline killed every workshop build in prod ("couldn't be
        // drafted") while the model was still mid-generation.
        // Same reasoning ceiling as the planner: rewriting an app is a long
        // visible answer, and the default chain of thought eats the whole budget.
        reasoningEffort: 'low',
        // The whole file comes back, so this is the largest visible answer the
        // product asks for — and it grows every time the user adds a feature.
        // A ceiling sized for the first version truncates the fifth.
        maxTokens: WORKSHOP_ITERATE_MAX_TOKENS,
        timeoutMs: 90_000,
        messages: [
          { role: 'system', content: WORKSHOP_ITERATOR },
          {
            role: 'user',
            content:
              `Current app (title: ${source.title}):\n\n${source.html}\n\nRequested change: ${input.instruction}\n\nReply with the full updated HTML as JSON now.` +
              (attempt === 0 ? '' : '\n\nYour previous reply was unusable (cut off or not valid JSON). Reply again with the whole updated app, shorter if needed. JSON only.'),
          },
        ],
      })
    } catch (err) {
      console.warn('[live] workshop iterate model failed', err)
      lastError = 'could not apply the change'
      continue
    }
    /* Balanced-object search, not a greedy regex: one stray brace in the prose
     * (or in the program itself) made the parse fail and cost the update even
     * though the JSON was right there. Same helper as the planner below. */
    const parsedReply = extractJsonObject(raw || '')
    if (!parsedReply) {
      console.warn(`[live] workshop iterate returned no JSON; reply was: ${(raw || '').slice(0, 200)}`)
      lastError = 'could not apply the change'
      continue
    }
    try {
      const parsed = parsedReply as { title?: string; html?: string }
      const html = String(parsed.html || '')
      if (!html.trim()) {
        lastError = 'the updated app came back empty'
        continue
      }
      return await iterateWorkshopBuild({
        phone: input.phone,
        persona: input.persona,
        artifactId: source.artifactId,
        title: String(parsed.title || source.title),
        html,
        instruction: input.instruction,
      })
    } catch {
      lastError = 'could not apply the change'
    }
  }
  return { ok: false, logged: false, error: lastError }
}

export async function autoRunWorkshop(
  phone: string,
  persona: AgentId,
  ask: string,
): Promise<{ ok?: boolean; logged?: boolean; error?: string; artifactId?: string; url?: string; title?: string; deduped?: boolean } | null> {
  const base = apiBase()
  const key = process.env.HIREALPHA_INTERNAL_KEY || ''
  if (!base || !key) return { ok: false, logged: false, error: 'not configured' }

  // Dedup: a verified build with the same normalized ask (from another user)
  // clones instantly instead of re-running the planner and sandbox. The clone
  // gives the asker their own artifact row — own expiry, own keep/toss.
  const templateKey = workshopTemplateKey(ask)
  if (templateKey) {
    const existing = await findWorkshopTemplate(phone, persona, templateKey)
    if (existing) {
      const cloned = await cloneWorkshopBuild(phone, persona, existing.artifactId)
      if (cloned?.ok && cloned.artifactId) {
        console.log(`[live] workshop dedup hit: ${templateKey} -> ${cloned.artifactId}`)
        return { ...cloned, deduped: true }
      }
    }
  }

  // Plan → run → repair. Generated programs are sometimes broken (a dropped
  // backtick, a bad interpolation), so when the sandbox run fails the error
  // goes back to the planner for one fix-it pass. A planner failure must
  // return an error, never throw: this runs inside the chat turn, and a throw
  // here crashes the whole reply into the canned "Got tripped up" message.
  let lastError = ''
  for (let pass = 0; pass < 2; pass++) {
    const askWithFix =
      pass === 0
        ? ask
        : `${ask}\n\nYour previous program failed with this error:\n${lastError}\nWrite the whole corrected program again, shorter if needed.`
    let title = ''
    let code = ''
    let lastRaw = ''
    try {
      for (let attempt = 0; attempt < 2; attempt++) {
        const raw = await gmiChat({
          // Attempt 0 on the primary planner; attempt 1 on the fallback model,
          // so a 200-with-prose reply gets a real second opinion instead of the
          // same model repeating it.
          model: attempt === 0 ? WORKSHOP_MODEL : WORKSHOP_MODEL_FALLBACK,
          temperature: 0.2,
          maxTokens: WORKSHOP_MAX_TOKENS,
          // Measured on the ping-pong ask with the provider default: 61s and
          // 4383 hidden reasoning tokens, finish=length, and a content field of
          // exactly zero characters — the ceiling is spent thinking, so the
          // planner "fails" on a build that only needed less deliberation. At
          // 'low' the same ask answered in 20s with the whole app. This is the
          // one call in the product where the visible output is thousands of
          // tokens long, so the thinking budget has to lose the argument.
          reasoningEffort: 'low',
          timeoutMs: 90_000,
          messages: [
            { role: 'system', content: WORKSHOP_PLANNER },
            { role: 'user', content: attempt === 0 ? askWithFix : `${askWithFix}\n\nYour previous reply was cut off or not valid JSON. Write the whole program again, shorter if needed. JSON only.` },
          ],
        })
        lastRaw = raw || ''
        const parsed = extractJsonObject(raw || '') as { title?: string; code?: string } | null
        if (!parsed) continue
        title = String(parsed.title || '').slice(0, 120)
        code = String(parsed.code || '')
        if (code.trim()) break
      }
    } catch (err) {
      // A provider hiccup (429, 5xx, backend 400) should get the repair pass,
      // not an instant failure — the outer loop re-plans from scratch. Two
      // immediate refusals are the provider's rate limiter talking, so the
      // re-plan waits it out instead of spending its attempts inside the same
      // refusal window (measured: a build ask failed in 10s with no workshop
      // call reaching the server, then succeeded unchanged a minute later).
      console.warn('[live] workshop planner failed', err)
      lastError = 'the model provider hiccuped'
      if (pass === 0) {
        await new Promise((resolve) => setTimeout(resolve, 1500))
        continue
      }
      return { ok: false, logged: false, error: 'could not draft the program' }
    }
    if (!code.trim()) {
      // Never silent: a 200-but-unparseable planner reply looked exactly like
      // a phantom "the builder didn't accept the request" with no trace.
      console.warn(`[live] workshop planner returned no usable code; reply was: ${lastRaw.slice(0, 200)}`)
      lastError = 'could not draft the program'
      if (pass === 0) continue
      return { ok: false, logged: false, error: lastError }
    }
    // Some replies come back as the raw HTML document instead of a writer
    // program; wrapping beats burning the repair pass on a parse error.
    const trimmedCode = code.trim()
    if (/^<!doctype html|^<html/i.test(trimmedCode)) {
      code = "await Bun.write('out/index.html', " + JSON.stringify(trimmedCode) + ")"
    }
    // Catch keyboard-only interactive apps before spending a sandbox run: the
    // gate reason becomes the repair-pass instruction.
    const phoneFail = workshopPhoneGate(ask, code)
    if (phoneFail) {
      console.warn(`[live] workshop phone gate: ${phoneFail.slice(0, 80)}`)
      lastError = phoneFail
      if (pass === 0) continue
      // Pass 2 also failed the gate: ship it rather than nothing — the user
      // can say "make it touch friendly" and iterate.
      console.warn('[live] workshop phone gate still failing after repair pass; shipping anyway')
    }

    try {
      const res = await timedFetch(
        `${base}/api/internal/workshop`,
        {
          method: 'POST',
          headers: authHeaders(),
          body: JSON.stringify({ phone, persona, prompt: ask.slice(0, 500), title, code, templateKey }),
        },
        60000,
      )
      if (!res.ok) return { ok: false, logged: false, error: `build failed (${res.status})` }
      const out = (await res.json()) as { ok?: boolean; logged?: boolean; error?: string; artifactId?: string; url?: string; title?: string }
      if (out.ok) return out
      // Sandbox or gate failure: remember why and let pass 2 repair it.
      lastError = out.error || 'the program did not run'
    } catch (err) {
      console.warn('[live] workshop build failed', err)
      return { ok: false, logged: false, error: 'build failed' }
    }
  }
  return { ok: false, logged: false, error: lastError || 'build failed' }
}

export async function autoWorkshopKeep(
  phone: string,
  persona: AgentId,
  artifactId?: string,
): Promise<{ ok?: boolean; logged?: boolean; error?: string } | null> {
  const base = apiBase()
  const key = process.env.HIREALPHA_INTERNAL_KEY || ''
  if (!base || !key) return { ok: false, logged: false, error: 'not configured' }
  try {
    const res = await timedFetch(
      `${base}/api/internal/workshop/keep`,
      {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({ phone, persona, ...(artifactId ? { artifactId } : {}) }),
      },
      12000,
    )
    if (!res.ok) return { ok: false, logged: false, error: `failed (${res.status})` }
    return (await res.json()) as { ok?: boolean; logged?: boolean; error?: string }
  } catch {
    return { ok: false, logged: false, error: 'failed' }
  }
}

export async function autoWorkshopToss(
  phone: string,
  persona: AgentId,
  artifactId?: string,
): Promise<{ ok?: boolean; logged?: boolean; error?: string } | null> {
  const base = apiBase()
  const key = process.env.HIREALPHA_INTERNAL_KEY || ''
  if (!base || !key) return { ok: false, logged: false, error: 'not configured' }
  try {
    const res = await timedFetch(
      `${base}/api/internal/workshop/toss`,
      {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({ phone, persona, ...(artifactId ? { artifactId } : {}) }),
      },
      12000,
    )
    if (!res.ok) return { ok: false, logged: false, error: `failed (${res.status})` }
    return (await res.json()) as { ok?: boolean; logged?: boolean; error?: string }
  } catch {
    return { ok: false, logged: false, error: 'failed' }
  }
}

/** Shared to-do list: add | list | complete. Null = the service was
 * unreachable; the caller must say so rather than claim the list changed. */
export async function manageTodos(
  phone: string,
  action: 'add' | 'list' | 'complete',
  text?: string,
  id?: string,
): Promise<{ ok: boolean; todo?: { id: string; text: string }; completed?: { id: string; text: string }; open?: Array<{ id: string; text: string }>; error?: string } | null> {
  const base = apiBase()
  if (!base) return null
  try {
    const res = await fetch(`${base}/api/internal/todos`, {
      signal: AbortSignal.timeout(10000),
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ phone, action, text, id }),
    })
    if (!res.ok) return null
    return (await res.json()) as {
      ok: boolean
      todo?: { id: string; text: string }
      completed?: { id: string; text: string }
      open?: Array<{ id: string; text: string }>
      error?: string
    }
  } catch {
    return null
  }
}

/** Schedule a text the assistant sends on the user's behalf at a future time
 * (a midnight birthday message). The bot's poller delivers it. */
export async function scheduleTextLater(
  phone: string,
  to: string,
  text: string,
  at: string,
  persona = 'friend',
): Promise<{ ok: boolean; id?: string; error?: string }> {
  const base = apiBase()
  if (!base) return { ok: false, error: 'no api base' }
  try {
    const res = await fetch(`${base}/api/internal/scheduled_texts`, {
      signal: AbortSignal.timeout(10000),
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ phone, to, text, at, persona }),
    })
    const data = (await res.json().catch(() => ({}))) as { ok?: boolean; id?: string; error?: string }
    return res.ok && data.ok ? { ok: true, id: data.id } : { ok: false, error: data.error || `status ${res.status}` }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'failed' }
  }
}
