import { useCallback, useEffect, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { apiListLoops, apiListSleep, apiHome, type HomeSnapshot, type OpenLoop, type SleepNight } from './api'
import type { FeatureAuth } from './FeatureMiniApps'
import { dayStamp, localYmd, pickLastNight, shiftYmd } from './home'
import { promisesHubHint } from './promisesHint'

type HubLink = { kind: string; title: string; hint: string }

const LATER_LINKS: HubLink[] = [
  { kind: 'drop_zone', title: 'Drop zone', hint: 'Dump anything. Alpha files it.' },
  { kind: 'learning_queue', title: 'Learning', hint: 'Read and watch list' },
  { kind: 'open_loops', title: 'Promises', hint: 'Catch what you told someone you would do' },
  { kind: 'gratitude_journal', title: 'Gratitude', hint: 'One sentence a day' },
  { kind: 'weekly_review', title: 'Weekly focus', hint: 'One fix for next week' },
]

function formatClock12(hhmm: string) {
  const [hRaw, mRaw] = hhmm.split(':')
  const h = Number(hRaw)
  const m = Number(mRaw)
  if (!Number.isFinite(h) || !Number.isFinite(m)) return hhmm
  const am = h < 12
  const h12 = h % 12 || 12
  return `${h12}:${String(m).padStart(2, '0')} ${am ? 'AM' : 'PM'}`
}

function HubList({ auth, links, lead }: { auth: FeatureAuth; links: HubLink[]; lead: string }) {
  const [searchParams] = useSearchParams()
  const q = searchParams.toString()
  const suffix = q ? `?${q}` : ''
  const href = (kind: string) => `/app/mini/${auth.persona}/${kind}${suffix}`

  return (
    <div className="ma hub">
      <p className="mini__empty hub-lead">{lead}</p>
      <ul className="hub-list">
        {links.map((item) => (
          <li key={item.kind}>
            <Link className="hub-row" to={href(item.kind)}>
              <span className="hub-text">
                <span className="hub-title">{item.title}</span>
                <span className="hub-hint">{item.hint}</span>
              </span>
              <span className="hub-go" aria-hidden="true">›</span>
            </Link>
          </li>
        ))}
      </ul>
    </div>
  )
}

export function BodyHubApp({ auth }: { auth: FeatureAuth }) {
  const [searchParams] = useSearchParams()
  const q = searchParams.toString()
  const suffix = q ? `?${q}` : ''
  const href = (kind: string) => `/app/mini/${auth.persona}/${kind}${suffix}`
  const [snap, setSnap] = useState<HomeSnapshot | null>(null)
  const [nights, setNights] = useState<SleepNight[]>([])

  const load = useCallback(() => {
    Promise.all([
      apiHome({ email: auth.email, token: auth.token }).catch(() => null),
      apiListSleep({ email: auth.email, token: auth.token }).catch(() => ({ nights: [] as SleepNight[] })),
    ]).then(([d, sleep]) => {
      if (d) setSnap(d)
      setNights(sleep.nights || [])
    })
  }, [auth.email, auth.token])
  useEffect(() => { load() }, [load])

  const home = snap?.home
  const w = snap?.window
  const today = localYmd()
  const yest = shiftYmd(today, -1)
  const fromSleep = pickLastNight(nights, today)
  const fromTrend = (snap?.sleepTrend || []).find((n) => {
    const d = dayStamp(n.date)
    return (d === today || d === yest) && n.hours > 0
  })
  const lastNight = fromSleep.logged
    ? fromSleep
    : home?.lastNight?.logged
      ? home.lastNight
      : fromTrend
        ? { logged: true, hours: fromTrend.hours, bedtime: undefined as string | undefined, wake: undefined as string | undefined }
        : w?.lastNightHours
          ? { logged: true, hours: w.lastNightHours }
          : { logged: false, hours: 0 }
  const sleep = lastNight.logged
    ? `${lastNight.hours}h${lastNight.bedtime && lastNight.wake ? `  ${formatClock12(lastNight.bedtime)} to ${formatClock12(lastNight.wake)}` : ''}`
    : 'Not logged'
  const food = `${Math.round(w?.proteinToday || 0)}g of ${Math.round(w?.proteinGoal || 150)}`
  const train = home?.workout.done ? `${home.workout.name}  logged` : (home?.workout.name || 'Program')
  const spend = w?.weeklyBudget
    ? `$${Math.round(w.spend)} of $${Math.round(w.weeklyBudget)}`
    : `$${Math.round(w?.spend || 0)}`

  const rows = [
    { kind: 'sleep_tracker', label: 'Sleep', value: sleep },
    { kind: 'nutrition', label: 'Food', value: food },
    { kind: 'workout_log', label: 'Training', value: train },
    { kind: 'spending_snapshot', label: 'Spend', value: spend },
    { kind: 'mood_tracker', label: 'Mood', value: w?.moodLogs ? `${(w.avgEnergy || 0).toFixed(1)} energy` : 'Not logged' },
    { kind: 'habit_streak', label: 'Habits', value: `${w?.habitChecks || 0} this week` },
  ]

  return (
    <div className="ma hub">
      <p className="mini__empty hub-lead">Log here or text Alpha. These numbers match home.</p>
      <ul className="home-receipt-list">
        {rows.map((row) => (
          <li key={row.kind}>
            <Link className="home-receipt" to={href(row.kind)}>
              <span className="home-receipt-label">{row.label}</span>
              <span className="home-receipt-val">{row.value}</span>
            </Link>
          </li>
        ))}
      </ul>
    </div>
  )
}

export function LaterHubApp({ auth }: { auth: FeatureAuth }) {
  const [open, setOpen] = useState<OpenLoop[]>([])
  useEffect(() => {
    apiListLoops({ email: auth.email, token: auth.token })
      .then((d) => setOpen((d.loops || []).filter((l) => l.status === 'open')))
      .catch(() => setOpen([]))
  }, [auth.email, auth.token])
  const today = localYmd()
  const links = LATER_LINKS.map((item) =>
    item.kind === 'open_loops' ? { ...item, hint: promisesHubHint(open, today) } : item,
  )
  return (
    <HubList
      auth={auth}
      links={links}
      lead="Drop zone is a thought dump. Promises are what you told a person you would do."
    />
  )
}
