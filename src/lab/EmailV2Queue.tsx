import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { AlphaFace } from '../AlphaFace'
import {
  CHIP_LABELS,
  LATER,
  NOW,
  THREADS,
  TODAY,
  WAITING,
  avatarTint,
  initials,
  type MailThread,
} from './labData'
import './lab.css'
import './emailV2.css'

/* V2 — Reply Queue
 *
 * The organising idea: replying is the only part of email that actually costs
 * the user time, so Alpha builds one queue of exactly the threads that need a
 * reply, writes the draft for each, and serves them one card at a time. Every
 * send opens a follow-up Alpha then tracks. The product is a stack of
 * decisions, not a list of messages.
 */

type Disposition = 'sent' | 'skipped' | 'later'

type FollowUp = { id: string; who: string; what: string; expectBy: string; days: number; overdue: boolean; nudge?: string }

const AUTOPILOT = [
  {
    n: 1,
    title: 'Sort, file, and summarise',
    state: 'on' as const,
    detail: 'Reads everything so you read almost nothing. Never touches a thread from a person who is waiting on you.',
  },
  {
    n: 2,
    title: 'Draft replies',
    state: 'on' as const,
    detail: 'Every card in this queue arrives with a draft. You edit and send, or send as is.',
  },
  {
    n: 3,
    title: 'Send routine confirmations',
    state: 'locked' as const,
    detail: 'Limited to scheduling and acknowledgement replies, capped at five a day, always reversible.',
    progress: [14, 50],
  },
  {
    n: 4,
    title: 'Full autopilot for one sender',
    state: 'locked' as const,
    detail: 'Never a global setting. You enable it per person, and only after level 3 has been on for a month.',
  },
]

const QUEUE_CAP = 7

/** Deterministic, explainable rewrite — the prototype shows what changed rather
 *  than pretending a model is thinking. */
function rewrite(t: MailThread, body: string, instruction: string): { body: string; note: string } {
  const i = instruction.trim().toLowerCase()
  const alt = t.alts?.find((a) => i.includes(a.label.toLowerCase()) || a.label.toLowerCase().includes(i))
  if (alt) return { body: alt.body, note: `Switched to the “${alt.label}” angle.` }

  const paras = body.split(/\n{2,}/)
  if (/short|trim|brief|tight|concise/.test(i) && paras.length > 2) {
    const kept = [paras[0], ...paras.slice(-1)]
    return { body: kept.join('\n\n'), note: `Made it shorter — dropped ${paras.length - 2} paragraph${paras.length - 2 === 1 ? '' : 's'}.` }
  }
  if (/warm|friend|softer|kind/.test(i)) {
    return { body: body.replace(/^(Hi [^,\n]+,\n)/, '$1\nThanks for the note — this is genuinely welcome.\n'), note: 'Warmed the opening.' }
  }
  if (/formal|professional|stiff/.test(i)) {
    return { body: body.replace(/^Hey\b/m, 'Dear').replace(/^—\s*(.+)$/m, 'Best regards,\n$1'), note: 'Made it more formal.' }
  }
  if (/question|ask|close/.test(i)) {
    return { body: `${body}\n\nOne question before then: is there anything you want me to bring or prepare?`, note: 'Added a closing question.' }
  }
  return { body, note: 'Nothing matched that instruction — the draft is unchanged.' }
}

export function EmailV2Queue() {
  const [queue, setQueue] = useState<string[]>(NOW.map((t) => t.id))
  const [served, setServed] = useState<Record<Disposition, string[]>>({ sent: [], skipped: [], later: [] })
  const [drafts, setDrafts] = useState<Record<string, string>>({})
  const [showWhy, setShowWhy] = useState(false)
  const [askText, setAskText] = useState('')
  const [rewriteNote, setRewriteNote] = useState<string | null>(null)
  const [followUps, setFollowUps] = useState<FollowUp[]>(
    WAITING.map((t) => ({
      id: t.id,
      who: t.from.name,
      what: t.waiting?.what ?? '',
      expectBy: t.waiting?.expectBy ?? '',
      days: t.waiting?.days ?? 0,
      overdue: !!t.waiting?.overdue,
      nudge: t.nudge?.body,
    })),
  )
  const [openNotQueued, setOpenNotQueued] = useState(false)
  const [nudged, setNudged] = useState<string[]>([])
  const [toast, setToast] = useState<{ text: string; undo?: () => void } | null>(null)
  const [elapsed, setElapsed] = useState(0)
  const bodyRef = useRef<HTMLTextAreaElement | null>(null)

  const byId = useMemo(() => new Map(THREADS.map((t) => [t.id, t])), [])
  const current = queue.length > 0 ? byId.get(queue[0]!) : undefined
  const upNext = queue.slice(1, 3).map((id) => byId.get(id)!).filter(Boolean)
  const total = NOW.length
  const doneCount = total - queue.length
  const body = current ? drafts[current.id] ?? current.draft?.body ?? '' : ''

  useEffect(() => {
    const timer = window.setInterval(() => setElapsed((s) => s + 1), 1000)
    return () => window.clearInterval(timer)
  }, [])

  const advance = useCallback(
    (disposition: Disposition) => {
      setQueue((q) => q.slice(1))
      setServed((s) => ({ ...s, [disposition]: [...s[disposition], queue[0] ?? ''] }))
      setShowWhy(false)
      setAskText('')
      setRewriteNote(null)
    },
    [queue],
  )

  const send = useCallback(() => {
    if (!current) return
    const t = current
    const sentBody = drafts[t.id] ?? t.draft?.body ?? ''
    setFollowUps((f) => [
      {
        id: `f-${t.id}`,
        who: t.from.name,
        what: `Your reply${t.ask ? ` about ${t.ask.split(/[.,]/)[0]!.toLowerCase()}` : ''}`,
        expectBy: t.from.vip ? 'Alpha checks tomorrow — you usually hear back same day' : 'Alpha checks in 2 days',
        days: 0,
        overdue: false,
      },
      ...f,
    ])
    advance('sent')
    setToast({
      text: `Sent to ${t.from.name.split(' ')[0]}. Follow-up opened — Alpha will chase if nothing comes back.`,
      undo: () => {
        setQueue((q) => [t.id, ...q])
        setServed((s) => ({ ...s, sent: s.sent.slice(0, -1) }))
        setFollowUps((f) => f.filter((x) => x.id !== `f-${t.id}`))
        setDrafts((d) => ({ ...d, [t.id]: sentBody }))
      },
    })
  }, [advance, current, drafts])

  const skip = useCallback(() => {
    if (!current) return
    const t = current
    advance('skipped')
    setToast({
      text: `Skipped ${t.from.name.split(' ')[0]}. It goes back to Later, not into a void.`,
      undo: () => {
        setQueue((q) => [t.id, ...q])
        setServed((s) => ({ ...s, skipped: s.skipped.slice(0, -1) }))
      },
    })
  }, [advance, current])

  const shelve = useCallback(() => {
    if (!current) return
    const t = current
    advance('later')
    setToast({ text: `Kept for this afternoon. Alpha will put it back in front of you at 4pm.`, undo: () => setQueue((q) => [t.id, ...q]) })
  }, [advance, current])

  useEffect(() => {
    if (!toast) return
    const id = window.setTimeout(() => setToast(null), 9000)
    return () => window.clearTimeout(id)
  }, [toast])

  /* Keyboard is the whole point of a queue: one decision, one key. */
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const el = e.target as HTMLElement | null
      // A focused button owns its own Enter — otherwise every rail action would
      // also fire the card's send.
      if (el && (el.tagName === 'BUTTON' || el.tagName === 'A')) return
      const typing = !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA')
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey || !typing)) {
        e.preventDefault()
        send()
        return
      }
      if (typing || e.metaKey || e.ctrlKey || e.altKey) return
      if (e.key === 's') { e.preventDefault(); skip() }
      else if (e.key === 'l') { e.preventDefault(); shelve() }
      else if (e.key === 'e') { e.preventDefault(); bodyRef.current?.focus() }
      else if (e.key === 'z' && toast?.undo) { e.preventDefault(); toast.undo(); setToast(null) }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [send, skip, shelve, toast])

  function applyAsk() {
    if (!current || !askText.trim()) return
    const res = rewrite(current, body, askText)
    setDrafts((d) => ({ ...d, [current.id]: res.body }))
    setRewriteNote(res.note)
    setAskText('')
  }

  function nudge(f: FollowUp) {
    setNudged((n) => [...n, f.id])
    setToast({ text: `Nudge sent to ${f.who.split(' ')[0]}. Alpha will not chase again for four days.` })
    setFollowUps((all) => all.map((x) => (x.id === f.id ? { ...x, days: 0, overdue: false, expectBy: 'Nudged just now — checking Thursday' } : x)))
  }

  /* Time shown is real once the user has been in the queue long enough to
   * measure, and a 55-seconds-per-card estimate before that. */
  const minutes = elapsed >= 30 ? Math.max(1, Math.round(elapsed / 60)) : Math.max(1, Math.round((queue.length * 55) / 60))
  const notQueued = LATER.length

  return (
    <div className="lab l2">
      <div className="l2-shell">
        <header className="lab-topbar">
          <AlphaFace color="#2a6f7a" mood="soft" size={34} />
          <div className="lab-brand">
            <div className="lab-brand__name">Alpha · Reply queue</div>
            <div className="lab-brand__role">
              Built {TODAY} at 7:32am from 31 emails · {queue.length} card{queue.length === 1 ? '' : 's'} left
            </div>
          </div>
          <div className="lab-topbar__spacer" />
          <span className="lab-badge">Prototype v2</span>
        </header>

        <div className="l2-grid">
          <main className="l2-main">
            {/* Progress reads as "you are nearly done", never as an unread count. */}
            <div className="l2-progress">
              <div className="l2-progress__track" role="progressbar" aria-valuenow={doneCount} aria-valuemax={total}>
                {Array.from({ length: total }).map((_, i) => {
                  const disposition: Disposition | null =
                    i < served.sent.length ? 'sent' : i < served.sent.length + served.skipped.length ? 'skipped' : i < doneCount ? 'later' : null
                  return <span key={i} className={`l2-seg${disposition ? ` is-${disposition}` : ''}${i === doneCount ? ' is-current' : ''}`} />
                })}
              </div>
              <span className="l2-progress__label lab-num">
                {doneCount} of {total} · about {minutes} min
              </span>
            </div>

            {current ? (
              <>
                <div className="l2-deck">
                  {upNext.slice().reverse().map((t, i) => (
                    <div key={t.id} className={`l2-ghost l2-ghost--${upNext.length - i}`} aria-hidden="true">
                      <span className="lab-avatar lab-avatar--sm" style={{ background: avatarTint(t.from.hue).bg, color: avatarTint(t.from.hue).fg }}>
                        {initials(t.from.name)}
                      </span>
                      <span className="l2-ghost__text">{t.summary}</span>
                    </div>
                  ))}

                  <article className="lab-card l2-card" key={current.id}>
                    <header className="l2-card__head">
                      <span className="lab-avatar" style={{ background: avatarTint(current.from.hue).bg, color: avatarTint(current.from.hue).fg }}>
                        {initials(current.from.name)}
                      </span>
                      <div className="l2-card__who">
                        <div className="l2-card__name">
                          {current.from.name}
                          {current.from.vip && <span className="l2-card__vip">you usually reply</span>}
                        </div>
                        <div className="lab-note">
                          {current.from.org ?? current.from.email} · {current.arrived}
                          {current.threadCount && current.threadCount > 1 ? ` · ${current.threadCount} messages` : ''}
                        </div>
                      </div>
                      <button type="button" className="lab-btn lab-btn--quiet lab-btn--sm" aria-expanded={showWhy} onClick={() => setShowWhy((v) => !v)}>
                        Why is this here?
                      </button>
                    </header>

                    {showWhy && (
                      <div className="l2-why lab-fade-in">
                        <p className="l2-why__lead">
                          Scored <strong>0.91</strong> — the top of your queue. Anything under 0.55 goes to Later instead.
                        </p>
                        <ul className="l2-why__list">
                          <li>Deadline language in the thread — “hold until Thursday”.</li>
                          <li>You usually answer {current.from.name.split(' ')[0]} within three hours.</li>
                          <li>Nobody else can choose the time; a draft from Alpha cannot close this.</li>
                          {current.reasons.includes('money') && <li>Money is involved, so Alpha will not act alone.</li>}
                        </ul>
                        <div className="l2-why__chips">
                          {current.reasons.map((r) => (
                            <span key={r} className="lab-chip lab-chip--now">
                              {CHIP_LABELS[r]}
                            </span>
                          ))}
                        </div>
                      </div>
                    )}

                    <div className="l2-ask">
                      <span className="lab-kicker">They are asking for</span>
                      <p className="l2-ask__text">{current.ask ?? current.summary}</p>
                    </div>

                    <p className="l2-context">{current.summary}</p>
                    <p className="l2-whypoint">{current.why}</p>

                    {current.deadline && (
                      <div className="l2-deadline">
                        <span className="l2-deadline__dot" aria-hidden="true" />
                        <span className="lab-num">
                          {current.deadline.label} {current.deadline.when}
                        </span>
                        <span className="lab-note">
                          {current.deadline.hoursLeft < 48 ? `${current.deadline.hoursLeft} hours` : `${Math.round(current.deadline.hoursLeft / 24)} days`} — the only thing in
                          this queue with a hard clock on it
                        </span>
                      </div>
                    )}

                    <div className="l2-draft">
                      <div className="l2-draft__head">
                        <span className="lab-kicker">Alpha drafted this</span>
                        <span className="lab-note">Send as is, or change anything first.</span>
                      </div>
                      <div className="l2-draft__fields">
                        <div className="l2-draft__field">
                          <span className="l2-draft__label">To</span>
                          <span className="l2-draft__value">{current.from.email}</span>
                        </div>
                        <div className="l2-draft__field">
                          <span className="l2-draft__label">Subject</span>
                          <span className="l2-draft__value">{current.draft?.subject}</span>
                        </div>
                      </div>
                      <textarea
                        ref={bodyRef}
                        className="l2-draft__text"
                        aria-label="Reply draft"
                        rows={8}
                        value={body}
                        onChange={(e) => setDrafts((d) => ({ ...d, [current.id]: e.target.value }))}
                      />
                      {rewriteNote && <p className="l2-draft__note lab-fade-in">Alpha: {rewriteNote}</p>}
                      <div className="l2-draft__tools">
                        <div className="l2-draft__alts">
                          {(current.alts ?? []).map((a) => (
                            <button
                              key={a.label}
                              type="button"
                              className="lab-btn lab-btn--sm"
                              onClick={() => {
                                setDrafts((d) => ({ ...d, [current.id]: a.body }))
                                setRewriteNote(`Switched to the “${a.label}” angle.`)
                              }}
                            >
                              {a.label}
                            </button>
                          ))}
                        </div>
                        <div className="l2-draft__ask">
                          <input
                            className="l2-draft__input"
                            placeholder="Ask Alpha to change anything…"
                            aria-label="Ask Alpha to change the draft"
                            value={askText}
                            onChange={(e) => setAskText(e.target.value)}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter') {
                                e.preventDefault()
                                applyAsk()
                              }
                            }}
                          />
                          <button type="button" className="lab-btn lab-btn--sm" disabled={!askText.trim()} onClick={applyAsk}>
                            Apply
                          </button>
                        </div>
                      </div>
                    </div>

                    <footer className="l2-actions">
                      <button type="button" className="lab-btn lab-btn--primary l2-send" onClick={send}>
                        Send <kbd>↵</kbd>
                      </button>
                      <button type="button" className="lab-btn" onClick={skip}>
                        Skip <kbd>S</kbd>
                      </button>
                      <button type="button" className="lab-btn lab-btn--quiet" onClick={shelve}>
                        Later today <kbd>L</kbd>
                      </button>
                      <span className="l2-actions__hint lab-note">
                        Everything Alpha sends is reversible for 10 seconds. Nothing leaves your account without this key.
                      </span>
                    </footer>
                  </article>
                </div>

                <p className="l2-sublabel lab-note">
                  {upNext.length > 0 ? `Next up: ${upNext.map((t) => t.from.name).join(', ')}` : 'Last card in the queue.'} · Queue never
                  exceeds {QUEUE_CAP} cards and closes after 20 minutes so it cannot become an inbox.
                </p>
              </>
            ) : (
              <section className="lab-card l2-done lab-fade-in">
                <AlphaFace color="#2a6f7a" mood="soft" size={44} />
                <h2 className="lab-display l2-done__title">Queue clear.</h2>
                <p className="l2-done__line">
                  Nobody is waiting on you. Alpha opened {served.sent.length} follow-up{served.sent.length === 1 ? '' : 's'} from what you just sent and will
                  surface them the moment a reply lands or the clock runs out.
                </p>
                <div className="l2-done__stats">
                  <div>
                    <span className="lab-num">{served.sent.length}</span>
                    <span className="lab-note">sent</span>
                  </div>
                  <div>
                    <span className="lab-num">{served.skipped.length}</span>
                    <span className="lab-note">skipped</span>
                  </div>
                  <div>
                    <span className="lab-num">{served.later.length}</span>
                    <span className="lab-note">back later today</span>
                  </div>
                  <div>
                    <span className="lab-num">{minutes}m</span>
                    <span className="lab-note">in total</span>
                  </div>
                </div>
                <div className="l2-done__actions">
                  <button
                    type="button"
                    className="lab-btn lab-btn--primary"
                    onClick={() => {
                      setQueue(NOW.map((t) => t.id))
                      setServed({ sent: [], skipped: [], later: [] })
                      setElapsed(0)
                    }}
                  >
                    Rebuild the queue
                  </button>
                  <span className="lab-note">Next automatic build at 12:30pm — you will get one line in chat, not a notification per email.</span>
                </div>
              </section>
            )}
          </main>

          {/* ── Kept-out rail: the noise Alpha absorbed, plus what it may do alone ── */}
          <aside className="l2-rail">
            <section className="lab-card l2-rail__card">
              <header className="l2-rail__head">
                <span className="lab-kicker">Follow-ups you are tracking</span>
                <span className="lab-note">{followUps.length} open · Alpha chases the ones past your line</span>
              </header>
              <ul className="l2-follow">
                {followUps.slice(0, 6).map((f) => (
                  <li key={f.id} className={`l2-follow__item${f.overdue ? ' is-overdue' : ''}`}>
                    <div className="l2-follow__row">
                      <span className="l2-follow__who">{f.who}</span>
                      <span className={`l2-follow__days lab-num${f.overdue ? ' is-overdue' : ''}`}>
                        {f.days === 0 ? 'today' : `${f.days}d`}
                      </span>
                    </div>
                    <div className="lab-note l2-follow__what">{f.what}</div>
                    <div className="l2-follow__foot">
                      <span className="lab-note">{f.expectBy}</span>
                      {f.nudge && (
                        <button
                          type="button"
                          className={`lab-btn lab-btn--sm${f.overdue ? ' lab-btn--primary' : ''}`}
                          disabled={nudged.includes(f.id)}
                          onClick={() => nudge(f)}
                        >
                          {nudged.includes(f.id) ? 'Nudged' : 'Nudge'}
                        </button>
                      )}
                    </div>
                  </li>
                ))}
              </ul>
            </section>

            <section className="lab-card l2-rail__card">
              <button type="button" className="l2-notqueued__head" aria-expanded={openNotQueued} onClick={() => setOpenNotQueued((v) => !v)}>
                <span className="lab-kicker">Kept out of your queue</span>
                <span className="l2-notqueued__count lab-num">{notQueued}</span>
              </button>
              <p className="lab-note l2-notqueued__line">
                {notQueued} threads never reached you today. Receipts, alerts, invites, and mail where nobody asked a question.
              </p>
              {openNotQueued && (
                <ul className="l2-notqueued__list lab-fade-in">
                  {LATER.map((t) => (
                    <li key={t.id}>
                      <span className="l2-notqueued__subj">{t.subject}</span>
                      <span className="lab-note">{t.filed?.bucket}</span>
                    </li>
                  ))}
                </ul>
              )}
              <p className="l2-notqueued__proof lab-note">
                Alpha has no rule that files a person who is waiting on you. If it ever does, it tells you the same day.
              </p>
            </section>

            <section className="lab-card l2-rail__card">
              <header className="l2-rail__head">
                <span className="lab-kicker">How much Alpha may do alone</span>
              </header>
              <ol className="l2-ladder">
                {AUTOPILOT.map((rung) => (
                  <li key={rung.n} className={`l2-rung is-${rung.state}`}>
                    <span className="l2-rung__dot" aria-hidden="true" />
                    <div className="l2-rung__body">
                      <div className="l2-rung__title">
                        {rung.title}
                        <span className="l2-rung__tag">{rung.state === 'on' ? 'on' : 'locked'}</span>
                      </div>
                      <p className="lab-note">{rung.detail}</p>
                      {rung.progress && (
                        <div className="l2-rung__progress">
                          <span className="l2-rung__bar" aria-hidden="true">
                            <span style={{ width: `${(rung.progress[0] / rung.progress[1]) * 100}%` }} />
                          </span>
                          <span className="lab-note lab-num">
                            {rung.progress[0]}/{rung.progress[1]} reviewed sends
                          </span>
                        </div>
                      )}
                    </div>
                  </li>
                ))}
              </ol>
            </section>
          </aside>
        </div>

        <footer className="l2-legend">
          {[
            ['↵', 'send'],
            ['E', 'edit draft'],
            ['S', 'skip'],
            ['L', 'later today'],
            ['Z', 'undo'],
          ].map(([k, label]) => (
            <span key={k} className="l2-legend__item">
              <kbd>{k}</kbd>
              {label}
            </span>
          ))}
        </footer>
      </div>

      {toast && (
        <div className="lab-toast" role="status">
          <span>{toast.text}</span>
          {toast.undo && (
            <button
              type="button"
              className="lab-btn lab-btn--sm"
              onClick={() => {
                toast.undo?.()
                setToast(null)
              }}
            >
              Undo
            </button>
          )}
        </div>
      )}
    </div>
  )
}
