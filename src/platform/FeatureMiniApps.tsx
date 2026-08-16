import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react'
import type { AgentId } from '../agents/types'
import {
  apiAddDecision,
  apiAddDrop,
  apiAddHabit,
  apiAddLoop,
  apiAddMeeting,
  apiAddRelationship,
  apiAnalyzeNutrition,
  apiDeleteHabit,
  apiDeleteNutritionLog,
  apiListDecisions,
  apiListDrops,
  apiListHabits,
  apiListLoops,
  apiListMeetings,
  apiListMoods,
  apiListRelationships,
  apiLogMood,
  apiLogNutrition,
  apiNutritionToday,
  apiPatchLoop,
  apiReviewDecision,
  apiSetNutritionGoals,
  apiTouchRelationship,
  apiToggleHabit,
  type Decision,
  type Drop,
  type Habit,
  type Meeting,
  type MoodEntry,
  type NutritionGoals,
  type NutritionLog,
  type OpenLoop,
  type Relationship,
} from './api'

export interface FeatureAuth {
  email?: string
  token?: string
  persona: AgentId
}

function fmtWhen(iso: string | null | undefined): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}

function useAuthed(auth: FeatureAuth) {
  return { email: auth.email, token: auth.token }
}

/* ------------------------------ Open Loops ------------------------------ */

export function OpenLoopsApp({ auth }: { auth: FeatureAuth }) {
  const a = useAuthed(auth)
  const [loops, setLoops] = useState<OpenLoop[]>([])
  const [title, setTitle] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')

  const load = useCallback(() => {
    apiListLoops(a).then((d) => setLoops(d.loops)).catch(() => setErr('Could not load loops.'))
  }, [a.email, a.token])

  useEffect(() => {
    load()
  }, [load])

  async function add(e: FormEvent) {
    e.preventDefault()
    if (!title.trim() || busy) return
    setBusy(true)
    setErr('')
    try {
      await apiAddLoop({ ...a, title: title.trim() })
      setTitle('')
      load()
    } catch (error) {
      setErr(error instanceof Error ? error.message : 'Could not add that.')
    } finally {
      setBusy(false)
    }
  }

  async function setStatus(id: string, status: string) {
    await apiPatchLoop({ ...a, id, status }).catch(() => undefined)
    load()
  }

  const open = loops.filter((l) => l.status === 'open')
  const done = loops.filter((l) => l.status !== 'open')

  return (
    <div>
      <form className="mini__form" onSubmit={add}>
        <input
          className="mini__input"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="Something you said you'd do…"
          aria-label="New open loop"
        />
        <button className="mini__btn" type="submit" disabled={busy || !title.trim()}>
          Add
        </button>
      </form>
      {err && <p className="mini__empty">{err}</p>}

      <section className="mini__section">
        <h2>Open</h2>
        {open.length ? (
          <ul className="mini__list">
            {open.map((l) => (
              <li key={l.id} className="mini__row">
                <span className="mini__row-main">
                  <span className="mini__row-title">{l.title}</span>
                  {l.dueAt && <span className="mini__row-sub">due {fmtWhen(l.dueAt)}</span>}
                </span>
                <button className="mini__chip" type="button" onClick={() => setStatus(l.id, 'done')}>
                  Done
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="mini__empty">No open loops. Nothing slipping.</p>
        )}
      </section>

      {done.length > 0 && (
        <section className="mini__section">
          <h2>Closed</h2>
          <ul className="mini__list">
            {done.slice(0, 8).map((l) => (
              <li key={l.id} className="mini__row mini__row-muted">
                <span className="mini__row-title">{l.title}</span>
                <button className="mini__chip" type="button" onClick={() => setStatus(l.id, 'open')}>
                  Reopen
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  )
}

/* ---------------------------- Decision Ledger --------------------------- */

export function DecisionLedgerApp({ auth }: { auth: FeatureAuth }) {
  const a = useAuthed(auth)
  const [decisions, setDecisions] = useState<Decision[]>([])
  const [decision, setDecision] = useState('')
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')

  const load = useCallback(() => {
    apiListDecisions(a).then((d) => setDecisions(d.decisions)).catch(() => setErr('Could not load decisions.'))
  }, [a.email, a.token])

  useEffect(() => {
    load()
  }, [load])

  async function add(e: FormEvent) {
    e.preventDefault()
    if (!decision.trim() || busy) return
    setBusy(true)
    setErr('')
    try {
      await apiAddDecision({ ...a, decision: decision.trim(), reason: reason.trim() })
      setDecision('')
      setReason('')
      load()
    } catch (error) {
      setErr(error instanceof Error ? error.message : 'Could not save that.')
    } finally {
      setBusy(false)
    }
  }

  async function markOutcome(id: string, outcome: string) {
    if (busy) return
    setBusy(true)
    setErr('')
    try {
      await apiReviewDecision({ ...a, id, outcome })
      load()
    } catch (error) {
      setErr(error instanceof Error ? error.message : 'Could not update that.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div>
      <form className="mini__form mini__form-stack" onSubmit={add}>
        <input
          className="mini__input"
          value={decision}
          onChange={(e) => setDecision(e.target.value)}
          placeholder="The decision…"
          aria-label="Decision"
        />
        <input
          className="mini__input"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder="Why (optional)"
          aria-label="Reason"
        />
        <button className="mini__btn" type="submit" disabled={busy || !decision.trim()}>
          Log it
        </button>
      </form>
      {err && <p className="mini__empty">{err}</p>}

      <section className="mini__section">
        <h2>On the ledger</h2>
        {decisions.length ? (
          <ul className="mini__list">
            {decisions.map((d) => (
              <li key={d.id} className="mini__card-item">
                <span className="mini__row-title">{d.decision}</span>
                {d.reason && <span className="mini__row-sub">{d.reason}</span>}
                <span className="mini__row-sub">
                  {d.status === 'reviewed' ? `Reviewed · ${d.outcome || ''}` : `Logged ${fmtWhen(d.createdAt)}`}
                </span>
                {d.status !== 'reviewed' && (
                  <span className="mini__row-actions">
                    <button type="button" className="mini__chip mini__chip--green" disabled={busy} onClick={() => void markOutcome(d.id, 'worked')}>
                      Worked
                    </button>
                    <button type="button" className="mini__chip" disabled={busy} onClick={() => void markOutcome(d.id, 'did not work')}>
                      Didn't work
                    </button>
                  </span>
                )}
              </li>
            ))}
          </ul>
        ) : (
          <p className="mini__empty">No decisions logged yet.</p>
        )}
      </section>
    </div>
  )
}

/* --------------------------- Relationship Radar ------------------------- */

export function RelationshipRadarApp({ auth }: { auth: FeatureAuth }) {
  const a = useAuthed(auth)
  const [people, setPeople] = useState<Relationship[]>([])
  const [name, setName] = useState('')
  const [kind, setKind] = useState('personal')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')

  const load = useCallback(() => {
    apiListRelationships(a).then((d) => setPeople(d.relationships)).catch(() => setErr('Could not load people.'))
  }, [a.email, a.token])

  useEffect(() => {
    load()
  }, [load])

  async function add(e: FormEvent) {
    e.preventDefault()
    if (!name.trim() || busy) return
    setBusy(true)
    setErr('')
    try {
      await apiAddRelationship({ ...a, name: name.trim(), kind })
      setName('')
      load()
    } catch (error) {
      setErr(error instanceof Error ? error.message : 'Could not add that.')
    } finally {
      setBusy(false)
    }
  }

  async function touch(id: string) {
    await apiTouchRelationship({ ...a, id }).catch(() => undefined)
    load()
  }

  const due = people.filter((p) => {
    if (!p.lastTouchAt) return true
    const days = (Date.now() - new Date(p.lastTouchAt).getTime()) / 86400000
    return days >= p.cadenceDays
  })

  return (
    <div>
      <form className="mini__form" onSubmit={add}>
        <input
          className="mini__input"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Who matters?"
          aria-label="Person name"
        />
        <select className="mini__input mini__select" value={kind} onChange={(e) => setKind(e.target.value)} aria-label="Kind">
          <option value="personal">Personal</option>
          <option value="work">Work</option>
          <option value="investor">Investor</option>
          <option value="candidate">Candidate</option>
          <option value="partner">Partner</option>
        </select>
        <button className="mini__btn" type="submit" disabled={busy || !name.trim()}>
          Add
        </button>
      </form>
      {err && <p className="mini__empty">{err}</p>}

      <section className="mini__section">
        <h2>Time to reach out</h2>
        {due.length ? (
          <ul className="mini__list">
            {due.map((p) => (
              <li key={p.id} className="mini__row">
                <span className="mini__row-main">
                  <span className="mini__row-title">{p.name}</span>
                  <span className="mini__row-sub">
                    {p.kind} · {p.lastTouchAt ? `last ${fmtWhen(p.lastTouchAt)}` : 'never touched'}
                  </span>
                </span>
                <button className="mini__chip" type="button" onClick={() => touch(p.id)}>
                  Touched
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="mini__empty">Everyone's covered. Nice.</p>
        )}
      </section>

      {people.length > due.length && (
        <section className="mini__section">
          <h2>Everyone</h2>
          <ul className="mini__list">
            {people.map((p) => (
              <li key={p.id} className="mini__row mini__row-muted">
                <span className="mini__row-main">
                  <span className="mini__row-title">{p.name}</span>
                  <span className="mini__row-sub">{p.kind}</span>
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  )
}

/* ------------------------------ Alpha Drop Zone ------------------------- */

export function DropZoneApp({ auth }: { auth: FeatureAuth }) {
  const a = useAuthed(auth)
  const [drops, setDrops] = useState<Drop[]>([])
  const [content, setContent] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')

  const load = useCallback(() => {
    apiListDrops(a).then((d) => setDrops(d.drops)).catch(() => setErr('Could not load drops.'))
  }, [a.email, a.token])

  useEffect(() => {
    load()
  }, [load])

  async function add(e: FormEvent) {
    e.preventDefault()
    if (!content.trim() || busy) return
    setBusy(true)
    setErr('')
    try {
      await apiAddDrop({ ...a, content: content.trim() })
      setContent('')
      load()
    } catch (error) {
      setErr(error instanceof Error ? error.message : 'Could not drop that.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div>
      <form className="mini__form mini__form-stack" onSubmit={add}>
        <textarea
          className="mini__input mini__textarea"
          value={content}
          onChange={(e) => setContent(e.target.value)}
          placeholder="Dump anything here. A thought, a link, a task, an idea…"
          aria-label="Drop content"
          rows={3}
        />
        <button className="mini__btn" type="submit" disabled={busy || !content.trim()}>
          Drop it
        </button>
      </form>
      {err && <p className="mini__empty">{err}</p>}

      <section className="mini__section">
        <h2>In the zone</h2>
        {drops.length ? (
          <ul className="mini__list">
            {drops.map((d) => (
              <li key={d.id} className="mini__card-item">
                <span className="mini__row-title">{d.content}</span>
                <span className="mini__row-sub">
                  {d.status === 'new' ? 'Unsorted' : d.status} · {fmtWhen(d.createdAt)}
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="mini__empty">Nothing dropped yet. Send anything messy.</p>
        )}
      </section>
    </div>
  )
}

/* ------------------------------ Meeting Mode ---------------------------- */

export function MeetingModeApp({ auth }: { auth: FeatureAuth }) {
  const a = useAuthed(auth)
  const [meetings, setMeetings] = useState<Meeting[]>([])
  const [title, setTitle] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')

  const load = useCallback(() => {
    apiListMeetings(a).then((d) => setMeetings(d.meetings)).catch(() => setErr('Could not load meetings.'))
  }, [a.email, a.token])

  useEffect(() => {
    load()
  }, [load])

  async function add(e: FormEvent) {
    e.preventDefault()
    if (!title.trim() || busy) return
    setBusy(true)
    setErr('')
    try {
      await apiAddMeeting({ ...a, title: title.trim() })
      setTitle('')
      load()
    } catch (error) {
      setErr(error instanceof Error ? error.message : 'Could not add that.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div>
      <form className="mini__form" onSubmit={add}>
        <input
          className="mini__input"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="Meeting you want prepped…"
          aria-label="Meeting title"
        />
        <button className="mini__btn" type="submit" disabled={busy || !title.trim()}>
          Prep
        </button>
      </form>
      {err && <p className="mini__empty">{err}</p>}

      <section className="mini__section">
        <h2>Meetings</h2>
        {meetings.length ? (
          <ul className="mini__list">
            {meetings.map((m) => (
              <li key={m.id} className="mini__card-item">
                <span className="mini__row-title">{m.title}</span>
                <span className="mini__row-sub">{m.phase === 'done' ? 'Wrapped' : 'Prepping'}</span>
                {m.briefing && <span className="mini__row-sub">{m.briefing}</span>}
              </li>
            ))}
          </ul>
        ) : (
          <p className="mini__empty">No meetings yet. Add one to get a brief.</p>
        )}
      </section>
    </div>
  )
}

/* -------------------------------- Nutrition ----------------------------- */

const QUICK_ADD = [
  { label: '💧 Water', desc: '1 glass of water', cal: 0, p: 0, c: 0, f: 0 },
  { label: '☕ Coffee', desc: '1 cup black coffee', cal: 5, p: 0, c: 0, f: 0 },
] as const

function CalorieRing({ current, goal }: { current: number; goal: number }) {
  const pct = goal > 0 ? Math.min(100, Math.round((current / goal) * 100)) : 0
  const r = 58
  const circ = 2 * Math.PI * r
  const offset = circ - (pct / 100) * circ

  return (
    <div className="nutr-ring-wrap">
      <svg className="nutr-ring" viewBox="0 0 132 132">
        <circle cx="66" cy="66" r={r} fill="none" stroke="var(--border)" strokeWidth="10" />
        <circle
          cx="66" cy="66" r={r} fill="none"
          stroke="var(--mini-accent, #22c55e)"
          strokeWidth="10"
          strokeLinecap="round"
          strokeDasharray={circ}
          strokeDashoffset={offset}
          className="nutr-ring-progress"
        />
      </svg>
      <div className="nutr-ring-label">
        <span className="nutr-ring-num">{Math.round(current)}</span>
        <span className="nutr-ring-unit">/ {goal} cal</span>
      </div>
    </div>
  )
}

function MacroPill({ label, current, goal, color }: { label: string; current: number; goal: number; color: string }) {
  const pct = goal > 0 ? Math.min(100, Math.round((current / goal) * 100)) : 0
  return (
    <div className="nutr-pill">
      <div className="nutr-pill-top">
        <span className="nutr-pill-label" style={{ color }}>{label}</span>
        <span className="nutr-pill-val">{Math.round(current)}<span className="nutr-pill-of">/{goal}g</span></span>
      </div>
      <div className="nutr-pill-track">
        <div className="nutr-pill-fill" style={{ width: `${pct}%`, background: color }} />
      </div>
    </div>
  )
}

export function NutritionApp({ auth }: { auth: FeatureAuth }) {
  const a = useAuthed(auth)
  const [goals, setGoals] = useState<NutritionGoals | null>(null)
  const [logs, setLogs] = useState<NutritionLog[]>([])
  const [totals, setTotals] = useState({ calories: 0, protein: 0, carbs: 0, fat: 0 })
  const [desc, setDesc] = useState('')
  const [busy, setBusy] = useState(false)
  const [analyzing, setAnalyzing] = useState(false)
  const [msg, setMsg] = useState('')
  const fileRef = useRef<HTMLInputElement | null>(null)
  const [showGoals, setShowGoals] = useState(false)
  const [goalInput, setGoalInput] = useState({ calories: 2200, protein: 150, carbs: 220, fat: 70 })
  const [selectedMeal, setSelectedMeal] = useState<NutritionLog | null>(null)

  const load = useCallback(() => {
    apiNutritionToday(a)
      .then((d) => {
        setGoals(d.goals)
        setLogs(d.logs)
        setTotals(d.totals)
        if (d.goals) {
          setGoalInput({
            calories: d.goals.calorieGoal,
            protein: d.goals.proteinGoal,
            carbs: d.goals.carbsGoal,
            fat: d.goals.fatGoal,
          })
        }
      })
      .catch(() => setMsg('Could not load today.'))
  }, [a.email, a.token])

  useEffect(() => { load() }, [load])

  function pickImage(file: File | undefined) {
    if (!file) return
    setAnalyzing(true)
    setMsg('Reading the plate…')
    const reader = new FileReader()
    reader.onload = async () => {
      const base64 = String(reader.result || '').split(',')[1] || ''
      try {
        const est = await apiAnalyzeNutrition({ ...a, imageBase64: base64 })
        if (est.needsKey) {
          setMsg('Photo reading needs a model key. Describe the meal below instead.')
        } else if (!est.ok) {
          setMsg(est.error || 'Could not read that photo.')
        } else {
          await apiLogNutrition({
            ...a, description: est.guess || 'Meal from photo',
            calories: est.calories, protein: est.protein, carbs: est.carbs, fat: est.fat,
          })
          setMsg('')
          load()
        }
      } catch {
        setMsg('Could not read that photo.')
      } finally {
        setAnalyzing(false)
        if (fileRef.current) fileRef.current.value = ''
      }
    }
    reader.readAsDataURL(file)
  }

  async function add(e: FormEvent) {
    e.preventDefault()
    if (!desc.trim() || busy) return
    setBusy(true)
    setMsg('Estimating…')
    try {
      const est = await apiAnalyzeNutrition({ ...a, description: desc.trim() })
      if (est.needsKey) {
        await apiLogNutrition({ ...a, description: desc.trim() })
        setMsg('Logged. Add a model key to auto-estimate macros.')
      } else if (est.ok) {
        await apiLogNutrition({
          ...a, description: est.guess || desc.trim(),
          calories: est.calories, protein: est.protein, carbs: est.carbs, fat: est.fat,
        })
        setMsg('')
      } else {
        await apiLogNutrition({ ...a, description: desc.trim() })
        setMsg(est.error || 'Logged without a macro estimate.')
      }
      setDesc('')
      load()
    } catch {
      setMsg('Could not log that.')
    } finally {
      setBusy(false)
    }
  }

  async function quickAdd(item: typeof QUICK_ADD[number]) {
    if (busy) return
    setBusy(true)
    try {
      await apiLogNutrition({
        ...a, description: item.desc,
        calories: item.cal, protein: item.p, carbs: item.c, fat: item.f,
      })
      load()
    } catch {
      setMsg('Could not log that.')
    } finally {
      setBusy(false)
    }
  }

  async function deleteMeal(id: string) {
    if (busy) return
    setBusy(true)
    try {
      await apiDeleteNutritionLog({ ...a, id })
      setSelectedMeal(null)
      load()
    } catch {
      setMsg('Could not delete.')
    } finally {
      setBusy(false)
    }
  }

  const g = goals || { calorieGoal: 2200, proteinGoal: 150, carbsGoal: 220, fatGoal: 70 }

  async function saveGoals() {
    if (busy) return
    setBusy(true)
    try {
      await apiSetNutritionGoals({ ...a, ...goalInput })
      load()
      setShowGoals(false)
    } catch (error) {
      setMsg(error instanceof Error ? error.message : 'Could not save goals.')
    } finally {
      setBusy(false)
    }
  }

  const mealTime = (iso: string) => {
    const d = new Date(iso)
    return d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
  }

  return (
    <div className="nutr">
      {/* Hero ring + macro pills */}
      <div className="nutr-hero">
        <CalorieRing current={totals.calories} goal={g.calorieGoal} />
        <div className="nutr-pills">
          <MacroPill label="Protein" current={totals.protein} goal={g.proteinGoal} color="#f97316" />
          <MacroPill label="Carbs" current={totals.carbs} goal={g.carbsGoal} color="#3b82f6" />
          <MacroPill label="Fat" current={totals.fat} goal={g.fatGoal} color="#a855f7" />
        </div>
      </div>

      {/* Quick add */}
      <div className="nutr-quick-section">
        <span className="nutr-quick-label">Quick Add</span>
        <div className="nutr-quick">
          {QUICK_ADD.map((item) => (
            <button key={item.label} className="nutr-quick-btn" type="button" disabled={busy} onClick={() => void quickAdd(item)}>
              {item.label}
            </button>
          ))}
        </div>
      </div>

      {/* Input row */}
      <div className="nutr-input-row">
        <label className="nutr-photo-btn">
          <input ref={fileRef} type="file" accept="image/*" onChange={(e) => pickImage(e.target.files?.[0])} aria-label="Photo of food" />
          <span>{analyzing ? '⏳' : '📷'}</span>
          <span className="nutr-photo-text">Photo</span>
        </label>
        <form className="nutr-input-form" onSubmit={add}>
          <input
            className="nutr-input"
            value={desc}
            onChange={(e) => setDesc(e.target.value)}
            placeholder="What did you eat?"
            aria-label="Meal description"
          />
          <button className="nutr-log-btn" type="submit" disabled={busy || !desc.trim()}>
            Log
          </button>
        </form>
      </div>
      {msg && <p className="mini__hint">{msg}</p>}

      {/* Goals toggle */}
      {showGoals ? (
        <div className="nutr-goals-form">
          <div className="nutr-goals-grid">
            {(['calories', 'protein', 'carbs', 'fat'] as const).map((k) => {
              const label = k === 'calories' ? 'Calories' : k.charAt(0).toUpperCase() + k.slice(1)
              const val = k === 'calories' ? goalInput.calories : goalInput[k as 'protein' | 'carbs' | 'fat']
              return (
                <label key={k} className="nutr-goal-field">
                  <span>{label}{k !== 'calories' ? ' (g)' : ''}</span>
                  <input
                    className="nutr-goal-input"
                    type="number" min={0} value={val}
                    onChange={(e) => setGoalInput((p) => ({ ...p, [k]: Number(e.target.value) || 0 }))}
                  />
                </label>
              )
            })}
          </div>
          <div className="nutr-goals-actions">
            <button type="button" className="nutr-save-btn" disabled={busy} onClick={() => void saveGoals()}>Save</button>
            <button type="button" className="nutr-cancel-btn" onClick={() => setShowGoals(false)}>Cancel</button>
          </div>
        </div>
      ) : (
        <button type="button" className="nutr-edit-goals" onClick={() => setShowGoals(true)}>
          Goals
        </button>
      )}

      {/* Today's meals */}
      <section className="nutr-meals">
        <h3>Today</h3>
        {logs.length ? (
          <ul className="nutr-meal-list">
            {logs.map((l) => (
              <li key={l.id} className="nutr-meal-card" onClick={() => setSelectedMeal(l)}>
                <div className="nutr-meal-time">{mealTime(l.eatenAt)}</div>
                <div className="nutr-meal-info">
                  <span className="nutr-meal-name">{l.description}</span>
                  <span className="nutr-meal-macros">
                    {Math.round(l.calories)} cal · {Math.round(l.protein)}p · {Math.round(l.carbs)}c · {Math.round(l.fat)}f
                  </span>
                </div>
                <button className="nutr-meal-delete" type="button" onClick={(e) => { e.stopPropagation(); void deleteMeal(l.id) }} title="Remove">
                  ×
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="mini__empty">No meals logged yet.</p>
        )}
      </section>

      {/* Meal detail modal */}
      {selectedMeal && (
        <div className="nutr-modal-overlay" onClick={() => setSelectedMeal(null)}>
          <div className="nutr-modal" onClick={(e) => e.stopPropagation()}>
            <button className="nutr-modal-close" type="button" onClick={() => setSelectedMeal(null)}>×</button>
            <h3>{selectedMeal.description}</h3>
            <span className="nutr-modal-time">{mealTime(selectedMeal.eatenAt)}</span>
            <div className="nutr-modal-macros">
              <div className="nutr-modal-macro">
                <span className="nutr-modal-macro-val">{Math.round(selectedMeal.calories)}</span>
                <span className="nutr-modal-macro-label">Calories</span>
              </div>
              <div className="nutr-modal-macro">
                <span className="nutr-modal-macro-val" style={{ color: '#f97316' }}>{Math.round(selectedMeal.protein)}g</span>
                <span className="nutr-modal-macro-label">Protein</span>
              </div>
              <div className="nutr-modal-macro">
                <span className="nutr-modal-macro-val" style={{ color: '#3b82f6' }}>{Math.round(selectedMeal.carbs)}g</span>
                <span className="nutr-modal-macro-label">Carbs</span>
              </div>
              <div className="nutr-modal-macro">
                <span className="nutr-modal-macro-val" style={{ color: '#a855f7' }}>{Math.round(selectedMeal.fat)}g</span>
                <span className="nutr-modal-macro-label">Fat</span>
              </div>
            </div>
            <div className="nutr-modal-bar">
              {(() => {
                const total = selectedMeal.protein + selectedMeal.carbs + selectedMeal.fat
                if (total === 0) return null
                const pPct = (selectedMeal.protein / total) * 100
                const cPct = (selectedMeal.carbs / total) * 100
                const fPct = (selectedMeal.fat / total) * 100
                return (
                  <div className="nutr-modal-bar-inner">
                    <div style={{ width: `${pPct}%`, background: '#f97316' }} />
                    <div style={{ width: `${cPct}%`, background: '#3b82f6' }} />
                    <div style={{ width: `${fPct}%`, background: '#a855f7' }} />
                  </div>
                )
              })()}
            </div>
            <button className="nutr-modal-delete" type="button" onClick={() => void deleteMeal(selectedMeal.id)}>
              Remove meal
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

/* ------------------------------ Habit Streak Board ------------------------------ */

const HABIT_EMOJIS = ['💪', '📚', '🧘', '🏃', '💧', '🍎', '😴', '🎯', '✍️', '🎵', '🧹', '💊'] as const
const DAY_LETTERS = ['S', 'M', 'T', 'W', 'T', 'F', 'S'] as const

function last7Days(): string[] {
  const days: string[] = []
  for (let i = 6; i >= 0; i--) {
    const d = new Date()
    d.setDate(d.getDate() - i)
    days.push(d.toISOString().slice(0, 10))
  }
  return days
}

export function HabitStreakApp({ auth }: { auth: FeatureAuth }) {
  const a = useAuthed(auth)
  const [habits, setHabits] = useState<(Habit & { streak: number; recentDays: string[] })[]>([])
  const [name, setName] = useState('')
  const [emoji, setEmoji] = useState('💪')
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState('')
  const days = last7Days()

  const load = useCallback(() => {
    apiListHabits(a).then((d) => setHabits(d.habits)).catch(() => setMsg('Could not load habits.'))
  }, [a.email, a.token])

  useEffect(() => { load() }, [load])

  async function add(e: FormEvent) {
    e.preventDefault()
    if (!name.trim() || busy) return
    setBusy(true)
    try {
      await apiAddHabit({ ...a, name: name.trim(), emoji })
      setName('')
      load()
    } catch {
      setMsg('Could not add habit.')
    } finally {
      setBusy(false)
    }
  }

  async function toggle(habitId: string, date: string) {
    if (busy) return
    setBusy(true)
    try {
      await apiToggleHabit({ ...a, habitId, date })
      load()
    } catch {
      setMsg('Could not toggle.')
    } finally {
      setBusy(false)
    }
  }

  async function remove(habitId: string) {
    if (busy) return
    setBusy(true)
    try {
      await apiDeleteHabit({ ...a, habitId })
      load()
    } catch {
      setMsg('Could not delete.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="habit">
      <form className="habit-add" onSubmit={add}>
        <select className="nutr-goal-input" value={emoji} onChange={(e) => setEmoji(e.target.value)} style={{ width: 52, textAlign: 'center', fontSize: 18 }}>
          {HABIT_EMOJIS.map((e) => <option key={e} value={e}>{e}</option>)}
        </select>
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="New habit…" aria-label="Habit name" />
        <button className="habit-add-btn" type="submit" disabled={busy || !name.trim()}>Add</button>
      </form>
      {msg && <p className="mini__hint">{msg}</p>}

      {habits.length ? (
        <ul className="habit-list">
          {habits.map((h) => (
            <li key={h.id} className="habit-card">
              <span className="habit-emoji">{h.emoji}</span>
              <div className="habit-info">
                <div className="habit-name">{h.name}</div>
                <div className="habit-streak">🔥 <b>{h.streak}</b> day streak</div>
              </div>
              <div className="habit-days">
                {days.map((d, i) => (
                  <button
                    key={d}
                    className={`habit-day${h.recentDays.includes(d) ? ' done' : ''}`}
                    type="button"
                    onClick={() => void toggle(h.id, d)}
                  >
                    {DAY_LETTERS[i]}
                  </button>
                ))}
              </div>
              <button className="habit-delete" type="button" onClick={() => void remove(h.id)} title="Delete">×</button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="mini__empty">No habits yet. Add one above.</p>
      )}
    </div>
  )
}

/* ------------------------------ Mood & Energy Tracker ------------------------------ */

const MOOD_EMOJIS = ['😄', '🙂', '😐', '😔', '😤'] as const

export function MoodTrackerApp({ auth }: { auth: FeatureAuth }) {
  const a = useAuthed(auth)
  const [entries, setEntries] = useState<MoodEntry[]>([])
  const [streak, setStreak] = useState(0)
  const [selected, setSelected] = useState<string | null>(null)
  const [energy, setEnergy] = useState(3)
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState('')

  const load = useCallback(() => {
    apiListMoods(a).then((d) => { setEntries(d.entries); setStreak(d.streak) }).catch(() => setMsg('Could not load moods.'))
  }, [a.email, a.token])

  useEffect(() => { load() }, [load])

  async function save() {
    if (!selected || busy) return
    setBusy(true)
    try {
      await apiLogMood({ ...a, emoji: selected, energy, note: note.trim() || undefined })
      setSelected(null)
      setEnergy(3)
      setNote('')
      load()
    } catch {
      setMsg('Could not log mood.')
    } finally {
      setBusy(false)
    }
  }

  const fmtTime = (iso: string) => {
    const d = new Date(iso)
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) + ' ' +
           d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
  }

  return (
    <div className="mood">
      <div className="mood-emoji-row">
        {MOOD_EMOJIS.map((e) => (
          <button key={e} className={`mood-emoji-btn${selected === e ? ' selected' : ''}`} type="button" onClick={() => setSelected(e)}>
            {e}
          </button>
        ))}
      </div>

      <div className="mood-energy">
        <span className="mood-energy-label">Energy Level</span>
        <input className="mood-energy-slider" type="range" min={1} max={5} value={energy} onChange={(e) => setEnergy(Number(e.target.value))} />
        <span className="mood-energy-val">{energy}/5</span>
      </div>

      <textarea className="mood-note" value={note} onChange={(e) => setNote(e.target.value)} placeholder="How are you feeling? (optional)" rows={2} />

      <button className="mood-save" type="button" disabled={busy || !selected} onClick={() => void save()}>
        Log mood
      </button>
      {msg && <p className="mini__hint">{msg}</p>}

      {streak > 0 && <p className="mini__hint">🔥 {streak} day logging streak</p>}

      {entries.length ? (
        <section className="mood-history">
          <h3>Recent</h3>
          <ul className="mood-list">
            {entries.map((e) => (
              <li key={e.id} className="mood-entry">
                <span className="mood-entry-emoji">{e.emoji}</span>
                <div className="mood-entry-info">
                  <span className="mood-entry-time">{fmtTime(e.createdAt)}</span>
                  {e.note && <span className="mood-entry-note">{e.note}</span>}
                </div>
                <span className="mood-entry-energy">⚡ {e.energy}/5</span>
              </li>
            ))}
          </ul>
        </section>
      ) : (
        <p className="mini__empty">No moods logged yet.</p>
      )}
    </div>
  )
}
