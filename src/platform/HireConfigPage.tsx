import { useEffect, useRef, useState } from 'react'
import { Link, Navigate, useParams, useSearchParams } from 'react-router-dom'
import { getAgent } from '../agents'
import type { AgentId } from '../agents/types'
import { SKILLS } from '../agents/skills'
import {
  CONTEXT_FIELDS,
  TIMEZONES,
  connectorsForHire,
  setupProgress,
  type ConnectorId,
} from './connectors'
import { ConnectorLogo } from './ConnectorLogo'
import { apiConnectUrl, apiConnectorStatus, apiDeleteMemory, apiHireMemory, apiSaveMemory, type HireMemory } from './api'
import {
  connectedIds,
  getHireContext,
  getSession,
  hasHire,
  hydrateFromServer,
  persistHireContext,
  setHireContextField,
} from './roster'

const AGENT_IDS: AgentId[] = ['friend', 'coworker', 'cofounder']
const MARK: Record<AgentId, string> = {
  friend: 'Fr',
  coworker: 'Co',
  cofounder: 'Cf',
}

function isAgentId(value: string | undefined): value is AgentId {
  return !!value && (AGENT_IDS as string[]).includes(value)
}

export function HireConfigPage() {
  const { agentId: raw } = useParams()
  const [params, setParams] = useSearchParams()
  const [, bump] = useState(0)
  const [copied, setCopied] = useState(false)
  const [connectError, setConnectError] = useState('')
  const [connecting, setConnecting] = useState<ConnectorId | null>(null)
  const [ready, setReady] = useState<{ google: boolean; composio: boolean } | null>(null)
  const [memories, setMemories] = useState<HireMemory[]>([])
  const [memKey, setMemKey] = useState('')
  const [memValue, setMemValue] = useState('')
  const saveTimer = useRef<number | null>(null)
  const refresh = () => bump((n) => n + 1)

  useEffect(() => {
    void hydrateFromServer()
      .then(refresh)
      .catch(() => undefined)
    void apiConnectorStatus()
      .then(setReady)
      .catch(() => setReady({ google: false, composio: false }))
  }, [])

  useEffect(() => {
    const email = getSession()?.email
    if (!email || !isAgentId(raw)) return
    void apiHireMemory(email, raw)
      .then((d) => setMemories(d.memories || []))
      .catch(() => setMemories([]))
  }, [raw])

  useEffect(() => {
    if (!params.get('connected')) return
    void hydrateFromServer()
      .then(refresh)
      .catch(() => undefined)
    setParams({}, { replace: true })
  }, [params, setParams])

  useEffect(() => {
    const toConnect = params.get('connect')
    if (!toConnect) return
    const el = document.getElementById(`connector-${toConnect}`)
    if (el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'center' })
    }
  }, [params])

  if (!isAgentId(raw)) return <Navigate to="/app" replace />
  const agentId = raw
  if (!hasHire(agentId)) {
    const agent = getAgent(agentId)
    return (
      <div className="plat-page">
        <h1>Not hired yet</h1>
        <p className="plat-lead">Add {agent.name} first. Setup only opens for people on your roster.</p>
        <Link to="/app/shop" className="plat-btn">
          Hire {agent.name}
        </Link>
      </div>
    )
  }

  const agent = getAgent(agentId)
  const connectors = connectorsForHire(agentId)
  const fields = CONTEXT_FIELDS[agentId]
  const connected = connectedIds()
  const context = getHireContext(agentId)
  const progress = setupProgress({ agentId, connected, context })
  const skills = SKILLS[agentId]
  const connectedCount = connectors.filter((c) => connected.includes(c.id)).length
  const session = getSession()

  function scheduleSave() {
    if (saveTimer.current) window.clearTimeout(saveTimer.current)
    saveTimer.current = window.setTimeout(() => persistHireContext(agentId), 450)
  }

  async function copyNumber() {
    try {
      await navigator.clipboard.writeText(agent.phoneNumber)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1600)
    } catch {
      setCopied(false)
    }
  }

  async function connect(id: ConnectorId) {
    if (!session?.email) return
    setConnectError('')
    setConnecting(id)
    try {
      const url = await apiConnectUrl({ connector: id, email: session.email, persona: agentId })
      window.location.href = url
    } catch (err) {
      setConnectError(err instanceof Error ? err.message : 'Could not start connect')
      setConnecting(null)
    }
  }

  const targetConnector = params.get('connect')

  return (
    <div className="plat-page">
      <Link to="/app" className="plat-back">
        People
      </Link>

      <header className="plat-id">
        <span className="plat-mark plat-mark--lg" style={{ background: agent.color }}>
          {MARK[agentId]}
        </span>
        <div>
          <h1>{agent.name}</h1>
          <p>
            {agent.imsgName} in Messages · {progress.pct}% ready
          </p>
        </div>
        <div className="plat-id__call">
          <strong>{agent.phoneDisplay}</strong>
          <button type="button" className="plat-link" onClick={() => void copyNumber()}>
            {copied ? 'Copied' : 'Copy number'}
          </button>
        </div>
      </header>

      <div className="plat-split">
        <section>
          <h2>
            Tools
            <span>
              {connectedCount}/{connectors.length}
            </span>
          </h2>
          <p className="plat-hint">Never: {skills.deny.join(', ')}.</p>
          {ready && !ready.composio && !ready.google && (
            <p className="plat-auth__error">
              Connect is not live yet. Add COMPOSIO_API_KEY on HireAlpha-Web, then tap Connect again.
            </p>
          )}
          {connectError && <p className="plat-auth__error">{connectError}</p>}
          <ul className="plat-tools">
            {connectors.map((c) => {
              const on = connected.includes(c.id)
              const isTarget = targetConnector === c.id
              return (
                <li
                  key={c.id}
                  id={`connector-${c.id}`}
                  className={isTarget ? 'plat-tool--highlight' : ''}
                >
                  <ConnectorLogo id={c.id} />
                  <div>
                    <strong>{c.name}</strong>
                    <span>{c.blurb}</span>
                  </div>
                  {on ? (
                    <span className="plat-link">Connected</span>
                  ) : (
                    <button
                      type="button"
                      className="plat-btn plat-btn--sm"
                      disabled={connecting === c.id}
                      onClick={() => void connect(c.id)}
                    >
                      {connecting === c.id ? 'Opening…' : 'Connect'}
                    </button>
                  )}
                </li>
              )
            })}
          </ul>
        </section>

        <section>
          <h2>Context</h2>
          <p className="plat-hint">Saved to this hire. They read it on the next text.</p>
          <div className="plat-fields">
            {fields.map((f) => (
              <label key={f.id} className="plat-field">
                <span>{f.label}</span>
                <small>{f.hint}</small>
                {f.timezone ? (
                  <select
                    value={context[f.id] ?? ''}
                    onChange={(e) => {
                      setHireContextField(agentId, f.id, e.target.value)
                      scheduleSave()
                      refresh()
                    }}
                    onBlur={() => persistHireContext(agentId)}
                  >
                    <option value="">Pick a timezone…</option>
                    {TIMEZONES.map((tz) => (
                      <option key={tz} value={tz}>
                        {tz}
                      </option>
                    ))}
                  </select>
                ) : f.multiline ? (
                  <textarea
                    rows={3}
                    placeholder={f.placeholder}
                    value={context[f.id] ?? ''}
                    onChange={(e) => {
                      setHireContextField(agentId, f.id, e.target.value)
                      scheduleSave()
                      refresh()
                    }}
                    onBlur={() => persistHireContext(agentId)}
                  />
                ) : (
                  <input
                    type="text"
                    placeholder={f.placeholder}
                    value={context[f.id] ?? ''}
                    onChange={(e) => {
                      setHireContextField(agentId, f.id, e.target.value)
                      scheduleSave()
                      refresh()
                    }}
                    onBlur={() => persistHireContext(agentId)}
                  />
                )}
              </label>
            ))}
          </div>
        </section>
      </div>

      <section className="plat-memory">
        <h2>Remembers</h2>
        <p className="plat-hint">
          What {agent.name} keeps. Names, people, timezone, and this week&apos;s decision do not expire. Edit or delete
          anything that is wrong.
        </p>
        {memories.length ? (
          <ul className="plat-memory-list">
            {memories.map((m) => (
              <li key={m.key}>
                <label className="plat-field">
                  <span>
                    {m.key}
                    {m.durable ? <small> durable</small> : null}
                  </span>
                  <input
                    type="text"
                    value={m.value}
                    onChange={(e) => {
                      const value = e.target.value
                      setMemories((prev) => prev.map((x) => (x.key === m.key ? { ...x, value } : x)))
                    }}
                    onBlur={(e) => {
                      const email = session?.email
                      if (!email) return
                      void apiSaveMemory(email, agentId, [{ key: m.key, value: e.target.value }]).catch(() => undefined)
                    }}
                  />
                </label>
                <button
                  type="button"
                  className="plat-link"
                  onClick={() => {
                    const email = session?.email
                    if (!email) return
                    void apiDeleteMemory(email, agentId, m.key)
                      .then(setMemories)
                      .catch(() => undefined)
                  }}
                >
                  Forget
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="plat-hint">Nothing stored yet. It fills in from Context and from what you text.</p>
        )}
        <div className="plat-memory-add">
          <input
            type="text"
            placeholder="sister_flight"
            value={memKey}
            onChange={(e) => setMemKey(e.target.value)}
          />
          <input
            type="text"
            placeholder="Friday 7:40"
            value={memValue}
            onChange={(e) => setMemValue(e.target.value)}
          />
          <button
            type="button"
            className="plat-btn plat-btn--sm"
            disabled={!memKey.trim() || !memValue.trim() || !session?.email}
            onClick={() => {
              const email = session?.email
              if (!email) return
              void apiSaveMemory(email, agentId, [{ key: memKey.trim(), value: memValue.trim() }])
                .then((next) => {
                  setMemories(next)
                  setMemKey('')
                  setMemValue('')
                })
                .catch(() => undefined)
            }}
          >
            Remember
          </button>
        </div>
      </section>
    </div>
  )
}
