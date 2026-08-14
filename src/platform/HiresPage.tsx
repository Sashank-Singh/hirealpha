import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { AGENTS, getAgent } from '../agents'
import type { AgentId } from '../agents/types'
import { connectorsForHire, setupProgress } from './connectors'
import { apiSavePhone } from './api'
import {
  addHire,
  connectedIds,
  getActiveHireIds,
  getHireContext,
  getSession,
  hasHire,
  hydrateFromServer,
  removeHire,
  signIn,
} from './roster'

const PRICE_PER = 19
const BUNDLE_PRICE = 39
const MARK: Record<AgentId, string> = {
  friend: 'Fr',
  coworker: 'Co',
  cofounder: 'Cf',
}

function monthlyFor(count: number) {
  if (count === 0) return 0
  if (count === AGENTS.length) return BUNDLE_PRICE
  return count * PRICE_PER
}

function PhoneLink({
  email,
  phoneDraft,
  setPhoneDraft,
  phoneMsg,
  setPhoneMsg,
  onSaved,
}: {
  email?: string
  phoneDraft: string
  setPhoneDraft: (v: string) => void
  phoneMsg: string
  setPhoneMsg: (v: string) => void
  onSaved: () => void
}) {
  return (
    <form
      className="plat-phone"
      onSubmit={(e) => {
        e.preventDefault()
        if (!email) return
        setPhoneMsg('')
        void apiSavePhone(email, phoneDraft, getSession()?.name, getSession()?.timezone)
          .then(() => {
            signIn(email, phoneDraft, getSession()?.name, getSession()?.timezone)
            setPhoneMsg('Saved. Text from this number.')
            onSaved()
          })
          .catch((err) => {
            setPhoneMsg(err instanceof Error ? err.message : 'Could not save phone')
          })
      }}
    >
      <label>
        iMessage from
        <input
          type="tel"
          value={phoneDraft}
          onChange={(e) => setPhoneDraft(e.target.value)}
          placeholder="+1 555 010 9876"
        />
      </label>
      <button type="submit" className="plat-btn plat-btn--sm">
        Save
      </button>
      {phoneMsg && <span>{phoneMsg}</span>}
    </form>
  )
}

export function HiresPage() {
  const [tick, setTick] = useState(0)
  const refresh = () => setTick((n) => n + 1)
  const [phoneDraft, setPhoneDraft] = useState(getSession()?.phone || '')
  const [phoneMsg, setPhoneMsg] = useState('')
  const session = getSession()
  const activeIds = getActiveHireIds()
  const connected = connectedIds()
  void tick

  useEffect(() => {
    void hydrateFromServer()
      .then(() => {
        setPhoneDraft(getSession()?.phone || '')
        refresh()
      })
      .catch(() => undefined)
  }, [])

  const monthly = monthlyFor(activeIds.length)
  const readyBits = activeIds.map((id) =>
    setupProgress({
      agentId: id,
      connected,
      context: getHireContext(id),
    }),
  )
  const next = activeIds.flatMap((id) => {
    const agent = getAgent(id)
    const p = setupProgress({
      agentId: id,
      connected,
      context: getHireContext(id),
    })
    const items: { key: string; label: string; href: string }[] = []
    const missing = p.missingConnectors[0]
    if (missing) {
      items.push({
        key: `${id}-tool`,
        label: `Connect ${missing.name} on ${agent.name}`,
        href: `/app/hires/${id}`,
      })
    } else if (p.missingContext[0]) {
      items.push({
        key: `${id}-ctx`,
        label: `${p.missingContext[0].label} on ${agent.name}`,
        href: `/app/hires/${id}`,
      })
    }
    return items
  })

  if (activeIds.length === 0) {
    return (
      <div className="plat-page">
        <header className="plat-page__head">
          <h1>People</h1>
          <p>Hire someone for your texts. Each person gets their own number.</p>
        </header>

        <PhoneLink
          email={session?.email}
          phoneDraft={phoneDraft}
          setPhoneDraft={setPhoneDraft}
          phoneMsg={phoneMsg}
          setPhoneMsg={setPhoneMsg}
          onSaved={refresh}
        />

        <div className="plat-toolbar">
          <span>None hired</span>
          <button
            type="button"
            className="plat-btn"
            onClick={() => {
              for (const a of AGENTS) addHire(a.id)
              refresh()
            }}
          >
            Hire all three, ${BUNDLE_PRICE}/mo
          </button>
        </div>

        <ul className="plat-people">
          {AGENTS.map((a) => (
            <li key={a.id} className="plat-person">
              <span className="plat-mark" style={{ background: a.color }}>
                {MARK[a.id]}
              </span>
              <div className="plat-person__body">
                <div className="plat-person__line">
                  <strong>{a.name}</strong>
                  <span>${PRICE_PER}/mo</span>
                </div>
                <p>{a.pitch}</p>
              </div>
              <button
                type="button"
                className="plat-btn plat-btn--sm"
                onClick={() => {
                  addHire(a.id)
                  refresh()
                }}
              >
                Hire
              </button>
            </li>
          ))}
        </ul>
      </div>
    )
  }

  return (
    <div className="plat-page plat-page--split">
      <div>
        <header className="plat-page__head">
          <h1>People</h1>
          <p>
            {activeIds.length} hired, ${monthly}/mo. Text them from Messages. The first text sends you a card to pick what you want them to do.
          </p>
        </header>

        <PhoneLink
          email={session?.email}
          phoneDraft={phoneDraft}
          setPhoneDraft={setPhoneDraft}
          phoneMsg={phoneMsg}
          setPhoneMsg={setPhoneMsg}
          onSaved={refresh}
        />

        <ul className="plat-people">
          {activeIds.map((id, i) => {
            const agent = getAgent(id)
            const progress = readyBits[i]
            const tools = connectorsForHire(id)
            const toolsOn = tools.filter((c) => connected.includes(c.id)).length
            return (
              <li key={id} className="plat-person plat-person--link">
                <Link to={`/app/hires/${id}`} className="plat-person__hit">
                  <span className="plat-mark" style={{ background: agent.color }}>
                    {MARK[id]}
                  </span>
                  <div className="plat-person__body">
                    <div className="plat-person__line">
                      <strong>{agent.name}</strong>
                      <span className="plat-person__phone">{agent.phoneDisplay}</span>
                    </div>
                    <p>
                      {agent.imsgName} · {toolsOn}/{tools.length} tools · {progress.pct}% ready
                    </p>
                  </div>
                </Link>
                <div className="plat-person__side">
                  <Link to={`/app/hires/${id}`} className="plat-btn plat-btn--sm">
                    Open
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

        {activeIds.length < AGENTS.length && (
          <p className="plat-foot">
            <Link to="/app/shop" className="plat-link">
              Hire someone else
            </Link>
          </p>
        )}
      </div>

      <aside className="plat-rail">
        <h2>Setup</h2>
        {next.length === 0 ? (
          <p>Everyone is set. Text them from Messages.</p>
        ) : (
          <ul>
            {next.map((step) => (
              <li key={step.key}>
                <Link to={step.href}>{step.label}</Link>
              </li>
            ))}
          </ul>
        )}
        <p className="plat-rail__meta">${monthly}/mo</p>
      </aside>
    </div>
  )
}

export function ShopPage() {
  const [tick, setTick] = useState(0)
  const refresh = () => setTick((n) => n + 1)
  const ownedCount = AGENTS.filter((a) => hasHire(a.id)).length
  const allOwned = ownedCount === AGENTS.length
  const monthly = monthlyFor(ownedCount)
  void tick

  return (
    <div className="plat-page">
      <header className="plat-page__head">
        <h1>Hire</h1>
        <p>One person is ${PRICE_PER}/mo. All three together are ${BUNDLE_PRICE}/mo.</p>
      </header>

      <div className="plat-toolbar">
        <span>{ownedCount === 0 ? 'None hired' : `${ownedCount} hired, $${monthly}/mo`}</span>
        {allOwned ? (
          <Link to="/app" className="plat-btn plat-btn--ghost">
            Open people
          </Link>
        ) : (
          <button
            type="button"
            className="plat-btn"
            onClick={() => {
              for (const a of AGENTS) addHire(a.id)
              refresh()
            }}
          >
            Hire all three
          </button>
        )}
      </div>

      <ul className="plat-people">
        {AGENTS.map((a) => {
          const owned = hasHire(a.id)
          return (
            <li key={a.id} className="plat-person">
              <span className="plat-mark" style={{ background: a.color }}>
                {MARK[a.id]}
              </span>
              <div className="plat-person__body">
                <div className="plat-person__line">
                  <strong>{a.name}</strong>
                  <span>{owned ? 'On roster' : `$${PRICE_PER}/mo`}</span>
                </div>
                <p>{a.pitch}</p>
              </div>
              <div className="plat-person__side">
                {owned ? (
                  <>
                    <Link to={`/app/hires/${a.id}`} className="plat-btn plat-btn--sm">
                      Open
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
    </div>
  )
}
