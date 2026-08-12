import { useEffect, useMemo, useState } from 'react'
import { Link, Navigate, useParams, useSearchParams } from 'react-router-dom'
import { getAgent } from '../agents'
import type { AgentId } from '../agents/types'
import { SKILLS } from '../agents/skills'
import {
  CONTEXT_FIELDS,
  connectorsForHire,
  setupProgress,
  type ConnectorId,
} from './connectors'
import {
  disconnectGateway,
  disconnectRemote,
  fetchConnections,
  fetchGatewayCatalog,
  fetchGatewayStatus,
  OAUTH_TO_UI,
  startGatewayConnect,
  startGatewayConnectMapped,
  startOAuthConnect,
  syncConnectorIdentity,
  UI_TO_OAUTH,
  type GatewayToolkit,
  type RemoteConnection,
} from './api'
import { getHireContext, hasHire, setHireContextField } from './roster'

const AGENT_IDS: AgentId[] = ['friend', 'coworker', 'cofounder']

const UI_TO_COMPOSIO_SLUG: Record<ConnectorId, string> = {
  calendar: 'googlecalendar',
  gmail: 'gmail',
  slack: 'slack',
  notion: 'notion',
  linear: 'linear',
  github: 'github',
  drive: 'googledrive',
  spotify: 'spotify',
  stripe: 'stripe',
  figma: 'figma',
  maps: 'googlemaps',
}

function isAgentId(value: string | undefined): value is AgentId {
  return !!value && (AGENT_IDS as string[]).includes(value)
}

function normSlug(s: string) {
  return s.trim().toLowerCase().replace(/[\s_]+/g, '')
}

export function HireConfigPage() {
  const { agentId: raw } = useParams()
  const [searchParams, setSearchParams] = useSearchParams()
  const [, bump] = useState(0)
  const refresh = () => bump((n) => n + 1)
  const [userId, setUserId] = useState<string | null>(null)
  const [remote, setRemote] = useState<RemoteConnection[]>([])
  const [catalog, setCatalog] = useState<GatewayToolkit[]>([])
  const [gatewayOn, setGatewayOn] = useState(false)
  const [catalogQuery, setCatalogQuery] = useState('')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      setLoading(true)
      setError('')
      try {
        const id = await syncConnectorIdentity()
        if (cancelled) return
        setUserId(id)
        const status = await fetchGatewayStatus()
        if (cancelled) return
        setGatewayOn(status.enabled)
        if (id) {
          const connections = await fetchConnections(id).catch(() => [] as RemoteConnection[])
          if (!cancelled) setRemote(connections)
          if (status.enabled && isAgentId(raw)) {
            const tools = await fetchGatewayCatalog({ userId: id, persona: raw, limit: 120 })
            if (!cancelled) setCatalog(tools)
          } else if (!cancelled) {
            setCatalog([])
          }
        }
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : 'Could not load connections')
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [bump, raw])

  useEffect(() => {
    const connected = searchParams.get('connected')
    const status = searchParams.get('status')
    if (connected || status === 'success' || status === 'failed') {
      setSearchParams({}, { replace: true })
      bump((n) => n + 1)
    }
  }, [searchParams, setSearchParams])

  const filteredCatalog = useMemo(() => {
    const q = catalogQuery.trim().toLowerCase()
    if (!q) return catalog
    return catalog.filter(
      (t) =>
        t.name.toLowerCase().includes(q) ||
        t.slug.toLowerCase().includes(q) ||
        t.description.toLowerCase().includes(q),
    )
  }, [catalog, catalogQuery])

  if (!isAgentId(raw)) return <Navigate to="/app" replace />
  if (!hasHire(raw)) {
    const agent = getAgent(raw)
    return (
      <div className="plat-empty">
        <h1>Not hired yet</h1>
        <p>Add {agent.name} first. Setup only opens for hires on your roster.</p>
        <Link to="/app/shop" className="plat-btn">
          Add {agent.name}
        </Link>
      </div>
    )
  }

  const agent = getAgent(raw)
  const connectors = connectorsForHire(raw)
  const fields = CONTEXT_FIELDS[raw]
  const context = getHireContext(raw)
  const skills = SKILLS[raw]

  const gatewayBySlug = new Map(catalog.map((t) => [normSlug(t.slug), t]))

  const connectedUiIds = new Set(
    remote
      .map((c) => OAUTH_TO_UI[c.service])
      .filter((id): id is ConnectorId => !!id),
  )
  for (const c of connectors) {
    const slug = UI_TO_COMPOSIO_SLUG[c.id]
    const row = gatewayBySlug.get(normSlug(slug))
    if (row?.connected) connectedUiIds.add(c.id)
  }

  const progress = setupProgress({
    agentId: raw,
    connected: [...connectedUiIds],
    context,
  })
  const connectedCount = connectors.filter((c) => connectedUiIds.has(c.id)).length
  const catalogConnected = catalog.filter((t) => t.connected).length

  async function onConnect(connectorId: ConnectorId) {
    if (!userId || !isAgentId(raw)) {
      setError('Sign in again so we can start OAuth.')
      return
    }
    const service = UI_TO_OAUTH[connectorId]
    const persona = raw
    setBusy(connectorId)
    const redirectAfter = `${window.location.origin}/app/hires/${persona}?connected=${service}`
    if (gatewayOn) {
      startGatewayConnectMapped({
        service: connectorId,
        userId,
        persona,
        redirectAfter,
      })
      return
    }
    startOAuthConnect({
      service,
      userId,
      persona,
      redirectAfter,
    })
  }

  async function onDisconnect(connectorId: ConnectorId) {
    if (!userId) return
    setBusy(connectorId)
    setError('')
    try {
      const slug = UI_TO_COMPOSIO_SLUG[connectorId]
      const gw = gatewayBySlug.get(normSlug(slug))
      if (gw?.connectedAccountId) {
        await disconnectGateway(gw.connectedAccountId)
      } else {
        const service = UI_TO_OAUTH[connectorId]
        const row = remote.find((c) => c.service === service)
        if (!row) return
        await disconnectRemote(row.id)
        setRemote(await fetchConnections(userId))
      }
      refresh()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Disconnect failed')
    } finally {
      setBusy(null)
    }
  }

  async function onCatalogConnect(toolkit: GatewayToolkit) {
    if (!userId || !isAgentId(raw)) {
      setError('Sign in again so we can start OAuth.')
      return
    }
    setBusy(toolkit.slug)
    startGatewayConnect({
      toolkit: toolkit.slug,
      userId,
      persona: raw,
      redirectAfter: `${window.location.origin}/app/hires/${raw}?connected=${toolkit.slug}`,
    })
  }

  async function onCatalogDisconnect(toolkit: GatewayToolkit) {
    if (!toolkit.connectedAccountId) return
    setBusy(toolkit.slug)
    setError('')
    try {
      await disconnectGateway(toolkit.connectedAccountId)
      refresh()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Disconnect failed')
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="plat-config">
      <Link to="/app" className="plat-link plat-back">
        Roster
      </Link>

      <header className="plat-head plat-head--config">
        <div>
          <h1>{agent.name}</h1>
          <p className="plat-lead">
            {agent.imsgName}, {agent.phoneDisplay}. {progress.pct}% ready.
          </p>
        </div>
      </header>

      {error && <p className="plat-auth__error">{error}</p>}
      {loading && <p className="plat-lead">Loading connections…</p>}

      <section className="plat-block">
        <div className="plat-block__head">
          <h2>Tools</h2>
          <p>
            {connectedCount} of {connectors.length} featured connected
            {gatewayOn ? ' via the connector gateway' : ' via OAuth'}. Never: {skills.deny.join(', ')}.
          </p>
        </div>
        <ul className="plat-tools">
          {connectors.map((c) => {
            const on = connectedUiIds.has(c.id)
            return (
              <li key={c.id}>
                <div>
                  <strong>{c.name}</strong>
                  <span>{c.blurb}</span>
                </div>
                <button
                  type="button"
                  className={on ? 'plat-link' : 'plat-btn plat-btn--sm'}
                  disabled={busy === c.id || loading || !userId}
                  onClick={() => (on ? onDisconnect(c.id) : onConnect(c.id))}
                >
                  {busy === c.id ? 'Working…' : on ? 'Disconnect' : 'Connect'}
                </button>
              </li>
            )
          })}
        </ul>
      </section>

      {gatewayOn && (
        <section className="plat-block">
          <div className="plat-block__head">
            <h2>Catalog</h2>
            <p>
              {catalogConnected} connected of {catalog.length} apps available for {agent.name}. One
              gateway covers the rest so we do not hand code each OAuth app.
            </p>
          </div>
          <label className="plat-field">
            <span>Search apps</span>
            <input
              type="search"
              placeholder="Gmail, Notion, HubSpot…"
              value={catalogQuery}
              onChange={(e) => setCatalogQuery(e.target.value)}
            />
          </label>
          <ul className="plat-tools">
            {filteredCatalog.slice(0, 60).map((t) => (
              <li key={t.slug}>
                <div>
                  <strong>{t.name}</strong>
                  <span>
                    {t.description || t.slug}
                    {t.toolsCount != null ? ` · ${t.toolsCount} tools` : ''}
                  </span>
                </div>
                <button
                  type="button"
                  className={t.connected ? 'plat-link' : 'plat-btn plat-btn--sm'}
                  disabled={busy === t.slug || loading || !userId}
                  onClick={() =>
                    t.connected ? onCatalogDisconnect(t) : onCatalogConnect(t)
                  }
                >
                  {busy === t.slug ? 'Working…' : t.connected ? 'Disconnect' : 'Connect'}
                </button>
              </li>
            ))}
          </ul>
          {filteredCatalog.length === 0 && !loading && (
            <p className="plat-lead">No apps match that search for this hire.</p>
          )}
        </section>
      )}

      <section className="plat-block">
        <div className="plat-block__head">
          <h2>Context</h2>
          <p>Only {agent.name} sees this.</p>
        </div>
        <div className="plat-fields">
          {fields.map((f) => (
            <label key={f.id} className="plat-field">
              <span>{f.label}</span>
              <small>{f.hint}</small>
              {f.multiline ? (
                <textarea
                  rows={3}
                  placeholder={f.placeholder}
                  value={context[f.id] ?? ''}
                  onChange={(e) => {
                    setHireContextField(raw, f.id, e.target.value)
                    refresh()
                  }}
                />
              ) : (
                <input
                  type="text"
                  placeholder={f.placeholder}
                  value={context[f.id] ?? ''}
                  onChange={(e) => {
                    setHireContextField(raw, f.id, e.target.value)
                    refresh()
                  }}
                />
              )}
            </label>
          ))}
        </div>
      </section>

      <p className="plat-foot">
        Text <strong>{agent.imsgName}</strong> at <strong>{agent.phoneDisplay}</strong> when ready.
      </p>
    </div>
  )
}
