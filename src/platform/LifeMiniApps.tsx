import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react'
import { useNavigate } from 'react-router-dom'
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
  apiListWorkDrafts,
  apiListWorkouts,
  apiLogSleep,
  apiPutMiniPrefs,
  apiLogSpend,
  apiLogWorkout,
  apiMovePipeline,
  apiPatchLearning,
  apiSaveWeeklyReview,
  apiSetSpendBudget,
  apiTouchNetwork,
  apiSaveNetwork,
  apiWeeklyReview,
  type GratitudeEntry,
  type LearningItem,
  type NetworkPerson,
  type NetworkStay,
  type NetworkToday,
  type PipelineItem,
  type SleepNight,
  type SpendLog,
  type WeeklyReview,
  type WeeklySnapshot,
  type WorkDraft,
  type WorkoutLog,
  type WorkoutPr,
} from './api'
import type { FeatureAuth } from './FeatureMiniApps'
import { useStableAuth } from './useStableAuth'
import {
  defaultWorkoutDay,
  movePrescription,
  readWorkoutDays,
  readWorkoutMoveCount,
  readWorkoutPlace,
  WORKOUT_DAY_LABELS_ALL,
  WORKOUT_DAY_LETTERS_ALL,
  workoutSession,
  writeWorkoutDays,
  writeWorkoutMoveCount,
  writeWorkoutPlace,
  setsRepsLabel,
  type WorkoutDay,
  type WorkoutMove,
  type WorkoutMoveCount,
  type WorkoutPlace,
} from './workoutProgram'
import { exerciseDemoUrl } from './exerciseDemos'
import { isPersonMeetSuggestion, isTravelOrStayTitle, stayWhereFrom, CADENCE_OPTIONS } from './peopleMeets'
import { pickLastNight } from './home'
import { PeopleGraph } from './PeopleGraph'
import { useRefreshOnFocus } from './useRefreshOnFocus'
import { SpendBar, SpendDonut, SpendSwatch } from './SpendCharts'
import { SPEND_SLOTS, SPEND_SLOT_LABELS } from './spendChart'

const useAuth = useStableAuth

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
  const [viewDay, setViewDay] = useState<WorkoutDay>(() => defaultWorkoutDay(readWorkoutDays()))
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
        if (Array.isArray(d.workoutDays) && d.workoutDays.length) {
          writeWorkoutDays(d.workoutDays as WorkoutDay[])
        }
      })
      .catch(() => setMsg('Could not load workouts.'))
  }, [a])
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
  const todayDay = new Date().getDay() as WorkoutDay
  const viewingToday = todayDay === viewDay
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
          {readWorkoutDays().map((day) => (
            <button
              key={day}
              className={`wk-day${viewDay === day ? ' is-on' : ''}${todayDay === day ? ' is-today' : ''}`}
              type="button"
              role="tab"
              aria-selected={viewDay === day}
              aria-label={WORKOUT_DAY_LABELS_ALL[day]}
              onClick={() => setViewDay(day)}
            >
              {WORKOUT_DAY_LETTERS_ALL[day]}
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
  { value: 'article', label: 'Article', defaultMin: 10 },
  { value: 'video', label: 'Video', defaultMin: 15 },
  { value: 'podcast', label: 'Podcast', defaultMin: 30 },
  { value: 'book', label: 'Book', defaultMin: 60 },
  { value: 'paper', label: 'Paper', defaultMin: 20 },
  { value: 'thread', label: 'Thread', defaultMin: 5 },
] as const

type SuggestedArticle = {
  title: string
  url: string
  kind: string
  minutes: number
  topic: string
  tags: string[]
  notes: string
}

const ESSAY_SUGGESTIONS: SuggestedArticle[] = [
  {
    title: 'How to Do Great Work',
    url: 'https://paulgraham.com/greatwork.html',
    kind: 'article',
    minutes: 18,
    topic: 'Startups & Strategy',
    tags: ['work', 'startup', 'founder', 'create', 'essay', 'paul graham', 'strategy', 'execution'],
    notes: 'The four steps: choose a field, learn enough to reach the frontier, notice anomalies, explore promising ones.',
  },
  {
    title: 'Patrick Collison: Fast Execution & Compounding',
    url: 'https://patrickcollison.com/fast',
    kind: 'article',
    minutes: 8,
    topic: 'Engineering & Systems',
    tags: ['speed', 'engineering', 'systems', 'stripe', 'fast', 'execution', 'build', 'compounding'],
    notes: 'Historical examples of how quickly world-changing projects were actually built.',
  },
  {
    title: 'The Bitter Lesson in AI Scaling',
    url: 'http://www.incompleteideas.net/IncIdeas/BitterLesson.html',
    kind: 'paper',
    minutes: 7,
    topic: 'AI & Machine Learning',
    tags: ['ai', 'llm', 'neural', 'model', 'scale', 'learning', 'gpt', 'deep learning', 'machine learning', 'openai'],
    notes: 'General methods that leverage computation are ultimately the most effective in AI by a large margin.',
  },
  {
    title: 'Do Things that Don\'t Scale',
    url: 'https://paulgraham.com/ds.html',
    kind: 'article',
    minutes: 10,
    topic: 'Startups & Growth',
    tags: ['startup', 'founder', 'growth', 'sales', 'users', 'product', 'customer', 'market', 'scale'],
    notes: 'Recruit users manually, delight them individually, and make founders do customer service early on.',
  },
  {
    title: 'Choose Boring Technology',
    url: 'https://mcfunley.com/choose-boring-technology',
    kind: 'article',
    minutes: 12,
    topic: 'Engineering & Architecture',
    tags: ['tech', 'engineering', 'code', 'stack', 'database', 'postgres', 'architecture', 'infra', 'software', 'dev'],
    notes: 'Spend your innovation tokens wisely on core problems, not on unproven infrastructure components.',
  },
  {
    title: 'Superhuman: Product-Market Fit Engine',
    url: 'https://review.firstround.com/how-superhuman-built-an-engine-for-product-market-fit/',
    kind: 'article',
    minutes: 15,
    topic: 'Product & Design',
    tags: ['product', 'design', 'pmf', 'saas', 'ux', 'user', 'superhuman', 'metrics', 'retention'],
    notes: 'A systematic methodology to quantify, segment, and iterate your way to strong PMF.',
  },
  {
    title: 'Deep Work & Attention Anchoring',
    url: 'https://calnewport.com/deep-work-rules-for-focused-success-in-a-distracted-world/',
    kind: 'article',
    minutes: 11,
    topic: 'Focus & Productivity',
    tags: ['focus', 'productivity', 'deep work', 'habits', 'routine', 'attention', 'time', 'distraction', 'calendar'],
    notes: 'Protecting uninterrupted 90-minute blocks of high-cognition creative flow.',
  },
  {
    title: 'You and Your Research (Richard Hamming)',
    url: 'https://www.cs.virginia.edu/~robins/YouAndYourResearch.html',
    kind: 'article',
    minutes: 20,
    topic: 'Thinking & Mastery',
    tags: ['research', 'thinking', 'philosophy', 'mastery', 'science', 'math', 'learning', 'knowledge', 'ideas'],
    notes: 'Why do so few scientists make significant contributions and so many are forgotten? A blueprint for important work.',
  },
]

function getDynamicSuggestions(userItems: LearningItem[]): Array<SuggestedArticle & { reason: string }> {
  const userText = userItems
    .map((i) => `${i.title} ${i.url || ''} ${i.notes || ''} ${i.kind}`)
    .join(' ')
    .toLowerCase()
  const savedUrls = new Set(userItems.map((i) => (i.url || '').toLowerCase()).filter(Boolean))
  const savedTitles = new Set(userItems.map((i) => i.title.toLowerCase().trim()))

  const candidates = ESSAY_SUGGESTIONS.filter(
    (s) => !savedUrls.has(s.url.toLowerCase()) && !savedTitles.has(s.title.toLowerCase())
  )

  if (candidates.length === 0) return []

  const scored = candidates.map((c) => {
    let score = 0
    let matchedTag = ''
    for (const tag of c.tags) {
      if (userText.includes(tag.toLowerCase())) {
        score += 1
        if (!matchedTag) matchedTag = tag
      }
    }
    const reason = matchedTag
      ? `Based on saved items in ${c.topic}`
      : `Suggested for you in ${c.topic}`
    return { ...c, score, reason }
  })

  scored.sort((a, b) => b.score - a.score)
  return scored.slice(0, 3)
}

function getDomain(rawUrl: string | null | undefined): string {
  if (!rawUrl) return ''
  try {
    const parsed = new URL(openHttp(rawUrl))
    return parsed.hostname.replace(/^www\./i, '')
  } catch {
    return ''
  }
}

function parseUrlInput(input: string) {
  const raw = input.trim()
  const urlMatch = raw.match(/https?:\/\/\S+/i)?.[0]?.replace(/[),.;]+$/, '')
  let kind = 'article'
  let min = 10

  if (urlMatch) {
    const l = urlMatch.toLowerCase()
    if (l.includes('youtube.com') || l.includes('youtu.be') || l.includes('vimeo.com')) {
      kind = 'video'
      min = 15
    } else if (l.includes('spotify.com') || l.includes('podcasts.apple.com') || l.includes('overcast.fm')) {
      kind = 'podcast'
      min = 30
    } else if (l.includes('arxiv.org') || l.endsWith('.pdf')) {
      kind = 'paper'
      min = 20
    } else if (l.includes('goodreads.com') || l.includes('amazon.com/dp')) {
      kind = 'book'
      min = 60
    } else if (l.includes('x.com') || l.includes('twitter.com') || l.includes('threads.net')) {
      kind = 'thread'
      min = 5
    }
  }

  const cleanTitle = raw.replace(/https?:\/\/\S+/gi, '').trim() || (urlMatch ? getDomain(urlMatch) : '') || 'Saved link'
  return { url: urlMatch, title: cleanTitle, kind, min }
}

export function LearningQueueApp({ auth }: { auth: FeatureAuth }) {
  const a = useAuth(auth)
  const [items, setItems] = useState<LearningItem[]>([])
  const [title, setTitle] = useState('')
  const [urlInput, setUrlInput] = useState('')
  const [kind, setKind] = useState<string>('article')
  const [minutes, setMinutes] = useState<number>(10)
  const [notes, setNotes] = useState('')
  const [tab, setTab] = useState<'queue' | 'done'>('queue')
  const [durFilter, setDurFilter] = useState<'all' | 'quick' | 'medium' | 'deep'>('all')
  const [editingNoteId, setEditingNoteId] = useState<string | null>(null)
  const [itemNoteDraft, setItemNoteDraft] = useState('')
  const [editItem, setEditItem] = useState<LearningItem | null>(null)
  const [showAdd, setShowAdd] = useState(false)
  const [showSuggestions, setShowSuggestions] = useState(true)
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState('')

  const load = useCallback(() => {
    apiListLearning(a)
      .then((d) => {
        setItems(d.items || [])
        setMsg('')
      })
      .catch((err) =>
        setMsg(err instanceof Error && err.message ? err.message : 'Could not load queue.'),
      )
  }, [a])
  useEffect(() => { load() }, [load])

  function onTitleChange(val: string) {
    setTitle(val)
    if (/https?:\/\/\S+/i.test(val)) {
      const p = parseUrlInput(val)
      if (p.url && !urlInput) {
        setUrlInput(p.url)
        setKind(p.kind)
        setMinutes(p.min)
      }
    }
  }

  async function add(e: FormEvent) {
    e.preventDefault()
    if (!title.trim() || busy) return
    setBusy(true)
    setMsg('')
    try {
      const p = parseUrlInput(title.trim())
      const finalUrl = urlInput.trim() || p.url || undefined
      const finalTitle = (p.url ? p.title : title.trim()) || 'Saved link'
      await apiAddLearning({
        ...a,
        title: finalTitle.slice(0, 240),
        url: finalUrl,
        kind,
        minutes: Number(minutes) || 10,
        notes: notes.trim() || undefined,
      })
      setTitle('')
      setUrlInput('')
      setNotes('')
      setMinutes(10)
      setShowAdd(false)
      load()
    } catch (err) {
      setMsg(err instanceof Error && err.message ? err.message : 'Could not add that.')
    } finally {
      setBusy(false)
    }
  }

  const suggested = useMemo(() => getDynamicSuggestions(items), [items])

  async function addSuggested(s: SuggestedArticle) {
    if (busy) return
    setBusy(true)
    setMsg('')
    try {
      await apiAddLearning({
        ...a,
        title: s.title,
        url: s.url,
        kind: s.kind,
        minutes: s.minutes,
        notes: s.notes,
      })
      load()
    } catch {
      setMsg('Could not add suggestion.')
    } finally {
      setBusy(false)
    }
  }

  async function toggleStatus(item: LearningItem) {
    if (busy) return
    setBusy(true)
    const nextStatus = item.status === 'done' ? 'queued' : 'done'
    try {
      await apiPatchLearning({ ...a, id: item.id, status: nextStatus })
      load()
    } catch {
      setMsg('Could not update.')
    } finally {
      setBusy(false)
    }
  }

  async function bumpTop(id: string) {
    if (busy) return
    setBusy(true)
    try {
      await apiPatchLearning({ ...a, id, bumpTop: true })
      load()
    } catch {
      setMsg('Could not reorder.')
    } finally {
      setBusy(false)
    }
  }

  async function saveNotes(id: string) {
    if (busy) return
    setBusy(true)
    try {
      await apiPatchLearning({ ...a, id, notes: itemNoteDraft })
      setEditingNoteId(null)
      load()
    } catch {
      setMsg('Could not save note.')
    } finally {
      setBusy(false)
    }
  }

  async function saveEdit(e: FormEvent) {
    e.preventDefault()
    if (!editItem || !editItem.title.trim() || busy) return
    setBusy(true)
    try {
      await apiPatchLearning({
        ...a,
        id: editItem.id,
        title: editItem.title.trim(),
        url: editItem.url?.trim() || null,
        kind: editItem.kind,
        minutes: Number(editItem.minutes) || 10,
        notes: editItem.notes?.trim() || null,
      })
      setEditItem(null)
      load()
    } catch {
      setMsg('Could not update.')
    } finally {
      setBusy(false)
    }
  }

  async function remove(id: string) {
    if (busy) return
    setBusy(true)
    try {
      await apiPatchLearning({ ...a, id, _delete: true })
      load()
    } catch {
      setMsg('Could not remove.')
    } finally {
      setBusy(false)
    }
  }

  const kindLabel = (k: string) => LEARN_KINDS.find((x) => x.value === k)?.label || k

  const queued = items.filter((i) => i.status !== 'done')
  const doneItems = items.filter((i) => i.status === 'done')
  const next = queued[0]
  const nextUrl = next?.url ? openHttp(next.url) : ''
  const nextDomain = next ? getDomain(next.url) : ''

  const currentList = tab === 'queue' ? queued : doneItems
  const filteredList = currentList.filter((i) => {
    if (durFilter === 'quick') return (i.minutes || 10) <= 10
    if (durFilter === 'medium') return (i.minutes || 10) > 10 && (i.minutes || 10) <= 30
    if (durFilter === 'deep') return (i.minutes || 10) > 30
    return true
  })

  return (
    <div className="ma">
      {/* Hero */}
      <div className="ma-hero">
        <span className="ma-hero-kicker">{next ? 'Next up' : 'Queue'}</span>
        <span className="ma-hero-num">{next ? next.title : 'All caught up'}</span>
        <span className="ma-hero-label">
          {next
            ? `${kindLabel(next.kind)} · ${next.minutes || 10}m${nextDomain ? ` · ${nextDomain}` : ''}${queued.length > 1 ? ` · ${queued.length - 1} more in queue` : ''}`
            : 'Save an article or link to queue it up.'}
        </span>
      </div>

      {next && (
        <div style={{ display: 'flex', gap: 8 }}>
          {nextUrl ? (
            <a className="ma-btn ma-btn--block" style={{ flex: 1 }} href={nextUrl} target="_blank" rel="noreferrer">
              Open next
            </a>
          ) : null}
          <button
            className={`ma-btn${nextUrl ? ' ma-btn--quiet' : ' ma-btn--block'}`}
            style={{ flex: nextUrl ? 'none' : 1 }}
            type="button"
            disabled={busy}
            onClick={() => void toggleStatus(next)}
          >
            Mark done
          </button>
        </div>
      )}

      {msg && (
        <p className="mini__hint">
          {msg}{' '}
          <button className="ma-btn ma-btn--quiet" type="button" onClick={load}>Retry</button>
        </p>
      )}

      {/* Tabs */}
      <div className="lq-tabs">
        <button
          className={`lq-tab${tab === 'queue' ? ' is-on' : ''}`}
          type="button"
          onClick={() => setTab('queue')}
        >
          Queue ({queued.length})
        </button>
        <button
          className={`lq-tab${tab === 'done' ? ' is-on' : ''}`}
          type="button"
          onClick={() => setTab('done')}
        >
          Done ({doneItems.length})
        </button>
      </div>

      {/* Duration filter chips */}
      {currentList.length > 2 && (
        <div className="lq-filters-row">
          {(
            [
              ['all', 'All'],
              ['quick', '≤ 10m'],
              ['medium', '15–30m'],
              ['deep', '30m+'],
            ] as const
          ).map(([val, label]) => (
            <button
              key={val}
              className={`lq-tag-btn${durFilter === val ? ' is-on' : ''}`}
              type="button"
              onClick={() => setDurFilter(val)}
            >
              {label}
            </button>
          ))}
        </div>
      )}

      {/* List */}
      {filteredList.length > 0 && (
        <ul className="ma-list">
          {filteredList.map((i) => {
            const domain = getDomain(i.url)
            const itemUrl = i.url ? openHttp(i.url) : ''
            const isDone = i.status === 'done'
            const isEditingNote = editingNoteId === i.id

            return (
              <li key={i.id} className={`ma-row${isDone ? ' ma-row--done' : ''}`}>
                <div className="ma-row-main">
                  <span className="ma-title">
                    {itemUrl ? (
                      <a className="ma-title-link" href={itemUrl} target="_blank" rel="noreferrer">
                        {i.title}
                      </a>
                    ) : (
                      i.title
                    )}
                  </span>
                  <span className="ma-sub">
                    {kindLabel(i.kind)} · {i.minutes || 10}m{domain ? ` · ${domain}` : ''}
                  </span>

                  {i.notes && !isEditingNote && (
                    <div className="lq-note-snippet">
                      {i.notes}
                    </div>
                  )}

                  {isEditingNote && (
                    <div className="lq-note-drawer">
                      <textarea
                        className="ma-area"
                        rows={2}
                        placeholder="Key takeaways..."
                        value={itemNoteDraft}
                        onChange={(e) => setItemNoteDraft(e.target.value)}
                      />
                      <div style={{ display: 'flex', gap: 6 }}>
                        <button className="ma-btn ma-btn--sm" type="button" onClick={() => void saveNotes(i.id)}>
                          Save
                        </button>
                        <button className="ma-btn ma-btn--quiet ma-btn--sm" type="button" onClick={() => setEditingNoteId(null)}>
                          Cancel
                        </button>
                      </div>
                    </div>
                  )}

                  <div className="lq-actions">
                    <button
                      className="lq-link-btn"
                      type="button"
                      onClick={() => void toggleStatus(i)}
                    >
                      {isDone ? 'Requeue' : 'Done'}
                    </button>
                    <button
                      className="lq-link-btn"
                      type="button"
                      onClick={() => {
                        if (editingNoteId === i.id) {
                          setEditingNoteId(null)
                        } else {
                          setEditingNoteId(i.id)
                          setItemNoteDraft(i.notes || '')
                        }
                      }}
                    >
                      {i.notes ? 'Edit note' : 'Add note'}
                    </button>
                    {!isDone && i.id !== next?.id && (
                      <button
                        className="lq-link-btn"
                        type="button"
                        onClick={() => void bumpTop(i.id)}
                      >
                        Top
                      </button>
                    )}
                    <button
                      className="lq-link-btn"
                      type="button"
                      onClick={() => setEditItem(i)}
                    >
                      Edit
                    </button>
                    <button
                      className="lq-link-btn lq-link-btn--del"
                      type="button"
                      onClick={() => void remove(i.id)}
                    >
                      Remove
                    </button>
                  </div>
                </div>
              </li>
            )
          })}
        </ul>
      )}

      {/* Edit Form */}
      {editItem && (
        <form className="ma-stack" onSubmit={saveEdit}>
          <span style={{ fontSize: 13, fontWeight: 700 }}>Edit Item</span>
          <input
            className="ma-input"
            value={editItem.title}
            onChange={(e) => setEditItem({ ...editItem, title: e.target.value })}
            placeholder="Title"
          />
          <input
            className="ma-input"
            value={editItem.url || ''}
            onChange={(e) => setEditItem({ ...editItem, url: e.target.value })}
            placeholder="URL"
          />
          <div style={{ display: 'flex', gap: 8 }}>
            <label className="ma-field" style={{ flex: 1 }}>
              <span>Kind</span>
              <select
                className="ma-input"
                value={editItem.kind}
                onChange={(e) => setEditItem({ ...editItem, kind: e.target.value })}
              >
                {LEARN_KINDS.map((k) => (
                  <option key={k.value} value={k.value}>{k.label}</option>
                ))}
              </select>
            </label>
            <label className="ma-field" style={{ flex: 1 }}>
              <span>Minutes</span>
              <input
                className="ma-input"
                type="number"
                min={1}
                max={360}
                value={editItem.minutes}
                onChange={(e) => setEditItem({ ...editItem, minutes: Number(e.target.value) || 10 })}
              />
            </label>
          </div>
          <textarea
            className="ma-area"
            rows={2}
            value={editItem.notes || ''}
            onChange={(e) => setEditItem({ ...editItem, notes: e.target.value })}
            placeholder="Notes"
          />
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="ma-btn" type="submit" disabled={busy || !editItem.title.trim()}>Save</button>
            <button className="ma-btn ma-btn--quiet" type="button" onClick={() => setEditItem(null)}>Cancel</button>
          </div>
        </form>
      )}

      {/* Add Button & Form */}
      {!showAdd && (
        <button
          className="ma-btn ma-btn--quiet ma-btn--block"
          type="button"
          onClick={() => setShowAdd(true)}
        >
          Add to queue
        </button>
      )}

      {showAdd && (
        <form className="ma-stack" onSubmit={add}>
          <input
            className="ma-input"
            value={title}
            onChange={(e) => onTitleChange(e.target.value)}
            placeholder="Title or URL"
            aria-label="Title or URL"
            autoFocus
          />
          <div style={{ display: 'flex', gap: 8 }}>
            <label className="ma-field" style={{ flex: 1 }}>
              <span>Kind</span>
              <select className="ma-input" value={kind} onChange={(e) => setKind(e.target.value)}>
                {LEARN_KINDS.map((k) => (
                  <option key={k.value} value={k.value}>{k.label}</option>
                ))}
              </select>
            </label>
            <label className="ma-field" style={{ flex: 1 }}>
              <span>Minutes</span>
              <input
                className="ma-input"
                type="number"
                min={1}
                max={360}
                value={minutes}
                onChange={(e) => setMinutes(Number(e.target.value) || 10)}
              />
            </label>
          </div>
          <textarea
            className="ma-area"
            rows={2}
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            placeholder="Notes (optional)"
            aria-label="Notes"
          />
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="ma-btn ma-btn--block" style={{ flex: 1 }} type="submit" disabled={busy || !title.trim()}>
              Save
            </button>
            <button className="ma-btn ma-btn--quiet" type="button" onClick={() => setShowAdd(false)}>
              Cancel
            </button>
          </div>
        </form>
      )}

      {/* Essays and articles suggested based on saved items */}
      {suggested.length > 0 && (
        <div className="lq-suggested">
          <div className="lq-suggested-header">
            <span>Essays and articles suggested</span>
            <button
              className="ma-btn ma-btn--quiet"
              style={{ fontSize: 11, padding: 0 }}
              type="button"
              onClick={() => setShowSuggestions(!showSuggestions)}
            >
              {showSuggestions ? 'Hide' : 'Show'}
            </button>
          </div>

          {showSuggestions && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {suggested.map((s) => (
                <div key={s.url} className="lq-suggested-item">
                  <div className="lq-suggested-main">
                    <a
                      className="lq-suggested-title"
                      href={s.url}
                      target="_blank"
                      rel="noreferrer"
                    >
                      {s.title}
                    </a>
                    <span className="lq-suggested-sub">
                      {s.kind} · {s.minutes}m · {getDomain(s.url)}
                    </span>
                    <span className="lq-suggested-reason">
                      {s.reason}
                    </span>
                  </div>
                  <button
                    className="ma-chip"
                    type="button"
                    disabled={busy}
                    onClick={() => void addSuggested(s)}
                  >
                    + Add
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
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
  }, [a])
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

  const suggestedFixes: string[] = []
  if (snap?.avgSleepHours && snap.avgSleepHours < 7) suggestedFixes.push('In bed before 11 on weeknights')
  if (snap?.habitChecks === 0) suggestedFixes.push('One habit every morning')
  if (snap?.followUpsDue && snap.followUpsDue > 0) suggestedFixes.push('Text one person I owe')
  if (snap?.meals !== undefined && snap.meals < 5) suggestedFixes.push('Log dinner 5 nights')
  if (!suggestedFixes.length) suggestedFixes.push('Protect the one thing that mattered most')

  const savedFocus = focusText.trim()

  function pickFix(fix: string) {
    setFocusText(fix)
  }

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
        <label className="ma-label">One fix next week
          <textarea className="ma-area" rows={2} value={focusText} onChange={(e) => setFocusText(e.target.value)} placeholder="One thing that actually matters." />
        </label>
        {!savedFocus && (
          <div className="ma-pills">
            {suggestedFixes.map((fix) => (
              <button key={fix} className="ma-chip" type="button" onClick={() => pickFix(fix)}>
                {fix}
              </button>
            ))}
          </div>
        )}
        <button className="ma-btn ma-btn--block" type="submit" disabled={busy || !weekStart || !focusText.trim()}>
          {savedFocus ? 'Save focus' : 'Lock it in'}
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

export { HomeApp } from './HomeApp'

/* ---------------------------- Networking CRM ---------------------------- */
function smsHref(name: string, phone?: string) {
  const body = encodeURIComponent(`Hey ${name.split(/\s+/)[0] || name}, checking in.`)
  const digits = (phone || '').replace(/[^\d+]/g, '')
  return digits ? `sms:${digits}?body=${body}` : `sms:?body=${body}`
}

function telHref(phone?: string) {
  const digits = (phone || '').replace(/[^\d+]/g, '')
  return digits ? `tel:${digits}` : ''
}

function personBits(p: { company?: string; phone?: string; contactEmail?: string; context?: string; whereMet?: string; lastTouch: string | null }) {
  return [p.company, p.phone, p.contactEmail, p.context || p.whereMet || 'No note yet', agoLabel(p.lastTouch)].filter(Boolean).join(' · ')
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
  const navigate = useNavigate()
  const [people, setPeople] = useState<NetworkPerson[]>([])
  const [today, setToday] = useState<NetworkToday[]>([])
  const [stay, setStay] = useState<NetworkStay | null>(null)
  const [calendarConnected, setCalendarConnected] = useState<boolean | null>(null)
  const [line, setLine] = useState('')
  const [phone, setPhone] = useState('')
  const [contactEmail, setContactEmail] = useState('')
  const [company, setCompany] = useState('')
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState('')
  const [showAdd, setShowAdd] = useState(false)
  const [addCadence, setAddCadence] = useState(14)
  const [openId, setOpenId] = useState<string | null>(null)
  const [confirmDel, setConfirmDel] = useState<string | null>(null)
  const [edit, setEdit] = useState({ name: '', phone: '', contactEmail: '', company: '', whereMet: '', context: '', cadenceDays: 14 })
  const [logNotes, setLogNotes] = useState<Record<string, string>>({})
  const [drafts, setDrafts] = useState<WorkDraft[]>([])
  const [nudge, setNudge] = useState<{ id: string; text: string } | null>(null)

  const load = useCallback(() => {
    apiListNetwork({ ...a, lazy: true })
      .then((d) => {
        setPeople(d.people)
        setToday(d.today || [])
        setStay(d.stay ?? null)
        setCalendarConnected(d.calendarConnected ?? null)
        // People paint the moment the query returns; the calendar half (a Google
        // hop, up to ~2.5s cold) fills in behind it so it never holds the roster.
        if (!d.today?.length) {
          apiListNetwork(a)
            .then((full) => {
              setToday(full.today || [])
              setStay(full.stay ?? null)
              setCalendarConnected(full.calendarConnected ?? null)
            })
            .catch(() => {})
        }
      })
      .catch(() => setMsg('Could not load people.'))
  }, [a])
  useEffect(() => { load() }, [load])

  /* Pending drafts back the nudge button: if Alpha already wrote an outreach
   * mail for this person, nudge opens that draft for review. Drafts are a
   * nice-to-have here, so a miss just means the copyable one-liner path. */
  const loadDrafts = useCallback(() => {
    apiListWorkDrafts({ email: a.email, token: a.token, persona: a.persona })
      .then((d) => setDrafts(d.drafts || []))
      .catch(() => setDrafts([]))
  }, [a])
  useEffect(() => { loadDrafts() }, [loadDrafts])

  function overdueBy(p: NetworkPerson) {
    if (!p.lastTouch) return null
    return Math.max(1, daysSince(p.lastTouch) - (p.cadenceDays || 14))
  }

  function overdueBadge(p: NetworkPerson) {
    const n = overdueBy(p)
    return n === null ? 'no touch yet' : n <= 1 ? 'overdue by 1 day' : `overdue by ${n} days`
  }

  function nudgePerson(p: NetworkPerson) {
    const email = (p.contactEmail || '').trim().toLowerCase()
    const draft = email
      ? drafts.find((d) => d.status !== 'sent' && (d.toAddr || '').trim().toLowerCase() === email)
      : undefined
    if (draft) {
      navigate(`/app/mini/${auth.persona}/approve_send?draft=${encodeURIComponent(draft.id)}`)
      return
    }
    const since = p.whereMet ? ` since ${p.whereMet}` : ''
    setNudge({ id: p.id, text: `Hey ${p.name}, it has been a while${since}. How are things on your end?` })
  }

  async function copyNudge() {
    if (!nudge) return
    try {
      await navigator.clipboard.writeText(nudge.text)
      setMsg('Nudge copied. Paste it wherever you two talk.')
    } catch {
      setMsg('Could not copy. Select the line by hand instead.')
    }
  }

  async function add(e: FormEvent) {
    e.preventDefault()
    if (!line.trim() || busy) return
    setBusy(true)
    try {
      const parsed = parseNetworkLine(line.trim())
      await apiAddNetwork({
        ...a,
        name: parsed.name,
        whereMet: parsed.whereMet,
        context: parsed.context,
        phone: phone.trim(),
        contactEmail: contactEmail.trim(),
        company: company.trim(),
        cadenceDays: addCadence,
      })
      setLine('')
      setPhone('')
      setContactEmail('')
      setCompany('')
      setShowAdd(false)
      load()
    } catch {
      setMsg('Could not add that.')
    } finally {
      setBusy(false)
    }
  }

  function openPerson(p: NetworkPerson) {
    setOpenId(p.id)
    setConfirmDel(null)
    setEdit({
      name: p.name,
      phone: p.phone || '',
      contactEmail: p.contactEmail || '',
      company: p.company || '',
      whereMet: p.whereMet || '',
      context: p.context || '',
      cadenceDays: p.cadenceDays || 14,
    })
  }

  async function savePerson(id: string) {
    if (!edit.name.trim() || busy) return
    setBusy(true)
    try {
      await apiSaveNetwork({
        ...a,
        id,
        name: edit.name.trim(),
        phone: edit.phone.trim(),
        contactEmail: edit.contactEmail.trim(),
        company: edit.company.trim(),
        whereMet: edit.whereMet.trim(),
        context: edit.context.trim(),
        cadenceDays: Math.max(3, Math.min(365, Math.round(edit.cadenceDays) || 14)),
      })
      setOpenId(null)
      load()
    } catch {
      setMsg('Could not save that.')
    } finally {
      setBusy(false)
    }
  }

  async function removePerson(p: NetworkPerson) {
    if (busy) return
    setBusy(true)
    try {
      await apiTouchNetwork({ ...a, id: p.id, _delete: true })
      setOpenId(null)
      setConfirmDel(null)
      setMsg(`Removed ${p.name}.`)
      load()
    } catch {
      setMsg('Could not delete that.')
    } finally {
      setBusy(false)
    }
  }

  async function talked(id: string, note?: string) {
    if (busy) return
    setBusy(true)
    setMsg('')
    const noteText = note?.trim()
    const name = people.find((p) => p.id === id)?.name || 'the person'
    try {
      await apiTouchNetwork({ ...a, id, context: noteText || undefined })
      /* Update the row before the reload lands, so the tap reads as working even
       * on a slow link — this was a silent no-op when the response took a beat. */
      setPeople((prev) =>
        prev.map((p) => (p.id === id ? { ...p, lastTouch: new Date().toISOString(), context: noteText || p.context } : p)),
      )
      setLogNotes((prev) => {
        const n = { ...prev }
        delete n[id]
        return n
      })
      setMsg(`Marked ${name} talked.`)
      load()
    } catch (err) {
      setMsg(err instanceof Error ? err.message : 'Could not mark that as talked.')
    } finally {
      setBusy(false)
    }
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

  const genericName = /^(meet|meeting|call|coffee|lunch|dinner|hang|stay)$/i
  const contacts = people.filter((p) => !genericName.test(p.name.trim()))
  const ranked = contacts.slice().sort((x, y) => {
    const xo = daysSince(x.lastTouch) - x.cadenceDays
    const yo = daysSince(y.lastTouch) - y.cadenceDays
    return yo - xo
  })
  const due = ranked.filter((p) => daysSince(p.lastTouch) >= p.cadenceDays)
  const hotel = today.find((e) => isTravelOrStayTitle(e.who || e.title, e.place))
  const where = stay || (hotel ? stayWhereFrom(hotel.title, hotel.place) : null)
  const peopleToday = today.filter(isPersonMeetSuggestion)
  const inPersonToday = peopleToday.filter((e) => e.kind === 'In person')
  const remoteToday = peopleToday.filter((e) => e.kind !== 'In person')

  return (
    <div className="ma">

      {/* Where you are chip */}
      {where && (
        <div className="ma-where-chip">
          <span className="ma-where-label">Where you are</span>
          <span className="ma-where-title">{where.title}</span>
          {where.place && where.place !== where.title && <span className="ma-where-sub">{where.place}</span>}
        </div>
      )}

      {/* Your network as a graph */}
      {contacts.length > 0 && (
        <section className="ma-section">
          <span className="ma-section-label">Your network</span>
          <PeopleGraph people={contacts} selectedId={openId} onSelect={(p) => (p ? openPerson(p) : setOpenId(null))} />
          <p className="ma-sub">Drag to spin, tap a node to focus. Closer to the core = fresher connection.</p>
        </section>
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
            <strong>
              {due[0]!.name}
              <span className="ma-badge">{overdueBadge(due[0]!)}</span>
            </strong>
            <span className="ma-sub">{personBits(due[0]!)}</span>
            <input
              className="ma-input"
              value={logNotes[due[0]!.id] || ''}
              onChange={(ev) => setLogNotes((prev) => ({ ...prev, [due[0]!.id]: ev.target.value }))}
              placeholder="What did you talk about?"
              aria-label="Note"
            />
            <div className="ma-callout-actions">
              <a className="ma-btn" href={smsHref(due[0]!.name, due[0]!.phone)}>Text</a>
              {telHref(due[0]!.phone) && (
                <a className="ma-chip" href={telHref(due[0]!.phone)}>Call</a>
              )}
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
        <p className="mini__empty">
          Text Alpha "met Priya at the Stripe dinner, hiring" and it lands here. Or type a name below and Alpha reminds you when to follow up.
        </p>
      )}

      {/* People roster */}
      {contacts.length > 0 && (
        <ul className="ma-list">
          {ranked.map((p) => {
            const late = daysSince(p.lastTouch) >= p.cadenceDays
            const open = openId === p.id
            return (
              <li key={p.id} className={`ma-row${late ? ' ma-row--warn' : ''}`}>
                <div className="ma-row-main">
                  <button
                    className="wk-name-btn"
                    type="button"
                    onClick={() => {
                      if (open) {
                        setOpenId(null)
                        setConfirmDel(null)
                      } else {
                        openPerson(p)
                      }
                    }}
                  >
                    <span className="ma-title">
                      {p.name}
                      {late && <span className="ma-badge">{overdueBadge(p)}</span>}
                    </span>
                  </button>
                  <span className="ma-sub">{personBits(p)}</span>
                  {nudge && nudge.id === p.id && (
                    <div className="ma-stack" style={{ marginTop: 8 }}>
                      <span className="ma-sub">{nudge.text}</span>
                      <div className="ma-callout-actions">
                        <button className="ma-chip" type="button" onClick={() => void copyNudge()}>Copy</button>
                        {p.contactEmail && (
                          <a
                            className="ma-chip"
                            href={`mailto:${p.contactEmail}?subject=${encodeURIComponent('Quick catch up')}&body=${encodeURIComponent(nudge.text)}`}
                          >
                            Email it
                          </a>
                        )}
                        {p.phone && <a className="ma-chip" href={smsHref(p.name, p.phone)}>Text it</a>}
                      </div>
                    </div>
                  )}
                  {open && (
                    <div className="ma-stack" style={{ marginTop: 8 }}>
                      <label className="ma-field">
                        <span>Name</span>
                        <input className="ma-input" value={edit.name} onChange={(e) => setEdit({ ...edit, name: e.target.value })} />
                      </label>
                      <div className="ma-form-split">
                        <label className="ma-field">
                          <span>Phone</span>
                          <input className="ma-input" value={edit.phone} onChange={(e) => setEdit({ ...edit, phone: e.target.value })} inputMode="tel" />
                        </label>
                        <label className="ma-field">
                          <span>Email</span>
                          <input className="ma-input" value={edit.contactEmail} onChange={(e) => setEdit({ ...edit, contactEmail: e.target.value })} inputMode="email" />
                        </label>
                      </div>
                      <label className="ma-field">
                        <span>Company</span>
                        <input className="ma-input" value={edit.company} onChange={(e) => setEdit({ ...edit, company: e.target.value })} />
                      </label>
                      <label className="ma-field">
                        <span>Where you met</span>
                        <input className="ma-input" value={edit.whereMet} onChange={(e) => setEdit({ ...edit, whereMet: e.target.value })} />
                      </label>
                      <label className="ma-field">
                        <span>Reach out every</span>
                        <select
                          className="ma-input"
                          value={edit.cadenceDays}
                          onChange={(e) => setEdit({ ...edit, cadenceDays: Number(e.target.value) })}
                        >
                          {CADENCE_OPTIONS.map((o) => (
                            <option key={o.days} value={o.days}>{o.label}</option>
                          ))}
                        </select>
                      </label>
                      <label className="ma-field">
                        <span>Note</span>
                        <input className="ma-input" value={edit.context} onChange={(e) => setEdit({ ...edit, context: e.target.value })} />
                      </label>
                      <div className="ma-callout-actions">
                        <button className="ma-btn" type="button" disabled={busy || !edit.name.trim()} onClick={() => void savePerson(p.id)}>
                          Save
                        </button>
                        {p.contactEmail && (
                          <a className="ma-chip" href={`mailto:${p.contactEmail}`}>Email</a>
                        )}
                        {(edit.phone || p.phone) && (
                          <a className="ma-chip" href={smsHref(p.name, edit.phone || p.phone)}>Text</a>
                        )}
                        <button
                          className={`ma-chip ma-chip--danger${confirmDel === p.id ? ' ma-chip--armed' : ''}`}
                          type="button"
                          disabled={busy}
                          onClick={() => (confirmDel === p.id ? void removePerson(p) : setConfirmDel(p.id))}
                        >
                          {confirmDel === p.id ? 'Confirm delete' : 'Delete'}
                        </button>
                      </div>
                    </div>
                  )}
                </div>
                <button className="ma-chip" type="button" onClick={() => void talked(p.id, logNotes[p.id])}>Talked</button>
                {late && (
                  <button className="ma-chip" type="button" onClick={() => nudgePerson(p)}>
                    Nudge
                  </button>
                )}
                {p.phone && <a className="ma-chip" href={smsHref(p.name, p.phone)}>Text</a>}
                {telHref(p.phone) && <a className="ma-chip" href={telHref(p.phone)}>Call</a>}
              </li>
            )
          })}
        </ul>
      )}

      {(showAdd || !contacts.length) ? (
        <form className="ma-stack" onSubmit={add}>
          <label className="ma-field">
            <span>Name</span>
            <input
              className="ma-input"
              value={line}
              onChange={(e) => setLine(e.target.value)}
              placeholder="Priya @ dinner: hiring at Stripe"
              aria-label="Person"
            />
          </label>
          <div className="ma-form-split">
            <label className="ma-field">
              <span>Phone</span>
              <input className="ma-input" value={phone} onChange={(e) => setPhone(e.target.value)} inputMode="tel" placeholder="4155550100" />
            </label>
            <label className="ma-field">
              <span>Email</span>
              <input className="ma-input" value={contactEmail} onChange={(e) => setContactEmail(e.target.value)} inputMode="email" placeholder="priya@stripe.com" />
            </label>
          </div>
          <label className="ma-field">
            <span>Company</span>
            <input className="ma-input" value={company} onChange={(e) => setCompany(e.target.value)} placeholder="Stripe" />
          </label>
          <label className="ma-field">
            <span>Reach out every</span>
            <select className="ma-input" value={addCadence} onChange={(e) => setAddCadence(Number(e.target.value))}>
              {CADENCE_OPTIONS.map((o) => (
                <option key={o.days} value={o.days}>{o.label}</option>
              ))}
            </select>
          </label>
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
  }, [a])
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

  function copyToken() {
    if (!a.token) return
    void navigator.clipboard.writeText(a.token).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    })
  }

  const lastNightKey = lastNightDateStr()
  const todayKey = localDateStr()
  const picked = pickLastNight(nights, todayKey)
  const lastNight = picked.logged
    ? nights.find((n) => {
        const d = n.sleepDate.match(/(\d{4}-\d{2}-\d{2})/)?.[1] || n.sleepDate.slice(0, 10)
        return d === lastNightKey || d === todayKey
      }) || nights.find((n) => n.bedtime === picked.bedtime && n.wake === picked.wake)
    : undefined
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
              ? `${previewHours}h  ${formatClock12(bedtime)} to ${formatClock12(wake)}. Change bed and wake if you need.`
              : 'Set bed and wake, or connect Apple Health.'}
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

      <button className="ma-btn ma-btn--block" type="button" disabled={busy} onClick={() => void save()}>
        {lastNight ? 'Update last night' : `Log ${previewHours}h last night`}
      </button>

      {lastNight && (
        <p className="ma-insight">
          {fromHealth ? `Pulled from ${fromHealth} automatically.` : 'Last night is in.'}{' '}
          Change bed and wake if it was off.
        </p>
      )}

      {!lastNight && (
        <>
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
  const [movedId, setMovedId] = useState<string | null>(null)

  const load = useCallback(() => {
    apiListPipeline(a).then((d) => setItems(d.items)).catch(() => setMsg('Could not load pipeline.'))
  }, [a])
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

  /* Tap to advance: the card moves before the round trip, and snaps back if
   * the server says no. */
  async function move(item: PipelineItem, stage: string) {
    if (movedId) return
    setMovedId(item.id)
    setMsg('')
    const prev = items
    setItems((cur) =>
      cur.map((i) => (i.id === item.id ? { ...i, stage, updatedAt: new Date().toISOString() } : i)),
    )
    try {
      await apiMovePipeline({ ...a, id: item.id, stage })
      load()
    } catch {
      setItems(prev)
      setMsg(`Could not move ${item.title}. Tap again to retry.`)
    } finally {
      setMovedId(null)
    }
  }

  function nextStage(stage: string) {
    const i = PIPE_STAGES.findIndex((s) => s.id === stage)
    return PIPE_STAGES[Math.min(PIPE_STAGES.length - 1, i + 1)]?.id || stage
  }

  const live = items.filter((i) => i.stage !== 'won' && i.stage !== 'lost')
  const staleCount = live.filter((i) => daysSince(i.updatedAt) > 10).length
  const hottest = live.slice().sort((x, y) => {
    const hx = (PIPE_HEAT[x.stage] || 0) + daysSince(x.updatedAt)
    const hy = (PIPE_HEAT[y.stage] || 0) + daysSince(y.updatedAt)
    return hy - hx
  })[0]
  const rest = items.filter((i) => i.id !== hottest?.id)
  const stagesWithCards = PIPE_STAGES.filter((s) => rest.some((i) => i.stage === s.id))

  /* Deals vs jobs live side by side on one board — the kind tab keeps the
   * sales pipeline from being the hiring pipeline. */
  const [kindTab, setKindTab] = useState<'all' | 'deal' | 'job'>('all')
  const kindFiltered = kindTab === 'all' ? items : items.filter((i) => (i.kind || 'deal') === kindTab)

  return (
    <div className="ma">
      <div className="ma-kind-tabs">
        {(['all', 'deal', 'job'] as const).map((k) => (
          <button
            key={k}
            type="button"
            className={`ma-kind-tab${kindTab === k ? ' ma-kind-tab--on' : ''}`}
            onClick={() => setKindTab(k)}
          >
            {k === 'all' ? 'All' : k === 'deal' ? 'Deals' : 'Jobs'}
          </button>
        ))}
      </div>
      {kindFiltered.length === 0 && (
        <p className="mini__empty">
          No {kindTab === 'all' ? 'items' : kindTab + 's'} here. Lead, active, interview, offer, then won.
          {staleCount > 0 ? ` ${staleCount} other ${staleCount === 1 ? 'deal has' : 'deals have'} gone quiet.` : ''}
        </p>
      )}
      {hottest && kindTab !== 'all' && (hottest.kind || 'deal') !== kindTab && null}
      {hottest && (kindTab === 'all' || (hottest.kind || 'deal') === kindTab) && (
        <div className="ma-callout ma-callout--hot">
          <span className="ma-callout-kicker">
            {PIPE_STAGES.find((s) => s.id === hottest.stage)?.label} · hottest
            {daysSince(hottest.updatedAt) > 10 ? ` · stale ${daysSince(hottest.updatedAt)} days` : ''}
          </span>
          <strong>{hottest.title}</strong>
          {hottest.company && <span className="ma-sub">{hottest.company}</span>}
          {hottest.value > 0 && <span className="ma-sub">${Math.round(hottest.value).toLocaleString()}</span>}
          {hottest.notes && <span className="ma-sub">{hottest.notes}</span>}
          <div className="ma-callout-actions">
            <button
              type="button"
              className="ma-btn"
              disabled={movedId === hottest.id}
              onClick={() => void move(hottest, nextStage(hottest.stage))}
            >
              {movedId === hottest.id ? 'Moving' : pipeAction(hottest.stage)}
            </button>
            <button
              type="button"
              className="ma-chip"
              disabled={movedId === hottest.id}
              onClick={() => void move(hottest, 'lost')}
            >
              Lost
            </button>
          </div>
        </div>
      )}
      {!items.length && (
        <p className="mini__empty">
          Lead, interview, offer, won. Add the first company above, or text Alpha "talking to Acme" and it lands here itself.
        </p>
      )}
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
          const col = kindFiltered.filter((i) => i.id !== hottest?.id && i.stage === s.id)
          return (
            <div key={s.id}>
              <div className="pipe-stage">{s.label} {col.length}</div>
              <ul className="ma-list">
                {col.map((i) => {
                  const stale = daysSince(i.updatedAt) > 10
                  const closing = s.id === 'won' || s.id === 'lost'
                  return (
                    <li key={i.id} className={`ma-row${closing ? ' ma-row--done' : stale ? ' ma-row--warn' : ''}`}>
                      <div className="ma-row-main">
                        <span className="ma-title">
                          {i.title}
                          {stale && <span className="ma-badge">stale · {daysSince(i.updatedAt)} days</span>}
                        </span>
                        <span className="ma-sub">
                          {[
                            i.company || s.label,
                            i.value > 0 ? `$${Math.round(i.value).toLocaleString()}` : '',
                          ].filter(Boolean).join(' · ')}
                        </span>
                      </div>
                      {!closing && (
                        <span className="pipe-actions">
                          <button
                            type="button"
                            className="ma-chip"
                            disabled={movedId === i.id}
                            onClick={() => void move(i, nextStage(i.stage))}
                          >
                            {movedId === i.id ? 'Moving' : pipeAction(i.stage)}
                          </button>
                          <button
                            type="button"
                            className="ma-chip"
                            disabled={movedId === i.id}
                            onClick={() => void move(i, 'lost')}
                          >
                            Lost
                          </button>
                        </span>
                      )}
                    </li>
                  )
                })}
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
  }, [a])
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
  }, [a])
  useEffect(() => { load() }, [load])
  useRefreshOnFocus(load)

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
  const remainDays = Math.max(1, daysLeftInWeek(weekStart) + 1)
  const perDay = !over ? Math.round(Math.max(0, left) / remainDays) : 0
  const last = logs[0]
  const topCat = [...byCategory].sort((a, b) => b.total - a.total)[0]
  // The charts read {category, amount}; the API returns {category, total}.
  const chartRows = byCategory.map((c) => ({ category: c.category, amount: c.total }))

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
      <SpendBar rows={chartRows} budget={budget} />
      <SpendDonut rows={chartRows} />
      <div className="ma-pills">
        {SPEND_SLOTS.map((c) => {
          const row = byCategory.find((x) => x.category === c)
          return (
            <button
              key={c}
              type="button"
              className={`ma-chip${category === c ? ' ma-chip--on' : ''}`}
              onClick={() => { setCategory(c); setShowLog(true) }}
            >
              <SpendSwatch category={c} />
              {SPEND_SLOT_LABELS[c]}{row ? ` $${Math.round(row.total)}` : ''}
            </button>
          )
        })}
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
