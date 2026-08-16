import type { AgentId } from '../../src/agents/types'

export type EventNudge = {
  phone: string
  topic: string
  key: string
  text: string
  urgent: boolean
}

function apiBase() {
  return (process.env.HIREALPHA_API_URL || '').replace(/\/$/, '')
}

function authHeaders() {
  return {
    Authorization: `Bearer ${process.env.HIREALPHA_INTERNAL_KEY || ''}`,
    Accept: 'application/json',
    'Content-Type': 'application/json',
  }
}

export async function fetchDueEventNudges(persona: AgentId): Promise<EventNudge[]> {
  const base = apiBase()
  if (!base) return []
  try {
    const res = await fetch(
      `${base}/api/internal/event-nudges?persona=${encodeURIComponent(persona)}`,
      { headers: authHeaders() },
    )
    if (!res.ok) return []
    const data = (await res.json()) as { nudges?: EventNudge[] }
    return data.nudges || []
  } catch (err) {
    console.warn('[nudge] fetch failed', err)
    return []
  }
}

export async function revertEventNudge(phone: string, persona: AgentId, key: string) {
  const base = apiBase()
  if (!base) return
  try {
    await fetch(`${base}/api/internal/event-nudges/revert`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ phone, persona, key }),
    })
  } catch (err) {
    console.warn('[nudge] revert failed', err)
  }
}
