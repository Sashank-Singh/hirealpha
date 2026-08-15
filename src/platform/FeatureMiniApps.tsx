import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react'
import type { AgentId } from '../agents/types'
import {
  apiAddDecision,
  apiAddDrop,
  apiAddLoop,
  apiAddMeeting,
  apiAddRelationship,
  apiAnalyzeNutrition,
  apiListDecisions,
  apiListDrops,
  apiListLoops,
  apiListMeetings,
  apiListRelationships,
  apiLogNutrition,
  apiNutritionToday,
  apiPatchLoop,
  apiReviewDecision,
  apiSetNutritionGoals,
  apiTouchRelationship,
  type Decision,
  type Drop,
  type Meeting,
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

  useEffect(() => {
    load()
  }, [load])

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
            ...a,
            description: est.guess || 'Meal from photo',
            calories: est.calories,
            protein: est.protein,
            carbs: est.carbs,
            fat: est.fat,
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
          ...a,
          description: est.guess || desc.trim(),
          calories: est.calories,
          protein: est.protein,
          carbs: est.carbs,
          fat: est.fat,
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

  const g = goals || { calorieGoal: 2200, proteinGoal: 150, carbsGoal: 220, fatGoal: 70 }
  const pct = (val: number, goal: number) => (goal > 0 ? Math.min(100, Math.round((val / goal) * 100)) : 0)

  async function saveGoals() {
    if (busy) return
    setBusy(true)
    setMsg('')
    try {
      await apiSetNutritionGoals({ ...a, ...goalInput })
      load()
      setShowGoals(false)
      setMsg('')
    } catch (error) {
      setMsg(error instanceof Error ? error.message : 'Could not save goals.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div>
      <div className="mini__macro-grid">
        <MacroBar label="Calories" value={Math.round(totals.calories)} goal={g.calorieGoal} unit="" pct={pct(totals.calories, g.calorieGoal)} />
        <MacroBar label="Protein" value={Math.round(totals.protein)} goal={g.proteinGoal} unit="g" pct={pct(totals.protein, g.proteinGoal)} />
        <MacroBar label="Carbs" value={Math.round(totals.carbs)} goal={g.carbsGoal} unit="g" pct={pct(totals.carbs, g.carbsGoal)} />
        <MacroBar label="Fat" value={Math.round(totals.fat)} goal={g.fatGoal} unit="g" pct={pct(totals.fat, g.fatGoal)} />
      </div>

      {showGoals ? (
        <div className="mini__form-stack">
          <label className="mini__field">
            <span>Daily calories</span>
            <input
              className="mini__input"
              type="number"
              min={0}
              value={goalInput.calories}
              onChange={(e) => setGoalInput((p) => ({ ...p, calories: Number(e.target.value) || 0 }))}
            />
          </label>
          <label className="mini__field">
            <span>Protein (g)</span>
            <input
              className="mini__input"
              type="number"
              min={0}
              value={goalInput.protein}
              onChange={(e) => setGoalInput((p) => ({ ...p, protein: Number(e.target.value) || 0 }))}
            />
          </label>
          <label className="mini__field">
            <span>Carbs (g)</span>
            <input
              className="mini__input"
              type="number"
              min={0}
              value={goalInput.carbs}
              onChange={(e) => setGoalInput((p) => ({ ...p, carbs: Number(e.target.value) || 0 }))}
            />
          </label>
          <label className="mini__field">
            <span>Fat (g)</span>
            <input
              className="mini__input"
              type="number"
              min={0}
              value={goalInput.fat}
              onChange={(e) => setGoalInput((p) => ({ ...p, fat: Number(e.target.value) || 0 }))}
            />
          </label>
          <div className="mini__row-actions">
            <button type="button" className="mini__chip mini__chip--green" disabled={busy} onClick={() => void saveGoals()}>
              Save goals
            </button>
            <button type="button" className="mini__chip" onClick={() => setShowGoals(false)}>
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <button type="button" className="mini__chip" onClick={() => setShowGoals(true)}>
          Adjust daily goals
        </button>
      )}

      <label className="mini__photo">
        <input
          ref={fileRef}
          type="file"
          accept="image/*"
          onChange={(e) => pickImage(e.target.files?.[0])}
          aria-label="Photo of food"
        />
        <span className="mini__photo-label">{analyzing ? 'Reading…' : 'Snap or upload a photo'}</span>
      </label>

      <form className="mini__form" onSubmit={add}>
        <input
          className="mini__input"
          value={desc}
          onChange={(e) => setDesc(e.target.value)}
          placeholder="Or describe it — 2 eggs, toast, coffee"
          aria-label="Meal description"
        />
        <button className="mini__btn" type="submit" disabled={busy || !desc.trim()}>
          Log
        </button>
      </form>
      {msg && <p className="mini__hint">{msg}</p>}

      <section className="mini__section">
        <h2>Today</h2>
        {logs.length ? (
          <ul className="mini__list">
            {logs.map((l) => (
              <li key={l.id} className="mini__row">
                <span className="mini__row-main">
                  <span className="mini__row-title">{l.description}</span>
                  <span className="mini__row-sub">
                    {Math.round(l.calories)} cal · {Math.round(l.protein)}p {Math.round(l.carbs)}c {Math.round(l.fat)}f
                  </span>
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="mini__empty">Nothing logged yet today.</p>
        )}
      </section>
    </div>
  )
}

function MacroBar({ label, value, goal, unit, pct }: { label: string; value: number; goal: number; unit: string; pct: number }) {
  return (
    <div className="mini__macro">
      <div className="mini__macro-head">
        <span className="mini__macro-label">{label}</span>
        <span className="mini__macro-num">
          {value}/{goal}
          {unit}
        </span>
      </div>
      <div className="mini__macro-track">
        <div className="mini__macro-fill" style={{ width: `${pct}%` }} />
      </div>
    </div>
  )
}
