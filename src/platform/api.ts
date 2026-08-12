import type { ConnectorId } from './connectors'
import type { AgentId } from '../agents/types'
import { getSession } from './roster'

/** Backend OAuth service IDs (must match services/connectors). */
export type OAuthService =
  | 'google_calendar'
  | 'gmail'
  | 'slack'
  | 'notion'
  | 'linear'
  | 'github'
  | 'google_drive'
  | 'spotify'
  | 'uber'
  | 'stripe'
  | 'figma'
  | 'google_maps'

export const UI_TO_OAUTH: Record<ConnectorId, OAuthService> = {
  calendar: 'google_calendar',
  gmail: 'gmail',
  slack: 'slack',
  notion: 'notion',
  linear: 'linear',
  github: 'github',
  drive: 'google_drive',
  spotify: 'spotify',
  stripe: 'stripe',
  figma: 'figma',
  maps: 'google_maps',
}

export const OAUTH_TO_UI: Partial<Record<OAuthService, ConnectorId>> = {
  google_calendar: 'calendar',
  gmail: 'gmail',
  slack: 'slack',
  notion: 'notion',
  linear: 'linear',
  github: 'github',
  google_drive: 'drive',
  spotify: 'spotify',
  stripe: 'stripe',
  figma: 'figma',
  google_maps: 'maps',
}

const USER_ID_KEY = 'hirealpha-connector-user-id'

export function connectorsApiBase(): string {
  return (
    import.meta.env.VITE_CONNECTORS_URL ??
    'https://xx88g8zzx3wwedjdnnrbprm8.coolify.alphasphere.trade'
  )
}

export function getConnectorUserId(): string | null {
  return localStorage.getItem(USER_ID_KEY)
}

export function setConnectorUserId(id: string) {
  localStorage.setItem(USER_ID_KEY, id)
}

export async function ensureConnectorUser(email: string): Promise<string> {
  const existing = getConnectorUserId()
  if (existing) return existing
  const res = await fetch(`${connectorsApiBase()}/users`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email }),
  })
  if (!res.ok) {
    const err = await res.json().catch(() => ({}))
    throw new Error((err as { message?: string }).message ?? 'Could not create connector user')
  }
  const data = (await res.json()) as { user: { id: string } }
  setConnectorUserId(data.user.id)
  return data.user.id
}

export interface RemoteConnection {
  id: string
  service: OAuthService
  status: string
  scopesGranted: string[]
  personas: Array<{ persona: string; enabled: boolean }>
}

export async function fetchConnections(userId: string): Promise<RemoteConnection[]> {
  const res = await fetch(`${connectorsApiBase()}/users/${userId}/connections`)
  if (!res.ok) throw new Error('Failed to load connections')
  const data = (await res.json()) as { connections: RemoteConnection[] }
  return data.connections.filter((c) => c.status === 'active')
}

export function startOAuthConnect(input: {
  service: OAuthService
  userId: string
  persona: AgentId
  redirectAfter: string
}) {
  const url = new URL(`${connectorsApiBase()}/connect/${input.service}`)
  url.searchParams.set('user_id', input.userId)
  url.searchParams.set('persona', input.persona)
  url.searchParams.set('redirect_after', input.redirectAfter)
  window.location.assign(url.toString())
}

export async function disconnectRemote(connectedAccountId: string): Promise<void> {
  const res = await fetch(`${connectorsApiBase()}/disconnect/${connectedAccountId}`, {
    method: 'POST',
  })
  if (!res.ok) throw new Error('Disconnect failed')
}

/** Sync platform session email → connector user id (call after login / on config page). */
export async function syncConnectorIdentity(): Promise<string | null> {
  const session = getSession()
  if (!session?.email) return null
  try {
    return await ensureConnectorUser(session.email)
  } catch {
    return getConnectorUserId()
  }
}

/** Composio catalog item (one gateway → hundreds of apps). */
export interface GatewayToolkit {
  slug: string
  name: string
  description: string
  logo: string | null
  categories: string[]
  authRequired: boolean
  toolsCount: number | null
  featured: boolean
  connected: boolean
  connectedAccountId: string | null
}

export interface GatewayConnection {
  id: string
  toolkit: string
  status: string
  isDisabled: boolean
  createdAt: string
  updatedAt: string
}

export async function fetchGatewayStatus(): Promise<{ enabled: boolean; provider: string | null }> {
  const res = await fetch(`${connectorsApiBase()}/gateway/status`)
  if (!res.ok) return { enabled: false, provider: null }
  return (await res.json()) as { enabled: boolean; provider: string | null }
}

export async function fetchGatewayCatalog(input: {
  userId: string
  persona: AgentId
  limit?: number
}): Promise<GatewayToolkit[]> {
  const url = new URL(`${connectorsApiBase()}/gateway/catalog`)
  url.searchParams.set('user_id', input.userId)
  url.searchParams.set('persona', input.persona)
  url.searchParams.set('limit', String(input.limit ?? 100))
  const res = await fetch(url)
  if (!res.ok) {
    const err = await res.json().catch(() => ({}))
    throw new Error((err as { message?: string }).message ?? 'Failed to load connector catalog')
  }
  const data = (await res.json()) as { toolkits: GatewayToolkit[] }
  return data.toolkits
}

export async function fetchGatewayConnections(userId: string): Promise<GatewayConnection[]> {
  const res = await fetch(`${connectorsApiBase()}/gateway/users/${userId}/connections`)
  if (!res.ok) throw new Error('Failed to load gateway connections')
  const data = (await res.json()) as { connections: GatewayConnection[] }
  return data.connections.filter(
    (c) => !c.isDisabled && String(c.status).toUpperCase() === 'ACTIVE',
  )
}

/** Start Composio Connect Link for a toolkit slug (gmail, github, …). */
export function startGatewayConnect(input: {
  toolkit: string
  userId: string
  persona: AgentId
  redirectAfter: string
}) {
  const url = new URL(
    `${connectorsApiBase()}/gateway/connect/${encodeURIComponent(input.toolkit)}`,
  )
  url.searchParams.set('user_id', input.userId)
  url.searchParams.set('persona', input.persona)
  url.searchParams.set('redirect_after', input.redirectAfter)
  window.location.assign(url.toString())
}

/** Featured UI connector → Composio via service mapping. */
export function startGatewayConnectMapped(input: {
  service: OAuthService | ConnectorId
  userId: string
  persona: AgentId
  redirectAfter: string
}) {
  const url = new URL(
    `${connectorsApiBase()}/gateway/connect-mapped/${encodeURIComponent(input.service)}`,
  )
  url.searchParams.set('user_id', input.userId)
  url.searchParams.set('persona', input.persona)
  url.searchParams.set('redirect_after', input.redirectAfter)
  window.location.assign(url.toString())
}

export async function disconnectGateway(connectedAccountId: string): Promise<void> {
  const res = await fetch(`${connectorsApiBase()}/gateway/disconnect/${connectedAccountId}`, {
    method: 'POST',
  })
  if (!res.ok) throw new Error('Disconnect failed')
}
