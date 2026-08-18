import { useEffect, useState, type CSSProperties } from 'react'
import { Link, Navigate, useParams, useSearchParams } from 'react-router-dom'
import { AlphaFace, type AlphaFaceMood } from '../AlphaFace'
import { getAgent } from '../agents'
import type { AgentId } from '../agents/types'
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
import { MiniAppSettings } from './MiniAppSettings'
import {
  GratitudeJournalApp,
  LearningQueueApp,
  MirrorApp,
  NetworkingCrmApp,
  PipelineBoardApp,
  SleepTrackerApp,
  SpendingSnapshotApp,
  WeeklyReviewApp,
  WorkoutLogApp,
} from './LifeMiniApps'
import { MiniAppIcon } from './MiniAppIcons'

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

const FACE_MOOD: Record<AgentId, AlphaFaceMood> = {
  friend: 'soft',
  coworker: 'sharp',
  cofounder: 'bold',
}

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
  'workout_log',
  'learning_queue',
  'weekly_review',
  'weekly_focus',
  'networking_crm',
  'sleep_tracker',
  'pipeline_board',
  'gratitude_journal',
  'spending_snapshot',
  'mirror',
])

export interface MenuFeature {
  kind: string
  title: string
  emoji: string
  blurb: string
  sample?: string
}

/** Friend store aliases: old kinds still open, they land on the surviving app. */
export const FRIEND_APP_ALIASES: Record<string, string> = {
  relationship_radar: 'networking_crm',
  drop_zone: 'learning_queue',
  check_in: 'mood_tracker',
  spiral_options: 'pick_night',
}

export const MENU_FEATURES: Record<string, MenuFeature[]> = {
  friend: [
    { kind: 'nutrition', title: 'Nutrition', emoji: '🥗', blurb: 'Meals and macros.', sample: 'i ate a chicken bowl' },
    { kind: 'habit_streak', title: 'Habits', emoji: '🔥', blurb: 'Today and streaks.' },
    { kind: 'mood_tracker', title: 'Mood', emoji: '😊', blurb: 'How you feel.' },
    { kind: 'workout_log', title: 'Workout', emoji: '🏋️', blurb: 'Home or gym. Mon through Fri.' },
    { kind: 'sleep_tracker', title: 'Sleep', emoji: '🌱', blurb: 'Last night.' },
    { kind: 'spending_snapshot', title: 'Spending', emoji: '💰', blurb: 'This week\'s budget.' },
    { kind: 'mirror', title: 'Mirror', emoji: '🪞', blurb: 'How life actually looks.' },
    { kind: 'networking_crm', title: 'People', emoji: '🤝', blurb: 'Who to follow up.' },
    { kind: 'open_loops', title: 'Promises', emoji: '🪢', blurb: 'What you said you\'d do.' },
    { kind: 'digest', title: 'Today', emoji: '☀️', blurb: 'Calendar, mail, reminders.' },
    { kind: 'learning_queue', title: 'Learning', emoji: '📚', blurb: 'What to read or watch next.' },
    { kind: 'pick_night', title: 'Tonight', emoji: '🌙', blurb: 'What to do.', sample: 'what should we do tonight' },
  ],
  coworker: [
    { kind: 'digest', title: 'Morning brief', emoji: '☀️', blurb: 'Calendar, important mail, and reminders every morning.' },
    { kind: 'meeting_mode', title: 'Meeting mode', emoji: '🗂️', blurb: 'Prepped before, wrapped after.', sample: 'prep me for the review' },
    { kind: 'learning_queue', title: 'Learning queue', emoji: '📚', blurb: 'Save articles, videos, podcasts. Play the next one.' },
    { kind: 'mirror', title: 'The mirror', emoji: '🪞', blurb: 'Here\'s what your week actually looked like.' },
    { kind: 'weekly_review', title: 'Weekly review', emoji: '📅', blurb: 'What got done, what slipped, next week\'s focus.' },
    { kind: 'networking_crm', title: 'Networking', emoji: '🤝', blurb: 'People you met, what you talked about, when to follow up.' },
    { kind: 'open_loops', title: 'Promises', emoji: '🪢', blurb: 'What you said you would do.' },
    { kind: 'drop_zone', title: 'Save for later', emoji: '📥', blurb: 'Dump anything and Alpha sorts it later.' },
    { kind: 'approve_send', title: 'Approve & send', emoji: '✉️', blurb: 'Review drafts before they go out.', sample: 'approve the email' },
    { kind: 'pick_slot', title: 'Pick a slot', emoji: '🗓️', blurb: 'Compare times and pick what works.', sample: 'pick a slot for the review' },
    { kind: 'standup_paste', title: 'Standup', emoji: '📋', blurb: 'Raw notes in, tight standup out.', sample: 'standup' },
    { kind: 'linear_triage', title: 'Linear triage', emoji: '🎯', blurb: 'Issues and backlog, triaged.', sample: 'triage the backlog' },
  ],
  cofounder: [
    { kind: 'digest', title: 'Morning brief', emoji: '☀️', blurb: 'Calendar, important mail, and reminders every morning.' },
    { kind: 'decision_ledger', title: 'Decisions', emoji: '📜', blurb: 'Log the call, revisit the reasoning later.', sample: 'log a decision' },
    { kind: 'mirror', title: 'The mirror', emoji: '🪞', blurb: 'Your week at a glance. Decisions, spend, habits.' },
    { kind: 'pipeline_board', title: 'Pipeline', emoji: '💼', blurb: 'Jobs, fundraising, leads. Move them through stages.' },
    { kind: 'networking_crm', title: 'Networking', emoji: '🤝', blurb: 'People you met, what you talked about, when to follow up.' },
    { kind: 'weekly_review', title: 'Weekly review', emoji: '📅', blurb: 'What got done, what slipped, next week\'s focus.' },
    { kind: 'spending_snapshot', title: 'Spending', emoji: '💰', blurb: 'Log spend, watch the weekly budget.' },
    { kind: 'relationship_radar', title: 'Stay in touch', emoji: '📡', blurb: 'Investors, candidates, partners. Who to ping.' },
    { kind: 'open_loops', title: 'Promises', emoji: '🪢', blurb: 'What you said you would do.' },
    { kind: 'drop_zone', title: 'Save for later', emoji: '📥', blurb: 'Dump anything and Alpha sorts it later.' },
    { kind: 'kill_keep_park', title: 'Kill · Keep · Park', emoji: '⚖️', blurb: 'Decide what to kill, keep, or park.', sample: 'kill keep park' },
    { kind: 'hire_decision', title: 'Hire decision', emoji: '🤝', blurb: 'The call on the candidate.', sample: 'should we hire them' },
    { kind: 'approve_investor_note', title: 'Investor note', emoji: '💼', blurb: 'Review the note before it goes out.', sample: 'review the investor note' },
  ],
}


export const APP_STORE_GROUPS: Record<string, { label: string; kinds: string[] }[]> = {
  friend: [
    { label: 'Life', kinds: ['nutrition', 'habit_streak', 'mood_tracker', 'workout_log', 'sleep_tracker', 'spending_snapshot', 'mirror'] },
    { label: 'People', kinds: ['networking_crm', 'open_loops'] },
    { label: 'Day', kinds: ['digest', 'learning_queue', 'pick_night'] },
  ],
  coworker: [
    { label: 'Day', kinds: ['digest', 'standup_paste', 'meeting_mode', 'weekly_review', 'pick_slot'] },
    { label: 'Work', kinds: ['approve_send', 'linear_triage', 'learning_queue'] },
    { label: 'People', kinds: ['networking_crm', 'open_loops', 'drop_zone', 'mirror'] },
  ],
  cofounder: [
    { label: 'Work', kinds: ['pipeline_board', 'kill_keep_park', 'hire_decision', 'approve_investor_note', 'weekly_review', 'spending_snapshot'] },
    { label: 'People', kinds: ['networking_crm', 'relationship_radar', 'open_loops', 'drop_zone'] },
    { label: 'Day', kinds: ['digest', 'decision_ledger', 'mirror'] },
  ],
}

export const KIND_TITLES: Record<string, { title: string; blurb: string }> = {
  menu: { title: 'Apps', blurb: 'Tap one to open it.' },
  apps: { title: 'Apps', blurb: 'Tap one to open it.' },
  digest: { title: 'Morning brief', blurb: 'Your day at a glance. Calendar, important mail, and reminders.' },
  approve_send: { title: 'Approve & send', blurb: 'Review the draft and approve it to send.' },
  pick_slot: { title: 'Pick a slot', blurb: 'Compare meeting times and pick the one that works.' },
  pick_night: { title: 'Pick the night', blurb: 'Plans, options, and a call on what to do.' },
  check_in: { title: 'Check-in', blurb: 'A quick pulse on how you are doing.' },
  standup_paste: { title: 'Standup', blurb: 'Your standup notes, tightened up.' },
  linear_triage: { title: 'Linear triage', blurb: 'Issues and backlog, triaged.' },
  kill_keep_park: { title: 'Kill · Keep · Park', blurb: 'Decide what to kill, keep, or park.' },
  hire_decision: { title: 'Hire decision', blurb: 'The call on the candidate.' },
  weekly_focus: { title: 'Weekly focus', blurb: 'What to focus on this week.' },
  weekly_review: { title: 'Weekly review', blurb: 'What got done, what slipped, and next week\'s focus.' },
  approve_investor_note: { title: 'Investor note', blurb: 'Review the note before it goes out.' },
  spiral_options: { title: 'Get unstuck', blurb: 'Step back, see the options, get moving again.' },
  open_loops: { title: 'Promises', blurb: 'What you said you would do.' },
  meeting_mode: { title: 'Meeting mode', blurb: 'Prepped before, wrapped after.' },
  decision_ledger: { title: 'Decisions', blurb: 'Big calls on record, reasoning intact.' },
  relationship_radar: { title: 'Stay in touch', blurb: 'Who to reach out to, and when.' },
  drop_zone: { title: 'Save for later', blurb: 'Dump anything and Alpha sorts it later.' },
  nutrition: { title: 'Nutrition', blurb: 'Snap a meal, see the macros, hit your goals.' },
  habit_streak: { title: 'Habits', blurb: 'Build streaks. Track daily habits.' },
  mood_tracker: { title: 'Mood', blurb: 'Log how you feel. Spot patterns over time.' },
  workout_log: { title: 'Workout', blurb: 'Home or gym. Mon through Fri.' },
  learning_queue: { title: 'Learning queue', blurb: 'Save what to read or watch next.' },
  networking_crm: { title: 'Networking', blurb: 'People you met and when to follow up.' },
  sleep_tracker: { title: 'Sleep', blurb: 'Bedtime, wake, and sleep debt.' },
  pipeline_board: { title: 'Pipeline', blurb: 'Jobs, fundraising, leads. Sorted by stage.' },
  gratitude_journal: { title: 'Gratitude', blurb: 'One sentence a day.' },
  spending_snapshot: { title: 'Spending', blurb: 'Log spend against a weekly budget.' },
  mirror: { title: 'The mirror', blurb: 'Here\'s what your life actually looks like. No spin.' },
}

const FRIEND_KIND_TITLES: Record<string, { title: string; blurb: string }> = {
  digest: { title: 'Today', blurb: 'Calendar, mail, reminders.' },
  networking_crm: { title: 'People', blurb: 'Who to follow up.' },
  pick_night: { title: 'Tonight', blurb: 'What to do.' },
  learning_queue: { title: 'Learning', blurb: 'What to read or watch next.' },
  mirror: { title: 'Mirror', blurb: 'How life actually looks.' },
}

export function MiniAppPage() {
  const { persona, kind } = useParams()
  const [searchParams] = useSearchParams()
  const token = searchParams.get('t') || ''
  const agent = getAgent((persona as AgentId) || 'friend')
  const kindInfo =
    (persona === 'friend' ? FRIEND_KIND_TITLES[kind || ''] : undefined) ??
    KIND_TITLES[kind || ''] ?? {
      title: 'Apps',
      blurb: 'Open from a text to continue.',
    }
  const [data, setData] = useState<DigestData | null>(null)
  const [mini, setMini] = useState<MiniPayload | null>(null)
  const [loading, setLoading] = useState(true)
  const [expired, setExpired] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [settingsTick, setSettingsTick] = useState(0)

  const isDigest = kind === 'digest'
  const isMenu = kind === 'menu'
  const isApps = kind === 'apps' || isMenu
  const isLiveMini = LIVE_MINI_KINDS.has(kind || '')
  const isFeature = FEATURE_KINDS.has(kind || '')
  const isKnown = isLiveMini || isFeature || isApps || isDigest

  useEffect(() => {
    setSettingsOpen(false)
  }, [kind])

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
  const miniAccent = agent.color
  const miniAccentFg = '#f4f4f5'
  const features = MENU_FEATURES[persona || ''] ?? []
  const storeGroups = (APP_STORE_GROUPS[persona || ''] ?? []).map((group) => ({
    ...group,
    items: group.kinds
      .map((k) => features.find((f) => f.kind === k))
      .filter((f): f is MenuFeature => !!f),
  })).filter((g) => g.items.length > 0)
  const search = searchParams.toString()
  const q = search ? `?${search}` : ''
  const appsHref = `/app/mini/${persona || 'friend'}/apps${q}`
  const openHref = (featureKind: string) => `/app/mini/${persona || 'friend'}/${featureKind}${q}`
  const aliasKind = persona === 'friend' && kind ? FRIEND_APP_ALIASES[kind] : undefined

  if (aliasKind) {
    return <Navigate to={`/app/mini/friend/${aliasKind}${q}`} replace />
  }

  return (
    <div className="mini" style={{ '--mini-accent': miniAccent, '--mini-accent-fg': miniAccentFg } as CSSProperties}>
      <div className="mini__card">
        <header className="mini__head">
          {!isApps && (
            <Link className="mini__nav" to={appsHref} aria-label="Back to all apps">
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                <path
                  d="M15 6l-6 6 6 6"
                  stroke="currentColor"
                  strokeWidth="2.25"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            </Link>
          )}
          <span className="mini__avatar">
            <AlphaFace color={miniAccent} mood={FACE_MOOD[agent.id]} size={42} />
          </span>
          <div className="mini__who">
            <p className="mini__name">{agent.imsgName}</p>
            <p className="mini__role">
              {settingsOpen ? 'Settings' : isApps ? 'Apps' : isKnown ? kindInfo.title : agent.role}
            </p>
          </div>
          <div className="mini__head-actions">
            {!isApps && (
              <Link className="mini__back" to={appsHref} onClick={() => setSettingsOpen(false)}>
                All apps
              </Link>
            )}
            {authed && !expired && (
              <button
                className="mini__back"
                type="button"
                onClick={() => {
                  if (settingsOpen) {
                    setSettingsOpen(false)
                    setSettingsTick((n) => n + 1)
                  } else {
                    setSettingsOpen(true)
                  }
                }}
              >
                {settingsOpen ? 'Close' : 'Settings'}
              </button>
            )}
          </div>
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

        {authed && !expired && settingsOpen && (
          <div className="mini__body">
            <MiniAppSettings
              auth={{
                persona: (persona as AgentId) || 'friend',
                email: email || undefined,
                token: token || undefined,
              }}
              focusKind={kind || 'apps'}
              onClose={() => {
                setSettingsOpen(false)
                setSettingsTick((n) => n + 1)
              }}
            />
          </div>
        )}

        {authed && !expired && isApps && !settingsOpen && (
          <div className="mini__body">
            <div className="mini-store">
              {storeGroups.map((group) => (
                <section key={group.label} className="mini-store__group">
                  <h2 className="mini-store__label">{group.label}</h2>
                  {group.items.map((f) => (
                    <Link key={f.kind} className="mini-store__row" to={openHref(f.kind)}>
                      <span className="mini-store__mark">
                        <MiniAppIcon kind={f.kind} />
                      </span>
                      <span className="mini-store__text">
                        <span className="mini-store__title">{f.title}</span>
                        <span className="mini-store__hint">{f.blurb}</span>
                      </span>
                      <span className="ma-chip mini-store__go">Open</span>
                    </Link>
                  ))}
                </section>
              ))}
            </div>
          </div>
        )}

        {authed && !expired && !settingsOpen && isDigest && loading && (
          <div className="mini__body">
            <p className="mini__blurb">Pulling your day together…</p>
          </div>
        )}

        {authed && !expired && !settingsOpen && isDigest && !loading && data?.error && (
          <div className="mini__body">
            <p className="mini__blurb">{data.error}</p>
          </div>
        )}

        {authed && !expired && !settingsOpen && isDigest && !loading && !data?.error && (
          <div className="mini__body">
            <div className="ma-hero">
              <span className="ma-hero-kicker">Today</span>
              <p className="mini__date">{data?.date}</p>
            </div>

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

        {authed && !expired && !settingsOpen && isLiveMini && !isDigest && loading && (
          <div className="mini__body">
            <p className="mini__blurb">Working it out…</p>
          </div>
        )}

        {authed && !expired && !settingsOpen && isLiveMini && !isDigest && !loading && mini?.error && (
          <div className="mini__body">
            <p className="mini__blurb">{mini.error}</p>
          </div>
        )}

        {authed && !expired && !settingsOpen && isLiveMini && !isDigest && !loading && !mini?.error && (
          <div className="mini__body">
            {mini?.date && (
              <div className="ma-hero">
                <span className="ma-hero-kicker">Ready</span>
                <p className="mini__date">{mini.date}</p>
              </div>
            )}
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

        {authed && !expired && !settingsOpen && !isApps && !isKnown && (
          <div className="mini__body">
            <p className="mini__blurb">{kindInfo.blurb}</p>
            <p className="mini__hint">
              Text {agent.imsgName} back to keep going. This one is not live yet.
            </p>
          </div>
        )}
      {authed && !expired && !settingsOpen && isFeature && (
          <div className="mini__body" key={settingsTick}>
            {kind === 'open_loops' && (
              <OpenLoopsApp auth={{ persona: (persona as AgentId) || 'friend', email: email || undefined, token: token || undefined }} />
            )}
            {kind === 'meeting_mode' && (
              <MeetingModeApp auth={{ persona: (persona as AgentId) || 'friend', email: email || undefined, token: token || undefined }} />
            )}
            {kind === 'decision_ledger' && (
              <DecisionLedgerApp auth={{ persona: (persona as AgentId) || 'friend', email: email || undefined, token: token || undefined }} />
            )}
            {kind === 'relationship_radar' && (
              <RelationshipRadarApp auth={{ persona: (persona as AgentId) || 'friend', email: email || undefined, token: token || undefined }} />
            )}
            {kind === 'drop_zone' && (
              <DropZoneApp auth={{ persona: (persona as AgentId) || 'friend', email: email || undefined, token: token || undefined }} />
            )}
            {kind === 'nutrition' && (
              <NutritionApp auth={{ persona: (persona as AgentId) || 'friend', email: email || undefined, token: token || undefined }} />
            )}
            {kind === 'habit_streak' && (
              <HabitStreakApp auth={{ persona: (persona as AgentId) || 'friend', email: email || undefined, token: token || undefined }} />
            )}
            {kind === 'mood_tracker' && (
              <MoodTrackerApp auth={{ persona: (persona as AgentId) || 'friend', email: email || undefined, token: token || undefined }} />
            )}
            {kind === 'workout_log' && (
              <WorkoutLogApp auth={{ persona: (persona as AgentId) || 'friend', email: email || undefined, token: token || undefined }} />
            )}
            {kind === 'learning_queue' && (
              <LearningQueueApp auth={{ persona: (persona as AgentId) || 'friend', email: email || undefined, token: token || undefined }} />
            )}
            {(kind === 'weekly_review' || kind === 'weekly_focus') && (
              <WeeklyReviewApp auth={{ persona: (persona as AgentId) || 'friend', email: email || undefined, token: token || undefined }} />
            )}
            {kind === 'networking_crm' && (
              <NetworkingCrmApp auth={{ persona: (persona as AgentId) || 'friend', email: email || undefined, token: token || undefined }} />
            )}
            {kind === 'sleep_tracker' && (
              <SleepTrackerApp auth={{ persona: (persona as AgentId) || 'friend', email: email || undefined, token: token || undefined }} />
            )}
            {kind === 'pipeline_board' && (
              <PipelineBoardApp auth={{ persona: (persona as AgentId) || 'friend', email: email || undefined, token: token || undefined }} />
            )}
            {kind === 'gratitude_journal' && (
              <GratitudeJournalApp auth={{ persona: (persona as AgentId) || 'friend', email: email || undefined, token: token || undefined }} />
            )}
            {kind === 'spending_snapshot' && (
              <SpendingSnapshotApp auth={{ persona: (persona as AgentId) || 'friend', email: email || undefined, token: token || undefined }} />
            )}
            {kind === 'mirror' && (
              <MirrorApp auth={{ persona: (persona as AgentId) || 'friend', email: email || undefined, token: token || undefined }} />
            )}
          </div>
        )}
      </div>
    </div>
  )
}
