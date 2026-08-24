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
  NetworkingCrmApp,
  PipelineBoardApp,
  SleepTrackerApp,
  SpendingSnapshotApp,
  WeeklyReviewApp,
  WorkoutLogApp,
} from './LifeMiniApps'
import { HomeApp } from './HomeApp'
import { CofounderHomeApp, CoworkerHomeApp } from './WorkHomes'
import { BriefApp } from './BriefApp'
import { BodyHubApp, LaterHubApp } from './FriendHubApps'
import {
  ApproveSendApp,
  PickSlotApp,
  LinearTriageApp,
  HireDecisionApp,
  InvestorNoteApp,
} from './WorkMiniApps'
import { EmailReader } from './EmailReader'
import { readBriefCache, writeBriefCache } from './briefCache'
import { applyMiniTheme, readMiniTheme } from './miniTheme'
import { localYmd } from './home'
import type { ReplyDraft } from './api'


interface DigestData {
  date?: string
  calendar?: string[]
  emails?: string[]
  emailItems?: Array<{ id: string; label: string; snippet?: string }>
  mailGroups?: import('./briefStory').BriefMailGroup[]
  mailTally?: string
  reminders?: Array<{ time?: string; text?: string }>
  events?: Array<{ id: string; label: string }>
  tomorrow?: string[]
  brief?: 'morning' | 'evening'
  story?: import('./briefStory').BriefStory
  error?: string
  /* The server answered before the brief finished assembling. Not an error: the
   * load is still running behind that response, so the right move is to come
   * back for it rather than to tell the user anything. */
  pending?: boolean
}

interface MiniSection {
  heading: string
  items: string[]
  emailMeta?: Array<{ id: string; snippet?: string }>
}

interface MiniPayload {
  title?: string
  date?: string
  sections?: MiniSection[]
  paste?: string
  text?: string
  dayScore?: { points: number; verdict: string } | null
  dayFacts?: Array<{ key: string; label: string; detail: string; state: 'done' | 'miss' | 'partial' }>
  habitsToday?: Array<{ id: string; name: string; emoji: string; done: boolean }>
  carryOver?: Array<{ id: string; title: string; dueLabel?: string }>
  error?: string
  /* Same contract as the morning brief: the evening one is heavy enough that the
   * server answers before it is built rather than holding the request open. */
  pending?: boolean
  note?: string
}

/** The two kinds the device holds onto. Everything else is small and fast enough
 * that a spinner is honest. */
const BRIEF_CACHE_KINDS = new Set(['digest', 'pick_night'])

type BriefPayload = DigestData & MiniPayload

/** This device's last copy of one brief, or null. Module-level so the first-frame
 * seed and a kind change on an already-mounted page read it the same way. */
function cachedBrief(persona: string, kind: string, token: string): BriefPayload | null {
  if (!BRIEF_CACHE_KINDS.has(kind)) return null
  return readBriefCache<BriefPayload>(
    { email: getSession()?.email, token, persona },
    kind,
    localYmd(),
    Date.now(),
  )
}

function saveBrief(persona: string, kind: string, token: string, brief: BriefPayload) {
  if (!BRIEF_CACHE_KINDS.has(kind)) return
  writeBriefCache({ email: getSession()?.email, token, persona }, kind, brief, localYmd(), Date.now())
}

/* Delays, not one interval. The build is already running server-side and lands in
 * the cache when it lands, so ask again soon at first and back off after —
 * cumulatively 0.4s, 1.0, 1.9, 3.2, 5.0, 7.4. The old ladder was four flat
 * 1600ms tries, which meant nothing before 1.6s and nothing after 6.4s. */
const BRIEF_RETRY_MS = [250, 450, 700, 1000, 1400, 1900, 2500, 3200]

const LIVE_MINI_KINDS = new Set(['digest', 'pick_night', 'tonight', 'standup_paste', 'kill_keep_park'])

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
  'home',
  'body',
  'later',
  'approve_send',
  'pick_slot',
  'linear_triage',
  'hire_decision',
  'approve_investor_note',
])

export interface MenuFeature {
  kind: string
  title: string
  emoji: string
  blurb: string
  sample?: string
}

/** Old kinds still open; they land on the surviving app. 'mirror' is the old name for 'home'. */
export const APP_ALIASES: Record<string, string> = {
  relationship_radar: 'networking_crm',
  check_in: 'home',
  weekly_focus: 'weekly_review',
  spiral_options: 'home',
  mirror: 'home',
}
export const FRIEND_APP_ALIASES = APP_ALIASES

export const MENU_FEATURES: Record<string, MenuFeature[]> = {
  friend: [
    { kind: 'home', title: 'Home', emoji: '🏠', blurb: 'Today, next eight hours, and receipts.', sample: 'home screen' },
    { kind: 'body', title: 'Body', emoji: '💪', blurb: 'Nutrition, workout, sleep, habits, mood.', sample: 'log my breakfast' },
    { kind: 'networking_crm', title: 'People', emoji: '🤝', blurb: 'Who to follow up and who you are seeing.', sample: 'i met sarah' },
    { kind: 'digest', title: 'Morning brief', emoji: '☀️', blurb: 'Who is next, what to do, what can wait.', sample: 'morning brief' },
    { kind: 'pick_night', title: 'Evening brief', emoji: '🌆', blurb: 'Day wrap, mail since morning, tomorrow.' },
    { kind: 'tonight', title: 'Tonight', emoji: '🌙', blurb: 'Places to eat or hang. Maps powered.', sample: 'dinner plans tonight' },
    { kind: 'later', title: 'Later', emoji: '📥', blurb: 'Drop zone, learning, promises, gratitude.', sample: 'save for later' },
  ],
  coworker: [
    { kind: 'meeting_mode', title: 'Meeting mode', emoji: '🗂️', blurb: 'Prepped before, wrapped after.', sample: 'prep me for the review' },
    { kind: 'approve_send', title: 'Approve & send', emoji: '✉️', blurb: 'Review drafts before they go out.', sample: 'approve the email' },
    { kind: 'pick_slot', title: 'Pick a slot', emoji: '🗓️', blurb: 'Compare times and pick what works.', sample: 'pick a slot for the review' },
    { kind: 'linear_triage', title: 'Linear triage', emoji: '🎯', blurb: 'Issues and backlog, triaged.', sample: 'triage the backlog' },
    { kind: 'standup_paste', title: 'Standup', emoji: '📋', blurb: 'Raw notes in, tight standup out.', sample: 'standup' },
    { kind: 'open_loops', title: 'Promises', emoji: '🔗', blurb: 'What you told a person you would do, until you mark it done.', sample: 'i promised maya the deck' },
    { kind: 'networking_crm', title: 'People', emoji: '🤝', blurb: 'Who to follow up and when.', sample: 'i met sarah' },
    { kind: 'drop_zone', title: 'Save for later', emoji: '📥', blurb: 'Dump anything and Alpha sorts it later.', sample: 'save for later' },
  ],
  cofounder: [
    { kind: 'pipeline_board', title: 'Pipeline', emoji: '💼', blurb: 'Jobs, fundraising, leads. Move them through stages.' },
    { kind: 'decision_ledger', title: 'Decisions', emoji: '📜', blurb: 'Log the call, revisit the reasoning later.', sample: 'log a decision' },
    { kind: 'networking_crm', title: 'People', emoji: '🤝', blurb: 'People you met, when to follow up.' },
    { kind: 'open_loops', title: 'Promises', emoji: '🔗', blurb: 'What you told a person you would do, until you mark it done.', sample: 'i promised maya the deck' },
    { kind: 'approve_investor_note', title: 'Investor note', emoji: '💼', blurb: 'Review the note before it goes out.', sample: 'review the investor note' },
    { kind: 'hire_decision', title: 'Hire decision', emoji: '🤝', blurb: 'The call on the candidate.', sample: 'should we hire them' },
    { kind: 'drop_zone', title: 'Save for later', emoji: '📥', blurb: 'Dump anything and Alpha sorts it later.', sample: 'save for later' },
  ],
}

export const APP_STORE_GROUPS: Record<string, { label: string; kinds: string[] }[]> = {
  friend: [
    { label: 'Home', kinds: ['home'] },
    { label: 'Body', kinds: ['body'] },
    { label: 'People', kinds: ['networking_crm'] },
    { label: 'Brief', kinds: ['digest', 'pick_night', 'tonight'] },
    { label: 'Later', kinds: ['later'] },
  ],
  coworker: [
    { label: 'Home', kinds: ['home'] },
    { label: 'Work', kinds: ['meeting_mode', 'approve_send', 'pick_slot', 'linear_triage', 'standup_paste', 'open_loops'] },
    { label: 'People', kinds: ['networking_crm'] },
    { label: 'Later', kinds: ['drop_zone'] },
  ],
  cofounder: [
    { label: 'Home', kinds: ['home'] },
    { label: 'Work', kinds: ['pipeline_board', 'decision_ledger', 'hire_decision', 'approve_investor_note', 'open_loops'] },
    { label: 'People', kinds: ['networking_crm'] },
    { label: 'Later', kinds: ['drop_zone'] },
  ],
}

export const KIND_TITLES: Record<string, { title: string; blurb: string }> = {
  menu: { title: 'Apps', blurb: 'Tap one to open it.' },
  apps: { title: 'Apps', blurb: 'Tap one to open it.' },
  digest: { title: 'Morning brief', blurb: 'Who is next, what to do, what can wait.' },
  next_move: { title: 'Next', blurb: 'The one thing to do now.' },
  approve_send: { title: 'Approve & send', blurb: 'Review the draft and approve it to send.' },
  pick_slot: { title: 'Pick a slot', blurb: 'Compare meeting times and pick the one that works.' },
  pick_night: { title: 'Evening brief', blurb: 'What happened, what is left, and what is on tomorrow.' },
  tonight: { title: 'Tonight', blurb: 'Places to eat or hang near you.' },
  body: { title: 'Body', blurb: 'Nutrition, workout, sleep, habits, and mood.' },
  later: { title: 'Later', blurb: 'Drop zone, learning queue, promises, and gratitude.' },
  check_in: { title: 'Check-in', blurb: 'A quick pulse on how you are doing.' },
  standup_paste: { title: 'Standup', blurb: 'Your standup notes, tightened up.' },
  linear_triage: { title: 'Linear triage', blurb: 'Issues and backlog, triaged.' },
  kill_keep_park: { title: 'Kill · Keep · Park', blurb: 'Decide what to kill, keep, or park.' },
  hire_decision: { title: 'Hire decision', blurb: 'The call on the candidate.' },
  weekly_focus: { title: 'Weekly focus', blurb: 'What to focus on this week.' },
  weekly_review: { title: 'Weekly review', blurb: 'What got done, what slipped, and next week\'s focus.' },
  approve_investor_note: { title: 'Investor note', blurb: 'Review the note before it goes out.' },
  spiral_options: { title: 'Get unstuck', blurb: 'Step back, see the options, get moving again.' },
  open_loops: { title: 'Promises', blurb: 'What you told a person you would do, until you mark it done.' },
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
  home: { title: 'Home', blurb: 'Today, next eight hours, and receipts.' },
}

const FRIEND_KIND_TITLES: Record<string, { title: string; blurb: string }> = {
  home: { title: 'Home', blurb: 'Today, next eight hours, and receipts.' },
  next_move: { title: 'Next', blurb: 'The one thing to do now.' },
  digest: { title: 'Morning brief', blurb: 'Who is next, what to do, what can wait.' },
  networking_crm: { title: 'People', blurb: 'Who to follow up.' },
  pick_night: { title: 'Evening brief', blurb: 'What happened and what is left.' },
  learning_queue: { title: 'Learning', blurb: 'What to read or watch next.' },
  drop_zone: { title: 'Save for later', blurb: 'Dump anything and Alpha sorts it later.' },
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
  /* Paint this device's last copy of the brief on the very first frame, so opening
   * a texted link shows the brief you left rather than a shimmer. The fetch below
   * still runs and replaces it; yesterday's copy is refused by the cache, not by
   * this. Read once at mount — a kind change on a mounted page re-reads it in the
   * fetch effect. */
  const [seed] = useState(() => cachedBrief(persona || '', kind || '', token))
  const [data, setData] = useState<DigestData | null>(() => (kind === 'digest' ? seed : null))
  const [mini, setMini] = useState<MiniPayload | null>(() => (kind === 'digest' ? null : seed))
  const [loading, setLoading] = useState(!seed)
  const [briefTries, setBriefTries] = useState(0)
  const [expired, setExpired] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [settingsTick, setSettingsTick] = useState(0)
  const [openEmailId, setOpenEmailId] = useState<string | null>(null)
  const [openEmailLabel, setOpenEmailLabel] = useState<string | undefined>(undefined)
  const [openEmailSummary, setOpenEmailSummary] = useState<string | undefined>(undefined)
  const [openDraft, setOpenDraft] = useState<ReplyDraft | null>(null)

  function openMail(id: string, label: string, snippet?: string) {
    setOpenEmailId(id)
    setOpenEmailLabel(label)
    setOpenEmailSummary(snippet)
    setOpenDraft(null)
  }

  function openReplyDraft(id: string, label: string, snippet: string | undefined, draft: ReplyDraft) {
    setOpenEmailId(id)
    setOpenEmailLabel(label)
    setOpenEmailSummary(snippet)
    setOpenDraft(draft)
  }

  const isDigest = kind === 'digest'
  const isEveningBrief = kind === 'pick_night'
  const isMenu = kind === 'menu'
  const isApps = kind === 'apps' || isMenu
  const isLiveMini = LIVE_MINI_KINDS.has(kind || '')
  const isFeature = FEATURE_KINDS.has(kind || '')
  const isKnown = isLiveMini || isFeature || isApps || isDigest

  useEffect(() => {
    setSettingsOpen(false)
    setExpired(false)
  }, [kind])

  /* The shell's inline script already painted the saved theme before React ran;
   * this keeps the attribute honest after a client-side navigation in, and hands
   * the page background back to the host page on the way out. */
  useEffect(() => {
    applyMiniTheme(readMiniTheme())
    const hold = document.getElementById('mini-hold')
    return () => {
      applyMiniTheme(null)
      hold?.remove()
    }
  }, [])

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
    setBriefTries(0)
    /* Navigating between briefs on a mounted page misses the mount-time seed, so
     * read the cache here too. Painting the old copy first means the spinner only
     * shows on a brief this device has never held. */
    const held = cachedBrief(persona || '', kind || '', token)
    if (held) {
      if (isDigest) setData(held)
      else setMini(held)
      setLoading(false)
    }
    const qs = new URLSearchParams({ persona: persona || '' })
    if (token) qs.set('t', token)
    else qs.set('email', getSession()?.email || '')
    const url = isDigest ? `/api/digest?${qs}` : `/api/mini?${qs}&kind=${encodeURIComponent(kind || '')}`
    fetch(url)
      .then((res) =>
        res.ok ? (res.json() as Promise<BriefPayload>) : Promise.reject({ status: res.status }),
      )
      .then((d) => {
        if (cancelled) return
        if (isDigest) setData(d)
        else setMini(d)
        saveBrief(persona || '', kind || '', token, d)
      })
      .catch((err) => {
        if (cancelled) return
        if (err && err.status === 401) {
          setExpired(true)
          return
        }
        // A held copy is better than an error over the top of it.
        if (held) return
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

  /* The brief is the heaviest read in the app — two calendars, the inbox, and a
   * model pass over the mail. The server stops waiting after a beat and says
   * `pending` instead of holding the request open, so come back for it quietly.
   * The work is already running server-side; this only waits for it to land in the
   * cache, which is why a few short tries beat one long stare. Both briefs do this
   * now — the evening one used to have no server cache to land in, so it was left
   * out of the ladder and just sat there. */
  useEffect(() => {
    const pending = isDigest ? data?.pending : isEveningBrief ? mini?.pending : false
    const wait = BRIEF_RETRY_MS[briefTries]
    if (!pending || wait === undefined) return
    let cancelled = false
    const timer = setTimeout(() => {
      setBriefTries((n) => n + 1)
      const qs = new URLSearchParams({ persona: persona || '' })
      if (token) qs.set('t', token)
      else qs.set('email', getSession()?.email || '')
      const url = isDigest ? `/api/digest?${qs}` : `/api/mini?${qs}&kind=pick_night`
      fetch(url)
        .then((res) => (res.ok ? (res.json() as Promise<BriefPayload>) : Promise.reject(new Error('brief'))))
        .then((d) => {
          if (cancelled) return
          if (isDigest) setData(d)
          else setMini(d)
          saveBrief(persona || '', kind || '', token, d)
        })
        .catch(() => {})
    }, wait)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [isDigest, isEveningBrief, data?.pending, mini?.pending, briefTries, kind, persona, token])

  const email = getSession()?.email
  const authed = !!token || !!email
  const miniAccent = agent.color
  const miniAccentFg = '#f4f4f5'
  const search = searchParams.toString()
  const q = search ? `?${search}` : ''
  const appsHref = `/app/mini/${persona || 'friend'}/apps${q}`
  const openHref = (featureKind: string) => `/app/mini/${persona || 'friend'}/${featureKind}${q}`
  const aliasKind = kind ? APP_ALIASES[kind] : undefined

  if (aliasKind) {
    return <Navigate to={`/app/mini/${persona || 'friend'}/${aliasKind}${q}`} replace />
  }

  /* 'Next' stopped being a screen: every persona's home leads with the ranked
   * queue, so a lone one-card app in front of it is just a wall. The work-only
   * kinds still redirect for friend, who never had them. */
  if (kind === 'next_move') {
    return <Navigate to={openHref('home')} replace />
  }

  if (
    persona === 'friend' &&
    (kind === 'approve_send' || kind === 'pick_slot' || kind === 'linear_triage' || kind === 'standup_paste')
  ) {
    return <Navigate to={openHref('home')} replace />
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
              {settingsOpen
                ? 'Settings'
                : isApps
                  ? persona === 'friend'
                    ? 'Home'
                    : 'Apps'
                  : isKnown
                    ? kindInfo.title
                    : agent.role}
            </p>
          </div>
          <div className="mini__head-actions">
            {!isApps && kind !== 'next_move' && (
              <Link className="mini__back" to={appsHref} onClick={() => setSettingsOpen(false)}>
                {persona === 'friend' ? 'Home' : 'All apps'}
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
          <div className="mini__body mini__body--home-screen">
            {persona === 'coworker' ? (
              <CoworkerHomeApp
                auth={{
                  persona: (persona as AgentId) || 'friend',
                  email: email || undefined,
                  token: token || undefined,
                }}
              />
            ) : persona === 'cofounder' ? (
              <CofounderHomeApp
                auth={{
                  persona: (persona as AgentId) || 'friend',
                  email: email || undefined,
                  token: token || undefined,
                }}
              />
            ) : (
              <HomeApp
                auth={{
                  persona: (persona as AgentId) || 'friend',
                  email: email || undefined,
                  token: token || undefined,
                }}
              />
            )}
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

        {/* Still assembling. Reads as one continuous load while the retries run,
          * and only asks for a tap once they are spent — an empty BriefApp here
          * would look like a day with nothing in it. */}
        {authed && !expired && !settingsOpen && isDigest && !loading && !data?.error && data?.pending && (
          <div className="mini__body">
            <p className="mini__blurb">Pulling your day together…</p>
            {briefTries >= BRIEF_RETRY_MS.length && (
              <button className="mini__btn" type="button" onClick={() => setBriefTries(0)}>
                Keep waiting
              </button>
            )}
          </div>
        )}

        {authed && !expired && !settingsOpen && isDigest && !loading && !data?.error && !data?.pending && (
          <div className="mini__body">
            <BriefApp
              auth={{
                persona: (persona as AgentId) || 'friend',
                email: email || undefined,
                token: token || undefined,
              }}
              data={data}
              onOpenMail={openMail}
              onOpenDraft={openReplyDraft}
            />
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

        {/* Same shape as the morning brief's wait: the evening one now answers
          * `pending` too rather than holding the request open, and an empty
          * BriefApp would read as an evening with nothing in it. */}
        {authed && !expired && !settingsOpen && isEveningBrief && !loading && !mini?.error && mini?.pending && (
          <div className="mini__body">
            <p className="mini__blurb">{mini.note || 'Closing out your day…'}</p>
            {briefTries >= BRIEF_RETRY_MS.length && (
              <button className="mini__btn" type="button" onClick={() => setBriefTries(0)}>
                Keep waiting
              </button>
            )}
          </div>
        )}

        {authed && !expired && !settingsOpen && isLiveMini && !isDigest && kind === 'pick_night' && !loading && !mini?.error && !mini?.pending && (
          <div className="mini__body">
            <BriefApp
              auth={{
                persona: (persona as AgentId) || 'friend',
                email: email || undefined,
                token: token || undefined,
              }}
              data={null}
              evening={mini}
              onOpenMail={openMail}
              onOpenDraft={openReplyDraft}
            />
          </div>
        )}

        {authed && !expired && !settingsOpen && isLiveMini && !isDigest && kind !== 'pick_night' && !loading && !mini?.error && (
          <div className="mini__body">
            {mini?.date && (
              <div className="ma-hero">
                <span className="ma-hero-kicker">
                  {kind === 'pick_night' ? 'Evening' : kind === 'tonight' ? 'Tonight' : 'Ready'}
                </span>
                <p className="mini__date">{mini.date}</p>
              </div>
            )}
            {mini?.sections?.map((s) => (
              <section key={s.heading} className="mini__section">
                <h2>{s.heading}</h2>
                {s.items?.length ? (
                  <ul className="mini__list">
                    {s.items.map((item, i) => {
                      const emailId = s.emailMeta?.[i]?.id
                      const snippet = s.emailMeta?.[i]?.snippet
                      const isClickable = !!emailId && !emailId.startsWith('text-')
                      return (
                        <li
                          key={i}
                          style={{ whiteSpace: 'pre-wrap' }}
                          className={isClickable ? 'mail-row' : undefined}
                          onClick={isClickable ? () => openMail(emailId, item, snippet) : undefined}
                          role={isClickable ? 'button' : undefined}
                          tabIndex={isClickable ? 0 : undefined}
                          onKeyDown={isClickable ? (ev) => { if (ev.key === 'Enter' || ev.key === ' ') openMail(emailId, item, snippet) } : undefined}
                        >
                          <span className="mail-row-label">{item}</span>
                          {snippet ? <span className="mail-row-snip">{snippet}</span> : null}
                        </li>
                      )
                    })}
                  </ul>
                ) : (
                  <p className="mini__empty">Nothing here yet.</p>
                )}
              </section>
            ))}
            {mini?.paste && kind !== 'pick_night' && (
              <p className="mini__hint">Text {agent.imsgName} to keep going.</p>
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
            {kind === 'home' && (
              persona === 'coworker' ? (
                <CoworkerHomeApp auth={{ persona: (persona as AgentId) || 'friend', email: email || undefined, token: token || undefined }} />
              ) : persona === 'cofounder' ? (
                <CofounderHomeApp auth={{ persona: (persona as AgentId) || 'friend', email: email || undefined, token: token || undefined }} />
              ) : (
                <HomeApp auth={{ persona: (persona as AgentId) || 'friend', email: email || undefined, token: token || undefined }} />
              )
            )}
            {kind === 'body' && (
              <BodyHubApp auth={{ persona: (persona as AgentId) || 'friend', email: email || undefined, token: token || undefined }} />
            )}
            {kind === 'later' && (
              <LaterHubApp auth={{ persona: (persona as AgentId) || 'friend', email: email || undefined, token: token || undefined }} />
            )}
            {kind === 'approve_send' && persona !== 'friend' && (
              <ApproveSendApp
                auth={{ persona: (persona as AgentId) || 'friend', email: email || undefined, token: token || undefined }}
                draftId={searchParams.get('draft') || undefined}
              />
            )}
            {kind === 'pick_slot' && persona !== 'friend' && (
              <PickSlotApp
                auth={{ persona: (persona as AgentId) || 'friend', email: email || undefined, token: token || undefined }}
                draftId={searchParams.get('draft') || undefined}
              />
            )}
            {kind === 'linear_triage' && (
              <LinearTriageApp auth={{ persona: (persona as AgentId) || 'friend', email: email || undefined, token: token || undefined }} />
            )}
            {kind === 'hire_decision' && (
              <HireDecisionApp auth={{ persona: (persona as AgentId) || 'friend', email: email || undefined, token: token || undefined }} />
            )}
            {kind === 'approve_investor_note' && (
              <InvestorNoteApp auth={{ persona: (persona as AgentId) || 'friend', email: email || undefined, token: token || undefined }} />
            )}
          </div>
        )}
      </div>
      {openEmailId && (
        <EmailReader
          messageId={openEmailId}
          label={openEmailLabel}
          summary={openEmailSummary}
          auth={{ email: email || undefined, token: token || undefined }}
          persona={(persona as AgentId) || 'friend'}
          draft={openDraft}
          onClose={() => {
            setOpenEmailId(null)
            setOpenEmailLabel(undefined)
            setOpenEmailSummary(undefined)
            setOpenDraft(null)
          }}
        />
      )}
    </div>
  )
}
