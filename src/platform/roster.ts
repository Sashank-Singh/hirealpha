import type { AgentId } from '../agents/types'
import type { ConnectorId } from './connectors'

const SESSION_KEY = 'hirealpha-session'
const ROSTER_KEY = 'hirealpha-roster'
const CONNECTIONS_KEY = 'hirealpha-connections'
const CONTEXT_KEY = 'hirealpha-hire-context'

export interface Session {
  email: string
  signedInAt: string
}

export interface HireEntitlement {
  agentId: AgentId
  status: 'active' | 'paused'
  hiredAt: string
}

export type ConnectionMap = Partial<Record<ConnectorId, { connected: boolean; updatedAt: string }>>
export type HireContextMap = Partial<Record<AgentId, Record<string, string>>>

function readJson<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key)
    if (!raw) return fallback
    return JSON.parse(raw) as T
  } catch {
    return fallback
  }
}

function writeJson(key: string, value: unknown) {
  localStorage.setItem(key, JSON.stringify(value))
}

export function getSession(): Session | null {
  return readJson<Session | null>(SESSION_KEY, null)
}

export function signIn(email: string): Session {
  const session: Session = { email: email.trim().toLowerCase(), signedInAt: new Date().toISOString() }
  writeJson(SESSION_KEY, session)
  return session
}

export function signOut() {
  localStorage.removeItem(SESSION_KEY)
}

export function getRoster(): HireEntitlement[] {
  return readJson<HireEntitlement[]>(ROSTER_KEY, [])
}

export function getActiveHireIds(): AgentId[] {
  return getRoster()
    .filter((h) => h.status === 'active')
    .map((h) => h.agentId)
}

export function hasHire(agentId: AgentId): boolean {
  return getRoster().some((h) => h.agentId === agentId && h.status === 'active')
}

export function addHire(agentId: AgentId): HireEntitlement[] {
  const roster = getRoster().filter((h) => h.agentId !== agentId)
  roster.push({ agentId, status: 'active', hiredAt: new Date().toISOString() })
  writeJson(ROSTER_KEY, roster)
  return roster
}

export function removeHire(agentId: AgentId): HireEntitlement[] {
  const roster = getRoster().filter((h) => h.agentId !== agentId)
  writeJson(ROSTER_KEY, roster)
  return roster
}

export function getConnections(): ConnectionMap {
  return readJson<ConnectionMap>(CONNECTIONS_KEY, {})
}

export function setConnection(id: ConnectorId, connected: boolean): ConnectionMap {
  const next = { ...getConnections(), [id]: { connected, updatedAt: new Date().toISOString() } }
  writeJson(CONNECTIONS_KEY, next)
  return next
}

export function connectedIds(): ConnectorId[] {
  return (Object.entries(getConnections()) as [ConnectorId, { connected: boolean }][])
    .filter(([, v]) => v?.connected)
    .map(([id]) => id)
}

export function getHireContext(agentId: AgentId): Record<string, string> {
  return getAllHireContext()[agentId] ?? {}
}

export function getAllHireContext(): HireContextMap {
  return readJson<HireContextMap>(CONTEXT_KEY, {})
}

export function setHireContextField(agentId: AgentId, fieldId: string, value: string): Record<string, string> {
  const all = getAllHireContext()
  const current = { ...(all[agentId] ?? {}), [fieldId]: value }
  all[agentId] = current
  writeJson(CONTEXT_KEY, all)
  return current
}
