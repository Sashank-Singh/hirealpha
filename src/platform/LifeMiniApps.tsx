import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react'
import { Link } from 'react-router-dom'
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
  apiPutMiniPrefs,
  apiLogSpend,
  apiLogWorkout,
  apiMirror,
  apiPatchLearning,
  apiPatchPipeline,
  apiSaveWeeklyReview,
  apiSetSpendBudget,
  apiTouchNetwork,
  apiWeeklyReview,
  type GratitudeEntry,
  type LearningItem,
  type MirrorSnapshot,
  type NetworkPerson,
  type NetworkStay,
  type NetworkToday,
  type PipelineItem,
  type SleepNight,
  type SpendLog,
  type WeeklyReview,
  type WeeklySnapshot,
  type WorkoutLog,
  type WorkoutPr,
} from './api'
import type { FeatureAuth } from './FeatureMiniApps'
import {
  defaultWorkoutWeekday,
  isWeekend,
  jsDayToWeekday,
  movePrescription,
  readWorkoutMoveCount,
  readWorkoutPlace,
  WORKOUT_DAY_LABELS,
  WORKOUT_DAY_LETTERS,
  WORKOUT_WEEKDAYS,
  workoutSession,
  writeWorkoutMoveCount,
  writeWorkoutPlace,
  setsRepsLabel,
  type WorkoutMove,
  type WorkoutMoveCount,
  type WorkoutPlace,
  type WorkoutWeekday,
} from './workoutProgram'
import { exerciseDemoUrl } from './exerciseDemos'

function useAuth(auth: FeatureAuth) {
  return { email: auth.email, token: auth.token, persona: auth.persona }
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

function daysSince(iso: string | null) {
  if (!iso) return 999
  return Math.floor((Date.now() - new Date(iso).getTime()) / 86400000)
}

function agoLabel(iso: string | null) {
  const n = daysSince(iso)
  if (n >= 999) return 'never'
  if (n <= 0) return 'today'
  if (n === 1) return 'yesterday'
  return `${n}d ago`
}

function parseNetworkLine(line: string) {
  const meet = line.match(/^(?:meet(?:ing)?(?:\s+with)?)\s+(.+?)(?:\s+at\s+(.+))?$/i)
  if (meet?.[1] && !/^(meet|meeting|call)$/i.test(meet[1].trim())) {
    return { name: meet[1].trim(), whereMet: (meet[2] || '').trim(), context: '' }
  }
  const at = line.match(/^(.+?)\s+@\s+([^:]+)(?::\s*(.*))?$/)
  if (at) return { name: at[1]!.trim(), whereMet: at[2]!.trim(), context: (at[3] || '').trim() }
  const colon = line.match(/^([^:,]+)[,:]\s*(.+)$/)
  if (colon && !/^(meet|meeting|call|coffee|lunch|dinner)$/i.test(colon[1]!.trim())) {
    return { name: colon[1]!.trim(), whereMet: '', context: colon[2]!.trim() }
  }
  const place = line.match(/^(.+?)\s+at\s+(.+)$/i)
  if (place) return { name: place[1]!.trim(), whereMet: place[2]!.trim(), context: '' }
  return { name: line.trim(), whereMet: '', context: '' }
}

function parsePipeLine(line: string) {
  const at = line.match(/^(.+?)\s+@\s+(.+)$/)
  if (at) return { title: at[1]!.trim(), company: at[2]!.trim() }
  return { title: line.trim(), company: '' }
}

function isoToLocalDate(iso: string) {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso.slice(0, 10)
  return localDateStr(d)
}

function shiftLocalDate(dateStr: string, days: number) {
  const [y, m, d] = dateStr.split('-').map(Number)
  return localDateStr(new Date(y || 1970, (m || 1) - 1, (d || 1) + days))
}

function daysLeftInWeek(weekStart: string) {
  if (!weekStart) return 0
  const [y, m, d] = weekStart.split('-').map(Number)
  const end = new Date(y || 1970, (m || 1) - 1, (d || 1) + 6)
  const today = new Date()
  today.setHours(0, 0, 0, 0)
  return Math.max(0, Math.round((end.getTime() - today.getTime()) / 86400000))
}

function openHttp(url: string) {
  const t = url.trim()
  if (!t) return ''
  return /^https?:\/\//i.test(t) ? t : `https://${t}`
}

/* ------------------------------ Workout Log ----------------------------- */

function lastWeightFor(logs: WorkoutLog[], name: string): number {
  const hit = logs.find((l) => l.exercise.toLowerCase() === name.toLowerCase() && l.weight > 0)
  return hit?.weight || 0
}

export function WorkoutLogApp({ auth }: { auth: FeatureAuth }) {
  const a = useAuth(auth)
  const [logs, setLogs] = useState<WorkoutLog[]>([])
  const [prs, setPrs] = useState<WorkoutPr[]>([])
  const [place, setPlace] = useState<WorkoutPlace>(() => readWorkoutPlace())
  const [moveCount, setMoveCount] = useState<WorkoutMoveCount>(() => readWorkoutMoveCount())
  const [viewDay, setViewDay] = useState<WorkoutWeekday>(() => defaultWorkoutWeekday())
  const [exercise, setExercise] = useState('')
  const [sets, setSets] = useState('3')
  const [reps, setReps] = useState('8')
  const [weight, setWeight] = useState('')
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState('')
  const [showNew, setShowNew] = useState(false)
  const [demoExercise, setDemoExercise] = useState<string | null>(null)
  const [demoUrls, setDemoUrls] = useState<Record<string, string | null>>({})

  const load = useCallback(() => {
    apiListWorkouts(a)
      .then((d) => {
        setLogs(d.logs)
        setPrs(d.prs)
        if (d.workoutPlace === 'home' || d.workoutPlace === 'gym') {
          setPlace(d.workoutPlace)
          writeWorkoutPlace(d.workoutPlace)
        }
        if (d.workoutMoveCount === 4 || d.workoutMoveCount === 5 || d.workoutMoveCount === 6) {
          setMoveCount(d.workoutMoveCount)
          writeWorkoutMoveCount(d.workoutMoveCount)
        }
      })
      .catch(() => setMsg('Could not load workouts.'))
  }, [a.email, a.token])
  useEffect(() => { load() }, [load])

  async function choosePlace(next: WorkoutPlace) {
    setPlace(next)
    writeWorkoutPlace(next)
    try {
      await apiPutMiniPrefs({ ...a, workoutPlace: next })
    } catch {
      setMsg('Could not save place.')
    }
  }

  async function chooseCount(next: WorkoutMoveCount) {
    setMoveCount(next)
    writeWorkoutMoveCount(next)
    try {
      await apiPutMiniPrefs({ ...a, workoutMoveCount: next })
    } catch {
      setMsg('Could not save moves.')
    }
  }

  async function logMoves(moves: WorkoutMove[], sessionName: string) {
    if (!moves.length || busy) return
    setBusy(true)
    setMsg('')
    const notes = `${place === 'home' ? 'Home' : 'Gym'} ${sessionName}`
    try {
      for (const move of moves) {
        await apiLogWorkout({
          ...a,
          exercise: move.name,
          sets: move.sets,
          reps: move.reps,
          weight: lastWeightFor(logs, move.name),
          notes,
        })
      }
      load()
    } catch {
      setMsg('Could not log that.')
    } finally {
      setBusy(false)
    }
  }

  async function unlogMove(name: string) {
    const hit = logs.find(
      (l) => isoToLocalDate(l.loggedAt) === localDateStr() && l.exercise.toLowerCase() === name.toLowerCase(),
    )
    if (!hit || busy) return
    setBusy(true)
    setMsg('')
    try {
      await apiDeleteWorkout({ ...a, id: hit.id })
      load()
    } catch {
      setMsg('Could not update.')
    } finally {
      setBusy(false)
    }
  }

  async function add(e: FormEvent) {
    e.preventDefault()
    if (!exercise.trim() || busy) return
    setBusy(true)
    setMsg('')
    try {
      await apiLogWorkout({
        ...a,
        exercise: exercise.trim(),
        sets: Number(sets) || 1,
        reps: Number(reps) || 1,
        weight: Number(weight) || 0,
      })
      setExercise('')
      setShowNew(false)
      load()
    } catch {
      setMsg('Could not log that.')
    } finally {
      setBusy(false)
    }
  }

  function handleDemoToggle(name: string) {
    if (demoExercise === name) {
      setDemoExercise(null)
      return
    }
    const key = name.toLowerCase()
    setDemoUrls((prev) => (key in prev ? prev : { ...prev, [key]: exerciseDemoUrl(name) }))
    setDemoExercise(name)
  }

  const session = workoutSession(place, viewDay, moveCount)
  const today = localDateStr()
  const todayWeekday = jsDayToWeekday(new Date().getDay())
  const viewingToday = todayWeekday === viewDay
  const weekend = isWeekend()
  const todayNames = new Set(
    logs.filter((l) => isoToLocalDate(l.loggedAt) === today).map((l) => l.exercise.toLowerCase()),
  )
  const left = session.moves.filter((m) => !todayNames.has(m.name.toLowerCase()))
  const doneCount = session.moves.length - left.length
  const allDone = left.length === 0
  const prMap = new Map(prs.map((p) => [p.exercise.toLowerCase(), p]))
  const placeLabel = place === 'home' ? 'Home' : 'Gym'
  const sessionNames = new Set(session.moves.map((m) => m.name.toLowerCase()))
  const history = logs.filter(
    (l) => !(isoToLocalDate(l.loggedAt) === today && sessionNames.has(l.exercise.toLowerCase())),
  )

  let heroKicker = viewingToday ? 'Today' : session.dayLabel
  let heroNum = session.name
  let heroLabel = `${session.moves.length} moves. ${placeLabel}.`
  if (weekend && viewDay === 1) {
    heroKicker = 'Rest'
    heroNum = 'Rest day'
    heroLabel = `Monday is ${session.name}. ${placeLabel}.`
  }
  if (allDone) {
    heroNum = 'All done'
    heroLabel = `${session.name}. ${placeLabel}.`
  } else if (doneCount > 0) {
    heroNum = `${doneCount} of ${session.moves.length}`
    heroLabel = left[0] ? `${left[0].name} is next` : heroLabel
  }

  const addForm = (
    <form className="ma-form" onSubmit={add}>
      <input className="ma-input" value={exercise} onChange={(e) => setExercise(e.target.value)} placeholder="Exercise" aria-label="Exercise" />
      <input className="ma-input ma-input--sm" value={sets} onChange={(e) => setSets(e.target.value)} inputMode="numeric" aria-label="Sets" placeholder="Sets" />
      <input className="ma-input ma-input--sm" value={reps} onChange={(e) => setReps(e.target.value)} inputMode="numeric" aria-label="Reps" placeholder="Reps" />
      <input className="ma-input ma-input--sm" value={weight} onChange={(e) => setWeight(e.target.value)} inputMode="decimal" aria-label="Weight" placeholder="Lbs" />
      <button className="ma-btn" type="submit" disabled={busy || !exercise.trim()}>Log</button>
    </form>
  )

  return (
    <div className="ma workout">
      <div className="ma-hero">
        <span className="ma-hero-kicker">{heroKicker}</span>
        <span className="ma-hero-num">{heroNum}</span>
        <span className="ma-hero-label">{heroLabel}</span>
      </div>

      <div className="wk-controls">
        <div className="wk-places">
          <button
            className={`wk-place${place === 'home' ? ' is-on' : ''}`}
            type="button"
            aria-pressed={place === 'home'}
            onClick={() => void choosePlace('home')}
          >
            Home
          </button>
          <button
            className={`wk-place${place === 'gym' ? ' is-on' : ''}`}
            type="button"
            aria-pressed={place === 'gym'}
            onClick={() => void choosePlace('gym')}
          >
            Gym
          </button>
        </div>

        <div className="wk-counts" role="group" aria-label="Moves per day">
          {([4, 5, 6] as const).map((n) => (
            <button
              key={n}
              className={`wk-place${moveCount === n ? ' is-on' : ''}`}
              type="button"
              aria-pressed={moveCount === n}
              onClick={() => void chooseCount(n)}
            >
              {n}
            </button>
          ))}
        </div>

        <div className="wk-days" role="tablist" aria-label="Weekday">
          {WORKOUT_WEEKDAYS.map((day) => (
            <button
              key={day}
              className={`wk-day${viewDay === day ? ' is-on' : ''}${todayWeekday === day ? ' is-today' : ''}`}
              type="button"
              role="tab"
              aria-selected={viewDay === day}
              aria-label={WORKOUT_DAY_LABELS[day]}
              onClick={() => setViewDay(day)}
            >
              {WORKOUT_DAY_LETTERS[day]}
            </button>
          ))}
        </div>
      </div>

      {left.length > 0 && (
        <button
          className="ma-btn ma-btn--block"
          type="button"
          disabled={busy}
          onClick={() => void logMoves(left, session.name)}
        >
          Done for today
        </button>
      )}

      {msg && <p className="mini__hint">{msg}</p>}

      <ul className="habit-list">
        {session.moves.map((move) => {
          const done = todayNames.has(move.name.toLowerCase())
          const lw = lastWeightFor(logs, move.name)
          const pr = prMap.get(move.name.toLowerCase())
          const isExpanded = demoExercise === move.name
          const demoKey = move.name.toLowerCase()
          const demoFetched = demoKey in demoUrls
          const demoUrl = demoUrls[demoKey]
          const demoLoading = isExpanded && !demoFetched
          return (
            <li key={move.name} className={`habit-card wk-card${isExpanded ? ' is-expanded' : ''}`}>
              <div className="habit-info">
                <button
                  className="wk-name-btn"
                  type="button"
                  aria-expanded={isExpanded}
                  onClick={() => handleDemoToggle(move.name)}
                >
                  {move.name}
                </button>
                <div className="habit-streak">
                  {movePrescription(move, lw)}
                  {pr ? `. PR ${Math.round(pr.weight)} x ${pr.reps}` : ''}
                </div>
              </div>
              <button
                className={`wk-act${done ? ' is-on' : ''}`}
                type="button"
                disabled={busy}
                onClick={() => void (done ? unlogMove(move.name) : logMoves([move], session.name))}
              >
                Done
              </button>
              {isExpanded && (
                <div className="wk-demo">
                  {demoLoading && <span className="wk-demo-hint">Loading...</span>}
                  {!demoLoading && demoUrl && (
                    <img
                      className="wk-demo-img"
                      src={demoUrl}
                      alt={`How to do ${move.name}`}
                      loading="lazy"
                      onError={() => setDemoUrls((prev) => ({ ...prev, [demoKey]: null }))}
                    />
                  )}
                  {!demoLoading && demoFetched && !demoUrl && (
                    <span className="wk-demo-hint">No demo for this lift</span>
                  )}
                </div>
              )}
            </li>
          )
        })}
      </ul>

      {history.length > 0 && (
        <ul className="habit-list">
          {history.slice(0, 20).map((l) => {
            const pr = prMap.get(l.exercise.toLowerCase())
            const isPr = pr && pr.weight === l.weight && pr.reps === l.reps
            return (
              <li key={l.id} className="habit-card">
                <div className="habit-info">
                  <div className="habit-name">{l.exercise}{isPr ? ' PR' : ''}</div>
                  <div className="habit-streak">
                    {setsRepsLabel(l.sets, l.reps)}{l.weight ? ` at ${l.weight} lbs` : ''} {fmtDay(l.loggedAt)}
                  </div>
                </div>
                <button className="habit-delete" type="button" onClick={() => void apiDeleteWorkout({ ...a, id: l.id }).then(load)} title="Remove">×</button>
              </li>
            )
          })}
        </ul>
      )}

      {!showNew && (
        <button className="ma-btn ma-btn--quiet ma-btn--block" type="button" onClick={() => setShowNew(true)}>New lift</button>
      )}
      {showNew && addForm}
    </div>
  )
}

/* ----------------------------- Learning Queue --------------------------- */

const LEARN_KINDS = [
  { value: 'article', label: 'Article' },
  { value: 'video', label: 'Video' },
  { value: 'podcast', label: 'Podcast' },
] as const

export function LearningQueueApp({ auth }: { auth: FeatureAuth }) {
  const a = useAuth(auth)
  const [items, setItems] = useState<LearningItem[]>([])
  const [title, setTitle] = useState('')
  const [kind, setKind] = useState<string>('article')
  const [notes, setNotes] = useState('')
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState('')
  const [showAdd, setShowAdd] = useState(false)

  const load = useCallback(() => {
    apiListLearning(a)
      .then((d) => {
        setItems(d.items || [])
        setMsg('')
      })
      .catch((err) =>
        setMsg(err instanceof Error && err.message ? err.message : 'Could not load queue.'),
      )
  }, [a.email, a.token])
  useEffect(() => { load() }, [load])

  async function add(e: FormEvent) {
    e.preventDefault()
    if (!title.trim() || busy) return
    setBusy(true)
    try {
      const raw = title.trim()
      const urlMatch = raw.match(/https?:\/\/\S+/i)?.[0]?.replace(/[),.;]+$/, '')
      const cleanTitle = raw.replace(/https?:\/\/\S+/gi, '').trim() || urlMatch || 'Saved'
      await apiAddLearning({
        ...a,
        title: cleanTitle.slice(0, 160),
        url: urlMatch,
        kind,
        notes: notes.trim() || undefined,
      })
      setTitle('')
      setNotes('')
      setShowAdd(false)
      load()
    } catch (err) {
      setMsg(err instanceof Error && err.message ? err.message : 'Could not add that.')
    } finally {
      setBusy(false)
    }
  }

  const queued = items.filter((i) => i.status !== 'done')
  const next = queued[0]
  const nextUrl = next?.url ? openHttp(next.url) : ''
  const kindLabel = (k: string) => LEARN_KINDS.find((x) => x.value === k)?.label || k

  async function markDone(id: string) {
    if (busy) return
    setBusy(true)
    try {
      await apiPatchLearning({ ...a, id, status: 'done' })
      load()
    } catch {
      setMsg('Could not update.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="ma">
      <div className="ma-hero">
        <span className="ma-hero-kicker">{next ? 'Next' : 'Queue'}</span>
        <span className="ma-hero-num">{next ? next.title : 'Nothing queued'}</span>
        <span className="ma-hero-label">
          {next
            ? `${kindLabel(next.kind)}${queued.length > 1 ? `. ${queued.length - 1} more` : ''}`
            : 'Save one article. It becomes next up.'}
        </span>
      </div>

      {next && nextUrl && (
        <a className="ma-btn ma-btn--block" href={nextUrl} target="_blank" rel="noreferrer">
          Play next
        </a>
      )}
      {next && !nextUrl && (
        <button className="ma-btn ma-btn--block" type="button" disabled={busy} onClick={() => void markDone(next.id)}>
          Mark done
        </button>
      )}
      {next && nextUrl && (
        <button className="ma-btn ma-btn--quiet ma-btn--block" type="button" disabled={busy} onClick={() => void markDone(next.id)}>
          Done with this
        </button>
      )}

      {msg && (
        <p className="mini__hint">
          {msg}{' '}
          <button className="ma-btn ma-btn--quiet" type="button" onClick={load}>Retry</button>
        </p>
      )}

      {queued.length > 0 && (
        <ul className="ma-list">
          {queued.map((i) => (
            <li key={i.id} className="ma-row">
              <div className="ma-row-main">
                <span className="ma-title">{i.title}</span>
                <span className="ma-sub">
                  {kindLabel(i.kind)}
                  {i.notes ? `. ${i.notes}` : ''}
                </span>
              </div>
              {i.id !== next?.id && (
                <button className="ma-chip" type="button" disabled={busy} onClick={() => void markDone(i.id)}>Done</button>
              )}
              <button className="ma-x" type="button" onClick={() => void apiPatchLearning({ ...a, id: i.id, _delete: true }).then(load)} title="Remove">×</button>
            </li>
          ))}
        </ul>
      )}

      {items.length > 0 && !showAdd && (
        <button className="ma-btn ma-btn--quiet ma-btn--block" type="button" onClick={() => setShowAdd(true)}>Save something</button>
      )}
      {(items.length === 0 || showAdd) && (
        <form className="ma-stack" onSubmit={add}>
          <input
            className="ma-input"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Title or URL"
            aria-label="Title or URL"
          />
          <label className="ma-field">
            <span>Kind</span>
            <select className="ma-input" value={kind} onChange={(e) => setKind(e.target.value)}>
              {LEARN_KINDS.map((k) => (
                <option key={k.value} value={k.value}>{k.label}</option>
              ))}
            </select>
          </label>
          <textarea
            className="ma-area"
            rows={3}
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            placeholder="Notes"
            aria-label="Notes"
          />
          <button className="ma-btn ma-btn--block" type="submit" disabled={busy || !title.trim()}>Save</button>
        </form>
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
  const [showRest, setShowRest] = useState(false)

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

  const insight = (() => {
    if (!snap) return 'This week is still forming.'
    if (snap.followUpsDue > 0) return `${snap.followUpsDue} follow ups waiting`
    if (snap.avgSleepHours && snap.avgSleepHours < 7) return `Sleep averaged ${snap.avgSleepHours}h. That's the leak.`
    if (snap.habitChecks === 0) return 'Habits went quiet this week.'
    if (snap.avgEnergy && snap.avgEnergy < 3) return `Energy averaged ${snap.avgEnergy.toFixed(1)}. Protect next week.`
    if (snap.meals === 0 && snap.sleepNights === 0) return 'Thin week. Log a few days so the review has teeth.'
    return 'Week looks held together. Name the focus.'
  })()
  const savedFocus = focusText.trim()

  return (
    <div className="ma">
      <div className="ma-hero">
        <span className="ma-hero-kicker">{weekStart ? `Week of ${fmtDay(weekStart)}` : 'This week'}</span>
        <span className="ma-hero-num">
          {savedFocus
            || (snap?.followUpsDue ? `${snap.followUpsDue} follow ups` : '')
            || (snap?.avgSleepHours ? `${snap.avgSleepHours}h sleep` : '')
            || 'Set this week'}
        </span>
        <span className="ma-hero-label">{savedFocus ? insight : snap ? insight : 'Numbers show up as you log the week.'}</span>
      </div>

      {snap && (
        <div className="ma-stats">
          <div className="ma-stat"><b>{snap.habitChecks}</b><span>habits</span></div>
          <div className="ma-stat"><b>{snap.followUpsDue}</b><span>follow ups</span></div>
          <div className="ma-stat"><b>{snap.meals}</b><span>meals</span></div>
        </div>
      )}

      <form className="ma-stack" onSubmit={save}>
        <label className="ma-label">Next week focus
          <textarea className="ma-area" rows={2} value={focusText} onChange={(e) => setFocusText(e.target.value)} placeholder="One thing that actually matters." />
        </label>
        <button className="ma-btn ma-btn--block" type="submit" disabled={busy || !weekStart}>
          {savedFocus ? 'Save focus' : 'Set focus'}
        </button>
        {!showRest && (
          <button className="ma-btn ma-btn--quiet ma-btn--block" type="button" onClick={() => setShowRest(true)}>
            What happened
          </button>
        )}
        {showRest && (
          <>
            <label className="ma-label">What got done
              <textarea className="ma-area" rows={2} value={doneText} onChange={(e) => setDoneText(e.target.value)} placeholder="Shipped, finished, showed up" />
            </label>
            <label className="ma-label">What slipped
              <textarea className="ma-area" rows={2} value={slippedText} onChange={(e) => setSlippedText(e.target.value)} placeholder="Missed, delayed, avoided" />
            </label>
          </>
        )}
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

/* ------------------------------ The Mirror ------------------------------ */

function mirrorNext(snap: MirrorSnapshot, focusText: string): {
  hot: boolean; kicker: string; title: string; hint: string; wantFocus?: boolean; openKind?: string
} {
  const w = snap.window
  const today = localDateStr()
  const lastMood = snap.moodTrend.length ? snap.moodTrend[snap.moodTrend.length - 1] : null
  const moodToday = snap.moodTrend.some((m) => m.date.slice(0, 10) === today)
  const lastNight = w.lastNightHours || 0
  const shortNights = w.shortNights || 0
  const protein = w.proteinToday || 0
  const proteinGoal = w.proteinGoal || 150

  if (lastNight > 0 && lastNight < 6.5 && (shortNights >= 2 || protein < 60)) {
    const proteinBit = proteinGoal ? ` Protein is at ${Math.round(protein)} of ${Math.round(proteinGoal)}.` : ''
    return {
      hot: true,
      kicker: 'The read',
      title: `${lastNight}h last night${shortNights >= 2 ? `, ${shortNights} short nights this week` : ''}`,
      hint: `Eat something with actual protein.${proteinBit} Skip the extra coffee.`,
      openKind: 'nutrition',
    }
  }
  if (w.weeklyBudget > 0 && w.spend > w.weeklyBudget && (w.workoutsToday === 0 || lastNight < 6.5)) {
    return {
      hot: true,
      kicker: 'The leak',
      title: `$${Math.round(w.spend - w.weeklyBudget)} over, and the week is thin`,
      hint: snap.spendByCategory[0]
        ? `${snap.spendByCategory[0].category} is the biggest slice. Sleep and gym are slipping with it.`
        : 'Spend, sleep, and gym are moving together.',
      openKind: 'spending_snapshot',
    }
  }
  if (proteinGoal > 0 && protein < 60 && (w.meals > 0 || lastNight > 0)) {
    return {
      hot: true,
      kicker: 'The read',
      title: `Protein is sitting at ${Math.round(protein)} of ${Math.round(proteinGoal)}`,
      hint: 'Dinner is one chicken bowl away. Eat that.',
      openKind: 'nutrition',
    }
  }
  if (!moodToday) {
    return {
      hot: true,
      kicker: 'Next',
      title: 'Log how you feel',
      hint: lastMood ? `Last ${lastMood.emoji} on ${fmtDay(lastMood.date)}` : 'Open Mood and tap a face.',
      openKind: 'mood_tracker',
    }
  }
  if (w.sleepNights === 0) {
    return { hot: true, kicker: 'Next', title: 'Log last night', hint: 'Bedtime and wake. Two numbers.', openKind: 'sleep_tracker' }
  }
  if (w.weeklyBudget > 0 && w.spend > w.weeklyBudget) {
    return {
      hot: true,
      kicker: 'Over budget',
      title: `$${Math.round(w.spend - w.weeklyBudget)} over this week`,
      hint: snap.spendByCategory[0] ? `${snap.spendByCategory[0].category} is the biggest slice.` : 'Open spending to see where.',
      openKind: 'spending_snapshot',
    }
  }
  if (w.decisionsOpen > 0) {
    return { hot: true, kicker: 'Next', title: 'Review a decision', hint: `${w.decisionsOpen} still open.`, openKind: 'decision_ledger' }
  }
  if (w.learningQueued > 0) {
    return {
      hot: true,
      kicker: 'Next',
      title: snap.nextLearning || 'Do one saved item',
      hint: `${w.learningQueued} in the queue.`,
      openKind: 'learning_queue',
    }
  }
  const focus = (snap.currentReview?.focusText || focusText).trim()
  if (!focus) {
    return { hot: true, kicker: 'Next', title: 'Set this week\'s focus', hint: 'One sentence is enough.', wantFocus: true }
  }
  return { hot: false, kicker: 'On track', title: focus, hint: 'Keep logging. The numbers stay honest.' }
}

export function MirrorApp({ auth }: { auth: FeatureAuth }) {
  const a = useAuth(auth)
  const [snap, setSnap] = useState<MirrorSnapshot | null>(null)
  const [msg, setMsg] = useState('')
  const [busy, setBusy] = useState(false)
  const [focusText, setFocusText] = useState('')

  const load = useCallback(() => {
    apiMirror(a).then((d) => {
      setSnap(d)
      if (d.currentReview) setFocusText(d.currentReview.focusText)
    }).catch(() => setMsg('Could not load your mirror.'))
  }, [a.email, a.token])
  useEffect(() => { load() }, [load])

  const w = snap?.window
  const moodAvg = w && w.moodLogs > 0 ? w.avgEnergy.toFixed(1) : 'none'
  const spendPct = w && w.weeklyBudget > 0 ? Math.round((w.spend / w.weeklyBudget) * 100) : 0
  const next = snap ? mirrorNext(snap, focusText) : null

  async function saveFocus(e: FormEvent) {
    e.preventDefault()
    if (busy || !snap || !focusText.trim()) return
    setBusy(true)
    try {
      await apiSaveWeeklyReview({
        ...a,
        weekStart: snap.weekStart,
        doneText: snap.currentReview?.doneText || '',
        slippedText: snap.currentReview?.slippedText || '',
        focusText: focusText.trim(),
      })
      setMsg('Focus saved.')
      load()
    } catch {
      setMsg('Could not save.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="ma">
      {!snap && !msg && <p className="mini__empty">The picture fills in as you log the week.</p>}
      {next && (
        <div className={`ma-callout${next.hot ? ' ma-callout--hot' : ''}`}>
          <span className="ma-callout-kicker">{next.kicker}</span>
          <strong>{next.title}</strong>
          <span className="ma-sub">{next.hint}</span>
          {next.openKind && (
            <div className="ma-callout-actions">
              <Link className="ma-btn" to={`/app/mini/${auth.persona}/${next.openKind}`}>Open</Link>
            </div>
          )}
          {'wantFocus' in next && next.wantFocus && (
            <form className="ma-form" onSubmit={saveFocus}>
              <input className="ma-input" value={focusText} onChange={(e) => setFocusText(e.target.value)} placeholder="One sentence for this week" aria-label="Weekly focus" />
              <button className="ma-btn" type="submit" disabled={busy || !focusText.trim()}>Set</button>
            </form>
          )}
        </div>
      )}
      {w && (
        <div className="ma-stats">
          <div className="ma-stat"><b>{moodAvg}</b><span>energy</span></div>
          <div className="ma-stat"><b>{w.sleepNights ? w.avgSleepHours : 'none'}</b><span>sleep h</span></div>
          <div className="ma-stat"><b>${Math.round(w.spend)}</b><span>{spendPct}% budget</span></div>
          <div className="ma-stat"><b>{w.habitChecks}</b><span>habits</span></div>
          <div className="ma-stat"><b>{w.workouts}</b><span>workouts</span></div>
          <div className="ma-stat"><b>{w.meals}</b><span>meals</span></div>
        </div>
      )}
      {snap && snap.moodTrend.length > 0 && (
        <div className="mirror-mood-row">
          {snap.moodTrend.slice(-7).map((m, i) => (
            <span key={i} className="mirror-mood" title={`${m.date} energy ${m.energy}`}>{m.emoji}</span>
          ))}
        </div>
      )}
      {snap && snap.spendByCategory.length > 0 && (
        <div className="ma-pills">
          {snap.spendByCategory.map((c) => (
            <span key={c.category} className="ma-pill">{c.category} ${Math.round(c.amount)}</span>
          ))}
        </div>
      )}
      {msg && <p className="mini__hint">{msg}</p>}
    </div>
  )
}

/* ---------------------------- Networking CRM ---------------------------- */
function smsDraft(name: string) {
  return `sms:&body=${encodeURIComponent(`Hey ${name}, checking in.`)}`
}

function kindLabel(kind: string): string {
  if (kind === 'Google Meet') return 'Google Meet'
  if (kind === 'Phone call') return 'Call'
  if (kind === 'In person') return 'In person'
  return kind || 'Meeting'
}

function kindBadgeClass(kind: string): string {
  if (kind === 'Google Meet') return 'ma-kind-badge ma-kind-badge--meet'
  if (kind === 'Phone call') return 'ma-kind-badge ma-kind-badge--call'
  if (kind === 'In person') return 'ma-kind-badge ma-kind-badge--person'
  return 'ma-kind-badge'
}

export function NetworkingCrmApp({ auth }: { auth: FeatureAuth }) {
  const a = useAuth(auth)
  const [people, setPeople] = useState<NetworkPerson[]>([])
  const [today, setToday] = useState<NetworkToday[]>([])
  const [stay, setStay] = useState<NetworkStay | null>(null)
  const [calendarConnected, setCalendarConnected] = useState<boolean | null>(null)
  const [line, setLine] = useState('')
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState('')
  const [showAdd, setShowAdd] = useState(false)
  const [logNotes, setLogNotes] = useState<Record<string, string>>({})

  const load = useCallback(() => {
    apiListNetwork(a)
      .then((d) => {
        setPeople(d.people)
        setToday(d.today || [])
        setStay(d.stay ?? null)
        setCalendarConnected(d.calendarConnected ?? null)
      })
      .catch(() => setMsg('Could not load people.'))
  }, [a.email, a.token, a.persona])
  useEffect(() => { load() }, [load])

  async function add(e: FormEvent) {
    e.preventDefault()
    if (!line.trim() || busy) return
    setBusy(true)
    try {
      const parsed = parseNetworkLine(line.trim())
      await apiAddNetwork({ ...a, name: parsed.name, whereMet: parsed.whereMet, context: parsed.context })
      setLine('')
      setShowAdd(false)
      load()
    } catch {
      setMsg('Could not add that.')
    } finally {
      setBusy(false)
    }
  }

  async function talked(id: string, note?: string) {
    await apiTouchNetwork({ ...a, id, context: note?.trim() || undefined }).catch(() => undefined)
    setLogNotes((prev) => { const n = { ...prev }; delete n[id]; return n })
    load()
  }

  async function logCalPerson(name: string, note?: string) {
    const existing = people.find((p) => p.name.toLowerCase() === name.toLowerCase())
    if (existing) {
      await apiTouchNetwork({ ...a, id: existing.id, context: note?.trim() || undefined }).catch(() => undefined)
    } else {
      await apiAddNetwork({ ...a, name, whereMet: 'Calendar', context: note?.trim() || '' }).catch(() => undefined)
    }
    load()
  }

  const genericName = /^(meet|meeting|call|coffee|lunch|dinner|hang)$/i
  const contacts = people.filter((p) => !genericName.test(p.name.trim()))
  const ranked = contacts.slice().sort((x, y) => {
    const xo = daysSince(x.lastTouch) - x.cadenceDays
    const yo = daysSince(y.lastTouch) - y.cadenceDays
    return yo - xo
  })
  const due = ranked.filter((p) => daysSince(p.lastTouch) >= p.cadenceDays)
  const inPersonToday = today.filter((e) => e.kind === 'In person')
  const remoteToday = today.filter((e) => e.kind !== 'In person')

  return (
    <div className="ma">

      {/* Where you are chip */}
      {stay && (
        <div className="ma-where-chip">
          <span className="ma-where-label">Where you are</span>
          <span className="ma-where-title">{stay.title}</span>
          {stay.place && <span className="ma-where-sub">{stay.place}</span>}
        </div>
      )}

      {/* In person today */}
      {inPersonToday.length > 0 && (
        <section className="ma-section">
          <span className="ma-section-label">Seeing today</span>
          {inPersonToday.map((e, i) => {
            const noteKey = `cal-${i}`
            return (
              <div key={noteKey} className="ma-callout ma-callout--hot">
                <div className="ma-callout-row">
                  <strong>{e.who || e.title}</strong>
                  <span className={kindBadgeClass(e.kind)}>{kindLabel(e.kind)}</span>
                </div>
                <span className="ma-sub">{[e.time, e.place].filter(Boolean).join(' · ')}</span>
                <div className="ma-callout-actions">
                  <button
                    className="ma-chip"
                    type="button"
                    onClick={() => void logCalPerson(e.who || e.title, logNotes[noteKey])}
                  >
                    Log
                  </button>
                </div>
              </div>
            )
          })}
        </section>
      )}

      {/* Remote meetings today (Meet / Call) */}
      {remoteToday.length > 0 && (
        <section className="ma-section">
          <span className="ma-section-label">On the calendar</span>
          <ul className="ma-list">
            {remoteToday.map((e, i) => {
              const noteKey = `remote-${i}`
              return (
                <li key={noteKey} className="ma-row">
                  <div className="ma-row-main">
                    <span className="ma-title">
                      {e.who || e.title}
                      <span className={kindBadgeClass(e.kind)}>{kindLabel(e.kind)}</span>
                    </span>
                    <span className="ma-sub">{e.time}{e.place ? ` · ${e.place}` : ''}</span>
                  </div>
                  <button
                    className="ma-chip"
                    type="button"
                    onClick={() => void logCalPerson(e.who || e.title, logNotes[noteKey])}
                  >
                    Log
                  </button>
                </li>
              )
            })}
          </ul>
        </section>
      )}

      {/* No calendar connected */}
      {calendarConnected === false && today.length === 0 && (
        <div className="ma-callout">
          <span className="ma-callout-kicker">Connect Calendar</span>
          <strong>See who you are meeting</strong>
          <span className="ma-sub">Go to Settings and connect your Google Calendar to see today's people here.</span>
        </div>
      )}

      {/* Overdue outreach callout */}
      {due.length > 0 && (
        <section className="ma-section">
          <span className="ma-section-label">Reach out</span>
          <div className="ma-callout ma-callout--hot">
            <strong>{due[0]!.name}</strong>
            <span className="ma-sub">{due[0]!.context || due[0]!.whereMet || 'No note yet'} · {agoLabel(due[0]!.lastTouch)}</span>
            <input
              className="ma-input"
              value={logNotes[due[0]!.id] || ''}
              onChange={(ev) => setLogNotes((prev) => ({ ...prev, [due[0]!.id]: ev.target.value }))}
              placeholder="What did you talk about?"
              aria-label="Note"
            />
            <div className="ma-callout-actions">
              <a className="ma-btn" href={smsDraft(due[0]!.name)}>Text</a>
              <button className="ma-chip" type="button" onClick={() => void talked(due[0]!.id, logNotes[due[0]!.id])}>Talked</button>
            </div>
          </div>
          {due.length > 1 && (
            <p className="mini__hint">{due.length - 1} more {due.length === 2 ? 'person is' : 'people are'} due.</p>
          )}
        </section>
      )}

      {/* All clear */}
      {contacts.length > 0 && due.length === 0 && (
        <div className="ma-callout">
          <span className="ma-callout-kicker">All clear</span>
          <strong>Nobody is due</strong>
          <span className="ma-sub">Keep touching base. Last notes stay on each person.</span>
        </div>
      )}

      {/* Empty state (no CRM and no calendar events) */}
      {!contacts.length && today.length === 0 && calendarConnected !== false && (
        <p className="mini__empty">Type a name below. Alpha will remind you when to follow up.</p>
      )}

      {/* People roster */}
      {contacts.length > 0 && (
        <ul className="ma-list">
          {ranked.map((p) => {
            const late = daysSince(p.lastTouch) >= p.cadenceDays
            return (
              <li key={p.id} className={`ma-row${late ? ' ma-row--warn' : ''}`}>
                <div className="ma-row-main">
                  <span className="ma-title">
                    {p.name}
                    {late && <span className="ma-badge">due</span>}
                  </span>
                  <span className="ma-sub">{p.context || p.whereMet || 'No note yet'} · {agoLabel(p.lastTouch)}</span>
                </div>
                <button className="ma-chip" type="button" onClick={() => void talked(p.id, logNotes[p.id])}>Talked</button>
                {late && <a className="ma-chip" href={smsDraft(p.name)}>Text</a>}
              </li>
            )
          })}
        </ul>
      )}

      {/* Add form */}
      {(showAdd || !contacts.length) ? (
        <form className="ma-form" onSubmit={add}>
          <input
            className="ma-input"
            value={line}
            onChange={(e) => setLine(e.target.value)}
            placeholder="Priya @ dinner: hiring at Stripe"
            aria-label="Person"
          />
          <button className="ma-btn" type="submit" disabled={busy || !line.trim()}>Add</button>
        </form>
      ) : (
        <button className="ma-btn ma-btn--quiet" type="button" onClick={() => setShowAdd(true)}>Add a person</button>
      )}

      {msg && <p className="mini__hint">{msg}</p>}
    </div>
  )
}

/* ----------------------------- Sleep Tracker ---------------------------- */

const SHORTCUT_URL = 'https://www.icloud.com/shortcuts/hirealpha-sleep'

function sleepSourceLabel(source?: string | null) {
  if (source === 'apple_health') return 'Apple Health'
  return null
}

export function SleepTrackerApp({ auth }: { auth: FeatureAuth }) {
  const a = useAuth(auth)
  const [nights, setNights] = useState<SleepNight[]>([])
  const [bedtime, setBedtime] = useState('23:00')
  const [wake, setWake] = useState('07:00')
  const [quality, setQuality] = useState(3)
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState('')
  const [showTimes, setShowTimes] = useState(false)
  const [showShortcut, setShowShortcut] = useState(false)
  const [copied, setCopied] = useState(false)

  const load = useCallback(() => {
    apiListSleep(a)
      .then((d) => {
        setNights(d.nights)
        const key = lastNightDateStr()
        const logged = d.nights.find((n) => n.sleepDate.slice(0, 10) === key)
        if (logged) {
          setBedtime(logged.bedtime)
          setWake(logged.wake)
          setQuality(logged.quality)
        } else {
          if (d.sleepBedtime) setBedtime(d.sleepBedtime)
          if (d.sleepWake) setWake(d.sleepWake)
        }
      })
      .catch(() => setMsg('Could not load sleep.'))
  }, [a.email, a.token])
  useEffect(() => { load() }, [load])

  async function save() {
    if (busy) return
    setBusy(true)
    try {
      await apiLogSleep({ ...a, bedtime, wake, quality, sleepDate: lastNightDateStr() })
      setShowTimes(false)
      load()
    } catch {
      setMsg('Could not log sleep.')
    } finally {
      setBusy(false)
    }
  }

  function copyToken() {
    if (!a.token) return
    void navigator.clipboard.writeText(a.token).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    })
  }

  const lastNightKey = lastNightDateStr()
  const lastNight = nights.find((n) => n.sleepDate.slice(0, 10) === lastNightKey)
  const last7 = nights.slice(0, 7)
  const avg = last7.length
    ? last7.reduce((s, n) => s + hoursBetween(n.bedtime, n.wake), 0) / last7.length
    : 0
  const debt = last7.reduce((s, n) => s + Math.max(0, 8 - hoursBetween(n.bedtime, n.wake)), 0)
  const lastHours = lastNight ? hoursBetween(lastNight.bedtime, lastNight.wake) : 0
  const previewHours = hoursBetween(bedtime, wake)
  const fromHealth = sleepSourceLabel(lastNight?.source)

  return (
    <div className="ma">
      <div className="ma-hero">
        <span className="ma-hero-kicker">
          {lastNight ? 'Last night' : 'Not logged'}
          {fromHealth && <span className="ma-badge" style={{ marginLeft: 6 }}>{fromHealth}</span>}
        </span>
        <span className="ma-hero-num">{lastNight ? `${lastHours}h` : 'Log last night'}</span>
        <span className="ma-hero-label">
          {lastNight
            ? `${formatClock12(lastNight.bedtime)} to ${formatClock12(lastNight.wake)}${avg ? `  Avg ${avg.toFixed(1)}h` : ''}${debt >= 2 ? `  ${debt.toFixed(1)}h debt` : ''}`
            : nights.length
              ? `Same as last time? ${previewHours}h  ${formatClock12(bedtime)} to ${formatClock12(wake)}`
              : 'Connect Apple Health or log manually below.'}
        </span>
      </div>

      {last7.length > 0 && (
        <div className="sleep-bars">
          {last7.slice().reverse().map((n) => {
            const h = hoursBetween(n.bedtime, n.wake)
            return (
              <div key={n.id} className="sleep-bar-col" title={`${n.sleepDate} ${h}h`}>
                <div className="sleep-bar" style={{ height: `${Math.min(100, (h / 10) * 100)}%` }} />
                <span>{String(Number(n.sleepDate.slice(8, 10)) || '')}</span>
              </div>
            )
          })}
        </div>
      )}

      {!lastNight && (
        <>
          <button className="ma-btn ma-btn--block" type="button" disabled={busy} onClick={() => void save()}>
            Log {previewHours}h last night
          </button>
          <button
            className="ma-btn ma-btn--quiet ma-btn--block"
            type="button"
            onClick={() => setShowShortcut((v) => !v)}
          >
            {showShortcut ? 'Hide setup' : 'Auto from Apple Health'}
          </button>
          {showShortcut && (
            <div className="ma-callout">
              <span className="ma-callout-kicker">iOS Shortcut setup</span>
              <strong>Run once on your iPhone</strong>
              <span className="ma-sub">
                1. Install the HireAlpha Sleep Shortcut from the link below.
                2. Tap Copy Token and paste it into the Shortcut when prompted.
                3. Run the Shortcut each morning or set it to run automatically at 7 AM.
                It reads last night from Apple Health and sends it here. No typing required.
              </span>
              <div className="ma-callout-actions">
                <a
                  className="ma-btn"
                  href={SHORTCUT_URL}
                  target="_blank"
                  rel="noreferrer"
                >
                  Get Shortcut
                </a>
                {a.token && (
                  <button className="ma-chip" type="button" onClick={copyToken}>
                    {copied ? 'Copied' : 'Copy Token'}
                  </button>
                )}
              </div>
            </div>
          )}
        </>
      )}

      {lastNight && !showTimes && (
        <p className="ma-insight">
          {fromHealth ? `Pulled from ${fromHealth} automatically.` : 'Last night is in.'}{' '}
          Change times if it was off.
        </p>
      )}

      {(showTimes || nights.length === 0) && (
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
      )}
      {!showTimes && nights.length > 0 && (
        <button className="ma-btn ma-btn--quiet ma-btn--block" type="button" onClick={() => setShowTimes(true)}>
          Change times
        </button>
      )}
      {lastNight && showTimes && (
        <button className="ma-btn ma-btn--block" type="button" disabled={busy} onClick={() => void save()}>
          Update last night
        </button>
      )}

      {msg && <p className="mini__hint">{msg}</p>}
      {nights.length ? (
        <ul className="ma-list">
          {nights.slice(0, 21).map((n) => {
            const srcLabel = sleepSourceLabel(n.source)
            return (
              <li key={n.id} className="ma-row">
                <div className="ma-row-main">
                  <span className="ma-title">
                    {fmtDay(n.sleepDate)}  {hoursBetween(n.bedtime, n.wake)}h
                    {srcLabel && <span className="ma-badge" style={{ marginLeft: 4, fontSize: '0.7em' }}>{srcLabel}</span>}
                  </span>
                  <span className="ma-sub">{formatClock12(n.bedtime)} to {formatClock12(n.wake)}  quality {n.quality}/5</span>
                </div>
                <button className="ma-x" type="button" onClick={() => void apiDeleteSleep({ ...a, id: n.id }).then(load)} title="Remove">×</button>
              </li>
            )
          })}
        </ul>
      ) : (
        <p className="mini__empty">Log last night. Bed and wake stick next time.</p>
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

const PIPE_HEAT: Record<string, number> = { offer: 400, interview: 300, active: 200, lead: 100, won: -1, lost: -1 }

function pipeAction(stage: string) {
  if (stage === 'lead') return 'Reach out'
  if (stage === 'active') return 'Move to interview'
  if (stage === 'interview') return 'Move to offer'
  if (stage === 'offer') return 'Mark won'
  return 'Advance'
}

export function PipelineBoardApp({ auth }: { auth: FeatureAuth }) {
  const a = useAuth(auth)
  const [items, setItems] = useState<PipelineItem[]>([])
  const [line, setLine] = useState('')
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState('')
  const [showAdd, setShowAdd] = useState(false)

  const load = useCallback(() => {
    apiListPipeline(a).then((d) => setItems(d.items)).catch(() => setMsg('Could not load pipeline.'))
  }, [a.email, a.token])
  useEffect(() => { load() }, [load])

  async function add(e: FormEvent) {
    e.preventDefault()
    if (!line.trim() || busy) return
    setBusy(true)
    try {
      const parsed = parsePipeLine(line.trim())
      await apiAddPipeline({ ...a, title: parsed.title, company: parsed.company })
      setLine('')
      setShowAdd(false)
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

  const live = items.filter((i) => i.stage !== 'won' && i.stage !== 'lost')
  const hottest = live.slice().sort((x, y) => {
    const hx = (PIPE_HEAT[x.stage] || 0) + daysSince(x.updatedAt)
    const hy = (PIPE_HEAT[y.stage] || 0) + daysSince(y.updatedAt)
    return hy - hx
  })[0]
  const rest = items.filter((i) => i.id !== hottest?.id)
  const stagesWithCards = PIPE_STAGES.filter((s) => rest.some((i) => i.stage === s.id))

  return (
    <div className="ma">
      {hottest && (
        <div className="ma-callout ma-callout--hot">
          <span className="ma-callout-kicker">{PIPE_STAGES.find((s) => s.id === hottest.stage)?.label} · hottest</span>
          <strong>{hottest.title}</strong>
          {hottest.company && <span className="ma-sub">{hottest.company}</span>}
          {hottest.notes && <span className="ma-sub">{hottest.notes}</span>}
          <div className="ma-callout-actions">
            <button type="button" className="ma-btn" onClick={() => void apiPatchPipeline({ ...a, id: hottest.id, stage: nextStage(hottest.stage) }).then(load)}>
              {pipeAction(hottest.stage)}
            </button>
            <button type="button" className="ma-chip" onClick={() => void apiPatchPipeline({ ...a, id: hottest.id, stage: 'lost' }).then(load)}>Lost</button>
          </div>
        </div>
      )}
      {!items.length && <p className="mini__empty">Add a deal, job, or round. The hottest one sits on top.</p>}
      {(showAdd || !items.length) ? (
        <form className="ma-form" onSubmit={add}>
          <input
            className="ma-input"
            value={line}
            onChange={(e) => setLine(e.target.value)}
            placeholder="PM @ Stripe"
            aria-label="Deal"
          />
          <button className="ma-btn" type="submit" disabled={busy || !line.trim()}>Add</button>
        </form>
      ) : (
        <button className="ma-btn ma-btn--quiet" type="button" onClick={() => setShowAdd(true)}>Add a deal</button>
      )}
      {msg && <p className="mini__hint">{msg}</p>}
      <div className="pipe-now">
        {stagesWithCards.map((s) => {
          const col = rest.filter((i) => i.stage === s.id)
          return (
            <div key={s.id}>
              <div className="pipe-stage">{s.label} {col.length}</div>
              <ul className="ma-list">
                {col.map((i) => (
                  <li key={i.id} className={`ma-row${s.id === 'lost' || s.id === 'won' ? ' ma-row--done' : ''}`}>
                    <div className="ma-row-main">
                      <span className="ma-title">{i.title}</span>
                      <span className="ma-sub">{i.company || s.label}</span>
                    </div>
                    {s.id !== 'won' && s.id !== 'lost' && (
                      <button type="button" className="ma-chip" onClick={() => void apiPatchPipeline({ ...a, id: i.id, stage: nextStage(i.stage) }).then(load)}>
                        {pipeAction(i.stage)}
                      </button>
                    )}
                  </li>
                ))}
              </ul>
            </div>
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

  const today = localDateStr()
  const todayEntries = entries.filter((e) => isoToLocalDate(e.createdAt) === today)
  const days = new Set(entries.map((e) => isoToLocalDate(e.createdAt)))
  let streak = 0
  let cursor = days.has(today) ? today : shiftLocalDate(today, -1)
  while (days.has(cursor)) {
    streak++
    cursor = shiftLocalDate(cursor, -1)
  }
  const wroteToday = todayEntries.length > 0

  return (
    <div className="ma">
      <div className="ma-hero">
        <span className="ma-hero-kicker">{wroteToday ? 'Logged today' : 'Not yet today'}</span>
        <span className="ma-hero-num">
          {streak > 0 ? `${streak} day streak` : `${weekCount} this week`}
        </span>
        <span className="ma-hero-label">
          {wroteToday
            ? todayEntries[0]?.text || `${weekCount} notes this week`
            : 'One sentence. That is the whole practice.'}
        </span>
      </div>

      <form className="ma-form" onSubmit={add}>
        <input
          className="ma-input"
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder={wroteToday ? 'Another one?' : 'What are you grateful for?'}
          aria-label="Gratitude"
        />
        <button className="ma-btn" type="submit" disabled={busy || !text.trim()}>
          {wroteToday ? 'Add' : 'Write it'}
        </button>
      </form>
      {msg && <p className="mini__hint">{msg}</p>}
      {entries.length ? (
        <ul className="ma-list">
          {entries.slice(0, 8).map((e) => (
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
        <p className="mini__empty">Write one sentence. That is the whole practice.</p>
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
  const [weekStart, setWeekStart] = useState('')
  const [budgetEdit, setBudgetEdit] = useState('')
  const [showBudget, setShowBudget] = useState(false)
  const [amount, setAmount] = useState('')
  const [category, setCategory] = useState('food')
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState('')
  const [showLog, setShowLog] = useState(false)

  const load = useCallback(() => {
    apiListSpending(a).then((d) => {
      setLogs(d.logs)
      setByCategory(d.byCategory)
      setWeekTotal(d.weekTotal)
      setBudget(d.weeklyBudget)
      setWeekStart(d.weekStart)
      if (d.logs[0]?.category) setCategory(d.logs[0].category)
    }).catch(() => setMsg('Could not load spending.'))
  }, [a.email, a.token])
  useEffect(() => { load() }, [load])

  async function add(e: FormEvent) {
    e.preventDefault()
    const n = Number(amount)
    if (!n || n <= 0 || busy) return
    setBusy(true)
    try {
      await apiLogSpend({ ...a, amount: n, category })
      setAmount('')
      setShowLog(false)
      load()
    } catch {
      setMsg('Could not log that.')
    } finally {
      setBusy(false)
    }
  }

  const left = budget - weekTotal
  const over = left < 0
  const pct = budget > 0 ? Math.min(100, (weekTotal / budget) * 100) : 0
  const remainDays = Math.max(1, daysLeftInWeek(weekStart) + 1)
  const perDay = !over ? Math.round(Math.max(0, left) / remainDays) : 0
  const last = logs[0]
  const topCat = [...byCategory].sort((a, b) => b.total - a.total)[0]

  return (
    <div className="ma">
      <div className="spend-hero">
        <div className="ma-hero">
          <span className="ma-hero-kicker">{over ? 'Over budget' : 'This week'}</span>
          <div className="spend-total">
            {over ? `$${Math.round(-left)} over` : `$${Math.round(Math.max(0, left))} left`}
            <span> / ${Math.round(budget)}</span>
          </div>
          <p className="ma-insight">
            {over
              ? `${topCat ? topCat.category : 'Spending'} is the leak.`
              : logs.length
                ? `$${perDay} a day left${topCat ? `. Most on ${topCat.category}` : ''}`
                : 'Log the next spend. The week total fills in.'}
          </p>
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
      <div className="ma-pills">
        {SPEND_CATS.map((c) => (
          <button
            key={c}
            type="button"
            className={`ma-chip${category === c ? ' ma-chip--on' : ''}`}
            onClick={() => { setCategory(c); setShowLog(true) }}
          >
            {c}{byCategory.find((x) => x.category === c) ? ` $${Math.round(byCategory.find((x) => x.category === c)!.total)}` : ''}
          </button>
        ))}
      </div>

      {(showLog || logs.length === 0) ? (
        <form className="ma-form" onSubmit={add}>
          <input className="ma-input ma-input--sm" value={amount} onChange={(e) => setAmount(e.target.value)} inputMode="decimal" placeholder="$" aria-label="Amount" />
          <button className="ma-btn" type="submit" disabled={busy || !amount}>Log {category}</button>
        </form>
      ) : (
        <button className="ma-btn ma-btn--block" type="button" onClick={() => setShowLog(true)}>
          {last ? `Log ${last.category}` : 'Log spend'}
        </button>
      )}

      {msg && <p className="mini__hint">{msg}</p>}
      {logs.length ? (
        <ul className="ma-list">
          {logs.slice(0, 40).map((l) => (
            <li key={l.id} className="ma-row">
              <div className="ma-row-main">
                <span className="ma-title">${Number(l.amount).toFixed(2)}  {l.category}</span>
                <span className="ma-sub">{l.description || fmtDay(l.spentAt)}</span>
              </div>
              <button className="ma-x" type="button" onClick={() => void apiDeleteSpend({ ...a, id: l.id }).then(load)} title="Remove">×</button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="mini__empty">Log the next spend. The week total fills in.</p>
      )}
    </div>
  )
}
