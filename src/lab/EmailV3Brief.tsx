import { useMemo, useState } from 'react'
import { AlphaFace } from '../AlphaFace'
import { LAB_ROUTES } from './labRoutes'
import {
  BRIEF_TIME,
  LATER,
  TALLY,
  THREADS,
  TODAY,
  WAITING,
  avatarTint,
  initials,
} from './labData'
import './lab.css'
import './emailV3.css'

/* V3 — Morning Brief + Email Radar
 *
 * The organising idea: email is a story you read once a morning, and everything
 * with a date on it lives on one seven-day radar that Alpha re-walks all day.
 * Nothing here is a list of messages — the brief is written, the radar is
 * watched, and the user's only job is to say yes, no, or later.
 *
 * Deliberately rendered in the product's light theme warmed toward brand paper:
 * the brief is a morning read, and it should feel printed.
 */

type RadarKind = 'deadline' | 'waiting' | 'chase' | 'soft'

type RadarEntry = {
  id: string
  day: number
  kind: RadarKind
  title: string
  detail: string
  /** What Alpha will do on its own if nobody intervenes. */
  auto: string
  threadId?: string
  action?: string
}

const DAYS = ['Tue 23', 'Wed 24', 'Thu 25', 'Fri 26', 'Sat 27', 'Sun 28', 'Mon 29', 'Tue 30']

const RADAR: RadarEntry[] = [
  {
    id: 'r1',
    day: 0,
    kind: 'deadline',
    title: 'Interview slot hold — Priya',
    detail: 'She is holding Thursday 10:00am for you until Thursday 5pm. Replying today keeps the pick of the slots.',
    auto: 'If nothing happens by Thursday 1pm, Alpha drafts a reply and puts it in front of you.',
    threadId: 't1',
    action: 'Reply now',
  },
  {
    id: 'r2',
    day: 0,
    kind: 'chase',
    title: 'Invoice #204 — 9 days past due',
    detail: 'You set your own line at seven days. Alpha has a firmer note ready and will not send it without you.',
    auto: 'Alpha keeps watching and will not escalate twice in one week.',
    threadId: 't7',
    action: 'Send the firmer note',
  },
  {
    id: 'r3',
    day: 0,
    kind: 'soft',
    title: 'Marcus is blocked on your yes',
    detail: 'He cannot book the room until you confirm Friday.',
    auto: 'Nothing. Alpha will not answer a scheduling question on your behalf until you turn level 3 on.',
    threadId: 't2',
    action: 'Say yes to Friday',
  },
  {
    id: 'r4',
    day: 1,
    kind: 'waiting',
    title: 'Recommendation letter expected',
    detail: 'You asked four days ago and the portal closes the 28th. Wednesday is the natural day to nudge.',
    auto: 'If Thursday passes with no letter, Alpha drafts the nudge.',
    threadId: 't6',
    action: 'Nudge today',
  },
  {
    id: 'r5',
    day: 1,
    kind: 'deadline',
    title: 'Jules books the table at noon',
    detail: 'She needs a headcount. This is a two-word reply.',
    auto: 'Alpha will not RSVP for you.',
    threadId: 't5',
    action: 'Reply in two words',
  },
  {
    id: 'r6',
    day: 2,
    kind: 'deadline',
    title: 'Interview actually happening',
    detail: 'Once Priya confirms, this is where the 45 minutes land.',
    auto: 'Alpha will send you a prep sheet the night before.',
  },
  {
    id: 'r7',
    day: 2,
    kind: 'chase',
    title: 'Figma SLA passed — decide or drop',
    detail: 'Their 48-hour window closed. Either escalate or let the 6-seat invoice go and stop watching it.',
    auto: 'Alpha stops watching after Thursday unless you say otherwise.',
    threadId: 't9',
    action: 'Escalate',
  },
  {
    id: 'r8',
    day: 3,
    kind: 'deadline',
    title: 'Sarah needs your notes',
    detail: 'You already said Thursday evening. This is the last minute you can honestly keep that promise.',
    auto: 'Alpha will remind you Thursday at 4pm, once.',
    threadId: 't4',
    action: 'Open her draft',
  },
  {
    id: 'r9',
    day: 3,
    kind: 'soft',
    title: 'Meridian intro goes cold',
    detail: 'Six days since you said yes. A nudge stops being normal after about a week.',
    auto: 'Alpha drafts the nudge but will not send it to a new contact.',
    threadId: 't8',
    action: 'Send a light nudge',
  },
  {
    id: 'r10',
    day: 7,
    kind: 'deadline',
    title: 'Lease e-sign expires',
    detail: 'After the 30th the file closes and the application re-opens.',
    auto: 'Alpha will remind you three times: Monday, Tuesday morning, Tuesday at 6pm.',
    threadId: 't3',
    action: 'Sign now',
  },
]

const KIND_LABEL: Record<RadarKind, string> = {
  deadline: 'Deadline',
  waiting: 'Expected reply',
  chase: 'Past your line',
  soft: 'Worth a look',
}

const INTERRUPTS = [
  { id: 'deadline', label: 'A deadline inside 48 hours', on: true },
  { id: 'person', label: 'A person waiting on me', on: true },
  { id: 'money', label: 'Anything over $500', on: true },
  { id: 'everything', label: 'Everything else', on: false },
]

export function EmailV3Brief() {
  const [selected, setSelected] = useState<string | null>('r1')
  const [resolved, setResolved] = useState<string[]>([])
  const [openFiled, setOpenFiled] = useState(false)
  const [openDraft, setOpenDraft] = useState<string | null>(null)
  const [openHonest, setOpenHonest] = useState(false)
  const [interrupts, setInterrupts] = useState(INTERRUPTS)
  const [nudged, setNudged] = useState<string[]>([])
  const [toast, setToast] = useState<string | null>(null)
  const [drafts, setDrafts] = useState<Record<string, string>>({})

  const entry = RADAR.find((r) => r.id === selected)
  const thread = entry?.threadId ? THREADS.find((t) => t.id === entry.threadId) : undefined

  const live = useMemo(() => RADAR.filter((r) => !resolved.includes(r.id)), [resolved])
  const byDay = useMemo(() => DAYS.map((_, i) => live.filter((r) => r.day === i)), [live])
  const undecided = live.filter((r) => r.kind === 'deadline' || r.kind === 'chase').length

  function flash(text: string) {
    setToast(text)
    window.setTimeout(() => setToast((t) => (t === text ? null : t)), 6000)
  }

  function act(e: RadarEntry) {
    setResolved((r) => [...r, e.id])
    if (e.threadId) {
      setDrafts((d) => ({ ...d, [e.threadId!]: d[e.threadId!] ?? THREADS.find((t) => t.id === e.threadId)?.draft?.body ?? '' }))
    }
    flash(`${e.action} — done. Alpha moved it off the radar and will tell you the moment a reply lands.`)
  }

  return (
    <div className="lab lab--paper l3">
      <div className="l3-shell">
        {/* ── Masthead ───────────────────────────────────────────────────── */}
        <header className="l3-masthead">
          <div className="l3-masthead__brand">
            <AlphaFace color="#1f6b5f" mood="soft" size={30} />
            <div>
              <div className="l3-masthead__name">Alpha</div>
              <div className="lab-note">Morning brief</div>
            </div>
          </div>
          <div className="l3-masthead__date">
            <span className="l3-masthead__day">{TODAY}</span>
            <span className="lab-note lab-num">Written {BRIEF_TIME} · read in 90 seconds</span>
          </div>
          <span className="lab-badge">Prototype v3</span>
        </header>

        <div className="l3-rule" />

        {/* ── The brief itself ───────────────────────────────────────────── */}
        <section className="l3-brief">
          <h1 className="lab-display l3-brief__lead">
            Two things need you before noon.
            <span className="l3-brief__lead-soft"> Everything else is already moving.</span>
          </h1>
          <div className="l3-brief__body">
            <p>
              Northwind came back overnight — Priya wants a time for your interview and is holding a slot until
              Thursday. That is the one thing today with a clock on it, so it is at the top of the radar below.
            </p>
            <p>
              Marcus is blocked on a one-word yes, and Jules needs a headcount before she books. Both take seconds.
              I drafted replies for all three; none of them leave your account without you.
            </p>
            <p>
              Overnight I read <strong>31 emails</strong>. <strong>{TALLY.needsYou} needed you</strong>, and I filed the
              other {LATER.length} — receipts, alerts, an invite, and a newsletter you read on Sundays. One thing is
              past the line you set it: the Brightline invoice is nine days late, and I have a firmer note ready.
            </p>
            <p className="l3-brief__sign">— Alpha</p>
          </div>
        </section>

        {/* ── Email radar ────────────────────────────────────────────────── */}
        <section className="l3-radar">
          <header className="l3-radar__head">
            <div>
              <span className="lab-kicker">Email radar · next seven days</span>
              <p className="l3-radar__sub">
                Everything with a date on it, in one line. I re-walk it every 30 minutes and will tell you the moment
                something moves.
              </p>
            </div>
            <span className="l3-radar__count lab-num">
              {undecided} undecided · {live.length} tracked
            </span>
          </header>

          <div className="l3-track">
            {DAYS.map((day, i) => {
              const entries = byDay[i]!
              return (
                <div key={day} className={`l3-day${i === 0 ? ' is-today' : ''}${entries.length === 0 ? ' is-empty' : ''}`}>
                  <div className="l3-day__label lab-num">{day}</div>
                  <div className="l3-day__pips">
                    {entries.map((e) => (
                      <button
                        key={e.id}
                        type="button"
                        className={`l3-pip is-${e.kind}${selected === e.id ? ' is-selected' : ''}${i === 0 ? ' is-now' : ''}`}
                        aria-label={`${KIND_LABEL[e.kind]}: ${e.title}`}
                        aria-pressed={selected === e.id}
                        onClick={() => setSelected(selected === e.id ? null : e.id)}
                      >
                        <span className="l3-pip__dot" aria-hidden="true" />
                        <span className="l3-pip__text">{e.title}</span>
                      </button>
                    ))}
                    {entries.length === 0 && <span className="l3-day__quiet">—</span>}
                  </div>
                </div>
              )
            })}
          </div>

          {entry ? (
            <article className="l3-detail lab-fade-in">
              <div className="l3-detail__main">
                <span className={`lab-chip l3-chip--${entry.kind}`}>{KIND_LABEL[entry.kind]}</span>
                <h3 className="l3-detail__title">{entry.title}</h3>
                <p className="l3-detail__text">{entry.detail}</p>
                <p className="l3-detail__auto">
                  <span className="lab-kicker">If you do nothing</span>
                  {entry.auto}
                </p>
                {thread && <p className="l3-detail__why">Why it matters: {thread.why}</p>}
              </div>
              <div className="l3-detail__side">
                <button type="button" className="lab-btn lab-btn--primary" onClick={() => act(entry)}>
                  {entry.action ?? 'Handle it'}
                </button>
                {thread?.draft && (
                  <button type="button" className="lab-btn" onClick={() => setOpenDraft(openDraft === entry.id ? null : entry.id)}>
                    {openDraft === entry.id ? 'Hide draft' : 'Read Alpha’s draft'}
                  </button>
                )}
                <button
                  type="button"
                  className="lab-btn lab-btn--quiet"
                  onClick={() => {
                    setResolved((r) => [...r, entry.id])
                    flash('Snoozed to Thursday evening. Alpha will bring it back exactly once.')
                  }}
                >
                  Snooze
                </button>
                <button
                  type="button"
                  className="lab-btn lab-btn--quiet"
                  onClick={() => {
                    setResolved((r) => [...r, entry.id])
                    flash('Dropped. Alpha stopped watching it — nothing here will nag you again.')
                  }}
                >
                  Let it go
                </button>
              </div>
            </article>
          ) : (
            <p className="l3-radar__idle lab-note">Pick anything on the radar to see what it is and what Alpha would do.</p>
          )}

          {openDraft && thread?.draft && (
            <div className="l3-draft lab-fade-in">
              <div className="l3-draft__head">
                <span className="lab-kicker">Draft · {thread.from.name}</span>
                <span className="lab-note">Subject: {thread.draft.subject}</span>
              </div>
              <textarea
                className="l3-draft__text"
                aria-label="Draft body"
                rows={7}
                value={drafts[thread.id] ?? thread.draft.body}
                onChange={(e) => setDrafts((d) => ({ ...d, [thread.id]: e.target.value }))}
              />
              <div className="l3-draft__row">
                <button
                  type="button"
                  className="lab-btn lab-btn--primary"
                  onClick={() => {
                    const target = RADAR.find((r) => r.threadId === thread.id)
                    if (target) act(target)
                  }}
                >
                  Send as is
                </button>
                <span className="lab-note">Or keep reading — nothing sends on its own.</span>
              </div>
            </div>
          )}
        </section>

        <div className="l3-columns">
          <div className="l3-col">
            {/* ── Waiting on others ─────────────────────────────────────── */}
            <section className="l3-block">
              <header className="l3-block__head">
                <span className="lab-kicker">Waiting on other people</span>
                <span className="lab-note">Alpha watches the clock on these</span>
              </header>
              <ul className="l3-wait">
                {WAITING.map((t) => (
                  <li key={t.id} className={`l3-wait__item${t.waiting?.overdue ? ' is-overdue' : ''}`}>
                    <span className="lab-avatar lab-avatar--sm" style={{ background: avatarTint(t.from.hue).bg, color: avatarTint(t.from.hue).fg }}>
                      {initials(t.from.name)}
                    </span>
                    <div className="l3-wait__id">
                      <div className="l3-wait__what">{t.waiting?.what}</div>
                      <div className="lab-note">
                        {t.from.name} · {t.waiting?.days === 0 ? t.waiting.since : `${t.waiting?.days} days`} · {t.waiting?.expectBy}
                      </div>
                    </div>
                    <button
                      type="button"
                      className={`lab-btn lab-btn--sm${t.waiting?.overdue ? ' lab-btn--primary' : ''}`}
                      disabled={nudged.includes(t.id)}
                      onClick={() => {
                        setNudged((n) => [...n, t.id])
                        flash(`Nudge sent to ${t.from.name.split(' ')[0]}. One nudge every four days, never more.`)
                      }}
                    >
                      {nudged.includes(t.id) ? 'Nudged' : 'Nudge'}
                    </button>
                  </li>
                ))}
              </ul>
            </section>

            {/* ── Filed overnight ──────────────────────────────────────── */}
            <section className="l3-block">
              <button type="button" className="l3-block__toggle" aria-expanded={openFiled} onClick={() => setOpenFiled((v) => !v)}>
                <span className="lab-kicker">Filed overnight · {LATER.length}</span>
                <span className="lab-note">{openFiled ? 'Hide' : 'See what I filed and why'}</span>
              </button>
              <p className="l3-block__line">
                Receipts, payouts, alerts, an invite and a newsletter. Nothing in here had a person waiting on you.
              </p>
              {openFiled && (
                <ul className="l3-filed lab-fade-in">
                  {LATER.map((t) => (
                    <li key={t.id}>
                      <span className="l3-filed__subj">{t.subject}</span>
                      <span className="lab-note">{t.filed?.note}</span>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          </div>

          {/* ── Controls + honesty ─────────────────────────────────────── */}
          <aside className="l3-col l3-col--side">
            <section className="l3-card">
              <header className="l3-card__head">
                <span className="lab-kicker">When Alpha may interrupt you</span>
              </header>
              <ul className="l3-int">
                {interrupts.map((it) => (
                  <li key={it.id}>
                    <button
                      type="button"
                      role="switch"
                      aria-checked={it.on}
                      aria-label={it.label}
                      className="lab-switch"
                      onClick={() => setInterrupts((prev) => prev.map((p) => (p.id === it.id ? { ...p, on: !p.on } : p)))}
                    />
                    <span className="l3-int__label">{it.label}</span>
                  </li>
                ))}
              </ul>
              <p className="lab-note l3-card__foot">
                One chat message a day, maximum, no matter what the switches say. The brief itself never notifies — you
                come to it.
              </p>
            </section>

            <section className="l3-card">
              <header className="l3-card__head">
                <span className="lab-kicker">What Alpha did alone this morning</span>
              </header>
              <ul className="l3-did">
                <li>
                  <span>Read</span>
                  <span className="lab-num">31 emails</span>
                </li>
                <li>
                  <span>Filed, with a reason attached</span>
                  <span className="lab-num">{LATER.length}</span>
                </li>
                <li>
                  <span>Drafted for your review</span>
                  <span className="lab-num">{TALLY.drafted}</span>
                </li>
                <li>
                  <span>Sent without asking</span>
                  <span className="lab-num l3-did__zero">0</span>
                </li>
              </ul>
              <p className="lab-note l3-card__foot">
                Alpha has no send access to your mail. It can only write, file, and watch.
              </p>
            </section>

            <section className="l3-card l3-card--honest">
              <button type="button" className="l3-block__toggle" aria-expanded={openHonest} onClick={() => setOpenHonest((v) => !v)}>
                <span className="lab-kicker">When something breaks</span>
                <span className="lab-note">{openHonest ? 'Hide' : 'How I tell you'}</span>
              </button>
              {openHonest ? (
                <div className="lab-fade-in">
                  <p className="l3-honest__sample">
                    “Gmail didn't answer, so mail is a text-only scan: senders and subjects only, nothing to open or
                    reply to.”
                  </p>
                  <p className="lab-note">
                    That is the exact line Alpha uses. A partial brief says it is partial — a radar with a blind spot
                    is worse than no radar, because you would trust it.
                  </p>
                </div>
              ) : (
                <p className="lab-note l3-card__foot">
                  A brief that hides a broken connection is worse than no brief. Alpha says what it could not see.
                </p>
              )}
            </section>
          </aside>
        </div>

        <footer className="l3-foot">
          <span className="lab-note">
            Prototype v3 · light “morning paper” variant of the product theme · mock data, no account access
          </span>
          <a className="lab-btn lab-btn--sm" href={LAB_ROUTES.compare}>
            Compare the three concepts →
          </a>
        </footer>
      </div>

      {toast && (
        <div className="lab-toast" role="status">
          <span>{toast}</span>
        </div>
      )}
    </div>
  )
}
