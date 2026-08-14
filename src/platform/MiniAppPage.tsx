import { useEffect, useState, type CSSProperties } from 'react'
import { Link, useParams, useSearchParams } from 'react-router-dom'
import { getAgent } from '../agents'
import type { AgentId } from '../agents/types'
import { apiSetup } from './api'
import { getSession } from './roster'

interface DigestData {
  date?: string
  calendar?: string[]
  emails?: string[]
  reminders?: Array<{ time?: string; text?: string }>
  error?: string
}

interface MiniSection {
  heading: string
  items: string[]
}

interface MiniPayload {
  title?: string
  date?: string
  sections?: MiniSection[]
  paste?: string
  text?: string
  error?: string
}

const LIVE_MINI_KINDS = new Set(['digest', 'pick_night', 'standup_paste', 'kill_keep_park'])

interface MenuFeature {
  kind: string
  title: string
  emoji: string
  blurb: string
  sample?: string
}

const MENU_FEATURES: Record<string, MenuFeature[]> = {
  friend: [
    { kind: 'digest', title: 'Morning brief', emoji: '☀️', blurb: 'Calendar, important mail, and reminders every morning.' },
    { kind: 'check_in', title: 'Check-in', emoji: '👋', blurb: 'A quick pulse on how you are doing.' },
    { kind: 'pick_night', title: "Tonight's plan", emoji: '🌙', blurb: 'Plans, options, and a call on what to do.', sample: 'what should we do tonight' },
    { kind: 'spiral_options', title: 'Options', emoji: '🌀', blurb: 'Step back and look at the options.', sample: "i'm spiraling" },
  ],
  coworker: [
    { kind: 'digest', title: 'Morning brief', emoji: '☀️', blurb: 'Calendar, important mail, and reminders every morning.' },
    { kind: 'approve_send', title: 'Approve & send', emoji: '✉️', blurb: 'Review drafts before they go out.', sample: 'approve the email' },
    { kind: 'pick_slot', title: 'Pick a slot', emoji: '🗓️', blurb: 'Compare times and pick what works.', sample: 'pick a slot for the review' },
    { kind: 'standup_paste', title: 'Standup', emoji: '📋', blurb: 'Raw notes in, tight standup out.', sample: 'standup' },
    { kind: 'linear_triage', title: 'Linear triage', emoji: '🎯', blurb: 'Issues and backlog, triaged.', sample: 'triage the backlog' },
  ],
  cofounder: [
    { kind: 'digest', title: 'Morning brief', emoji: '☀️', blurb: 'Calendar, important mail, and reminders every morning.' },
    { kind: 'weekly_focus', title: 'Weekly focus', emoji: '🧭', blurb: 'What to actually focus on this week.', sample: 'what is my weekly focus' },
    { kind: 'kill_keep_park', title: 'Kill · Keep · Park', emoji: '⚖️', blurb: 'Decide what to kill, keep, or park.', sample: 'kill keep park' },
    { kind: 'hire_decision', title: 'Hire decision', emoji: '🤝', blurb: 'The call on the candidate.', sample: 'should we hire them' },
    { kind: 'approve_investor_note', title: 'Investor note', emoji: '💼', blurb: 'Review the note before it goes out.', sample: 'review the investor note' },
  ],
}

const KIND_TITLES: Record<string, { title: string; blurb: string }> = {
  menu: { title: 'What do you want from me?', blurb: 'Pick a feature and I will set it up. You can change anytime.' },
  digest: { title: 'Morning brief', blurb: 'Your day at a glance — calendar, important mail, and reminders.' },
  approve_send: { title: 'Approve & send', blurb: 'Review the draft and approve it to send.' },
  pick_slot: { title: 'Pick a slot', blurb: 'Compare meeting times and pick the one that works.' },
  pick_night: { title: 'Pick the night', blurb: 'Plans, options, and a call on what to do.' },
  check_in: { title: 'Check-in', blurb: 'A quick pulse on how you are doing.' },
  standup_paste: { title: 'Standup', blurb: 'Your standup notes, tightened up.' },
  linear_triage: { title: 'Linear triage', blurb: 'Issues and backlog, triaged.' },
  kill_keep_park: { title: 'Kill · Keep · Park', blurb: 'Decide what to kill, keep, or park.' },
  hire_decision: { title: 'Hire decision', blurb: 'The call on the candidate.' },
  weekly_focus: { title: 'Weekly focus', blurb: 'What to focus on this week.' },
  approve_investor_note: { title: 'Investor note', blurb: 'Review the note before it goes out.' },
  spiral_options: { title: 'Options', blurb: 'Step back and look at the options.' },
}

export function MiniAppPage() {
  const { persona, kind } = useParams()
  const [searchParams] = useSearchParams()
  const token = searchParams.get('t') || ''
  const agent = getAgent((persona as AgentId) || 'friend')
  const kindInfo = KIND_TITLES[kind || ''] ?? {
    title: 'HireAlpha',
    blurb: 'Open from a text to continue.',
  }
  const [data, setData] = useState<DigestData | null>(null)
  const [mini, setMini] = useState<MiniPayload | null>(null)
  const [loading, setLoading] = useState(true)
  const [status, setStatus] = useState<'idle' | 'busy' | 'done' | 'error'>('idle')
  const [picked, setPicked] = useState<MenuFeature | null>(null)
  const [setupError, setSetupError] = useState('')
  const [expired, setExpired] = useState(false)

  const isDigest = kind === 'digest'
  const isMenu = kind === 'menu'
  const isLiveMini = LIVE_MINI_KINDS.has(kind || '')

  useEffect(() => {
    let cancelled = false
    if (!isLiveMini) {
      setLoading(false)
      return () => {
        cancelled = true
      }
    }
    if (!token && !getSession()?.email) {
      setLoading(false)
      return () => {
        cancelled = true
      }
    }
    setLoading(true)
    const qs = new URLSearchParams({ persona: persona || '' })
    if (token) qs.set('t', token)
    else qs.set('email', getSession()?.email || '')
    const url = isDigest ? `/api/digest?${qs}` : `/api/mini?${qs}&kind=${encodeURIComponent(kind || '')}`
    fetch(url)
      .then((res) =>
        res.ok ? (res.json() as Promise<DigestData & MiniPayload>) : Promise.reject({ status: res.status }),
      )
      .then((d) => {
        if (cancelled) return
        if (isDigest) setData(d)
        else setMini(d)
      })
      .catch((err) => {
        if (cancelled) return
        if (err && err.status === 401) {
          setExpired(true)
          return
        }
        if (isDigest) setData({ error: "Couldn't load your brief right now." })
        else setMini({ error: "Couldn't load this right now." })
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [kind, persona, token, isDigest, isLiveMini])

  const email = getSession()?.email
  const authed = !!token || !!email
  const features = MENU_FEATURES[persona || ''] ?? []

  async function choose(feature: MenuFeature) {
    if (!authed || status === 'busy') return
    setPicked(feature)
    setStatus('busy')
    setSetupError('')
    try {
      await apiSetup({
        persona: (persona as AgentId) || 'friend',
        feature: feature.kind,
        email: email || undefined,
        token: token || undefined,
      })
      setStatus('done')
    } catch (err) {
      const msg = err instanceof Error ? err.message : ''
      if (/expired/i.test(msg)) {
        setExpired(true)
      } else {
        setStatus('error')
        setSetupError(msg || 'Could not set that up right now.')
      }
    }
  }

  return (
    <div className="mini" style={{ '--mini-accent': agent.color } as CSSProperties}>
      <div className="mini__card">
        <header className="mini__head">
          <span className="mini__avatar" aria-hidden>
            {agent.initial}
          </span>
          <div className="mini__who">
            <p className="mini__name">{agent.imsgName}</p>
            <p className="mini__role">{isMenu ? 'Choose a feature' : isLiveMini ? kindInfo.title : agent.role}</p>
          </div>
          <span className="mini__brand">HireAlpha</span>
        </header>

        {!authed && (
          <div className="mini__body">
            <p className="mini__blurb">Sign in to use this with {agent.name}.</p>
            <Link className="mini__cta" to="/app/login">
              Sign in
            </Link>
          </div>
        )}

        {authed && expired && (
          <div className="mini__body">
            <p className="mini__blurb">This card's link expired.</p>
            <Link className="mini__cta" to="/app/login">
              Sign in to keep using it
            </Link>
          </div>
        )}

        {authed && !expired && isMenu && (
          <div className="mini__body">
            <p className="mini__blurb">Pick a feature and I will set it up. You can change anytime.</p>
            {status === 'done' && picked ? (
              <div className="mini__done">
                <p className="mini__done-title">
                  {picked.emoji} {picked.title}. Done.
                </p>
                <p className="mini__blurb">
                  {picked.kind === 'digest'
                    ? `${agent.imsgName} will text you a brief each morning at 8am.`
                    : picked.sample
                      ? `When you want it, text ${agent.imsgName}: “${picked.sample}”`
                      : 'All set.'}
                </p>
                {picked.sample && (
                  <a
                    className="mini__cta"
                    href={`sms:${agent.phoneNumber}?&body=${encodeURIComponent(picked.sample)}`}
                  >
                    Try it now
                  </a>
                )}
                <button type="button" className="mini__again" onClick={() => setStatus('idle')}>
                  Pick another
                </button>
              </div>
            ) : (
              <div className="mini__menu">
                {features.map((f) => (
                  <button
                    key={f.kind}
                    type="button"
                    className="mini__feature"
                    disabled={status === 'busy'}
                    onClick={() => void choose(f)}
                  >
                    <span className="mini__feature-emoji" aria-hidden>
                      {f.emoji}
                    </span>
                    <span className="mini__feature-text">
                      <span className="mini__feature-title">{f.title}</span>
                      <span className="mini__feature-blurb">{f.blurb}</span>
                    </span>
                  </button>
                ))}
                {status === 'error' && <p className="mini__empty">{setupError}</p>}
              </div>
            )}
          </div>
        )}

        {authed && !expired && isDigest && loading && (
          <div className="mini__body">
            <p className="mini__blurb">Pulling your day together…</p>
          </div>
        )}

        {authed && !expired && isDigest && !loading && data?.error && (
          <div className="mini__body">
            <p className="mini__blurb">{data.error}</p>
          </div>
        )}

        {authed && !expired && isDigest && !loading && !data?.error && (
          <div className="mini__body">
            <p className="mini__date">{data?.date}</p>

            <section className="mini__section">
              <h2>On your calendar</h2>
              {data?.calendar?.length ? (
                <ul className="mini__list">
                  {data.calendar.map((c, i) => (
                    <li key={i}>{c}</li>
                  ))}
                </ul>
              ) : (
                <p className="mini__empty">Nothing scheduled.</p>
              )}
            </section>

            <section className="mini__section">
              <h2>Important mail</h2>
              {data?.emails?.length ? (
                <ul className="mini__list">
                  {data.emails.map((e, i) => (
                    <li key={i}>{e}</li>
                  ))}
                </ul>
              ) : (
                <p className="mini__empty">Nothing flagged.</p>
              )}
            </section>

            <section className="mini__section">
              <h2>Reminders</h2>
              {data?.reminders?.length ? (
                <ul className="mini__list">
                  {data.reminders.map((r, i) => (
                    <li key={i}>
                      <span className="mini__time">{r.time}</span> {r.text}
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="mini__empty">No reminders lined up.</p>
              )}
            </section>
          </div>
        )}

        {authed && !expired && isLiveMini && !isDigest && loading && (
          <div className="mini__body">
            <p className="mini__blurb">Working it out…</p>
          </div>
        )}

        {authed && !expired && isLiveMini && !isDigest && !loading && mini?.error && (
          <div className="mini__body">
            <p className="mini__blurb">{mini.error}</p>
          </div>
        )}

        {authed && !expired && isLiveMini && !isDigest && !loading && !mini?.error && (
          <div className="mini__body">
            {mini?.date && <p className="mini__date">{mini.date}</p>}
            {mini?.sections?.map((s) => (
              <section key={s.heading} className="mini__section">
                <h2>{s.heading}</h2>
                {s.items?.length ? (
                  <ul className="mini__list">
                    {s.items.map((item, i) => (
                      <li key={i} style={{ whiteSpace: 'pre-wrap' }}>
                        {item}
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="mini__empty">Nothing here yet.</p>
                )}
              </section>
            ))}
            {mini?.paste && (
              <p className="mini__hint">Paste-ready. Text {agent.imsgName} if you want a different cut.</p>
            )}
          </div>
        )}

        {authed && !isMenu && !isLiveMini && (
          <div className="mini__body">
            <p className="mini__blurb">{kindInfo.blurb}</p>
            <p className="mini__hint">
              Text {agent.imsgName} back to keep going. This one is not live yet.
            </p>
          </div>
        )}
      </div>
    </div>
  )
}
