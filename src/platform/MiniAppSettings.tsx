import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import {
  apiConnectUrl,
  apiGetMiniPrefs,
  apiListSpending,
  apiNutritionToday,
  apiPutMiniPrefs,
  apiSetNutritionGoals,
  apiSetSpendBudget,
} from './api'
import { ConnectorLogo } from './ConnectorLogo'
import { connectorsForHire, type ConnectorId } from './connectors'
import type { FeatureAuth } from './FeatureMiniApps'
import { connectedIds, getSession, hydrateFromServer } from './roster'
import { readWorkoutPlace, writeWorkoutPlace, readWorkoutMoveCount, writeWorkoutMoveCount, type WorkoutMoveCount, type WorkoutPlace } from './workoutProgram'

export const MINI_SETTINGS_EVENT = 'hire-mini-settings'

function pingSettingsSaved() {
  window.dispatchEvent(new Event(MINI_SETTINGS_EVENT))
}

function formatClock12(hhmm: string) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm.trim())
  if (!m) return hhmm
  let h = Number(m[1])
  const min = Number(m[2])
  if (!Number.isFinite(h) || !Number.isFinite(min) || h > 23 || min > 59) return hhmm
  const mer = h >= 12 ? 'PM' : 'AM'
  h = h % 12
  if (h === 0) h = 12
  return `${h}:${String(min).padStart(2, '0')} ${mer}`
}

const SETTING_APPS = ['nutrition', 'workout_log', 'sleep_tracker', 'spending_snapshot'] as const

export function MiniAppSettings({
  auth,
  focusKind,
  onClose,
}: {
  auth: FeatureAuth
  focusKind?: string
  onClose: () => void
}) {
  const showAll = !focusKind || focusKind === 'apps' || focusKind === 'menu'
  const only = showAll ? SETTING_APPS : SETTING_APPS.filter((k) => k === focusKind)
  const known = only.length > 0

  return (
    <div className="ma mini-set">
      <div className="ma-hero">
        <span className="ma-hero-kicker">Settings</span>
        <span className="ma-hero-num">{showAll ? 'Your apps' : 'This app'}</span>
        <span className="ma-hero-label">
          {known
            ? 'Change goals, connectors, place, sleep times, and budget. Saved on this phone and your account.'
            : 'Connect tools on the website. This app has no extra settings.'}
        </span>
      </div>

      <ConnectorSettings auth={auth} />
      {only.includes('nutrition') && <NutritionSettings auth={auth} />}
      {only.includes('workout_log') && <WorkoutSettings auth={auth} />}
      {only.includes('sleep_tracker') && <SleepSettings auth={auth} />}
      {only.includes('spending_snapshot') && <SpendSettings auth={auth} />}

      <button className="ma-btn ma-btn--quiet ma-btn--block" type="button" onClick={onClose}>
        Done
      </button>
    </div>
  )
}

function ConnectorSettings({ auth }: { auth: FeatureAuth }) {
  const persona = auth.persona
  const connectors = connectorsForHire(persona)
  const [ids, setIds] = useState<ConnectorId[]>(() => connectedIds())
  const [connecting, setConnecting] = useState<ConnectorId | null>(null)
  const [msg, setMsg] = useState('')
  const email = auth.email || getSession()?.email
  const siteHref = `/app/hires/${persona}`

  useEffect(() => {
    void hydrateFromServer()
      .then(() => setIds(connectedIds()))
      .catch(() => undefined)
  }, [email])

  async function connect(id: ConnectorId) {
    if (!email) {
      window.location.href = '/app/login'
      return
    }
    setConnecting(id)
    setMsg('')
    try {
      const url = await apiConnectUrl({ connector: id, email, persona })
      window.location.href = url
    } catch (error) {
      setMsg(error instanceof Error ? error.message : 'Could not start connect.')
      setConnecting(null)
    }
  }

  const onCount = connectors.filter((c) => ids.includes(c.id)).length

  return (
    <section className="mini-set__block">
      <h2>Connectors</h2>
      <p>
        {onCount}/{connectors.length} on. Tap Connect here. Open the website if a tool needs a longer setup.
      </p>
      <Link className="ma-btn ma-btn--block" to={siteHref}>
        Open website
      </Link>
      <ul className="habit-list conn-list">
        {connectors.map((c) => {
          const on = ids.includes(c.id)
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
                <button
                  className="wk-act"
                  type="button"
                  disabled={connecting === c.id}
                  onClick={() => void connect(c.id)}
                >
                  {connecting === c.id ? 'Opening' : 'Connect'}
                </button>
              )}
            </li>
          )
        })}
      </ul>
      {msg && <p className="mini__hint">{msg}</p>}
    </section>
  )
}

function NutritionSettings({ auth }: { auth: FeatureAuth }) {
  const [calories, setCalories] = useState(2200)
  const [protein, setProtein] = useState(150)
  const [carbs, setCarbs] = useState(220)
  const [fat, setFat] = useState(70)
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState('')

  useEffect(() => {
    apiNutritionToday(auth)
      .then((d) => {
        if (!d.goals) return
        setCalories(d.goals.calorieGoal)
        setProtein(d.goals.proteinGoal)
        setCarbs(d.goals.carbsGoal)
        setFat(d.goals.fatGoal)
      })
      .catch(() => setMsg('Could not load nutrition goals.'))
  }, [auth.email, auth.token])

  async function save() {
    if (busy) return
    setBusy(true)
    setMsg('')
    try {
      await apiSetNutritionGoals({
        ...auth,
        calorieGoal: calories,
        proteinGoal: protein,
        carbsGoal: carbs,
        fatGoal: fat,
      })
      pingSettingsSaved()
      setMsg('Nutrition goals saved.')
    } catch (error) {
      setMsg(error instanceof Error ? error.message : 'Could not save goals.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="mini-set__block">
      <h2>Nutrition</h2>
      <p>Daily targets for the ring and macros.</p>
      <div className="mini-set__grid">
        <label>
          <span>Calories</span>
          <input inputMode="numeric" value={calories} onChange={(e) => setCalories(Number(e.target.value) || 0)} />
        </label>
        <label>
          <span>Protein g</span>
          <input inputMode="numeric" value={protein} onChange={(e) => setProtein(Number(e.target.value) || 0)} />
        </label>
        <label>
          <span>Carbs g</span>
          <input inputMode="numeric" value={carbs} onChange={(e) => setCarbs(Number(e.target.value) || 0)} />
        </label>
        <label>
          <span>Fat g</span>
          <input inputMode="numeric" value={fat} onChange={(e) => setFat(Number(e.target.value) || 0)} />
        </label>
      </div>
      <button className="ma-btn" type="button" disabled={busy} onClick={() => void save()}>
        Save nutrition
      </button>
      {msg && <p className="mini__hint">{msg}</p>}
    </section>
  )
}

function WorkoutSettings({ auth }: { auth: FeatureAuth }) {
  const [place, setPlace] = useState<WorkoutPlace>(() => readWorkoutPlace())
  const [moveCount, setMoveCount] = useState<WorkoutMoveCount>(() => readWorkoutMoveCount())
  const [msg, setMsg] = useState('')

  useEffect(() => {
    apiGetMiniPrefs(auth)
      .then((p) => {
        setPlace(p.workoutPlace)
        writeWorkoutPlace(p.workoutPlace)
        if (p.workoutMoveCount === 4 || p.workoutMoveCount === 5 || p.workoutMoveCount === 6) {
          setMoveCount(p.workoutMoveCount)
          writeWorkoutMoveCount(p.workoutMoveCount)
        }
      })
      .catch(() => setMsg('Could not load workout settings.'))
  }, [auth.email, auth.token])

  async function pick(next: WorkoutPlace) {
    setPlace(next)
    writeWorkoutPlace(next)
    pingSettingsSaved()
    try {
      await apiPutMiniPrefs({ ...auth, workoutPlace: next })
    } catch (error) {
      setMsg(error instanceof Error ? error.message : 'Could not save workout place.')
    }
  }

  async function pickMoves(next: WorkoutMoveCount) {
    setMoveCount(next)
    writeWorkoutMoveCount(next)
    pingSettingsSaved()
    try {
      await apiPutMiniPrefs({ ...auth, workoutMoveCount: next })
    } catch (error) {
      setMsg(error instanceof Error ? error.message : 'Could not save move count.')
    }
  }

  return (
    <section className="mini-set__block">
      <h2>Workout</h2>
      <p>Monday through Friday plan. Home is bodyweight and dumbbells. Gym is barbell and machines.</p>
      <div className="wk-places">
        <button className={`wk-place${place === 'home' ? ' is-on' : ''}`} type="button" onClick={() => void pick('home')}>
          Home
        </button>
        <button className={`wk-place${place === 'gym' ? ' is-on' : ''}`} type="button" onClick={() => void pick('gym')}>
          Gym
        </button>
      </div>
      <p>Moves per day. 4 is a short session. 6 is the full day.</p>
      <div className="wk-counts">
        {([4, 5, 6] as const).map((n) => (
          <button
            key={n}
            className={`wk-place${moveCount === n ? ' is-on' : ''}`}
            type="button"
            aria-pressed={moveCount === n}
            onClick={() => void pickMoves(n)}
          >
            {n}
          </button>
        ))}
      </div>
      {msg && <p className="mini__hint">{msg}</p>}
    </section>
  )
}

function SleepSettings({ auth }: { auth: FeatureAuth }) {
  const [bedtime, setBedtime] = useState('23:00')
  const [wake, setWake] = useState('07:00')
  const [msg, setMsg] = useState('')

  useEffect(() => {
    apiGetMiniPrefs(auth)
      .then((p) => {
        if (p.sleepBedtime) setBedtime(p.sleepBedtime)
        if (p.sleepWake) setWake(p.sleepWake)
      })
      .catch(() => setMsg('Could not load sleep times.'))
  }, [auth.email, auth.token])

  async function saveTimes(nextBed: string, nextWake: string) {
    setBedtime(nextBed)
    setWake(nextWake)
    pingSettingsSaved()
    try {
      await apiPutMiniPrefs({ ...auth, sleepBedtime: nextBed, sleepWake: nextWake })
      setMsg('')
    } catch (error) {
      setMsg(error instanceof Error ? error.message : 'Could not save sleep times.')
    }
  }

  return (
    <section className="mini-set__block">
      <h2>Sleep</h2>
      <p>Usual bed and wake. Used when you log last night.</p>
      <div className="mini-set__grid">
        <label>
          <span>Bed {formatClock12(bedtime)}</span>
          <input type="time" value={bedtime} onChange={(e) => void saveTimes(e.target.value, wake)} />
        </label>
        <label>
          <span>Wake {formatClock12(wake)}</span>
          <input type="time" value={wake} onChange={(e) => void saveTimes(bedtime, e.target.value)} />
        </label>
      </div>
      {msg && <p className="mini__hint">{msg}</p>}
    </section>
  )
}

function SpendSettings({ auth }: { auth: FeatureAuth }) {
  const [budget, setBudget] = useState(400)
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState('')

  useEffect(() => {
    apiListSpending(auth)
      .then((d) => setBudget(d.weeklyBudget))
      .catch(() => setMsg('Could not load budget.'))
  }, [auth.email, auth.token])

  async function save() {
    if (busy || budget <= 0) return
    setBusy(true)
    setMsg('')
    try {
      await apiSetSpendBudget({ ...auth, weeklyBudget: budget })
      pingSettingsSaved()
      setMsg('Weekly budget saved.')
    } catch (error) {
      setMsg(error instanceof Error ? error.message : 'Could not save budget.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="mini-set__block">
      <h2>Spending</h2>
      <p>Weekly budget. Over shows red on the card.</p>
      <label className="mini-set__field">
        <span>Weekly budget</span>
        <input inputMode="decimal" value={budget} onChange={(e) => setBudget(Number(e.target.value) || 0)} />
      </label>
      <button className="ma-btn" type="button" disabled={busy || budget <= 0} onClick={() => void save()}>
        Save budget
      </button>
      {msg && <p className="mini__hint">{msg}</p>}
    </section>
  )
}
