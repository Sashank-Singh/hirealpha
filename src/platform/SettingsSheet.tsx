import { useEffect, useState } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import { CONNECTOR_CATALOG, type ConnectorId } from './connectors'
import { ConnectorLogo } from './ConnectorLogo'
import {
  apiBillingManage,
  apiBillingStatus,
  apiConnectUrl,
  apiConnectorStatus,
  apiDeleteLocation,
  apiDeleteMemory,
  apiDisconnect,
  apiHireMemory,
  apiLocations,
  apiSaveLocation,
  type BillingSubscription,
  type HireMemory,
  type SavedLocation,
} from './api'
import { connectedIds, getSession, hydrateFromServer, setConnection, signOut } from './roster'
import './SettingsSheet.css'

/* ---- Helpers moved from the old pages (pure, copied verbatim) ---- */

/** The invite, kill switch, and loop APIs key on E.164. From marketing/phone.ts. */
function toE164(raw: string): string {
  const digits = raw.replace(/\D/g, '')
  if (digits.length === 10) return `+1${digits}`
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`
  if (raw.trim().startsWith('+') && digits.length >= 8) return `+${digits}`
  return ''
}

/** When a loop fires next, in words a text would use. From marketing/format.ts. */
function nextRunLabel(nextRun: string | null, now: number): string {
  if (!nextRun) return ''
  const t = new Date(nextRun).getTime()
  if (Number.isNaN(t)) return ''
  const mins = Math.round((t - now) / 60000)
  if (mins <= 0) return 'runs now'
  if (mins < 60) return `runs in ${mins}m`
  const hours = Math.round(mins / 60)
  if (hours < 24) return `runs in ${hours}h`
  return `runs in ${Math.round(hours / 24)}d`
}

/** From LocationPage. */
type NominatimRow = { display_name?: string; type?: string }

async function reversePlace(lat: number, lng: number): Promise<string> {
  const url = new URL('https://nominatim.openstreetmap.org/reverse')
  url.searchParams.set('lat', String(lat))
  url.searchParams.set('lon', String(lng))
  url.searchParams.set('format', 'jsonv2')
  const res = await fetch(url, { headers: { Accept: 'application/json' } })
  if (!res.ok) return ''
  const data = (await res.json()) as NominatimRow
  const label = (data.display_name || '').split(',').slice(0, 3).join(',')
  return label
}

/* ---- Local types ---- */

type LocationKind = 'home' | 'work'
type Loop = { id: string; kind: string; title: string; status: string; next_run: string | null }

/**
 * The one settings sheet: account, connectors, location, and controls in a
 * single scrolling page. Absorbs HireConfigPage's connector list (scoped to the
 * friend persona), LocationPage's saved places, and ControlsPage's kill switch
 * + loops panel, keeping the same endpoints and flows.
 */
export function SettingsSheet() {
  const navigate = useNavigate()
  const [params, setParams] = useSearchParams()
  const [, bump] = useState(0)
  const refresh = () => bump((n) => n + 1)

  /* Connectors (from HireConfigPage) */
  const [connectError, setConnectError] = useState('')
  const [connecting, setConnecting] = useState<ConnectorId | null>(null)
  const [disconnecting, setDisconnecting] = useState<ConnectorId | null>(null)
  const [ready, setReady] = useState<{ google: boolean; composio: boolean } | null>(null)

  /* Location (from LocationPage) */
  const [locations, setLocations] = useState<SavedLocation[]>([])
  const [locBusy, setLocBusy] = useState(false)
  const [locError, setLocError] = useState('')
  const [locNotice, setLocNotice] = useState('')
  const [capturing, setCapturing] = useState(false)
  const [manual, setManual] = useState('')
  const [openKind, setOpenKind] = useState<LocationKind | null>(null)
  const [toolFilter, setToolFilter] = useState<'all' | 'connected'>('all')
  const [copiedPhone, setCopiedPhone] = useState(false)

  /* Billing */
  const [billing, setBilling] = useState<{ active: boolean; subscriptions: BillingSubscription[] } | null>(null)
  const [manageBusy, setManageBusy] = useState(false)

  /* Memory */
  const [memories, setMemories] = useState<HireMemory[] | null>(null)
  const [memError, setMemError] = useState('')

  /* Loops (from LoopsPanel) */
  const [loops, setLoops] = useState<Loop[] | null>(null)
  const [loopsLoaded, setLoopsLoaded] = useState(false)
  const [loopsError, setLoopsError] = useState('')
  const [busyLoopId, setBusyLoopId] = useState('')

  const session = getSession()
  const e164 = toE164(session?.phone || '')

  useEffect(() => {
    void hydrateFromServer()
      .then(refresh)
      .catch(() => undefined)
    void apiConnectorStatus()
      .then(setReady)
      // A failed probe is unknown, not "unconfigured" — never tell the user the
      // server is broken because their network hiccuped.
      .catch(() => setReady(null))
  }, [])

  useEffect(() => {
    if (!session?.email) return
    void apiBillingStatus(session.email)
      .then((s) =>
        setBilling({
          active: Object.values(s.hires).some(Boolean),
          subscriptions: s.subscriptions,
        }),
      )
      .catch(() => setBilling({ active: false, subscriptions: [] }))
    void apiHireMemory(session.email, 'friend')
      .then((d) => setMemories(d.memories))
      .catch(() => setMemories([]))
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  /* After a connector OAuth round-trip lands back with ?connected=, rehydrate
   * and clear the param — same as HireConfigPage. */
  useEffect(() => {
    if (!params.get('connected')) return
    void hydrateFromServer()
      .then(refresh)
      .catch(() => undefined)
    setParams({}, { replace: true })
  }, [params, setParams])

  /* Deep link ?connect=connectorId: scroll to the connector and ring it —
   * mini apps and chat links point here today via /app/hires/friend?connect=x. */
  useEffect(() => {
    const toConnect = params.get('connect')
    if (!toConnect) return
    const el = document.getElementById(`connector-${toConnect}`)
    if (el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'center' })
    }
  }, [params])

  /* Loops (same GET as marketing/LoopsPanel). */
  async function loadLoops(value: string) {
    if (!value) return
    setLoopsLoaded(false)
    setLoopsError('')
    try {
      const res = await fetch(`/api/loops?phone=${encodeURIComponent(value)}`)
      const data = (await res.json().catch(() => ({}))) as { loops?: Loop[] }
      if (!res.ok) throw new Error(String(res.status))
      setLoops(Array.isArray(data.loops) ? data.loops : [])
    } catch {
      setLoops(null)
      setLoopsError('Could not load loops. Try again in a minute.')
    } finally {
      setLoopsLoaded(true)
    }
  }
  useEffect(() => {
    if (!e164) return
    void loadLoops(e164)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [e164])

  /* Locations (same GET as LocationPage). */
  useEffect(() => {
    const email = getSession()?.email
    if (!email) return
    void apiLocations(email)
      .then((data) => setLocations(data.locations))
      .catch((err) => setLocError(err instanceof Error ? err.message : 'Could not load locations'))
  }, [])

  if (!session?.email) {
    return (
      <div className="ha-page">
        <div className="ha-scroll">
          <header className="ha-header">
            <a className="ha-header__back" href="/" aria-label="Home">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                <path d="M15 6l-6 6 6 6" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </a>
            <div className="ha-header__brand">
              <img src="/HireAlpha_logo.png" alt="HireAlpha" className="ha-header__logo" />
              <span className="ha-header__title">Alpha</span>
            </div>
            <Link to="/app/login" className="ha-header__signin" aria-label="Sign in">
              Sign in
            </Link>
          </header>
          <div className="ha-body">
            <div className="ha-card ha-empty-card">
              <div className="ha-empty-logo-wrap">
                <img src="/HireAlpha_logo.png" alt="HireAlpha" className="ha-empty-logo" />
              </div>
              <h2 className="ha-empty-title">Welcome to Alpha</h2>
              <p className="ha-empty-sub">Sign in to manage your connected tools, location preferences, and personal assistant settings.</p>
              <Link to="/app/login" className="ha-btn ha-btn--primary">
                Sign in to continue →
              </Link>
            </div>
          </div>
        </div>
      </div>
    )
  }

  const connectors = CONNECTOR_CATALOG.filter((c) => c.id !== 'plaid')
  const connected = connectedIds()
  const connectedCount = connectors.filter((c) => connected.includes(c.id)).length
  const isPlaidConnected = connected.includes('plaid')
  const targetConnector = params.get('connect')

  /* Calendar is the flagship second row: catalog has Gmail first, so reorder
   * so Google Calendar sits right behind the lead app in the list. */
  const orderedConnectors = [...connectors].sort((a, b) => {
    if (a.id === 'calendar') return 1
    if (b.id === 'calendar') return -1
    return 0
  })

  const filteredConnectors = orderedConnectors.filter((c) => {
    if (toolFilter === 'connected') return connected.includes(c.id)
    return true
  })

  const latest = (kind: LocationKind) => locations.find((l) => l.kind === kind) ?? null
  const home = latest('home')
  const work = latest('work')

  /* ---- Connect flow: same as HireConfigPage, persona pinned to friend. ---- */
  async function connect(id: ConnectorId) {
    if (!session?.email) return
    setConnectError('')
    setConnecting(id)
    try {
      const url = await apiConnectUrl({ connector: id, email: session.email, persona: 'friend' })
      window.location.href = url
    } catch (err) {
      setConnectError(err instanceof Error ? err.message : 'Could not start connect')
      setConnecting(null)
    }
  }

  /* ---- Disconnect: tear the tool down server-side and flip the local chip.
   * A confirm dialog costs more than it saves here — the action is reversible
   * by tapping Connect again, so we just do it. ---- */
  async function disconnect(id: ConnectorId) {
    if (!session?.email) {
      setConnectError('Sign in again to manage tools.')
      return
    }
    setConnectError('')
    setDisconnecting(id)
    try {
      await apiDisconnect({
        connector: id,
        email: session.email,
        persona: 'friend',
      })
      // Flip the local chip immediately so the row repaints as "Connect";
      // the next /api/me refresh from the same session will agree.
      setConnection(id, false)
    } catch (err) {
      setConnectError(err instanceof Error ? err.message : 'Disconnect failed.')
    } finally {
      setDisconnecting(null)
    }
  }

  /* ---- Location: same endpoints and flows as LocationPage. ---- */
  function manualSave(kind: LocationKind) {
    const label = manual.trim()
    if (!label) {
      setLocError('Enter a place or label first.')
      return
    }
    setLocBusy(true)
    setLocError('')
    setLocNotice('')
    void (async () => {
      try {
        const url = new URL('https://nominatim.openstreetmap.org/search')
        url.searchParams.set('q', manual.trim())
        url.searchParams.set('format', 'jsonv2')
        url.searchParams.set('limit', '1')
        const res = await fetch(url, { headers: { Accept: 'application/json' } })
        if (!res.ok) throw new Error('Could not look up that address')
        const rows = (await res.json()) as Array<{ lat?: string; lon?: string; display_name?: string }>
        const row = rows[0]
        if (!row || !row.lat || !row.lon) throw new Error('No place found. Try a city or address.')
        const email = getSession()?.email
        if (!email) return
        const next = await apiSaveLocation({
          email,
          kind,
          latitude: Number(row.lat),
          longitude: Number(row.lon),
          accuracy_m: null,
          label: label || String(row.display_name || '').split(',').slice(0, 3).join(','),
          source: 'manual',
        })
        setLocations(next)
        setManual('')
        setLocNotice(`${label || 'Location'} saved.`)
      } catch (err) {
        setLocError(err instanceof Error ? err.message : 'Could not save location')
      } finally {
        setLocBusy(false)
      }
    })()
  }

  function removeLocation(kind: LocationKind) {
    const email = getSession()?.email
    if (!email) return
    setLocError('')
    void apiDeleteLocation(email, kind)
      .then(setLocations)
      .catch((err) => setLocError(err instanceof Error ? err.message : 'Could not delete'))
  }

  async function captureCurrent(kind: 'home' | 'work') {
    if (!('geolocation' in navigator)) {
      setLocError('This browser has no location support. Enter a city or address manually.')
      return
    }
    setCapturing(true)
    setLocError('')
    setLocNotice('')
    try {
      const pos = await new Promise<GeolocationPosition>((resolve, reject) =>
        navigator.geolocation.getCurrentPosition(resolve, reject, {
          enableHighAccuracy: true,
          timeout: 12000,
          maximumAge: 60000,
        }),
      )
      const { latitude, longitude, accuracy } = pos.coords
      const place = await reversePlace(latitude, longitude)
      const fallback = kind === 'home' ? 'My home' : 'My work'
      const label = place || fallback
      const email = getSession()?.email
      if (!email) return
      const next = await apiSaveLocation({ email, kind, latitude, longitude, accuracy_m: accuracy, label, source: 'gps' })
      setLocations(next)
      setLocNotice(`${label} saved. Nearby searches will use it.`)
    } catch {
      setLocError('Location permission denied or unavailable. You can still enter a city or address manually.')
    } finally {
      setCapturing(false)
    }
  }

  /* ---- Loops: same pause/resume POSTs as marketing/LoopsPanel. ---- */
  async function toggleLoop(loop: Loop) {
    const pause = loop.status !== 'paused'
    setBusyLoopId(loop.id)
    try {
      const res = await fetch(`/api/loops/${encodeURIComponent(loop.id)}/${pause ? 'pause' : 'resume'}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phone: e164 }),
      })
      if (!res.ok) throw new Error(String(res.status))
      await loadLoops(e164)
    } catch {
      setLoopsError('Could not change that loop. Try again.')
    } finally {
      setBusyLoopId('')
    }
  }

  function onSignOut() {
    signOut()
    navigate('/app/login')
  }

  function toggleKind(kind: LocationKind) {
    setOpenKind((k) => (k === kind ? null : kind))
  }

  async function openBilling() {
    if (!session?.email) return
    setManageBusy(true)
    try {
      const url = await apiBillingManage(session.email)
      window.location.href = url
    } catch (err) {
      setLocError(err instanceof Error ? err.message : 'Could not open billing')
    } finally {
      setManageBusy(false)
    }
  }

  async function clearMemory(key: string) {
    if (!session?.email) return
    setMemError('')
    try {
      const next = await apiDeleteMemory(session.email, 'friend', key)
      setMemories(next)
    } catch (err) {
      setMemError(err instanceof Error ? err.message : 'Could not clear that memory')
    }
  }

  const friendSub = billing?.subscriptions.find((s) => s.persona === 'friend')

  return (
    <div className="ss-page">
      <div className="ss-shell">
        <header className="ss-top">
          <a className="ss-nav-back" href="/" aria-label="Home">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <polyline points="15 18 9 12 15 6" />
            </svg>
          </a>
        </header>

        <section className="ss-contact">
          <img src="/HireAlpha_logo.png" alt="" className="ss-contact-logo" />
          <div className="ss-contact-body">
            <h1 className="ss-contact-name">Alpha</h1>
            <span className="ss-contact-role">Personal Assistant</span>
            <p className="ss-contact-phone">
              <a href="sms:+14155951440">(415) 595-1440</a>
              <button
                type="button"
                className="ss-copy"
                onClick={() => {
                  void navigator.clipboard.writeText('+14155951440')
                  setCopiedPhone(true)
                  setTimeout(() => setCopiedPhone(false), 2000)
                }}
              >
                {copiedPhone ? 'Copied' : 'Copy'}
              </button>
            </p>
          </div>
          <div className="ss-contact-actions">
            <a href="sms:+14155951440" className="ss-btn-primary">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
                <path d="M20 2H4c-1.1 0-2 .9-2 2v18l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2z" />
              </svg>
              <span>Message</span>
            </a>
            <a
              href="/api/contact/alpha.vcf"
              download="Alpha.vcf"
              className="ss-btn-ghost"
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <path d="M16 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
                <circle cx="8.5" cy="7" r="4" />
                <line x1="20" y1="8" x2="20" y2="14" />
                <line x1="23" y1="11" x2="17" y2="11" />
              </svg>
              <span>Add to Contacts</span>
            </a>
          </div>
        </section>

        {/* Plan — its own card, set apart from the list sections */}
        <section className="ss-plan">
          <div className="ss-plan-row">
            <div className="ss-body">
              {friendSub && subscriptionActiveLabel(friendSub.status) ? (
                <>
                  <span className="ss-name">Alpha the Friend</span>
                  <span className="ss-subline">
                    {friendSub.status === 'trialing' ? 'Trial' : 'Active'}
                    {friendSub.currentPeriodEnd ? ` · renews ${dateLabel(friendSub.currentPeriodEnd)}` : ''}
                  </span>
                </>
              ) : billing ? (
                <>
                  <span className="ss-name">Free</span>
                  <span className="ss-subline">No active subscription. Start a trial to text with Alpha.</span>
                </>
              ) : (
                <>
                  <span className="ss-name">Plan</span>
                  <span className="ss-subline">Checking…</span>
                </>
              )}
            </div>
            <div className="ss-actions">
              {friendSub && subscriptionActiveLabel(friendSub.status) ? (
                <button type="button" className="ss-btn" disabled={manageBusy} onClick={() => void openBilling()}>
                  {manageBusy ? 'Opening…' : 'Manage billing'}
                </button>
              ) : (
                <Link to="/app/login?plan=single" className="ss-btn">
                  Start trial
                </Link>
              )}
            </div>
          </div>
        </section>

        {/* ── Sections: one hairline-divided surface, native-settings style ── */}
        <div className="ss">
          {/* Connected Tools */}
          <section className="ss-sec">
            <header className="ss-sec-head">
              <div>
                <h2 className="ss-title">Connected Tools</h2>
                <p className="ss-sub">Services Alpha can search, check, and act on during your conversations.</p>
              </div>
            </header>

            <div className="ss-filters">
              {(['all', 'connected'] as const).map((filter) => (
                <button
                  key={filter}
                  type="button"
                  className={`ss-filter${toolFilter === filter ? ' is-active' : ''}`}
                  onClick={() => setToolFilter(filter)}
                >
                  {filter === 'all' && `All (${connectors.length})`}
                  {filter === 'connected' && `Connected (${connectedCount})`}
                </button>
              ))}
            </div>

            {ready && !ready.composio && !ready.google && (
              <p className="set-err">Connect is not configured on the server yet.</p>
            )}
            {connectError && <p className="set-err">{connectError}</p>}

            <div className="ss-list ss-list--scroll">
              {filteredConnectors.map((c) => {
                const on = connected.includes(c.id)
                const isTarget = targetConnector === c.id
                return (
                  <div
                    key={c.id}
                    id={`connector-${c.id}`}
                    className={`ss-row${isTarget ? ' is-target' : ''}`}
                  >
                    <div className="ss-cell">
                      <div className="ss-icon">
                        <ConnectorLogo id={c.id} size={22} />
                      </div>
                      <div className="ss-body">
                        <span className="ss-name">{c.name}</span>
                        <span className="ss-subline">{c.blurb}</span>
                      </div>
                      {c.noAuth ? (
                        <span className="ss-included">Included</span>
                      ) : (
                        <div className="ss-actions">
                          {on ? (
                            <button
                              type="button"
                              className="ss-btn-text ss-btn-danger"
                              disabled={disconnecting === c.id}
                              onClick={() => void disconnect(c.id)}
                            >
                              {disconnecting === c.id ? 'Disconnecting…' : 'Disconnect'}
                            </button>
                          ) : (
                            <button
                              type="button"
                              className="ss-btn"
                              disabled={connecting === c.id}
                              onClick={() => void connect(c.id)}
                            >
                              {connecting === c.id ? 'Connecting…' : 'Connect'}
                            </button>
                          )}
                        </div>
                      )}
                    </div>
                  </div>
                )
              })}
            </div>
          </section>

          {/* Bank Account (Plaid): only surfaces once a real connection exists.
           * Not provisioned end to end yet, so no affordance and no copy. */}
          {isPlaidConnected && (
          <section id="connector-plaid" className={`ss-sec${isPlaidConnected ? ' is-connected' : ''}${targetConnector === 'plaid' ? ' is-target' : ''}`}>
            <header className="ss-sec-head">
              <div>
                <h2 className="ss-title">Bank Account</h2>
                <p className="ss-sub">Read-only balance queries and spending summaries in Messages.</p>
              </div>
              {isPlaidConnected && <span className="ss-connected-badge">Connected</span>}
            </header>

            <div className="ss-list">
              <div className="ss-row">
                <div className="ss-cell">
                  <div className="ss-icon">
                    <ConnectorLogo id="plaid" size={22} />
                  </div>
                  <div className="ss-body">
                    <span className="ss-name">
                      {isPlaidConnected ? 'Primary account' : 'Link your bank'}
                    </span>
                    <span className="ss-subline">
                      {isPlaidConnected
                        ? 'Balances and spending summaries are read-only. Alpha cannot move money.'
                        : 'Alpha reads balances and spending summaries. It cannot move money or see your login.'}
                    </span>
                  </div>
                  <div className="ss-actions">
                    {isPlaidConnected ? (
                      <>
                        <Link to="/app/mini/friend/spending_snapshot" className="ss-link">
                          Spending Snapshot
                        </Link>
                        <button
                          type="button"
                          className="ss-btn-text ss-btn-danger"
                          disabled={disconnecting === 'plaid'}
                          onClick={() => void disconnect('plaid')}
                        >
                          {disconnecting === 'plaid' ? 'Disconnecting…' : 'Disconnect'}
                        </button>
                      </>
                    ) : (
                      <button
                        type="button"
                        className="ss-btn"
                        disabled={connecting === 'plaid'}
                        onClick={() => void connect('plaid')}
                      >
                        {connecting === 'plaid' ? 'Connecting…' : 'Link'}
                      </button>
                    )}
                  </div>
                </div>
              </div>
            </div>
          </section>
          )}

          {/* Places */}
          <section className="ss-sec">
            <header className="ss-sec-head">
              <div>
                <h2 className="ss-title">Places</h2>
                <p className="ss-sub">Used for weather, commute timing, and local recommendations.</p>
              </div>
            </header>

            {locError && <p className="set-err">{locError}</p>}
            {locNotice && <p className="set-note">{locNotice}</p>}

            <div className="ss-list">
              {[
                {
                  kind: 'home' as LocationKind,
                  title: 'Home',
                  saved: home,
                },
                {
                  kind: 'work' as LocationKind,
                  title: 'Work',
                  saved: work,
                },
              ].map((row) => (
                <div key={row.kind} className={`ss-row${openKind === row.kind ? ' is-open' : ''}`}>
                  <button
                    type="button"
                    className="ss-cell ss-cell-btn"
                    aria-expanded={openKind === row.kind}
                    onClick={() => toggleKind(row.kind)}
                  >
                    <div className="ss-body">
                      <span className="ss-name">{row.title}</span>
                      <span className="ss-subline">{row.saved ? row.saved.label : 'Not set yet'}</span>
                    </div>
                    <span className={`ss-chevron${openKind === row.kind ? ' is-open' : ''}`} aria-hidden="true">
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
                        <polyline points="6 9 12 15 18 9" />
                      </svg>
                    </span>
                  </button>

                  {openKind === row.kind && (
                    <div className="ss-edit">
                      <button
                        type="button"
                        className="ss-btn ss-btn-ghost"
                        disabled={capturing || locBusy}
                        onClick={() => void captureCurrent(row.kind as 'home' | 'work')}
                      >
                        {capturing ? 'Locating…' : 'Use my current location'}
                      </button>
                      <div className="ss-input-row">
                        <input
                          className="bento-input"
                          type="text"
                          placeholder="Enter street address or city"
                          value={manual}
                          onChange={(e) => setManual(e.target.value)}
                        />
                        <button
                          type="button"
                          className="ss-btn"
                          disabled={locBusy || !manual.trim()}
                          onClick={() => manualSave(row.kind)}
                        >
                          Save
                        </button>
                      </div>
                      {row.saved && (
                        <button
                          type="button"
                          className="ss-btn-text ss-btn-danger"
                          disabled={locBusy}
                          onClick={() => removeLocation(row.kind)}
                        >
                          Clear
                        </button>
                      )}
                    </div>
                  )}
                </div>
              ))}
            </div>
          </section>

          {/* Scheduled Routines */}
          <section className="ss-sec">
            <header className="ss-sec-head">
              <div>
                <h2 className="ss-title">Scheduled Routines</h2>
                <p className="ss-sub">Proactive tasks Alpha runs on a schedule in Messages.</p>
              </div>
            </header>

            {loopsError && <p className="set-err">{loopsError}</p>}
            {!e164 && <p className="ss-empty">Add your phone number to view scheduled routines.</p>}
            {e164 && !loopsLoaded && <p className="ss-empty">Checking routines…</p>}
            {e164 && loopsLoaded && (loops?.length ?? 0) === 0 && (
              <p className="ss-empty">
                No scheduled routines yet. Text Alpha in Messages to set one up, like &ldquo;brief me every morning at 8am&rdquo;.
              </p>
            )}
            {e164 && loopsLoaded && (loops?.length ?? 0) > 0 && (
              <div className="ss-list">
                {loops!.map((loop) => (
                  <div key={loop.id} className="ss-row">
                    <div className="ss-cell">
                      <div className="ss-body">
                        <span className="ss-name">{loop.title}</span>
                        <span className="ss-subline">
                          {loop.kind}
                          {loop.status === 'paused' ? ' · Paused' : ''}
                          {loop.status !== 'paused' && loop.next_run ? ` · Next run ${nextRunLabel(loop.next_run, Date.now())}` : ''}
                        </span>
                      </div>
                      <div className="ss-actions">
                        <button
                          type="button"
                          className="ss-btn-text"
                          disabled={busyLoopId === loop.id}
                          onClick={() => void toggleLoop(loop)}
                        >
                          {loop.status === 'paused' ? 'Resume' : 'Pause'}
                        </button>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </section>

          {/* Memory */}
          <section className="ss-sec">
            <header className="ss-sec-head">
              <div>
                <h2 className="ss-title">Memory</h2>
                <p className="ss-sub">What Alpha remembers about you from your conversations.</p>
              </div>
            </header>

            {memError && <p className="set-err">{memError}</p>}
            {memories === null && <p className="ss-empty">Checking memories…</p>}
            {memories !== null && memories.length === 0 && (
              <p className="ss-empty">
                Nothing saved yet. Alpha remembers the things you tell it in Messages — family, work, routines.
              </p>
            )}
            {memories !== null && memories.length > 0 && (
              <div className="ss-list">
                {memories.map((m) => (
                  <div key={m.key} className="ss-row">
                    <div className="ss-cell">
                      <div className="ss-body">
                        <span className="ss-name">{m.value}</span>
                        <span className="ss-subline">{m.key}</span>
                      </div>
                      <div className="ss-actions">
                        <button
                          type="button"
                          className="ss-btn-text ss-btn-danger"
                          onClick={() => void clearMemory(m.key)}
                        >
                          Clear
                        </button>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </section>

          {/* Account */}
          <section className="ss-sec">
            <header className="ss-sec-head">
              <div>
                <h2 className="ss-title">Account</h2>
              </div>
            </header>
            <div className="ss-list">
              <div className="ss-row">
                <div className="ss-cell">
                  <div className="ss-body">
                    <span className="ss-name">{session.name || 'Alpha User'}</span>
                    <span className="ss-subline">
                      {session.email}
                      {session.phone ? ` · ${session.phone}` : ''}
                    </span>
                  </div>
                  <div className="ss-actions">
                    <button type="button" className="ss-btn-text ss-btn-danger" onClick={onSignOut}>
                      Sign out
                    </button>
                  </div>
                </div>
              </div>
            </div>
          </section>
        </div>
      </div>
    </div>
  )
}

function subscriptionActiveLabel(status: string): boolean {
  return status === 'active' || status === 'trialing'
}

function dateLabel(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}
