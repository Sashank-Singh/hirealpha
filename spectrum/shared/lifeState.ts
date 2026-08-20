import type { MiniAppKind } from './miniApps'

export type LifeState = {
  localTime?: string
  weekday?: string
  tick?: string
  nutrition?: { calories: number; protein: number; calorieGoal: number; proteinGoal: number; meals: number }
  habits?: Array<{ name: string; streak: number; todayDone: boolean }>
  mood?: { loggedToday: boolean; lastEmoji?: string | null; lastEnergy?: number | null }
  sleep?: { hours: number; quality: number; date: string } | null
  sleepWeek?: { nights: number; avgHours: number; shortNights: number }
  workoutsToday?: number
  workoutToday?: { name: string; place: string; rest?: boolean }
  peopleDue?: Array<{ name: string; days: number; note?: string; phone?: string; email?: string }>
  peoplePhones?: Array<{ name: string; phone?: string; email?: string }>
  spend?: { weekTotal: number; weeklyBudget: number }
  loops?: string[]
  calendar?: string[]
  mail?: string[]
  weekly?: {
    meals: number; calories: number; moodLogs: number; avgEnergy: number; habitChecks: number
    sleepNights: number; avgSleepHours: number; spend: number; weeklyBudget: number
    workouts: number; learningDone: number; gratitude: number
  }
}

export type LifeCardKind = Extract<
  MiniAppKind,
  | 'digest'
  | 'nutrition'
  | 'sleep_tracker'
  | 'mood_tracker'
  | 'workout_log'
  | 'spending_snapshot'
  | 'open_loops'
  | 'networking_crm'
  | 'pick_night'
  | 'mirror'
  | 'weekly_review'
>

export type LifeInsight = {
  topic: string
  severity: number
  loop: 'morning' | 'interrupt' | 'night' | 'weekly'
  line: string
  tap: string
  card: LifeCardKind | null
}

function hourOf(state: LifeState): number {
  const m = String(state.localTime || '').match(/T(\d{2})/)
  return m ? Number(m[1]) : 12
}

function isWeekday(state: LifeState): boolean {
  const d = (state.weekday || '').toLowerCase()
  return d !== 'saturday' && d !== 'sunday'
}

function fmtHours(n: number): string {
  const x = Math.round(n * 10) / 10
  return Number.isInteger(x) ? String(x) : x.toFixed(1)
}

/** Yesterday's YYYY-MM-DD from a local ISO like 2026-08-19T08:00. */
export function lastNightDateFromLocalTime(localTime?: string): string | null {
  const m = String(localTime || '').match(/^(\d{4})-(\d{2})-(\d{2})/)
  if (!m) return null
  const utc = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]) - 1)
  return new Date(utc).toISOString().slice(0, 10)
}

/** True only when sleepDate is the calendar night that just ended. */
export function isLastNightSleep(
  sleep: { hours?: number; date?: string } | null | undefined,
  localTime?: string,
): boolean {
  const expected = lastNightDateFromLocalTime(localTime)
  const date = String(sleep?.date || '').slice(0, 10)
  return !!expected && date === expected && (sleep?.hours || 0) > 0
}

/** Ranked, computed facts. Copy has no hyphens. Numbers come from logs, never invented. */
export function computeLifeInsights(state: LifeState): LifeInsight[] {
  const out: LifeInsight[] = []
  const n = state.nutrition
  const sleep = state.sleep
  const week = state.sleepWeek
  const hour = hourOf(state)

  const protein = Math.round(n?.protein || 0)
  const proteinGoal = Math.round(n?.proteinGoal || 150)
  const calories = Math.round(n?.calories || 0)
  const calorieGoal = Math.round(n?.calorieGoal || 2200)
  const shortNights = week?.shortNights || 0
  const sleepLastNight = isLastNightSleep(sleep, state.localTime)
  const lastHours = sleepLastNight ? sleep?.hours || 0 : 0
  const workoutsToday = state.workoutsToday || 0
  const calendar = state.calendar || []
  const calendarEmpty = calendar.length === 0
  const people = state.peopleDue || []
  const loops = state.loops || []
  const spend = state.spend
  const overBudget =
    !!spend && spend.weeklyBudget > 0 && spend.weekTotal > spend.weeklyBudget
  const nearBudget =
    !!spend && spend.weeklyBudget > 0 && spend.weekTotal >= spend.weeklyBudget * 0.9 && !overBudget

  if (sleepLastNight && lastHours > 0 && lastHours < 6.5) {
    const pattern =
      shortNights >= 2
        ? `second short night this week, avg ${fmtHours(week?.avgHours || lastHours)}h`
        : 'last night was short'
    out.push({
      topic: 'sleep',
      severity: lastHours < 5.5 || shortNights >= 2 ? 90 : 70,
      loop: 'interrupt',
      line: `You logged ${fmtHours(lastHours)}h last night, ${pattern}.`,
      tap: 'Reply log if that is wrong, or skip gym if you want rest.',
      card: 'sleep_tracker',
    })
  }

  if (n && proteinGoal > 0 && (protein < 60 || protein < proteinGoal * 0.45) && hour >= 14) {
    const gymTomorrow = isWeekday(state)
    const rec = gymTomorrow
      ? 'Dinner is one chicken bowl away. Eat that, skip the second coffee.'
      : 'Eat something with actual protein before the night is gone.'
    out.push({
      topic: 'nutrition_gap',
      severity: protein < 40 ? 88 : 72,
      loop: 'interrupt',
      line: `Protein is sitting at ${protein} of ${proteinGoal}. ${rec}`,
      tap: 'Reply eat, skip, or later.',
      card: 'nutrition',
    })
  }

  if (n && calorieGoal > 0 && calories > calorieGoal) {
    const over = calories - calorieGoal
    out.push({
      topic: 'calorie_over',
      severity: 70,
      loop: 'interrupt',
      line: `You're ${over} calories over your ${calorieGoal} target today.`,
      tap: 'Reply wrap, later, or skip.',
      card: 'nutrition',
    })
  }

  if (isWeekday(state) && workoutsToday === 0 && hour >= 16 && hour < 21) {
    const tired = sleepLastNight && lastHours > 0 && lastHours < 6.5
    out.push({
      topic: 'workout',
      severity: tired ? 55 : 64,
      loop: 'interrupt',
      line: tired
        ? `No lift logged today and last night was ${fmtHours(lastHours)}h. Home 4 is enough, or skip.`
        : 'No lift logged today. Home or gym, tap Mark when you do it.',
      tap: 'Reply done, skip, or later.',
      card: 'workout_log',
    })
  }

  if (people[0]) {
    const p = people[0]
    out.push({
      topic: 'follow_up',
      severity: p.days >= 21 ? 80 : 62,
      loop: 'interrupt',
      line: `${p.name} is ${p.days} days cold${p.note ? `. ${p.note}` : '.'} Draft a short ping.`,
      tap: 'Reply send, later, or skip.',
      card: 'networking_crm',
    })
  }

  if (loops[0]) {
    out.push({
      topic: 'loop',
      severity: 60,
      loop: 'interrupt',
      line: `Still open: ${loops[0]}.`,
      tap: 'Reply done, snooze, or later.',
      card: 'open_loops',
    })
  }

  if (overBudget && spend) {
    out.push({
      topic: 'spend',
      severity: 78,
      loop: 'interrupt',
      line: `This week is $${Math.round(spend.weekTotal)} of $${Math.round(spend.weeklyBudget)}. You are over.`,
      tap: 'Reply log if you added more, or skip.',
      card: 'spending_snapshot',
    })
  } else if (nearBudget && spend) {
    out.push({
      topic: 'spend',
      severity: 50,
      loop: 'interrupt',
      line: `This week is $${Math.round(spend.weekTotal)} of $${Math.round(spend.weeklyBudget)}. Close.`,
      tap: 'Reply log or skip.',
      card: 'spending_snapshot',
    })
  }

  if (state.mood && !state.mood.loggedToday && hour >= 20) {
    out.push({
      topic: 'mood',
      severity: 40,
      loop: 'interrupt',
      line: 'How did today land?',
      tap: 'Reply with 😄 🙂 😐 😔 or 😤',
      card: 'mood_tracker',
    })
  }

  const top = [...out].sort((a, b) => b.severity - a.severity)[0]
  const firstCal = calendar[0]
  const atRisk = top && top.severity >= 62 ? top.line : 'Nothing sharp is on fire.'
  const rec =
    top?.topic === 'nutrition_gap'
      ? 'Eat the protein first.'
      : top?.topic === 'sleep'
        ? 'Protect tonight. No late caffeine.'
        : top?.topic === 'follow_up'
          ? `Text ${people[0]?.name || 'them'} today.`
          : top?.topic === 'workout'
            ? 'Do the short session or skip on purpose.'
            : firstCal
              ? 'Show up for the first thing. That is the day.'
              : 'Pick one thing and close it.'

  out.push({
    topic: 'morning',
    severity: top ? Math.max(50, top.severity - 5) : 45,
    loop: 'morning',
    line: firstCal
      ? `Today: ${firstCal}. At risk: ${atRisk} ${rec}`
      : `Nothing on the calendar yet. At risk: ${atRisk} ${rec}`,
    tap: 'Reply ok, skip, or tell me what actually matters.',
    card: 'digest',
  })

  const nightRec = calendarEmpty
    ? 'Tonight is open. Want a place, or stay in?'
    : `Tonight still has ${calendar.length} on the book. Wrap the rest.`
  out.push({
    topic: calendarEmpty ? 'tonight' : 'debrief',
    severity: calendarEmpty ? 58 : 48,
    loop: 'night',
    line: [
      sleepLastNight && lastHours > 0 ? `Last night was ${fmtHours(lastHours)}h.` : '',
      n && proteinGoal > 0 ? `Protein landed at ${protein} of ${proteinGoal}.` : '',
      nightRec,
    ]
      .filter(Boolean)
      .join(' '),
    tap: calendarEmpty ? 'Reply in, out, or skip.' : 'Reply done, leftover, or skip.',
    card: calendarEmpty ? 'pick_night' : 'digest',
  })

  if (state.weekly) {
    const w = state.weekly
    const hasData =
      w.meals + w.moodLogs + w.habitChecks + w.sleepNights + w.workouts + w.gratitude > 1
    if (hasData) {
      out.push({
        topic: 'weekly_recap',
        severity: 52,
        loop: 'weekly',
        line: `This week: ${w.sleepNights ? `avg ${fmtHours(w.avgSleepHours)}h sleep` : 'almost no sleep logs'}, ${w.workouts} workouts, protein days were thin, spend $${Math.round(w.spend)} of $${Math.round(w.weeklyBudget)}. One fix next week, not ten.`,
        tap: 'Reply with the one thing you want to fix.',
        card: 'mirror',
      })
    }
  }

  return out.sort((a, b) => b.severity - a.severity)
}

export function pickProactiveInsight(state: LifeState, tick: string): LifeInsight | null {
  const t = tick.toLowerCase()
  const insights = computeLifeInsights(state)
  if (t === 'weekly') return insights.find((i) => i.loop === 'weekly') || null
  if (t === 'morning' || t === 'digest') {
    const morning = insights.find((i) => i.loop === 'morning')
    if (!morning) return null
    const hasSignal =
      (state.calendar && state.calendar.length > 0) ||
      isLastNightSleep(state.sleep, state.localTime) ||
      (state.nutrition?.meals || 0) > 0 ||
      (state.loops && state.loops.length > 0) ||
      (state.peopleDue && state.peopleDue.length > 0) ||
      (state.habits && state.habits.length > 0)
    return hasSignal ? morning : null
  }
  if (t === 'evening' || t === 'digest_evening' || t === 'night') {
    return insights.find((i) => i.loop === 'night') || null
  }
  const interrupt = insights.find((i) => i.loop === 'interrupt' && i.severity >= 62)
  return interrupt || null
}

function clockLine(state: LifeState): string {
  const weekday = String(state.weekday || '').trim()
  const m = String(state.localTime || '').match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/)
  if (!m) return weekday ? `Today is ${weekday}. This is today. Do not guess the weekday.` : ''
  const months = [
    'January',
    'February',
    'March',
    'April',
    'May',
    'June',
    'July',
    'August',
    'September',
    'October',
    'November',
    'December',
  ]
  const hour = Number(m[4])
  const ap = hour >= 12 ? 'PM' : 'AM'
  const h12 = hour % 12 || 12
  const date = `${months[Number(m[2]) - 1]} ${Number(m[3])}, ${m[1]}`
  const day = weekday || 'unknown'
  return `Today is ${day}, ${date}. Local time ${h12}:${m[5]} ${ap}. This is today. Do not guess the weekday.`
}

export function formatLifeStateBlock(state: LifeState): string {
  const insights = computeLifeInsights(state)
  const top = insights.filter((i) => i.loop === 'interrupt').slice(0, 3)
  const n = state.nutrition
  const sleep = state.sleep
  const week = state.sleepWeek
  const lines: string[] = [
    '## Life right now (ground truth from their logs. Use these numbers. Do not invent.)',
  ]
  const nowLine = clockLine(state)
  if (nowLine) lines.push(nowLine)
  if (isLastNightSleep(sleep, state.localTime) && sleep?.hours) {
    lines.push(
      `Sleep: last night ${fmtHours(sleep.hours)}h, quality ${sleep.quality}/5.${
        week?.shortNights
          ? ` ${week.shortNights} short nights this week, avg ${fmtHours(week.avgHours)}h.`
          : ''
      }`,
    )
  } else {
    lines.push('Sleep: no last night log.')
  }
  if (state.mood) {
    lines.push(
      state.mood.loggedToday
        ? `Mood today: ${state.mood.lastEmoji || 'logged'}, energy ${state.mood.lastEnergy ?? '?'}/5.`
        : `Mood: not logged today.${state.mood.lastEmoji ? ` Last ${state.mood.lastEmoji}.` : ''}`,
    )
  }
  if (n) {
    lines.push(
      `Food today: ${Math.round(n.protein)}g protein of ${Math.round(n.proteinGoal)}, ${Math.round(n.calories)} of ${Math.round(n.calorieGoal)} calories, ${n.meals} ${n.meals === 1 ? 'meal' : 'meals'}.`,
    )
  }
  if (state.spend) {
    lines.push(`Spend this week: $${Math.round(state.spend.weekTotal)} of $${Math.round(state.spend.weeklyBudget)}.`)
  }
  const session = state.workoutToday
  const sessionBit = session
    ? session.rest
      ? ` Today is ${session.name}. Rest is fine.`
      : ` Today is ${session.name}, ${session.place}.`
    : isWeekday(state)
      ? ` It is ${state.weekday || 'a weekday'}, a session day.`
      : ` It is ${state.weekday || 'the weekend'}. Rest is fine.`
  lines.push(`Workout today: ${state.workoutsToday || 0} lifts logged.${sessionBit}`)
  if (state.loops?.length) lines.push(`Promises still open: ${state.loops.slice(0, 3).join('; ')}.`)
  if (state.peopleDue?.length) {
    lines.push(
      `People due: ${state.peopleDue
        .map((p) => `${p.name} (${p.days} days${p.phone ? `, ${p.phone}` : ''})`)
        .join(', ')}.`,
    )
  }
  if (state.peoplePhones?.length) {
    lines.push(
      `People you can text or email: ${state.peoplePhones
        .map((p) => [p.name, p.phone, p.email].filter(Boolean).join(' '))
        .join(', ')}. If they say text a name, use the number. If they say email or follow up, use the email. Tell them to tap Send, Book, or Text. Never claim you sent a text.`,
    )
  }
  if (state.calendar?.length) lines.push(`Calendar next 8 hours: ${state.calendar.slice(0, 6).join('; ')}.`)
  else lines.push('Calendar next 8 hours: empty or not connected. Do not invent events.')
  if (state.mail?.length) {
    lines.push(
      `Judged mail: ${state.mail.slice(0, 3).join('; ')}. Use the id= value if they want a reply. Do not invent mail.`,
    )
  } else {
    lines.push('Judged mail: empty or not connected. Do not invent mail.')
  }
  if (top.length) {
    lines.push(`At risk, computed: ${top.map((i) => i.line).join(' ')}`)
    lines.push(`If they ask what to eat, what to do tonight, or say they are exhausted, answer from this block. Offer a tap: ${top[0]!.tap}`)
  }
  return lines.join('\n')
}

export function tapHint(insight: LifeInsight): string {
  return `${insight.line} ${insight.tap}`
}
