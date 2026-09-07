import { useEffect, useMemo, useState } from 'react'
import { Navigate } from 'react-router-dom'
import {
  apiAddRelationship,
  apiConnectUrl,
  apiGetMiniPrefs,
  apiNutritionToday,
  apiPutMiniPrefs,
  apiSaveLocation,
  apiSavePhone,
  apiSetDigestTime,
  apiSetEveningTime,
  apiSetNutritionGoals,
  apiSetSpendBudget,
  apiSetup,
  apiSetupStatus,
} from './api'
import { ConnectorLogo } from './ConnectorLogo'
import { connectorsForHire, type ConnectorId } from './connectors'
import type { FeatureAuth } from './FeatureMiniApps'
import { connectedIds, getSession, hydrateFromServer } from './roster'
import {
  writeWorkoutDays,
  readWorkoutDays,
  WORKOUT_DAY_LABELS_ALL,
  WORKOUT_DAY_LETTERS_ALL,
  type WorkoutDay,
} from './workoutProgram'
import { MINI_SETTINGS_EVENT } from './MiniAppSettings'

/** Common IANA zones offered on the timezone step (detected one always included). */
const COMMON_ZONES = [
  'America/Los_Angeles',
  'America/New_York',
  'America/Chicago',
  'America/Denver',
  'Europe/London',
  'Europe/Berlin',
  'Asia/Kolkata',
  'Asia/Dubai',
  'Australia/Sydney',
  'Pacific/Auckland',
]

/** Onboarding wizard shown in the menu card while setup is incomplete.
 * Five pages, each bundling related questions, so the whole thing is done in
 * five taps-or-less per topic instead of eleven pages of one question. */
export function SetupApp({ auth }: { auth: FeatureAuth }) {
  const persona = auth.persona
  const email = auth.email || getSession()?.email

  type Step = 'you' | 'watch' | 'body' | 'people' | 'connect'
  const STEPS: { id: Step; title: string }[] = [
    { id: 'you', title: 'You & places' },
    { id: 'watch', title: 'What Alpha watches' },
    { id: 'body', title: 'Sleep, training & food' },
    { id: 'people', title: 'People & spend' },
    { id: 'connect', title: 'Connect tools' },
  ]
  // Resume where the user left off — closing the tab mid-wizard must not send
  // them back to page one on return.
  const [step, setStep] = useState<Step>(() => {
    try {
      const saved = localStorage.getItem('ha_setup_step') as Step | null
      return saved && STEPS.some((s) => s.id === saved) ? saved : 'you'
    } catch {
      return 'you'
    }
  })
  const idx = STEPS.findIndex((s) => s.id === step)

  const [features, setFeatures] = useState<string[]>([])
  const [digestTime, setDigestTime] = useState('08:00')
  const [eveningTime, setEveningTime] = useState('21:00')
  const [calories, setCalories] = useState(2200)
  const [protein, setProtein] = useState(150)
  const [bedtime, setBedtime] = useState('23:00')
  const [wake, setWake] = useState('07:00')
  const [days, setDays] = useState<WorkoutDay[]>(() => readWorkoutDays() || [0, 1, 2, 3, 4])
  const [personName, setPersonName] = useState('')
  const [personKind, setPersonKind] = useState('personal')
  const [personCadence, setPersonCadence] = useState(14)
  const [people, setPeople] = useState<Array<{ name: string; kind: string; cadence: number }>>([])
  const [budget, setBudget] = useState(400)
  const detectedTz = useMemo(() => {
    try {
      return Intl.DateTimeFormat().resolvedOptions().timeZone || 'America/New_York'
    } catch {
      return 'America/New_York'
    }
  }, [])
  const [tz, setTz] = useState(detectedTz)
  const zoneOptions = useMemo(() => (detectedTz && !COMMON_ZONES.includes(detectedTz) ? [detectedTz, ...COMMON_ZONES] : COMMON_ZONES), [detectedTz])
  const [homeQuery, setHomeQuery] = useState('')
  const [workQuery, setWorkQuery] = useState('')
  const [ids, setIds] = useState<ConnectorId[]>(() => connectedIds())
  const [connecting, setConnecting] = useState<ConnectorId | null>(null)
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState('')
  const [done, setDone] = useState(false)

  const connectors = connectorsForHire(persona)
  const onCount = connectors.filter((c) => c.noAuth || ids.includes(c.id)).length
  const a = email ? { email } : { token: auth.token }

  useEffect(() => {
    if (!email && !auth.token) return
    void apiSetupStatus({ persona, ...a })
      .then((s) => {
        if (s.setup?.length) setFeatures(s.setup)
        if (s.setupDone) setDone(true)
      })
      .catch(() => undefined)
    void hydrateFromServer().then(() => setIds(connectedIds())).catch(() => undefined)
    void apiNutritionToday(a)
      .then((d) => {
        if (!d.goals) return
        setCalories(d.goals.calorieGoal)
        setProtein(d.goals.proteinGoal)
      })
      .catch(() => undefined)
    void apiGetMiniPrefs(a)
      .then((p) => {
        if (p.sleepBedtime) setBedtime(p.sleepBedtime)
        if (p.sleepWake) setWake(p.sleepWake)
        if (Array.isArray(p.workoutDays) && p.workoutDays.length) setDays(p.workoutDays as WorkoutDay[])
      })
      .catch(() => undefined)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [email, auth.token, persona])

  function goto(i: number) {
    if (i < STEPS.length - 1) {
      const id = STEPS[i + 1]!.id
      try {
        localStorage.setItem('ha_setup_step', id)
      } catch {
        /* private mode: resume just restarts from page one */
      }
      setStep(id)
    } else setDone(true)
  }

  async function next() {
    setMsg('')
    setBusy(true)
    try {
      if (step === 'you') {
        // Time zone rides the phone record; home and work geocode on save.
        // Independent writes run together so the page lands in one round trip.
        const jobs: Promise<unknown>[] = []
        const session = getSession()
        if (email && session?.phone) {
          jobs.push(apiSavePhone(email, session.phone, session.name, tz))
        }
        const homeQ = homeQuery.trim()
        if (email && homeQ) {
          jobs.push(
            geocodePlace(homeQ).then((hit) =>
              apiSaveLocation({ email, kind: 'home', latitude: hit.lat, longitude: hit.lon, label: homeQ, source: 'manual' }),
            ),
          )
        }
        const workQ = workQuery.trim()
        if (email && workQ) {
          jobs.push(
            geocodePlace(workQ).then((hit) =>
              apiSaveLocation({ email, kind: 'work', latitude: hit.lat, longitude: hit.lon, label: workQ, source: 'manual' }),
            ),
          )
        }
        await Promise.all(jobs)
      } else if (step === 'watch') {
        const f = features.length ? features : ['digest']
        await Promise.all([
          apiSetup({ persona, features: f, ...a }),
          apiSetDigestTime({ persona, time: digestTime, ...a }),
          apiSetEveningTime({ persona, time: eveningTime, ...a }),
        ])
      } else if (step === 'body') {
        writeWorkoutDays(days)
        // One prefs PUT carries sleep + workout days (server merges per field).
        await Promise.all([
          apiPutMiniPrefs({ ...a, sleepBedtime: bedtime, sleepWake: wake, workoutDays: days }),
          apiSetNutritionGoals({ ...a, calorieGoal: calories, proteinGoal: protein }),
        ])
      } else if (step === 'people') {
        // Save every person the user added (each keeps its own kind/cadence).
        const all = people.length ? people : (personName.trim() ? [{ name: personName.trim(), kind: personKind, cadence: personCadence }] : [])
        await Promise.all([
          ...all.map((p) =>
            apiAddRelationship({ ...a, name: p.name, kind: p.kind as 'personal' | 'work' | 'partner' | 'investor', cadenceDays: p.cadence }),
          ),
          apiSetSpendBudget({ ...a, weeklyBudget: budget }),
        ])
      } else if (step === 'connect') {
        // Nothing to save here — connectors bind themselves via OAuth.
      }
    } catch (error) {
      setMsg(error instanceof Error ? error.message : 'Could not save that step.')
      setBusy(false)
      return
    }
    setBusy(false)
    goto(idx)
  }

  /** Geocode free text to a lat/lon via Nominatim, like the settings sheet. */
  async function geocodePlace(query: string): Promise<{ lat: number; lon: number }> {
    const url = new URL('https://nominatim.openstreetmap.org/search')
    url.searchParams.set('q', query)
    url.searchParams.set('format', 'jsonv2')
    url.searchParams.set('limit', '1')
    const res = await fetch(url, { headers: { Accept: 'application/json' } })
    if (!res.ok) throw new Error('Could not look up that address')
    const rows = (await res.json()) as Array<{ lat?: string; lon?: string }>
    const row = rows[0]
    if (!row || !row.lat || !row.lon) throw new Error('No place found. Try a city or address.')
    return { lat: Number(row.lat), lon: Number(row.lon) }
  }

  function skip() {
    goto(idx)
  }

  async function connect(id: ConnectorId) {
    if (!email) {
      window.location.href = '/app/login'
      return
    }
    setConnecting(id)
    setMsg('')
    try {
      const url = await apiConnectUrl({
        connector: id,
        email,
        persona,
        // Land back on this same wizard screen (path plus the t/email query that
        // authenticates it) after the OAuth dance, so the user can connect more
        // tools and press Done. Without this the OAuth redirect drops them on the
        // main dashboard and they never return to the wizard.
        redirect: window.location.pathname + window.location.search,
      })
      window.location.href = url
    } catch (error) {
      setMsg(error instanceof Error ? error.message : 'Could not start connect.')
      setConnecting(null)
    }
  }

  /* Finished: mark setup complete and land on home with the one-shot tour.
   * The POST failure path matters: a stale token used to swallow the error and
   * the wizard reappeared on every menu open. Mirror the flag locally so the
   * gate clears immediately, then re-assert the server row in the background. */
  if (done) {
    void apiSetup({ persona, done: true, ...a }).catch(() => undefined)
    try {
      localStorage.setItem('ha_setup_done', persona)
      localStorage.removeItem('ha_setup_step')
    } catch {
      /* private mode: server row is the only source */
    }
    window.dispatchEvent(new Event(MINI_SETTINGS_EVENT))
    const q = window.location.search
    const joiner = q ? '&' : '?'
    return <Navigate to={`/app/mini/${persona}/home${q}${joiner}tour=1`} replace />
  }

  return (
    <div className="mini__body setup">
      <p className="setup__step">
        {idx + 1} of {STEPS.length} · {STEPS[idx]!.title}
      </p>

      {step === 'you' && (
        <div className="setup__block">
          <p className="setup__lead">
            {detectedTz ? `Alpha clocked your device and thinks you're in ${detectedTz}. That right? Add where you live and work while you're here.` : 'Your time zone and places — Alpha uses them for briefs, weather, and commute timing.'}
          </p>
          <label className="setup__row">
            <span>Time zone</span>
            <select className="setup__select" value={tz} onChange={(e) => setTz(e.target.value)}>
              {zoneOptions.map((zone) => (
                <option key={zone} value={zone}>
                  {zone}
                </option>
              ))}
            </select>
          </label>
          <input
            className="setup__text"
            type="text"
            placeholder="Where's home? (city or address)"
            value={homeQuery}
            onChange={(e) => setHomeQuery(e.target.value)}
          />
          <input
            className="setup__text"
            type="text"
            placeholder="Where do you work? (optional)"
            value={workQuery}
            onChange={(e) => setWorkQuery(e.target.value)}
          />
          {homeQuery.trim() && <p className="setup__hint">Tap Next to save {homeQuery.trim()}. Leave blank to skip.</p>}
        </div>
      )}

      {step === 'watch' && (
        <div className="setup__block">
          <p className="setup__lead">What should Alpha watch, and when should the briefs land? Pick any — change it all later.</p>
          <div className="setup__chips">
            {connectors.length ? (
              <>
                <label className="ma-chip is-pick">
                  <input type="checkbox" checked={features.includes('digest')} onChange={(e) => setFeatures((f) => (e.target.checked ? [...f, 'digest'] : f.filter((x) => x !== 'digest')))} />
                  Daily brief: your morning and evening wrap
                </label>
                <label className="ma-chip is-pick">
                  <input type="checkbox" checked={features.includes('spending_snapshot')} onChange={(e) => setFeatures((f) => (e.target.checked ? [...f, 'spending_snapshot'] : f.filter((x) => x !== 'spending_snapshot')))} />
                  Spending watch: catches duplicate and wild charges
                </label>
                <label className="ma-chip is-pick">
                  <input type="checkbox" checked={features.includes('nutrition')} onChange={(e) => setFeatures((f) => (e.target.checked ? [...f, 'nutrition'] : f.filter((x) => x !== 'nutrition')))} />
                  Nutrition: logs meals from a photo
                </label>
                <label className="ma-chip is-pick">
                  <input type="checkbox" checked={features.includes('sleep_tracker')} onChange={(e) => setFeatures((f) => (e.target.checked ? [...f, 'sleep_tracker'] : f.filter((x) => x !== 'sleep_tracker')))} />
                  Sleep: tracks bedtime and wake
                </label>
                <label className="ma-chip is-pick">
                  <input type="checkbox" checked={features.includes('habit_streak')} onChange={(e) => setFeatures((f) => (e.target.checked ? [...f, 'habit_streak'] : f.filter((x) => x !== 'habit_streak')))} />
                  Habits: streaks Alpha keeps honest
                </label>
                <label className="ma-chip is-pick">
                  <input type="checkbox" checked={features.includes('learning_queue')} onChange={(e) => setFeatures((f) => (e.target.checked ? [...f, 'learning_queue'] : f.filter((x) => x !== 'learning_queue')))} />
                  Learning queue: articles and courses saved for later
                </label>
                <label className="ma-chip is-pick">
                  <input type="checkbox" checked={features.includes('drop_zone')} onChange={(e) => setFeatures((f) => (e.target.checked ? [...f, 'drop_zone'] : f.filter((x) => x !== 'drop_zone')))} />
                  Drop zone: dump anything you'd forget, links, thoughts, to-dos, and Alpha files it and follows up
                </label>
              </>
            ) : (
              <p className="mini__hint">Features for {persona} load after you sign in.</p>
            )}
          </div>
          <label className="setup__row">
            <span>Morning brief</span>
            <input type="time" value={digestTime} onChange={(e) => setDigestTime(e.target.value)} />
          </label>
          <label className="setup__row">
            <span>Evening brief</span>
            <input type="time" value={eveningTime} onChange={(e) => setEveningTime(e.target.value)} />
          </label>
        </div>
      )}

      {step === 'body' && (
        <div className="setup__block">
          <p className="setup__lead">Rough rhythms. Alpha keeps the times and counts honest.</p>
          <label className="setup__row">
            <span>Bedtime</span>
            <input type="time" value={bedtime} onChange={(e) => setBedtime(e.target.value)} />
          </label>
          <label className="setup__row">
            <span>Wake</span>
            <input type="time" value={wake} onChange={(e) => setWake(e.target.value)} />
          </label>
          <p className="setup__hint">Which days do you train? Tap to change.</p>
          <div className="wk-days" role="group" aria-label="Workout days">
            {([0, 1, 2, 3, 4, 5, 6] as WorkoutDay[]).map((day) => (
              <button
                key={day}
                className={`wk-day${days.includes(day) ? ' is-on' : ''}`}
                type="button"
                aria-pressed={days.includes(day)}
                aria-label={WORKOUT_DAY_LABELS_ALL[day]}
                onClick={() =>
                  setDays((prev) => {
                    const has = prev.includes(day)
                    if (has && prev.length <= 1) return prev
                    return has ? prev.filter((d) => d !== day) : [...prev, day]
                  })
                }
              >
                {WORKOUT_DAY_LETTERS_ALL[day]}
              </button>
            ))}
          </div>
          <label className="setup__row">
            <span>Calories</span>
            <input type="number" inputMode="numeric" value={calories} onChange={(e) => setCalories(Number(e.target.value) || 0)} />
          </label>
          <label className="setup__row">
            <span>Protein (g)</span>
            <input type="number" inputMode="numeric" value={protein} onChange={(e) => setProtein(Number(e.target.value) || 0)} />
          </label>
        </div>
      )}

      {step === 'people' && (
        <div className="setup__block">
          <p className="setup__lead">Who should Alpha nudge you to stay close to? Add anyone — then tap Next when done.</p>
          <div className="setup__people-row">
            <input className="setup__text" type="text" placeholder="Name (e.g. Mom, Priya, Jordan)" value={personName} onChange={(e) => setPersonName(e.target.value)} />
            <button
              type="button"
              className="wk-act"
              disabled={!personName.trim()}
              onClick={() => {
                const name = personName.trim()
                if (!name) return
                setPeople((p) => [...p, { name, kind: personKind, cadence: personCadence }])
                setPersonName('')
              }}
            >
              Add
            </button>
          </div>
          {people.length > 0 && (
            <div className="setup__people-list">
              {people.map((p, i) => (
                <span key={`${p.name}-${i}`} className="ma-chip is-pick">
                  {p.name}
                  <button type="button" className="setup__x" aria-label={`Remove ${p.name}`} onClick={() => setPeople((list) => list.filter((_, idx) => idx !== i))}>
                    ×
                  </button>
                </span>
              ))}
            </div>
          )}
          <div className="setup__chips">
            {(['personal', 'work', 'partner', 'investor'] as const).map((k) => (
              <button key={k} className={`ma-chip${personKind === k ? ' ma-chip--on' : ''}`} type="button" onClick={() => setPersonKind(k)}>
                {k}
              </button>
            ))}
          </div>
          <label className="setup__row">
            <span>Check in every</span>
            <select className="setup__select" value={personCadence} onChange={(e) => setPersonCadence(Number(e.target.value))}>
              <option value={1}>daily</option>
              <option value={2}>every 2 days</option>
              <option value={3}>twice a week</option>
              <option value={7}>week</option>
              <option value={14}>2 weeks</option>
              <option value={30}>month</option>
            </select>
          </label>
          <label className="setup__row">
            <span>Weekly budget</span>
            <input type="number" inputMode="decimal" value={budget} onChange={(e) => setBudget(Number(e.target.value) || 0)} />
          </label>
          <p className="setup__hint">Alpha flags when a purchase would break your weekly budget.</p>
        </div>
      )}

      {step === 'connect' && (
        <div className="setup__block">
          <p className="setup__lead">
            {onCount}/{connectors.length} on. Connect Google for mail and calendar — the biggest upgrade.
          </p>
          <ul className="habit-list conn-list">
            {connectors.map((c) => {
              const on = c.noAuth || ids.includes(c.id)
              return (
                <li key={c.id} className="habit-card conn-row">
                  <ConnectorLogo id={c.id} />
                  <div className="habit-info">
                    <div className="habit-name">{c.name}</div>
                    <div className="habit-streak">{c.blurb}</div>
                  </div>
                  {on ? (
                    <span className="ma-chip">On</span>
                  ) : (
                    <button className="wk-act" type="button" disabled={connecting === c.id} onClick={() => void connect(c.id)}>
                      {connecting === c.id ? 'Opening' : 'Connect'}
                    </button>
                  )}
                </li>
              )
            })}
          </ul>
        </div>
      )}

      {msg && <p className="mini__hint">{msg}</p>}
      <div className="setup__nav">
        <button className="wk-act" type="button" onClick={skip}>
          Skip
        </button>
        <button className="ma-btn" type="button" disabled={busy} onClick={() => void next()}>
          {busy ? 'Saving…' : step === 'connect' ? 'Done' : 'Next'}
        </button>
      </div>
    </div>
  )
}
