import { useCallback, useEffect, useState, type FormEvent } from 'react'
import {
  apiAddGratitude,
  apiAddLearning,
  apiAddNetwork,
  apiAddPipeline,
  apiDeleteGratitude,
  apiDeleteSleep,
  apiDeleteSpend,
  apiDeleteWorkout,
  apiListGratitude,
  apiListLearning,
  apiListNetwork,
  apiListPipeline,
  apiListSleep,
  apiListSpending,
  apiListWorkouts,
  apiLogSleep,
  apiLogSpend,
  apiLogWorkout,
  apiPatchLearning,
  apiPatchPipeline,
  apiSaveWeeklyReview,
  apiSetSpendBudget,
  apiTouchNetwork,
  apiWeeklyReview,
  type GratitudeEntry,
  type LearningItem,
  type NetworkPerson,
  type PipelineItem,
  type SleepNight,
  type SpendLog,
  type WeeklyReview,
  type WeeklySnapshot,
  type WorkoutLog,
  type WorkoutPr,
} from './api'
import type { FeatureAuth } from './FeatureMiniApps'

function useAuth(auth: FeatureAuth) {
  return { email: auth.email, token: auth.token }
}

function fmtDay(iso: string | null | undefined) {
  if (!iso) return ''
  const raw = iso.slice(0, 10)
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    const [y, m, d] = raw.split('-').map(Number)
    return new Date(y!, (m || 1) - 1, d || 1).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
  }
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return raw
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}

function localDateStr(d = new Date()) {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

function lastNightDateStr() {
  const now = new Date()
  return localDateStr(new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1))
}

function hoursBetween(bedtime: string, wake: string) {
  const [bh, bm] = bedtime.split(':').map(Number)
  const [wh, wm] = wake.split(':').map(Number)
  if ([bh, bm, wh, wm].some((n) => Number.isNaN(n))) return 0
  let mins = wh * 60 + wm - (bh * 60 + bm)
  if (mins <= 0) mins += 24 * 60
  return Math.round((mins / 60) * 10) / 10
}

function daysSince(iso: string | null) {
  if (!iso) return 999
  return Math.floor((Date.now() - new Date(iso).getTime()) / 86400000)
}

/* ------------------------------ Workout Log ----------------------------- */

export function WorkoutLogApp({ auth }: { auth: FeatureAuth }) {
  const a = useAuth(auth)
  const [logs, setLogs] = useState<WorkoutLog[]>([])
  const [prs, setPrs] = useState<WorkoutPr[]>([])
  const [exercise, setExercise] = useState('')
  const [sets, setSets] = useState('3')
  const [reps, setReps] = useState('8')
  const [weight, setWeight] = useState('')
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState('')

  const load = useCallback(() => {
    apiListWorkouts(a).then((d) => { setLogs(d.logs); setPrs(d.prs) }).catch(() => setMsg('Could not load workouts.'))
  }, [a.email, a.token])
  useEffect(() => { load() }, [load])

  async function add(e: FormEvent) {
    e.preventDefault()
    if (!exercise.trim() || busy) return
    setBusy(true)
    try {
      await apiLogWorkout({
        ...a,
        exercise: exercise.trim(),
        sets: Number(sets) || 1,
        reps: Number(reps) || 1,
        weight: Number(weight) || 0,
      })
      setExercise('')
      setWeight('')
      load()
    } catch {
      setMsg('Could not log that.')
    } finally {
      setBusy(false)
    }
  }

  const prMap = new Map(prs.map((p) => [p.exercise.toLowerCase(), p]))

  return (
    <div className="ma">
      <form className="ma-form" onSubmit={add}>
        <input className="ma-input" value={exercise} onChange={(e) => setExercise(e.target.value)} placeholder="Exercise (bench, squat…)" aria-label="Exercise" />
        <input className="ma-input ma-input--sm" value={sets} onChange={(e) => setSets(e.target.value)} inputMode="numeric" aria-label="Sets" placeholder="Sets" />
        <input className="ma-input ma-input--sm" value={reps} onChange={(e) => setReps(e.target.value)} inputMode="numeric" aria-label="Reps" placeholder="Reps" />
        <input className="ma-input ma-input--sm" value={weight} onChange={(e) => setWeight(e.target.value)} inputMode="decimal" aria-label="Weight" placeholder="Lbs" />
        <button className="ma-btn" type="submit" disabled={busy || !exercise.trim()}>Log</button>
      </form>
      {msg && <p className="mini__hint">{msg}</p>}
      {prs.length > 0 && (
        <div className="ma-pills">
          {prs.slice(0, 4).map((p) => (
            <span key={p.exercise} className="ma-pill">PR {p.exercise} {Math.round(p.weight)}×{p.reps}</span>
          ))}
        </div>
      )}
      {logs.length ? (
        <ul className="ma-list">
          {logs.map((l) => {
            const pr = prMap.get(l.exercise.toLowerCase())
            const isPr = pr && pr.weight === l.weight && pr.reps === l.reps
            return (
              <li key={l.id} className="ma-row">
                <div className="ma-row-main">
                  <span className="ma-title">{l.exercise}{isPr ? ' · PR' : ''}</span>
                  <span className="ma-sub">{l.sets}×{l.reps}{l.weight ? ` @ ${l.weight} lbs` : ''} · {fmtDay(l.loggedAt)}</span>
                </div>
                <button className="ma-x" type="button" onClick={() => void apiDeleteWorkout({ ...a, id: l.id }).then(load)} title="Remove">×</button>
              </li>
            )
          })}
        </ul>
      ) : (
        <p className="mini__empty">No lifts yet. Log a set above.</p>
      )}
    </div>
  )
}

/* ----------------------------- Learning Queue --------------------------- */

const LEARN_KINDS = ['article', 'video', 'podcast'] as const

export function LearningQueueApp({ auth }: { auth: FeatureAuth }) {
  const a = useAuth(auth)
  const [items, setItems] = useState<LearningItem[]>([])
  const [title, setTitle] = useState('')
  const [kind, setKind] = useState<string>('article')
  const [minutes, setMinutes] = useState('15')
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState('')

  const load = useCallback(() => {
    apiListLearning(a).then((d) => setItems(d.items)).catch(() => setMsg('Could not load queue.'))
  }, [a.email, a.token])
  useEffect(() => { load() }, [load])

  async function add(e: FormEvent) {
    e.preventDefault()
    if (!title.trim() || busy) return
    setBusy(true)
    try {
      await apiAddLearning({ ...a, title: title.trim(), kind, minutes: Number(minutes) || 10 })
      setTitle('')
      load()
    } catch {
      setMsg('Could not add that.')
    } finally {
      setBusy(false)
    }
  }

  const queued = items.filter((i) => i.status !== 'done')
  const next = queued[0]

  return (
    <div className="ma">
      <form className="ma-form" onSubmit={add}>
        <input className="ma-input" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Article, video, podcast…" aria-label="Title" />
        <select className="ma-input ma-input--sm" value={kind} onChange={(e) => setKind(e.target.value)} aria-label="Kind">
          {LEARN_KINDS.map((k) => <option key={k} value={k}>{k}</option>)}
        </select>
        <input className="ma-input ma-input--sm" value={minutes} onChange={(e) => setMinutes(e.target.value)} inputMode="numeric" aria-label="Minutes" placeholder="Min" />
        <button className="ma-btn" type="submit" disabled={busy || !title.trim()}>Save</button>
      </form>
      {msg && <p className="mini__hint">{msg}</p>}
      {next && (
        <div className="ma-callout">
          <span className="ma-callout-kicker">Next up · {next.minutes} min</span>
          <strong>{next.title}</strong>
          <span className="ma-sub">{next.kind}</span>
        </div>
      )}
      {items.length ? (
        <ul className="ma-list">
          {items.map((i) => (
            <li key={i.id} className={`ma-row${i.status === 'done' ? ' ma-row--done' : ''}`}>
              <div className="ma-row-main">
                <span className="ma-title">{i.title}</span>
                <span className="ma-sub">{i.kind} · {i.minutes} min</span>
              </div>
              {i.status !== 'done' && (
                <button className="ma-chip" type="button" onClick={() => void apiPatchLearning({ ...a, id: i.id, status: 'done' }).then(load)}>Done</button>
              )}
              <button className="ma-x" type="button" onClick={() => void apiPatchLearning({ ...a, id: i.id, _delete: true }).then(load)} title="Remove">×</button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="mini__empty">Queue is empty. Save something to read or watch.</p>
      )}
    </div>
  )
}

/* ----------------------------- Weekly Review ---------------------------- */

export function WeeklyReviewApp({ auth }: { auth: FeatureAuth }) {
  const a = useAuth(auth)
  const [weekStart, setWeekStart] = useState('')
  const [snap, setSnap] = useState<WeeklySnapshot | null>(null)
  const [reviews, setReviews] = useState<WeeklyReview[]>([])
  const [doneText, setDoneText] = useState('')
  const [slippedText, setSlippedText] = useState('')
  const [focusText, setFocusText] = useState('')
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState('')

  const load = useCallback(() => {
    apiWeeklyReview(a).then((d) => {
      setWeekStart(d.weekStart)
      setSnap(d.snapshot)
      setReviews(d.reviews)
      if (d.current) {
        setDoneText(d.current.doneText)
        setSlippedText(d.current.slippedText)
        setFocusText(d.current.focusText)
      }
    }).catch(() => setMsg('Could not load this week.'))
  }, [a.email, a.token])
  useEffect(() => { load() }, [load])

  async function save(e: FormEvent) {
    e.preventDefault()
    if (busy || !weekStart) return
    setBusy(true)
    try {
      await apiSaveWeeklyReview({ ...a, weekStart, doneText, slippedText, focusText })
      setMsg('Saved.')
      load()
    } catch {
      setMsg('Could not save.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="ma">
      {snap && (
        <div className="ma-stats">
          <div className="ma-stat"><b>{snap.meals}</b><span>meals</span></div>
          <div className="ma-stat"><b>{snap.avgEnergy ? snap.avgEnergy.toFixed(1) : '—'}</b><span>energy</span></div>
          <div className="ma-stat"><b>{snap.avgSleepHours || '—'}</b><span>sleep h</span></div>
          <div className="ma-stat"><b>${Math.round(snap.spend)}</b><span>spent</span></div>
          <div className="ma-stat"><b>{snap.habitChecks}</b><span>habits</span></div>
          <div className="ma-stat"><b>{snap.followUpsDue}</b><span>follow-ups</span></div>
        </div>
      )}
      <form className="ma-stack" onSubmit={save}>
        <label className="ma-label">What got done
          <textarea className="ma-area" rows={2} value={doneText} onChange={(e) => setDoneText(e.target.value)} placeholder="Shipped, finished, showed up…" />
        </label>
        <label className="ma-label">What slipped
          <textarea className="ma-area" rows={2} value={slippedText} onChange={(e) => setSlippedText(e.target.value)} placeholder="Missed, delayed, avoided…" />
        </label>
        <label className="ma-label">Next week focus
          <textarea className="ma-area" rows={2} value={focusText} onChange={(e) => setFocusText(e.target.value)} placeholder="One thing that actually matters." />
        </label>
        <button className="ma-btn" type="submit" disabled={busy}>Save review</button>
      </form>
      {msg && <p className="mini__hint">{msg}</p>}
      {reviews.length > 0 && (
        <ul className="ma-list">
          {reviews.map((r) => (
            <li key={r.id} className="ma-row">
              <div className="ma-row-main">
                <span className="ma-title">Week of {fmtDay(r.weekStart)}</span>
                <span className="ma-sub">{r.focusText || r.doneText || 'No focus set'}</span>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

/* ---------------------------- Networking CRM ---------------------------- */

export function NetworkingCrmApp({ auth }: { auth: FeatureAuth }) {
  const a = useAuth(auth)
  const [people, setPeople] = useState<NetworkPerson[]>([])
  const [name, setName] = useState('')
  const [whereMet, setWhereMet] = useState('')
  const [context, setContext] = useState('')
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState('')

  const load = useCallback(() => {
    apiListNetwork(a).then((d) => setPeople(d.people)).catch(() => setMsg('Could not load people.'))
  }, [a.email, a.token])
  useEffect(() => { load() }, [load])

  async function add(e: FormEvent) {
    e.preventDefault()
    if (!name.trim() || busy) return
    setBusy(true)
    try {
      await apiAddNetwork({ ...a, name: name.trim(), whereMet: whereMet.trim(), context: context.trim() })
      setName(''); setWhereMet(''); setContext('')
      load()
    } catch {
      setMsg('Could not add that.')
    } finally {
      setBusy(false)
    }
  }

  const due = people.filter((p) => daysSince(p.lastTouch) >= p.cadenceDays)

  return (
    <div className="ma">
      <form className="ma-stack" onSubmit={add}>
        <div className="ma-form">
          <input className="ma-input" value={name} onChange={(e) => setName(e.target.value)} placeholder="Name" aria-label="Name" />
          <input className="ma-input" value={whereMet} onChange={(e) => setWhereMet(e.target.value)} placeholder="Where you met" aria-label="Where" />
        </div>
        <input className="ma-input" value={context} onChange={(e) => setContext(e.target.value)} placeholder="What you talked about" aria-label="Context" />
        <button className="ma-btn" type="submit" disabled={busy || !name.trim()}>Add</button>
      </form>
      {msg && <p className="mini__hint">{msg}</p>}
      {due.length > 0 && <p className="mini__hint">{due.length} follow-up{due.length === 1 ? '' : 's'} due.</p>}
      {people.length ? (
        <ul className="ma-list">
          {people.map((p) => {
            const days = daysSince(p.lastTouch)
            const late = days >= p.cadenceDays
            return (
              <li key={p.id} className={`ma-row${late ? ' ma-row--warn' : ''}`}>
                <div className="ma-row-main">
                  <span className="ma-title">{p.name}</span>
                  <span className="ma-sub">
                    {p.whereMet ? `${p.whereMet} · ` : ''}{p.context || 'No note'}
                    {' · '}{p.lastTouch ? `${days}d ago` : 'never'}
                  </span>
                </div>
                <button className="ma-chip" type="button" onClick={() => void apiTouchNetwork({ ...a, id: p.id }).then(load)}>Talked</button>
                <button className="ma-x" type="button" onClick={() => void apiTouchNetwork({ ...a, id: p.id, _delete: true }).then(load)} title="Remove">×</button>
              </li>
            )
          })}
        </ul>
      ) : (
        <p className="mini__empty">Log someone you met. Alpha will remind you to follow up.</p>
      )}
    </div>
  )
}

/* ----------------------------- Sleep Tracker ---------------------------- */

export function SleepTrackerApp({ auth }: { auth: FeatureAuth }) {
  const a = useAuth(auth)
  const [nights, setNights] = useState<SleepNight[]>([])
  const [bedtime, setBedtime] = useState('23:00')
  const [wake, setWake] = useState('07:00')
  const [quality, setQuality] = useState(3)
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState('')

  const load = useCallback(() => {
    apiListSleep(a).then((d) => setNights(d.nights)).catch(() => setMsg('Could not load sleep.'))
  }, [a.email, a.token])
  useEffect(() => { load() }, [load])

  async function save() {
    if (busy) return
    setBusy(true)
    try {
      await apiLogSleep({ ...a, bedtime, wake, quality, sleepDate: lastNightDateStr() })
      load()
    } catch {
      setMsg('Could not log sleep.')
    } finally {
      setBusy(false)
    }
  }

  const last7 = nights.slice(0, 7)
  const avg = last7.length
    ? last7.reduce((s, n) => s + hoursBetween(n.bedtime, n.wake), 0) / last7.length
    : 0
  const debt = last7.reduce((s, n) => s + Math.max(0, 8 - hoursBetween(n.bedtime, n.wake)), 0)

  return (
    <div className="ma">
      <div className="ma-stats">
        <div className="ma-stat"><b>{avg ? avg.toFixed(1) : '—'}</b><span>avg hours</span></div>
        <div className="ma-stat"><b>{debt ? debt.toFixed(1) : '0'}</b><span>sleep debt</span></div>
        <div className="ma-stat"><b>{last7.length}</b><span>nights</span></div>
      </div>
      <div className="sleep-bars">
        {last7.slice().reverse().map((n) => {
          const h = hoursBetween(n.bedtime, n.wake)
          return (
            <div key={n.id} className="sleep-bar-col" title={`${n.sleepDate} ${h}h`}>
              <div className="sleep-bar" style={{ height: `${Math.min(100, (h / 10) * 100)}%` }} />
              <span>{n.sleepDate.slice(5)}</span>
            </div>
          )
        })}
      </div>
      <div className="ma-form">
        <label className="ma-label">Bed
          <input className="ma-input" type="time" value={bedtime} onChange={(e) => setBedtime(e.target.value)} />
        </label>
        <label className="ma-label">Wake
          <input className="ma-input" type="time" value={wake} onChange={(e) => setWake(e.target.value)} />
        </label>
        <label className="ma-label">Quality {quality}/5
          <input className="mood-energy-slider" type="range" min={1} max={5} value={quality} onChange={(e) => setQuality(Number(e.target.value))} />
        </label>
      </div>
      <button className="ma-btn" type="button" disabled={busy} onClick={() => void save()}>Log last night</button>
      {msg && <p className="mini__hint">{msg}</p>}
      {nights.length ? (
        <ul className="ma-list">
          {nights.map((n) => (
            <li key={n.id} className="ma-row">
              <div className="ma-row-main">
                <span className="ma-title">{fmtDay(n.sleepDate)} · {hoursBetween(n.bedtime, n.wake)}h</span>
                <span className="ma-sub">{n.bedtime} → {n.wake} · quality {n.quality}/5</span>
              </div>
              <button className="ma-x" type="button" onClick={() => void apiDeleteSleep({ ...a, id: n.id }).then(load)} title="Remove">×</button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="mini__empty">No nights logged yet.</p>
      )}
    </div>
  )
}

/* ----------------------------- Pipeline Board --------------------------- */

const PIPE_STAGES = [
  { id: 'lead', label: 'Lead' },
  { id: 'active', label: 'Active' },
  { id: 'interview', label: 'Interview' },
  { id: 'offer', label: 'Offer' },
  { id: 'won', label: 'Won' },
  { id: 'lost', label: 'Lost' },
] as const

export function PipelineBoardApp({ auth }: { auth: FeatureAuth }) {
  const a = useAuth(auth)
  const [items, setItems] = useState<PipelineItem[]>([])
  const [title, setTitle] = useState('')
  const [company, setCompany] = useState('')
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState('')

  const load = useCallback(() => {
    apiListPipeline(a).then((d) => setItems(d.items)).catch(() => setMsg('Could not load pipeline.'))
  }, [a.email, a.token])
  useEffect(() => { load() }, [load])

  async function add(e: FormEvent) {
    e.preventDefault()
    if (!title.trim() || busy) return
    setBusy(true)
    try {
      await apiAddPipeline({ ...a, title: title.trim(), company: company.trim() })
      setTitle(''); setCompany('')
      load()
    } catch {
      setMsg('Could not add that.')
    } finally {
      setBusy(false)
    }
  }

  function nextStage(stage: string) {
    const i = PIPE_STAGES.findIndex((s) => s.id === stage)
    return PIPE_STAGES[Math.min(PIPE_STAGES.length - 1, i + 1)]?.id || stage
  }

  return (
    <div className="ma">
      <form className="ma-form" onSubmit={add}>
        <input className="ma-input" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Deal, job, round…" aria-label="Title" />
        <input className="ma-input" value={company} onChange={(e) => setCompany(e.target.value)} placeholder="Company" aria-label="Company" />
        <button className="ma-btn" type="submit" disabled={busy || !title.trim()}>Add</button>
      </form>
      {msg && <p className="mini__hint">{msg}</p>}
      <div className="pipe-board">
        {PIPE_STAGES.map((s) => {
          const col = items.filter((i) => i.stage === s.id)
          return (
            <section key={s.id} className="pipe-col">
              <h3>{s.label} <span>{col.length}</span></h3>
              {col.map((i) => (
                <article key={i.id} className="pipe-card">
                  <strong>{i.title}</strong>
                  {i.company && <span>{i.company}</span>}
                  <div className="pipe-actions">
                    {s.id !== 'won' && s.id !== 'lost' && (
                      <button type="button" className="ma-chip" onClick={() => void apiPatchPipeline({ ...a, id: i.id, stage: nextStage(i.stage) }).then(load)}>Advance</button>
                    )}
                    {s.id !== 'lost' && s.id !== 'won' && (
                      <button type="button" className="ma-chip" onClick={() => void apiPatchPipeline({ ...a, id: i.id, stage: 'lost' }).then(load)}>Lost</button>
                    )}
                    <button type="button" className="ma-x" onClick={() => void apiPatchPipeline({ ...a, id: i.id, _delete: true }).then(load)}>×</button>
                  </div>
                </article>
              ))}
            </section>
          )
        })}
      </div>
    </div>
  )
}

/* --------------------------- Gratitude Journal -------------------------- */

export function GratitudeJournalApp({ auth }: { auth: FeatureAuth }) {
  const a = useAuth(auth)
  const [entries, setEntries] = useState<GratitudeEntry[]>([])
  const [weekCount, setWeekCount] = useState(0)
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState('')

  const load = useCallback(() => {
    apiListGratitude(a).then((d) => { setEntries(d.entries); setWeekCount(d.weekCount) }).catch(() => setMsg('Could not load journal.'))
  }, [a.email, a.token])
  useEffect(() => { load() }, [load])

  async function add(e: FormEvent) {
    e.preventDefault()
    if (!text.trim() || busy) return
    setBusy(true)
    try {
      await apiAddGratitude({ ...a, text: text.trim() })
      setText('')
      load()
    } catch {
      setMsg('Could not save that.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="ma">
      <p className="mini__hint">{weekCount} {weekCount === 1 ? 'note' : 'notes'} this week.</p>
      <form className="ma-stack" onSubmit={add}>
        <textarea className="ma-area" rows={2} value={text} onChange={(e) => setText(e.target.value)} placeholder="One sentence. What are you grateful for?" />
        <button className="ma-btn" type="submit" disabled={busy || !text.trim()}>Write it down</button>
      </form>
      {msg && <p className="mini__hint">{msg}</p>}
      {entries.length ? (
        <ul className="ma-list">
          {entries.map((e) => (
            <li key={e.id} className="ma-row">
              <div className="ma-row-main">
                <span className="ma-title">{e.text}</span>
                <span className="ma-sub">{fmtDay(e.createdAt)}</span>
              </div>
              <button className="ma-x" type="button" onClick={() => void apiDeleteGratitude({ ...a, id: e.id }).then(load)} title="Remove">×</button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="mini__empty">Nothing yet. One sentence is enough.</p>
      )}
    </div>
  )
}

/* --------------------------- Spending Snapshot -------------------------- */

const SPEND_CATS = ['food', 'transport', 'subscriptions', 'housing', 'fun', 'other'] as const

export function SpendingSnapshotApp({ auth }: { auth: FeatureAuth }) {
  const a = useAuth(auth)
  const [logs, setLogs] = useState<SpendLog[]>([])
  const [byCategory, setByCategory] = useState<Array<{ category: string; total: number }>>([])
  const [weekTotal, setWeekTotal] = useState(0)
  const [budget, setBudget] = useState(400)
  const [budgetEdit, setBudgetEdit] = useState('')
  const [showBudget, setShowBudget] = useState(false)
  const [amount, setAmount] = useState('')
  const [category, setCategory] = useState('food')
  const [description, setDescription] = useState('')
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState('')

  const load = useCallback(() => {
    apiListSpending(a).then((d) => {
      setLogs(d.logs)
      setByCategory(d.byCategory)
      setWeekTotal(d.weekTotal)
      setBudget(d.weeklyBudget)
    }).catch(() => setMsg('Could not load spending.'))
  }, [a.email, a.token])
  useEffect(() => { load() }, [load])

  async function add(e: FormEvent) {
    e.preventDefault()
    const n = Number(amount)
    if (!n || n <= 0 || busy) return
    setBusy(true)
    try {
      await apiLogSpend({ ...a, amount: n, category, description: description.trim() })
      setAmount(''); setDescription('')
      load()
    } catch {
      setMsg('Could not log that.')
    } finally {
      setBusy(false)
    }
  }

  const pct = budget > 0 ? Math.min(100, (weekTotal / budget) * 100) : 0
  const over = weekTotal > budget

  return (
    <div className="ma">
      <div className="spend-hero">
        <div>
          <span className="ma-sub">This week</span>
          <div className="spend-total">${Math.round(weekTotal)} <span>/ ${Math.round(budget)}</span></div>
        </div>
        <button className="ma-chip" type="button" onClick={() => { setBudgetEdit(String(budget)); setShowBudget((v) => !v) }}>Budget</button>
      </div>
      {showBudget && (
        <form className="ma-form" onSubmit={(e) => {
          e.preventDefault()
          const next = Number(budgetEdit)
          if (next > 0) void apiSetSpendBudget({ ...a, weeklyBudget: next }).then(() => { setShowBudget(false); load() })
        }}>
          <input className="ma-input ma-input--sm" value={budgetEdit} onChange={(e) => setBudgetEdit(e.target.value)} inputMode="decimal" aria-label="Weekly budget" />
          <button className="ma-btn" type="submit">Save budget</button>
        </form>
      )}
      <div className="nutr-modal-bar">
        <div className="nutr-modal-bar-inner">
          <div style={{ width: `${pct}%`, background: over ? '#ef4444' : 'var(--mini-accent, #22c55e)' }} />
        </div>
      </div>
      {over && <p className="mini__hint">${Math.round(weekTotal - budget)} over budget this week.</p>}
      <div className="ma-pills">
        {byCategory.map((c) => (
          <span key={c.category} className="ma-pill">{c.category} ${Math.round(c.total)}</span>
        ))}
      </div>
      <form className="ma-form" onSubmit={add}>
        <input className="ma-input ma-input--sm" value={amount} onChange={(e) => setAmount(e.target.value)} inputMode="decimal" placeholder="$" aria-label="Amount" />
        <select className="ma-input" value={category} onChange={(e) => setCategory(e.target.value)} aria-label="Category">
          {SPEND_CATS.map((c) => <option key={c} value={c}>{c}</option>)}
        </select>
        <input className="ma-input" value={description} onChange={(e) => setDescription(e.target.value)} placeholder="What for?" aria-label="Description" />
        <button className="ma-btn" type="submit" disabled={busy || !amount}>Log</button>
      </form>
      {msg && <p className="mini__hint">{msg}</p>}
      {logs.length ? (
        <ul className="ma-list">
          {logs.map((l) => (
            <li key={l.id} className="ma-row">
              <div className="ma-row-main">
                <span className="ma-title">${Number(l.amount).toFixed(2)} · {l.category}</span>
                <span className="ma-sub">{l.description || fmtDay(l.spentAt)}</span>
              </div>
              <button className="ma-x" type="button" onClick={() => void apiDeleteSpend({ ...a, id: l.id }).then(load)} title="Remove">×</button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="mini__empty">No spend logged this week.</p>
      )}
    </div>
  )
}
