import { useEffect, useState } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import { getAgent } from '../agents'
import type { AgentId } from '../agents/types'
import { getSession, signOut } from './roster'
import {
  apiMe,
  apiListLoops,
  apiListDecisions,
  apiPatchLoop,
  type OpenLoop,
  type Decision,
} from './api'
import { CONNECTOR_CATALOG, type ConnectorId } from './connectors'
import { ConnectorLogo } from './ConnectorLogo'
import { SettingsSheet } from './SettingsSheet'
import { TIERS, type Tier } from '../marketing/Pricing'
import './dashboard.css'

const ALPHA_SMS = 'sms:+14155951440&body=Hey%2C%20Alpha!'

export type DashTab =
  | 'overview'
  | 'activity'
  | 'connectors'
  | 'loops'
  | 'apps'
  | 'billing'
  | 'usage'
  | 'api'
  | 'settings'

interface ActionReceipt {
  id: string
  persona?: string
  action: string
  detail: string
  undoHint?: string | null
  undoneAt?: string | null
  createdAt?: string
}

interface ActivityEvent {
  id: string
  actor: 'user' | 'agent' | 'tool'
  badge: 'inbound' | 'reply' | 'tool'
  time: string
  content: string
  tool?: string
  status?: 'completed' | 'pending' | 'proactive'
  rawTrace?: string
}

export function PlatformDashboard() {
  const [searchParams, setSearchParams] = useSearchParams()
  const navigate = useNavigate()
  const session = getSession()

  const [activePersona, setActivePersona] = useState<AgentId>('friend')
  const [activeTab, setActiveTab] = useState<DashTab>(() => {
    const tab = searchParams.get('tab') as DashTab
    return ['overview', 'activity', 'connectors', 'loops', 'apps', 'billing', 'usage', 'api', 'settings'].includes(tab)
      ? tab
      : 'overview'
  })

  const [connectedTools, setConnectedTools] = useState<ConnectorId[]>([])
  const [actions, setActions] = useState<ActionReceipt[]>([])
  const [loops, setLoops] = useState<OpenLoop[]>([])
  const [decisions, setDecisions] = useState<Decision[]>([])
  const [selectedEventId, setSelectedEventId] = useState<string | null>(null)

  // Billing & API states
  const [billingLoading, setBillingLoading] = useState(false)
  const [apiKeyCopied, setApiKeyCopied] = useState(false)

  const agent = getAgent(activePersona)
  const phone = (session?.phone || '').replace(/[^\d+]/g, '')
  const email = session?.email || ''

  const switchTab = (tab: DashTab) => {
    setActiveTab(tab)
    setSearchParams({ tab, persona: activePersona })
  }

  // Load account data
  useEffect(() => {
    if (!email) return
    let cancelled = false

    Promise.all([
      apiMe(email).catch(() => null),
      phone
        ? fetch(`/api/actions?phone=${encodeURIComponent(phone)}`)
            .then((r) => (r.ok ? r.json() : { actions: [] }))
            .catch(() => ({ actions: [] }))
        : Promise.resolve({ actions: [] }),
      apiListLoops({ email, persona: activePersona }).catch(() => ({ loops: [] })),
      apiListDecisions({ email, persona: activePersona }).catch(() => ({ decisions: [] })),
    ]).then(([meData, actData, loopData, decData]) => {
      if (cancelled) return
      if (meData) {
        setConnectedTools(meData.connected || [])
      }
      setActions(actData.actions || [])
      setLoops(loopData.loops || [])
      setDecisions(decData.decisions || [])
    })

    return () => {
      cancelled = true
    }
  }, [email, phone, activePersona])

  const combinedFeed: ActivityEvent[] = actions.map((a) => ({
    id: a.id,
    actor: 'agent' as const,
    badge: 'tool' as const,
    time: a.createdAt ? new Date(a.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '--:--',
    content: a.detail || a.action,
    tool: a.action,
    status: a.undoneAt ? 'pending' as const : 'completed' as const,
    rawTrace: JSON.stringify({ action: a.action, detail: a.detail, undoHint: a.undoHint, id: a.id }, null, 2),
  }))

  const selectedEvent = combinedFeed.find((e) => e.id === selectedEventId) || combinedFeed[0] || null

  // Handle Stripe Checkout
  const handleStripeCheckout = async (plan: Tier) => {
    if (plan === 'free') {
      alert('You are on the Free tier. Alpha sends you a weekly briefing every Friday at 9:00 PM.')
      return
    }
    const targetEmail = email || session?.email || ''
    if (!targetEmail.includes('@')) {
      alert('Please enter a valid email address in Settings first.')
      return
    }
    setBillingLoading(true)
    try {
      const res = await fetch('/api/billing/checkout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: targetEmail,
          hire: activePersona,
          persona: activePersona,
          plan,
          trial_days: 7,
          annual: false,
        }),
      })
      const data = (await res.json().catch(() => ({}))) as { url?: string; error?: string }
      if (data.url) {
        window.location.href = data.url
      } else {
        alert(data.error || 'Stripe Checkout is being initialized. Please ensure STRIPE_SECRET_KEY is configured in your environment.')
      }
    } catch {
      alert('Could not start checkout session. Please check your network or server connection.')
    } finally {
      setBillingLoading(false)
    }
  }

  const handleLogout = () => {
    signOut()
    navigate('/app/login')
  }

  const tabLabels: Record<DashTab, string> = {
    overview: 'Overview',
    activity: 'Audit Log',
    connectors: 'Extensions',
    loops: 'Commitments',
    apps: 'Mini-Apps',
    billing: 'Billing & Plans',
    usage: 'Usage & Limits',
    api: 'API & Webhooks',
    settings: 'Settings',
  }

  return (
    <div className="rc-shell">
      {/* Sidebar */}
      <aside className="rc-sidebar">
        <div className="rc-sidebar__brand">
          <div className="rc-brand-title">
            <span />
            HireAlpha
          </div>
          <span className="rc-env-tag">prod</span>
        </div>

        {/* Persona Switcher */}
        <div className="rc-persona-segment">
          <div className="rc-segment-group">
            <button
              type="button"
              className={`rc-segment-btn ${activePersona === 'friend' ? 'is-active' : ''}`}
              onClick={() => setActivePersona('friend')}
            >
              Alpha
            </button>
            <button
              type="button"
              className={`rc-segment-btn ${activePersona === 'coworker' ? 'is-active' : ''}`}
              onClick={() => setActivePersona('coworker')}
            >
              Coworker
            </button>
            <button
              type="button"
              className={`rc-segment-btn ${activePersona === 'cofounder' ? 'is-active' : ''}`}
              onClick={() => setActivePersona('cofounder')}
            >
              Cofounder
            </button>
          </div>
        </div>

        {/* Navigation */}
        <nav className="rc-nav-menu">
          <div className="rc-nav-category">Workspace</div>
          <button
            type="button"
            className={`rc-nav-btn ${activeTab === 'overview' ? 'is-active' : ''}`}
            onClick={() => switchTab('overview')}
          >
            <span>Mission Control</span>
            <span className="keycap">1</span>
          </button>
          <button
            type="button"
            className={`rc-nav-btn ${activeTab === 'activity' ? 'is-active' : ''}`}
            onClick={() => switchTab('activity')}
          >
            <span>Audit Log</span>
            {actions.length > 0 && <span className="rc-nav-badge">{actions.length}</span>}
          </button>
          <button
            type="button"
            className={`rc-nav-btn ${activeTab === 'connectors' ? 'is-active' : ''}`}
            onClick={() => switchTab('connectors')}
          >
            <span>Extensions</span>
            <span className="rc-nav-badge">{connectedTools.length}</span>
          </button>
          <button
            type="button"
            className={`rc-nav-btn ${activeTab === 'loops' ? 'is-active' : ''}`}
            onClick={() => switchTab('loops')}
          >
            <span>Commitments</span>
            {loops.length > 0 && <span className="rc-nav-badge">{loops.length}</span>}
          </button>
          <button
            type="button"
            className={`rc-nav-btn ${activeTab === 'apps' ? 'is-active' : ''}`}
            onClick={() => switchTab('apps')}
          >
            <span>Mini-Apps</span>
          </button>

          <div className="rc-nav-category">Platform & Ops</div>
          <button
            type="button"
            className={`rc-nav-btn ${activeTab === 'billing' ? 'is-active' : ''}`}
            onClick={() => switchTab('billing')}
          >
            <span>Billing & Plans</span>
          </button>
          <button
            type="button"
            className={`rc-nav-btn ${activeTab === 'usage' ? 'is-active' : ''}`}
            onClick={() => switchTab('usage')}
          >
            <span>Usage & Limits</span>
          </button>
          <button
            type="button"
            className={`rc-nav-btn ${activeTab === 'api' ? 'is-active' : ''}`}
            onClick={() => switchTab('api')}
          >
            <span>API & Webhooks</span>
          </button>

          <div className="rc-nav-category">System</div>
          <button
            type="button"
            className={`rc-nav-btn ${activeTab === 'settings' ? 'is-active' : ''}`}
            onClick={() => switchTab('settings')}
          >
            <span>Settings</span>
          </button>
        </nav>

        {/* User Footer */}
        <div className="rc-sidebar-footer">
          <div className="rc-user-info">
            <p className="rc-user-info__name">{session?.name || session?.email || 'User'}</p>
            <p className="rc-user-info__phone">{phone || '+1 (415) 595-1440'}</p>
          </div>
          <button type="button" className="rc-signout-btn" onClick={handleLogout}>
            Exit
          </button>
        </div>
      </aside>

      {/* Main Workspace Area */}
      <main className="rc-main">
        {/* Top Header */}
        <header className="rc-header">
          <div className="rc-header__breadcrumbs">
            <span>HireAlpha</span>
            <span className="rc-crumb-sep">/</span>
            <span>{agent.name}</span>
            <span className="rc-crumb-sep">/</span>
            <span className="rc-crumb-active">{tabLabels[activeTab]}</span>
          </div>

          <div className="rc-header__actions">
            <div className="rc-status-pill">
              <span className="rc-status-dot" />
              <span>(415) 595-1440</span>
            </div>
            <a className="rc-btn-sm rc-btn-sm--primary" href={ALPHA_SMS}>
              <span>Text iMessage</span>
              <span className="keycap" style={{ background: 'rgba(0,0,0,0.2)', color: '#fff' }}>⌘T</span>
            </a>
          </div>
        </header>

        {/* OVERVIEW & ACTIVITY (Master-Detail Mission Control) */}
        {activeTab === 'overview' || activeTab === 'activity' ? (
          <div className="rc-workspace-grid">
            {/* Master Activity Table */}
            <section className="rc-master-pane">
              <div className="rc-pane-header">
                <span className="rc-pane-title">Autonomous Actions & Trace Log</span>
                <span className="rc-pane-meta">{combinedFeed.length} Events</span>
              </div>

              <div className="rc-activity-list">
                {combinedFeed.length === 0 ? (
                  <div style={{ padding: '48px 24px', textAlign: 'center', color: 'var(--rc-fg-subtle)' }}>
                    <p style={{ fontWeight: 500, color: '#fff', marginBottom: '6px' }}>No autonomous actions logged yet</p>
                    <p style={{ fontSize: '12px' }}>Text Alpha on iMessage or connect a tool to begin logging autonomous actions.</p>
                  </div>
                ) : (
                  combinedFeed.map((event) => {
                    const isSelected = selectedEvent?.id === event.id
                    return (
                      <div
                        key={event.id}
                        className={`rc-row ${isSelected ? 'is-selected' : ''}`}
                        onClick={() => setSelectedEventId(event.id)}
                      >
                        <span className="rc-mono-time">{event.time}</span>
                        <div>
                          <span className={`rc-tag rc-tag--${event.badge}`}>
                            {event.badge}
                          </span>
                        </div>
                        <div className="rc-row-text">{event.content}</div>
                        <div className="rc-row-tool">{event.tool || '--'}</div>
                      </div>
                    )
                  })
                )}
              </div>
            </section>

            {/* Detail Inspector Drawer */}
            <aside className="rc-detail-pane">
              <div className="rc-pane-header">
                <span className="rc-pane-title">Action Inspector</span>
                <span className="rc-pane-meta">Metadata</span>
              </div>

              {selectedEvent ? (
                <div className="rc-inspector">
                  <div className="rc-inspector__header">
                    <div>
                      <h4 className="rc-inspector__title">
                        {selectedEvent.tool ? `Action: ${selectedEvent.tool}` : 'Execution Event'}
                      </h4>
                      <p className="rc-inspector__subtitle">ID: {selectedEvent.id.slice(0, 8)}</p>
                    </div>
                    <span className={`rc-tag rc-tag--${selectedEvent.badge}`}>
                      {selectedEvent.status || 'completed'}
                    </span>
                  </div>

                  <div className="rc-meta-grid">
                    <div className="rc-meta-box">
                      <p className="rc-meta-box__lbl">Timestamp</p>
                      <p className="rc-meta-box__val">{selectedEvent.time}</p>
                    </div>
                    <div className="rc-meta-box">
                      <p className="rc-meta-box__lbl">Integration</p>
                      <p className="rc-meta-box__val">{selectedEvent.tool || 'Autonomous'}</p>
                    </div>
                  </div>

                  <div className="rc-inspector-section">
                    <span className="rc-inspector-label">Action Summary</span>
                    <div className="rc-code-block">{selectedEvent.content}</div>
                  </div>

                  {selectedEvent.rawTrace && (
                    <div className="rc-inspector-section">
                      <span className="rc-inspector-label">Raw Trace Record</span>
                      <pre className="rc-code-block">{selectedEvent.rawTrace}</pre>
                    </div>
                  )}

                  <div style={{ marginTop: 'auto' }}>
                    <a
                      className="rc-btn-sm rc-btn-sm--primary"
                      style={{ width: '100%', justifyContent: 'center' }}
                      href={ALPHA_SMS}
                    >
                      Follow up on iMessage
                    </a>
                  </div>
                </div>
              ) : (
                <div style={{ padding: '32px', textAlign: 'center', color: 'var(--rc-fg-subtle)' }}>
                  Select an action to inspect its execution receipt and metadata.
                </div>
              )}
            </aside>
          </div>
        ) : activeTab === 'billing' ? (
          /* BILLING & SUBSCRIPTION TAB */
          <div style={{ flex: 1, overflowY: 'auto', padding: '24px', maxWidth: '1000px', margin: '0 auto', width: '100%' }}>
            <div className="rc-card-panel">
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <div>
                  <h3 className="rc-card-panel__title">Subscription & Tier</h3>
                  <p className="rc-card-panel__desc">Managed directly through Stripe Billing</p>
                </div>
                <span className="rc-tag rc-tag--connected">ACTIVE (TRIAL)</span>
              </div>
              <div className="rc-meta-grid" style={{ marginTop: '12px' }}>
                <div className="rc-meta-box">
                  <p className="rc-meta-box__lbl">Active Hire</p>
                  <p className="rc-meta-box__val">{agent.name}</p>
                </div>
                <div className="rc-meta-box">
                  <p className="rc-meta-box__lbl">Trial Status</p>
                  <p className="rc-meta-box__val">7-Day Free Trial</p>
                </div>
              </div>
            </div>

            <h3 style={{ fontSize: '13px', fontWeight: 600, color: '#fff', margin: '20px 0 8px' }}>Official Platform Plans</h3>
            <div className="rc-billing-grid">
              {TIERS.map((tier) => (
                <div key={tier.id} className={`rc-plan-card ${tier.id === 'single' ? 'is-active-tier' : ''}`}>
                  <div>
                    <div className="rc-plan-card__header">
                      <p className="rc-plan-card__title">{tier.name}</p>
                      {tier.badge && <span className="rc-tag rc-tag--inbound">{tier.badge}</span>}
                    </div>
                    <p className="rc-plan-card__price">
                      {tier.price === 0 ? '$0' : `$${tier.price}`}
                      <span> / {tier.per}</span>
                    </p>
                    <p style={{ fontSize: '12px', color: 'var(--rc-fg-muted)', minHeight: '36px' }}>{tier.blurb}</p>
                  </div>
                  <button
                    type="button"
                    className={`rc-btn-sm ${tier.id === 'single' ? 'rc-btn-sm--primary' : ''}`}
                    style={{ width: '100%', justifyContent: 'center' }}
                    disabled={billingLoading}
                    onClick={() => handleStripeCheckout(tier.id)}
                  >
                    {tier.cta}
                  </button>
                </div>
              ))}
            </div>
          </div>
        ) : activeTab === 'usage' ? (
          /* USAGE & METRICS TAB (Real Account Data) */
          <div style={{ flex: 1, overflowY: 'auto', padding: '24px', maxWidth: '800px', margin: '0 auto', width: '100%' }}>
            <div className="rc-card-panel">
              <h3 className="rc-card-panel__title">Live Account Activity</h3>
              <p className="rc-card-panel__desc">Real-time counts recorded for {email || 'your account'}.</p>
              <div className="rc-meta-grid">
                <div className="rc-meta-box">
                  <p className="rc-meta-box__lbl">Recorded Actions</p>
                  <p className="rc-meta-box__val">{actions.length} receipts</p>
                </div>
                <div className="rc-meta-box">
                  <p className="rc-meta-box__lbl">Active Integrations</p>
                  <p className="rc-meta-box__val">{connectedTools.length} connected</p>
                </div>
                <div className="rc-meta-box">
                  <p className="rc-meta-box__lbl">Open Commitments</p>
                  <p className="rc-meta-box__val">{loops.length} loops</p>
                </div>
                <div className="rc-meta-box">
                  <p className="rc-meta-box__lbl">Logged Decisions</p>
                  <p className="rc-meta-box__val">{decisions.length} decisions</p>
                </div>
              </div>
            </div>

            <div className="rc-card-panel">
              <h3 className="rc-card-panel__title">Line Telemetry</h3>
              <p className="rc-card-panel__desc">Direct iMessage & SMS routing details.</p>
              <div className="rc-meta-grid">
                <div className="rc-meta-box">
                  <p className="rc-meta-box__lbl">Hire Line Number</p>
                  <p className="rc-meta-box__val">+1 (415) 595-1440</p>
                </div>
                <div className="rc-meta-box">
                  <p className="rc-meta-box__lbl">Bound User Phone</p>
                  <p className="rc-meta-box__val">{phone || 'Not connected'}</p>
                </div>
              </div>
            </div>
          </div>
        ) : activeTab === 'api' ? (
          /* API & WEBHOOKS TAB */
          <div style={{ flex: 1, overflowY: 'auto', padding: '24px', maxWidth: '800px', margin: '0 auto', width: '100%' }}>
            <div className="rc-card-panel">
              <h3 className="rc-card-panel__title">Platform API Key</h3>
              <p className="rc-card-panel__desc">Used to trigger programmatic turns and ingest background signals.</p>
              <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
                <input
                  type="password"
                  readOnly
                  value="ha_live_98a7fbc1209e44519bcfa"
                  className="rc-code-block"
                  style={{ flex: 1, padding: '6px 10px', outline: 'none' }}
                />
                <button
                  type="button"
                  className="rc-btn-sm"
                  onClick={() => {
                    navigator.clipboard?.writeText('ha_live_98a7fbc1209e44519bcfa')
                    setApiKeyCopied(true)
                    setTimeout(() => setApiKeyCopied(false), 2000)
                  }}
                >
                  {apiKeyCopied ? 'Copied!' : 'Copy Key'}
                </button>
              </div>
            </div>

            <div className="rc-card-panel">
              <h3 className="rc-card-panel__title">Inbound Event Webhook</h3>
              <p className="rc-card-panel__desc">Send events from GitHub, Linear, Google Pub/Sub, or custom scripts to trigger immediate proactive judgment.</p>
              <div className="rc-code-block" style={{ marginBottom: '12px' }}>
                POST https://hirealpha.chat/api/internal/events/webhook
              </div>
              <p className="rc-inspector-label" style={{ marginBottom: '6px' }}>Example Ingestion Payload</p>
              <pre className="rc-code-block">
{`curl -X POST https://hirealpha.chat/api/internal/events/webhook \\
  -H "Authorization: Bearer ha_live_98a7fbc1209e44519bcfa" \\
  -H "Content-Type: application/json" \\
  -d '{
    "userId": "usr_sashank",
    "eventType": "meeting_ended",
    "data": { "title": "Catchup with Sarah", "durationMin": 30 }
  }'`}
              </pre>
            </div>
          </div>
        ) : activeTab === 'connectors' ? (
          /* CONNECTORS GRID */
          <div style={{ flex: 1, overflowY: 'auto' }}>
            <div className="rc-pane-header">
              <span className="rc-pane-title">Extensions Registry</span>
              <span className="rc-pane-meta">{CONNECTOR_CATALOG.length} Integrations</span>
            </div>
            <div className="rc-extensions-grid">
              {CONNECTOR_CATALOG.map((c) => {
                const isConn = connectedTools.includes(c.id) || c.noAuth
                return (
                  <div key={c.id} className="rc-ext-tile">
                    <div>
                      <div className="rc-ext-tile__head">
                        <div className="rc-ext-tile__name">
                          <ConnectorLogo id={c.id} size={18} />
                          <span>{c.name}</span>
                        </div>
                        <span className={`rc-tag rc-tag--${isConn ? 'connected' : 'disconnected'}`}>
                          {isConn ? 'active' : 'offline'}
                        </span>
                      </div>
                      <p className="rc-ext-tile__blurb">{c.blurb}</p>
                    </div>
                    <div>
                      {c.noAuth ? (
                        <span className="rc-pane-meta">System Native</span>
                      ) : (
                        <button
                          type="button"
                          className="rc-btn-sm"
                          style={{ width: '100%', justifyContent: 'center' }}
                          onClick={() => switchTab('settings')}
                        >
                          {isConn ? 'Manage Token' : 'Connect'}
                        </button>
                      )}
                    </div>
                  </div>
                )
              })}
            </div>
          </div>
        ) : activeTab === 'loops' ? (
          /* LOOPS & COMMITMENTS */
          <div style={{ flex: 1, overflowY: 'auto', padding: '16px', display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '16px' }}>
            <div style={{ background: 'var(--rc-surface)', border: '1px solid var(--rc-border)', borderRadius: 'var(--rc-radius)' }}>
              <div className="rc-pane-header">
                <span className="rc-pane-title">Open Commitments</span>
                <span className="rc-pane-meta">{loops.length} Tasks</span>
              </div>
              <div style={{ padding: '8px' }}>
                {loops.length === 0 ? (
                  <p style={{ textAlign: 'center', color: 'var(--rc-fg-subtle)', padding: '24px' }}>No active loops.</p>
                ) : (
                  loops.map((l) => (
                    <div
                      key={l.id}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: '10px',
                        padding: '8px 10px',
                        borderBottom: '1px solid var(--rc-border-subtle)',
                      }}
                    >
                      <input
                        type="checkbox"
                        checked={l.status === 'done'}
                        onChange={async () => {
                          await apiPatchLoop({ email, id: l.id, status: l.status === 'open' ? 'done' : 'open' })
                          setLoops((prev) =>
                            prev.map((x) => (x.id === l.id ? { ...x, status: x.status === 'open' ? 'done' : 'open' } : x)),
                          )
                        }}
                      />
                      <span style={{ flex: 1, color: l.status === 'done' ? 'var(--rc-fg-subtle)' : '#fff', fontSize: '12.5px' }}>
                        {l.title}
                      </span>
                      <span className="rc-mono-time">{l.dueAt ? new Date(l.dueAt).toLocaleDateString() : '--'}</span>
                    </div>
                  ))
                )}
              </div>
            </div>

            <div style={{ background: 'var(--rc-surface)', border: '1px solid var(--rc-border)', borderRadius: 'var(--rc-radius)' }}>
              <div className="rc-pane-header">
                <span className="rc-pane-title">Decision Ledger</span>
                <span className="rc-pane-meta">{decisions.length} Decisions</span>
              </div>
              <div style={{ padding: '8px' }}>
                {decisions.length === 0 ? (
                  <p style={{ textAlign: 'center', color: 'var(--rc-fg-subtle)', padding: '24px' }}>No decisions logged.</p>
                ) : (
                  decisions.map((d) => (
                    <div
                      key={d.id}
                      style={{
                        padding: '8px 10px',
                        borderBottom: '1px solid var(--rc-border-subtle)',
                      }}
                    >
                      <p style={{ margin: '0 0 2px', fontWeight: 500, color: '#fff', fontSize: '12.5px' }}>{d.decision}</p>
                      <p style={{ margin: 0, color: 'var(--rc-fg-muted)', fontSize: '11px' }}>{d.reason || 'No rationale'}</p>
                    </div>
                  ))
                )}
              </div>
            </div>
          </div>
        ) : activeTab === 'apps' ? (
          /* MINI APPS */
          <div style={{ flex: 1, overflowY: 'auto', padding: '16px' }}>
            <div className="rc-pane-header" style={{ marginBottom: '12px' }}>
              <span className="rc-pane-title">Mini-App Catalog</span>
              <span className="rc-pane-meta">Live Extensions</span>
            </div>
            <div className="rc-extensions-grid">
              {[
                { kind: 'digest', title: 'Daily Brief', desc: 'Morning & evening briefings with calendar summary.' },
                { kind: 'networking_crm', title: 'People Graph', desc: 'Contact interaction cadences and relationship notes.' },
                { kind: 'spending_snapshot', title: 'Spending Ledger', desc: 'Weekly burn pacing and subscription guard.' },
                { kind: 'sleep_tracker', title: 'Sleep & Recovery', desc: 'Sleep duration logging and recovery trends.' },
                { kind: 'open_loops', title: 'Open Loops', desc: 'Central commitment tracker for user promises.' },
                { kind: 'workout_log', title: 'Training Log', desc: 'Workout consistency and training logs.' },
              ].map((item) => (
                <Link
                  key={item.kind}
                  to={`/app/mini/${activePersona}/${item.kind}`}
                  className="rc-ext-tile"
                  style={{ textDecoration: 'none' }}
                >
                  <div className="rc-ext-tile__head">
                    <span style={{ fontWeight: 600, color: '#fff' }}>{item.title}</span>
                    <span className="rc-mono-time">Launch &rarr;</span>
                  </div>
                  <p className="rc-ext-tile__blurb">{item.desc}</p>
                </Link>
              ))}
            </div>
          </div>
        ) : (
          /* SETTINGS */
          <div style={{ flex: 1, overflowY: 'auto', padding: '24px' }}>
            <div style={{ maxWidth: '800px', margin: '0 auto' }}>
              <SettingsSheet />
            </div>
          </div>
        )}

        {/* Bottom Status Bar */}
        <footer className="rc-statusbar">
          <div className="rc-statusbar__left">
            <span>HireAlpha Mission Control</span>
            <span>&bull;</span>
            <span style={{ color: 'var(--rc-emerald)' }}>Autonomous Engine Online</span>
          </div>

          <div className="rc-statusbar__shortcuts">
            <span><span className="keycap">⌘T</span> iMessage</span>
          </div>
        </footer>
      </main>
    </div>
  )
}
