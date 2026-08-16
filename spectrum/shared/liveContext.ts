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
  want?: 'maps' | 'web',
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
): Promise<{ ok: boolean; logged?: boolean; guess?: string; calories?: number; protein?: number; carbs?: number; fat?: number; error?: string } | null> {
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
    ok?: boolean; logged?: boolean; error?: string
    amount?: number; category?: string; description?: string
  }>('/api/internal/spending', phone, persona, text)
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
