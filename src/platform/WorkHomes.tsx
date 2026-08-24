import { useCallback, useEffect, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import {
  apiHome,
  apiListDecisions,
  apiListLinear,
  apiListLoops,
  apiListPipeline,
  apiListWorkDrafts,
  apiStandupToday,
  apiNextStack,
  apiGetArtifact,
  apiKeepArtifact,
  apiTossArtifact,
  type Artifact,
  type Decision,
  type HomeSnapshot,
  type LinearIssue,
  type NextItem,
  type OpenLoop,
  type PipelineItem,
  type WorkDraft,
} from './api'
import { ActionButtons, ActionRow, runAction, snoozeAction } from './ActionQueue'
import type { FeatureAuth } from './FeatureMiniApps'
import { MiniAppIcon } from './MiniAppIcons'
import { remainingMeets } from './home'
import { CategoryDonut } from './SpendCharts'
import { useRefreshOnFocus } from './useRefreshOnFocus'

/** One tile in the 2x2 "Where you are" grid. The viz slot is optional so a tile
 * that is a pure count still sits on the same baseline as one with a bar. */
function Vital({
  to,
  label,
  value,
  sub,
  foot,
}: {
  to: string
  label: string
  value: string
  sub?: string
  foot?: string
}) {
  return (
    <li>
      <Link className="home-vital" to={to}>
        <span className="home-vital-label">{label}</span>
        <span className="home-vital-val">
          {value}
          {sub ? <i> {sub}</i> : null}
        </span>
        {foot ? <span className="home-vital-foot">{foot}</span> : null}
      </Link>
    </li>
  )
}

/** Shared queue state: rungs come from /api/work/next, verbs from ActionQueue. */
function useWorkQueue(auth: FeatureAuth, reload: () => void) {
  const [items, setItems] = useState<NextItem[]>([])
  const [busy, setBusy] = useState(false)
  const [doneId, setDoneId] = useState<string | null>(null)
  const [snoozed, setSnoozed] = useState<string[]>([])
  const [actMsg, setActMsg] = useState('')

  const fetchQueue = useCallback(() => {
    apiNextStack({ email: auth.email, token: auth.token, persona: auth.persona })
      .then((d) => setItems(d.items || []))
      .catch(() => setItems([]))
  }, [auth.email, auth.token, auth.persona])

  useEffect(() => {
    fetchQueue()
  }, [fetchQueue])

  const queue = snoozed.length
    ? [...items.filter((i) => !snoozed.includes(i.id)), ...items.filter((i) => snoozed.includes(i.id))]
    : items

  async function doQueue(item: NextItem) {
    if (busy) return
    setBusy(true)
    setActMsg('')
    try {
      await runAction(item, { email: auth.email, token: auth.token, persona: auth.persona })
      setDoneId(item.id)
      fetchQueue()
      reload()
    } catch (err) {
      setActMsg(err instanceof Error ? err.message : 'Could not do that.')
    } finally {
      setBusy(false)
    }
  }

  async function snoozeQueue(item: NextItem) {
    try {
      const how = await snoozeAction(item, { email: auth.email, token: auth.token, persona: auth.persona })
      if (how === 'reload') {
        fetchQueue()
        reload()
      } else {
        setSnoozed((cur) => (cur.includes(item.id) ? cur : [...cur, item.id]))
      }
    } catch {
      setActMsg('Could not snooze that.')
    }
  }

  return { queue, busy, doneId, actMsg, doQueue, snoozeQueue }
}

/** Day header + lead card + queue + today + people-due, shared by both homes. */
function WorkTop({
  auth,
  snap,
  suffix,
  queue,
  busy,
  doneId,
  actMsg,
  doQueue,
  snoozeQueue,
}: {
  auth: FeatureAuth
  snap: HomeSnapshot | null
  suffix: string
  queue: NextItem[]
  busy: boolean
  doneId: string | null
  actMsg: string
  doQueue: (i: NextItem) => void
  snoozeQueue: (i: NextItem) => void
}) {
  const miniLink = (kind: string) => `/app/mini/${auth.persona}/${kind}${suffix}`
  const raw = snap?.home
  const dateLabel =
    raw?.dateLabel || new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' })
  const upcoming = remainingMeets(raw?.upcoming || [])
  const peopleDue = raw?.peopleDue || []
  const mailCount = (raw?.mailGroups || []).length
    ? (raw?.mailGroups || []).reduce((a, g) => a + g.count, 0)
    : (raw?.mail || []).length

  const stateBits: string[] = []
  if (upcoming.length) stateBits.push(`${upcoming.length} left today`)
  if (peopleDue.length) stateBits.push(`${peopleDue.length} ${peopleDue.length === 1 ? 'person' : 'people'} due`)
  if (mailCount) stateBits.push(`${mailCount} in mail`)
  const stateLine = stateBits.join('   ')

  const lead = queue[0]
  const queued = queue.slice(1)

  return (
    <>
      <header className="home-day">
        <span className="home-day-kicker">Today</span>
        <h2 className="home-day-title">{dateLabel || 'Today'}</h2>
        {stateLine ? <p className="home-day-state">{stateLine}</p> : null}
      </header>

      {lead && (
        <section className={`home-action${lead.hot ? ' home-action--hot' : ''}`}>
          <span className="home-action-kicker">{lead.kicker}</span>
          <h3 className="home-action-title">{lead.title}</h3>
          {lead.hint ? <p className="home-action-hint">{lead.hint}</p> : null}
          <div className="home-action-row">
            <ActionButtons
              item={lead}
              persona={auth.persona}
              suffix={suffix}
              busy={busy}
              done={doneId === lead.id}
              btnClass="home-action-btn"
              chipClass="home-action-chip"
              onDo={doQueue}
              onSnooze={snoozeQueue}
            />
          </div>
        </section>
      )}

      {queued.length > 0 && (
        <ul className="ma-list home-queue">
          {queued.map((item) => (
            <ActionRow
              key={item.id}
              item={item}
              persona={auth.persona}
              suffix={suffix}
              busy={busy}
              done={doneId === item.id}
              onDo={doQueue}
            />
          ))}
        </ul>
      )}
      {actMsg && <p className="mini__hint home-msg">{actMsg}</p>}

      {upcoming.length > 0 && (
        <section className="home-block">
          <h3 className="home-section-title">Today</h3>
          <ul className="home-plain-list">
            {upcoming.map((e, i) => (
              <li key={`${e.time}-${e.title}-${i}`}>
                <span className="home-plain-time">{e.time}</span>
                <span>{e.title}</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {peopleDue.length > 0 && (
        <section className="home-block">
          <h3 className="home-section-title">People due</h3>
          <ul className="home-plain-list">
            {peopleDue.map((p) => (
              <li key={p.name}>
                <Link className="home-plain-link" to={miniLink('networking_crm')}>
                  <span>{p.name}</span>
                  <span className="home-plain-meta">{p.days >= 900 ? 'No touch yet' : `${p.days} days`}</span>
                </Link>
                {p.phone ? (
                  <a className="home-plain-sms" href={`sms:${p.phone.replace(/[^\d+]/g, '')}`}>
                    Text
                  </a>
                ) : null}
              </li>
            ))}
          </ul>
        </section>
      )}
    </>
  )
}

function Dock({ auth, suffix, items }: { auth: FeatureAuth; suffix: string; items: Array<{ kind: string; label: string }> }) {
  return (
    <nav className="home-dock" aria-label="Quick travel">
      {items.map((d) => (
        <Link key={d.label} className="home-dock-btn" to={`/app/mini/${auth.persona}/${d.kind}${suffix}`}>
          <span className="home-dock-icon" aria-hidden="true">
            <MiniAppIcon kind={d.kind} />
          </span>
          <span>{d.label}</span>
        </Link>
      ))}
    </nav>
  )
}

function useHomeSnap(auth: FeatureAuth) {
  const [snap, setSnap] = useState<HomeSnapshot | null>(null)
  const [loading, setLoading] = useState(true)
  const load = useCallback(() => {
    setLoading(true)
    apiHome({ email: auth.email, token: auth.token })
      .then(setSnap)
      .catch(() => setSnap(null))
      .finally(() => setLoading(false))
  }, [auth.email, auth.token])
  useEffect(() => {
    load()
  }, [load])
  return { snap, loading, load }
}

/* The dock mirrors friend's shape: the surfaces you travel to, not the screen
 * you are on. 'Now' died with the next_move app — the lead card at the top of
 * this home IS now — so People took the slot. */
const COWORKER_DOCK = [
  { kind: 'digest', label: 'Brief' },
  { kind: 'linear_triage', label: 'Issues' },
  { kind: 'networking_crm', label: 'People' },
  { kind: 'later', label: 'Later' },
]

const COFOUNDER_DOCK = [
  { kind: 'digest', label: 'Brief' },
  { kind: 'pipeline_board', label: 'Pipeline' },
  { kind: 'decision_ledger', label: 'Decide' },
  { kind: 'networking_crm', label: 'People' },
]

export function CoworkerHomeApp({ auth }: { auth: FeatureAuth }) {
  const [searchParams] = useSearchParams()
  const suffix = searchParams.toString() ? `?${searchParams.toString()}` : ''
  const miniLink = (kind: string) => `/app/mini/${auth.persona}/${kind}${suffix}`
  const { snap, loading, load } = useHomeSnap(auth)
  const q = useWorkQueue(auth, load)
  useRefreshOnFocus(load)

  const [drafts, setDrafts] = useState<WorkDraft[]>([])
  const [loops, setLoops] = useState<OpenLoop[]>([])
  const [issues, setIssues] = useState<LinearIssue[]>([])
  const [standup, setStandup] = useState<string | null>(null)

  const reloadTiles = useCallback(() => {
    apiListWorkDrafts({ email: auth.email, token: auth.token, persona: auth.persona })
      .then((d) => setDrafts((d.drafts || []).filter((x) => x.status === 'pending')))
      .catch(() => {})
    apiListLoops({ email: auth.email, token: auth.token })
      .then((d) => setLoops(d.loops || []))
      .catch(() => {})
    apiListLinear({ email: auth.email, token: auth.token, persona: auth.persona })
      .then((d) => setIssues(d.issues || []))
      .catch(() => {})
    apiStandupToday({ email: auth.email, token: auth.token })
      .then((d) => setStandup(d.today || null))
      .catch(() => {})
  }, [auth.email, auth.token, auth.persona])

  useEffect(() => {
    reloadTiles()
  }, [reloadTiles])
  useRefreshOnFocus(reloadTiles)

  if (loading && !snap) {
    return (
      <div className="home-screen home-screen--loading">
        <div className="home-day-kicker home-shimmer">Loading today</div>
        <div className="home-action home-action--skeleton" />
      </div>
    )
  }

  const mailGroups = snap?.home?.mailGroups || []
  const mailCount = mailGroups.length ? mailGroups.reduce((a, g) => a + g.count, 0) : (snap?.home?.mail || []).length
  const openLoops = loops.filter((l) => l.status === 'open')
  const now = Date.now()
  const dueToday = openLoops.filter((l) => l.dueAt && new Date(l.dueAt).getTime() <= now + 12 * 3600_000).length
  const closedIssues = issues.filter((i) => /done|canceled|closed/i.test(i.state || '')).length

  return (
    <div className="home-screen">
      <WorkTop auth={auth} snap={snap} suffix={suffix} {...q} />

      <section className="home-block" aria-label="Where you are">
        <h3 className="home-section-title">Where you are</h3>
        <ul className="home-vitals">
          <Vital to={miniLink('digest')} label="Inbox" value={`${mailCount}`} foot={mailGroups[0] ? `${mailGroups[0].label} top` : 'in mail'} />
          {drafts.length > 0 && (
            <Vital to={miniLink('approve_send')} label="Drafts" value={`${drafts.length}`} foot="ready to send" />
          )}
          {loops.length > 0 && (
            <Vital to={miniLink('open_loops')} label="Promises" value={`${openLoops.length} of ${loops.length}`} foot={dueToday ? `${dueToday} due today` : 'open'} />
          )}
          {issues.length > 0 && (
            <Vital to={miniLink('linear_triage')} label="Issues" value={`${issues.length}`} foot={closedIssues ? `${closedIssues} closed` : 'assigned'} />
          )}
          <Vital to={miniLink('standup_paste')} label="Standup" value={standup ? 'In' : 'Not yet'} foot={standup ? 'posted today' : 'paste your notes'} />
        </ul>
      </section>

      {mailGroups.length > 0 && (
        <section className="home-block">
          <h3 className="home-section-title">What the inbox is</h3>
          <CategoryDonut
            rows={mailGroups.map((g) => ({ label: g.label, value: g.count }))}
            center={`${mailCount}`}
            centerLabel="in mail"
          />
        </section>
      )}

      <Dock auth={auth} suffix={suffix} items={COWORKER_DOCK} />
    </div>
  )
}

export function CofounderHomeApp({ auth }: { auth: FeatureAuth }) {
  const [searchParams] = useSearchParams()
  const suffix = searchParams.toString() ? `?${searchParams.toString()}` : ''
  const miniLink = (kind: string) => `/app/mini/${auth.persona}/${kind}${suffix}`
  const { snap, loading, load } = useHomeSnap(auth)
  const q = useWorkQueue(auth, load)
  useRefreshOnFocus(load)

  const [pipeline, setPipeline] = useState<PipelineItem[]>([])
  const [decisions, setDecisions] = useState<Decision[]>([])
  const [loops, setLoops] = useState<OpenLoop[]>([])
  const [runway] = useState<string | null>(null)

  const reloadTiles = useCallback(() => {
    apiListPipeline({ email: auth.email, token: auth.token })
      .then((d) => setPipeline(d.items || []))
      .catch(() => {})
    apiListDecisions({ email: auth.email, token: auth.token })
      .then((d) => setDecisions(d.decisions || []))
      .catch(() => {})
    apiListLoops({ email: auth.email, token: auth.token })
      .then((d) => setLoops(d.loops || []))
      .catch(() => {})
  }, [auth.email, auth.token, auth.persona])

  useEffect(() => {
    reloadTiles()
  }, [reloadTiles])
  useRefreshOnFocus(reloadTiles)

  /* Real runway comes from the weekly snapshot in /api/home; the persona context
   * is the fallback for an older API that has no snapshots yet. */
  const snapRunway = snap?.home?.runway
  const runwayFromSnap = snapRunway ? `${Math.round(snapRunway.months)}` : null

  if (loading && !snap) {
    return (
      <div className="home-screen home-screen--loading">
        <div className="home-day-kicker home-shimmer">Loading today</div>
        <div className="home-action home-action--skeleton" />
      </div>
    )
  }

  const live = pipeline.filter((p) => p.stage !== 'won' && p.stage !== 'lost')
  const byStage = new Map<string, number>()
  for (const p of live) {
    byStage.set(p.stage, (byStage.get(p.stage) || 0) + (p.value > 0 ? p.value : 1))
  }
  // When a row has no value recorded, weight it as one unit so the donut still
  // shows the split — the label below keeps the raw count honest.
  const stageRows = [...byStage.entries()].map(([label, value]) => ({ label, value }))
  const liveValue = live.reduce((s, p) => s + (p.value > 0 ? p.value : 0), 0)

  const openDec = decisions.filter((d) => d.outcome === null)
  const oldestSat = openDec.reduce((max, d) => {
    const days = Math.floor((Date.now() - new Date(d.createdAt).getTime()) / 86400000)
    return Math.max(max, days)
  }, 0)
  const openLoops = loops.filter((l) => l.status === 'open')
  const now = Date.now()
  const dueToday = openLoops.filter((l) => l.dueAt && new Date(l.dueAt).getTime() <= now + 12 * 3600_000).length

  return (
    <div className="home-screen">
      <WorkTop auth={auth} snap={snap} suffix={suffix} {...q} />

      <section className="home-block" aria-label="Where you are">
        <h3 className="home-section-title">Where you are</h3>
        <ul className="home-vitals">
          <Vital to={miniLink('spending_snapshot')} label="Runway" value={runwayFromSnap || runway || '—'} sub={runwayFromSnap || runway ? 'mo' : undefined} foot={runwayFromSnap || runway ? 'cash left' : 'not tracked'} />
          <Vital to={miniLink('pipeline_board')} label="Pipeline" value={liveValue > 0 ? `$${(liveValue / 1000).toFixed(0)}k` : `${live.length}`} foot={liveValue > 0 ? `${live.length} live deals` : 'live deals'} />
          <Vital to={miniLink('decision_ledger')} label="Decisions" value={`${openDec.length} of ${decisions.length}`} foot={oldestSat ? `${oldestSat} sat` : 'open'} />
          <Vital to={miniLink('open_loops')} label="Promises" value={`${openLoops.length} of ${loops.length}`} foot={dueToday ? `${dueToday} due today` : 'open'} />
        </ul>
      </section>

      {stageRows.length > 0 && (
        <section className="home-block">
          <h3 className="home-section-title">Pipeline by stage</h3>
          <CategoryDonut rows={stageRows} center={liveValue > 0 ? `$${(liveValue / 1000).toFixed(0)}k` : `${live.length}`} centerLabel={liveValue > 0 ? 'live value' : 'live'} />
        </section>
      )}

      <Dock auth={auth} suffix={suffix} items={COFOUNDER_DOCK} />
    </div>
  )
}

/* ---- Workshop artifact viewer: the built thing, with keep-or-toss ---- */
export function ArtifactApp({ auth, id }: { auth: FeatureAuth; id?: string }) {
  const [artifact, setArtifact] = useState<Artifact | null>(null)
  const [loading, setLoading] = useState(true)
  const [msg, setMsg] = useState('')
  const [gone, setGone] = useState(false)

  const load = useCallback(() => {
    if (!id) {
      setLoading(false)
      setGone(true)
      return
    }
    setLoading(true)
    apiGetArtifact({ email: auth.email, token: auth.token, id })
      .then((d) => setArtifact({ ...d, id } as Artifact))
      .catch(() => setGone(true))
      .finally(() => setLoading(false))
  }, [auth.email, auth.token, id])

  useEffect(() => {
    load()
  }, [load])

  async function act(kind: 'keep' | 'toss') {
    if (!id) return
    try {
      if (kind === 'keep') await apiKeepArtifact({ email: auth.email, token: auth.token, id })
      else await apiTossArtifact({ email: auth.email, token: auth.token, id })
      if (kind === 'toss') setGone(true)
      else setArtifact((cur) => (cur ? { ...cur, state: 'kept', expiresAt: null } : cur))
      setMsg(kind === 'keep' ? 'Kept — this stays for good.' : 'Tossed — deleted.')
    } catch (err) {
      setMsg(err instanceof Error ? err.message : 'Could not do that.')
    }
  }

  if (loading) {
    return (
      <div className="ma">
        <p className="mini__empty">Loading…</p>
      </div>
    )
  }

  if (gone || !artifact) {
    return (
      <div className="ma">
        <p className="mini__empty">This build is gone. Ask Alpha to build it again.</p>
      </div>
    )
  }

  const htmlFile = artifact.files.find((f) => /\.html?$/i.test(f))
  const previewUrl = htmlFile ? `/a/${artifact.id}/${htmlFile}${auth.token ? `?t=${encodeURIComponent(auth.token)}` : ''}` : ''

  return (
    <div className="ma">
      <div className="ma-hero">
        <span className="ma-hero-kicker">{artifact.state === 'kept' ? 'Kept' : 'Built for you'}</span>
        <span className="ma-hero-num">{artifact.title}</span>
        <span className="ma-hero-label">
          {artifact.state === 'kept'
            ? 'Saved for good.'
            : artifact.expiresAt
              ? `Auto-deletes ${new Date(artifact.expiresAt).toLocaleDateString([], { month: 'short', day: 'numeric' })} unless you keep it.`
              : ''}
        </span>
      </div>

      {previewUrl && (
        <iframe
          title={artifact.title}
          src={previewUrl}
          className="artifact-frame"
          sandbox="allow-scripts"
        />
      )}

      <div className="ma-callout-actions">
        <a className="ma-btn" href={previewUrl} target="_blank" rel="noreferrer">Open full page</a>
        {artifact.state !== 'kept' && (
          <button className="ma-chip" type="button" onClick={() => void act('keep')}>Keep it</button>
        )}
        <button className="ma-chip ma-chip--danger" type="button" onClick={() => void act('toss')}>Toss it</button>
      </div>
      {msg && <p className="mini__hint">{msg}</p>}
    </div>
  )
}
