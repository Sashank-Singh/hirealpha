import { useEffect, useState, type CSSProperties } from 'react'
import { Link, useParams, useSearchParams } from 'react-router-dom'
import { getAgent } from '../agents'
import type { AgentId } from '../agents/types'
import { apiSetup, apiSetupStatus } from './api'
import { getSession } from './roster'
import {
  DecisionLedgerApp,
  DropZoneApp,
  HabitStreakApp,
  MeetingModeApp,
  MoodTrackerApp,
  NutritionApp,
  OpenLoopsApp,
  RelationshipRadarApp,
} from './FeatureMiniApps'

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

/** Feature kinds rendered by their own interactive component, not /api/mini. */
export const FEATURE_KINDS = new Set([
  'open_loops',
  'meeting_mode',
  'decision_ledger',
  'relationship_radar',
  'drop_zone',
  'nutrition',
  'habit_streak',
  'mood_tracker',
])

export interface MenuFeature {
  kind: string
  title: string
  emoji: string
  blurb: string
  sample?: string
}

export const MENU_FEATURES: Record<string, MenuFeature[]> = {
  friend: [
    { kind: 'digest', title: 'Morning brief', emoji: '☀️', blurb: 'Calendar, important mail, and reminders every morning.' },
    { kind: 'nutrition', title: 'Nutrition', emoji: '🥗', blurb: 'Snap a meal, see macros, hit your daily goals.', sample: 'i ate a chicken bowl' },
    { kind: 'habit_streak', title: 'Habits', emoji: '🔥', blurb: 'Build streaks. Track daily habits.' },
    { kind: 'mood_tracker', title: 'Mood', emoji: '😊', blurb: 'Log how you feel. Spot patterns over time.' },
    { kind: 'open_loops', title: 'Open loops', emoji: '🪢', blurb: 'Track promises and follow-ups so nothing slips.' },
    { kind: 'relationship_radar', title: 'Relationship radar', emoji: '📡', blurb: 'Know who to reach out to and when.' },
    { kind: 'drop_zone', title: 'Drop zone', emoji: '📥', blurb: 'Dump anything messy. Alpha sorts it.' },
    { kind: 'check_in', title: 'Check-in', emoji: '👋', blurb: 'A quick pulse on how you are doing.' },
    { kind: 'pick_night', title: "Tonight's plan", emoji: '🌙', blurb: 'Plans, options, and a call on what to do.', sample: 'what should we do tonight' },
    { kind: 'spiral_options', title: 'Options', emoji: '🌀', blurb: 'Step back and look at the options.', sample: "i'm spiraling" },
  ],
  coworker: [
    { kind: 'digest', title: 'Morning brief', emoji: '☀️', blurb: 'Calendar, important mail, and reminders every morning.' },
    { kind: 'meeting_mode', title: 'Meeting mode', emoji: '🗂️', blurb: 'Prepped before, wrapped after.', sample: 'prep me for the review' },
    { kind: 'open_loops', title: 'Open loops', emoji: '🪢', blurb: 'Track commitments so nothing slips.' },
    { kind: 'drop_zone', title: 'Drop zone', emoji: '📥', blurb: 'Dump anything messy. Alpha sorts it.' },
    { kind: 'approve_send', title: 'Approve & send', emoji: '✉️', blurb: 'Review drafts before they go out.', sample: 'approve the email' },
    { kind: 'pick_slot', title: 'Pick a slot', emoji: '🗓️', blurb: 'Compare times and pick what works.', sample: 'pick a slot for the review' },
    { kind: 'standup_paste', title: 'Standup', emoji: '📋', blurb: 'Raw notes in, tight standup out.', sample: 'standup' },
    { kind: 'linear_triage', title: 'Linear triage', emoji: '🎯', blurb: 'Issues and backlog, triaged.', sample: 'triage the backlog' },
  ],
  cofounder: [
    { kind: 'digest', title: 'Morning brief', emoji: '☀️', blurb: 'Calendar, important mail, and reminders every morning.' },
    { kind: 'decision_ledger', title: 'Decision ledger', emoji: '📜', blurb: 'Log big calls, revisit the reasoning.', sample: 'log a decision' },
    { kind: 'relationship_radar', title: 'Relationship radar', emoji: '📡', blurb: 'Investors, candidates, partners — who to touch.' },
    { kind: 'open_loops', title: 'Open loops', emoji: '🪢', blurb: 'Track commitments so nothing slips.' },
    { kind: 'drop_zone', title: 'Drop zone', emoji: '📥', blurb: 'Dump anything messy. Alpha sorts it.' },
    { kind: 'weekly_focus', title: 'Weekly focus', emoji: '🧭', blurb: 'What to actually focus on this week.', sample: 'what is my weekly focus' },
    { kind: 'kill_keep_park', title: 'Kill · Keep · Park', emoji: '⚖️', blurb: 'Decide what to kill, keep, or park.', sample: 'kill keep park' },
    { kind: 'hire_decision', title: 'Hire decision', emoji: '🤝', blurb: 'The call on the candidate.', sample: 'should we hire them' },
    { kind: 'approve_investor_note', title: 'Investor note', emoji: '💼', blurb: 'Review the note before it goes out.', sample: 'review the investor note' },
  ],
}

export const KIND_TITLES: Record<string, { title: string; blurb: string }> = {
  menu: { title: 'What do you want from me?', blurb: 'Pick the features you want. You can change anytime.' },
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
  open_loops: { title: 'Open loops', blurb: 'Promises and follow-ups, so nothing slips.' },
  meeting_mode: { title: 'Meeting mode', blurb: 'Prepped before, wrapped after.' },
  decision_ledger: { title: 'Decision ledger', blurb: 'Big calls on record, reasoning intact.' },
  relationship_radar: { title: 'Relationship radar', blurb: 'Who to reach out to, and when.' },
  drop_zone: { title: 'Drop zone', blurb: 'Dump anything messy. Alpha sorts it.' },
  nutrition: { title: 'Nutrition', blurb: 'Snap a meal, see the macros, hit your goals.' },
  habit_streak: { title: 'Habits', blurb: 'Build streaks. Track daily habits.' },
  mood_tracker: { title: 'Mood', blurb: 'Log how you feel. Spot patterns over time.' },
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
  const [setupError, setSetupError] = useState('')
  const [expired, setExpired] = useState(false)
  const [selected, setSelected] = useState<string[]>([])
  const [savedFeatures, setSavedFeatures] = useState<string[]>([])
  const [setupDone, setSetupDone] = useState(false)

  const isDigest = kind === 'digest'
  const isMenu = kind === 'menu'
  const isLiveMini = LIVE_MINI_KINDS.has(kind || '')
  const isFeature = FEATURE_KINDS.has(kind || '')
  const isKnown = isLiveMini || isFeature || isMenu || isDigest

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

  useEffect(() => {
    let cancelled = false
    if (!authed || !isMenu) return
    apiSetupStatus({ persona: (persona as AgentId) || 'friend', email: email || undefined, token: token || undefined })
      .then((st) => {
        if (cancelled) return
        setSavedFeatures(st.setup)
        setSetupDone(st.setupDone)
        setSelected(st.setup)
      })
      .catch(() => {
        if (cancelled) return
        setSetupError('Could not load your features. Please try again.')
      })
    return () => {
      cancelled = true
    }
  }, [authed, isMenu, persona, email, token])

  function toggle(feature: MenuFeature) {
    setSelected((prev) => (prev.includes(feature.kind) ? prev.filter((k) => k !== feature.kind) : [...prev, feature.kind]))
  }

  async function saveSetup() {
    if (!authed || status === 'busy') return
    setStatus('busy')
    setSetupError('')
    try {
      await apiSetup({
        persona: (persona as AgentId) || 'friend',
        features: selected,
        done: true,
        email: email || undefined,
        token: token || undefined,
      })
      setSavedFeatures(selected)
      setSetupDone(true)
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

  function editSetup() {
    setStatus('idle')
    setSetupDone(false)
  }

  const allFeatures = MENU_FEATURES[(persona as AgentId) || 'friend'] ?? []

  return (
    <div className="mini" style={{ '--mini-accent': agent.color } as CSSProperties}>
      <div className="mini__card">
        <header className="mini__head">
          <span className="mini__avatar" aria-hidden>
            {agent.initial}
          </span>
          <div className="mini__who">
            <p className="mini__name">{agent.imsgName}</p>
            <p className="mini__role">{isMenu ? 'Your features' : isKnown ? kindInfo.title : agent.role}</p>
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
            {setupDone ? (
              <div className="mini__done">
                <p className="mini__done-title">Your features are set up.</p>
                <p className="mini__blurb">
                  {savedFeatures
                    .map((k) => allFeatures.find((f) => f.kind === k))
                    .filter(Boolean)
                    .map((f) => `${f!.emoji} ${f!.title}`)
                    .join(' · ') || 'Nothing enabled yet.'}
                </p>
                <button type="button" className="mini__again" onClick={editSetup}>
                  Change features
                </button>
              </div>
            ) : (
              <>
                <p className="mini__blurb">Pick the features you want. You can change anytime.</p>
                <div className="mini__menu">
                  {features.map((f) => {
                    const on = selected.includes(f.kind)
                    return (
                      <button
                        key={f.kind}
                        type="button"
                        className={`mini__feature${on ? ' mini__feature--on' : ''}`}
                        onClick={() => toggle(f)}
                      >
                        <span className="mini__feature-emoji" aria-hidden>
                          {on ? '✓' : f.emoji}
                        </span>
                        <span className="mini__feature-text">
                          <span className="mini__feature-title">{f.title}</span>
                          <span className="mini__feature-blurb">{f.blurb}</span>
                        </span>
                      </button>
                    )
                  })}
                  {status === 'error' && <p className="mini__empty">{setupError}</p>}
                </div>
                <button
                  type="button"
                  className="mini__cta"
                  disabled={status === 'busy' || selected.length === 0}
                  onClick={() => void saveSetup()}
                >
                  {status === 'busy' ? 'Saving…' : selected.length ? `Save ${selected.length} feature${selected.length === 1 ? '' : 's'}` : 'Select a feature'}
                </button>
              </>
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

        {authed && !isMenu && !isKnown && (
          <div className="mini__body">
            <p className="mini__blurb">{kindInfo.blurb}</p>
            <p className="mini__hint">
              Text {agent.imsgName} back to keep going. This one is not live yet.
            </p>
          </div>
        )}
      {authed && !expired && isFeature && kind === 'open_loops' && (
          <OpenLoopsApp auth={{ persona: (persona as AgentId) || 'friend', email: email || undefined, token: token || undefined }} />
        )}
        {authed && !expired && isFeature && kind === 'meeting_mode' && (
          <MeetingModeApp auth={{ persona: (persona as AgentId) || 'friend', email: email || undefined, token: token || undefined }} />
        )}
        {authed && !expired && isFeature && kind === 'decision_ledger' && (
          <DecisionLedgerApp auth={{ persona: (persona as AgentId) || 'friend', email: email || undefined, token: token || undefined }} />
        )}
        {authed && !expired && isFeature && kind === 'relationship_radar' && (
          <RelationshipRadarApp auth={{ persona: (persona as AgentId) || 'friend', email: email || undefined, token: token || undefined }} />
        )}
        {authed && !expired && isFeature && kind === 'drop_zone' && (
          <DropZoneApp auth={{ persona: (persona as AgentId) || 'friend', email: email || undefined, token: token || undefined }} />
        )}
        {authed && !expired && isFeature && kind === 'nutrition' && (
          <NutritionApp auth={{ persona: (persona as AgentId) || 'friend', email: email || undefined, token: token || undefined }} />
        )}
        {authed && !expired && isFeature && kind === 'habit_streak' && (
          <HabitStreakApp auth={{ persona: (persona as AgentId) || 'friend', email: email || undefined, token: token || undefined }} />
        )}
        {authed && !expired && isFeature && kind === 'mood_tracker' && (
          <MoodTrackerApp auth={{ persona: (persona as AgentId) || 'friend', email: email || undefined, token: token || undefined }} />
        )}
      </div>
    </div>
  )
}
