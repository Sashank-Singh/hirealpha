import { useEffect, useState } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import { apiConnectorStatus, apiConnectUrl, apiLocations, apiSaveLocation, apiSignIn, type SavedLocation } from './api'
import { CONNECTOR_CATALOG, TIMEZONES } from './connectors'
import { getConnections, getSession, signIn } from './roster'
import { ProactiveControls } from './ProactiveControls'
import {
  CONNECTOR_ACCESS,
  DEFAULT_QUIET_END,
  DEFAULT_QUIET_START,
  PRIORITIES,
  PROFILE_FIELDS,
  PROOF_BY_PRIORITY,
  RESPONSE_STYLES,
  STAGE1_STEPS,
  loadOnboarding,
  saveOnboarding,
  type OnboardStep,
  type OnboardingProgress,
  type ProactiveSettings,
} from './onboarding'

type NominatimRow = { display_name?: string; type?: string; lat?: string; lon?: string }

async function reversePlace(lat: number, lng: number): Promise<string> {
  const url = new URL('https://nominatim.openstreetmap.org/reverse')
  url.searchParams.set('lat', String(lat))
  url.searchParams.set('lon', String(lng))
  url.searchParams.set('format', 'jsonv2')
  const res = await fetch(url, { headers: { Accept: 'application/json' } })
  if (!res.ok) return ''
  const data = (await res.json()) as NominatimRow
  return (data.display_name || '').split(',').slice(0, 3).join(',')
}

async function searchPlace(q: string): Promise<{ lat: number; lon: number; label: string }> {
  const url = new URL('https://nominatim.openstreetmap.org/search')
  url.searchParams.set('q', q)
  url.searchParams.set('format', 'jsonv2')
  url.searchParams.set('limit', '1')
  const res = await fetch(url, { headers: { Accept: 'application/json' } })
  if (!res.ok) throw new Error('Could not look up that place')
  const rows = (await res.json()) as Array<{ lat?: string; lon?: string; display_name?: string }>
  const row = rows[0]
  if (!row?.lat || !row.lon) throw new Error('No place found. Try a city or address.')
  return {
    lat: Number(row.lat),
    lon: Number(row.lon),
    label: (row.display_name || q).split(',').slice(0, 3).join(','),
  }
}

interface PendingPlace {
  lat: number
  lon: number
  accuracy: number | null
  label: string
}

export function OnboardingPage() {
  const navigate = useNavigate()
  const [params, setParams] = useSearchParams()
  const session = getSession()
  const [progress, setProgress] = useState<OnboardingProgress>(() => {
    const loaded = loadOnboarding()
    const jump = params.get('step')
    if (jump && STAGE1_STEPS.some((s) => s.id === jump)) {
      loaded.currentStep = jump as OnboardStep
      loaded.stage = 1
    }
    return loaded
  })
  const [locations, setLocations] = useState<SavedLocation[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [pendingPlace, setPendingPlace] = useState<PendingPlace | null>(null)
  const [manualQuery, setManualQuery] = useState('')
  const [connectAvailable, setConnectAvailable] = useState<boolean | null>(null)

  const email = session?.email || ''

  useEffect(() => {
    const step = params.get('step')
    if (step && STAGE1_STEPS.some((s) => s.id === step)) {
      goToStep(step as OnboardStep, 1)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params])

  useEffect(() => {
    if (!email) return
    apiLocations(email)
      .then((data) => setLocations(data.locations))
      .catch(() => undefined)
    apiConnectorStatus()
      .then((s) => setConnectAvailable(s.google || s.composio))
      .catch(() => setConnectAvailable(false))
  }, [email])

  const commit = (next: OnboardingProgress) => {
    const saved = saveOnboarding(next)
    setProgress(saved)
    return saved
  }

  const goToStep = (step: OnboardStep, stage: 0 | 1 | 2) => {
    setError('')
    setNotice('')
    commit({ ...progress, currentStep: step, stage })
    setParams({}, { replace: true })
  }

  const update = (patch: Partial<OnboardingProgress>) => {
    commit({ ...progress, ...patch })
  }

  const latestLocation = (kind: 'current' | 'home' | 'work') =>
    locations.find((l) => l.kind === kind) ?? null

  async function persistLocation(
    kind: 'current' | 'home' | 'work',
    place: PendingPlace,
  ) {
    if (!email) return
    setBusy(true)
    setError('')
    try {
      const next = await apiSaveLocation({
        email,
        kind,
        latitude: place.lat,
        longitude: place.lon,
        accuracy_m: place.accuracy,
        label: place.label,
        source: place.accuracy != null ? 'gps' : 'manual',
      })
      setLocations(next)
      setNotice(kind === 'current' ? 'Location saved.' : `${place.label} saved as ${kind}.`)
      setPendingPlace(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save location')
    } finally {
      setBusy(false)
    }
  }

  async function captureCurrent() {
    if (!('geolocation' in navigator)) {
      setError('This browser has no location support. Enter a city or address below.')
      return
    }
    setBusy(true)
    setError('')
    try {
      const pos = await new Promise<GeolocationPosition>((resolve, reject) =>
        navigator.geolocation.getCurrentPosition(resolve, reject, {
          enableHighAccuracy: true,
          timeout: 12000,
          maximumAge: 60000,
        }),
      )
      const { latitude, longitude, accuracy } = pos.coords
      const label = (await reversePlace(latitude, longitude)) || 'My current location'
      setPendingPlace({ lat: latitude, lon: longitude, accuracy, label })
    } catch {
      setError(
        'Location permission denied or unavailable. You can still enter a city or address below — nearby features stay off until a location is saved.',
      )
    } finally {
      setBusy(false)
    }
  }

  async function lookupManual() {
    const q = manualQuery.trim()
    if (!q) {
      setError('Enter a city, neighborhood, or address first.')
      return
    }
    setBusy(true)
    setError('')
    try {
      const found = await searchPlace(q)
      setPendingPlace({ lat: found.lat, lon: found.lon, accuracy: null, label: found.label })
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not look up that place')
    } finally {
      setBusy(false)
    }
  }

  async function saveName(next: OnboardingProgress) {
    if (!email) return
    try {
      await apiSignIn(email, session?.phone || '', next.identity.name, next.timezone || undefined)
    } catch {
      /* server offline — keep local session; progress still saved */
    }
    if (session) signIn(email, session.phone || '', next.identity.name, next.timezone || undefined)
  }

  async function saveTimezone(next: OnboardingProgress) {
    if (!email || !next.timezone) return
    try {
      await apiSignIn(email, session?.phone || '', next.identity.name, next.timezone)
    } catch {
      /* server offline — local only */
    }
    if (session) signIn(email, session.phone || '', next.identity.name, next.timezone)
  }

  async function startConnector(id: Parameters<typeof apiConnectUrl>[0]['connector']) {
    if (!email) return
    try {
      const url = await apiConnectUrl({ connector: id, email, persona: 'friend' })
      window.open(url, '_blank', 'noopener')
      setNotice(`Connecting ${CONNECTOR_CATALOG.find((c) => c.id === id)?.name || id} in a new tab. It stays “Not connected” until the connection is confirmed.`)
    } catch {
      setError('Connecting is not available in this build yet. Nothing has been marked connected.')
    }
  }

  async function connectAll() {
    const unconnected = CONNECTOR_CATALOG.map((c) => c.id).filter((id) => !getConnections()[id]?.connected)
    for (const id of unconnected) {
      try {
        const url = await apiConnectUrl({ connector: id, email, persona: 'friend' })
        window.open(url, '_blank', 'noopener')
      } catch {
        /* keep trying the rest; summary below is truthful */
      }
    }
    if (unconnected.some((id) => !getConnections()[id]?.connected)) {
      setNotice('Connect links opened where available. Cards stay accurate: nothing is marked connected unless the connection is confirmed.')
    }
  }

  const current = latestLocation('current')
  const home = latestLocation('home')
  const work = latestLocation('work')
  const topPriority = PRIORITIES.find((p) => p.id === progress.priorities[0])
  const proof = topPriority ? PROOF_BY_PRIORITY[topPriority.id] : null

  if (progress.currentStep === 'done') {
    return (
      <div className="plat-page">
        <header className="plat-page__head">
          <h1>All set</h1>
          <p>Alpha is set up to be useful from the first conversation.</p>
        </header>
        <div className="onb-card">
          <p>
            Hey {progress.identity.name || 'there'} — Alpha is ready. You can change anything here or
            in Settings any time.
          </p>
          <ul className="onb-summary">
            <li>
              <span>Location</span>
              <strong>{current ? current.label : 'Not set — manual entry always available'}</strong>
            </li>
            {home && (
              <li>
                <span>Home</span>
                <strong>{home.label}</strong>
              </li>
            )}
            {work && (
              <li>
                <span>Work</span>
                <strong>{work.label}</strong>
              </li>
            )}
            <li>
              <span>First focus</span>
              <strong>{topPriority ? topPriority.label : 'None chosen yet'}</strong>
            </li>
            <li>
              <span>Proactive</span>
              <strong>
                {progress.proactive.everythingOff || !progress.proactive.enabled
                  ? 'Paused'
                  : `On${progress.proactive.checkInFrequency === 'off' ? ' — check-ins off' : ''}`}
              </strong>
            </li>
          </ul>
          <div className="onb-actions">
            <Link to="/app" className="plat-btn">
              Open workspace
            </Link>
            <Link to="/app/setup?step=proactive" className="plat-btn plat-btn--ghost">
              Adjust proactive controls
            </Link>
            <Link to="/app/location" className="plat-btn plat-btn--ghost">
              Manage locations
            </Link>
          </div>
        </div>
      </div>
    )
  }

  if (progress.currentStep === 'stage2' || progress.stage === 2) {
    const filled = PROFILE_FIELDS.filter((f) => (progress.profile[f.id] || '').trim()).length
    const pct = Math.round((filled / PROFILE_FIELDS.length) * 100)

    return (
      <div className="plat-page">
        <header className="plat-page__head">
          <h1>Complete the profile</h1>
          <p>Optional, progressive, and every field explains what it unlocks. Skip anything.</p>
        </header>

        <div className="onb-progress">
          <div className="onb-progress__bar">
            <span style={{ width: `${pct}%` }} />
          </div>
          <span>
            {filled}/{PROFILE_FIELDS.length} optional fields
          </span>
        </div>

        <div className="onb-fields">
          {PROFILE_FIELDS.map((field) => {
            const value = progress.profile[field.id] || ''
            return (
              <label key={field.id} className="onb-field-card">
                <span className="onb-field-card__label">{field.label}</span>
                <span className="onb-field-card__benefit">{field.benefit}</span>
                {field.multiline ? (
                  <textarea
                    rows={2}
                    placeholder={field.placeholder}
                    value={value}
                    onChange={(e) => {
                      const profile = { ...progress.profile, [field.id]: e.target.value }
                      update({ profile })
                    }}
                  />
                ) : (
                  <input
                    type="text"
                    placeholder={field.placeholder}
                    value={value}
                    onChange={(e) => {
                      const profile = { ...progress.profile, [field.id]: e.target.value }
                      update({ profile })
                    }}
                  />
                )}
              </label>
            )
          })}
        </div>

        <div className="onb-actions">
          <button
            type="button"
            className="plat-btn"
            onClick={() => commit({ ...progress, currentStep: 'done', completedAt: new Date().toISOString() })}
          >
            Finish setup
          </button>
          <Link to="/app" className="plat-link">
            Finish later
          </Link>
        </div>
      </div>
    )
  }

  if (progress.stage === 0) {
    return (
      <div className="plat-page onb-welcome">
        <header className="plat-id">
          <span className="plat-mark plat-mark--lg">🌤️</span>
          <div>
            <h1>Alpha works better when it knows your context.</h1>
            <p>
              We use your location for nearby recommendations, weather, directions, and plans. You
              choose what Alpha can access. You can update or remove it in Settings at any time.
            </p>
          </div>
        </header>

        <div className="onb-actions">
          <button
            type="button"
            className="plat-btn"
            onClick={() => goToStep('identity', 1)}
          >
            Set up Alpha
          </button>
          <button
            type="button"
            className="plat-btn plat-btn--ghost"
            onClick={() => setNotice('Location is used on the server for map and weather lookups. Alpha sees a safe label like “near Work in San Francisco”, never your exact coordinates.')}
          >
            See what will be collected
          </button>
          <Link to="/app" className="plat-link">
            Skip for now
          </Link>
        </div>
        {notice && <p className="onb-note">{notice}</p>}
        <p className="plat-foot" style={{ marginTop: 32 }}>
          <Link to="/app/location" className="plat-link">
            Already set? Manage locations here.
          </Link>
        </p>
      </div>
    )
  }

  const stepIndex = STAGE1_STEPS.findIndex((s) => s.id === progress.currentStep)
  const stepMeta = STAGE1_STEPS[stepIndex]

  return (
    <div className="plat-page">
      <header className="plat-page__head">
        <div className="onb-stephead">
          <span className="onb-stephead__count">
            Step {stepIndex + 1} of {STAGE1_STEPS.length}
          </span>
          <h1>{stepMeta?.label}</h1>
        </div>
        <div className="onb-progress">
          <div className="onb-progress__bar">
            <span style={{ width: `${((stepIndex + 1) / STAGE1_STEPS.length) * 100}%` }} />
          </div>
          <span>Progress is saved after every step.</span>
        </div>
      </header>

      {error && <p className="plat-auth__error">{error}</p>}
      {notice && <p className="plat-hint">{notice}</p>}

      {progress.currentStep === 'identity' && (
        <div className="onb-card">
          <div className="plat-fields">
            <label className="plat-field">
              <span>What should we call you?</span>
              <input
                type="text"
                placeholder="Sashank"
                value={progress.identity.name}
                autoFocus
                onChange={(e) => update({ identity: { ...progress.identity, name: e.target.value } })}
              />
            </label>
            <label className="plat-field">
              <span>Pronouns <small>(optional)</small></span>
              <input
                type="text"
                placeholder="she/her, they/them, …"
                value={progress.identity.pronouns}
                onChange={(e) => update({ identity: { ...progress.identity, pronouns: e.target.value } })}
              />
            </label>
            <label className="plat-field">
              <span>What should Alpha help with most? <small>(optional, one line)</small></span>
              <input
                type="text"
                placeholder="Keeping my week on track"
                value={progress.identity.focus}
                onChange={(e) => update({ identity: { ...progress.identity, focus: e.target.value } })}
              />
            </label>
          </div>
          <div className="onb-actions">
            <button
              type="button"
              className="plat-btn"
              disabled={!progress.identity.name.trim()}
              onClick={async () => {
                const next = commit({ ...progress, stage: 1 })
                await saveName(next)
                goToStep('location', 1)
              }}
            >
              Continue
            </button>
            <Link to="/app" className="plat-link">
              Finish later
            </Link>
          </div>
        </div>
      )}

      {progress.currentStep === 'location' && (
        <div className="onb-card">
          {pendingPlace ? (
            <>
              <h2>That&apos;s {pendingPlace.label}. Right?</h2>
              <p className="plat-hint">
                {pendingPlace.accuracy != null
                  ? `Detected with ${Math.round(pendingPlace.accuracy)}m accuracy.`
                  : 'From the address you entered.'}{' '}
                You can fix the label if it is wrong. Raw coordinates never reach Alpha&apos;s chat — only this label.
              </p>
              <label className="plat-field" style={{ marginBottom: 12 }}>
                <span>Place label</span>
                <input
                  type="text"
                  value={pendingPlace.label}
                  onChange={(e) => setPendingPlace({ ...pendingPlace, label: e.target.value })}
                />
              </label>
              <div className="onb-actions">
                <button
                  type="button"
                  className="plat-btn"
                  disabled={busy}
                  onClick={() => void persistLocation('current', pendingPlace)}
                >
                  {busy ? 'Saving…' : 'Save current location'}
                </button>
                <button type="button" className="plat-link" onClick={() => setPendingPlace(null)}>
                  Change
                </button>
              </div>
            </>
          ) : (
            <>
              <h2>Allow location so Alpha can find places near you, give local weather, and plan around where you are.</h2>
              <p className="plat-hint">
                GPS is only requested after you tap allow — never before. Exact location is not required; a city or address works.
              </p>
              <div className="onb-actions">
                <button type="button" className="plat-btn" disabled={busy} onClick={() => void captureCurrent()}>
                  {busy ? 'Locating…' : 'Allow current location'}
                </button>
              </div>
              <div className="onb-divider"><span>or enter it manually</span></div>
              <label className="plat-field">
                <span>City, neighborhood, or address</span>
                <input
                  type="text"
                  placeholder="SoMa, San Francisco"
                  value={manualQuery}
                  onChange={(e) => setManualQuery(e.target.value)}
                />
              </label>
              <div className="onb-actions">
                <button
                  type="button"
                  className="plat-btn plat-btn--sm"
                  disabled={busy || !manualQuery.trim()}
                  onClick={() => void lookupManual()}
                >
                  {busy ? 'Looking up…' : 'Use this instead'}
                </button>
                <Link to="/app" className="plat-link">
                  Finish later
                </Link>
              </div>
              {current && (
                <div className="onb-actions">
                  <button type="button" className="plat-btn" onClick={() => goToStep('homework', 1)}>
                    Continue
                  </button>
                </div>
              )}
            </>
          )}
        </div>
      )}

      {progress.currentStep === 'homework' && (
        <div className="onb-card">
          {!current ? (
            <>
              <h2>Save a location first so we have a starting point.</h2>
              <div className="onb-actions">
                <button type="button" className="plat-btn" onClick={() => goToStep('location', 1)}>
                  Go back to location
                </button>
              </div>
            </>
          ) : pendingPlace ? (
            <>
              <h2>Use {pendingPlace.label}?</h2>
              <div className="onb-actions">
                <button
                  type="button"
                  className="plat-btn plat-btn--sm"
                  disabled={busy}
                  onClick={() => void persistLocation('home', pendingPlace)}
                >
                  Save as Home
                </button>
                <button
                  type="button"
                  className="plat-btn plat-btn--sm"
                  disabled={busy}
                  onClick={() => void persistLocation('work', pendingPlace)}
                >
                  Save as Work
                </button>
                <button type="button" className="plat-link" onClick={() => setPendingPlace(null)}>
                  Change
                </button>
              </div>
            </>
          ) : (
            <>
              <h2>Save this as Home, or use a different address?</h2>
              <p className="plat-hint">
                Current: <strong>{current.label}</strong>. Alpha never assumes Home or Work — only what you save.
              </p>
              <div className="onb-actions">
                <button
                  type="button"
                  className="plat-btn plat-btn--sm"
                  disabled={busy}
                  onClick={() => void persistLocation('home', { lat: current.latitude, lon: current.longitude, accuracy: current.accuracy_m, label: `Home in ${current.label}` })}
                >
                  Save as Home
                </button>
                <button
                  type="button"
                  className="plat-btn plat-btn--sm"
                  disabled={busy}
                  onClick={() => void persistLocation('work', { lat: current.latitude, lon: current.longitude, accuracy: current.accuracy_m, label: `Work in ${current.label}` })}
                >
                  Save as Work
                </button>
              </div>
              <div className="onb-divider"><span>or</span></div>
              <label className="plat-field">
                <span>Different address</span>
                <input
                  type="text"
                  placeholder="SoMa, San Francisco"
                  value={manualQuery}
                  onChange={(e) => setManualQuery(e.target.value)}
                />
              </label>
              <div className="onb-actions">
                <button
                  type="button"
                  className="plat-btn plat-btn--sm"
                  disabled={busy || !manualQuery.trim()}
                  onClick={() => void lookupManual()}
                >
                  Look it up
                </button>
                <button type="button" className="plat-link" onClick={() => goToStep('time', 1)}>
                  Skip Home/Work
                </button>
              </div>
              {(home || work) && (
                <div className="onb-actions">
                  <button type="button" className="plat-btn" onClick={() => goToStep('time', 1)}>
                    Continue
                  </button>
                  <p className="onb-note" style={{ margin: 0 }}>
                    Saved: {[home && `Home (${home.label})`, work && `Work (${work.label})`].filter(Boolean).join(' · ')}.
                  </p>
                </div>
              )}
            </>
          )}
        </div>
      )}

      {progress.currentStep === 'time' && (
        <div className="onb-card">
          <div className="plat-fields">
            <label className="plat-field">
              <span>Timezone</span>
              <select
                value={progress.timezone}
                onChange={(e) => update({ timezone: e.target.value })}
              >
                <option value="">Detected: {new Intl.DateTimeFormat().resolvedOptions().timeZone}</option>
                {TIMEZONES.map((tz) => (
                  <option key={tz} value={tz}>
                    {tz}
                  </option>
                ))}
              </select>
            </label>
            <div className="onb-inline">
              <label className="plat-field">
                <span>Quiet hours start</span>
                <input
                  type="time"
                  value={progress.quietStart}
                  onChange={(e) => update({ quietStart: e.target.value })}
                />
              </label>
              <label className="plat-field">
                <span>Quiet hours end</span>
                <input
                  type="time"
                  value={progress.quietEnd}
                  onChange={(e) => update({ quietEnd: e.target.value })}
                />
              </label>
            </div>
            <p className="plat-hint">Alpha never sends a proactive message outside these hours. Default {DEFAULT_QUIET_START}–{DEFAULT_QUIET_END}.</p>
            <div>
              <span className="onb-label">Response style</span>
              <div className="onb-chips">
                {RESPONSE_STYLES.map((style) => (
                  <button
                    key={style.id}
                    type="button"
                    className={`onb-chip ${progress.responseStyle === style.id ? 'onb-chip--on' : ''}`}
                    onClick={() => update({ responseStyle: style.id })}
                  >
                    {style.label}
                  </button>
                ))}
              </div>
            </div>
            <div className="onb-inline">
              <span className="onb-label">Ask follow-ups when info is missing?</span>
              <div className="onb-chips">
                <button
                  type="button"
                  className={`onb-chip ${progress.followUps ? 'onb-chip--on' : ''}`}
                  onClick={() => update({ followUps: true })}
                >
                  Yes
                </button>
                <button
                  type="button"
                  className={`onb-chip ${!progress.followUps ? 'onb-chip--on' : ''}`}
                  onClick={() => update({ followUps: false })}
                >
                  No
                </button>
              </div>
            </div>
          </div>
          <div className="onb-actions">
            <button
              type="button"
              className="plat-btn"
              onClick={async () => {
                const next = commit({
                  ...progress,
                  timezone: progress.timezone || new Intl.DateTimeFormat().resolvedOptions().timeZone,
                })
                await saveTimezone(next)
                goToStep('priorities', 1)
              }}
            >
              Continue
            </button>
            <Link to="/app" className="plat-link">
              Finish later
            </Link>
          </div>
        </div>
      )}

      {progress.currentStep === 'priorities' && (
        <div className="onb-card">
          <h2>Pick up to three things Alpha should know first.</h2>
          <p className="plat-hint">This sets your first feature card. You can change it later.</p>
          <div className="onb-chips onb-chips--grid">
            {PRIORITIES.map((p) => {
              const on = progress.priorities.includes(p.id)
              const disabled = !on && progress.priorities.length >= 3
              return (
                <button
                  key={p.id}
                  type="button"
                  className={`onb-chip onb-chip--big ${on ? 'onb-chip--on' : ''}`}
                  disabled={disabled}
                  onClick={() => {
                    const priorities = on
                      ? progress.priorities.filter((id) => id !== p.id)
                      : [...progress.priorities, p.id]
                    update({ priorities })
                  }}
                >
                  <span className="onb-chip__emoji">{p.emoji}</span>
                  {p.label}
                </button>
              )
            })}
          </div>
          <div className="onb-actions">
            <button
              type="button"
              className="plat-btn"
              disabled={progress.priorities.length === 0}
              onClick={() => goToStep('proof', 1)}
            >
              Continue
            </button>
            <Link to="/app" className="plat-link">
              Finish later
            </Link>
          </div>
        </div>
      )}

      {progress.currentStep === 'proof' && (
        <div className="onb-card">
          {proof ? (
            <>
              <h2>{proof.title}</h2>
              <p className="plat-hint">{proof.line}</p>
              {proof.href ? (
                <div className="onb-actions">
                  <Link to={proof.href} className="plat-btn">
                    Open it now
                  </Link>
                </div>
              ) : (
                <p className="onb-note">
                  Alpha runs this from the saved location once you text it. It returns one answer — not a menu.
                </p>
              )}
            </>
          ) : (
            <h2>Text Alpha anything when you are ready. It answers with one thing done.</h2>
          )}
          <div className="onb-actions">
            <button type="button" className="plat-btn" onClick={() => goToStep('connectors', 1)}>
              Continue
            </button>
          </div>
        </div>
      )}

      {progress.currentStep === 'connectors' && (
        <div className="onb-card">
          <h2>Connect the tools Alpha will actually use.</h2>
          <p className="plat-hint">
            Read-only by default; you can allow more. Revoke anytime. Nothing is marked connected
            unless the connection is confirmed.
          </p>
          {connectAvailable === false && (
            <p className="onb-note">
              Connecting is not available in this build yet, so nothing here will be marked
              connected. The cards below are truthful — all currently “Not connected”.
            </p>
          )}
          <ul className="onb-connectors">
            {CONNECTOR_CATALOG.map((c) => {
              const conn = getConnections()[c.id]
              const access = CONNECTOR_ACCESS[c.id]?.access ?? 'read'
              const state = conn?.connected ? 'Connected' : 'Not connected'
              return (
                <li key={c.id} className={`onb-connector ${conn?.connected ? 'onb-connector--on' : ''}`}>
                  <div className="onb-connector__body">
                    <div className="onb-connector__line">
                      <strong>{c.name}</strong>
                      <span className={`onb-connector__state onb-connector__state--${conn?.connected ? 'ok' : 'off'}`}>
                        {state}
                      </span>
                    </div>
                    <p>{c.blurb}</p>
                    <p className="onb-connector__meta">
                      {access === 'read-write' ? 'Can read and write' : 'Read-only'} ·{' '}
                      {CONNECTOR_ACCESS[c.id]?.revoke ?? 'Revoke any time in Settings.'}
                    </p>
                  </div>
                  <button
                    type="button"
                    className="plat-btn plat-btn--sm"
                    disabled={conn?.connected || connectAvailable === false}
                    onClick={() => void startConnector(c.id)}
                  >
                    {conn?.connected ? 'Connected' : 'Connect'}
                  </button>
                </li>
              )
            })}
          </ul>
          <div className="onb-actions">
            <button
              type="button"
              className="plat-btn"
              disabled={connectAvailable === false}
              onClick={() => void connectAll()}
            >
              Connect all
            </button>
            <button
              type="button"
              className="plat-link"
              onClick={() => {
                update({ connectorsSeen: true })
                goToStep('proactive', 1)
              }}
            >
              Skip for now
            </button>
          </div>
        </div>
      )}

      {progress.currentStep === 'proactive' && (
        <div className="onb-card">
          <h2>Control how proactive Alpha is.</h2>
          <p className="plat-hint">
            Nothing proactive fires until you say so — and never outside your quiet hours ({progress.quietStart}–{progress.quietEnd}).
          </p>
          <ProactiveControls
            value={progress.proactive}
            onChange={(proactive: ProactiveSettings) => update({ proactive })}
            full
          />
          <div className="onb-actions">
            <button
              type="button"
              className="plat-btn"
              onClick={() => {
                commit({ ...progress, currentStep: 'stage2', stage: 2 })
                navigate('/app/setup')
              }}
            >
              Continue
            </button>
            <Link to="/app" className="plat-link">
              Finish later
            </Link>
          </div>
        </div>
      )}

      <div className="onb-actions onb-actions--foot">
        {stepIndex > 0 && (
          <button type="button" className="plat-link" onClick={() => goToStep(STAGE1_STEPS[stepIndex - 1].id, 1)}>
            Back
          </button>
        )}
      </div>
    </div>
  )
}
