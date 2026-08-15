import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { TIMEZONES } from './connectors'
import { apiDeleteLocation, apiLocations, apiSaveLocation, type SavedLocation } from './api'
import { getSession, signIn } from './roster'

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

export function LocationPage() {
  const session = getSession()
  const [locations, setLocations] = useState<SavedLocation[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [capturing, setCapturing] = useState(false)
  const [manual, setManual] = useState('')
  const [timezone, setTimezone] = useState(session?.timezone || '')
  const viewer = new Intl.DateTimeFormat().resolvedOptions().timeZone

  const refresh = async () => {
    const email = getSession()?.email
    if (!email) return
    try {
      const data = await apiLocations(email)
      setLocations(data.locations)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load locations')
    }
  }

  useEffect(() => {
    void refresh()
  }, [])

  const latestState = (kind: 'current' | 'home' | 'work') =>
    locations.find((l) => l.kind === kind) ?? null

  function persistX(
    lat: number,
    lng: number,
    accuracy: number | null,
    kind: 'current' | 'home' | 'work',
    label: string,
  ) {
    const email = getSession()?.email
    if (!email) return
    setBusy(true)
    setError('')
    setNotice('')
    void (async () => {
      try {
        const next = await apiSaveLocation({ email, kind, latitude: lat, longitude: lng, accuracy_m: accuracy, label, source: 'gps' })
        setLocations(next)
        setNotice(kind === 'current' ? 'Location saved.' : `${label} saved. Nearby searches will use it.`)
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Could not save location')
      } finally {
        setBusy(false)
      }
    })()
  }

  function manualSave(kind: 'current' | 'home' | 'work') {
    const label = manual.trim()
    if (!label) {
      setError('Enter a place or label first.')
      return
    }
    setBusy(true)
    setError('')
    setNotice('')
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
        setNotice(`${label || 'Location'} saved.`)
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Could not save location')
      } finally {
        setBusy(false)
      }
    })()
  }

  function remove(kind: 'current' | 'home' | 'work') {
    const email = getSession()?.email
    if (!email) return
    setError('')
    void apiDeleteLocation(email, kind)
      .then(setLocations)
      .catch((err) => setError(err instanceof Error ? err.message : 'Could not delete'))
  }

  async function capture() {
    if (!('geolocation' in navigator)) {
      setError('This browser has no location support. Enter a city or address below.')
      return
    }
    setCapturing(true)
    setError('')
    setNotice('')
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
      setNotice(`Saved ${label}.`)
    } catch {
      setError(
        'Location permission denied or unavailable. You can still enter a city or address manually below.',
      )
    } finally {
      setCapturing(false)
    }
  }

  function setHomeFromCurrent() {
    const cur = latestState('current')
    if (!cur) return
    const label = prompt('Label for Home (e.g. Home in SoMa):', 'Home')?.trim()
    if (!label) return
    persistX(cur.latitude, cur.longitude, cur.accuracy_m, 'home', label)
  }

  function setWorkFromCurrent() {
    const cur = latestState('current')
    if (!cur) return
    const label = prompt('Label for Work (e.g. Work in FiDi):', 'Work')?.trim()
    if (!label) return
    persistX(cur.latitude, cur.longitude, cur.accuracy_m, 'work', label)
  }

  const current = latestState('current')
  const home = latestState('home')
  const work = latestState('work')

  function saveTimezone() {
    const email = getSession()?.email
    if (!email || !timezone) return
    void fetch('/api/me', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, phone: session?.phone || '', name: session?.name, timezone }),
    })
      .then((r) => r.json())
      .then(() => {
        if (email) signIn(email, session?.phone || '', session?.name, timezone)
        setNotice('Timezone saved.')
      })
      .catch(() => setError('Could not save timezone'))
  }

  return (
    <div className="plat-page">
      <Link to="/app" className="plat-back">
        People
      </Link>

      <header className="plat-id">
        <span className="plat-mark plat-mark--lg">📍</span>
        <div>
          <h1>Location</h1>
          <p>Alpha uses this for nearby places, weather, and plans. You control it from here.</p>
        </div>
      </header>

      {error && <p className="plat-auth__error">{error}</p>}
      {notice && <p className="plat-hint">{notice}</p>}

      <div className="plat-split">
        <section>
          <h2>Current location</h2>
          <p className="plat-hint">
            {current
              ? `Using ${current.label}${current.accuracy_m ? ` (${Math.round(current.accuracy_m)}m accuracy)` : ''} · ${timeAgo(current.updated_at)}.`
              : 'Exact location only when you allow it. Nearby features stay blocked until it is set.'}
          </p>
          {current && (
            <p className="plat-hint">
              Raw coordinates never reach Alpha&apos;s chat — the label is all the bot sees.
            </p>
          )}
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
            <button
              type="button"
              className="plat-btn"
              disabled={busy || capturing}
              onClick={() => void capture()}
            >
              {capturing ? 'Locating…' : 'Allow current location'}
            </button>
            {current && (
              <button
                type="button"
                className="plat-btn plat-btn--ghost"
                onClick={() => remove('current')}
              >
                Remove current
              </button>
            )}
          </div>

          <h2 style={{ marginTop: 24 }}>Home</h2>
          <p className="plat-hint">
            {home ? `Saved ${home.label} · ${timeAgo(home.updated_at)}.` : 'Not set. Nearby searches default to your current location.'}
          </p>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
            <button
              type="button"
              className="plat-btn plat-btn--sm"
              disabled={!current}
              onClick={setHomeFromCurrent}
            >
              Save current as Home
            </button>
            {home && (
              <button type="button" className="plat-link" onClick={() => remove('home')}>
                Delete Home
              </button>
            )}
          </div>

          <h2 style={{ marginTop: 24 }}>Work</h2>
          <p className="plat-hint">
            {work ? `Saved ${work.label} · ${timeAgo(work.updated_at)}.` : 'Not set.'}
          </p>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
            <button
              type="button"
              className="plat-btn plat-btn--sm"
              disabled={!current}
              onClick={setWorkFromCurrent}
            >
              Save current as Work
            </button>
            {work && (
              <button type="button" className="plat-link" onClick={() => remove('work')}>
                Delete Work
              </button>
            )}
          </div>
        </section>

        <section>
          <h2>Or enter it manually</h2>
          <p className="plat-hint">Works if GPS is off, denied, or this browser has no support.</p>
          <label className="plat-field">
            <span>Place, city, or address</span>
            <input
              type="text"
              placeholder="SoMa, San Francisco"
              value={manual}
              onChange={(e) => setManual(e.target.value)}
            />
          </label>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
            <button
              type="button"
              className="plat-btn plat-btn--sm"
              disabled={busy || !manual.trim()}
              onClick={() => manualSave('current')}
            >
              Save current
            </button>
            <button
              type="button"
              className="plat-btn plat-btn--sm"
              disabled={busy || !manual.trim()}
              onClick={() => manualSave('home')}
            >
              Save as Home
            </button>
            <button
              type="button"
              className="plat-btn plat-btn--sm"
              disabled={busy || !manual.trim()}
              onClick={() => manualSave('work')}
            >
              Save as Work
            </button>
          </div>

          <h2 style={{ marginTop: 24 }}>Time &amp; language</h2>
          <label className="plat-field">
            <span>Timezone</span>
            <select value={timezone} onChange={(e) => setTimezone(e.target.value)}>
              <option value="">Detected: {viewer}</option>
              {TIMEZONES.map((tz) => (
                <option key={tz} value={tz}>
                  {tz}
                </option>
              ))}
            </select>
          </label>
          <div style={{ marginTop: 8 }}>
            <button
              type="button"
              className="plat-btn plat-btn--sm"
              disabled={!timezone}
              onClick={saveTimezone}
            >
              Save timezone
            </button>
          </div>
        </section>
      </div>
    </div>
  )
}