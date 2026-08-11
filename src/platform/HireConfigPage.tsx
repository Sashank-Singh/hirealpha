import { useState } from 'react'
import { Link, Navigate, useParams } from 'react-router-dom'
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
  connectedIds,
  getHireContext,
  hasHire,
  setConnection,
  setHireContextField,
} from './roster'

const AGENT_IDS: AgentId[] = ['friend', 'coworker', 'cofounder']

function isAgentId(value: string | undefined): value is AgentId {
  return !!value && (AGENT_IDS as string[]).includes(value)
}

export function HireConfigPage() {
  const { agentId: raw } = useParams()
  const [, bump] = useState(0)
  const refresh = () => bump((n) => n + 1)

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
  const connected = connectedIds()
  const context = getHireContext(raw)
  const progress = setupProgress({ agentId: raw, connected, context })
  const skills = SKILLS[raw]
  const connectedCount = connectors.filter((c) => connected.includes(c.id)).length

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

      <section className="plat-block">
        <div className="plat-block__head">
          <h2>Tools</h2>
          <p>
            {connectedCount} of {connectors.length} connected. Never: {skills.deny.join(', ')}.
          </p>
        </div>
        <ul className="plat-tools">
          {connectors.map((c) => {
            const on = connected.includes(c.id)
            return (
              <li key={c.id}>
                <div>
                  <strong>{c.name}</strong>
                  <span>{c.blurb}</span>
                </div>
                <button
                  type="button"
                  className={on ? 'plat-link' : 'plat-btn plat-btn--sm'}
                  onClick={() => {
                    setConnection(c.id as ConnectorId, !on)
                    refresh()
                  }}
                >
                  {on ? 'Disconnect' : 'Connect'}
                </button>
              </li>
            )
          })}
        </ul>
      </section>

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
