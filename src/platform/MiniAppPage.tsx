import { lazy, Suspense, useCallback, useEffect, useRef, useState, type CSSProperties } from 'react'
import { Link, Navigate, useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { AlphaFace, type AlphaFaceMood } from '../AlphaFace'
import { AGENTS, getAgent } from '../agents'
import type { AgentId } from '../agents/types'
import { getSession } from './roster'
import { APP_ALIASES, KIND_TITLES } from './miniAppCatalog'
import { useRefreshOnFocus } from './useRefreshOnFocus'
import { readBriefCache, writeBriefCache } from './briefCache'
import { applyMiniTheme, readMiniTheme } from './miniTheme'
import { localYmd } from './home'
import { apiSetupStatus } from './api'
import { setupIsDone } from './setupGate'
import { alphaThreadHref } from './alphaLine'
import type { ReplyDraft } from './api'
import { BriefLoading } from './BriefLoading'
import { useSwipeBack } from './useSwipeBack'
import { swipeBackTarget } from './swipeBack'
import './homeA.css'
import './friendBrief.css'


// Download only the screen being opened; keep the surrounding navigation visible.
const DecisionLedgerApp = lazy(() => import('./FeatureMiniApps').then(m => ({ default: m.DecisionLedgerApp })))
const DropZoneApp = lazy(() => import('./FeatureMiniApps').then(m => ({ default: m.DropZoneApp })))
const HabitStreakApp = lazy(() => import('./FeatureMiniApps').then(m => ({ default: m.HabitStreakApp })))
const MeetingModeApp = lazy(() => import('./FeatureMiniApps').then(m => ({ default: m.MeetingModeApp })))
const MoodTrackerApp = lazy(() => import('./FeatureMiniApps').then(m => ({ default: m.MoodTrackerApp })))
const NutritionApp = lazy(() => import('./FeatureMiniApps').then(m => ({ default: m.NutritionApp })))
const OpenLoopsApp = lazy(() => import('./FeatureMiniApps').then(m => ({ default: m.OpenLoopsApp })))
const RelationshipRadarApp = lazy(() => import('./FeatureMiniApps').then(m => ({ default: m.RelationshipRadarApp })))
const BuildsApp = lazy(() => import('./FeatureMiniApps').then(m => ({ default: m.BuildsApp })))
const LearningQueueApp = lazy(() => import('./LifeMiniApps').then(m => ({ default: m.LearningQueueApp })))
const NetworkingCrmApp = lazy(() => import('./LifeMiniApps').then(m => ({ default: m.NetworkingCrmApp })))
const PipelineBoardApp = lazy(() => import('./LifeMiniApps').then(m => ({ default: m.PipelineBoardApp })))
const SleepTrackerApp = lazy(() => import('./LifeMiniApps').then(m => ({ default: m.SleepTrackerApp })))
const SpendingSnapshotApp = lazy(() => import('./SpendingSnapshotApp').then(m => ({ default: m.SpendingSnapshotApp })))
const WeeklyReviewApp = lazy(() => import('./LifeMiniApps').then(m => ({ default: m.WeeklyReviewApp })))
const WorkoutLogApp = lazy(() => import('./LifeMiniApps').then(m => ({ default: m.WorkoutLogApp })))
const MiniAppSettings = lazy(() => import('./MiniAppSettings').then(m => ({ default: m.MiniAppSettings })))
const SetupApp = lazy(() => import('./SetupApp').then(m => ({ default: m.SetupApp })))
const HomeApp = lazy(() => import('./HomeApp').then(m => ({ default: m.HomeApp })))
const ArtifactApp = lazy(() => import('./WorkHomes').then(m => ({ default: m.ArtifactApp })))
const CofounderHomeApp = lazy(() => import('./WorkHomes').then(m => ({ default: m.CofounderHomeApp })))
const CoworkerHomeApp = lazy(() => import('./WorkHomes').then(m => ({ default: m.CoworkerHomeApp })))
const FriendBrief = lazy(() => import('./FriendBrief').then(m => ({ default: m.FriendBrief })))
const BriefApp = lazy(() => import('./BriefApp').then(m => ({ default: m.BriefApp })))
/* The next morning brief, prototyped in src/lab. Mock data for now; `?brief=classic`
 * puts the shipped brief back while the two are compared. */
const NextBriefEmbedded = lazy(() => import('../lab/EmailBrief').then((m) => ({ default: m.NextBriefEmbedded })))
const NextBriefEvening = lazy(() => import('../lab/EmailBrief').then((m) => ({ default: m.NextBriefEvening })))
const BodyHubApp = lazy(() => import('./FriendHubApps').then(m => ({ default: m.BodyHubApp })))
const LaterHubApp = lazy(() => import('./FriendHubApps').then(m => ({ default: m.LaterHubApp })))
const ApproveSendApp = lazy(() => import('./WorkMiniApps').then(m => ({ default: m.ApproveSendApp })))
const PickSlotApp = lazy(() => import('./WorkMiniApps').then(m => ({ default: m.PickSlotApp })))
const LinearTriageApp = lazy(() => import('./WorkMiniApps').then(m => ({ default: m.LinearTriageApp })))
const HireDecisionApp = lazy(() => import('./WorkMiniApps').then(m => ({ default: m.HireDecisionApp })))
const InvestorNoteApp = lazy(() => import('./WorkMiniApps').then(m => ({ default: m.InvestorNoteApp })))
const ApprovePurchaseApp = lazy(() => import('./ApprovePurchaseApp').then(m => ({ default: m.ApprovePurchaseApp })))
const StandupPasteApp = lazy(() => import('./WorkMiniApps').then(m => ({ default: m.StandupPasteApp })))
const EmailReader = lazy(() => import('./EmailReader').then(m => ({ default: m.EmailReader })))
const VaultApp = lazy(() => import('./VaultApp').then(m => ({ default: m.VaultApp })))

interface DigestData {
  date?: string
  generatedAt?: number
  calendar?: string[]
  emails?: string[]
  emailItems?: Array<{ id: string; label: string; snippet?: string }>
  mailGroups?: import('./briefStory').BriefMailGroup[]
  mailTally?: string
  needsYou?: import('./briefStory').NeedsYouItem[]
  mailStatus?: 'ok' | 'not_connected' | 'auth_expired' | 'timeout' | 'provider_error'
  mailFailed?: boolean
  calendarStatus?: 'ok' | 'not_connected' | 'auth_expired' | 'timeout' | 'provider_error'
  calendarFailed?: boolean
  reminders?: Array<{ time?: string; text?: string }>
  events?: Array<{ id: string; label: string }>
  tomorrow?: string[]
  brief?: 'morning' | 'evening'
  story?: import('./briefStory').BriefStory
  /** Today's soonest meetings, soonest first. Optional until the server ships it. */
  meetings?: Array<{ time: string; title: string; startsInMin?: number }>
  /** The one email that needs a human now, or null. Optional until the server ships it. */
  attention?: { id: string; label: string; snippet?: string; why: string } | null
  error?: string
  /* The server answered before the brief finished assembling. Not an error: the
   * load is still running behind that response, so the right move is to come
   * back for it rather than to tell the user anything. */
  pending?: boolean
  /* Free-tier rationing served a stale-but-same-day payload on purpose. The
   * brief still paints (the data is real), but the UI shows a "refreshes used
   * up" line so the user knows to upgrade. */
  limited?: boolean
  used?: number
  limit?: number
}

interface MiniSection {
  heading: string
  items: string[]
  emailMeta?: Array<{ id: string; snippet?: string; kind?: string }>
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
  mailGroups?: import('./briefStory').BriefMailGroup[]
  mailStatus?: 'ok' | 'not_connected' | 'auth_expired' | 'timeout' | 'provider_error'
  calendarStatus?: 'ok' | 'not_connected' | 'auth_expired' | 'timeout' | 'provider_error'
  error?: string
  /* Same contract as the morning brief: the evening one is heavy enough that the
   * server answers before it is built rather than holding the request open. */
  pending?: boolean
  note?: string
  /* Free-tier rationing served a stale-but-same-day payload on purpose. */
  limited?: boolean
  used?: number
  limit?: number
}

/** The two kinds the device holds onto. Everything else is small and fast enough
 * that a spinner is honest. */
const BRIEF_CACHE_KINDS = new Set(['digest', 'pick_night'])

type BriefPayload = DigestData & MiniPayload

/** This device's last copy of one brief, or null. Module-level so the first-frame
 * seed and a kind change on an already-mounted page read it the same way. */
function cachedBrief(persona: string, kind: string, token: string): { brief: BriefPayload; at: number } | null {
  if (!BRIEF_CACHE_KINDS.has(kind)) return null
  const env = readBriefCache<{ brief: BriefPayload; at: number }>(
    { email: getSession()?.email, token, persona },
    kind,
    localYmd(),
    Date.now(),
  )
  const b = env && typeof env === 'object' && 'brief' in (env as Record<string, unknown>) ? (env as { brief: BriefPayload; at: number }).brief : (env as unknown as BriefPayload)
  const at = env && typeof env === 'object' && 'at' in (env as Record<string, unknown>) ? Number((env as Record<string, unknown>).at) || 0 : 0
  if (!b) return null
  if (b && Array.isArray((b as any).dayFacts)) {
    (b as any).dayFacts = (b as any).dayFacts.filter(
      (f: any) => f?.key !== 'gratitude' && !/gratitude/i.test(f?.label || '') && !/gratitude/i.test(f?.key || '')
    )
  }
  return { brief: b, at }
}

function saveBrief(persona: string, kind: string, token: string, brief: BriefPayload) {
  if (!BRIEF_CACHE_KINDS.has(kind)) return
  if (brief && Array.isArray((brief as any).dayFacts)) {
    (brief as any).dayFacts = (brief as any).dayFacts.filter(
      (f: any) => f?.key !== 'gratitude' && !/gratitude/i.test(f?.label || '') && !/gratitude/i.test(f?.key || '')
    )
  }
  writeBriefCache({ email: getSession()?.email, token, persona }, kind, brief, localYmd(), Date.now())
}

/* Delays, not one interval. The build is already running server-side and lands in
 * the cache when it lands, so ask again soon at first and back off after —
 * cumulatively 0.4s, 1.0, 1.9, 3.2, 5.0, 7.4. The old ladder was four flat
 * 1600ms tries, which meant nothing before 1.6s and nothing after 6.4s. */
const BRIEF_RETRY_MS = [250, 450, 700, 1000, 1400, 1900, 2500, 3200]

const LIVE_MINI_KINDS = new Set(['digest', 'pick_night', 'tonight', 'kill_keep_park'])

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
  'spending_snapshot',
  'home',
  'body',
  'later',
  'approve_send',
  'pick_slot',
  'linear_triage',
  'standup_paste',
  'hire_decision',
  'approve_investor_note',
  'approve_purchase',
  'builds',
  'vault',
])


const FRIEND_KIND_TITLES: Record<string, { title: string; blurb: string }> = {
  home: { title: 'Home', blurb: 'Today, next eight hours, and receipts.' },
  next_move: { title: 'Next', blurb: 'The one thing to do now.' },
  digest: { title: 'Morning brief', blurb: 'Who is next, what to do, what can wait.' },
  networking_crm: { title: 'People', blurb: 'Who to follow up.' },
  pick_night: { title: 'Evening brief', blurb: 'What happened and what is left.' },
  learning_queue: { title: 'Learning', blurb: 'What to read or watch next.' },
  drop_zone: { title: 'Save for later', blurb: 'Dump anything and Alpha sorts it later.' },
  approve_purchase: { title: 'Order Review', blurb: 'Review your item, shipping address, and approve the order.' },
}


export function MiniAppPage() {
  const params = useParams()
  /* Only real hires exist. Anything else in the URL (stale link, hand-typed,
   * old "feature" persona from an earlier shell) falls back to friend here so
   * the apps grid and every link it builds stay on valid personas; the server
   * rejects unknown personas with a 400. */
  const persona = (AGENTS.some((a) => a.id === params.persona) ? params.persona : 'friend') as AgentId
  const kind = params.kind
  const [searchParams] = useSearchParams()
  const classicBrief = searchParams.get('brief') === 'classic'
  const friendBrief = persona === 'friend' && (kind === 'digest' || kind === 'pick_night') && !classicBrief
  const navigate = useNavigate()
  const token = searchParams.get('t') || ''
  const agent = getAgent(persona)
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
  const [data, setData] = useState<DigestData | null>(() => (kind === 'digest' ? seed?.brief ?? null : null))
  /** When the model on screen was built. The cache envelope knows for the seed,
   *  and every fetch that lands a real payload updates it. */
  const [updatedAt, setUpdatedAt] = useState<number>(() => seed?.at ?? 0)
  const [fetching, setFetching] = useState(false)
  const [mini, setMini] = useState<MiniPayload | null>(() => (kind === 'digest' ? null : seed?.brief ?? null))
  const currentBriefRef = useRef<BriefPayload | null>(null)
  currentBriefRef.current = (kind === 'digest' ? data : mini) as BriefPayload | null
  const [loading, setLoading] = useState(!seed)
  const [refreshError, setRefreshError] = useState('')
  const [briefTries, setBriefTries] = useState(0)
  const [expired, setExpired] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [settingsTick, setSettingsTick] = useState(0)
  /** menu card doubles as the onboarding wizard until setup is done. */
  const [setupDone, setSetupDone] = useState<boolean | null>(null)
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

  const closeMail = useCallback(() => {
    setOpenEmailId(null)
    setOpenEmailLabel(undefined)
    setOpenEmailSummary(undefined)
    setOpenDraft(null)
  }, [])

  const isDigest = kind === 'digest'
  const isEveningBrief = kind === 'pick_night'
  const isMenu = kind === 'menu' || kind === 'setup' || kind === 'onboarding'
  const isApps = kind === 'apps' || isMenu
  const isLiveMini = LIVE_MINI_KINDS.has(kind || '')
  const isFeature = FEATURE_KINDS.has(kind || '')
  const isKnown = isLiveMini || isFeature || isApps || isDigest

  useEffect(() => {
    setSettingsOpen(false)
    setExpired(false)
    setRefreshError('')
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

  /* Fetch the live brief, painting the held copy first. Runs on mount and on
   * return-to-focus (see useRefreshOnFocus below): the cache read up front is
   * what keeps a reopened brief instant — the network only refreshes behind
   * whatever is already on screen. */
  const refresh = useCallback((opts?: { force?: boolean }): Promise<void> => {
    if (!isLiveMini) {
      setLoading(false)
      return Promise.resolve()
    }
    if (!token && !getSession()?.email) {
      setLoading(false)
      return Promise.resolve()
    }
    setBriefTries(0)
    setRefreshError('')
    /* The held copy is what makes a normal reopen instant: paint it, fetch over
     * the top. A manual refresh must NOT paint the held copy first — the user
     * asked for fresh data and showing them their stale copy while a request is
     * in flight is the bug that "the brief never updates" describes. The seed
     * stays so the next normal open still paints instantly; this open shows the
     * spinner instead. */
    const held = opts?.force ? null : cachedBrief(persona || '', kind || '', token)
    if (held) {
      if (isDigest) setData(held.brief)
      else setMini(held.brief)
      setUpdatedAt(held.at)
      setLoading(false)
    } else {
      // If we already have content on screen, do not show a blank loading spinner on background refresh
      if (isDigest) {
        setData((prev) => {
          if (!opts?.force && !prev?.calendar?.length && !prev?.emails?.length && !prev?.story) {
            setLoading(true)
          }
          return prev
        })
      } else {
        setMini((prev) => {
          if (!opts?.force && !prev?.sections?.length && !prev?.mailGroups?.length) {
            setLoading(true)
          }
          return prev
        })
      }
    }
    const qs = new URLSearchParams({ persona: persona || '' })
    if (token) qs.set('t', token)
    else qs.set('email', getSession()?.email || '')
    /* The server already sends short stale-while-revalidate headers, so a normal
     * open is cheap. A manual refresh must always hit the server, though: the
     * browser can otherwise serve the same body from its own cache for the whole
     * SWR window and the user sees nothing change. `_t` busts both the browser
     * cache (it's a different query) and the server's brief cache (the loader
     * keys on userId+persona+kind only, but the in-memory layer is per-process
     * and the SWR covers it). */
    if (opts?.force) qs.set('_t', Date.now().toString())
    const url = isDigest ? `/api/digest?${qs}` : `/api/mini?${qs}&kind=${encodeURIComponent(kind || '')}`
    setFetching(true)
    return fetch(url)
      .then((res) =>
        res.ok ? (res.json() as Promise<BriefPayload>) : Promise.reject({ status: res.status }),
      )
      .then((d) => {
        if (isDigest) {
          setData((prev) => (d.pending && (prev?.calendar?.length || prev?.emails?.length || prev?.story || prev?.meetings?.length || prev?.mailGroups?.length) ? { ...prev, pending: true } : d))
        } else {
          setMini((prev) => (d.pending && (prev?.sections?.length || prev?.mailGroups?.length) ? { ...prev, pending: true } : d))
        }
        if (!d.pending) {
          saveBrief(persona || '', kind || '', token, d)
          setUpdatedAt(Date.now())
          setRefreshError('')
        }
        setFetching(false)
      })
      .catch((err) => {
        if (err && err.status === 401) {
          setExpired(true)
          return
        }
        // A failed update must not erase a brief already on screen.
        if (held || (currentBriefRef.current && !currentBriefRef.current.error)) {
          setRefreshError('Could not update this brief. Showing the last good copy.')
          return
        }
        if (isDigest) setData({ error: "Couldn't load your brief right now." })
        else setMini({ error: "Couldn't load this right now." })
      })
      .finally(() => {
        setFetching(false)
        setLoading(false)
      })
  }, [kind, persona, token, isDigest, isLiveMini])

  useEffect(() => {
    refresh()
  }, [refresh])
  /* Leaving the app and coming back should refresh the brief, not leave stale
   * mail on screen — and the held-copy paint above means that refresh never
   * shows the spinner. Home does the same. */
  useRefreshOnFocus(refresh)

  /* The brief is the heaviest read in the app — two calendars, the inbox, and a
   * model pass over the mail. The server stops waiting after a beat and says
   * `pending` instead of holding the request open, so come back for it quietly.
   * The work is already running server-side; this only waits for it to land in the
   * cache, which is why a few short tries beat one long stare. Both briefs do this
   * now — the evening one used to have no server cache to land in, so it was left
   * out of the ladder and just sat there. */
  useEffect(() => {
    const pending = isDigest ? data?.pending : isEveningBrief ? mini?.pending : false
    if (!pending) return
    // A cold build (two calendars, the inbox, a model pass) routinely outlasts
    // the fast ladder, so past it the poll settles into a slower beat rather
    // than giving up — the screen must update on its own, never require the
    // user to leave and come back. Hard cap so a crashed build cannot spin.
    const wait = BRIEF_RETRY_MS[briefTries] ?? 4000
    if (briefTries >= BRIEF_RETRY_MS.length + 30) {
      const message = 'This update is taking too long. Try refreshing again.'
      if (isDigest) {
        setData((prev) => prev?.story || prev?.calendar?.length || prev?.meetings?.length || prev?.mailGroups?.length
          ? { ...prev, pending: false }
          : { error: message })
      } else {
        setMini((prev) => prev?.sections?.length || prev?.mailGroups?.length
          ? { ...prev, pending: false }
          : { error: message })
      }
      setRefreshError(message)
      return
    }
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
          if (isDigest) {
            setData((prev) => d.pending && (prev?.story || prev?.calendar?.length || prev?.meetings?.length || prev?.mailGroups?.length)
              ? { ...prev, pending: true }
              : d)
          } else {
            setMini((prev) => d.pending && (prev?.sections?.length || prev?.mailGroups?.length)
              ? { ...prev, pending: true }
              : d)
          }
          if (!d.pending) {
            saveBrief(persona || '', kind || '', token, d)
            setUpdatedAt(Date.now())
            setRefreshError('')
          }
        })
        .catch(() => {})
    }, wait)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [isDigest, isEveningBrief, data?.pending, mini?.pending, briefTries, kind, persona, token])

  const email = getSession()?.email

  /* The menu card is the onboarding wizard until the person has told Alpha
   * what to watch: features, goals, sleep, workout days, budget, connectors. */
  const isMenuCard = isMenu && persona === 'friend'
  useEffect(() => {
    if (!isMenuCard || !(token || email)) {
      setSetupDone(null)
      return
    }
    let cancelled = false
    /* One decision, three signals, in the order that matters: a finished wizard
     * stays finished, a wizard still in flight is NOT finished however done the
     * server thinks it is (the connect-page bug), and otherwise the server
     * answers. See setupGate.ts. */
    try {
      const emailKey = email ? `ha_setup_done_${email.toLowerCase().trim()}` : null
      const decided = setupIsDone({
        localDone: localStorage.getItem(emailKey || 'ha_setup_done'),
        stepInFlight: localStorage.getItem('ha_setup_step'),
        serverDone: null,
      })
      if (decided !== null) {
        setSetupDone(decided)
        return
      }
    } catch {
      /* private mode */
    }
    apiSetupStatus({ persona: 'friend', email: email || undefined, token: token || undefined })
      .then((s) => {
        if (!cancelled) setSetupDone(!!s.setupDone)
      })
      .catch(() => {
        // If status call fails when explicitly visiting the menu card, do not prematurely treat setup as done;
        // let the onboarding wizard render so the user can configure their setup.
        if (!cancelled) setSetupDone(false)
      })
    return () => {
      cancelled = true
    }
  }, [isMenuCard, token, email])
  const authed = !!token || !!email
  const miniAccent = agent.color
  const miniAccentFg = '#f4f4f5'
  const search = searchParams.toString()
  const q = search ? `?${search}` : ''
  const appsHref = `/app/mini/${persona || 'friend'}/apps${q}`
  const openHref = (featureKind: string) => `/app/mini/${persona || 'friend'}/${featureKind}${q}`
  const aliasKind = kind ? APP_ALIASES[kind] : undefined

  /* Swipe right to go back, the way a phone does it: whatever is open on top
   * closes first, then the screen the user came from. */
  const swipeBack = useCallback(() => {
    const target = swipeBackTarget({
      mailOpen: !!openEmailId,
      sheetOpen: settingsOpen,
      historyIdx: (window.history.state as { idx?: number } | null)?.idx ?? 0,
      homeHref: appsHref,
    })
    if (target.kind === 'mail') return closeMail()
    if (target.kind === 'sheet') {
      setSettingsOpen(false)
      setSettingsTick((n) => n + 1)
      return
    }
    if (target.kind === 'history') return navigate(-1)
    navigate(target.href, { replace: true })
  }, [openEmailId, settingsOpen, closeMail, navigate, appsHref])
  const swipeHintRef = useSwipeBack({ onBack: swipeBack })
  const swipeHint = (
    <div className="swipe-back-hint" ref={swipeHintRef} aria-hidden="true">
      <span className="swipe-back-hint__pill">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <path
            d="M15 6l-6 6 6 6"
            stroke="currentColor"
            strokeWidth="2.25"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </span>
    </div>
  )

  if (aliasKind) {
    return <Navigate to={`/app/mini/${persona || 'friend'}/${aliasKind}${q}`} replace />
  }

  /* 'Next' stopped being a screen: every persona's home leads with the ranked
   * queue, so a lone one-card app in front of it is just a wall. The work-only
   * kinds still redirect for friend, who never had them. */
  if (kind === 'next_move') {
    return <Navigate to={openHref('home')} replace />
  }

  /* Your builds: every workshop artifact, newest first. */
  if (kind === 'builds') {
    return (
      <div className="mini hA-screen" style={{ '--mini-accent': miniAccent, '--mini-accent-fg': miniAccentFg } as CSSProperties}>
        <div className="mini__card">
          <header className="mini__head">
            <Link className="mini__nav" to={appsHref} aria-label="Back to all apps">
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                <path d="M15 6l-6 6 6 6" stroke="currentColor" strokeWidth="2.25" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </Link>
          </header>
          <div className="mini__body">
            <BuildsApp
              auth={{ persona: (persona as AgentId) || 'friend', email: email || undefined, token: token || undefined }}
              persona={(persona as AgentId) || 'friend'}
            />
          </div>
        </div>
        {swipeHint}
      </div>
    )
  }

  /* Workshop artifacts: the built thing, with keep-or-toss. */
  if (kind === 'artifact') {
    return (
      <div className="mini hA-screen" style={{ '--mini-accent': miniAccent, '--mini-accent-fg': miniAccentFg } as CSSProperties}>
        <div className="mini__card">
          <header className="mini__head">
            <Link className="mini__nav" to={appsHref} aria-label="Back to all apps">
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                <path d="M15 6l-6 6 6 6" stroke="currentColor" strokeWidth="2.25" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </Link>
          </header>
          <div className="mini__body">
            <ArtifactApp
              auth={{ persona: (persona as AgentId) || 'friend', email: email || undefined, token: token || undefined }}
              id={searchParams.get('id') || undefined}
            />
          </div>
        </div>
        {swipeHint}
      </div>
    )
  }

  /* In-thread Vault: save encrypted credentials or private handoff. */
  if (kind === 'vault') {
    return (
      <div className="mini hA-screen" style={{ '--mini-accent': miniAccent, '--mini-accent-fg': miniAccentFg } as CSSProperties}>
        <div className="mini__card">
          <header className="mini__head">
            <a
              className="mini__back"
              href={alphaThreadHref()}
              onClick={(e) => {
                if (window.history.length > 1) {
                  e.preventDefault()
                  window.history.back()
                }
              }}
              aria-label="Return to iMessage"
            >
              ‹ Messages
            </a>
            <div className="mini__head-actions">
              <Link className="mini__back" to={appsHref} style={{ opacity: 0.7 }}>
                All apps
              </Link>
            </div>
          </header>
          <div className="mini__body">
            <Suspense fallback={<div className="mini__loading" role="status" style={{ padding: 24 }}>Loading vault…</div>}>
              <VaultApp
                auth={{ persona: (persona as AgentId) || 'friend', email: email || undefined, token: token || undefined }}
                portal={searchParams.get('portal') || undefined}
              />
            </Suspense>
          </div>
        </div>
        {swipeHint}
      </div>
    )
  }

  /* approve_send and pick_slot are deliberately NOT redirected for the friend:
   * canonicalMiniAppKind stopped folding them into home (spectrum/shared/
   * miniApps.ts) because the friend drafts replies and calendar events now, and
   * this redirect made the card's "tap to confirm" promise dead — the tap
   * landed on home, which has no confirm UI, so the mail never went and the
   * event never landed. The render branch below is the only surface that can
   * send or book a friend draft. Home still backs the kinds that are hubs
   * there (linear_triage, standup_paste). */
  if (persona === 'friend' && (kind === 'linear_triage' || kind === 'standup_paste')) {
    return <Navigate to={openHref('home')} replace />
  }

  return (
    <div className={`mini hA-screen${friendBrief ? ' fb-screen' : ''}`} style={{ '--mini-accent': miniAccent, '--mini-accent-fg': miniAccentFg } as CSSProperties}>
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
        <Suspense fallback={<div className="mini__loading" role="status" style={{ padding: 24 }}>Loading your app…</div>}>

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
            {isMenuCard && setupDone === null ? (
              <BriefLoading calm={friendBrief} />
            ) : isMenuCard && setupDone === false ? (
              <SetupApp
                auth={{
                  persona: (persona as AgentId) || 'friend',
                  email: email || undefined,
                  token: token || undefined,
                }}
              />
            ) : persona === 'coworker' ? (
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
              (() => {
                /* Home A (HomeApp) is the canonical home screen. */
                const skinAuth = {
                  persona: (persona as AgentId) || 'friend',
                  email: email || undefined,
                  token: token || undefined,
                }
                return <HomeApp auth={skinAuth} />
              })()
            )}
          </div>
        )}

        {authed && !expired && !settingsOpen && isDigest && !classicBrief && !loading && !data?.error && (!data?.pending || !!(data?.calendar?.length || data?.story || data?.meetings?.length || data?.emails?.length)) && (
          <div className="mini__body">
            <Suspense fallback={<BriefLoading calm={friendBrief} attempt={briefTries} />}>
              {friendBrief ? <FriendBrief
                key="morning"
                data={data}
                auth={{ persona: 'friend', email: email || undefined, token: token || undefined }}
                updatedAt={updatedAt}
                refreshing={fetching || !!data?.pending}
                refreshError={refreshError}
                onRefresh={() => refresh({ force: true })}
                href={openHref}
                onSettings={() => setSettingsOpen(true)}
                onOpenMail={openMail}
                onOpenDraft={openReplyDraft}
              /> : <NextBriefEmbedded
                data={data}
                updatedAt={updatedAt}
                refreshing={fetching || !!data?.pending}
                onRefresh={() => refresh({ force: true })}
              />}
            </Suspense>
          </div>
        )}

        {authed && !expired && !settingsOpen && isDigest && loading && !data && (
          <div className="mini__body">
            <BriefLoading calm={friendBrief} attempt={briefTries} />
          </div>
        )}

        {authed && !expired && !settingsOpen && isDigest && !loading && data?.error && (
          <div className="mini__body">
            <p className="mini__blurb">{data.error}</p>
            <button
              className="mini__btn"
              type="button"
              onClick={() => {
                setData(null)
                void refresh({ force: true })
              }}
            >
              Try again
            </button>
          </div>
        )}

        {/* Still assembling. Reads as one continuous load while the retries run,
          * and only asks for a tap once they are spent — an empty BriefApp here
          * would look like a day with nothing in it. */}
        {/* If pending with no data yet, show loading progress */}
        {authed && !expired && !settingsOpen && isDigest && !loading && !data?.error && data?.pending && (!data?.calendar?.length && !data?.story && !data?.meetings?.length && !data?.emails?.length) && (
          <div className="mini__body">
            <BriefLoading calm={friendBrief} attempt={briefTries} />
            {briefTries >= BRIEF_RETRY_MS.length + 30 && (
              <button className="mini__btn" type="button" onClick={() => setBriefTries(0)}>
                Try again
              </button>
            )}
          </div>
        )}

        {authed && !expired && !settingsOpen && isDigest && classicBrief && !loading && !data?.error && (!data?.pending || !!(data?.calendar?.length || data?.story || data?.meetings?.length || data?.emails?.length)) && (
          <div className="mini__body">
            <BriefApp
              auth={{
                persona: (persona as AgentId) || 'friend',
                email: email || undefined,
                token: token || undefined,
              }}
              data={data}
              onRefresh={refresh}
              onOpenMail={openMail}
              onOpenDraft={openReplyDraft}
            />
          </div>
        )}

        {authed && !expired && !settingsOpen && isLiveMini && !isDigest && loading && (
          <div className="mini__body">
            {isEveningBrief ? <BriefLoading calm={friendBrief} evening attempt={briefTries} /> : <p className="mini__blurb">Working it out…</p>}
          </div>
        )}

        {authed && !expired && !settingsOpen && isLiveMini && !isDigest && !loading && mini?.error && (
          <div className="mini__body">
            <p className="mini__blurb" role="alert">{mini.error}</p>
            <button className="mini__btn" type="button" onClick={() => void refresh({ force: true })}>Try again</button>
          </div>
        )}

        {/* Same shape as morning: show loading only when cold with no data */}
        {authed && !expired && !settingsOpen && isEveningBrief && !loading && !mini?.error && mini?.pending && (!mini?.sections?.length && !mini?.mailGroups?.length) && (
          <div className="mini__body">
            <BriefLoading calm={friendBrief} evening attempt={briefTries} />
            {briefTries >= BRIEF_RETRY_MS.length + 30 && (
              <button className="mini__btn" type="button" onClick={() => setBriefTries(0)}>
                Try again
              </button>
            )}
          </div>
        )}

        {authed && !expired && !settingsOpen && isLiveMini && !isDigest && kind === 'pick_night' && !classicBrief && !loading && !mini?.error && (!mini?.pending || !!(mini?.sections?.length || mini?.mailGroups?.length)) && (
          <div className="mini__body">
            <Suspense fallback={<BriefLoading calm={friendBrief} evening attempt={briefTries} />}>
              {friendBrief ? <FriendBrief
                key="evening"
                evening
                data={mini}
                auth={{ persona: 'friend', email: email || undefined, token: token || undefined }}
                updatedAt={updatedAt}
                refreshing={fetching || !!mini?.pending}
                refreshError={refreshError}
                onRefresh={() => refresh({ force: true })}
                href={openHref}
                onSettings={() => setSettingsOpen(true)}
                onOpenMail={openMail}
                onOpenDraft={openReplyDraft}
              /> : <NextBriefEvening evening={mini} />}
            </Suspense>
          </div>
        )}

        {authed && !expired && !settingsOpen && isLiveMini && !isDigest && kind === 'pick_night' && classicBrief && !loading && !mini?.error && (!mini?.pending || !!(mini?.sections?.length || mini?.mailGroups?.length)) && (
          <div className="mini__body">
            <BriefApp
              auth={{
                persona: (persona as AgentId) || 'friend',
                email: email || undefined,
                token: token || undefined,
              }}
              data={null}
              evening={mini}
              onRefresh={refresh}
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
            {/* Both screens were coworker-and-up only, from when the friend
              * never drafted anything. It drafts events and replies now, and
              * this is the only surface that can confirm them — the card's
              * whole promise is the tap. */}
            {kind === 'approve_send' && (
              <ApproveSendApp
                auth={{ persona: (persona as AgentId) || 'friend', email: email || undefined, token: token || undefined }}
                draftId={searchParams.get('draft') || undefined}
              />
            )}
            {kind === 'pick_slot' && (
              <PickSlotApp
                auth={{ persona: (persona as AgentId) || 'friend', email: email || undefined, token: token || undefined }}
                draftId={searchParams.get('draft') || undefined}
              />
            )}
            {kind === 'linear_triage' && (
              <LinearTriageApp auth={{ persona: (persona as AgentId) || 'friend', email: email || undefined, token: token || undefined }} />
            )}
            {kind === 'standup_paste' && persona !== 'friend' && (
              <StandupPasteApp auth={{ persona: (persona as AgentId) || 'friend', email: email || undefined, token: token || undefined }} />
            )}
            {kind === 'hire_decision' && (
              <HireDecisionApp auth={{ persona: (persona as AgentId) || 'friend', email: email || undefined, token: token || undefined }} />
            )}
            {kind === 'approve_investor_note' && (
              <InvestorNoteApp auth={{ persona: (persona as AgentId) || 'friend', email: email || undefined, token: token || undefined }} />
            )}
            {kind === 'approve_purchase' && (
              <ApprovePurchaseApp
                auth={{ persona: (persona as AgentId) || 'friend', email: email || undefined, token: token || undefined }}
                spendId={searchParams.get('id') || searchParams.get('spend') || undefined}
              />
            )}
            {kind === 'vault' && (
              <VaultApp
                auth={{ persona: (persona as AgentId) || 'friend', email: email || undefined, token: token || undefined }}
                portal={searchParams.get('portal') || undefined}
              />
            )}
          </div>
        )}
        </Suspense>
      </div>
      {openEmailId && (
        <Suspense fallback={<p role="status">Opening email…</p>}>
        <EmailReader
          messageId={openEmailId}
          label={openEmailLabel}
          summary={openEmailSummary}
          auth={{ persona: (persona as AgentId) || 'friend', email: email || undefined, token: token || undefined }}
          persona={(persona as AgentId) || 'friend'}
          draft={openDraft}
          onClose={closeMail}
          onSent={() => { if (isDigest || isEveningBrief) void refresh({ force: true }) }}
        />
        </Suspense>
      )}
      {swipeHint}
    </div>
  )
}
