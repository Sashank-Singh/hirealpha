import type { NextItem } from './api'

export type HomeMeet = { time: string; title: string }
export type HomePerson = { name: string; days: number; phone?: string; id?: string; context?: string }
export type HomeMail = { from: string; subject: string }
export type HomeWorkout = { name: string; rest?: boolean; done: boolean }
export type HomeLoop = { id: string; title: string; dueAt?: string | null }

export type HomeSlice = {
  hour: number
  lastNightLogged: boolean
  lastNightHours: number
  next?: HomeMeet
  peopleDue: HomePerson[]
  dueLoop?: HomeLoop | null
  proteinToday: number
  proteinGoal: number
  spend: number
  weeklyBudget: number
  workoutToday: HomeWorkout
}

/**
 * @deprecated The shape home used before it could act — a card with a `cta` and
 * somewhere to go. `pickHomeQueue` returns `NextItem`s instead, so a rung can
 * carry a verb. Kept exported for one release.
 */
export type HomeAction = {
  kicker: string
  title: string
  hint: string
  cta: string
  openKind: string
}

export function dayStamp(value: unknown): string {
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value.toISOString().slice(0, 10)
  const s = String(value || '')
  const m = s.match(/(\d{4}-\d{2}-\d{2})/)
  return m?.[1] || ''
}

export function localYmd(d = new Date()) {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

/** Minutes since midnight for a "11:30 AM" clock string; NaN when it is not one
 * (all-day, ranges, malformed) — those are kept rather than dropped as past. */
export function meetMinutes(time: string): number {
  const m = String(time || '').match(/(\d{1,2}):(\d{2})\s*(AM|PM)?/i)
  if (!m) return NaN
  let h = Number(m[1])
  const min = Number(m[2])
  const ap = (m[3] || '').toUpperCase()
  if (ap === 'PM' && h < 12) h += 12
  if (ap === 'AM' && h === 12) h = 0
  return h * 60 + min
}

/** Only meetings still ahead of (or just starting) now. The cached snapshot lists
 * the whole day, so this is re-checked against the live clock: a meeting already
 * behind us stops counting as "left today" and stops leading the Next card. */
export function remainingMeets(meets: HomeMeet[], now = new Date()): HomeMeet[] {
  const nowMin = now.getHours() * 60 + now.getMinutes()
  return meets.filter((m) => {
    const t = meetMinutes(m.time)
    return Number.isNaN(t) || t >= nowMin - 5
  })
}

export function shiftYmd(ymd: string, days: number) {
  const [y, m, d] = ymd.split('-').map(Number)
  const dt = new Date(y || 1970, (m || 1) - 1, (d || 1) + days)
  return localYmd(dt)
}

function hoursBetween(bedtime: string, wake: string) {
  const b = String(bedtime).match(/(\d{1,2}):(\d{2})/)
  const w = String(wake).match(/(\d{1,2}):(\d{2})/)
  if (!b || !w) return 0
  const bm = Number(b[1]) * 60 + Number(b[2])
  const wm = Number(w[1]) * 60 + Number(w[2])
  let mins = wm - bm
  if (mins <= 0) mins += 24 * 60
  return Math.round((mins / 60) * 10) / 10
}

export function pickLastNight(
  nights: Array<{ sleepDate?: unknown; bedtime?: string; wake?: string; createdAt?: unknown }>,
  today: string,
): { logged: boolean; hours: number; bedtime?: string; wake?: string } {
  const yest = shiftYmd(today, -1)
  const hit =
    nights.find((n) => {
      const d = dayStamp(n.sleepDate)
      return d === yest || d === today
    }) ||
    nights.find((n) => {
      const created = Date.parse(String(n.createdAt || ''))
      return Number.isFinite(created) && Date.now() - created < 36 * 60 * 60 * 1000 && n.bedtime && n.wake
    })
  if (!hit?.bedtime || !hit?.wake) return { logged: false, hours: 0 }
  return {
    logged: true,
    hours: hoursBetween(hit.bedtime, hit.wake),
    bedtime: hit.bedtime,
    wake: hit.wake,
  }
}

export function mergeMeets(primary: HomeMeet[], fallback: HomeMeet[]): HomeMeet[] {
  const out: HomeMeet[] = []
  const seen = new Set<string>()
  for (const e of [...primary, ...fallback]) {
    const title = (e.title || '').trim()
    const time = (e.time || '').trim()
    if (!title && !time) continue
    const key = `${time}|${title}`.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push({ time, title: title || time })
  }
  return out.slice(0, 8)
}

export function duePeopleFrom(
  people: Array<{ name: string; lastTouch?: string | null; cadenceDays?: number; phone?: string }>,
): HomePerson[] {
  return people
    .map((p) => {
      const days = p.lastTouch ? Math.floor((Date.now() - new Date(p.lastTouch).getTime()) / 86400000) : 999
      return { name: p.name, days, phone: p.phone, due: days >= (p.cadenceDays || 14) }
    })
    .filter((p) => p.due)
    .slice(0, 3)
    .map(({ name, days, phone }) => ({ name, days, phone }))
}

/**
 * Which of home's two supporting calls are actually needed for this snapshot.
 *
 * `/api/sleep` and `/api/network` exist here only as fallbacks: last night comes
 * from the snapshot when it is logged, and the people-due rows come from the
 * snapshot when it has any. Firing them regardless cost home a 1.3–2.7 s request
 * to learn nothing — `/api/network`'s calendar half reads the very same cache
 * `/api/home` does, so it cannot know anything home does not.
 */
export function homeFetchPlan(snap: {
  home?: { lastNight?: { logged?: boolean }; peopleDue?: unknown[] }
} | null | undefined) {
  const home = snap?.home
  return {
    // No snapshot at all means the fallbacks are all we have.
    sleep: !home || !home.lastNight?.logged,
    people: !home || !home.peopleDue?.length,
  }
}

/** How many rungs home will show. Past four it stops being a shortlist. */
export const HOME_QUEUE_MAX = 4

/** iOS wants the number and the body on one `sms:` URL; no number still opens the
 * composer with the text ready, which beats retyping it. */
function smsTo(phone: string | undefined, body: string) {
  const digits = (phone || '').replace(/[^\d+]/g, '')
  return `sms:${digits}&body=${encodeURIComponent(body)}`
}

/**
 * What friend should do next, ranked, as items the screen can actually execute.
 *
 * This was `pickHomeAction`, which returned one card with a `cta` and a link —
 * so home could tell you a person was due but the only thing it could do about it
 * was navigate. Every rung here now declares a verb, and the ones that are still
 * `open` are honest: a sleep log or a workout log genuinely needs its own form.
 *
 * The ladder's order is unchanged, so whatever used to lead still leads.
 */
export function pickHomeQueue(s: HomeSlice, now = new Date()): NextItem[] {
  const morning = s.hour < 11
  const evening = s.hour >= 18
  const items: NextItem[] = []

  if (!s.lastNightLogged && s.hour < 14) {
    items.push({
      id: 'sleep-last',
      kicker: 'Last night',
      title: 'Log last night',
      hint: 'Bed and wake. Sleep stays empty until you do.',
      action: 'open',
      doLabel: 'Log sleep',
      openKind: 'sleep_tracker',
    })
  }

  if (s.next) {
    items.push({
      id: `meet-${s.next.time}-${s.next.title}`,
      kicker: 'Next',
      title: `${s.next.time}  ${s.next.title}`,
      hint: 'Prep for them is in the brief.',
      action: 'open',
      doLabel: 'Open brief',
      openKind: evening ? 'pick_night' : 'digest',
    })
  }

  const who = s.peopleDue[0]
  if (who) {
    const quiet = who.days >= 900 ? 'No touch logged yet' : `${who.days} days quiet`
    items.push(
      who.id
        ? {
            id: `person-${who.id}`,
            kicker: 'Due',
            title: `Ping ${who.name}`,
            hint: who.context || quiet,
            hot: true,
            action: 'person',
            doLabel: 'Talked',
            personId: who.id,
            sms: smsTo(who.phone, `Hey ${who.name.split(' ')[0]} — ${who.context || 'been a minute, how are you'}`),
          }
        : /* No id means nothing to mark touched, so this stays a link rather than
           * growing a button that would fail. An older API deploy lands here. */
          {
            id: `person-${who.name}`,
            kicker: 'Due',
            title: `Ping ${who.name}`,
            hint: `${quiet}. Open People to log it.`,
            action: 'open',
            doLabel: 'Open People',
            openKind: 'networking_crm',
          },
    )
  }

  if (s.dueLoop?.id) {
    const due = s.dueLoop.dueAt ? Date.parse(s.dueLoop.dueAt) : NaN
    const late = Number.isFinite(due) && due < now.getTime()
    items.push({
      id: `loop-${s.dueLoop.id}`,
      kicker: late ? 'Overdue' : 'Promised',
      title: s.dueLoop.title,
      hint: late ? 'You said you would. Close it or push it a day.' : 'Still open.',
      hot: late,
      action: 'loop',
      doLabel: 'Done',
      loopId: s.dueLoop.id,
    })
  }

  if (evening && s.weeklyBudget > 0 && s.spend > s.weeklyBudget) {
    items.push({
      id: 'spend-over',
      kicker: 'Spend',
      title: `$${Math.round(s.spend - s.weeklyBudget)} over the weekly cap`,
      hint: 'Housing and food first. Open spend to see the split.',
      action: 'open',
      doLabel: 'See spend',
      openKind: 'spending_snapshot',
    })
  }

  if (!morning && s.proteinGoal > 0 && s.proteinToday < 60) {
    items.push({
      id: 'protein-gap',
      kicker: 'Food',
      title: `Protein ${Math.round(s.proteinToday)} / ${Math.round(s.proteinGoal)}`,
      hint: 'One solid meal closes the gap.',
      action: 'open',
      doLabel: 'Log food',
      openKind: 'nutrition',
    })
  }

  if (!s.workoutToday.rest && !s.workoutToday.done && s.hour >= 7 && s.hour < 20) {
    items.push({
      id: 'workout-today',
      kicker: 'Training',
      title: s.workoutToday.name,
      hint: 'Today is on the program. Log when you are done.',
      action: 'open',
      doLabel: 'Open workout',
      openKind: 'workout_log',
    })
  }

  if (evening) {
    items.push({
      id: 'evening-wrap',
      kicker: 'Evening',
      title: 'Wrap the day',
      hint: 'See tomorrow, or save something for later.',
      action: 'open',
      doLabel: 'Evening brief',
      openKind: 'pick_night',
    })
  }

  // Only when there is genuinely nothing — otherwise this would sit under four
  // real rungs claiming the day is clear.
  if (!items.length) {
    items.push({
      id: 'quiet',
      kicker: 'Today',
      title: 'Nothing is on fire',
      hint: 'Text Alpha if you need a prep, a ping, or a log.',
      action: 'open',
      doLabel: 'Morning brief',
      openKind: 'digest',
    })
  }

  return items.slice(0, HOME_QUEUE_MAX)
}
