import { useEffect, useState } from 'react'
import { Navigate } from 'react-router-dom'
import {
  apiAddRelationship,
  apiConnectUrl,
  apiGetMiniPrefs,
  apiNutritionToday,
  apiPutMiniPrefs,
  apiSetDigestTime,
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

/** Onboarding wizard shown in the menu card while setup is incomplete. */
export function SetupApp({ auth }: { auth: FeatureAuth }) {
  const persona = auth.persona
  const email = auth.email || getSession()?.email

  type Step = 'features' | 'time' | 'goals' | 'sleep' | 'days' | 'people' | 'budget' | 'connect'
  const STEPS: { id: Step; title: string }[] = [
    { id: 'features', title: 'What Alpha watches' },
    { id: 'time', title: 'Daily brief time' },
    { id: 'goals', title: 'Food goals' },
    { id: 'sleep', title: 'Sleep' },
    { id: 'days', title: 'Workout days' },
    { id: 'people', title: 'People who matter' },
    { id: 'budget', title: 'Weekly spend' },
    { id: 'connect', title: 'Connect tools' },
  ]
  const [step, setStep] = useState<Step>('features')
  const idx = STEPS.findIndex((s) => s.id === step)

  const [features, setFeatures] = useState<string[]>([])
  const [digestTime, setDigestTime] = useState('08:00')
  const [calories, setCalories] = useState(2200)
  const [protein, setProtein] = useState(150)
  const [bedtime, setBedtime] = useState('23:00')
  const [wake, setWake] = useState('07:00')
  const [days, setDays] = useState<WorkoutDay[]>(() => readWorkoutDays() || [0, 1, 2, 3, 4])
  const [personName, setPersonName] = useState('')
  const [personKind, setPersonKind] = useState('personal')
  const [personCadence, setPersonCadence] = useState(14)
  const [budget, setBudget] = useState(400)
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

  async function next() {
    setMsg('')
    setBusy(true)
    try {
      if (step === 'features') {
        const f = features.length ? features : ['digest']
        await apiSetup({ persona, features: f, ...a })
        if (features.includes('digest')) await apiSetDigestTime({ persona, time: digestTime, ...a })
      } else if (step === 'time') {
        await apiSetDigestTime({ persona, time: digestTime, ...a })
      } else if (step === 'goals') {
        await apiSetNutritionGoals({ ...a, calorieGoal: calories, proteinGoal: protein })
      } else if (step === 'sleep') {
        await apiPutMiniPrefs({ ...a, sleepBedtime: bedtime, sleepWake: wake })
      } else if (step === 'days') {
        writeWorkoutDays(days)
        await apiPutMiniPrefs({ ...a, workoutDays: days })
      } else if (step === 'people') {
        const name = personName.trim()
        if (name) {
          await apiAddRelationship({ ...a, name, kind: personKind, cadenceDays: personCadence })
        }
      } else if (step === 'budget') {
        await apiSetSpendBudget({ ...a, weeklyBudget: budget })
      }
    } catch (error) {
      setMsg(error instanceof Error ? error.message : 'Could not save that step.')
      setBusy(false)
      return
    }
    setBusy(false)
    const i = STEPS.findIndex((s) => s.id === step)
    if (i < STEPS.length - 1) setStep(STEPS[i + 1]!.id)
    else setDone(true)
  }

  function skip() {
    const i = STEPS.findIndex((s) => s.id === step)
    if (i < STEPS.length - 1) setStep(STEPS[i + 1]!.id)
    else setDone(true)
  }

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

  /* Finished: mark setup complete and land on the home screen. */
  if (done) {
    void apiSetup({ persona, done: true, ...a }).catch(() => undefined)
    window.dispatchEvent(new Event(MINI_SETTINGS_EVENT))
    const q = window.location.search
    return <Navigate to={`/app/mini/${persona}/home${q}`} replace />
  }

  return (
    <div className="mini__body setup">
      <p className="setup__step">
        {idx + 1} of {STEPS.length} · {STEPS[idx]!.title}
      </p>

      {step === 'features' && (
        <div className="setup__block">
          <p className="setup__lead">What should Alpha watch for you? Pick any — you can change this later.</p>
          <div className="setup__chips">
            {connectors.length ? (
              <>
                <label className="ma-chip is-pick">
                  <input type="checkbox" checked={features.includes('digest')} onChange={(e) => setFeatures((f) => (e.target.checked ? [...f, 'digest'] : f.filter((x) => x !== 'digest')))} />
                  Daily brief — your morning and evening wrap
                </label>
                <label className="ma-chip is-pick">
                  <input type="checkbox" checked={features.includes('spending_snapshot')} onChange={(e) => setFeatures((f) => (e.target.checked ? [...f, 'spending_snapshot'] : f.filter((x) => x !== 'spending_snapshot')))} />
                  Spending watch — catches duplicate and wild charges
                </label>
                <label className="ma-chip is-pick">
                  <input type="checkbox" checked={features.includes('nutrition')} onChange={(e) => setFeatures((f) => (e.target.checked ? [...f, 'nutrition'] : f.filter((x) => x !== 'nutrition')))} />
                  Food + macros — logs meals from a photo
                </label>
                <label className="ma-chip is-pick">
                  <input type="checkbox" checked={features.includes('habit_streak')} onChange={(e) => setFeatures((f) => (e.target.checked ? [...f, 'habit_streak'] : f.filter((x) => x !== 'habit_streak')))} />
                  Habits — streaks Alpha keeps honest
                </label>
                <label className="ma-chip is-pick">
                  <input type="checkbox" checked={features.includes('learning_queue')} onChange={(e) => setFeatures((f) => (e.target.checked ? [...f, 'learning_queue'] : f.filter((x) => x !== 'learning_queue')))} />
                  Learning queue — articles and courses saved for later
                </label>
                <label className="ma-chip is-pick">
                  <input type="checkbox" checked={features.includes('drop_zone')} onChange={(e) => setFeatures((f) => (e.target.checked ? [...f, 'drop_zone'] : f.filter((x) => x !== 'drop_zone')))} />
                  Drop zone — text anything, Alpha files it and follows up
                </label>
              </>
            ) : (
              <p className="mini__hint">Features for {persona} load after you sign in.</p>
            )}
          </div>
        </div>
      )}

      {step === 'time' && (
        <div className="setup__block">
          <p className="setup__lead">When should the daily brief land? Alpha texts the morning wrap then.</p>
          <label className="setup__row">
            <span>Brief time</span>
            <input type="time" value={digestTime} onChange={(e) => setDigestTime(e.target.value)} />
          </label>
        </div>
      )}

      {step === 'goals' && (
        <div className="setup__block">
          <p className="setup__lead">Daily food targets. Alpha logs meals and keeps the count.</p>
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

      {step === 'sleep' && (
        <div className="setup__block">
          <p className="setup__lead">Rough sleep times. Alpha uses them for your briefs and wind-down.</p>
          <label className="setup__row">
            <span>Bedtime</span>
            <input type="time" value={bedtime} onChange={(e) => setBedtime(e.target.value)} />
          </label>
          <label className="setup__row">
            <span>Wake</span>
            <input type="time" value={wake} onChange={(e) => setWake(e.target.value)} />
          </label>
        </div>
      )}

      {step === 'days' && (
        <div className="setup__block">
          <p className="setup__lead">Which days do you train? Tap to change.</p>
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
        </div>
      )}

      {step === 'people' && (
        <div className="setup__block">
          <p className="setup__lead">Who should Alpha nudge you to stay close to? Add one — or skip and do this later.</p>
          <input className="setup__text" type="text" placeholder="Name (e.g. Mom, Priya, Jordan)" value={personName} onChange={(e) => setPersonName(e.target.value)} />
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
              <option value={7}>week</option>
              <option value={14}>2 weeks</option>
              <option value={30}>month</option>
            </select>
          </label>
        </div>
      )}

      {step === 'budget' && (
        <div className="setup__block">
          <p className="setup__lead">Weekly spend limit. Alpha flags when a purchase would break it.</p>
          <label className="setup__row">
            <span>Weekly budget</span>
            <input type="number" inputMode="decimal" value={budget} onChange={(e) => setBudget(Number(e.target.value) || 0)} />
          </label>
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
