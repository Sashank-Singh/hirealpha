import type { AgentId } from '../agents/types'
import type { ConnectorId } from './connectors'
import { apiMe, apiSaveContext, apiSaveRoster } from './api'

const SESSION_KEY = 'hirealpha-session'
const ROSTER_KEY = 'hirealpha-roster'
const CONNECTIONS_KEY = 'hirealpha-connections'
const CONTEXT_KEY = 'hirealpha-hire-context'

export interface Session {
  email: string
  phone: string
  name?: string
  timezone?: string
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
  const raw = readJson<Session | (Omit<Session, 'phone'> & { phone?: string }) | null>(SESSION_KEY, null)
  if (!raw) return null
  return {
    email: raw.email,
    phone: raw.phone || '',
    name: raw.name || undefined,
    timezone: raw.timezone || undefined,
    signedInAt: raw.signedInAt,
  }
}

export function signIn(email: string, phone = '', name?: string, timezone?: string): Session {
  const session: Session = {
    email: email.trim().toLowerCase(),
    phone: phone.trim(),
    name: name?.trim() || undefined,
    timezone: timezone?.trim() || undefined,
    signedInAt: new Date().toISOString(),
  }
  writeJson(SESSION_KEY, session)
  return session
}

export function signOut() {
  localStorage.removeItem(SESSION_KEY)
}

export const clearSession = signOut


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

function persistRosterRemote() {
  const session = getSession()
  if (!session?.email) return
  void apiSaveRoster(session.email, getActiveHireIds()).catch((err) => {
    console.warn('[roster] save failed', err)
  })
}

export function addHire(agentId: AgentId): HireEntitlement[] {
  const roster = getRoster().filter((h) => h.agentId !== agentId)
  roster.push({ agentId, status: 'active', hiredAt: new Date().toISOString() })
  writeJson(ROSTER_KEY, roster)
  persistRosterRemote()
  return roster
}

export function removeHire(agentId: AgentId): HireEntitlement[] {
  const roster = getRoster().filter((h) => h.agentId !== agentId)
  writeJson(ROSTER_KEY, roster)
  persistRosterRemote()
  return roster
}

export function replaceRoster(agentIds: AgentId[]): HireEntitlement[] {
  const now = new Date().toISOString()
  const roster: HireEntitlement[] = agentIds.map((agentId) => ({
    agentId,
    status: 'active',
    hiredAt: now,
  }))
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

export function replaceConnections(ids: ConnectorId[]): ConnectionMap {
  const next: ConnectionMap = {}
  const now = new Date().toISOString()
  for (const id of ids) next[id] = { connected: true, updatedAt: now }
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

export function replaceHireContext(map: HireContextMap) {
  writeJson(CONTEXT_KEY, map)
}

export function persistHireContext(agentId: AgentId) {
  const session = getSession()
  if (!session?.email) return
  void apiSaveContext(session.email, agentId, getHireContext(agentId)).catch((err) => {
    console.warn('[context] save failed', err)
  })
}

export async function hydrateFromServer(): Promise<void> {
  const session = getSession()
  if (!session?.email) return
  const data = await apiMe(session.email)
  const serverName = data.user?.name || undefined
  const serverTz = data.user?.timezone || undefined
  const needsPhone = data.user?.phone && data.user.phone !== session.phone
  if (needsPhone || (serverName && serverName !== session.name) || (serverTz && serverTz !== session.timezone)) {
    signIn(session.email, data.user?.phone || session.phone, serverName, serverTz)
  }
  if (data.roster?.length) {
    replaceRoster(data.roster)
  } else if (getActiveHireIds().length) {
    await apiSaveRoster(session.email, getActiveHireIds()).catch(() => undefined)
  }
  if (data.context && Object.keys(data.context).length) {
    replaceHireContext(data.context)
  }
  replaceConnections(data.connected || [])
}
