import { gmiChat } from './gmi'
import type { AgentId } from '../../src/agents/types'

export type LiveProfile = {
  found: boolean
  hired: boolean
  context: Record<string, string>
  connected: string[]
  memories: Array<{ key: string; value: string; durable?: boolean }>
  email: string | null
  name?: string | null
  timezone?: string | null
  lastInboundAt?: string | null
  location?: { kind: string; label: string; label_text: string } | null
}

const EMPTY: LiveProfile = {
  found: false,
  hired: false,
  context: {},
  connected: [],
  memories: [],
  email: null,
  name: null,
  timezone: null,
  lastInboundAt: null,
}

function apiBase() {
  return (process.env.HIREALPHA_API_URL || '').replace(/\/$/, '')
}

function authHeaders() {
  const key = process.env.HIREALPHA_INTERNAL_KEY || ''
  return {
    Authorization: `Bearer ${key}`,
    Accept: 'application/json',
    'Content-Type': 'application/json',
  }
}

async function timedFetch(url: string, init: RequestInit, ms: number) {
  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), ms)
  try {
    return await fetch(url, { ...init, signal: ctrl.signal })
  } finally {
    clearTimeout(t)
  }
}

export async function fetchLiveProfile(phone: string, persona: AgentId): Promise<LiveProfile> {
  const base = apiBase()
  const key = process.env.HIREALPHA_INTERNAL_KEY || ''
  if (!base || !key) return EMPTY
  const attempt = async (): Promise<LiveProfile> => {
    const url = `${base}/api/internal/live?phone=${encodeURIComponent(phone)}&persona=${encodeURIComponent(persona)}`
    const res = await timedFetch(url, { headers: authHeaders() }, 8000)
    if (!res.ok) return EMPTY
    const data = (await res.json()) as LiveProfile
    return {
      ...EMPTY,
      ...data,
      context: data.context || {},
      connected: data.connected || [],
      memories: data.memories || [],
    }
  }
  try {
    const first = await attempt()
    // A sender already known to be hired can briefly read as not-found after a
    // deploy. Retry once so one blip can't turn into a "sign in" reply.
    if (first.found) return first
    await new Promise((r) => setTimeout(r, 300))
    return await attempt()
  } catch (err) {
    console.warn('[live] profile lookup failed', err)
    return EMPTY
  }
}

export async function fetchLiveTools(
  phone: string,
  persona: AgentId,
  message: string,
  want?: 'maps' | 'web' | 'gmail' | 'calendar' | 'drive',
): Promise<string[]> {
  const base = apiBase()
  const key = process.env.HIREALPHA_INTERNAL_KEY || ''
  if (!base || !key) return []
  const attempt = async (): Promise<string[]> => {
    const res = await timedFetch(
      `${base}/api/internal/live/tools`,
      {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({ phone, persona, message, ...(want ? { want } : {}) }),
      },
      20000,
    )
    if (!res.ok) return []
    const data = (await res.json()) as { results?: string[] }
    return data.results || []
  }
  try {
    const first = await attempt()
    // A connected user can briefly read as empty results while the backing
    // tool (Gmail/Calendar) is mid-refresh. Retry once so a single empty
    // response can't turn into a "can't see your inbox" reply.
    if (first.length) return first
    await new Promise((r) => setTimeout(r, 300))
    return await attempt()
  } catch (err) {
    console.warn('[live] tools failed', err)
    return []
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
    return { ok: !!data.ok, id: data.id, kind: data.kind, error: data.error }
  } catch (err) {
    console.warn('[live] propose failed', err)
    return { ok: false, error: 'Could not save the draft.' }
  }
}

export async function persistLiveFacts(
  phone: string,
  persona: AgentId,
  facts: Array<{ key: string; value: string }>,
): Promise<void> {
  const base = apiBase()
  const key = process.env.HIREALPHA_INTERNAL_KEY || ''
  if (!base || !key || !facts.length) return
  try {
    await timedFetch(
      `${base}/api/internal/memory`,
      {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({ phone, persona, facts }),
      },
      8000,
    )
  } catch (err) {
    console.warn('[live] persist facts failed', err)
  }
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
      return 'Got it, that meal is saved. Add a GMI key in settings and I can estimate macros from photos.'
    }
    return 'Logged that meal from the photo. It\'s in your Nutrition log.'
  } catch (err) {
    console.warn('[live] photo read failed', err)
    return null
  }
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

export function formatHireMemories(
  memories: Array<{ key: string; value: string; durable?: boolean }>,
): string {
  if (!memories.length) return ''
  const lines = memories
    .slice(0, 12)
    .map((m) => `- ${m.key}: ${m.value}`)
  return `What this hire remembers (durable facts, never guess past these):\n${lines.join('\n')}`
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

const WORKSHOP_PLANNER = [
  'You generate a single-file JavaScript program for a sandbox.',
  'Sandbox rules: Bun runtime, NO network, NO environment variables, no child processes.',
  'Do useful work, then WRITE every output file into the out/ directory (create it if needed), e.g. await Bun.write("out/index.html", html).',
  'For a page or tracker, produce one self-contained out/index.html with inline CSS/JS and realistic sample data the user can edit later in the file.',
  'Reply with JSON only, no markdown: {"title": "short name", "code": "<the whole program>"}',
].join('\n')

export async function autoRunWorkshop(
  phone: string,
  persona: AgentId,
  ask: string,
): Promise<{ ok?: boolean; logged?: boolean; error?: string; artifactId?: string; url?: string; title?: string } | null> {
  const base = apiBase()
  const key = process.env.HIREALPHA_INTERNAL_KEY || ''
  if (!base || !key) return { ok: false, logged: false, error: 'not configured' }

  // Plan: turn the ask into sandbox code. One repair retry on invalid JSON.
  // A planner failure must return an error, never throw: this runs inside the
  // chat turn, and a throw here crashes the whole reply into the canned
  // "Got tripped up" message instead of an honest "the build failed".
  let title = ''
  let code = ''
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      const raw = await gmiChat({
        temperature: 0.2,
        maxTokens: 3000,
        messages: [
          { role: 'system', content: WORKSHOP_PLANNER },
          { role: 'user', content: attempt === 0 ? ask : `${ask}\n\nYour previous reply was not valid JSON. Reply again, JSON only.` },
        ],
      })
      const jsonMatch = (raw || '').match(/\{[\s\S]*\}/)
      if (!jsonMatch) continue
      try {
        const parsed = JSON.parse(jsonMatch[0]) as { title?: string; code?: string }
        title = String(parsed.title || '').slice(0, 120)
        code = String(parsed.code || '')
        if (code.trim()) break
      } catch {
        /* retry once */
      }
    }
  } catch (err) {
    console.warn('[live] workshop planner failed', err)
    return { ok: false, logged: false, error: 'could not draft the program' }
  }
  if (!code.trim()) return { ok: false, logged: false, error: 'could not draft the program' }

  try {
    const res = await timedFetch(
      `${base}/api/internal/workshop`,
      {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({ phone, persona, prompt: ask.slice(0, 500), title, code }),
      },
      45000,
    )
    if (!res.ok) return { ok: false, logged: false, error: `build failed (${res.status})` }
    return (await res.json()) as { ok?: boolean; logged?: boolean; error?: string; artifactId?: string; url?: string; title?: string }
  } catch (err) {
    console.warn('[live] workshop build failed', err)
    return { ok: false, logged: false, error: 'build failed' }
  }
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
