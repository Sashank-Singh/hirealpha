import { Composio } from '@composio/core'
import { ConnectorError, type Persona } from '../types'
import {
  featuredToolkits,
  isToolkitAllowed,
  normalizeToolkitSlug,
} from './policy'

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

export class ComposioGateway {
  private readonly client: Composio

  constructor(apiKey: string) {
    this.client = new Composio({
      apiKey,
      allowTracking: false,
    })
  }

  static fromEnv(): ComposioGateway | null {
    const key = process.env.COMPOSIO_API_KEY?.trim()
    if (!key) return null
    return new ComposioGateway(key)
  }

  async listCatalog(input: {
    userId: string
    persona?: Persona | null
    limit?: number
    category?: string
  }): Promise<{ toolkits: GatewayToolkit[]; gateway: 'composio' }> {
    const limit = Math.min(Math.max(input.limit ?? 100, 1), 250)
    const raw = await this.client.toolkits.get({
      limit,
      sortBy: 'usage',
      ...(input.category ? { category: input.category } : {}),
    })
    const items = Array.isArray(raw) ? raw : []

    const connected = await this.listConnections(input.userId)
    const bySlug = new Map(connected.map((c) => [normalizeToolkitSlug(c.toolkit), c]))
    const featured = new Set(
      input.persona ? featuredToolkits(input.persona).map(normalizeToolkitSlug) : [],
    )

    const toolkits: GatewayToolkit[] = []
    for (const item of items) {
      const slug = normalizeToolkitSlug(item.slug)
      if (input.persona && !isToolkitAllowed(input.persona, slug)) continue
      const conn = bySlug.get(slug)
      toolkits.push({
        slug: item.slug,
        name: item.name,
        description: item.meta?.description ?? '',
        logo: item.meta?.logo ?? null,
        categories: (item.meta?.categories ?? []).map((c) => c.slug),
        authRequired: !item.noAuth,
        toolsCount: item.meta?.toolsCount ?? null,
        featured: featured.has(slug),
        connected: !!conn && !conn.isDisabled && conn.status.toUpperCase() === 'ACTIVE',
        connectedAccountId: conn?.id ?? null,
      })
    }

    toolkits.sort((a, b) => {
      if (a.featured !== b.featured) return a.featured ? -1 : 1
      if (a.connected !== b.connected) return a.connected ? -1 : 1
      return a.name.localeCompare(b.name)
    })

    return { toolkits, gateway: 'composio' }
  }

  async startConnect(input: {
    userId: string
    toolkit: string
    persona?: Persona | null
    callbackUrl: string
  }): Promise<{ redirectUrl: string }> {
    const slug = normalizeToolkitSlug(input.toolkit)
    if (input.persona && !isToolkitAllowed(input.persona, slug)) {
      throw new ConnectorError(
        `Toolkit ${input.toolkit} is not allowed for ${input.persona}`,
        'PERMISSION_DENIED',
      )
    }

    const session = await this.client.create(input.userId, {
      manageConnections: false,
    })
    const request = await session.authorize(input.toolkit, {
      callbackUrl: input.callbackUrl,
    })
    if (!request.redirectUrl) {
      throw new ConnectorError('Composio did not return a connect URL', 'PROVIDER_ERROR')
    }
    return { redirectUrl: request.redirectUrl }
  }

  async listConnections(userId: string): Promise<GatewayConnection[]> {
    const res = await this.client.connectedAccounts.list({
      userIds: [userId],
      limit: 100,
    })
    return (res.items ?? []).map((item) => ({
      id: item.id,
      toolkit: item.toolkit.slug,
      status: String(item.status),
      isDisabled: item.isDisabled,
      createdAt: item.createdAt,
      updatedAt: item.updatedAt,
    }))
  }

  async disconnect(connectedAccountId: string): Promise<void> {
    await this.client.connectedAccounts.delete(connectedAccountId)
  }

  /**
   * Agent-facing session: tools for the persona's allowed / connected apps.
   * Chat layer can call this and pass `tools` into the model provider.
   */
  async createSession(input: {
    userId: string
    persona: Persona
    mcp?: boolean
  }): Promise<{
    sessionId: string
    toolCount: number
    toolNames: string[]
    mcp: { url: string; headers: Record<string, string> } | null
  }> {
    const featured = featuredToolkits(input.persona)
    const connected = await this.listConnections(input.userId)
    const connectedSlugs = connected
      .filter((c) => !c.isDisabled && c.status.toUpperCase() === 'ACTIVE')
      .map((c) => c.toolkit)
      .filter((slug) => isToolkitAllowed(input.persona, slug))

    const toolkits = [...new Set([...featured, ...connectedSlugs])]
    const session = await this.client.create(input.userId, {
      manageConnections: false,
      ...(toolkits.length ? { toolkits } : {}),
      ...(input.mcp ? { mcp: true } : {}),
    })

    const tools = await session.tools()
    const list = Array.isArray(tools) ? tools : []
    const toolNames = list
      .map((t) => {
        if (t && typeof t === 'object' && 'function' in t) {
          const fn = (t as { function?: { name?: string } }).function
          return fn?.name
        }
        if (t && typeof t === 'object' && 'name' in t) {
          return (t as { name?: string }).name
        }
        return undefined
      })
      .filter((n): n is string => !!n)

    let mcp: { url: string; headers: Record<string, string> } | null = null
    if (input.mcp && 'mcp' in session && session.mcp) {
      const m = session.mcp as { url?: string; headers?: Record<string, string> }
      if (m.url) {
        mcp = { url: m.url, headers: m.headers ?? {} }
      }
    }

    return {
      sessionId: session.sessionId,
      toolCount: toolNames.length || list.length,
      toolNames,
      mcp,
    }
  }
}
