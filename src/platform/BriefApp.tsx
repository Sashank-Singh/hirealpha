import { useCallback, useEffect, useRef, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import {
  apiDraftMailReply,
  apiListNetwork,
  apiListSleep,
  apiListWorkDrafts,
  apiPatchLoop,
  apiPrepFor,
  apiReminderAction,
  apiTriageMail,
  apiToggleHabit,
  type MailTriageAction,
  type NetworkPerson,
  type NetworkToday,
  type ReplyDraft,
  type SleepNight,
} from './api'
import type { FeatureAuth } from './FeatureMiniApps'
import {
  firstName,
  isNoiseReminder,
  mailGroupHeading,
  mailReasonLabels,
  pickBriefAction,
  type BriefAsk,
  type BriefBeat,
  type BriefDo,
  type BriefFact,
  type BriefMailGroup,
  type BriefStory,
  type CarryOverItem,
  type EveningDayFact,
  type HabitToday,
  type NeedsYouItem,
} from './briefStory'
import { duePeopleFrom, localYmd, pickLastNight } from './home'
import { isPersonMeetSuggestion } from './peopleMeets'

export type BriefPayload = {
  date?: string
  brief?: 'morning' | 'evening'
  calendar?: string[]
  emails?: string[]
  emailItems?: BriefAsk[]
  mailGroups?: BriefMailGroup[]
  mailTally?: string
  needsYou?: NeedsYouItem[]
  factLine?: BriefFact[]
  /** The work personas' thread slice: Linear/PRs/drafts or pipeline/decisions/runway. */
  work?: Array<{ title: string; lines: string[] }> | { sections: Array<{ title: string; lines: string[] }> }
  reminders?: Array<{ id?: string; time?: string; text?: string }>
  tomorrow?: string[]
  story?: BriefStory
  /** Today's soonest meetings, soonest first. Optional until the server ships it. */
  meetings?: Array<{ time: string; title: string; startsInMin?: number }>
  /** The one email that needs a human now, or null. Optional until the server ships it. */
  attention?: { id: string; label: string; snippet?: string; why: string } | null
  error?: string
  /* Free-tier rationing served a stale-but-same-day payload on purpose. The
   * brief still paints (the data is real), but the UI shows a "refreshes used
   * up" line so the user knows to upgrade. */
  limited?: boolean
  used?: number
  limit?: number
}

/** The pick_night mini payload, routed through here so the evening gets the rich UI too. */
export type EveningPayload = {
  date?: string
  sections?: Array<{
    heading: string
    items: string[]
    emailMeta?: Array<{ id: string; snippet?: string }>
  }>
  mailGroups?: BriefMailGroup[]
  dayScore?: { points: number; verdict: string } | null
  dayFacts?: EveningDayFact[]
  habitsToday?: HabitToday[]
  carryOver?: CarryOverItem[]
  error?: string
  /* Free-tier rationing served a stale-but-same-day payload on purpose. */
  limited?: boolean
  used?: number
  limit?: number
}

type Creds = { email?: string; token?: string }

function senderName(from: string) {
  const name = from.replace(/<[^>]+>/, '').replace(/"/g, '').trim()
  return name.split(/[\s@]/)[0] || from
}

function mailBits(label: string) {
  const parts = String(label || '').split(' · ')
  if (parts.length > 1) {
    return { subject: parts.slice(0, -1).join(' · '), from: parts[parts.length - 1] || '' }
  }
  return { subject: label, from: senderName(label) }
}

function beatsFromToday(today: NetworkToday[]): BriefBeat[] {
  return today.filter(isPersonMeetSuggestion).map((e) => ({
    time: e.time,
    name: e.who || e.title,
    kind: e.kind || 'Meeting',
  }))
}

/** Minutes since midnight from a formatted clock like 10:00 AM. */
function beatMinutes(time: string): number {
  const m = String(time || '').match(/(\d{1,2}):(\d{2})\s*(AM|PM)?/i)
  if (!m) return -1
  let h = Number(m[1])
  const min = Number(m[2])
  const ap = (m[3] || '').toUpperCase()
  if (ap === 'PM' && h < 12) h += 12
  if (ap === 'AM' && h === 12) h = 0
  return h * 60 + min
}

function smsChatLink(body: string) {
  return `sms:?&body=${encodeURIComponent(body)}`
}

const FACT_STATE_MARK: Record<string, string> = { done: '✓', miss: '✗', partial: '◐', ok: '', gap: '' }

function FactStrip({ facts }: { facts: BriefFact[] }) {
  if (!facts.length) return null
  return (
    <div className="brief-facts">
      {facts.map((f) => {
        const inner = (
          <>
            <span className={`brief-fact-text brief-fact--${f.state}`}>{f.text}</span>
          </>
        )
        return f.openKind ? (
          <Link key={f.key} className="brief-fact" to={`?open=${f.openKind}`}>
            {inner}
          </Link>
        ) : (
          <span key={f.key} className="brief-fact">
            {inner}
          </span>
        )
      })}
    </div>
  )
}

/* The brief/prep build is a handful of slow reads — mail, calendar, meetings,
 * then a pass to rank what matters. While that runs, walk the user through the
 * steps so the wait reads as the assistant actually working: each step lights
 * up, ticks a check, and the sequence loops until the real data lands. People
 * who prefer reduced motion get the same list frozen — nothing marches. */
const BRIEF_ACTIVITY_STEPS = [
  "Pulling today's email",
  'Scanning your calendar',
  'Checking meetings',
  'Finding what matters',
  'Writing your brief',
]

function BriefActivity() {
  /* Read once at mount. The march is pure decoration, so when the user prefers
   * reduced motion we freeze on the first step and never advance the interval. */
  const reduceMotion = useRef(
    typeof window !== 'undefined' &&
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches,
  ).current
  const [current, setCurrent] = useState(0)
  useEffect(() => {
    if (reduceMotion) return
    const id = window.setInterval(() => {
      setCurrent((n) => (n + 1) % BRIEF_ACTIVITY_STEPS.length)
    }, 800)
    return () => window.clearInterval(id)
  }, [reduceMotion])
  return (
    <ul className="brief-activity">
      {BRIEF_ACTIVITY_STEPS.map((label, i) => {
        const done = i < current
        const isCurrent = i === current
        return (
          <li
            key={label}
            className={`brief-activity-step${isCurrent ? ' is-current' : ''}${done ? ' is-done' : ''}`}
          >
            <span className="brief-activity-mark" aria-hidden="true">
              {done ? '✓' : isCurrent ? <span className="brief-activity-dot" /> : null}
            </span>
            <span className="brief-activity-label">{label}</span>
          </li>
        )
      })}
    </ul>
  )
}

function PrepSheet({
  name,
  creds,
  onClose,
}: {
  name: string
  creds: Creds
  onClose: () => void
}) {
  const { email, token } = creds
  const [loading, setLoading] = useState(true)
  const [text, setText] = useState('')
  useEffect(() => {
    let cancelled = false
    apiPrepFor({ email, token, name })
      .then((r) => {
        if (!cancelled) setText(r.text || 'Nothing to prep yet. Text Alpha closer to the meeting.')
      })
      .catch(() => {
        if (!cancelled) setText('Could not pull a prep right now. Text Alpha and it will read you in.')
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [name, email, token])
  return (
    <div className="brief-prep" role="dialog" aria-modal="true">
      <div className="brief-prep-card">
        <button className="brief-prep-close" type="button" aria-label="Close" onClick={onClose}>
          ×
        </button>
        <span className="brief-prep-kicker">Prep</span>
        <h3 className="brief-prep-title">{name}</h3>
        {loading ? (
          <BriefActivity />
        ) : (
          <>
            <p className="brief-prep-text">{text}</p>
            <a className="brief-prep-chat" href={smsChatLink(`prep me for ${name}`)}>
              Keep going in chat
            </a>
          </>
        )}
      </div>
    </div>
  )
}

function DoCard({
  card,
  creds,
  onOpenMailId,
  miniLink,
}: {
  card: BriefDo
  creds: Creds
  onOpenMailId: (id: string) => void
  miniLink: (kind: string) => string
}) {
  const [prepOpen, setPrepOpen] = useState(false)

  const body = (
    <>
      <span className="brief-do-kicker">{card.kicker}</span>
      <h3 className="brief-do-title">{card.title}</h3>
      <p className="brief-do-hint">{card.hint}</p>
      <span className="brief-do-btn">{card.cta}</span>
    </>
  )

  return (
    <>
      <section className="brief-do">
        {card.kind === 'prep' ? (
          <button className="brief-do-tap" type="button" onClick={() => setPrepOpen(true)}>
            {body}
          </button>
        ) : card.kind === 'mail' ? (
          <button className="brief-do-tap" type="button" onClick={() => onOpenMailId('')}>
            {body}
          </button>
        ) : (
          <Link className="brief-do-tap" to={card.kind === 'quiet' ? '/app/apps' : miniLink(card.openKind)}>
            {body}
          </Link>
        )}
      </section>
      {prepOpen && <PrepSheet name={card.prepName || card.title} creds={creds} onClose={() => setPrepOpen(false)} />}
    </>
  )
}

function ReasonChips({ reasons }: { reasons: string[] }) {
  const labels = mailReasonLabels(reasons)
  if (!labels.length) return null
  return (
    <span className="brief-ny-reasons">
      {labels.map((l) => (
        <span key={l} className="brief-ny-chip">
          {l}
        </span>
      ))}
    </span>
  )
}

function TriageActions({
  busy,
  onDone,
  onDraft,
  onSkip,
}: {
  busy: boolean
  onDone: () => void
  onDraft?: () => void
  onSkip: () => void
}) {
  return (
    <span className="brief-triage">
      <button className="brief-tap brief-tap--done" type="button" disabled={busy} onClick={(e) => { e.stopPropagation(); onDone() }}>
        Done
      </button>
      {onDraft && (
        <button className="brief-tap brief-tap--draft" type="button" disabled={busy} onClick={(e) => { e.stopPropagation(); onDraft() }}>
          Draft reply
        </button>
      )}
      <button className="brief-tap brief-tap--skip" type="button" disabled={busy} onClick={(e) => { e.stopPropagation(); onSkip() }}>
        Skip
      </button>
    </span>
  )
}

/** The create-draft response may omit the body until the server ships it, so a
 * draft opened for review falls back to the stored row to always show text. */
async function ensureDraftBody(
  a: { email?: string; token?: string },
  draft: ReplyDraft,
): Promise<ReplyDraft> {
  if (draft.body) return draft
  try {
    const d = await apiListWorkDrafts(a)
    const found = (d.drafts || []).find((x) => x.id === draft.id)
    if (found) return { ...draft, body: found.body || '' }
  } catch {
    /* keep the to/subject-only draft */
  }
  return draft
}

function NeedsYouRow({
  item,
  creds,
  onOpenMail,
  onOpenDraft,
  onGone,
  notify,
}: {
  item: NeedsYouItem
  creds: Creds
  onOpenMail: (id: string, label: string, snippet?: string) => void
  onOpenDraft: (id: string, label: string, snippet: string | undefined, draft: ReplyDraft) => void
  onGone: () => void
  notify: (msg: string) => void
}) {
  const [busy, setBusy] = useState(false)
  const bits = mailBits(item.label)
  const tappable = !!(item.id && !item.id.startsWith('text-'))

  const fail = (err: unknown) => {
    notify(err instanceof Error && err.message ? err.message : 'Could not reach Alpha just now')
  }

  return (
    <li className="brief-ny-row">
      <div
        className={tappable ? 'brief-ny-main brief-ask--tap' : 'brief-ny-main'}
        onClick={tappable ? () => onOpenMail(item.id, item.label, item.snippet) : undefined}
        role={tappable ? 'button' : undefined}
        tabIndex={tappable ? 0 : undefined}
        onKeyDown={(ev) => {
          if (tappable && (ev.key === 'Enter' || ev.key === ' ')) onOpenMail(item.id, item.label, item.snippet)
        }}
      >
        <span className="brief-ask-from">{bits.from}</span>
        <span className="brief-ask-label">{bits.subject}</span>
        {item.snippet ? <span className="brief-ask-snip">{item.snippet}</span> : null}
        <ReasonChips reasons={item.reasons} />
      </div>
      <TriageActions
        busy={busy}
        onDone={() => {
          onGone()
          apiTriageMail({ ...creds, id: item.id, action: 'done' as MailTriageAction }).catch(fail)
        }}
        onDraft={
          tappable
            ? () => {
                setBusy(true)
                apiDraftMailReply({ ...creds, id: item.id })
                  .then((res) =>
                    ensureDraftBody(creds, {
                      id: res.id,
                      toAddr: res.toAddr,
                      subject: res.subject,
                      body: res.body || '',
                    }),
                  )
                  .then((full) => {
                    notify('Reply draft ready')
                    onOpenDraft(item.id, item.label, item.snippet, full)
                  })
                  .catch((err) => {
                    setBusy(false)
                    fail(err)
                  })
              }
            : undefined
        }
        onSkip={() => {
          onGone()
          apiTriageMail({ ...creds, id: item.id, action: 'skip' as MailTriageAction }).catch(fail)
        }}
      />
    </li>
  )
}

function PileRow({
  e,
  creds,
  onOpenMail,
  onOpenDraft,
  notify,
}: {
  e: BriefAsk
  creds: Creds
  onOpenMail: (id: string, label: string, snippet?: string) => void
  onOpenDraft: (id: string, label: string, snippet: string | undefined, draft: ReplyDraft) => void
  notify: (msg: string) => void
}) {
  const [busy, setBusy] = useState(false)
  const [gone, setGone] = useState(false)
  const tappable = !!(e.id && !e.id.startsWith('text-'))
  const bits = mailBits(e.label)
  if (gone) return null

  const triage = (action: MailTriageAction) => {
    setBusy(true)
    if (action !== 'drafted') setGone(true)
    apiTriageMail({ ...creds, id: e.id, action })
      .catch((err) => {
        setGone(false)
        notify(err instanceof Error && err.message ? err.message : 'Could not reach Alpha just now')
      })
      .finally(() => setBusy(false))
  }

  return (
    <li className={tappable ? 'brief-pile-row brief-ask--tap' : 'brief-pile-row'}>
      <div
        onClick={tappable ? () => onOpenMail(e.id, e.label, e.snippet) : undefined}
        role={tappable ? 'button' : undefined}
        tabIndex={tappable ? 0 : undefined}
        onKeyDown={(ev) => {
          if (tappable && (ev.key === 'Enter' || ev.key === ' ')) onOpenMail(e.id, e.label, e.snippet)
        }}
      >
        <span className="brief-ask-from">{bits.from}</span>
        <span className="brief-ask-label">{bits.subject}</span>
        {e.snippet ? <span className="brief-ask-snip">{e.snippet}</span> : null}
      </div>
      <TriageActions
        busy={busy}
        onDone={() => triage('done')}
        onDraft={
          tappable
            ? () => {
                setBusy(true)
                apiDraftMailReply({ ...creds, id: e.id })
                  .then((res) =>
                    ensureDraftBody(creds, {
                      id: res.id,
                      toAddr: res.toAddr,
                      subject: res.subject,
                      body: res.body || '',
                    }),
                  )
                  .then((full) => {
                    notify('Reply draft ready')
                    onOpenDraft(e.id, e.label, e.snippet, full)
                  })
                  .catch((err) => {
                    notify(err instanceof Error && err.message ? err.message : 'Could not draft a reply')
                  })
                  .finally(() => setBusy(false))
              }
            : undefined
        }
        onSkip={() => triage('skip')}
      />
    </li>
  )
}

function ReminderRow({
  r,
  creds,
  onGone,
  notify,
}: {
  r: { id?: string; time?: string; text?: string }
  creds: Creds
  onGone: () => void
  notify: (msg: string) => void
}) {
  const [busy, setBusy] = useState(false)
  const act = async (action: 'done' | 'snooze') => {
    if (!r.id || busy) return
    setBusy(true)
    onGone()
    try {
      await apiReminderAction({ ...creds, id: r.id, action, hours: 1 })
      if (action === 'snooze') notify('Snoozed an hour')
    } catch (err) {
      notify(err instanceof Error && err.message ? err.message : 'Could not reach that reminder')
    }
  }
  return (
    <li className="brief-rem-row">
      <span className="brief-rem-time">{r.time}</span>
      <span className="brief-rem-text">{r.text}</span>
      <span className="brief-triage">
        <button className="brief-tap brief-tap--done" type="button" disabled={busy || !r.id} onClick={() => void act('done')}>
          Done
        </button>
        <button className="brief-tap" type="button" disabled={busy || !r.id} onClick={() => void act('snooze')}>
          Snooze
        </button>
      </span>
    </li>
  )
}

function DayClosed({
  facts,
  habits,
  creds,
  notify,
}: {
  facts: EveningDayFact[]
  habits: HabitToday[]
  creds: Creds
  notify: (msg: string) => void
}) {
  const [rows, setRows] = useState(habits)
  useEffect(() => setRows(habits), [habits])
  const toggle = async (h: HabitToday) => {
    const next = rows.map((x) => (x.id === h.id ? { ...x, done: !x.done } : x))
    setRows(next)
    try {
      await apiToggleHabit({ ...creds, habitId: h.id, date: localYmd() })
    } catch {
      setRows(rows)
      notify('Could not save that')
    }
  }
  return (
    <section className="brief-block">
      <h3 className="brief-label">The day, closed</h3>
      <ul className="brief-closed">
        {facts.map((f) => (
          <li key={f.key} className={`brief-closed-row brief-closed--${f.state}`}>
            <span className="brief-closed-mark">{FACT_STATE_MARK[f.state]}</span>
            <span className="brief-closed-label">{f.label}</span>
            {f.detail ? <span className="brief-closed-detail">{f.detail}</span> : null}
          </li>
        ))}
      </ul>
      {rows.length > 0 && (
        <div className="brief-habits">
          {rows.map((h) => (
            <button
              key={h.id}
              type="button"
              className={`brief-habit ${h.done ? 'brief-habit--done' : ''}`}
              onClick={() => void toggle(h)}
            >
              <span className="brief-habit-mark">{h.done ? '✓' : h.emoji || '·'}</span>
              {h.name}
            </button>
          ))}
        </div>
      )}
    </section>
  )
}

function CarryOver({
  items,
  creds,
  onGone,
  notify,
}: {
  items: CarryOverItem[]
  creds: Creds
  onGone: (id: string) => void
  notify: (msg: string) => void
}) {
  const [busy, setBusy] = useState('')
  const move = async (id: string, status: 'done' | 'open', pushTomorrow: boolean) => {
    if (busy) return
    setBusy(id)
    onGone(id)
    try {
      if (pushTomorrow) {
        const d = new Date()
        d.setDate(d.getDate() + 1)
        d.setHours(9, 0, 0, 0)
        await apiPatchLoop({ ...creds, id, status, dueAt: d.toISOString() })
      } else {
        await apiPatchLoop({ ...creds, id, status })
      }
    } catch (err) {
      notify(err instanceof Error && err.message ? err.message : 'Could not save that')
    } finally {
      setBusy('')
    }
  }
  return (
    <section className="brief-block">
      <h3 className="brief-label">Carry over</h3>
      <ul className="brief-carry">
        {items.map((c) => (
          <li key={c.id} className="brief-carry-row">
            <span className="brief-carry-title">{c.title}</span>
            {c.dueLabel ? <span className="brief-carry-due">due {c.dueLabel}</span> : null}
            <span className="brief-triage">
              <button
                className="brief-tap brief-tap--done"
                type="button"
                disabled={busy === c.id}
                onClick={() => void move(c.id, 'done', false)}
              >
                Done
              </button>
              <button
                className="brief-tap"
                type="button"
                disabled={busy === c.id}
                onClick={() => void move(c.id, 'open', true)}
              >
                Tomorrow
              </button>
            </span>
          </li>
        ))}
      </ul>
    </section>
  )
}

function Toast({ toast }: { toast: { msg: string } | null }) {
  if (!toast) return null
  return <div className="brief-toast">{toast.msg}</div>
}

export function BriefApp({
  auth,
  data,
  evening,
  onOpenMail,
  onOpenDraft,
  onRefresh,
}: {
  auth: FeatureAuth
  data: BriefPayload | null
  evening?: EveningPayload | null
  onOpenMail: (id: string, label: string, snippet?: string) => void
  onOpenDraft: (id: string, label: string, snippet: string | undefined, draft: ReplyDraft) => void
  onRefresh?: (opts?: { force?: boolean }) => Promise<void> | void
}) {
  const [searchParams] = useSearchParams()
  const q = searchParams.toString()
  const suffix = q ? `?${q}` : ''
  const miniLink = useCallback(
    (kind: string) => `/app/mini/${auth.persona}/${kind}${suffix}`,
    [auth.persona, suffix],
  )

  const [nights, setNights] = useState<SleepNight[]>([])
  const [people, setPeople] = useState<NetworkPerson[]>([])
  const [todayMeets, setTodayMeets] = useState<NetworkToday[]>([])
  const [needsYou, setNeedsYou] = useState<NeedsYouItem[]>([])
  const [reminders, setReminders] = useState<Array<{ id?: string; time?: string; text?: string }>>([])
  const [carry, setCarry] = useState<CarryOverItem[]>([])
  const [openPiles, setOpenPiles] = useState<Set<string>>(new Set())
  const [toast, setToast] = useState<{ msg: string } | null>(null)
  const [prepName, setPrepName] = useState<string | null>(null)
  /* A tiny "refresh again" affordance: the cached brief on this device can be
   * minutes old, and a manual refresh rebuilds it server-side and paints when
   * the response lands. The button stays nearly invisible until you look for it,
   * so the screen still reads like "this is the brief", not "this is a list of
   * buttons". */
  const [refreshing, setRefreshing] = useState(false)
  const [refreshedAt, setRefreshedAt] = useState<number | null>(null)
  const refreshTimer = useRef<number | null>(null)
  const toastTimer = useRef<number | null>(null)

  const notify = useCallback((msg: string) => {
    setToast({ msg })
    if (toastTimer.current) window.clearTimeout(toastTimer.current)
    toastTimer.current = window.setTimeout(() => setToast(null), 4000)
  }, [])

  /* Manual refresh: rebuild the brief against the live calendar/inbox/model. The
   * server already does the cache+retry dance, so this is "ask the server
   * again" — the held copy keeps painting until the fresh payload lands. The
   * "Updated just now" hint gives the action a verb so users know it did
   * something; it fades after a few seconds so it doesn't become UI furniture.
   *
   * `force: true` makes the parent skip the held-copy paint and bust the
   * browser cache: a user who taps refresh wants a real rebuild, not the
   * spinner running over the same data they had a second ago. */
  const handleRefresh = useCallback(() => {
    if (!onRefresh || refreshing) return
    setRefreshing(true)
    Promise.resolve(onRefresh({ force: true }))
      .catch(() => {})
      .finally(() => {
        setRefreshing(false)
        setRefreshedAt(Date.now())
        if (refreshTimer.current) window.clearTimeout(refreshTimer.current)
        refreshTimer.current = window.setTimeout(() => setRefreshedAt(null), 3500)
      })
  }, [onRefresh, refreshing])

  const creds = { email: auth.email, token: auth.token }
  const isEvening = !!evening || data?.brief === 'evening'

  useEffect(() => {
    const loadCreds = { email: auth.email, token: auth.token, persona: auth.persona }
    Promise.all([
      apiListSleep({ email: auth.email, token: auth.token }).catch(() => ({ nights: [] as SleepNight[] })),
      apiListNetwork(loadCreds).catch(() => ({ people: [] as NetworkPerson[], today: [] as NetworkToday[] })),
    ]).then(([sleep, net]) => {
      setNights(sleep.nights || [])
      setPeople(net.people || [])
      setTodayMeets(net.today || [])
    })
  }, [auth.email, auth.token, auth.persona])

  useEffect(() => {
    setNeedsYou(data?.story?.needsYou || data?.needsYou || [])
  }, [data])

  useEffect(() => {
    setReminders((data?.reminders || []).filter((r) => r.text && !isNoiseReminder(r.text)))
  }, [data])

  useEffect(() => {
    setCarry(evening?.carryOver || [])
  }, [evening])

  const story = data?.story
  const fromNet = beatsFromToday(todayMeets)
  const beats = (story?.beats && story.beats.length ? story.beats : fromNet)
  const facts: BriefFact[] = story?.factLine || data?.factLine || []
  const groups: BriefMailGroup[] = story?.mailGroups?.length
    ? story.mailGroups
    : data?.mailGroups?.length
      ? data.mailGroups
      : []
  // Morning gets piles from the digest payload; evening from pick_night.
  const mailPiles: BriefMailGroup[] = isEvening ? (evening?.mailGroups || []) : groups
  const work = Array.isArray(data?.work) ? data.work : data?.work?.sections || []
  const tally = story?.mailTally || data?.mailTally || ''
  const due = story?.due?.length ? story.due : duePeopleFrom(people)
  const lastNight = pickLastNight(nights, localYmd())
  const later = (story?.later?.length ? story.later : data?.tomorrow || []).slice(0, 2)
  const hour = new Date().getHours()

  // The cached day beat list is a snapshot of the whole calendar, so the "next"
  // card must skip anything already behind us — a meeting at 11:30 AM is not
  // "next" at 7 PM. All-day/unparseable beats stay (they have no start time).
  const nowMin = new Date().getHours() * 60 + new Date().getMinutes()
  const nextBeat = beats.find((b) => {
    const t = beatMinutes(b.time)
    return t < 0 || t >= nowMin - 5
  })
  const doCard: BriefDo =
    story?.do ||
    pickBriefAction({
      hour,
      lastNightLogged: lastNight.logged,
      next: nextBeat,
      due,
      asks: [],
    })

  const kicker = isEvening ? 'Evening' : data?.brief === 'morning' || story ? 'Morning' : 'Morning'
  const dateLabel = evening?.date || data?.date || story?.date || ''
  // Free-tier cap hit: the rationing path served a stale-but-same-day payload
  // on purpose, so the user gets a banner explaining why this brief isn't
  // freshly rebuilt. Both briefs carry the same shape from the server.
  const limited = !!data?.limited || !!evening?.limited
  const limitedUsed = data?.used ?? evening?.used
  const limitedLimit = data?.limit ?? evening?.limit
  // The lead names the beat, so a prep DO card that names the same beat twice
  // would answer the same question twice. On a prep day the header takes the
  // action ("Get prepped for Maria.") and the card keeps the beat.
  const leadTitle =
    doCard?.kind === 'prep' && doCard.prepName
      ? `Get prepped for ${firstName(doCard.prepName)}.`
      : story?.lead || 'Your day'

  // Evening sections come from the pick_night payload headings.
  const eveSection = (heading: string) => evening?.sections?.find((s) => s.heading === heading)
  const whereTonight = eveSection('Where you are')
  const earlierToday = eveSection('Earlier today')
  const leftTonight = eveSection('Left this evening')
  const mailSince = eveSection('Mail since this morning')
  const tomorrowEve = eveSection('Tomorrow')
  const eveMail: BriefAsk[] = (mailSince?.items || []).map((label, i) => ({
    id: mailSince?.emailMeta?.[i]?.id || '',
    label,
    snippet: mailSince?.emailMeta?.[i]?.snippet,
  }))

  const nowMinutes = new Date().getHours() * 60 + new Date().getMinutes()

  /* Rides the digest payload. Missing or empty on an API that has not shipped it
   * yet, so both lists render nothing and today's screens stay as they were. */
  const upNext = (data?.meetings || []).slice(0, 5)
  const attention = !isEvening ? data?.attention || null : null
  const attentionTappable = !!(attention && attention.id && !attention.id.startsWith('text-'))

  const openFirstMail = () => {
    const first = needsYou[0]
    if (first) onOpenMail(first.id, first.label, first.snippet)
  }

  const togglePile = (kind: string) => {
    setOpenPiles((prev) => {
      const next = new Set(prev)
      if (next.has(kind)) next.delete(kind)
      else next.add(kind)
      return next
    })
  }

  return (
    <div className="brief">
      <header className="brief-lead">
        <div className="brief-lead-row">
          <span className="brief-kicker">{kicker}</span>
          {onRefresh ? (
            <button
              type="button"
              className={`brief-refresh${refreshing ? ' is-busy' : ''}`}
              onClick={handleRefresh}
              disabled={refreshing}
              aria-label="Refresh brief"
              title={refreshing ? 'Refreshing' : 'Refresh brief'}
            >
              <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
                <path
                  d="M8 2.5a5.5 5.5 0 0 1 4.85 2.93M13.5 8a5.5 5.5 0 0 1-9.7 3.57M2.5 8a5.5 5.5 0 0 1 .65-2.5"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  strokeLinecap="round"
                />
                <path
                  d="M13 1.5l.5 3-3 .5M3 14.5l-.5-3 3-.5"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            </button>
          ) : null}
        </div>
        {dateLabel ? <p className="brief-date">{dateLabel}</p> : null}
        <h2 className="brief-title">{leadTitle}</h2>
      </header>

      {refreshedAt ? <p className="brief-refreshed">Updated just now</p> : null}

      {limited && (
        <p className="brief-limited">
          Free refreshes done for now ({limitedUsed ?? '?'} of {limitedLimit ?? '?'} this week).{' '}
          <a href="/app/settings?upgrade=1">Upgrade</a> to refresh anytime.
        </p>
      )}

      {!isEvening && <FactStrip facts={facts} />}

      <DoCard
        card={doCard}
        creds={creds}
        onOpenMailId={() => openFirstMail()}
        miniLink={miniLink}
      />

      {isEvening && evening?.dayScore && (
        <p className="brief-score">
          <span className="brief-score-points">Day closed at {evening.dayScore.points}</span>
          <span className="brief-score-verdict">{evening.dayScore.verdict}</span>
        </p>
      )}

      {isEvening && (evening?.dayFacts?.length || evening?.habitsToday?.length) && (
        <DayClosed
          facts={evening?.dayFacts || []}
          habits={evening?.habitsToday || []}
          creds={creds}
          notify={notify}
        />
      )}

      {isEvening && whereTonight && (
        <p className="brief-later">
          <span>{whereTonight.heading}</span>
          {whereTonight.items.join('  ')}
        </p>
      )}

      {isEvening && earlierToday && earlierToday.items.length > 0 && (
        <section className="brief-block">
          <h3 className="brief-label">Earlier today</h3>
          <ul className="brief-day">
            {earlierToday.items.map((it, i) => (
              <li key={`${it}-${i}`} className="brief-day--past">
                {it}
              </li>
            ))}
          </ul>
        </section>
      )}

      {!isEvening && beats.length > 0 && (
        <section className="brief-block">
          <h3 className="brief-label">The day</h3>
          <ol className="brief-day">
            {beats.map((b, i) => {
              const mins = beatMinutes(b.time)
              const past = mins >= 0 && mins < nowMinutes - 5
              return (
                <li key={`${b.time}-${b.name}-${i}`} className={past ? 'brief-day--past' : undefined}>
                  <span className="brief-day-time">{b.time}</span>
                  <span className="brief-day-name">{b.name}</span>
                  {b.kind && b.kind !== 'Meeting' ? <span className="brief-day-kind">{b.kind}</span> : null}
                  {!past && (
                    <button className="brief-tap" type="button" onClick={() => setPrepName(b.name)}>
                      Prep
                    </button>
                  )}
                </li>
              )
            })}
          </ol>
        </section>
      )}

      {work.length > 0 && (
        <section className="brief-block">
          <h3 className="brief-label">Work</h3>
          {work.map((w) => (
            <div key={w.title} className="brief-work-group">
              <span className="brief-work-title">{w.title}</span>
              <ul className="brief-asks">
                {w.lines.map((l, i) => (
                  <li key={i} className="brief-ask-line">{l}</li>
                ))}
              </ul>
            </div>
          ))}
        </section>
      )}

      {(needsYou.length > 0 || (isEvening && eveMail.length > 0)) && (
        <section className="brief-block">
          <h3 className="brief-label">Needs you{needsYou.length ? ` · ${needsYou.length}` : ''}</h3>
          <ul className="brief-asks">
            {isEvening
              ? eveMail.map((e) => (
                  <PileRow key={e.id || e.label} e={e} creds={creds} onOpenMail={onOpenMail} onOpenDraft={onOpenDraft} notify={notify} />
                ))
              : needsYou.map((item) => (
                  <NeedsYouRow
                    key={item.id}
                    item={item}
                    creds={creds}
                    onOpenMail={onOpenMail}
                    onOpenDraft={onOpenDraft}
                    onGone={() => setNeedsYou((prev) => prev.filter((x) => x.id !== item.id))}
                    notify={notify}
                  />
                ))}
          </ul>
        </section>
      )}

      {isEvening && leftTonight && leftTonight.items.length > 0 && (
        <section className="brief-block">
          <h3 className="brief-label">Left tonight</h3>
          <ul className="brief-day">
            {leftTonight.items.map((it, i) => (
              <li key={`${it}-${i}`}>{it}</li>
            ))}
          </ul>
        </section>
      )}

      {isEvening && carry.length > 0 && (
        <CarryOver
          items={carry}
          creds={creds}
          onGone={(id) => setCarry((prev) => prev.filter((c) => c.id !== id))}
          notify={notify}
        />
      )}

      {!isEvening && reminders.length > 0 && (
        <section className="brief-block">
          <h3 className="brief-label">Reminders</h3>
          <ul className="brief-notes">
            {reminders.map((r, i) => (
              <ReminderRow
                key={`${r.text}-${i}`}
                r={r}
                creds={creds}
                onGone={() => setReminders((prev) => prev.filter((x) => x !== r))}
                notify={notify}
              />
            ))}
          </ul>
        </section>
      )}

      {!isEvening && due.length > 0 && (
        <section className="brief-block">
          <h3 className="brief-label">Due a ping</h3>
          <ul className="brief-due">
            {due.map((p) => (
              <li key={p.name}>
                <Link className="brief-due-link" to={miniLink('networking_crm')}>
                  <span>{p.name}</span>
                  <span>{p.days >= 900 ? 'No touch yet' : `${p.days} days`}</span>
                </Link>
                {p.phone ? (
                  <a className="brief-sms" href={`sms:${p.phone.replace(/[^\d+]/g, '')}`}>
                    Text
                  </a>
                ) : null}
              </li>
            ))}
          </ul>
        </section>
      )}

      {upNext.length > 0 && (
        <section className="brief-block">
          <h3 className="brief-label">Up next</h3>
          <ul className="brief-next">
            {upNext.map((m, i) => (
              <li
                key={`${m.time}-${m.title}-${i}`}
                className={m.startsInMin != null && m.startsInMin <= 60 ? 'brief-next-row brief-next-row--soon' : 'brief-next-row'}
              >
                <span className="brief-next-time">{m.time}</span>
                <span className="brief-next-title">{m.title}</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {attention && (
        <section className="brief-block">
          <button
            className={attentionTappable ? 'brief-att brief-att--tap' : 'brief-att'}
            type="button"
            onClick={attentionTappable ? () => onOpenMail(attention.id, attention.label, attention.snippet) : undefined}
          >
            <span className="brief-att-kicker">Needs your eyes</span>
            <span className="brief-att-label">{attention.label}</span>
            {attention.why ? <span className="brief-att-why">{attention.why}</span> : null}
            {attention.snippet ? <span className="brief-att-snip">{attention.snippet}</span> : null}
          </button>
        </section>
      )}

      {mailPiles.length > 0 && (
        <section className="brief-block">
          <h3 className="brief-label">Mail</h3>
          {tally ? <p className="brief-mail-tally">{tally}</p> : null}
          <div className="brief-piles">
            {mailPiles.map((g) => {
              const open = openPiles.has(g.kind)
              return (
                <div key={g.kind} className="brief-pile">
                  <button className="brief-pile-head" type="button" onClick={() => togglePile(g.kind)}>
                    <span>{mailGroupHeading(g.kind, g.count, g.label)}</span>
                    <span className="brief-pile-caret">{open ? '▾' : '▸'}</span>
                  </button>
                  {open && (
                    <ul className="brief-asks brief-pile-items">
                      {g.items.map((e) => (
                        <PileRow key={e.id || e.label} e={e} creds={creds} onOpenMail={onOpenMail} onOpenDraft={onOpenDraft} notify={notify} />
                      ))}
                    </ul>
                  )}
                </div>
              )
            })}
          </div>
        </section>
      )}

      {isEvening && tomorrowEve && tomorrowEve.items.length > 0 && (
        <p className="brief-later">
          <span>Tomorrow</span>
          {tomorrowEve.items.join('  ')}
        </p>
      )}
      {!isEvening && later.length > 0 && (
        <p className="brief-later">
          <span>Tomorrow</span>
          {later.join('  ')}
        </p>
      )}

      {prepName && <PrepSheet name={prepName} creds={creds} onClose={() => setPrepName(null)} />}
      <Toast toast={toast} />
    </div>
  )
}
