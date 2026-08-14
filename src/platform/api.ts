import type { AgentId } from '../agents/types'
import type { ConnectorId } from './connectors'

const API = ''

async function parseJson<T>(res: Response): Promise<T> {
  const text = await res.text()
  try {
    return JSON.parse(text) as T
  } catch {
    throw new Error(text.slice(0, 180) || `Request failed (${res.status})`)
  }
}

export async function apiExchangeGoogle(ticket: string) {
  const res = await fetch(`${API}/api/auth/ticket?ticket=${encodeURIComponent(ticket)}`)
  const data = await parseJson<{ email?: string; name?: string | null; phone?: string | null; error?: string }>(res)
  if (!res.ok || !data.email) throw new Error(data.error || 'Google sign in failed')
  return { email: data.email, name: data.name || '', phone: data.phone || '' }
}

export async function apiSignIn(email: string, phone: string, name?: string, timezone?: string) {
  const res = await fetch(`${API}/api/me`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, phone, name, timezone }),
  })
  const data = await parseJson<{
    user?: { id: string; email: string; name: string | null; timezone: string | null; phone: string | null }
    roster?: AgentId[]
    error?: string
  }>(res)
  if (!res.ok) throw new Error(data.error || 'Could not sign in')
  return data
}

export async function apiMe(email: string) {
  const res = await fetch(`${API}/api/me?email=${encodeURIComponent(email)}`)
  if (!res.ok) throw new Error('Could not load account')
  return parseJson<{
    user: { id: string; email: string; name: string | null; timezone: string | null; phone: string | null } | null
    roster: AgentId[]
    context: Partial<Record<AgentId, Record<string, string>>>
    connected: ConnectorId[]
    memory?: Partial<Record<AgentId, Array<{ key: string; value: string; durable: boolean }>>>
  }>(res)
}

export async function apiSavePhone(email: string, phone: string, name?: string, timezone?: string) {
  const res = await fetch(`${API}/api/me/phone`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, phone, name, timezone }),
  })
  const data = await parseJson<{ error?: string }>(res)
  if (!res.ok) throw new Error(data.error || 'Could not save phone')
}

export async function apiSaveRoster(email: string, agentIds: AgentId[]) {
  const res = await fetch(`${API}/api/me/roster`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, agentIds }),
  })
  if (!res.ok) throw new Error('Could not save roster')
}

export async function apiSaveContext(email: string, agentId: AgentId, fields: Record<string, string>) {
  const res = await fetch(`${API}/api/me/hires/${agentId}/context`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, fields }),
  })
  if (!res.ok) throw new Error('Could not save context')
}

export type HireMemory = { key: string; value: string; durable: boolean }

export async function apiHireMemory(email: string, agentId: AgentId) {
  const res = await fetch(`${API}/api/me/hires/${agentId}/memory?email=${encodeURIComponent(email)}`)
  if (!res.ok) throw new Error('Could not load memory')
  return parseJson<{ memories: HireMemory[] }>(res)
}

export async function apiSaveMemory(email: string, agentId: AgentId, facts: Array<{ key: string; value: string }>) {
  const res = await fetch(`${API}/api/me/hires/${agentId}/memory`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, facts }),
  })
  const data = await parseJson<{ memories?: HireMemory[]; error?: string }>(res)
  if (!res.ok) throw new Error(data.error || 'Could not save memory')
  return data.memories || []
}

export async function apiDeleteMemory(email: string, agentId: AgentId, key: string) {
  const qs = new URLSearchParams({ email, key })
  const res = await fetch(`${API}/api/me/hires/${agentId}/memory?${qs}`, { method: 'DELETE' })
  const data = await parseJson<{ memories?: HireMemory[]; error?: string }>(res)
  if (!res.ok) throw new Error(data.error || 'Could not delete memory')
  return data.memories || []
}

export async function apiConnectorStatus() {
  const res = await fetch(`${API}/api/connectors/status`)
  if (!res.ok) return { google: false, composio: false }
  return parseJson<{ google: boolean; composio: boolean }>(res)
}

export async function apiConnectUrl(input: {
  connector: ConnectorId
  email: string
  persona: AgentId
}) {
  const qs = new URLSearchParams({
    email: input.email,
    persona: input.persona,
    redirect: `/app/hires/${input.persona}`,
    json: '1',
  })
  const res = await fetch(`${API}/api/connect/${input.connector}?${qs}`)
  const data = await parseJson<{ url?: string; error?: string; message?: string }>(res)
  if (!res.ok || !data.url) {
    throw new Error(data.message || data.error || 'Connect is not configured yet')
  }
  return data.url
}

export async function apiSetup(input: {
  persona: AgentId
  feature: string
  email?: string
  token?: string
}) {
  const res = await fetch(`${API}/api/setup`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      persona: input.persona,
      feature: input.feature,
      email: input.email,
      token: input.token,
    }),
  })
  const data = await parseJson<{ ok?: boolean; setup?: string[]; error?: string; code?: string }>(res)
  if (!res.ok) throw new Error(data.error || 'Could not set up that feature')
  return data
}
