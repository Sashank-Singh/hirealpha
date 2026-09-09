import { useCallback, useEffect, useRef, useState, type CSSProperties, type FormEvent } from 'react'
import { Link } from 'react-router-dom'
import { rankPromise } from './promisesHint'
import { buildHabitHeatmap } from './habitHeatmap'
import { useStableAuth } from './useStableAuth'
import type { AgentId } from '../agents/types'
import {
  apiAddDecision,
  apiAddDrop,
  apiAddHabit,
  apiAddLearning,
  apiAddLoop,
  apiAddMeeting,
  apiAddNetwork,
  apiAddRelationship,
  apiAnalyzeNutrition,
  apiDayEvents,
  apiDeleteHabit,
  apiDeleteMeeting,
  apiDeleteNutritionLog,
  apiListArtifacts,
  apiListDecisions,
  apiListDrops,
  apiListHabits,
  apiListLoops,
  apiListMeetings,
  apiListMoods,
  apiListRelationships,
  apiLogMood,
  apiLogNutrition,
  apiLogNutritionPhoto,
  apiMeetingPrep,
  apiNutritionToday,
  apiPatchDrop,
  apiPatchLoop,
  apiPatchMeeting,
  apiReviewDecision,
  apiSaveWorkDraft,
  apiSetNutritionGoals,
  apiTouchRelationship,
  apiToggleHabit,
  apiTranscribeMeeting,
  type Decision,
  type Drop,
  type Habit,
  type Meeting,
  type MeetingPrep,
  type MoodEntry,
  type NutritionGoals,
  type NutritionLog,
  type OpenLoop,
  type Relationship,
  apiGetMiniPrefs,
  apiPutMiniPrefs,
} from './api'
import type { Artifact } from './api'

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

function todayStr() {
  const d = new Date()
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

function daysSince(iso: string | null | undefined) {
  if (!iso) return 999
  return Math.floor((Date.now() - new Date(iso).getTime()) / 86400000)
}

function agoLabel(iso: string | null | undefined) {
  const n = daysSince(iso)
  if (n >= 999) return 'never'
  if (n <= 0) return 'today'
  if (n === 1) return 'yesterday'
  return `${n}d ago`
}

function dueDay(iso: string | null | undefined) {
  return iso ? iso.slice(0, 10) : null
}

function loopRank(l: { dueAt?: string | null }, today: string) {
  return rankPromise(l, today)
}

function loopDueLabel(l: { dueAt?: string | null }, today: string) {
  const d = dueDay(l.dueAt)
  if (!d) return 'no date'
  if (d < today) {
    const n = Math.round((new Date(`${today}T00:00:00`).getTime() - new Date(`${d}T00:00:00`).getTime()) / 86400000)
    return n <= 1 ? 'overdue 1 day' : `overdue ${n} days`
  }
  if (d === today) return 'due today'
  const tomorrow = new Date(`${today}T00:00:00`)
  tomorrow.setDate(tomorrow.getDate() + 1)
  const ty = tomorrow.getFullYear()
  const tm = String(tomorrow.getMonth() + 1).padStart(2, '0')
  const td = String(tomorrow.getDate()).padStart(2, '0')
  if (d === `${ty}-${tm}-${td}`) return 'due tomorrow'
  return fmtWhen(l.dueAt)
}

function useAuthed(auth: FeatureAuth) {
  return useStableAuth(auth)
}

/* ------------------------------ Open Loops ------------------------------ */

const PROMISE_EXAMPLES = [
  'Send Amy the intro',
  'Reply to Luigi',
  'Book the table for Saturday',
]

export function OpenLoopsApp({ auth }: { auth: FeatureAuth }) {
  const a = useAuthed(auth)
  const [loops, setLoops] = useState<OpenLoop[]>([])
  const [title, setTitle] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const [showAdd, setShowAdd] = useState(false)
  const today = todayStr()

  const load = useCallback(() => {
    apiListLoops(a).then((d) => setLoops(d.loops)).catch(() => setErr('Could not load promises.'))
  }, [a])

  useEffect(() => {
    load()
  }, [load])

  async function add(e: FormEvent) {
    e.preventDefault()
    if (!title.trim() || busy) return
    setBusy(true)
    setErr('')
    try {
      await apiAddLoop({ ...a, persona: a.persona, title: title.trim(), dueAt: today })
      setTitle('')
      setShowAdd(false)
      load()
    } catch (error) {
      setErr(error instanceof Error ? error.message : 'Could not add that.')
    } finally {
      setBusy(false)
    }
  }

  async function setStatus(id: string, status: string) {
    const prev = loops
    /* Optimistic: done rows vanish before the round trip. */
    setLoops((cur) => cur.map((l) => (l.id === id ? { ...l, status } : l)))
    try {
      await apiPatchLoop({ ...a, id, status })
      load()
    } catch (err) {
      setLoops(prev)
      setErr(err instanceof Error ? err.message : 'Could not update that.')
    }
  }

  async function snooze(id: string) {
    const due = new Date()
    due.setDate(due.getDate() + 1)
    due.setHours(9, 0, 0, 0)
    const prev = loops
    setLoops((cur) => cur.map((l) => (l.id === id ? { ...l, status: 'snoozed' } : l)))
    try {
      await apiPatchLoop({ ...a, id, status: 'open', dueAt: due.toISOString() })
      load()
    } catch (err) {
      setLoops(prev)
      setErr(err instanceof Error ? err.message : 'Could not snooze that.')
    }
  }

  const open = loops
    .filter((l) => l.status === 'open')
    .slice()
    .sort((x, y) => loopRank(x, today) - loopRank(y, today))
  const snoozed = loops.filter((l) => l.status === 'snoozed')
  const dueNow = open.filter((l) => loopRank(l, today) <= 1)
  const next = dueNow[0] || open[0]
  const dueCount = dueNow.length

  return (
    <div className="ma">
      <div className="ma-hero">
        <span className="ma-hero-kicker">{open.length ? 'You owe' : 'Clear'}</span>
        <span className="ma-hero-num">
          {open.length ? `${open.length} open` : 'Nothing owed'}
        </span>
        <span className="ma-hero-label">
          {open.length
            ? dueCount
              ? `${dueCount === 1 ? 'One is' : `${dueCount} are`} due today. Done when you actually did it. Tomorrow parks it till morning.`
              : 'Nothing is due today. Done when you actually did it.'
            : 'This is not a todo list. It is what you told a person you would do. Text Alpha I promised to send Amy the intro, or type it below.'}
        </span>
      </div>

      {next && (
        <div className={`ma-callout${loopRank(next, today) <= 1 ? ' ma-callout--hot' : ''}`}>
          <span className="ma-callout-kicker">{loopDueLabel(next, today)}</span>
          <strong>{next.title}</strong>
          {next.context ? <span className="ma-sub">{next.context}</span> : null}
          <div className="ma-callout-actions">
            <button className="ma-btn" type="button" onClick={() => void setStatus(next.id, 'done')}>Done</button>
            <button className="ma-chip" type="button" onClick={() => void snooze(next.id)}>Tomorrow</button>
          </div>
        </div>
      )}

      {!open.length && (
        <div className="promise-examples">
          {PROMISE_EXAMPLES.map((ex) => (
            <button
              key={ex}
              className="ma-chip"
              type="button"
              onClick={() => {
                setTitle(ex)
                setShowAdd(true)
              }}
            >
              {ex}
            </button>
          ))}
        </div>
      )}

      {(showAdd || !open.length) ? (
        <form className="ma-form" onSubmit={add}>
          <input
            className="ma-input"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="I told Maya I would send the intro"
            aria-label="New promise"
          />
          <button className="ma-btn" type="submit" disabled={busy || !title.trim()}>Add</button>
        </form>
      ) : (
        <button className="ma-btn ma-btn--quiet" type="button" onClick={() => setShowAdd(true)}>Add another</button>
      )}
      {err && <p className="mini__hint">{err}</p>}
      {open.length > 1 && (
        <ul className="ma-list">
          {open.filter((l) => l.id !== next?.id).map((l) => {
            const hot = loopRank(l, today) <= 1
            return (
              <li key={l.id} className={`ma-row${hot ? ' ma-row--warn' : ''}`}>
                <div className="ma-row-main">
                  <span className="ma-title">
                    {l.title}
                    {hot && <span className="ma-badge">{loopDueLabel(l, today)}</span>}
                  </span>
                  {!hot && <span className="ma-sub">{loopDueLabel(l, today)}</span>}
                </div>
                <button className="ma-chip" type="button" onClick={() => void setStatus(l.id, 'done')}>Done</button>
              </li>
            )
          })}
        </ul>
      )}
      {snoozed.length > 0 && (
        <ul className="ma-list">
          {snoozed.slice(0, 6).map((l) => (
            <li key={l.id} className="ma-row ma-row--done">
              <div className="ma-row-main">
                <span className="ma-title">{l.title}</span>
                <span className="ma-sub">Tomorrow</span>
              </div>
              <button className="ma-chip" type="button" onClick={() => void setStatus(l.id, 'open')}>Bring back</button>
            </li>
          ))}
        </ul>
      )}
      <p className="mini__hint">Drop zone is a thought dump. This list is only what you owe a person.</p>
    </div>
  )
}

/* ---------------------------- Decision Ledger --------------------------- */

function decisionRank(d: Decision) {
  if (d.status === 'reviewed') return 3
  const day = dueDay(d.reviewAt)
  if (day && day <= todayStr()) return 0
  if (d.reviewAt) return 1
  return 2
}

export function DecisionLedgerApp({ auth }: { auth: FeatureAuth }) {
  const a = useAuthed(auth)
  const [decisions, setDecisions] = useState<Decision[]>([])
  const [line, setLine] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const [showAdd, setShowAdd] = useState(false)

  const load = useCallback(() => {
    apiListDecisions(a).then((d) => setDecisions(d.decisions)).catch(() => setErr('Could not load decisions.'))
  }, [a])

  useEffect(() => {
    load()
  }, [load])

  async function add(e: FormEvent) {
    e.preventDefault()
    if (!line.trim() || busy) return
    setBusy(true)
    setErr('')
    try {
      const raw = line.trim()
      const split = raw.match(/^(.+?)\s+because\s+(.+)$/i)
      const decision = split ? split[1].trim() : raw
      const reason = split ? split[2].trim() : ''
      const review = new Date()
      review.setDate(review.getDate() + 7)
      const y = review.getFullYear()
      const m = String(review.getMonth() + 1).padStart(2, '0')
      const day = String(review.getDate()).padStart(2, '0')
      await apiAddDecision({
        ...a,
        persona: a.persona,
        decision,
        reason,
        reviewAt: `${y}-${m}-${day}`,
      })
      setLine('')
      setShowAdd(false)
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
    const prev = decisions
    /* Optimistic: the row reads as closed the moment you tap, and snaps back
     * if the server refuses. */
    setDecisions((cur) =>
      cur.map((d) => (d.id === id ? { ...d, outcome, status: 'reviewed' } : d)),
    )
    try {
      await apiReviewDecision({ ...a, id, outcome })
      load()
    } catch (error) {
      setDecisions(prev)
      setErr(error instanceof Error ? error.message : 'Could not update that.')
    } finally {
      setBusy(false)
    }
  }

  const ranked = decisions.slice().sort((x, y) => decisionRank(x) - decisionRank(y))
  const next = ranked.find((d) => d.status !== 'reviewed')
  const rest = ranked.filter((d) => d.id !== next?.id)

  return (
    <div className="ma">
      {next && (
        <div className={`ma-callout${decisionRank(next) === 0 ? ' ma-callout--hot' : ''}`}>
          <span className="ma-callout-kicker">
            {decisionRank(next) === 0 ? 'Revisit today' : next.reviewAt ? `Revisit ${fmtWhen(next.reviewAt)}` : 'Still open'}
          </span>
          <strong>{next.decision}</strong>
          {next.reason && <span className="ma-sub">{next.reason}</span>}
          <span className="ma-sub">
            {next.reviewAt ? `Revisit date ${fmtWhen(next.reviewAt)}` : 'No revisit date. It sits here until you call it.'}
          </span>
          <div className="ma-callout-actions">
            <button type="button" className="ma-btn" disabled={busy} onClick={() => void markOutcome(next.id, 'held up')}>
              Held up
            </button>
            <button type="button" className="ma-chip" disabled={busy} onClick={() => void markOutcome(next.id, 'reversed')}>
              Reversed
            </button>
          </div>
        </div>
      )}
      {!decisions.length && (
        <p className="mini__empty">
          Text "we decided to pass on the VP" and it logs itself. Or write it below; the review sits on top in a week.
        </p>
      )}
      {(showAdd || !decisions.length) ? (
        <form className="ma-form" onSubmit={add}>
          <input
            className="ma-input"
            value={line}
            onChange={(e) => setLine(e.target.value)}
            placeholder="Ship v2 this month because speed beats polish"
            aria-label="Decision"
          />
          <button className="ma-btn" type="submit" disabled={busy || !line.trim()}>Log</button>
        </form>
      ) : (
        <button className="ma-btn ma-btn--quiet" type="button" onClick={() => setShowAdd(true)}>Log another</button>
      )}
      {err && <p className="mini__hint">{err}</p>}
      {rest.length > 0 && (
        <ul className="ma-list">
          {rest.slice(0, 10).map((d) => (
            <li key={d.id} className={`ma-row${d.status === 'reviewed' ? ' ma-row--done' : decisionRank(d) === 0 ? ' ma-row--warn' : ''}`}>
              <div className="ma-row-main">
                <span className="ma-title">{d.decision}</span>
                <span className="ma-sub">
                  {d.status === 'reviewed'
                    ? `Called · ${d.outcome || 'done'}`
                    : [
                      d.reason,
                      d.reviewAt ? `Revisit ${fmtWhen(d.reviewAt)}` : `Logged ${fmtWhen(d.createdAt)}`,
                    ].filter(Boolean).join(' · ')}
                </span>
              </div>
              {d.status !== 'reviewed' && (
                <span className="ma-callout-actions">
                  <button type="button" className="ma-chip" disabled={busy} onClick={() => void markOutcome(d.id, 'held up')}>
                    Held up
                  </button>
                  <button type="button" className="ma-chip" disabled={busy} onClick={() => void markOutcome(d.id, 'reversed')}>
                    Reversed
                  </button>
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

/* --------------------------- Relationship Radar ------------------------- */

export function RelationshipRadarApp({ auth }: { auth: FeatureAuth }) {
  const a = useAuthed(auth)
  const [people, setPeople] = useState<Relationship[]>([])
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const [justTouched, setJustTouched] = useState<string | null>(null)
  const [showAdd, setShowAdd] = useState(false)

  const load = useCallback(() => {
    apiListRelationships(a).then((d) => setPeople(d.relationships)).catch(() => setErr('Could not load people.'))
  }, [a])

  useEffect(() => {
    load()
  }, [load])

  async function add(e: FormEvent) {
    e.preventDefault()
    if (!name.trim() || busy) return
    setBusy(true)
    setErr('')
    try {
      const raw = name.trim()
      const split = raw.match(/^(.+?)\s+\((personal|work|investor|candidate|partner)\)$/i)
      await apiAddRelationship({
        ...a,
        name: split ? split[1].trim() : raw,
        kind: split ? split[2].toLowerCase() : 'personal',
      })
      setName('')
      setShowAdd(false)
      load()
    } catch (error) {
      setErr(error instanceof Error ? error.message : 'Could not add that.')
    } finally {
      setBusy(false)
    }
  }

  async function touch(id: string) {
    setJustTouched(id)
    try {
      await apiTouchRelationship({ ...a, id })
      load()
    } catch (err) {
      setErr(err instanceof Error ? err.message : 'Could not mark that touched.')
    }
    window.setTimeout(() => setJustTouched((cur) => (cur === id ? null : cur)), 800)
  }

  const ranked = people.slice().sort((x, y) => {
    const xo = daysSince(x.lastTouchAt) - x.cadenceDays
    const yo = daysSince(y.lastTouchAt) - y.cadenceDays
    return yo - xo
  })
  const overdue = ranked.filter((p) => daysSince(p.lastTouchAt) >= p.cadenceDays)
  const next = overdue[0]
  const rest = ranked.filter((p) => p.id !== next?.id)

  return (
    <div className="ma">
      {next && (
        <button type="button" className="ma-callout ma-callout--hot" onClick={() => void touch(next.id)}>
          <span className="ma-callout-kicker">{justTouched === next.id ? 'Logged' : 'Overdue'}</span>
          <strong>{next.name}</strong>
          <span className="ma-sub">{next.kind} · {agoLabel(next.lastTouchAt)} · tap when you reach out</span>
        </button>
      )}
      {!people.length && <p className="mini__empty">Add someone who matters. Tap them when you reach out.</p>}
      {people.length > 0 && overdue.length === 0 && (
        <div className="ma-callout">
          <span className="ma-callout-kicker">All clear</span>
          <strong>Nobody is overdue</strong>
          <span className="ma-sub">Next ping is whenever cadence comes due.</span>
        </div>
      )}
      {(showAdd || !people.length) ? (
        <form className="ma-form" onSubmit={add}>
          <input
            className="ma-input"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Maya (investor)"
            aria-label="Person name"
          />
          <button className="ma-btn" type="submit" disabled={busy || !name.trim()}>Add</button>
        </form>
      ) : (
        <button className="ma-btn ma-btn--quiet" type="button" onClick={() => setShowAdd(true)}>Add someone</button>
      )}
      {err && <p className="mini__hint">{err}</p>}
      {rest.length > 0 && (
        <ul className="ma-list">
          {rest.map((p) => {
            const late = daysSince(p.lastTouchAt) >= p.cadenceDays
            return (
              <li key={p.id}>
                <button
                  type="button"
                  className={`ma-row ma-row--tap${late ? ' ma-row--warn' : ''}`}
                  onClick={() => void touch(p.id)}
                >
                  <div className="ma-row-main">
                    <span className="ma-title">
                      {p.name}
                      {late && <span className="ma-badge">overdue</span>}
                      {justTouched === p.id && <span className="ma-badge ma-badge--ok">logged</span>}
                    </span>
                    <span className="ma-sub">{p.kind} · {agoLabel(p.lastTouchAt)}</span>
                  </div>
                  <span className="ma-chip">{justTouched === p.id ? 'Logged' : 'Talked'}</span>
                </button>
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}

/* ------------------------------ Alpha Drop Zone ------------------------- */

type DropBucket = 'learning' | 'loop' | 'network'

function guessDropBucket(text: string): DropBucket {
  const t = text.toLowerCase()
  if (/https?:\/\//i.test(text) || /\b(article|podcast|video|youtube|read|watch)\b/.test(t)) return 'learning'
  if (/\b(met|coffee|intro|catch up|ping|from the)\b/.test(t)) return 'network'
  return 'loop'
}

function nameFromDrop(text: string) {
  const m = text.trim().match(/^([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)/)
  return m?.[1] || text.trim().slice(0, 40)
}

const DROP_BUCKETS: Array<{ id: DropBucket; label: string }> = [
  { id: 'loop', label: 'Loop' },
  { id: 'learning', label: 'Learning' },
  { id: 'network', label: 'Network' },
]

/** Every workshop build, newest first. Tapping opens the build in the
 * artifact screen where keep and toss live. */
export function BuildsApp({ auth, persona }: { auth: FeatureAuth; persona: AgentId }) {
  const [builds, setBuilds] = useState<Artifact[] | null>(null)
  const [error, setError] = useState('')

  useEffect(() => {
    let live = true
    apiListArtifacts({ email: auth.email, token: auth.token })
      .then((res) => {
        if (live) setBuilds(res.artifacts || [])
      })
      .catch(() => {
        if (live) setError('Could not load your builds. Try again in a bit.')
      })
    return () => {
      live = false
    }
  }, [auth.email, auth.token])

  const fmtDay = (iso: string) => {
    const d = new Date(iso)
    return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
  }

  return (
    <div className="ma">
      <div className="ma-hero">
        <span className="ma-hero-kicker">Workshop</span>
        <span className="ma-hero-num">Your builds</span>
        <span className="ma-hero-label">Every app Alpha built for you</span>
      </div>

      {error && <p className="mini__hint">{error}</p>}
      {!error && builds === null && <p className="mini__empty">Loading your builds…</p>}
      {!error && builds !== null && builds.length === 0 && (
        <div className="ma-callout">
          <span className="ma-callout-kicker">Build on demand</span>
          <strong>Nothing built yet</strong>
          <span className="ma-sub">
            Ask Alpha: <em>&ldquo;build a flappy bird game&rdquo;</em> or <em>&ldquo;make a habit tracker&rdquo;</em>. Alpha writes the code, tests it in the sandbox, delivers a live link in chat, and saves it right here.
          </span>
          <div className="ma-callout-actions">
            <a className="ma-btn" href="sms:+14155951440&body=Build%20a%20game">Text Alpha to build</a>
          </div>
        </div>
      )}
      {!error && builds !== null && builds.length > 0 && (
        <ul className="ma-list">
          {builds.map((b) => (
            <li key={b.id}>
              <Link
                className="ma-row"
                to={`/app/mini/${persona}/artifact?id=${b.id}${auth.token ? `&t=${auth.token}` : auth.email ? `&email=${encodeURIComponent(auth.email)}` : ''}`}
              >
                <div className="ma-row-main">
                  <span className="ma-title">{b.title}</span>
                  <span className="ma-sub">
                    {fmtDay(b.createdAt)}
                    {b.state === 'kept' ? ' · saved permanently' : ' · auto-expires in 7 days unless kept'}
                  </span>
                </div>
                <span aria-hidden="true">›</span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

export function DropZoneApp({ auth }: { auth: FeatureAuth }) {
  const a = useAuthed(auth)
  const [drops, setDrops] = useState<Drop[]>([])
  const [content, setContent] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const [filing, setFiling] = useState<string | null>(null)
  const [lastRouted, setLastRouted] = useState<{ id: string; bucket: DropBucket; label: string } | null>(null)

  const load = useCallback(() => {
    apiListDrops(a).then((d) => setDrops(d.drops)).catch(() => setErr('Could not load drops.'))
  }, [a])

  useEffect(() => {
    load()
  }, [load])

  async function fileDrop(drop: Drop, bucket: DropBucket, auto = false) {
    if (filing) return
    setFiling(drop.id)
    setErr('')
    try {
      if (bucket === 'learning') {
        await apiAddLearning({ ...a, title: drop.content.slice(0, 120) })
      } else if (bucket === 'loop') {
        await apiAddLoop({ ...a, persona: a.persona, title: drop.content.slice(0, 200), dueAt: todayStr() })
      } else {
        await apiAddNetwork({ ...a, name: nameFromDrop(drop.content), context: drop.content.slice(0, 400) })
      }
      await apiPatchDrop({ ...a, id: drop.id, status: 'routed', summary: bucket })
      const label = DROP_BUCKETS.find((b) => b.id === bucket)?.label || bucket
      if (auto) setLastRouted({ id: drop.id, bucket, label })
      load()
    } catch (error) {
      setErr(error instanceof Error ? error.message : 'Could not file that.')
    } finally {
      setFiling(null)
    }
  }

  async function undoRoute() {
    if (!lastRouted || filing) return
    setFiling(lastRouted.id)
    try {
      await apiPatchDrop({ ...a, id: lastRouted.id, status: 'new', summary: '' })
      setLastRouted(null)
      load()
    } catch {
      setErr('Could not undo.')
    } finally {
      setFiling(null)
    }
  }

  async function add(e: FormEvent) {
    e.preventDefault()
    if (!content.trim() || busy) return
    setBusy(true)
    setErr('')
    setLastRouted(null)
    const text = content.trim()
    try {
      const created = await apiAddDrop({ ...a, content: text })
      setContent('')
      const bucket = guessDropBucket(text)
      if (created.id) {
        await fileDrop(
          {
            id: created.id,
            persona: a.persona,
            content: text,
            status: 'new',
            mediaKind: null,
            summary: null,
            createdAt: '',
          },
          bucket,
          true,
        )
      } else {
        load()
      }
    } catch (error) {
      setErr(error instanceof Error ? error.message : 'Could not drop that.')
    } finally {
      setBusy(false)
    }
  }

  const unsorted = drops.filter((d) => d.status === 'new')
  const routed = drops.filter((d) => d.status !== 'new')
  const next = unsorted[0]

  return (
    <div className="ma">
      {!drops.length && !lastRouted && (
        <p className="mini__empty">
          Dump anything and Alpha files it. Or text Alpha "save this: the Stripe deck" and it lands here on its own.
        </p>
      )}
      {lastRouted && (
        <div className="ma-callout">
          <span className="ma-callout-kicker">Filed</span>
          <strong>Sent to {lastRouted.label}</strong>
          <div className="ma-callout-actions">
            <button className="ma-chip" type="button" disabled={!!filing} onClick={() => void undoRoute()}>
              Undo
            </button>
          </div>
        </div>
      )}
      {next && !lastRouted && (
        <div className="ma-callout">
          <span className="ma-callout-kicker">Needs you</span>
          <strong>{next.content}</strong>
          {next.hint && <span className="ma-sub">Alpha would file this under {next.hint}</span>}
          <div className="ma-callout-actions">
            {DROP_BUCKETS.map((b) => {
              const suggested = guessDropBucket(next.content) === b.id
              return (
                <button
                  key={b.id}
                  type="button"
                  className={suggested ? 'ma-btn' : 'ma-chip'}
                  disabled={filing === next.id}
                  onClick={() => void fileDrop(next, b.id)}
                >
                  {suggested ? `File as ${b.label}` : b.label}
                </button>
              )
            })}
          </div>
        </div>
      )}
      <form className="ma-form" onSubmit={add}>
        <input
          className="ma-input"
          value={content}
          onChange={(e) => setContent(e.target.value)}
          placeholder="Dump a thought, link, or name"
          aria-label="Drop content"
        />
        <button className="ma-btn" type="submit" disabled={busy || !content.trim()}>Drop</button>
      </form>
      {err && <p className="mini__hint">{err}</p>}
      {unsorted.length > 1 && (
        <ul className="ma-list">
          {unsorted.filter((d) => d.id !== next?.id).map((d) => {
            const guess = guessDropBucket(d.content)
            return (
              <li key={d.id} className="ma-row">
                <div className="ma-row-main">
                  <span className="ma-title">{d.content}</span>
                  <span className="ma-sub">Suggested {d.hint || guess}</span>
                </div>
                <button className="ma-chip ma-chip--on" type="button" disabled={filing === d.id} onClick={() => void fileDrop(d, guess)}>
                  File
                </button>
              </li>
            )
          })}
        </ul>
      )}
      {routed.length > 0 && (
        <ul className="ma-list">
          {routed.slice(0, 6).map((d) => (
            <li key={d.id} className="ma-row ma-row--done">
              <div className="ma-row-main">
                <span className="ma-title">{d.content}</span>
                <span className="ma-sub">{d.summary || d.status} · {fmtWhen(d.createdAt)}</span>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

/* ------------------------------ Meeting Mode ---------------------------- */

export function MeetingModeApp({ auth }: { auth: FeatureAuth }) {
  const a = useAuthed(auth)
  const [meetings, setMeetings] = useState<Meeting[]>([])
  const [prep, setPrep] = useState<MeetingPrep | null>(null)
  const [title, setTitle] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const [recording, setRecording] = useState(false)
  const [recFor, setRecFor] = useState<string | null>(null)
  const [transcribing, setTranscribing] = useState<string | null>(null)
  const [promiseDraft, setPromiseDraft] = useState('')
  const [styleErr, setStyleErr] = useState('')
  const [showAdd, setShowAdd] = useState(false)
  const [recapHref, setRecapHref] = useState('')
  const [confirmDel, setConfirmDel] = useState<string | null>(null)
  const recRef = useRef<{ media: MediaRecorder | null; chunks: Blob[]; start: number }>({
    media: null,
    chunks: [],
    start: 0,
  })

  const load = useCallback(() => {
    Promise.all([
      apiListMeetings(a),
      apiDayEvents({ ...a, persona: a.persona }).catch(() => ({ events: [] as Array<{ id: string; title: string; start: string; label: string }> })),
    ])
      .then(async ([d, day]) => {
        let rows = d.meetings
        if (!rows.length && day.events?.length) {
          for (const e of day.events.slice(0, 6)) {
            await apiAddMeeting({ ...a, title: e.title, startsAt: e.start }).catch(() => undefined)
          }
          const again = await apiListMeetings(a).catch(() => ({ meetings: rows }))
          rows = again.meetings
        }
        setMeetings(rows)
      })
      .catch(() => setErr('Could not load meetings.'))
  }, [a])

  useEffect(() => {
    load()
  }, [load])

  /* Auto-prep: Alpha assembles the brief for the next meeting on the calendar.
   * The route is new, so a miss before it ships just leaves the manual memo and
   * wrap flow below as the whole screen. */
  useEffect(() => {
    let on = true
    apiMeetingPrep({ ...a, persona: a.persona })
      .then((d) => {
        if (on) setPrep(d)
      })
      .catch(() => { })
    return () => {
      on = false
    }
  }, [a])

  async function add(e: FormEvent) {
    e.preventDefault()
    if (!title.trim() || busy) return
    setBusy(true)
    setErr('')
    try {
      await apiAddMeeting({ ...a, title: title.trim() })
      setTitle('')
      setShowAdd(false)
      load()
    } catch (error) {
      setErr(error instanceof Error ? error.message : 'Could not add that.')
    } finally {
      setBusy(false)
    }
  }

  async function startRec(meetingId: string, ev: { stopPropagation: () => void }) {
    ev.stopPropagation()
    setStyleErr('')
    if (typeof window === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
      setStyleErr('Recording needs a supported browser (Safari/Chrome).')
      return
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true },
      })
      const mimeType = MediaRecorder.isTypeSupported('audio/mp4') ? 'audio/mp4' : 'audio/webm'
      const media = new MediaRecorder(stream, mimeType ? { mimeType } : undefined)
      const chunks: Blob[] = []
      media.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data) }
      media.onstop = () => {
        stream.getTracks().forEach((t) => t.stop())
      }
      media.start(1000)
      recRef.current = { media, chunks, start: Date.now() }
      setRecFor(meetingId)
      setRecording(true)
    } catch {
      setStyleErr('Microphone unavailable.')
    }
  }

  async function stopRec(meetingId: string) {
    const rec = recRef.current
    const cb = async () => {
      if (!rec.media) return
      return new Promise<Blob>((resolve) => {
        rec.media!.onstop = () => {
          rec.media = null
          const blob = new Blob(rec.chunks, { type: rec.chunks[0]?.type || 'audio/mp4' })
          rec.chunks = []
          resolve(blob)
        }
        rec.media!.stop()
      })
    }
    const blob = await cb()
    if (!blob || blob.size < 512) {
      setRecording(false)
      setRecFor(null)
      setStyleErr('Memo too short to transcribe.')
      return
    }
    setRecording(false)
    setRecFor(null)
    setTranscribing(meetingId)
    setErr('')
    try {
      const reader = new FileReader()
      await new Promise<void>((resolve, reject) => {
        reader.onload = () => resolve()
        reader.onerror = () => reject(new Error('read failed'))
        reader.readAsDataURL(blob)
      })
      const base64 = String(reader.result || '').split(',')[1] || ''
      const res = await apiTranscribeMeeting({ ...a, id: meetingId, audioBase64: base64, mimeType: blob.type })
      if (res.ok && res.transcript) {
        load()
      } else {
        setErr(res.error || 'Transcription failed.')
      }
    } catch {
      setErr('Could not read the memo.')
    } finally {
      setTranscribing(null)
    }
  }

  function abortRec() {
    const rec = recRef.current
    if (rec.media) {
      rec.media.onstop = null
      rec.media.stop()
      rec.media = null
    }
    rec.chunks = []
    recRef.current = { media: null, chunks: [], start: 0 }
    setRecording(false)
    setRecFor(null)
  }

  const recordingElapsed = (start: number, now: number) => {
    const s = Math.max(0, Math.round((now - start) / 1000))
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
  }

  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!recording) return
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [recording])

  async function wrap(id: string) {
    const m = meetings.find((row) => row.id === id)
    try {
      await apiPatchMeeting({ ...a, id, phase: 'done' })
    } catch (err) {
      setErr(err instanceof Error ? err.message : 'Could not wrap that meeting.')
    }
    const recap = [m?.briefing, m?.notes].filter(Boolean).join('\n\n') || `Wrapped ${m?.title || 'the meeting'}.`
    await apiSaveWorkDraft({
      ...a,
      persona: a.persona,
      kind: 'email',
      toAddr: '',
      subject: `Recap: ${m?.title || 'meeting'}`,
      body: recap,
    }).catch(() => undefined)
    setRecapHref(`/app/mini/${auth.persona}/approve_send`)
    load()
  }

  async function addPromise(id: string) {
    const m = meetings.find((row) => row.id === id)
    if (!m || !promiseDraft.trim()) return
    const nextFollowups = [...(m.followups || []), { decision: promiseDraft.trim().slice(0, 200) }]
    setPromiseDraft('')
    try {
      await apiPatchMeeting({ ...a, id, followups: nextFollowups })
      load()
    } catch (err) {
      setErr(err instanceof Error ? err.message : 'Could not save that promise.')
    }
  }

  async function remove(id: string) {
    setErr('')
    try {
      await apiDeleteMeeting({ ...a, id })
      setConfirmDel(null)
      load()
    } catch (err) {
      setErr(err instanceof Error ? err.message : 'Could not delete that meeting.')
      setConfirmDel(null)
    }
  }

  function whenLabel(iso: string | null) {
    if (!iso) return 'No time set'
    const d = new Date(iso)
    if (Number.isNaN(d.getTime())) return ''
    return d.toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
  }

  const ranked = meetings.slice().sort((x, y) => {
    const xd = x.phase === 'done' ? 1 : 0
    const yd = y.phase === 'done' ? 1 : 0
    if (xd !== yd) return xd - yd
    const xt = x.startsAt ? new Date(x.startsAt).getTime() : Number.POSITIVE_INFINITY
    const yt = y.startsAt ? new Date(y.startsAt).getTime() : Number.POSITIVE_INFINITY
    return xt - yt
  })
  const next = ranked.find((m) => m.phase !== 'done') || ranked[0]
  const rest = ranked.filter((m) => m.id !== next?.id)
  /* The same recurring meeting's old followups — "last time you promised X" —
   * so a standing weekly doesn't restart from zero. */
  const titleKey = (t: string) => (t || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
  const priorFollowups = next
    ? meetings
      .filter((m) => m.id !== next.id && m.phase === 'done' && titleKey(m.title) === titleKey(next.title))
      .flatMap((m) => m.followups || [])
    : []
  const hasPromises = next?.followups?.length
  const promisePool = hasPromises ? next.followups! : priorFollowups

  function memoLabel(m: Meeting) {
    if (recording && recFor === m.id) return `Stop ${recordingElapsed(recRef.current.start, now)}`
    if (transcribing === m.id) return 'Transcribing'
    return 'Memo'
  }

  return (
    <div className="ma">
      {prep?.event && (
        <div className="ma-callout ma-callout--hot">
          <span className="ma-callout-kicker">Prepped</span>
          <strong>{prep.event.title} in {prep.event.startsInMin}</strong>
          {prep.event.attendees && prep.event.attendees.length > 0 && (
            <span className="ma-sub">With {prep.event.attendees.join(', ')}</span>
          )}
          {prep.prep.agenda.length > 0 && (
            <span className="ma-sub">Agenda: {prep.prep.agenda.join(' · ')}</span>
          )}
          {prep.prep.notes.map((n, i) => (
            <span key={i} className="ma-sub">{n}</span>
          ))}
          {prep.prep.lastThread && (
            <span className="ma-sub">
              Last thread: {prep.prep.lastThread.subject} · {prep.prep.lastThread.snippet}
            </span>
          )}
        </div>
      )}
      {next && (
        <div className={`ma-callout${next.phase !== 'done' ? ' ma-callout--hot' : ''}`}>
          <span className="ma-callout-kicker">{next.phase === 'done' ? 'Wrapped' : 'Up next'}</span>
          <strong>{next.title}</strong>
          <span className="ma-sub">{whenLabel(next.startsAt)}</span>
          {next.briefing && <span className="ma-sub">{next.briefing}</span>}
          {next.notes && <span className="ma-sub">{next.notes}</span>}
          {promisePool.length > 0 && (
            <span className="ma-sub">
              {hasPromises ? 'Promised:' : 'Last time you promised:'}
              {' '}{promisePool.map((f) => f.decision || f.action || f.owner).filter(Boolean).join(' · ')}
            </span>
          )}
          <div className="ma-callout-actions">
            <input
              className="ma-input"
              style={{ flex: 1, minWidth: 120 }}
              value={promiseDraft}
              onChange={(e) => setPromiseDraft(e.target.value)}
              placeholder={next.phase === 'done' ? 'Add a promise for next time' : 'Promised to…'}
              aria-label="Promise"
            />
            <button type="button" className="ma-chip" onClick={() => void addPromise(next.id)}>Add</button>
          </div>
          <div className="ma-callout-actions">
            <button
              type="button"
              className="ma-btn"
              disabled={transcribing === next.id || (recording && recFor !== next.id)}
              onClick={(e) => {
                if (recording && recFor === next.id) void stopRec(next.id)
                else if (!recording) void startRec(next.id, e)
              }}
            >
              {memoLabel(next)}
            </button>
            {next.phase !== 'done' && (
              <button type="button" className="ma-chip" onClick={() => void wrap(next.id)}>Wrap</button>
            )}
            {recapHref && (
              <Link className="ma-chip" to={recapHref}>Send recap</Link>
            )}
            <button
              type="button"
              className={`ma-chip ma-chip--danger${confirmDel === next.id ? ' ma-chip--armed' : ''}`}
              disabled={busy}
              onClick={() => (confirmDel === next.id ? void remove(next.id) : setConfirmDel(next.id))}
            >
              {confirmDel === next.id ? 'Confirm delete' : 'Delete'}
            </button>
          </div>
        </div>
      )}
      {!meetings.length && <p className="mini__empty">Name the meeting. Memo and wrap sit on top.</p>}
      {(showAdd || !meetings.length) ? (
        <form className="ma-form" onSubmit={add}>
          <input
            className="ma-input"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Staff review"
            aria-label="Meeting title"
          />
          <button className="ma-btn" type="submit" disabled={busy || !title.trim()}>Add</button>
        </form>
      ) : (
        <button className="ma-btn ma-btn--quiet" type="button" onClick={() => setShowAdd(true)}>Add a meeting</button>
      )}
      {err && <p className="mini__hint">{err}</p>}
      {styleErr && <p className="mini__hint">{styleErr}</p>}
      {recording && (
        <button type="button" className="ma-chip" onClick={abortRec}>Cancel recording</button>
      )}
      {rest.length > 0 && (
        <ul className="ma-list">
          {rest.map((m) => (
            <li key={m.id} className={`ma-row${m.phase === 'done' ? ' ma-row--done' : ''}`}>
              <div className="ma-row-main">
                <span className="ma-title">{m.title}</span>
                <span className="ma-sub">{m.phase === 'done' ? 'Wrapped' : whenLabel(m.startsAt)}</span>
              </div>
              {m.phase !== 'done' && (
                <button
                  type="button"
                  className="ma-chip"
                  disabled={transcribing === m.id || (recording && recFor !== m.id)}
                  onClick={(e) => {
                    if (recording && recFor === m.id) void stopRec(m.id)
                    else if (!recording) void startRec(m.id, e)
                  }}
                >
                  {memoLabel(m)}
                </button>
              )}
              <button
                type="button"
                className={`ma-chip ma-chip--danger${confirmDel === m.id ? ' ma-chip--armed' : ''}`}
                disabled={busy}
                onClick={() => (confirmDel === m.id ? void remove(m.id) : setConfirmDel(m.id))}
              >
                {confirmDel === m.id ? 'Confirm' : '✕'}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

/* -------------------------------- Nutrition ----------------------------- */

const QUICK_ADD = [
  { label: 'Water', desc: '1 glass of water', cal: 0, p: 0, c: 0, f: 0 },
  { label: 'Coffee', desc: '1 cup black coffee', cal: 5, p: 0, c: 0, f: 0 },
] as const

function CalorieRing({ current, goal }: { current: number; goal: number }) {
  const pct = goal > 0 ? Math.min(100, Math.round((current / goal) * 100)) : 0
  const r = 58
  const circ = 2 * Math.PI * r
  const offset = circ - (pct / 100) * circ

  return (
    <div className="nutr-ring-wrap">
      <svg className="nutr-ring" viewBox="0 0 132 132">
        <defs>
          <linearGradient id="nutrCalGrad" x1="0%" y1="0%" x2="100%" y2="100%">
            <stop offset="0%" stopColor="var(--hA-accent, #7fe3c4)" />
            <stop offset="100%" stopColor="var(--hA-accent-2, #3fd9f5)" />
          </linearGradient>
        </defs>
        <circle cx="66" cy="66" r={r} fill="none" stroke="rgba(255, 255, 255, 0.07)" strokeWidth="10" />
        <circle
          cx="66" cy="66" r={r} fill="none"
          stroke="url(#nutrCalGrad)"
          strokeWidth="10"
          strokeLinecap="round"
          strokeDasharray={circ}
          strokeDashoffset={offset}
          className="nutr-ring-progress"
        />
      </svg>
      <div className={`nutr-ring-label${pct === 0 ? ' is-empty' : ''}`}>
        <span className="nutr-ring-num">{Math.round(current)}</span>
        <span className="nutr-ring-unit">/ {goal} cal</span>
      </div>
    </div>
  )
}

function MacroPill({ label, current, goal }: { label: string; current: number; goal: number }) {
  const pct = goal > 0 ? Math.min(100, Math.round((current / goal) * 100)) : 0
  return (
    <div className="nutr-pill">
      <div className="nutr-pill-top">
        <span className="nutr-pill-label">{label}</span>
        <span className="nutr-pill-val">{Math.round(current)}<span className="nutr-pill-of"> / {goal}g</span></span>
      </div>
      <div className="nutr-pill-track">
        <div className="nutr-pill-fill" style={{ width: `${pct}%` }} />
      </div>
    </div>
  )
}

function groupNutritionHistory(logs: NutritionLog[]): Array<{ day: string; label: string; meals: NutritionLog[] }> {
  const byDay = new Map<string, NutritionLog[]>()
  for (const l of logs) {
    const d = new Date(l.eatenAt)
    const key = Number.isNaN(d.getTime())
      ? l.eatenAt.slice(0, 10)
      : `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
    const arr = byDay.get(key)
    if (arr) arr.push(l)
    else byDay.set(key, [l])
  }
  return [...byDay.entries()].map(([day, meals]) => {
    const [y, m, d] = day.split('-').map(Number)
    return {
      day,
      meals,
      label: new Date(y || 1970, (m || 1) - 1, d || 1).toLocaleDateString('en-US', {
        weekday: 'short',
        month: 'short',
        day: 'numeric',
      }),
    }
  })
}

export function NutritionApp({ auth }: { auth: FeatureAuth }) {
  const a = useAuthed(auth)
  const [goals, setGoals] = useState<NutritionGoals | null>(null)
  const [logs, setLogs] = useState<NutritionLog[]>([])
  const [history, setHistory] = useState<NutritionLog[]>([])
  const [totals, setTotals] = useState({ calories: 0, protein: 0, carbs: 0, fat: 0 })
  const [desc, setDesc] = useState('')
  const [busy, setBusy] = useState(false)
  const [analyzing, setAnalyzing] = useState(false)
  const [msg, setMsg] = useState('')
  const fileRef = useRef<HTMLInputElement | null>(null)
  const [showGoals, setShowGoals] = useState(false)
  const [goalInput, setGoalInput] = useState({ calories: 2200, protein: 150, carbs: 220, fat: 70 })
  const [prefs, setPrefs] = useState<{ currentWeightLb: number | null; targetWeightLb: number | null; weightGoal: 'loss' | 'gain' | 'muscle' | null }>({ currentWeightLb: null, targetWeightLb: null, weightGoal: null })
  const [weightInput, setWeightInput] = useState({ current: '', target: '' })
  const [showWeight, setShowWeight] = useState(false)
  const [selectedMeal, setSelectedMeal] = useState<NutritionLog | null>(null)
  const [pending, setPending] = useState<{
    description: string
    calories: number
    protein: number
    carbs: number
    fat: number
    imageBase64?: string
  } | null>(null)

  const load = useCallback(() => {
    apiNutritionToday(a)
      .then((d) => {
        setGoals(d.goals)
        setLogs(d.logs)
        setHistory(d.history || [])
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
    apiGetMiniPrefs(a)
      .then((d) => {
        const next = { currentWeightLb: d.currentWeightLb ?? null, targetWeightLb: d.targetWeightLb ?? null, weightGoal: d.weightGoal ?? null }
        setPrefs(next)
        setWeightInput((w) => ({ current: w.current || (next.currentWeightLb ? String(next.currentWeightLb) : ''), target: w.target || (next.targetWeightLb ? String(next.targetWeightLb) : '') }))
      })
      .catch(() => undefined)
  }, [a])

  useEffect(() => { load() }, [load])

  function pickImage(file: File | undefined) {
    if (!file) return
    setAnalyzing(true)
    setMsg('Reading the photo…')
    const reader = new FileReader()
    reader.onload = async () => {
      const base64 = String(reader.result || '').split(',')[1] || ''
      try {
        const est = await apiAnalyzeNutrition({
          ...a,
          description: desc.trim() || 'meal from photo',
          imageBase64: base64,
        })
        if (est.needsKey) {
          await apiLogNutritionPhoto({ ...a, description: desc.trim(), imageBase64: base64 })
          setMsg('Logged. Add a model key to auto-estimate macros.')
          load()
        } else if (est.ok) {
          setPending({
            description: est.guess || desc.trim() || 'meal from photo',
            calories: est.calories || 0,
            protein: est.protein || 0,
            carbs: est.carbs || 0,
            fat: est.fat || 0,
            imageBase64: base64,
          })
          setMsg('Confirm macros, then log.')
        } else {
          setMsg(est.error || 'Could not estimate that photo.')
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
        setDesc('')
        load()
      } else if (est.ok) {
        setPending({
          description: est.guess || desc.trim(),
          calories: est.calories || 0,
          protein: est.protein || 0,
          carbs: est.carbs || 0,
          fat: est.fat || 0,
        })
        setMsg('Confirm macros, then log.')
      } else {
        await apiLogNutrition({ ...a, description: desc.trim() })
        setMsg(est.error || 'Logged without a macro estimate.')
        setDesc('')
        load()
      }
    } catch {
      setMsg('Could not log that.')
    } finally {
      setBusy(false)
    }
  }

  async function confirmPending() {
    if (!pending || busy) return
    setBusy(true)
    try {
      await apiLogNutrition({
        ...a,
        description: pending.description,
        calories: pending.calories,
        protein: pending.protein,
        carbs: pending.carbs,
        fat: pending.fat,
      })
      setPending(null)
      setDesc('')
      setMsg('')
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
  const proteinLeft = Math.max(0, g.proteinGoal - totals.protein)
  const calLeft = Math.max(0, g.calorieGoal - totals.calories)
  const hour = new Date().getHours()
  const nextMeal = hour < 11 ? 'Breakfast' : hour < 15 ? 'Lunch' : hour < 21 ? 'Dinner' : 'Tonight'
  const nutrInsight = logs.length === 0
    ? `No meals yet. ${nextMeal} is the next log.`
    : proteinLeft >= 20
      ? `${Math.round(proteinLeft)}g protein left`
      : totals.calories >= g.calorieGoal
        ? 'Calories are at the goal.'
        : `${Math.round(calLeft)} cal left. ${nextMeal} still fits.`

  /* Nutritionist math (Mifflin-St Jeor approximation, activity folded flat):
   * loss = maintenance - 500, gain = +300, muscle = +200 with high protein.
   * Protein anchors on target weight (0.8g/lb), fat 25% of calories, carbs the rest. */
  function recommendMacros(cur: number, target: number, goal: 'loss' | 'gain' | 'muscle') {
    const age = 30, heightIn = 69, male = true
    const base = 10 * (cur * 0.4536) + 6.25 * (heightIn * 2.54) - 5 * age + (male ? 5 : -161)
    const maintenance = Math.round(base * 1.5)
    const calories = goal === 'loss' ? maintenance - 500 : goal === 'gain' ? maintenance + 300 : maintenance + 200
    const proteinPerLb = goal === 'muscle' ? 1.0 : goal === 'loss' ? 0.9 : 0.8
    const protein = Math.round((goal === 'gain' ? cur : target || cur) * proteinPerLb)
    const fat = Math.round((calories * 0.25) / 9)
    const carbs = Math.max(50, Math.round((calories - protein * 4 - fat * 9) / 4))
    return { calories, protein, carbs, fat, maintenance }
  }

  async function saveWeights(applyRecs: boolean) {
    if (busy) return
    const cur = Number(weightInput.current)
    const target = Number(weightInput.target)
    if (!cur || cur < 60 || cur > 600) { setMsg('Enter a current weight in lb.'); return }
    setBusy(true)
    try {
      const goal = prefs.weightGoal || 'loss'
      const res = await apiPutMiniPrefs({
        ...a,
        currentWeightLb: cur,
        targetWeightLb: target && target >= 60 && target <= 600 ? target : undefined,
        weightGoal: goal,
      })
      setPrefs((p) => ({ ...p, currentWeightLb: res.currentWeightLb ?? cur, targetWeightLb: res.targetWeightLb ?? (target || null), weightGoal: goal }))
      if (applyRecs) {
        const rec = recommendMacros(cur, target || cur, goal)
        setGoalInput({ calories: rec.calories, protein: rec.protein, carbs: rec.carbs, fat: rec.fat })
        await apiSetNutritionGoals({ ...a, calorieGoal: rec.calories, proteinGoal: rec.protein, carbsGoal: rec.carbs, fatGoal: rec.fat })
        load()
        setMsg(`Plan set: ${rec.calories} cal, ${rec.protein}g protein for ${goal === 'loss' ? 'weight loss' : goal === 'gain' ? 'weight gain' : 'muscle gain'}.`)
      } else {
        setMsg('Weights saved.')
      }
      setShowWeight(false)
    } catch {
      setMsg('Could not save weights.')
    } finally {
      setBusy(false)
    }
  }

  async function saveGoals() {
    if (busy) return
    setBusy(true)
    try {
      await apiSetNutritionGoals({
        ...a,
        calorieGoal: goalInput.calories,
        proteinGoal: goalInput.protein,
        carbsGoal: goalInput.carbs,
        fatGoal: goalInput.fat,
      })
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

  const historyDays = groupNutritionHistory(history)

  return (
    <div className="ma nutr">
      {/* Hero ring + macro pills */}
      <div className="nutr-hero">
        <CalorieRing current={totals.calories} goal={g.calorieGoal} />
        <div className="nutr-pills">
          <MacroPill label="Protein" current={totals.protein} goal={g.proteinGoal} />
          <MacroPill label="Carbs" current={totals.carbs} goal={g.carbsGoal} />
          <MacroPill label="Fat" current={totals.fat} goal={g.fatGoal} />
        </div>
      </div>
      <p className="nutr-insight">{nutrInsight}</p>

      {/* Quick add */}
      <div className="nutr-quick-section">
        <span className="nutr-quick-label">Quick</span>
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
        <label className="nutr-photo-btn" title="Photo of food">
          <input ref={fileRef} type="file" accept="image/*" onChange={(e) => pickImage(e.target.files?.[0])} aria-label="Photo of food" />
          {analyzing ? (
            <span className="nutr-photo-text">…</span>
          ) : (
            <>
              <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" focusable="false">
                <g fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M4.6 8.2h3l1.6-2.4h5.6l1.6 2.4h3v10.2H4.6z" />
                  <circle cx="12" cy="13" r="3.2" />
                </g>
              </svg>
              <span className="nutr-photo-text">Upload</span>
            </>
          )}
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
            Estimate
          </button>
        </form>
      </div>
      {pending && (
        <div className="ma-callout">
          <span className="ma-callout-kicker">Confirm</span>
          <strong>{pending.description}</strong>
          <span className="ma-sub">
            {Math.round(pending.calories)} cal · {Math.round(pending.protein)}p · {Math.round(pending.carbs)}c · {Math.round(pending.fat)}f
          </span>
          <div className="ma-callout-actions">
            <button className="ma-btn" type="button" disabled={busy} onClick={() => void confirmPending()}>Log</button>
            <button className="ma-chip" type="button" onClick={() => { setPending(null); setMsg('') }}>Skip</button>
          </div>
        </div>
      )}
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
        <div className="nutr-goal-btns nutr-goal-btns--2">
          <button type="button" className="nutr-edit-goals" onClick={() => setShowWeight((v) => !v)}>
            {prefs.currentWeightLb
              ? prefs.targetWeightLb && prefs.targetWeightLb !== prefs.currentWeightLb
                ? `${prefs.currentWeightLb} → ${prefs.targetWeightLb} lb`
                : `${prefs.currentWeightLb} lb`
              : 'Weight'}
          </button>
          <button type="button" className="nutr-edit-goals" onClick={() => setShowGoals(true)}>
            Goals
          </button>
        </div>
      )}

      {showWeight && !showGoals && (
        <div className="nutr-goals-form">
          <strong className="nutr-weight-title">Your weight plan</strong>
          <div className="nutr-weight-goal-picker" role="radiogroup" aria-label="Goal">
            {(['loss', 'gain', 'muscle'] as const).map((g) => (
              <button
                key={g}
                type="button"
                role="radio"
                aria-checked={(prefs.weightGoal || 'loss') === g}
                className={`nutr-weight-goal${(prefs.weightGoal || 'loss') === g ? ' is-on' : ''}`}
                onClick={() => setPrefs((p) => ({ ...p, weightGoal: g }))}
              >
                {g === 'loss' ? 'Weight loss' : g === 'gain' ? 'Weight gain' : 'Muscle gain'}
              </button>
            ))}
          </div>
          <div className="nutr-goals-grid">
            <label className="nutr-goal-field">
              <span>Current (lb)</span>
              <input
                className="nutr-goal-input" type="number" min={60} max={600} inputMode="decimal"
                placeholder="180"
                value={weightInput.current}
                onChange={(e) => setWeightInput((w) => ({ ...w, current: e.target.value }))}
              />
            </label>
            <label className="nutr-goal-field">
              <span>Target (lb)</span>
              <input
                className="nutr-goal-input" type="number" min={60} max={600} inputMode="decimal"
                placeholder="165"
                value={weightInput.target}
                onChange={(e) => setWeightInput((w) => ({ ...w, target: e.target.value }))}
              />
            </label>
          </div>
          <div className="nutr-goals-actions">
            <button type="button" className="nutr-save-btn" disabled={busy} onClick={() => void saveWeights(true)}>
              {busy ? 'Saving…' : 'Save + set my plan'}
            </button>
            <button type="button" className="nutr-cancel-btn" onClick={() => void saveWeights(false)} disabled={busy}>
              Just save
            </button>
          </div>
          <p className="nutr-weight-note">
            {prefs.currentWeightLb && prefs.targetWeightLb && prefs.weightGoal
              ? `On it: ${prefs.weightGoal === 'loss' ? 'losing' : prefs.weightGoal === 'gain' ? 'gaining' : 'building'} toward ${prefs.targetWeightLb} lb. Ask Alpha what to eat anytime.`
              : 'Alpha becomes your nutritionist: calories, protein, carbs, and fat tuned to your goal.'}
          </p>
        </div>
      )}

      {/* Today's meals */}
      <section className="nutr-meals">
        <h3>Today</h3>
        {logs.length ? (
          <ul className="nutr-meal-list">
            {logs.map((l) => (
              <li key={l.id} className="nutr-meal-card" onClick={() => setSelectedMeal(l)}>
                <div className="nutr-meal-time">{mealTime(l.eatenAt)}</div>
                {l.imageUrl ? <img src={l.imageUrl} alt="" className="nutr-meal-thumb" loading="lazy" /> : null}
                <div className="nutr-meal-info">
                  <span className="nutr-meal-name">{l.description}</span>
                  <span className="nutr-meal-macros">
                    {Math.round(l.calories)} cal
                    {l.protein || l.carbs || l.fat
                      ? ` · ${Math.round(l.protein)}p · ${Math.round(l.carbs)}c · ${Math.round(l.fat)}f`
                      : ''}
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

      {historyDays.length > 0 && (
        <section className="nutr-meals">
          <h3>Earlier</h3>
          {historyDays.map(({ day, label, meals }) => (
            <div key={day}>
              <p className="nutr-earlier-day">{label}</p>
              <ul className="nutr-meal-list">
                {meals.map((l) => (
                  <li key={l.id} className="nutr-meal-card" onClick={() => setSelectedMeal(l)}>
                    <div className="nutr-meal-time">{mealTime(l.eatenAt)}</div>
                    {l.imageUrl ? <img src={l.imageUrl} alt="" className="nutr-meal-thumb" loading="lazy" /> : null}
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
            </div>
          ))}
        </section>
      )}

      {/* Meal detail modal */}
      {selectedMeal && (
        <div className="nutr-modal-overlay" onClick={() => setSelectedMeal(null)}>
          <div className="nutr-modal" onClick={(e) => e.stopPropagation()}>
            <button className="nutr-modal-close" type="button" onClick={() => setSelectedMeal(null)}>×</button>
            {selectedMeal.imageUrl ? <img src={selectedMeal.imageUrl} alt="" className="nutr-modal-img" /> : null}
            <h3>{selectedMeal.description}</h3>
            <span className="nutr-modal-time">{mealTime(selectedMeal.eatenAt)}</span>
            <div className="nutr-modal-macros">
              <div className="nutr-modal-macro">
                <span className="nutr-modal-macro-val">{Math.round(selectedMeal.calories)}</span>
                <span className="nutr-modal-macro-label">Calories</span>
              </div>
              <div className="nutr-modal-macro">
                <span className="nutr-modal-macro-val">{Math.round(selectedMeal.protein)}g</span>
                <span className="nutr-modal-macro-label">Protein</span>
              </div>
              <div className="nutr-modal-macro">
                <span className="nutr-modal-macro-val">{Math.round(selectedMeal.carbs)}g</span>
                <span className="nutr-modal-macro-label">Carbs</span>
              </div>
              <div className="nutr-modal-macro">
                <span className="nutr-modal-macro-val">{Math.round(selectedMeal.fat)}g</span>
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
                    <div style={{ width: `${pPct}%` }} />
                    <div style={{ width: `${cPct}%` }} />
                    <div style={{ width: `${fPct}%` }} />
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

function localDateStr(d = new Date()) {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

function mondayOfLocal(d = new Date()): Date {
  const x = new Date(d.getFullYear(), d.getMonth(), d.getDate())
  const day = x.getDay()
  const diff = day === 0 ? 6 : day - 1
  x.setDate(x.getDate() - diff)
  return x
}

function currentWeekDays(): string[] {
  const monday = mondayOfLocal()
  const days: string[] = []
  for (let i = 0; i < 7; i++) {
    const d = new Date(monday)
    d.setDate(d.getDate() + i)
    days.push(localDateStr(d))
  }
  return days
}

function isoToLocalDate(iso: string) {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso.slice(0, 10)
  return localDateStr(d)
}

export function HabitStreakApp({ auth }: { auth: FeatureAuth }) {
  const a = useAuthed(auth)
  const [habits, setHabits] = useState<(Habit & { streak: number; recentDays: string[]; logDates?: string[] })[]>([])
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState('')
  const [days, setDays] = useState<string[]>(() => currentWeekDays())
  const [showAdd, setShowAdd] = useState(false)

  const load = useCallback(() => {
    apiListHabits(a).then((d) => {
      setHabits(d.habits)
      if (d.weekDays?.length === 7) setDays(d.weekDays)
    }).catch(() => setMsg('Could not load habits.'))
  }, [a])

  useEffect(() => { load() }, [load])

  async function add(e: FormEvent) {
    e.preventDefault()
    if (!name.trim() || busy) return
    setBusy(true)
    try {
      await apiAddHabit({ ...a, name: name.trim(), emoji: '·' })
      setName('')
      setShowAdd(false)
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
      setMsg('Could not update.')
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

  const today = localDateStr()
  const left = habits.filter((h) => !h.recentDays.includes(today))
  const doneToday = habits.length - left.length
  const bestStreak = habits.reduce((n, h) => Math.max(n, h.streak), 0)
  const allDone = habits.length > 0 && left.length === 0

  async function checkOffRemaining() {
    if (busy || left.length === 0) return
    setBusy(true)
    try {
      await Promise.all(left.map((h) => apiToggleHabit({ ...a, habitId: h.id, date: today })))
      load()
    } catch {
      setMsg('Could not update.')
    } finally {
      setBusy(false)
    }
  }

  const heatmapCols = buildHabitHeatmap(habits)
  const hasLogDates = habits.some((h) => (h.logDates?.length ?? 0) > 0)

  const addForm = (
    <form className="ma-form" onSubmit={add}>
      <input className="ma-input" value={name} onChange={(e) => setName(e.target.value)} placeholder="New habit" aria-label="Habit name" />
      <button className="ma-btn" type="submit" disabled={busy || !name.trim()}>Add</button>
    </form>
  )

  return (
    <div className="ma habit">
      <div className="ma-hero">
        <span className="ma-hero-kicker">Today</span>
        <span className="ma-hero-num">
          {habits.length === 0 ? 'Start a streak' : allDone ? 'All done' : `${doneToday} of ${habits.length}`}
        </span>
        <span className="ma-hero-label">
          {habits.length === 0
            ? 'Add one habit. Tap today to start.'
            : allDone
              ? bestStreak ? `Best streak ${bestStreak} days` : 'Come back tomorrow'
              : left[0] ? `${left[0].name} is next` : 'Check off what you did'}
        </span>
      </div>

      {hasLogDates && habits.length > 0 && (
        <div className="habit-heatmap" aria-label="12-week completion history" role="img">
          {heatmapCols.map((col, wi) => (
            <div key={wi} className="habit-heatmap-col">
              {col.map((cell) => (
                <div
                  key={cell.date}
                  className={`habit-heatmap-cell${cell.level < 0 ? ' future' : ''}`}
                  data-level={cell.level < 0 ? undefined : cell.level}
                  title={cell.level >= 0 ? cell.date : undefined}
                />
              ))}
            </div>
          ))}
        </div>
      )}

      {left.length > 0 && (
        <button className="ma-btn ma-btn--block" type="button" disabled={busy} onClick={() => void checkOffRemaining()}>
          {left.length === 1 && left[0] ? `Done with ${left[0].name}` : 'Check off the rest'}
        </button>
      )}

      {msg && <p className="mini__hint">{msg}</p>}

      {habits.length ? (
        <ul className="habit-list">
          {habits.map((h) => {
            const done = h.recentDays.includes(today)
            return (
              <li key={h.id} className="habit-card">
                <div className="habit-info">
                  <div className="habit-name">{h.name}</div>
                  <div className="habit-streak">{h.streak ? `${h.streak} day streak` : 'None yet'}</div>
                  <div className="habit-week" aria-label="This week">
                    {days.map((d) => (
                      <button
                        key={d}
                        className={`habit-week-sq${h.recentDays.includes(d) ? ' done' : ''}${d === today ? ' today' : ''}`}
                        type="button"
                        aria-label={d === today ? 'Today' : d}
                        aria-pressed={h.recentDays.includes(d)}
                        onClick={() => void toggle(h.id, d)}
                      />
                    ))}
                  </div>
                </div>
                <div className="habit-actions">
                  {!done ? (
                    <button className="ma-chip" type="button" disabled={busy} onClick={() => void toggle(h.id, today)}>
                      Done
                    </button>
                  ) : (
                    <button className="ma-chip ma-chip--on" type="button" disabled={busy} onClick={() => void toggle(h.id, today)}>
                      Done
                    </button>
                  )}
                  <button className="habit-delete" type="button" onClick={() => void remove(h.id)} title="Remove" aria-label="Remove habit">×</button>
                </div>
              </li>
            )
          })}
        </ul>
      ) : (
        <p className="mini__empty">Add one habit. Tap Done each day to build a streak.</p>
      )}

      {habits.length > 0 && !showAdd && (
        <button className="ma-btn ma-btn--quiet ma-btn--block" type="button" onClick={() => setShowAdd(true)}>Add habit</button>
      )}
      {(habits.length === 0 || showAdd) && addForm}
    </div>
  )
}

/* ------------------------------ Mood & Energy Tracker ------------------------------ */

interface MoodConfig {
  key: string
  label: string
  desc: string
  color: string
  badgeBg: string
}

const MOOD_OPTIONS: MoodConfig[] = [
  { key: 'great', label: 'Great', desc: 'Energized & dialed in', color: '#10b981', badgeBg: 'rgba(16, 185, 129, 0.15)' },
  { key: 'good', label: 'Good', desc: 'Positive & balanced', color: '#06b6d4', badgeBg: 'rgba(6, 182, 212, 0.15)' },
  { key: 'okay', label: 'Okay', desc: 'Steady & cruising', color: '#6366f1', badgeBg: 'rgba(99, 102, 241, 0.15)' },
  { key: 'low', label: 'Low', desc: 'Drained or tired', color: '#f59e0b', badgeBg: 'rgba(245, 158, 11, 0.15)' },
  { key: 'off', label: 'Off', desc: 'Stressed or tense', color: '#f43f5e', badgeBg: 'rgba(244, 63, 94, 0.15)' },
]

function parseMood(val?: string | null): MoodConfig {
  const v = String(val || '').toLowerCase().trim()
  if (v === 'great' || v === 'awesome' || v === '😄' || v === '5') return MOOD_OPTIONS[0]
  if (v === 'good' || v === 'solid' || v === '🙂' || v === '4') return MOOD_OPTIONS[1]
  if (v === 'okay' || v === 'neutral' || v === 'fine' || v === '😐' || v === '3') return MOOD_OPTIONS[2]
  if (v === 'low' || v === 'down' || v === 'tired' || v === '😔' || v === '2') return MOOD_OPTIONS[3]
  if (v === 'off' || v === 'hot' || v === 'stressed' || v === '😤' || v === '1') return MOOD_OPTIONS[4]
  return MOOD_OPTIONS[1]
}

function renderMoodIcon(key: string, color: string) {
  switch (key) {
    case 'great':
      return (
        <svg className="mood-card-svg" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <circle cx="12" cy="12" r="4" />
          <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41" />
        </svg>
      )
    case 'good':
      return (
        <svg className="mood-card-svg" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" />
          <polyline points="22 4 12 14.01 9 11.01" />
        </svg>
      )
    case 'okay':
      return (
        <svg className="mood-card-svg" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <circle cx="12" cy="12" r="9" />
          <line x1="8" y1="12" x2="16" y2="12" strokeWidth="2.5" />
        </svg>
      )
    case 'low':
      return (
        <svg className="mood-card-svg" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <rect x="2" y="7" width="16" height="10" rx="3" />
          <line x1="22" y1="11" x2="22" y2="13" />
          <line x1="6" y1="12" x2="6.01" y2="12" strokeWidth="3" />
        </svg>
      )
    case 'off':
    default:
      return (
        <svg className="mood-card-svg" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" />
        </svg>
      )
  }
}

const ENERGY_LEVELS = [
  { level: 1, label: 'Drained', hint: 'Low' },
  { level: 2, label: 'Tired', hint: 'Sluggish' },
  { level: 3, label: 'Steady', hint: 'Balanced' },
  { level: 4, label: 'Charged', hint: 'High' },
  { level: 5, label: 'Peak', hint: 'Max' },
] as const

const MOOD_DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const

function last7LocalDates(): string[] {
  const out: string[] = []
  const now = new Date()
  for (let i = 6; i >= 0; i--) {
    out.push(localDateStr(new Date(now.getFullYear(), now.getMonth(), now.getDate() - i)))
  }
  return out
}

export function MoodTrackerApp({ auth }: { auth: FeatureAuth }) {
  const a = useAuthed(auth)
  const [entries, setEntries] = useState<MoodEntry[]>([])
  const [streak, setStreak] = useState(0)
  const [energy, setEnergy] = useState(3)
  const [note, setNote] = useState('')
  const [showNote, setShowNote] = useState(false)
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState('')

  const load = useCallback(() => {
    apiListMoods(a)
      .then((d) => {
        setEntries(d.entries || [])
        setStreak(d.streak || 0)
        setMsg('')
      })
      .catch((err) =>
        setMsg(err instanceof Error && err.message ? err.message : 'Could not load moods.'),
      )
  }, [a])

  useEffect(() => { load() }, [load])

  const today = localDateStr()
  const todayEntry = entries.find((e) => isoToLocalDate(e.createdAt) === today)
  const activeMood = todayEntry ? parseMood(todayEntry.emoji) : null
  const last = entries[0]

  useEffect(() => {
    if (todayEntry) {
      setEnergy(todayEntry.energy)
      if (todayEntry.note) setNote(todayEntry.note)
    } else if (last) {
      setEnergy(last.energy)
    }
  }, [todayEntry, last])

  async function logMood(choice: MoodConfig) {
    if (busy) return
    setBusy(true)
    try {
      await apiLogMood({ ...a, emoji: choice.label, energy, note: note.trim() || undefined })
      load()
    } catch {
      setMsg('Could not log mood.')
    } finally {
      setBusy(false)
    }
  }

  async function pickEnergy(n: number) {
    setEnergy(n)
    if (!todayEntry || busy) return
    setBusy(true)
    try {
      await apiLogMood({ ...a, emoji: todayEntry.emoji, energy: n, note: note.trim() || undefined })
      load()
    } catch {
      setMsg('Could not log energy.')
    } finally {
      setBusy(false)
    }
  }

  async function saveNote() {
    if (!todayEntry || busy) return
    setBusy(true)
    try {
      await apiLogMood({ ...a, emoji: todayEntry.emoji, energy: todayEntry.energy, note: note.trim() || undefined })
      load()
      setMsg('Note saved.')
      setTimeout(() => setMsg(''), 2500)
    } catch {
      setMsg('Could not save note.')
    } finally {
      setBusy(false)
    }
  }

  const week = last7LocalDates()
  const byDay = new Map<string, MoodEntry>()
  for (const e of [...entries].reverse()) byDay.set(isoToLocalDate(e.createdAt), e)
  const avgEnergy = entries.length
    ? entries.slice(0, 7).reduce((s, e) => s + e.energy, 0) / Math.min(7, entries.length)
    : 0

  return (
    <div className="ma mood-pro">
      {/* Hero Header Card */}
      <div className="mood-hero-card">
        <div className="mood-hero-status-row">
          <span className={`mood-status-pill ${todayEntry ? 'is-logged' : 'is-unlogged'}`}>
            <span className="mood-status-dot" />
            {todayEntry ? 'LOGGED TODAY' : 'NOT LOGGED TODAY'}
          </span>
          {streak > 0 && (
            <span className="mood-streak-pill">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M8.5 14.5A2.5 2.5 0 0 0 11 12c0-1.38-.5-2-1-3-1.072-2.143-.224-4.054 2-6 .5 2.5 2 4.9 4 6.5 2 1.6 3 3.5 3 5.5a7 7 0 1 1-14 0c0-1.153.433-2.294 1-3a2.5 2.5 0 0 0 2.5 2.5z" />
              </svg>
              <span>{streak}d streak</span>
            </span>
          )}
        </div>

        <h2 className="mood-hero-title">
          {todayEntry ? (
            <>
              Feeling <span style={{ color: activeMood?.color }}>{activeMood?.label}</span>
            </>
          ) : (
            'How are you feeling?'
          )}
        </h2>
        <p className="mood-hero-sub">
          {todayEntry
            ? `${activeMood?.desc} · Energy ${todayEntry.energy}/5`
            : 'Select your state to track clarity, stress, and recovery over time.'}
        </p>

        {avgEnergy > 0 && (
          <div className="mood-hero-meter">
            <div className="mood-meter-header">
              <span className="mood-meter-label">7-day average energy</span>
              <span className="mood-meter-val">{avgEnergy.toFixed(1)} / 5</span>
            </div>
            <div className="mood-meter-track">
              <div
                className="mood-meter-fill"
                style={{ width: `${Math.min(100, (avgEnergy / 5) * 100)}%` }}
              />
            </div>
          </div>
        )}
      </div>

      {/* Mood Selector Grid */}
      <section className="mood-section">
        <span className="mood-section-kicker">SELECT MOOD</span>
        <div className="mood-cards-grid">
          {MOOD_OPTIONS.map((choice) => {
            const isSelected = activeMood?.key === choice.key
            return (
              <button
                key={choice.key}
                type="button"
                className={`mood-state-card ${isSelected ? 'is-selected' : ''}`}
                style={{
                  '--mood-color': choice.color,
                  '--mood-bg': choice.badgeBg,
                } as CSSProperties}
                disabled={busy}
                onClick={() => void logMood(choice)}
              >
                <div className="mood-state-icon-wrap">
                  {renderMoodIcon(choice.key, choice.color)}
                </div>
                <div className="mood-state-text">
                  <span className="mood-state-label">{choice.label}</span>
                  <span className="mood-state-desc">{choice.desc}</span>
                </div>
                {isSelected && (
                  <span className="mood-state-check" aria-hidden="true">
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                      <polyline points="20 6 9 17 4 12" />
                    </svg>
                  </span>
                )}
              </button>
            )
          })}
        </div>
      </section>

      {/* Energy Tier Selector */}
      <section className="mood-section">
        <div className="mood-section-split">
          <span className="mood-section-kicker">ENERGY LEVEL</span>
          <span className="mood-energy-hint">
            {ENERGY_LEVELS.find((l) => l.level === energy)?.label} ({energy}/5)
          </span>
        </div>
        <div className="mood-energy-gauge" role="radiogroup" aria-label="Energy level">
          {ENERGY_LEVELS.map((el) => {
            const isFilled = energy >= el.level
            const isSelected = energy === el.level
            return (
              <button
                key={el.level}
                type="button"
                role="radio"
                aria-checked={isSelected}
                className={`mood-energy-step ${isFilled ? 'is-filled' : ''} ${isSelected ? 'is-selected' : ''}`}
                disabled={busy}
                onClick={() => void pickEnergy(el.level)}
              >
                <div className="mood-energy-bar-wrap">
                  <div className="mood-energy-bar" style={{ height: `${el.level * 20}%` }} />
                </div>
                <span className="mood-energy-num">{el.level}</span>
                <span className="mood-energy-tag">{el.hint}</span>
              </button>
            )
          })}
        </div>
      </section>

      {/* Optional Note input */}
      <section className="mood-section">
        <div className="mood-note-card">
          <div className="mood-note-head" onClick={() => setShowNote(!showNote)}>
            <span className="mood-note-title">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
                <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
              </svg>
              {note ? 'Reflection note added' : 'Add context note (optional)'}
            </span>
            <span className="mood-note-toggle">{showNote ? 'Hide' : note ? 'Edit' : 'Add'}</span>
          </div>
          {(showNote || !!note) && (
            <div className="mood-note-body">
              <textarea
                className="mood-note-input"
                value={note}
                placeholder="What drove this state? (e.g. good sleep, intense sprint, workout...)"
                rows={2}
                maxLength={400}
                onChange={(e) => setNote(e.target.value)}
              />
              {todayEntry && (
                <button
                  type="button"
                  className="mood-note-save"
                  disabled={busy}
                  onClick={() => void saveNote()}
                >
                  Save note
                </button>
              )}
            </div>
          )}
        </div>
      </section>

      {msg && <p className="mood-toast">{msg}</p>}

      {/* 7-Day Consistency Rhythm */}
      <section className="mood-section">
        <div className="mood-section-split">
          <span className="mood-section-kicker">LAST 7 DAYS RHYTHM</span>
          <span className="mood-rhythm-sub">{entries.length} logs on record</span>
        </div>
        <div className="mood-rhythm-strip">
          {week.map((d) => {
            const [y, m, day] = d.split('-').map(Number)
            const dateObj = new Date(y || 1970, (m || 1) - 1, day || 1)
            const dayName = MOOD_DAY_NAMES[dateObj.getDay()]
            const hit = byDay.get(d)
            const mood = hit ? parseMood(hit.emoji) : null
            const isToday = d === today

            return (
              <div
                key={d}
                className={`mood-rhythm-col ${isToday ? 'is-today' : ''} ${hit ? 'is-logged' : ''}`}
                style={mood ? { '--day-accent': mood.color, '--day-bg': mood.badgeBg } as CSSProperties : undefined}
              >
                <span className="mood-rhythm-dayname">{isToday ? 'Today' : dayName}</span>
                <div className="mood-rhythm-circle">
                  {hit ? (
                    <span className="mood-rhythm-dot" />
                  ) : (
                    <span className="mood-rhythm-dash">—</span>
                  )}
                </div>
                {hit ? (
                  <span className="mood-rhythm-metric">{hit.energy}e</span>
                ) : (
                  <span className="mood-rhythm-date">{day}</span>
                )}
              </div>
            )
          })}
        </div>
      </section>

      {/* Recent Log History */}
      {entries.length > 0 && (
        <section className="mood-section">
          <span className="mood-section-kicker">RECENT LOGS</span>
          <div className="mood-history-list">
            {entries.slice(0, 7).map((e) => {
              const mood = parseMood(e.emoji)
              return (
                <div key={e.id} className="mood-history-item">
                  <div className="mood-history-badge" style={{ color: mood.color, background: mood.badgeBg }}>
                    <span className="mood-history-badge-dot" style={{ background: mood.color }} />
                    {mood.label}
                  </div>
                  <div className="mood-history-content">
                    <span className="mood-history-time">{fmtWhen(e.createdAt)}</span>
                    {e.note && <p className="mood-history-note">"{e.note}"</p>}
                  </div>
                  <div className="mood-history-energy">
                    <span className="mood-history-energy-val">Energy {e.energy}/5</span>
                    <div className="mood-history-energy-meter">
                      <div className="mood-history-energy-fill" style={{ width: `${e.energy * 20}%` }} />
                    </div>
                  </div>
                </div>
              )
            })}
          </div>
        </section>
      )}
    </div>
  )
}
