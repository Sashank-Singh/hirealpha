import { useState } from 'react'
import { Link } from 'react-router-dom'
import { AGENTS, getAgent } from '../agents'
import type { AgentId } from '../agents/types'
import { setupProgress } from './connectors'
import { addHire, connectedIds, getActiveHireIds, getHireContext, hasHire, removeHire } from './roster'

export function HiresPage() {
  const [tick, setTick] = useState(0)
  const refresh = () => setTick((n) => n + 1)
  const activeIds = getActiveHireIds()
  const connected = connectedIds()
  void tick

  if (activeIds.length === 0) {
    return (
      <div className="plat-empty">
        <h1>No hires yet</h1>
        <p>Add Friend, Coworker, or Cofounder. Setup only asks for what each hire can use.</p>
        <Link to="/app/shop" className="plat-btn">
          Choose a hire
        </Link>
      </div>
    )
  }

  return (
    <div className="plat-hires">
      <div className="plat-head">
        <div>
          <h1>Roster</h1>
          <p className="plat-lead">Configure access for who you hired.</p>
        </div>
        <Link to="/app/shop" className="plat-link">
          Add a hire
        </Link>
      </div>

      <ul className="plat-list">
        {activeIds.map((id) => {
          const agent = getAgent(id)
          const progress = setupProgress({
            agentId: id,
            connected,
            context: getHireContext(id),
          })
          return (
            <li key={id} className="plat-list__item">
              <div className="plat-list__main">
                <span className="plat-dot" style={{ background: agent.color }} aria-hidden />
                <div>
                  <h2>{agent.name}</h2>
                  <p>
                    {agent.imsgName}, {agent.phoneDisplay}
                  </p>
                </div>
              </div>
              <p className="plat-list__meta">{progress.pct}% ready</p>
              <div className="plat-list__actions">
                <Link to={`/app/hires/${id}`} className="plat-btn plat-btn--sm">
                  Configure
                </Link>
                <button
                  type="button"
                  className="plat-link"
                  onClick={() => {
                    removeHire(id)
                    refresh()
                  }}
                >
                  Remove
                </button>
              </div>
            </li>
          )
        })}
      </ul>
    </div>
  )
}

const PRICE_PER = 19
const BUNDLE_PRICE = 39
const BUNDLE_LIST = PRICE_PER * 3

export function ShopPage() {
  const [tick, setTick] = useState(0)
  const refresh = () => setTick((n) => n + 1)
  const ownedCount = AGENTS.filter((a) => hasHire(a.id)).length
  const allOwned = ownedCount === AGENTS.length
  const monthly = allOwned ? BUNDLE_PRICE : ownedCount * PRICE_PER
  void tick

  function hireAllThree() {
    for (const a of AGENTS) addHire(a.id)
    refresh()
  }

  return (
    <div className="plat-shop">
      <div className="plat-head">
        <div>
          <h1>Hire</h1>
          <p className="plat-lead">Buy one, two, or all three. Remove anyone later.</p>
        </div>
      </div>

      <div className="plat-bundle">
        <div>
          <h2>All three</h2>
          <p>
            <s>${BUNDLE_LIST}/mo</s> ${BUNDLE_PRICE}/mo
          </p>
        </div>
        {allOwned ? (
          <Link to="/app" className="plat-link">
            Open roster
          </Link>
        ) : (
          <button type="button" className="plat-btn" onClick={hireAllThree}>
            Hire all three
          </button>
        )}
      </div>

      <ul className="plat-list">
        {AGENTS.map((a) => {
          const owned = hasHire(a.id)
          return (
            <li key={a.id} className="plat-list__item">
              <div className="plat-list__main">
                <span className="plat-dot" style={{ background: a.color }} aria-hidden />
                <div>
                  <h2>{a.name}</h2>
                  <p>
                    {a.role}, ${PRICE_PER}/mo
                  </p>
                </div>
              </div>
              <p className="plat-list__meta">{owned ? 'On roster' : a.pitch}</p>
              <div className="plat-list__actions">
                {owned ? (
                  <>
                    <Link to={`/app/hires/${a.id}`} className="plat-btn plat-btn--sm">
                      Configure
                    </Link>
                    <button
                      type="button"
                      className="plat-link"
                      onClick={() => {
                        removeHire(a.id as AgentId)
                        refresh()
                      }}
                    >
                      Remove
                    </button>
                  </>
                ) : (
                  <button
                    type="button"
                    className="plat-btn plat-btn--sm"
                    onClick={() => {
                      addHire(a.id as AgentId)
                      refresh()
                    }}
                  >
                    Hire
                  </button>
                )}
              </div>
            </li>
          )
        })}
      </ul>

      {ownedCount > 0 && (
        <p className="plat-foot">
          {ownedCount} hired, ${monthly}/mo.{' '}
          <Link to="/app" className="plat-link">
            Go to roster
          </Link>
        </p>
      )}
    </div>
  )
}
