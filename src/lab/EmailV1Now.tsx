import { useMemo, useState } from 'react'
import { AlphaFace } from '../AlphaFace'
import { LAB_ROUTES } from './labRoutes'
import {
  CHIP_LABELS,
  TALLY,
  THREADS,
  TODAY,
  avatarTint,
  filedBuckets,
  initials,
  type MailState,
  type MailThread,
} from './labData'
import './lab.css'
import './emailV1.css'

/* V1 — Now / Waiting / Later
 *
 * The organising idea: a thread is never "unread", it is in one of exactly
 * three states. Now means only the user can move it; Waiting means the user
 * already moved and someone else owes the next move; Later means Alpha already
 * decided it never needed a human. Everything else (reading, filing, nudging,
 * the autopilot ledger) hangs off those three.
 */

const STATE_COPY: Record<MailState, { label: string; line: string; owner: string }> = {
  now: { label: 'Now', line: 'Only you can move these.', owner: 'Yours to move' },
  waiting: { label: 'Waiting', line: 'You moved. They owe the next move.', owner: 'Theirs to move' },
  later: { label: 'Later', line: 'Nobody is waiting. Alpha handled it.', owner: "Nobody's move" },
}

type Rule = { id: string; label: string; detail: string; live: string; on: boolean; locked?: string }

const INITIAL_RULES: Rule[] = [
  {
    id: 'file',
    label: 'Sort receipts, alerts and newsletters',
    detail: 'Alpha files them and shows you the pile, never the interruptions.',
    live: '9 filed today',
    on: true,
  },
  {
    id: 'draft',
    label: 'Write reply drafts',
    detail: 'A draft is written for anything that needs a reply, so you only edit and send.',
    live: '3 waiting for your review',
    on: true,
  },
  {
    id: 'nudge',
    label: 'Nudge once my line passes',
    detail: 'Alpha chases only people you already emailed, and only after the date you set.',
    live: '1 nudge ready',
    on: true,
  },
  {
    id: 'send',
    label: 'Send without my review',
    detail: 'Off, and it stays off until you turn it on for a specific sender.',
    live: 'Alpha cannot send as you',
    on: false,
    locked: 'Drafts only. Alpha has no send access to your account.',
  },
]

const HARD_RULES = [
  'Alpha never sends as you. It drafts, you send.',
  'Alpha never deletes — anything filed can be pulled back.',
  'Alpha never contacts someone you have not already written to.',
]

function SenderAvatar({ thread, small }: { thread: MailThread; small?: boolean }) {
  const tint = avatarTint(thread.from.hue)
  return (
    <span
      className={`lab-avatar${small ? ' lab-avatar--sm' : ''}`}
      style={{ background: tint.bg, color: tint.fg }}
      aria-hidden="true"
    >
      {initials(thread.from.name)}
    </span>
  )
}

function ReasonChips({ thread }: { thread: MailThread }) {
  return (
    <>
      {thread.reasons.map((r) => (
        <span key={r} className={`lab-chip${r === 'waiting_on_you' ? ' lab-chip--now' : r === 'money' ? ' lab-chip--risk' : ''}`}>
          {CHIP_LABELS[r]}
        </span>
      ))}
    </>
  )
}

export function EmailV1Now() {
  const [threads, setThreads] = useState<MailThread[]>(THREADS)
  const [state, setState] = useState<MailState>('now')
  const [openCard, setOpenCard] = useState<string | null>('t1')
  const [openDraft, setOpenDraft] = useState<string | null>('t1')
  const [openOriginal, setOpenOriginal] = useState<string | null>(null)
  const [nudging, setNudging] = useState<string | null>(null)
  const [drafts, setDrafts] = useState<Record<string, string>>({})
  const [rules, setRules] = useState<Rule[]>(INITIAL_RULES)
  const [openBuckets, setOpenBuckets] = useState<string[]>(['Receipts'])
  const [toast, setToast] = useState<{ text: string; undo: () => void } | null>(null)

  const groups = useMemo(() => {
    const by = (s: MailState) => threads.filter((t) => t.state === s)
    return { now: by('now'), waiting: by('waiting'), later: by('later') }
  }, [threads])

  const buckets = useMemo(() => filedBuckets(threads), [threads])

  function flash(text: string, undo: () => void) {
    setToast({ text, undo })
    window.setTimeout(() => setToast((t) => (t?.text === text ? null : t)), 7000)
  }

  /* The loop that matters: sending moves a thread into Waiting, so the thing
   * the user just replied to becomes something Alpha tracks for them. */
  function sendDraft(thread: MailThread) {
    setThreads((prev) =>
      prev.map((t) =>
        t.id === thread.id
          ? {
              ...t,
              state: 'waiting',
              waiting: {
                what: `Your reply to ${t.from.name.split(' ')[0]}`,
                since: 'You replied just now',
                days: 0,
                expectBy: t.from.vip ? 'You usually hear back in 1 day' : 'Alpha will check in 3 days',
                overdue: false,
              },
            }
          : t,
      ),
    )
    setOpenCard(null)
    setOpenDraft(null)
    flash(`Sent. Alpha is tracking a reply from ${thread.from.name.split(' ')[0]}.`, () =>
      setThreads((prev) => prev.map((t) => (t.id === thread.id ? thread : t))),
    )
  }

  function fileQuietly(thread: MailThread) {
    setThreads((prev) =>
      prev.map((t) =>
        t.id === thread.id
          ? { ...t, state: 'later', filed: { bucket: 'Reading', note: 'Filed quietly by you · pull it back any time' } }
          : t,
      ),
    )
    setOpenCard(null)
    flash(`Filed. Alpha will keep it if you need it.`, () =>
      setThreads((prev) => prev.map((t) => (t.id === thread.id ? thread : t))),
    )
  }

  function bringBack(thread: MailThread) {
    setThreads((prev) =>
      prev.map((t) => (t.id === thread.id ? { ...t, state: 'now', filed: undefined } : t)),
    )
    setState('now')
    setOpenCard(thread.id)
    setToast(null)
  }

  function sendNudge(thread: MailThread) {
    setThreads((prev) =>
      prev.map((t) =>
        t.id === thread.id && t.waiting
          ? { ...t, waiting: { ...t.waiting, since: 'You nudged just now', days: 0, overdue: false, expectBy: 'Alpha will check again Friday' } }
          : t,
      ),
    )
    setNudging(null)
    flash(`Nudge sent to ${thread.from.name.split(' ')[0]}. Alpha is watching for a reply.`, () => undefined)
  }

  function toggleRule(id: string) {
    setRules((prev) => prev.map((r) => (r.id === id ? { ...r, on: !r.on } : r)))
  }

  const stateCounts: Record<MailState, number> = {
    now: groups.now.length,
    waiting: groups.waiting.length,
    later: groups.later.length,
  }

  const overdue = groups.waiting.filter((t) => t.waiting?.overdue).length

  return (
    <div className="lab l1">
      <div className="lab-shell">
        <header className="lab-topbar">
          <AlphaFace color="#2a6f7a" mood="soft" size={34} />
          <div className="lab-brand">
            <div className="lab-brand__name">Alpha</div>
            <div className="lab-brand__role">
              {TODAY} · read 31 emails · {TALLY.filed} filed · {stateCounts.now} need you
            </div>
          </div>
          <div className="lab-topbar__spacer" />
          <span className="lab-badge">Prototype v1</span>
        </header>

        <div className="l1-grid">
          {/* ── The three states, as a switcher rather than a folder list ── */}
          <nav className="l1-states" aria-label="Email states">
            {(Object.keys(STATE_COPY) as MailState[]).map((s) => {
              const copy = STATE_COPY[s]
              const active = state === s
              return (
                <button
                  key={s}
                  type="button"
                  className={`l1-state${active ? ' is-active' : ''} l1-state--${s}`}
                  aria-pressed={active}
                  onClick={() => setState(s)}
                >
                  <span className="l1-state__top">
                    <span className="l1-state__name">{copy.label}</span>
                    <span className="l1-state__count lab-num">{stateCounts[s]}</span>
                  </span>
                  <span className="l1-state__line">{copy.line}</span>
                  <span className="l1-state__owner">{copy.owner}</span>
                </button>
              )
            })}
            <p className="lab-note l1-states__note">
              A thread is never unread. It is yours, theirs, or already handled.
            </p>
          </nav>

          <main className="l1-main">
            {state === 'now' && (
              <>
                <div className="l1-head">
                  <div>
                    <h2 className="lab-title">
                      {stateCounts.now} things only you can move
                    </h2>
                    <p className="lab-body">
                      About four minutes of decisions. Alpha already wrote {groups.now.filter((t) => t.draft).length} of the replies.
                    </p>
                  </div>
                  <a className="lab-btn lab-btn--sm" href={LAB_ROUTES.v2}>
                    Answer one at a time →
                  </a>
                </div>

                <div className="l1-list">
                  {groups.now.map((t) => {
                    const open = openCard === t.id
                    const draftOpen = openDraft === t.id
                    const body = drafts[t.id] ?? t.draft?.body ?? ''
                    return (
                      <article key={t.id} className={`lab-card l1-now${open ? ' is-open' : ''}`}>
                        <button
                          type="button"
                          className="l1-now__head"
                          aria-expanded={open}
                          onClick={() => setOpenCard(open ? null : t.id)}
                        >
                          <SenderAvatar thread={t} />
                          <span className="l1-now__id">
                            <span className="l1-now__who">
                              {t.from.name}
                              {t.from.org ? <span className="l1-now__org"> · {t.from.org}</span> : null}
                            </span>
                            <span className="l1-now__subject">
                              “{t.subject}”
                              {t.threadCount && t.threadCount > 1 ? ` · ${t.threadCount} messages` : ''}
                            </span>
                          </span>
                          <span className="l1-now__arrived lab-num">{t.arrived}</span>
                        </button>

                        <div className="l1-now__body">
                          {/* Alpha's summary is the headline. The subject is metadata. */}
                          <p className="l1-now__summary">{t.summary}</p>

                          <div className="l1-why">
                            <span className="lab-kicker">Why this is here</span>
                            <p className="l1-why__text">{t.why}</p>
                            <div className="l1-why__chips">
                              <ReasonChips thread={t} />
                              {t.deadline && (
                                <span className="lab-chip lab-chip--now lab-num">
                                  {t.deadline.label} {t.deadline.when}
                                </span>
                              )}
                            </div>
                          </div>

                          {open && (
                            <div className="lab-fade-in">
                              {t.deadline && (
                                <div className="l1-clock">
                                  <span className="l1-clock__bar" aria-hidden="true">
                                    <span style={{ width: `${Math.max(6, Math.min(100, (t.deadline.hoursLeft / 168) * 100))}%` }} />
                                  </span>
                                  <span className="l1-clock__text lab-num">
                                    {t.deadline.hoursLeft < 48 ? `${t.deadline.hoursLeft}h left` : `${Math.round(t.deadline.hoursLeft / 24)} days left`} — {t.deadline.when}
                                  </span>
                                </div>
                              )}

                              {t.suggested && (
                                <div className="l1-suggest">
                                  <span className="lab-kicker">Alpha's suggestion</span>
                                  <div className="l1-suggest__row">
                                    <div>
                                      <div className="l1-suggest__label">{t.suggested.label}</div>
                                      <p className="lab-note">{t.suggested.detail}</p>
                                    </div>
                                    <div className="l1-suggest__actions">
                                      {t.draft ? (
                                        <button
                                          type="button"
                                          className="lab-btn lab-btn--primary lab-btn--sm"
                                          onClick={() => setOpenDraft(draftOpen ? null : t.id)}
                                        >
                                          {draftOpen ? 'Hide draft' : 'Review draft'}
                                        </button>
                                      ) : (
                                        <button type="button" className="lab-btn lab-btn--primary lab-btn--sm" onClick={() => setOpenOriginal(t.id)}>
                                          Read thread
                                        </button>
                                      )}
                                      <button type="button" className="lab-btn lab-btn--quiet lab-btn--sm" onClick={() => fileQuietly(t)}>
                                        Not now
                                      </button>
                                    </div>
                                  </div>
                                </div>
                              )}

                              {draftOpen && t.draft && (
                                <div className="l1-draft lab-fade-in">
                                  <div className="l1-draft__head">
                                    <span className="lab-kicker">Draft written by Alpha</span>
                                    <span className="lab-note">Edit anything. Nothing sends until you say so.</span>
                                  </div>
                                  <div className="l1-draft__field">
                                    <span className="l1-draft__label">To</span>
                                    <span className="l1-draft__value">{t.from.name} &lt;{t.from.email}&gt;</span>
                                  </div>
                                  <div className="l1-draft__field">
                                    <span className="l1-draft__label">Subject</span>
                                    <span className="l1-draft__value">{t.draft.subject}</span>
                                  </div>
                                  <textarea
                                    className="l1-draft__text"
                                    aria-label="Draft body"
                                    value={body}
                                    rows={7}
                                    onChange={(e) => setDrafts((d) => ({ ...d, [t.id]: e.target.value }))}
                                  />
                                  {t.alts && (
                                    <div className="l1-draft__alts">
                                      <span className="lab-note">Other angles:</span>
                                      {t.alts.map((a) => (
                                        <button
                                          key={a.label}
                                          type="button"
                                          className="lab-btn lab-btn--sm"
                                          onClick={() => setDrafts((d) => ({ ...d, [t.id]: a.body }))}
                                        >
                                          {a.label}
                                        </button>
                                      ))}
                                    </div>
                                  )}
                                  <div className="l1-draft__send">
                                    <button type="button" className="lab-btn lab-btn--primary" onClick={() => sendDraft(t)}>
                                      Send reply
                                    </button>
                                    <span className="lab-note">Sending moves this to Waiting and starts the follow-up clock.</span>
                                  </div>
                                </div>
                              )}

                              <button
                                type="button"
                                className="l1-original__toggle"
                                aria-expanded={openOriginal === t.id}
                                onClick={() => setOpenOriginal(openOriginal === t.id ? null : t.id)}
                              >
                                {openOriginal === t.id ? '−' : '+'} Read the original
                                {t.threadCount && t.threadCount > 1 ? ` (${t.threadCount} messages)` : ''}
                              </button>
                              {openOriginal === t.id && (
                                <div className="l1-original lab-fade-in">
                                  <p className="l1-original__snippet">{t.snippet}</p>
                                  {t.body.map((p, i) => (
                                    <p key={i} className="l1-original__p">
                                      {p}
                                    </p>
                                  ))}
                                </div>
                              )}
                            </div>
                          )}
                        </div>
                      </article>
                    )
                  })}
                </div>
              </>
            )}

            {state === 'waiting' && (
              <>
                <div className="l1-head">
                  <div>
                    <h2 className="lab-title">Waiting on other people</h2>
                    <p className="lab-body">
                      You already did your part. Alpha watches the clock and offers a nudge when your line passes
                      {overdue ? ` — ${overdue} past it now.` : '.'}
                    </p>
                  </div>
                </div>

                <div className="l1-list">
                  {groups.waiting.map((t) => (
                    <article key={t.id} className={`lab-card l1-wait${t.waiting?.overdue ? ' is-overdue' : ''}`}>
                      <div className="l1-wait__row">
                        <SenderAvatar thread={t} />
                        <div className="l1-wait__id">
                          <div className="l1-wait__what">{t.waiting?.what}</div>
                          <div className="l1-wait__meta">
                            <span className="lab-note">{t.from.name}{t.from.org ? ` · ${t.from.org}` : ''}</span>
                            <span className="l1-wait__dot" aria-hidden="true" />
                            <span className="lab-note lab-num">
                              {t.waiting?.days === 0 ? t.waiting.since : `${t.waiting?.days} days`}
                            </span>
                            <span className="l1-wait__dot" aria-hidden="true" />
                            <span className="lab-note">{t.waiting?.expectBy}</span>
                          </div>
                        </div>
                        <span className={`lab-chip ${t.waiting?.overdue ? 'lab-chip--risk' : 'lab-chip--wait'}`}>
                          {t.waiting?.overdue ? 'past your line' : 'on track'}
                        </span>
                        <div className="l1-wait__actions">
                          <button
                            type="button"
                            className={`lab-btn lab-btn--sm${t.waiting?.overdue ? ' lab-btn--primary' : ''}`}
                            onClick={() => setNudging(nudging === t.id ? null : t.id)}
                          >
                            {t.nudge ? (nudging === t.id ? 'Hide nudge' : 'Nudge') : 'Read'}
                          </button>
                          <button
                            type="button"
                            className="lab-btn lab-btn--quiet lab-btn--sm"
                            onClick={() =>
                              setThreads((prev) => prev.filter((x) => x.id !== t.id))
                            }
                          >
                            Close
                          </button>
                        </div>
                      </div>

                      {nudging === t.id && t.nudge && (
                        <div className="l1-draft lab-fade-in">
                          <div className="l1-draft__head">
                            <span className="lab-kicker">Nudge draft</span>
                            <span className="lab-note">Short, warm, and it does not mention money unless you say so.</span>
                          </div>
                          <textarea
                            className="l1-draft__text"
                            aria-label="Nudge body"
                            rows={6}
                            value={drafts[`n-${t.id}`] ?? t.nudge.body}
                            onChange={(e) => setDrafts((d) => ({ ...d, [`n-${t.id}`]: e.target.value }))}
                          />
                          <div className="l1-draft__send">
                            <button type="button" className="lab-btn lab-btn--primary" onClick={() => sendNudge(t)}>
                              Send nudge
                            </button>
                            <span className="lab-note">Alpha will not nudge this person again for four days.</span>
                          </div>
                        </div>
                      )}
                    </article>
                  ))}
                </div>

                <div className="l1-promise">
                  <span className="l1-promise__mark" aria-hidden="true">
                    ◎
                  </span>
                  <p>
                    Alpha only ever chases threads <strong>you started</strong>, once every four days, and never more
                    than twice without asking. If someone new needs chasing, it asks first.
                  </p>
                </div>
              </>
            )}

            {state === 'later' && (
              <>
                <div className="l1-head">
                  <div>
                    <h2 className="lab-title">{groups.later.length} filed quietly</h2>
                    <p className="lab-body">
                      Nobody was waiting on you in any of these. Alpha keeps them out of your way and keeps every one of
                      them retrievable.
                    </p>
                  </div>
                </div>

                <div className="l1-buckets">
                  {buckets.map((g) => {
                    const open = openBuckets.includes(g.bucket)
                    return (
                      <section key={g.bucket} className="lab-panel l1-bucket">
                        <button
                          type="button"
                          className="l1-bucket__head"
                          aria-expanded={open}
                          onClick={() =>
                            setOpenBuckets((prev) => (prev.includes(g.bucket) ? prev.filter((b) => b !== g.bucket) : [...prev, g.bucket]))
                          }
                        >
                          <span className="l1-bucket__chev">{open ? '−' : '+'}</span>
                          <span className="l1-bucket__name">{g.bucket}</span>
                          <span className="l1-bucket__count lab-num">{g.items.length}</span>
                          <span className="l1-bucket__hint">{g.items.map((i) => i.from.name).slice(0, 3).join(', ')}</span>
                        </button>
                        {open && (
                          <ul className="l1-bucket__list lab-fade-in">
                            {g.items.map((t) => (
                              <li key={t.id} className="l1-file">
                                <SenderAvatar thread={t} small />
                                <div className="l1-file__id">
                                  <div className="l1-file__subject">{t.subject}</div>
                                  <div className="lab-note">{t.filed?.note}</div>
                                </div>
                                <span className="lab-note l1-file__arrived lab-num">{t.arrived}</span>
                                <button type="button" className="lab-btn lab-btn--quiet lab-btn--sm" onClick={() => bringBack(t)}>
                                  Bring back
                                </button>
                              </li>
                            ))}
                          </ul>
                        )}
                      </section>
                    )
                  })}
                </div>

                <div className="l1-promise">
                  <span className="l1-promise__mark" aria-hidden="true">
                    ◎
                  </span>
                  <p>
                    Filing is a judgement, so Alpha shows the judgement: every item above says <em>why</em> it was filed.
                    If Alpha ever files something from a person who was waiting on you, that is a bug — and there is an
                    undo at the top of this screen for seven days.
                  </p>
                </div>
              </>
            )}
          </main>

          {/* ── Trust rail: what Alpha may do alone, and what it did today ── */}
          <aside className="l1-rail">
            <section className="lab-card l1-rail__card">
              <header className="l1-rail__head">
                <span className="lab-kicker">Alpha's rules</span>
                <span className="lab-note">You can change these any time</span>
              </header>
              <ul className="l1-rules">
                {rules.map((r) => (
                  <li key={r.id} className={`l1-rule${r.locked ? ' is-locked' : ''}`}>
                    <div className="l1-rule__row">
                      <button
                        type="button"
                        role="switch"
                        aria-checked={r.on}
                        aria-label={r.label}
                        className="lab-switch"
                        disabled={!!r.locked}
                        onClick={() => toggleRule(r.id)}
                      />
                      <span className="l1-rule__label">{r.label}</span>
                    </div>
                    <p className="lab-note l1-rule__detail">{r.detail}</p>
                    <p className={`l1-rule__live${r.on ? ' is-on' : ''}`}>{r.on ? r.live : r.locked ?? 'Off'}</p>
                  </li>
                ))}
              </ul>
            </section>

            <section className="lab-card l1-rail__card">
              <header className="l1-rail__head">
                <span className="lab-kicker">Today</span>
                <span className="lab-note">Alpha's ledger</span>
              </header>
              <ul className="l1-ledger">
                <li>
                  <span>Emails read</span>
                  <span className="lab-num">31</span>
                </li>
                <li>
                  <span>Filed without asking</span>
                  <span className="lab-num">{groups.later.length}</span>
                </li>
                <li>
                  <span>Replies drafted</span>
                  <span className="lab-num">{TALLY.drafted}</span>
                </li>
                <li>
                  <span>Follow-ups watched</span>
                  <span className="lab-num">{groups.waiting.length}</span>
                </li>
                <li className="l1-ledger__zero">
                  <span>Sent without you</span>
                  <span className="lab-num">0</span>
                </li>
              </ul>
            </section>

            <section className="lab-card l1-rail__card l1-rail__card--rules">
              <header className="l1-rail__head">
                <span className="lab-kicker">Hard limits</span>
              </header>
              <ul className="l1-hard">
                {HARD_RULES.map((r) => (
                  <li key={r}>{r}</li>
                ))}
              </ul>
            </section>
          </aside>
        </div>
      </div>

      {toast && (
        <div className="lab-toast" role="status">
          <span>{toast.text}</span>
          <button
            type="button"
            className="lab-btn lab-btn--sm"
            onClick={() => {
              toast.undo()
              setToast(null)
            }}
          >
            Undo
          </button>
        </div>
      )}
    </div>
  )
}
