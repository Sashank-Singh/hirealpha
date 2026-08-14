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
  try {
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
  } catch (err) {
    console.warn('[live] profile lookup failed', err)
    return EMPTY
  }
}

export async function fetchLiveTools(
  phone: string,
  persona: AgentId,
  message: string,
): Promise<string[]> {
  const base = apiBase()
  const key = process.env.HIREALPHA_INTERNAL_KEY || ''
  if (!base || !key) return []
  try {
    const res = await timedFetch(
      `${base}/api/internal/live/tools`,
      {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({ phone, persona, message }),
      },
      20000,
    )
    if (!res.ok) return []
    const data = (await res.json()) as { results?: string[] }
    return data.results || []
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
