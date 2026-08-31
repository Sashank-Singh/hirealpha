import { useCallback, useEffect, useMemo, useState } from 'react'
import { MENU_FEATURES } from './miniAppCatalog'
import { Link, useSearchParams } from 'react-router-dom'
import {
  apiListNetwork,
  apiListSleep,
  apiHome,
  type HomeSnapshot,
  type NetworkPerson,
  type NetworkToday,
  type NextItem,
  type SleepNight,
} from './api'
import { ActionButtons, ActionRow } from './ActionQueue'
import { runAction, snoozeAction } from './actionRunner'
import type { FeatureAuth } from './FeatureMiniApps'
import { MiniAppIcon } from './MiniAppIcons'
import {
  dayStamp,
  duePeopleFrom,
  homeFetchPlan,
  localYmd,
  mergeMeets,
  pickHomeQueue,
  pickLastNight,
  remainingMeets,
  shiftYmd,
} from './home'
import { readHomeCache, writeHomeCache } from './homeCache'
import { useRefreshOnFocus } from './useRefreshOnFocus'
import { isPersonMeetSuggestion } from './peopleMeets'
import { SpendDonut } from './SpendCharts'
import { aggregateSpend } from './spendChart'

/** The sparkline scales against this, and 8h is the hairline it compares to. */
const SLEEP_TARGET_H = 8
const SLEEP_SCALE_H = 10

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

function formatClock12(hhmm: string) {
  const [hRaw, mRaw] = hhmm.split(':')
  const h = Number(hRaw)
  const m = Number(mRaw)
  if (!Number.isFinite(h) || !Number.isFinite(m)) return hhmm
  const am = h < 12
  const h12 = h % 12 || 12
  return `${h12}:${String(m).padStart(2, '0')} ${am ? 'AM' : 'PM'}`
}

const DOCK = [
  { kind: 'body', iconKind: 'body', label: 'Body' },
  { kind: 'digest', iconKind: 'digest', label: 'Brief' },
  { kind: 'networking_crm', iconKind: 'networking_crm', label: 'People' },
  { kind: 'later', iconKind: 'later', label: 'Later' },
] as const

export function HomeApp({ auth }: { auth: FeatureAuth }) {
  const [searchParams] = useSearchParams()
  const q = searchParams.toString()
  const suffix = q ? `?${q}` : ''
  const miniLink = (kind: string, persona?: string) =>
    `/app/mini/${persona || auth.persona}/${kind}${suffix}`

  /* Who this device's cached snapshot belongs to. Held stable so it can sit in a
   * dependency list without re-running everything on each render. */
  const who = useMemo(
    () => ({ email: auth.email, token: auth.token, persona: auth.persona }),
    [auth.email, auth.token, auth.persona],
  )

  /* Paint today's last answer immediately if this device has one, so reopening
   * home is instant and the network only ever refreshes what is already there.
   * Yesterday's copy is refused by the cache, not by this. */
  const [snap, setSnap] = useState<HomeSnapshot | null>(() =>
    readHomeCache<HomeSnapshot>(who, localYmd(), Date.now()),
  )
  const [nights, setNights] = useState<SleepNight[]>([])
  const [people, setPeople] = useState<NetworkPerson[]>([])
  const [todayMeets, setTodayMeets] = useState<NetworkToday[]>([])
  const [loading, setLoading] = useState(true)
  const [msg, setMsg] = useState('')
  const [worldTries, setWorldTries] = useState(0)
  /* Acting on a rung: which one is mid-flight, which one just landed, and which
   * ones were pushed to the back. Snoozed ids reorder the derived queue rather
   * than mutating it, so the next snapshot rebuilds cleanly. */
  const [busy, setBusy] = useState(false)
  const [doneId, setDoneId] = useState<string | null>(null)
  const [snoozed, setSnoozed] = useState<string[]>([])
  const [actMsg, setActMsg] = useState('')
  const [showOthers, setShowOthers] = useState(false)

  const load = useCallback(() => {
    setLoading(true)
    setWorldTries(0)
    /* One request paints the screen. The other two are fallbacks for fields the
     * snapshot usually carries, so they are asked for only when it came back
     * without them — /api/network took 1.3–2.7 s and its calendar half reads the
     * same cache /api/home does, so on a normal open it cost the page seconds to
     * confirm what home already said. Waiting for home before deciding costs the
     * fallback path one round trip and the common path nothing. */
    apiHome({ email: auth.email, token: auth.token })
      .then((d) => {
        setSnap(d)
        setMsg('')
        writeHomeCache(who, d, localYmd(), Date.now())
        return d as HomeSnapshot | null
      })
      .catch(() => {
        setMsg('Could not load home.')
        return null
      })
      .then((d) => {
        const plan = homeFetchPlan(d)
        if (plan.sleep) {
          apiListSleep({ email: auth.email, token: auth.token })
            .then((sleep) => setNights(sleep.nights || []))
            .catch(() => {})
        }
        if (plan.people) {
          apiListNetwork({ email: auth.email, token: auth.token, persona: auth.persona })
            .then((net) => {
              setPeople(net.people || [])
              setTodayMeets(net.today || [])
            })
            .catch(() => {})
        }
      })
      .finally(() => setLoading(false))
  }, [auth.email, auth.token, auth.persona, who])

  useEffect(() => {
    load()
  }, [load])
  useRefreshOnFocus(load)

  /* The page painted before the calendar and inbox came back — the server says
   * so rather than making everyone wait on a hop into Google. Come back for them
   * quietly, a couple of times at most, and leave the screen as it is if they
   * never arrive. */
  useEffect(() => {
    if (!snap?.worldPending || worldTries >= 3) return
    const timer = setTimeout(() => {
      setWorldTries((n) => n + 1)
      apiHome({ email: auth.email, token: auth.token })
        .then((d) => {
          setSnap(d)
          writeHomeCache(who, d, localYmd(), Date.now())
        })
        .catch(() => {})
    }, 1800)
    return () => clearTimeout(timer)
  }, [snap?.worldPending, worldTries, auth.email, auth.token, who])

  if (loading && !snap) {
    return (
      <div className="home-screen home-screen--loading">
        <div className="home-day-kicker home-shimmer">Loading today</div>
        <div className="home-action home-action--skeleton" />
      </div>
    )
  }

  const raw = snap?.home
  const today = localYmd()
  const fromSleep = pickLastNight(nights, today)
  const yest = shiftYmd(today, -1)
  const fromTrend = (snap?.sleepTrend || []).find((n) => {
    const d = dayStamp(n.date)
    return (d === today || d === yest) && n.hours > 0
  })
  const lastNight = fromSleep.logged
    ? fromSleep
    : raw?.lastNight?.logged
      ? raw.lastNight
      : fromTrend
        ? { logged: true, hours: fromTrend.hours, bedtime: undefined as string | undefined, wake: undefined as string | undefined }
        : { logged: false, hours: 0 }
  const upcoming = remainingMeets(
    mergeMeets(
      raw?.upcoming || [],
      todayMeets.map((m) => ({ time: m.time, title: m.who || m.title })),
    ).filter((e) => isPersonMeetSuggestion({ time: e.time, title: e.title, who: e.title })),
  )
  const peopleDue =
    raw?.peopleDue && raw.peopleDue.length > 0 ? raw.peopleDue : duePeopleFrom(people)
  const hour = typeof raw?.hour === 'number' ? raw.hour : new Date().getHours()
  const dateLabel =
    raw?.dateLabel ||
    new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' })
  const workout = raw?.workout || { name: 'Today', rest: true, done: false }
  const mail = raw?.mail || []
  const mailGroups = raw?.mailGroups || []
  // The groups already cover the same mail, so counting both would double it.
  const mailCount = mailGroups.length
    ? mailGroups.reduce((a, g) => a + g.count, 0)
    : mail.length

  const w = snap?.window
  const protein = w?.proteinToday || 0
  const proteinGoal = w?.proteinGoal || 150
  const spend = w?.spend || 0
  const budget = w?.weeklyBudget || 0
  const ranked = pickHomeQueue({
    hour,
    lastNightLogged: lastNight.logged,
    lastNightHours: lastNight.hours,
    next: upcoming[0],
    peopleDue,
    dueLoop: raw?.dueLoop,
    proteinToday: protein,
    proteinGoal,
    spend,
    weeklyBudget: budget,
    workoutToday: workout,
  })
  // Snoozed rungs sink instead of vanishing — nothing here is dismissible, only
  // deferrable, and a promise you pushed is still a promise.
  const queue = snoozed.length
    ? [...ranked.filter((i) => !snoozed.includes(i.id)), ...ranked.filter((i) => snoozed.includes(i.id))]
    : ranked
  const lead = queue[0]!
  const queued = queue.slice(1)

  async function doQueue(item: NextItem) {
    if (busy) return
    setBusy(true)
    setActMsg('')
    try {
      await runAction(item, { email: auth.email, token: auth.token, persona: auth.persona })
      setDoneId(item.id)
      // The rung is gone from the source of truth now, so re-read it: the row
      // leaves and the counts in the header move with it.
      load()
    } catch (err) {
      setActMsg(err instanceof Error ? err.message : 'Could not do that.')
    } finally {
      setBusy(false)
    }
  }

  async function snoozeQueue(item: NextItem) {
    try {
      const how = await snoozeAction(item, { email: auth.email, token: auth.token, persona: auth.persona })
      if (how === 'reload') load()
      else setSnoozed((cur) => (cur.includes(item.id) ? cur : [...cur, item.id]))
    } catch {
      setActMsg('Could not snooze that.')
    }
  }

  const briefKind = hour >= 18 ? 'pick_night' : 'digest'
  const sleepWeek = (snap?.sleepTrend || []).slice(-7)
  const dock = DOCK.map((d) => (d.kind === 'digest' ? { ...d, kind: briefKind } : d))

  /* The bed-to-wake window is the one thing the "7.2h" value cannot say on its
   * own, so it earns the tile's foot line. Restating the target there instead
   * would be the same fact twice — the hairline behind the bars is the target. */
  const sleepFoot =
    lastNight.logged && lastNight.bedtime && lastNight.wake
      ? `${formatClock12(lastNight.bedtime)} to ${formatClock12(lastNight.wake)}`
      : ''
  // The action card already leads with the next meeting, and the Today list
  // repeats it a third time. The header counts what is left instead.
  const stateBits: string[] = []
  if (upcoming.length) stateBits.push(`${upcoming.length} left today`)
  if (peopleDue.length) stateBits.push(`${peopleDue.length} ${peopleDue.length === 1 ? 'person' : 'people'} due`)
  if (mailCount) stateBits.push(`${mailCount} in mail`)
  const stateLine = stateBits.join('   ')
  const spendParts = aggregateSpend(snap?.spendByCategory || []).parts

  return (
    <div className="home-screen">
      <header className="home-day">
        <span className="home-day-kicker">Today</span>
        <h2 className="home-day-title">{dateLabel || 'Today'}</h2>
        {stateLine ? <p className="home-day-state">{stateLine}</p> : null}
      </header>

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
            onDo={(i) => void doQueue(i)}
            onSnooze={(i) => void snoozeQueue(i)}
          />
        </div>
      </section>

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
              onDo={(i) => void doQueue(i)}
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

      {/* Mail lives in the brief now; Home keeps the count chip only. */}

      {/* Both ride the home payload and are absent until the server ships them,
        * so this strip renders nothing and today's screen stays as it was. */}
      {(snap?.meetings?.length || snap?.attention) && (
        <section className="home-block home-block--now">
          {snap?.meetings && snap.meetings.length > 0 && (
            <div className="home-meets" aria-label="Up next">
              {snap.meetings.slice(0, 3).map((m, i) => (
                <span
                  key={`${m.time}-${m.title}-${i}`}
                  className={i === 0 && m.startsInMin != null && m.startsInMin <= 60 ? 'home-meet home-meet--soon' : 'home-meet'}
                >
                  <b>{m.time}</b> {m.title}
                </span>
              ))}
            </div>
          )}
          {snap?.attention && (
            <Link className="home-attention" to={miniLink(briefKind)}>
              1 in mail needs you · {snap.attention.why} · {snap.attention.label}
            </Link>
          )}
        </section>
      )}

      <section className="home-block" aria-label="Where you are">
        <h3 className="home-section-title">Where you are</h3>
        <ul className="home-vitals">
          <li>
            <Link className="home-vital" to={miniLink('sleep_tracker')}>
              <span className="home-vital-label">Sleep</span>
              <span className="home-vital-val">
                {lastNight.logged ? <>{lastNight.hours}<i>h</i></> : 'Not logged'}
              </span>
              {/* The week the Nights section used to be, at the size a glance
                * needs. Scaled against the same 10h so a bar's height still
                * means the same thing it did in the chart. */}
              <span className="home-vital-viz">
                {sleepWeek.length > 0 ? (
                  <span className="home-spark">
                    <span
                      className="home-spark-ref"
                      style={{ bottom: `${(SLEEP_TARGET_H / SLEEP_SCALE_H) * 100}%` }}
                    />
                    {sleepWeek.map((n, i) => (
                      <span
                        key={n.date}
                        className={`home-spark-bar${i === sleepWeek.length - 1 ? ' home-spark-bar--today' : ''}`}
                        style={{ height: `${Math.min(100, (n.hours / SLEEP_SCALE_H) * 100)}%` }}
                        title={`${fmtDay(n.date)}  ${n.hours}h`}
                      />
                    ))}
                  </span>
                ) : null}
              </span>
              {sleepFoot ? <span className="home-vital-foot">{sleepFoot}</span> : null}
            </Link>
          </li>
          <li>
            <Link className="home-vital" to={miniLink('nutrition')}>
              <span className="home-vital-label">Food</span>
              <span className="home-vital-val">
                {Math.round(protein)}<i>g of {Math.round(proteinGoal)}</i>
              </span>
              <span className="home-vital-viz">
                {proteinGoal > 0 ? (
                  <span className="home-receipt-rule" aria-hidden="true">
                    <i style={{ width: `${Math.min(100, (protein / proteinGoal) * 100)}%` }} />
                  </span>
                ) : null}
              </span>
            </Link>
          </li>
          <li>
            <Link className="home-vital" to={miniLink('workout_log')}>
              <span className="home-vital-label">Training</span>
              <span className="home-vital-val">{workout.name}</span>
              {/* Logged or not is a state, not a ratio, so it takes the viz slot
                * as a word. Keeps every value on the same baseline. */}
              <span className="home-vital-viz">
                <span className="home-vital-state">{workout.done ? 'Logged' : 'Not logged'}</span>
              </span>
            </Link>
          </li>
          <li>
            <Link className="home-vital" to={miniLink('spending_snapshot')}>
              <span className="home-vital-label">Spend</span>
              <span className="home-vital-val">
                ${Math.round(spend)}
                {budget > 0 ? <i> of ${Math.round(budget)}</i> : null}
              </span>
              <span className="home-vital-viz">
                {budget > 0 ? (
                  <span
                    className={`home-receipt-rule${spend > budget ? ' home-receipt-rule--over' : ''}`}
                    aria-hidden="true"
                  >
                    <i style={{ width: `${Math.min(100, (spend / budget) * 100)}%` }} />
                  </span>
                ) : null}
              </span>
              {/* Over budget says so in words. The red rule alone would be the
                * only signal otherwise, and colour alone is not a signal. */}
              {budget > 0 && spend > budget ? (
                <span className="home-vital-foot home-vital-foot--over">
                  ${Math.round(spend - budget)} over
                </span>
              ) : null}
            </Link>
          </li>
        </ul>
      </section>

      {/* Total against the cap is the Spend tile's job now. What nothing else on
        * this screen shows is the split, so the section that follows it shows
        * only that. */}
      {spendParts.length > 0 && (
        <section className="home-block">
          <h3 className="home-section-title">This week&apos;s spend</h3>
          <SpendDonut rows={snap?.spendByCategory || []} centerLabel="this week" />
        </section>
      )}

      <button
        type="button"
        className="home-others-btn"
        onClick={() => setShowOthers((v) => !v)}
      >
        {showOthers ? 'Hide others' : 'Others'}
      </button>

      {showOthers && (
        <section className="home-block" aria-label="Other hires' apps">
          <h3 className="home-section-title">Others</h3>
          {(['coworker', 'cofounder'] as const).map((p) => (
            <div key={p} style={{ marginBottom: 12 }}>
              <p className="home-vital-label" style={{ marginBottom: 6 }}>
                {p === 'coworker' ? 'Alpha (Coworker)' : 'Alpha(CoFounder)'} · coming soon
              </p>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                {(MENU_FEATURES[p] ?? [])
                  .filter((f) => f.kind !== 'home')
                  .map((f) => (
                    <Link
                      key={`${p}-${f.kind}`}
                      className="home-others-chip"
                      to={miniLink(f.kind, p)}
                    >
                      {f.emoji} {f.title}
                    </Link>
                  ))}
              </div>
            </div>
          ))}
        </section>
      )}

      <nav className="home-dock" aria-label="Quick travel">
        {dock.map((d) => (
          <Link key={d.label} className="home-dock-btn" to={miniLink(d.kind)}>
            <span className="home-dock-icon" aria-hidden="true">
              <MiniAppIcon kind={d.iconKind} />
            </span>
            <span>{d.label}</span>
          </Link>
        ))}
      </nav>

      {msg && <p className="mini__hint home-msg">{msg}</p>}
    </div>
  )
}
