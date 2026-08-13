import type { AgentId } from '../../src/agents/types'

export type LiveProfile = {
  found: boolean
  hired: boolean
  context: Record<string, string>
  connected: string[]
  email: string | null
  name?: string | null
}

const EMPTY: LiveProfile = {
  found: false,
  hired: false,
  context: {},
  connected: [],
  email: null,
  name: null,
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
    return (await res.json()) as LiveProfile
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

export function formatHireContext(fields: Record<string, string>): string {
  const lines = Object.entries(fields)
    .filter(([, v]) => (v || '').trim())
    .map(([k, v]) => `- ${k}: ${v.trim()}`)
  if (!lines.length) return ''
  return `Dashboard context for this person (treat as ground truth):\n${lines.join('\n')}`
}
