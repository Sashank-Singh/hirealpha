import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react'
import { Link } from 'react-router-dom'
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
  apiLogNutritionPhoto,
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

function useAuthed(auth: FeatureAuth) {
  return { email: auth.email, token: auth.token }
}

/* ------------------------------ Open Loops ------------------------------ */

function loopRank(l: OpenLoop, today: string) {
  const d = dueDay(l.dueAt)
  if (!d) return 2
  if (d < today) return 0
  if (d === today) return 1
  return 3
}

function loopDueLabel(l: OpenLoop, today: string) {
  const d = dueDay(l.dueAt)
  if (!d) return 'no date'
  if (d < today) return 'overdue'
  if (d === today) return 'today'
  return fmtWhen(l.dueAt)
}

export function OpenLoopsApp({ auth }: { auth: FeatureAuth }) {
  const a = useAuthed(auth)
  const [loops, setLoops] = useState<OpenLoop[]>([])
  const [title, setTitle] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const [showAdd, setShowAdd] = useState(false)
  const today = todayStr()

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
      await apiAddLoop({ ...a, persona: auth.persona, title: title.trim(), dueAt: today })
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
    await apiPatchLoop({ ...a, id, status }).catch(() => undefined)
    load()
  }

  async function snooze(id: string) {
    const due = new Date()
    due.setDate(due.getDate() + 1)
    due.setHours(9, 0, 0, 0)
    await apiPatchLoop({ ...a, id, status: 'open', dueAt: due.toISOString() }).catch(() => undefined)
    load()
  }

  const open = loops
    .filter((l) => l.status === 'open')
    .slice()
    .sort((x, y) => loopRank(x, today) - loopRank(y, today))
  const snoozed = loops.filter((l) => l.status === 'snoozed')
  const dueNow = open.filter((l) => loopRank(l, today) <= 1)
  const next = dueNow[0] || open[0]

  return (
    <div className="ma">
      {next && (
        <div className={`ma-callout${loopRank(next, today) <= 1 ? ' ma-callout--hot' : ''}`}>
          <span className="ma-callout-kicker">{loopDueLabel(next, today)}</span>
          <strong>{next.title}</strong>
          <div className="ma-callout-actions">
            <button className="ma-btn" type="button" onClick={() => void setStatus(next.id, 'done')}>Close</button>
            <button className="ma-chip" type="button" onClick={() => void snooze(next.id)}>Snooze</button>
          </div>
        </div>
      )}
      {!open.length && (
        <p className="mini__empty">Add a promise. Due today sits on top.</p>
      )}
      {(showAdd || !loops.length) ? (
        <form className="ma-form" onSubmit={add}>
          <input
            className="ma-input"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Said I would send the deck"
            aria-label="New open loop"
          />
          <button className="ma-btn" type="submit" disabled={busy || !title.trim()}>Add</button>
        </form>
      ) : (
        <button className="ma-btn ma-btn--quiet" type="button" onClick={() => setShowAdd(true)}>Add a promise</button>
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
                <button className="ma-chip" type="button" onClick={() => void setStatus(l.id, 'done')}>Close</button>
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
                <span className="ma-sub">Snoozed</span>
              </div>
              <button className="ma-chip" type="button" onClick={() => void setStatus(l.id, 'open')}>Restore</button>
            </li>
          ))}
        </ul>
      )}
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
  }, [a.email, a.token])

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
        persona: auth.persona,
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
    try {
      await apiReviewDecision({ ...a, id, outcome })
      load()
    } catch (error) {
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
            {decisionRank(next) === 0 ? 'Review today' : next.reviewAt ? `Review ${fmtWhen(next.reviewAt)}` : 'Still open'}
          </span>
          <strong>{next.decision}</strong>
          {next.reason && <span className="ma-sub">{next.reason}</span>}
          <div className="ma-callout-actions">
            <button type="button" className="ma-btn" disabled={busy} onClick={() => void markOutcome(next.id, 'worked')}>
              Worked
            </button>
            <button type="button" className="ma-chip" disabled={busy} onClick={() => void markOutcome(next.id, 'did not work')}>
              Did not work
            </button>
          </div>
        </div>
      )}
      {!decisions.length && <p className="mini__empty">Log the call in one line. Review sits on top in a week.</p>}
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
                    ? `Reviewed · ${d.outcome || 'done'}`
                    : d.reason || (d.reviewAt ? `Review ${fmtWhen(d.reviewAt)}` : `Logged ${fmtWhen(d.createdAt)}`)}
                </span>
              </div>
              {d.status !== 'reviewed' && (
                <button type="button" className="ma-chip" disabled={busy} onClick={() => void markOutcome(d.id, 'worked')}>
                  Worked
                </button>
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
    await apiTouchRelationship({ ...a, id }).catch(() => undefined)
    load()
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

export function DropZoneApp({ auth }: { auth: FeatureAuth }) {
  const a = useAuthed(auth)
  const [drops, setDrops] = useState<Drop[]>([])
  const [content, setContent] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const [filing, setFiling] = useState<string | null>(null)

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

  async function fileDrop(drop: Drop, bucket: DropBucket) {
    if (filing) return
    setFiling(drop.id)
    setErr('')
    try {
      if (bucket === 'learning') {
        await apiAddLearning({ ...a, title: drop.content.slice(0, 120) })
      } else if (bucket === 'loop') {
        await apiAddLoop({ ...a, persona: auth.persona, title: drop.content.slice(0, 200), dueAt: todayStr() })
      } else {
        await apiAddNetwork({ ...a, name: nameFromDrop(drop.content), context: drop.content.slice(0, 400) })
      }
      await apiPatchDrop({ ...a, id: drop.id, status: 'routed', summary: bucket })
      load()
    } catch (error) {
      setErr(error instanceof Error ? error.message : 'Could not file that.')
    } finally {
      setFiling(null)
    }
  }

  const unsorted = drops.filter((d) => d.status === 'new')
  const routed = drops.filter((d) => d.status !== 'new')
  const next = unsorted[0]

  return (
    <div className="ma">
      {!drops.length && <p className="mini__empty">Dump anything. Then file it as learning, a loop, or a person.</p>}
      {next && (
        <div className="ma-callout">
          <span className="ma-callout-kicker">Suggested: {DROP_BUCKETS.find((b) => b.id === guessDropBucket(next.content))?.label}</span>
          <strong>{next.content}</strong>
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
                  <span className="ma-sub">Suggested {guess}</span>
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
  const [title, setTitle] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const [recording, setRecording] = useState(false)
  const [recFor, setRecFor] = useState<string | null>(null)
  const [transcribing, setTranscribing] = useState<string | null>(null)
  const [styleErr, setStyleErr] = useState('')
  const [showAdd, setShowAdd] = useState(false)
  const [recapHref, setRecapHref] = useState('')
  const recRef = useRef<{ media: MediaRecorder | null; chunks: Blob[]; start: number }>({
    media: null,
    chunks: [],
    start: 0,
  })

  const load = useCallback(() => {
    Promise.all([
      apiListMeetings(a),
      apiDayEvents({ ...a, persona: auth.persona }).catch(() => ({ events: [] as Array<{ id: string; title: string; start: string; label: string }> })),
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
  }, [a.email, a.token, auth.persona])

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
    await apiPatchMeeting({ ...a, id, phase: 'done' }).catch(() => undefined)
    const recap = [m?.briefing, m?.notes].filter(Boolean).join('\n\n') || `Wrapped ${m?.title || 'the meeting'}.`
    await apiSaveWorkDraft({
      ...a,
      persona: auth.persona,
      kind: 'email',
      toAddr: '',
      subject: `Recap: ${m?.title || 'meeting'}`,
      body: recap,
    }).catch(() => undefined)
    setRecapHref(`/app/mini/${auth.persona}/approve_send`)
    load()
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

  function memoLabel(m: Meeting) {
    if (recording && recFor === m.id) return `Stop ${recordingElapsed(recRef.current.start, now)}`
    if (transcribing === m.id) return 'Transcribing'
    return 'Memo'
  }

  return (
    <div className="ma">
      {next && (
        <div className={`ma-callout${next.phase !== 'done' ? ' ma-callout--hot' : ''}`}>
          <span className="ma-callout-kicker">{next.phase === 'done' ? 'Wrapped' : 'Up next'}</span>
          <strong>{next.title}</strong>
          <span className="ma-sub">{whenLabel(next.startsAt)}</span>
          {next.briefing && <span className="ma-sub">{next.briefing}</span>}
          {next.notes && <span className="ma-sub">{next.notes}</span>}
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
  }, [a.email, a.token])

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
        <label className="nutr-photo-btn">
          <input ref={fileRef} type="file" accept="image/*" onChange={(e) => pickImage(e.target.files?.[0])} aria-label="Photo of food" />
          <span className="nutr-photo-text">{analyzing ? 'Wait' : 'Photo'}</span>
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

function dayLetter(dateStr: string): string {
  const [y, m, d] = dateStr.split('-').map(Number)
  return ['S', 'M', 'T', 'W', 'T', 'F', 'S'][new Date(Date.UTC(y || 1970, (m || 1) - 1, d || 1)).getUTCDay()] || ''
}

function isoToLocalDate(iso: string) {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso.slice(0, 10)
  return localDateStr(d)
}

export function HabitStreakApp({ auth }: { auth: FeatureAuth }) {
  const a = useAuthed(auth)
  const [habits, setHabits] = useState<(Habit & { streak: number; recentDays: string[] })[]>([])
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
  }, [a.email, a.token])

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

  async function markRemaining() {
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
              : left[0] ? `${left[0].name} is next` : 'Mark what you did'}
        </span>
      </div>

      {left.length > 0 && (
        <button className="ma-btn ma-btn--block" type="button" disabled={busy} onClick={() => void markRemaining()}>
          {left.length === 1 ? `Mark ${left[0].name}` : 'Mark remaining'}
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
                  <div className="habit-streak">{h.streak ? `${h.streak} day streak` : 'No streak yet'}</div>
                </div>
                <div className="habit-days">
                  {days.map((d) => (
                    <button
                      key={d}
                      className={`habit-day${h.recentDays.includes(d) ? ' done' : ''}${d === today ? ' today' : ''}`}
                      type="button"
                      onClick={() => void toggle(h.id, d)}
                    >
                      {dayLetter(d)}
                    </button>
                  ))}
                </div>
                {!done ? (
                  <button className="ma-chip" type="button" disabled={busy} onClick={() => void toggle(h.id, today)}>
                    Mark
                  </button>
                ) : (
                  <button className="ma-chip ma-chip--on" type="button" disabled={busy} onClick={() => void toggle(h.id, today)}>
                    Done
                  </button>
                )}
                <button className="habit-delete" type="button" onClick={() => void remove(h.id)} title="Remove">×</button>
              </li>
            )
          })}
        </ul>
      ) : (
        <p className="mini__empty">Add one habit. Tap today to start.</p>
      )}

      {habits.length > 0 && !showAdd && (
        <button className="ma-btn ma-btn--quiet ma-btn--block" type="button" onClick={() => setShowAdd(true)}>Add habit</button>
      )}
      {(habits.length === 0 || showAdd) && addForm}
    </div>
  )
}

/* ------------------------------ Mood & Energy Tracker ------------------------------ */

const MOOD_CHOICES = [
  { emoji: '😄', label: 'Good' },
  { emoji: '🙂', label: 'Okay' },
  { emoji: '😐', label: 'Low' },
  { emoji: '😔', label: 'Off' },
  { emoji: '😤', label: 'Hot' },
] as const
const MOOD_DAY_LETTERS = ['S', 'M', 'T', 'W', 'T', 'F', 'S'] as const

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
  }, [a.email, a.token])

  useEffect(() => { load() }, [load])

  const today = localDateStr()
  const todayEntry = entries.find((e) => isoToLocalDate(e.createdAt) === today)
  const last = entries[0]

  useEffect(() => {
    if (todayEntry) setEnergy(todayEntry.energy)
    else if (last) setEnergy(last.energy)
  }, [todayEntry, last])

  async function logEmoji(emoji: string) {
    if (busy) return
    setBusy(true)
    try {
      await apiLogMood({ ...a, emoji, energy })
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
      await apiLogMood({ ...a, emoji: todayEntry.emoji, energy: n })
      load()
    } catch {
      setMsg('Could not log energy.')
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
    <div className="ma mood">
      <div className="ma-hero">
        <span className="ma-hero-kicker">{todayEntry ? 'Today' : 'Not logged'}</span>
        <span className="ma-hero-num">
          {todayEntry
            ? (MOOD_CHOICES.find((c) => c.emoji === todayEntry.emoji)?.label || todayEntry.emoji)
            : 'How do you feel'}
        </span>
        <span className="ma-hero-label">
          {streak > 0
            ? `${streak} day streak${avgEnergy ? `. Avg energy ${avgEnergy.toFixed(1)}` : ''}`
            : todayEntry
              ? `Energy ${todayEntry.energy}/5`
              : 'Tap a mood.'}
        </span>
      </div>

      <div className="mood-emoji-row">
        {MOOD_CHOICES.map((choice) => (
          <button
            key={choice.emoji}
            className={`mood-emoji-btn${todayEntry?.emoji === choice.emoji ? ' selected' : ''}`}
            type="button"
            disabled={busy}
            onClick={() => void logEmoji(choice.emoji)}
          >
            {choice.label}
          </button>
        ))}
      </div>

      <span className="ma-hero-kicker">Energy</span>
      <div className="mood-energy-row" aria-label="Energy">
        {[1, 2, 3, 4, 5].map((n) => (
          <button
            key={n}
            type="button"
            className={`ma-chip${energy === n ? ' ma-chip--on' : ''}`}
            disabled={busy}
            onClick={() => void pickEnergy(n)}
          >
            {n}
          </button>
        ))}
      </div>

      {msg && (
        <p className="mini__hint">
          {msg}{' '}
          <button className="ma-btn ma-btn--quiet" type="button" onClick={load}>Retry</button>
        </p>
      )}

      <div className="mood-strip">
        {week.map((d) => {
          const [y, m, day] = d.split('-').map(Number)
          const letter = MOOD_DAY_LETTERS[new Date(y || 1970, (m || 1) - 1, day || 1).getDay()] || ''
          const hit = byDay.get(d)
          return (
            <div key={d} className={`mood-strip-day${d === today ? ' is-today' : ''}`}>
              <span className="mood-strip-emoji">{hit ? hit.emoji : '·'}</span>
              <span className="mood-strip-label">{letter}</span>
            </div>
          )
        })}
      </div>

      {entries.length > 0 && (
        <ul className="mood-list">
          {entries.slice(0, 14).map((e) => (
            <li key={e.id} className="mood-entry">
              <span className="mood-entry-emoji">{e.emoji}</span>
              <div className="mood-entry-info">
                <span className="mood-entry-time">{fmtWhen(e.createdAt)}</span>
                {e.note && <span className="mood-entry-note">{e.note}</span>}
              </div>
              <span className="mood-entry-energy">{e.energy}/5</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
