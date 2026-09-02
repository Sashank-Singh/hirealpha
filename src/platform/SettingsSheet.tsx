import { useEffect, useState } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import { CONNECTOR_CATALOG, type ConnectorId } from './connectors'
import { ConnectorLogo } from './ConnectorLogo'
import {
  apiConnectUrl,
  apiConnectorStatus,
  apiDeleteLocation,
  apiDisconnect,
  apiLocations,
  apiSaveLocation,
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

function timeAgo(iso: string): string {
  const minutes = Math.round((Date.now() - new Date(iso).getTime()) / 60000)
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  return new Date(iso).toLocaleDateString()
}

/* ---- Local types ---- */

type LocationKind = 'current' | 'home' | 'work'
type KillState = { armed?: boolean; error?: string }
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

  /* Controls (from KillSwitch + LoopsPanel) */
  const [armed, setArmed] = useState<boolean | null>(null)
  const [killLoaded, setKillLoaded] = useState(false)
  const [killConfirming, setKillConfirming] = useState(false)
  const [killBusy, setKillBusy] = useState(false)
  const [killError, setKillError] = useState('')
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
      .catch(() => setReady({ google: false, composio: false }))
  }, [])

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

  /* Kill switch state (same GET as marketing/KillSwitch). */
  useEffect(() => {
    if (!e164) return
    let live = true
    setKillLoaded(false)
    fetch(`/api/kill-switch?phone=${encodeURIComponent(e164)}`)
      .then((res) => (res.ok ? (res.json() as Promise<KillState>) : Promise.reject(new Error(String(res.status)))))
      .then((data) => {
        if (!live) return
        setArmed(!!data.armed)
        setKillLoaded(true)
      })
      .catch(() => {
        if (live) setKillLoaded(true)
      })
    return () => {
      live = false
    }
  }, [e164])

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
      <div className="ws-page">
        <div className="ws-scroll">
          <header className="ws-header">
            <div className="ws-header__back" />
            <p className="ws-header__title">Alpha</p>
            <Link to="/app/login" className="ws-header__avatar" style={{ textDecoration: 'none', fontSize: 12 }} aria-label="Sign in">
              In
            </Link>
          </header>
          <div className="mini__body">
            <p className="mini__empty" style={{ margin: '48px 24px', color: '#666' }}>Sign in to see your account, tools, and controls.</p>
          </div>
        </div>
      </div>
    )
  }

  const connectors = CONNECTOR_CATALOG
  const connected = connectedIds()
  const connectedCount = connectors.filter((c) => connected.includes(c.id)).length
  const targetConnector = params.get('connect')

  const latest = (kind: LocationKind) => locations.find((l) => l.kind === kind) ?? null
  const current = latest('current')
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
  function persistLocation(lat: number, lng: number, accuracy: number | null, kind: LocationKind, label: string) {
    const email = getSession()?.email
    if (!email) return
    setLocBusy(true)
    setLocError('')
    setLocNotice('')
    void (async () => {
      try {
        const next = await apiSaveLocation({ email, kind, latitude: lat, longitude: lng, accuracy_m: accuracy, label, source: 'gps' })
        setLocations(next)
        setLocNotice(kind === 'current' ? 'Location saved.' : `${label} saved. Nearby searches will use it.`)
      } catch (err) {
        setLocError(err instanceof Error ? err.message : 'Could not save location')
      } finally {
        setLocBusy(false)
      }
    })()
  }

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

  async function captureCurrent() {
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
      const label = place || 'My current location'
      const email = getSession()?.email
      if (!email) return
      const next = await apiSaveLocation({ email, kind: 'current', latitude, longitude, accuracy_m: accuracy, label, source: 'gps' })
      setLocations(next)
      setLocNotice(`Saved ${label}.`)
    } catch {
      setLocError('Location permission denied or unavailable. You can still enter a city or address manually.')
    } finally {
      setCapturing(false)
    }
  }

  function saveCurrentAs(kind: 'home' | 'work') {
    const cur = latest('current')
    if (!cur) return
    const label = prompt(kind === 'home' ? 'Label for Home (e.g. Home in SoMa):' : 'Label for Work (e.g. Work in FiDi):', kind === 'home' ? 'Home' : 'Work')?.trim()
    if (!label) return
    persistLocation(cur.latitude, cur.longitude, cur.accuracy_m, kind, label)
  }

  /* ---- Kill switch: same POST as marketing/KillSwitch. ---- */
  async function stopEverything() {
    if (!e164) return
    setKillBusy(true)
    setKillError('')
    try {
      const res = await fetch('/api/kill-switch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phone: e164 }),
      })
      const data = (await res.json().catch(() => ({}))) as KillState
      if (!res.ok) {
        setKillError(data.error || 'Could not stop anything. Try again.')
      } else {
        setArmed(!!data.armed)
        setKillConfirming(false)
      }
    } catch {
      setKillError('Could not reach the server. Try again.')
    } finally {
      setKillBusy(false)
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

  return (
    <div className="ws-page">
      <div className="ws-scroll">
        {/* ── Instinct-style Workspace header ── */}
        <header className="ws-header">
          <a className="ws-header__back" href="/" aria-label="Home">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden="true">
              <path d="M15 6l-6 6 6 6" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </a>
          <p className="ws-header__title">Alpha</p>
          <div className="ws-header__avatar" aria-label={session.name || session.email}>
            {(session.name || session.email || 'A')[0].toUpperCase()}
          </div>
        </header>

        <div className="mini__body">
          {/* ── Contact section (iMessage number) ── */}
          {session.phone && (
            <section className="mini__section">
              <p className="ws-section-label">Contact <span className="ws-info-icon">ⓘ</span></p>
              <a
                href={`sms:+14155951440`}
                className="ws-contact-btn"
                aria-label="Open iMessage with Alpha"
              >
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden>
                  <rect x="2" y="4" width="20" height="16" rx="5" fill="#22c55e" />
                  <circle cx="8" cy="12" r="1.5" fill="#fff" />
                  <circle cx="12" cy="12" r="1.5" fill="#fff" />
                  <circle cx="16" cy="12" r="1.5" fill="#fff" />
                </svg>
                Messages
              </a>
            </section>
          )}

          {/* ── Account ── */}
          <section className="mini__section">
            <p className="ws-section-label">Account</p>
            <dl className="set-account">
              <div className="set-account-row">
                <dt>Name</dt>
                <dd>{session.name || 'Not set yet'}</dd>
              </div>
              <div className="set-account-row">
                <dt>Email</dt>
                <dd>{session.email}</dd>
              </div>
              <div className="set-account-row">
                <dt>Phone</dt>
                <dd>{session.phone || 'Not set yet'}</dd>
              </div>
            </dl>
          </section>

          {/* 2. CONNECTORS */}
          <section className="mini__section">
            <div className="ws-section-row">
              <p className="ws-section-label">Tools</p>
              <span className="ws-section-count">{connectedCount}/{connectors.length} connected</span>
            </div>
            <p className="mini__blurb" style={{ marginBottom: 12 }}>Connect once — Alpha can reach them from any message.</p>
            {ready && !ready.composio && !ready.google && (
              <p className="set-err">
                Connect is not live yet. Add COMPOSIO_API_KEY on HireAlpha-Web, then tap Connect again.
              </p>
            )}
            {connectError && <p className="set-err">{connectError}</p>}
            <ul className="set-conn">
              {connectors.map((c) => {
                const on = connected.includes(c.id)
                const isTarget = targetConnector === c.id
                return (
                  <li
                    key={c.id}
                    id={`connector-${c.id}`}
                    className={`${on ? 'set-conn--on' : ''} ${isTarget ? 'set-conn--highlight' : ''}`.trim()}
                  >
                    <ConnectorLogo id={c.id} size={26} />
                    <div className="set-conn-text">
                      <span className="set-conn-name">{c.name}</span>
                      <span className="set-conn-blurb">{c.blurb}</span>
                    </div>
                    {c.noAuth ? (
                      <span className="set-chip">On</span>
                    ) : on ? (
                      <div className="set-conn-actions">
                        <span className="set-chip">Connected</span>
                        <button
                          type="button"
                          className="set-btn set-btn--ghost"
                          disabled={disconnecting === c.id}
                          onClick={() => void disconnect(c.id)}
                          aria-label={`Disconnect ${c.name}`}
                        >
                          {disconnecting === c.id ? 'Disconnecting…' : 'Disconnect'}
                        </button>
                      </div>
                    ) : (
                      <button
                        type="button"
                        className="set-btn"
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

          {/* 3. LOCATION */}
          <section className="mini__section">
            <h2>Location</h2>
            <p className="mini__blurb">
              Alpha uses this for nearby places, weather, and plans. You control it from here.
            </p>
            {locError && <p className="set-err">{locError}</p>}
            {locNotice && <p className="set-note">{locNotice}</p>}
            <div className="set-loc">
              {(
                [
                  {
                    kind: 'current' as LocationKind,
                    title: 'Current location',
                    saved: current,
                    sub: current
                      ? `${current.label}${current.accuracy_m ? ` (${Math.round(current.accuracy_m)}m)` : ''} · ${timeAgo(current.updated_at)}`
                      : 'Not set. Nearby features stay blocked until it is set.',
                  },
                  {
                    kind: 'home' as LocationKind,
                    title: 'Home',
                    saved: home,
                    sub: home ? `${home.label} · ${timeAgo(home.updated_at)}` : 'Not set.',
                  },
                  {
                    kind: 'work' as LocationKind,
                    title: 'Work',
                    saved: work,
                    sub: work ? `${work.label} · ${timeAgo(work.updated_at)}` : 'Not set.',
                  },
                ]
              ).map((row) => (
                <div key={row.kind} className={`set-loc-row${openKind === row.kind ? ' is-open' : ''}`}>
                  <button type="button" className="set-loc-head" onClick={() => toggleKind(row.kind)}>
                    <span className="set-loc-head-text">
                      <span className="set-loc-title">{row.title}</span>
                      <span className="set-loc-sub">{row.sub}</span>
                    </span>
                    <svg
                      className="set-loc-chev"
                      width="16"
                      height="16"
                      viewBox="0 0 24 24"
                      fill="none"
                      aria-hidden="true"
                    >
                      <path d="M9 6l6 6-6 6" stroke="currentColor" strokeWidth="2.25" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                  </button>
                  {openKind === row.kind && (
                    <div className="set-loc-body">
                      {row.kind === 'current' && (
                        <>
                          <p className="set-note">
                            Exact location only when you allow it. Raw coordinates never reach Alpha&apos;s chat —
                            the label is all the bot sees.
                          </p>
                          <div className="set-actions">
                            <button
                              type="button"
                              className="set-btn"
                              disabled={locBusy || capturing}
                              onClick={() => void captureCurrent()}
                            >
                              {capturing ? 'Locating…' : 'Allow current location'}
                            </button>
                            {current && (
                              <button type="button" className="set-btn set-btn--ghost" onClick={() => removeLocation('current')}>
                                Remove current
                              </button>
                            )}
                          </div>
                        </>
                      )}
                      {row.kind !== 'current' && (
                        <div className="set-actions">
                          <button
                            type="button"
                            className="set-btn"
                            disabled={!current || locBusy}
                            onClick={() => saveCurrentAs(row.kind === 'home' ? 'home' : 'work')}
                          >
                            Save current as {row.title}
                          </button>
                          {row.saved && (
                            <button type="button" className="set-link" onClick={() => removeLocation(row.kind)}>
                              Delete {row.title}
                            </button>
                          )}
                        </div>
                      )}
                      <label className="mini__field">
                        <span>Or enter a place, city, or address</span>
                        <input
                          className="set-input"
                          type="text"
                          placeholder="SoMa, San Francisco"
                          value={manual}
                          onChange={(e) => setManual(e.target.value)}
                        />
                      </label>
                      <div className="set-actions">
                        <button
                          type="button"
                          className="set-btn set-btn--ghost"
                          disabled={locBusy || !manual.trim()}
                          onClick={() => manualSave(row.kind)}
                        >
                          Save as {row.title}
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              ))}
            </div>
          </section>

          {/* 4. CONTROLS */}
          <section className="mini__section">
            <h2>Controls</h2>
            <div className="set-kill">
              <p className="set-kill-state" role="status">
                <span
                  className={`set-dot${armed ? ' set-dot--down' : killLoaded ? '' : ' set-dot--unknown'}`}
                  aria-hidden
                />
                {!e164
                  ? 'Add the phone you text from to see the switch.'
                  : armed
                    ? 'Everything is stopped. Text your hire to turn it back on.'
                    : killLoaded
                      ? 'Everything is running.'
                      : 'Checking the switch…'}
              </p>
              {!armed && e164 && (
                <>
                  {!killConfirming ? (
                    <button type="button" className="set-btn set-btn--danger" onClick={() => setKillConfirming(true)}>
                      Stop everything
                    </button>
                  ) : (
                    <div className="set-confirm">
                      <p>All hires go quiet until you turn them back on. Stop?</p>
                      <div className="set-actions">
                        <button type="button" className="set-btn set-btn--danger" onClick={() => void stopEverything()} disabled={killBusy}>
                          {killBusy ? 'Stopping…' : 'Yes, stop'}
                        </button>
                        <button type="button" className="set-btn set-btn--ghost" onClick={() => setKillConfirming(false)}>
                          Keep going
                        </button>
                      </div>
                    </div>
                  )}
                </>
              )}
              {killError && (
                <p className="set-err" role="alert">
                  {killError}
                </p>
              )}
            </div>

            <p className="mini__blurb" style={{ marginTop: 12 }}>
              Task loops — what your hires watch on a schedule.
            </p>
            {!e164 && <p className="mini__empty">Add the phone you text from to see your loops.</p>}
            {e164 && !loopsLoaded && <p className="mini__empty">Checking your loops…</p>}
            {e164 && loopsLoaded && loopsError && (
              <p className="set-err" role="alert">
                {loopsError}
              </p>
            )}
            {e164 && loopsLoaded && !loopsError && (loops?.length ?? 0) === 0 && (
              <p className="mini__empty">No loops running. Ask a hire to watch something for you.</p>
            )}
            {e164 && loopsLoaded && !loopsError && (loops?.length ?? 0) > 0 && (
              <ul className="set-loop">
                {loops!.map((loop) => (
                  <li key={loop.id}>
                    <div className="set-loop-text">
                      <span className="set-loop-title">{loop.title}</span>
                      <span className="set-loop-sub">
                        {loop.kind}
                        {loop.status === 'paused' ? ' · paused' : ''}
                        {loop.status !== 'paused' && loop.next_run ? ` · ${nextRunLabel(loop.next_run, Date.now())}` : ''}
                      </span>
                    </div>
                    <button
                      type="button"
                      className="set-btn set-btn--ghost"
                      disabled={busyLoopId === loop.id}
                      onClick={() => void toggleLoop(loop)}
                    >
                      {loop.status === 'paused' ? 'Resume' : 'Pause'}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </section>

          {/* ── Data privacy ── */}
          <section className="mini__section">
            <p className="ws-section-label">Data privacy</p>
            <p className="mini__blurb" style={{ color: '#666', marginBottom: 12 }}>Manage data from connected services</p>
            <div className="ws-privacy-card">
              <div className="ws-privacy-card__text">
                <span className="ws-privacy-card__title">External data <span className="ws-info-icon">ⓘ</span></span>
                <span className="ws-privacy-card__sub">Manage emails and other data imported from your connected services.</span>
              </div>
              <button
                type="button"
                className="set-btn set-btn--danger"
                onClick={onSignOut}
              >
                Sign out
              </button>
            </div>
            <p className="mini__blurb" style={{ marginTop: 10, color: '#555' }}>Coworker and Cofounder are coming soon. Your number is saved for both.</p>
          </section>
        </div>
      </div>
    </div>
  )
}
