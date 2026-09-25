import type { SQL } from 'bun'
import { jsonRevalidated } from '../utils/http'
import { resolveAuthedUser } from '../auth/session'
import type { AuthedUser } from '../db/users'
import {
  userMonday,
  shiftDateStr,
  localDateStrInTz,
  todayWindowUtc,
  weekWindowUtc,
  ymdOf,
} from '../timezones'
import { sleepHoursBetween } from '../habits/parsers'
import { loadMiniPrefs } from '../habits/prefs'
import type { StaleRead } from '../staleCache'

export type HomeWorld = {
  upcoming: Array<{ time: string; title: string }>
  mail: Array<{ from: string; subject: string }>
  mailGroups: Array<{
    kind: string
    label: string
    count: number
    items: Array<{ id: string; from: string; subject: string; snippet?: string }>
  }>
  meetings: any[]
  attention: any | null
}

const EMPTY_HOME_WORLD: HomeWorld = { upcoming: [], mail: [], mailGroups: [], meetings: [], attention: null }

export interface HomeRouteOptions {
  loadHomeWorld: (sql: SQL, user: AuthedUser, tzLocal: string) => Promise<HomeWorld>
  homeWorldCache: {
    read: (key: string, loader: () => Promise<HomeWorld>) => Promise<StaleRead<HomeWorld>>
  }
  workoutTodayLabel: (weekday: string, place: 'home' | 'gym') => { name: string; place: string; rest?: boolean }
}

export async function handleHomeRoutes(
  req: Request,
  sql: SQL,
  options: HomeRouteOptions,
): Promise<Response | null> {
  const url = new URL(req.url)
  const path = url.pathname

  // '/api/mirror' is the old path for this screen. Keep answering it for one release
  // so a client build already loaded in someone's browser does not start failing.
  if ((path === '/api/home' || path === '/api/mirror') && req.method === 'GET') {
    const { user, error } = await resolveAuthedUser(sql, {
      token: url.searchParams.get('t') || undefined,
      session: url.searchParams.get('s') || undefined,
      email: url.searchParams.get('email') || undefined,
    })
    if (error) return error
    const weekStart = userMonday(user!)
    const weekEndStr = shiftDateStr(weekStart, 7)
    const dayStart = shiftDateStr(weekStart, -14)
    const tzLocal = user!.timezone || 'America/Los_Angeles'
    const todayLocal = localDateStrInTz(new Date(), tzLocal)

    const lastNightKey = shiftDateStr(todayLocal, -1)

    /* The tables below keep TIMESTAMPTZ timestamps. Comparing one against a
     * bare `::date` reads it at midnight in the database's own session timezone,
     * so "today" silently ended at 5 PM Pacific: a dinner logged at 11 PM never
     * reached Home's protein row. Compare against the true UTC instants instead. */
    const dayWindow = todayWindowUtc(tzLocal)
    const weekWindow = weekWindowUtc(weekStart, tzLocal)
    const trendStart = weekWindowUtc(shiftDateStr(weekStart, -14), tzLocal).start

    /* These were awaited one at a time: twenty-odd round trips to Postgres, in
     * series, before the page had a single number to paint. Nothing here reads
     * anything else here, so they go out together and the slice costs about as
     * long as its slowest query instead of the sum of all of them. */
    const [
      nutr,
      nutrToday,
      nutrGoals,
      workoutsTodayRows,
      moods,
      habitRows,
      habitLogs,
      sleep,
      spend,
      spendByCat,
      budgetRow,
      workouts,
      prs,
      learning,
      learningNext,
      gratitude,
      decisions,
      moodTrend,
      sleepTrendRows,
      reviews,
      lastNightRows,
      prefs,
      duePeopleRows,
      dueLoopRows,
      runwayRows,
    ] = await Promise.all([
      sql`
        SELECT count(*)::int AS meals, coalesce(sum(calories), 0)::real AS calories
        FROM hire_nutrition_logs WHERE user_id = ${user!.id} AND eaten_at >= ${weekWindow.start.toISOString()} AND eaten_at < ${weekWindow.end.toISOString()}
      `,
      sql`
        SELECT coalesce(sum(protein), 0)::real AS protein, coalesce(sum(calories), 0)::real AS calories, count(*)::int AS meals
        FROM hire_nutrition_logs WHERE user_id = ${user!.id} AND eaten_at >= ${dayWindow.start.toISOString()} AND eaten_at < ${dayWindow.end.toISOString()}
      `,
      sql`
        SELECT protein_goal AS "proteinGoal", calorie_goal AS "calorieGoal" FROM hire_nutrition_goals WHERE user_id = ${user!.id} LIMIT 1
      `,
      sql`
        SELECT count(*)::int AS n FROM hire_workouts
        WHERE user_id = ${user!.id} AND logged_at >= ${dayWindow.start.toISOString()} AND logged_at < ${dayWindow.end.toISOString()}
      `,
      sql`
        SELECT count(*)::int AS logs, coalesce(avg(energy), 0)::real AS energy
        FROM hire_moods WHERE user_id = ${user!.id} AND created_at >= ${weekWindow.start.toISOString()} AND created_at < ${weekWindow.end.toISOString()}
      `,
      sql`
        SELECT id, name FROM hire_habits WHERE user_id = ${user!.id} ORDER BY created_at ASC LIMIT 12
      `,
      sql`
        SELECT habit_id AS "habitId", date FROM hire_habit_logs
        WHERE user_id = ${user!.id} AND date >= ${weekStart} AND date < ${weekEndStr}
      `,
      sql`
        SELECT sleep_date AS "sleepDate", bedtime, wake, quality FROM hire_sleep
        WHERE user_id = ${user!.id} AND sleep_date >= ${weekStart} AND sleep_date < ${weekEndStr}
      `,
      sql`
        SELECT coalesce(sum(amount), 0)::real AS total FROM hire_spending
        WHERE user_id = ${user!.id} AND spent_at >= ${weekWindow.start.toISOString()} AND spent_at < ${weekWindow.end.toISOString()}
      `,
      sql`
        SELECT category, coalesce(sum(amount), 0)::real AS amount FROM hire_spending
        WHERE user_id = ${user!.id} AND spent_at >= ${weekWindow.start.toISOString()} AND spent_at < ${weekWindow.end.toISOString()}
        GROUP BY category ORDER BY amount DESC
      `,
      sql`SELECT weekly_budget AS "weeklyBudget" FROM hire_spending_budget WHERE user_id = ${user!.id}`,
      sql`
        SELECT count(*)::int AS n FROM hire_workouts
        WHERE user_id = ${user!.id} AND logged_at >= ${weekWindow.start.toISOString()} AND logged_at < ${weekWindow.end.toISOString()}
      `,
      sql`
        SELECT exercise, max(weight) AS weight FROM hire_workouts
        WHERE user_id = ${user!.id} AND weight > 0
        GROUP BY exercise ORDER BY weight DESC LIMIT 5
      `,
      sql`
        SELECT status, count(*)::int AS n, coalesce(sum(minutes), 0)::int AS mins FROM hire_learning
        WHERE user_id = ${user!.id} GROUP BY status
      `,
      sql`
        SELECT title FROM hire_learning WHERE user_id = ${user!.id} AND status = 'queued'
        ORDER BY created_at ASC LIMIT 1
      `,
      sql`
        SELECT count(*)::int AS n FROM hire_gratitude
        WHERE user_id = ${user!.id} AND created_at >= ${weekWindow.start.toISOString()} AND created_at < ${weekWindow.end.toISOString()}
      `,
      sql`
        SELECT count(*) FILTER (WHERE outcome IS NULL)::int AS open,
               count(*) FILTER (WHERE outcome IS NOT NULL)::int AS resolved
        FROM hire_decisions WHERE user_id = ${user!.id}
      `,
      sql`
        SELECT emoji, energy, created_at AS "createdAt" FROM hire_moods
        WHERE user_id = ${user!.id} AND created_at >= ${trendStart.toISOString()}
        ORDER BY created_at ASC LIMIT 60
      `,
      sql`
        SELECT sleep_date AS "sleepDate", bedtime, wake, quality FROM hire_sleep
        WHERE user_id = ${user!.id} AND sleep_date >= ${dayStart} AND sleep_date < ${weekEndStr}
        ORDER BY sleep_date ASC LIMIT 21
      `,
      sql`
        SELECT id, week_start AS "weekStart", done_text AS "doneText", slipped_text AS "slippedText",
               focus_text AS "focusText", created_at AS "createdAt"
        FROM hire_weekly_reviews WHERE user_id = ${user!.id}
        ORDER BY week_start DESC LIMIT 4
      `,
      // Ran only when the week rows missed last night. In parallel it is free,
      // and it is the row the Body page reads on a Monday.
      sql`
        SELECT sleep_date AS "sleepDate", bedtime, wake, quality FROM hire_sleep
        WHERE user_id = ${user!.id} AND (sleep_date = ${lastNightKey} OR sleep_date = ${todayLocal})
        ORDER BY sleep_date DESC LIMIT 1
      `,
      loadMiniPrefs(sql, user!.id),
      // `id` is what turns a person from a row you read into one you can act on:
      // without it home can name who is due but cannot mark them touched.
      sql`
        SELECT id, name, context, phone, last_touch AS "lastTouch", cadence_days AS "cadenceDays"
        FROM hire_network WHERE user_id = ${user!.id}
        ORDER BY coalesce(last_touch, '1970-01-01'::timestamptz) ASC LIMIT 8
      `,
      // The one promise closest to its deadline. Home only ever shows one, so
      // there is no reason to ship eight.
      sql`
        SELECT id, title, due_at AS "dueAt" FROM hire_loops
        WHERE user_id = ${user!.id} AND status = 'open'
        ORDER BY due_at ASC NULLS LAST LIMIT 1
      `,
      // The most recent runway snapshot (cofounder), so home can show real months.
      sql`
        SELECT cash, burn, months, taken_on AS "takenOn" FROM hire_runway_snapshots
        WHERE user_id = ${user!.id}
        ORDER BY taken_on DESC LIMIT 1
      `,
    ])

    const habitChecks = (habitLogs as Array<{ habitId: string }>).length
    const habitNames = (habitRows as Array<{ name: string }>).map((h) => h.name)
    let sleepHours = 0
    const sleepRows = sleep as Array<{ sleepDate: string; bedtime: string; wake: string; quality: number }>
    if (sleepRows.length) {
      sleepHours = sleepRows.reduce((sum, r) => sum + sleepHoursBetween(r.bedtime, r.wake), 0) / sleepRows.length
    }
    const moodTrendRows = moodTrend as Array<{ emoji: string; energy: number; createdAt: Date }>
    const currentReview = (reviews as Array<{ weekStart: string }>).find((r) => r.weekStart === weekStart) || null
    const lrn = learning as Array<{ status: string; n: number; mins: number }>
    const queued = lrn.find((l) => l.status === 'queued')?.n || 0
    const done = lrn.find((l) => l.status === 'done')?.n || 0

    const sortedSleep = [...sleepRows].sort((a, b) => String(a.sleepDate).localeCompare(String(b.sleepDate)))
    const sleepHoursList = sortedSleep.map((r) => sleepHoursBetween(r.bedtime, r.wake))
    const lastNightFromWeek = sleepRows.find((r) => {
      const d = ymdOf(r.sleepDate)
      return d === lastNightKey || d === todayLocal
    })
    const lastNightLookup =
      lastNightFromWeek || (lastNightRows[0] as { sleepDate?: string; bedtime?: string; wake?: string } | undefined)
    const lastNightHours = lastNightLookup?.bedtime && lastNightLookup?.wake
      ? sleepHoursBetween(lastNightLookup.bedtime, lastNightLookup.wake)
      : 0
    const lastNightLogged = !!(lastNightLookup?.bedtime && lastNightLookup?.wake)
    const shortNights = sleepHoursList.filter((h) => h < 6.5).length
    const gToday = nutrGoals[0] as { proteinGoal?: number; calorieGoal?: number } | undefined
    const nToday = nutrToday[0] as { protein?: number; calories?: number; meals?: number } | undefined

    const weekday = new Intl.DateTimeFormat('en-US', { timeZone: tzLocal, weekday: 'long' }).format(new Date())
    const dateLabel = new Intl.DateTimeFormat('en-US', {
      timeZone: tzLocal,
      weekday: 'long',
      month: 'short',
      day: 'numeric',
    }).format(new Date())
    let hour = Number(
      new Intl.DateTimeFormat('en-US', { timeZone: tzLocal, hour: 'numeric', hour12: false }).format(new Date()),
    )
    if (hour === 24) hour = 0

    const workoutLabel = options.workoutTodayLabel(weekday, prefs.workoutPlace)
    const workoutsTodayN = Number((workoutsTodayRows[0] as { n?: number })?.n || 0)

    const peopleDue = (duePeopleRows as Array<{
      id: string; name: string; context: string; phone: string; lastTouch: Date | null; cadenceDays: number
    }>)
      .map((p) => {
        const days = p.lastTouch ? Math.floor((Date.now() - new Date(p.lastTouch).getTime()) / 86400000) : 999
        return { id: p.id, name: p.name, days, phone: p.phone || undefined, context: p.context || undefined, due: days >= (p.cadenceDays || 14) }
      })
      .filter((p) => p.due)
      .slice(0, 3)
      .map(({ id, name, days, phone, context }) => ({ id, name, days, phone, context }))

    const dueLoopRow = (dueLoopRows as Array<{ id: string; title: string; dueAt: Date | null }>)[0]
    const dueLoop = dueLoopRow
      ? { id: dueLoopRow.id, title: dueLoopRow.title, dueAt: dueLoopRow.dueAt ? new Date(dueLoopRow.dueAt).toISOString() : null }
      : null
    const runwayRow = (runwayRows as Array<{ cash: number; burn: number; months: number; takenOn: string }>)[0]
    const runway = runwayRow
      ? { cash: Math.round(runwayRow.cash), burn: Math.round(runwayRow.burn), months: Math.round(runwayRow.months * 10) / 10, takenOn: runwayRow.takenOn }
      : null

    /* Calendar, Gmail and the mail-kind judge, off the critical path. A stale
     * answer paints instantly while the next one loads behind the response;
     * only a cold first open waits, and only briefly. */
    const world = await options.homeWorldCache.read(`${user!.id}|${tzLocal}`, () => options.loadHomeWorld(sql, user!, tzLocal))
    const { upcoming, mail, mailGroups, meetings, attention } = world.value ?? EMPTY_HOME_WORLD

    /* A repeat open is usually the same bytes, so let the browser revalidate
     * rather than re-download — unless the world slice is still filling in, in
     * which case the client's own refetch must not be answered from a cache. */
    return jsonRevalidated(req, world.pending ? 0 : 60, {
      weekStart,
      // The calendar and inbox are still loading, so what the client has is
      // incomplete: one quiet refetch fills it in.
      worldPending: world.pending,
      home: {
        weekday,
        dateLabel,
        hour,
        upcoming,
        mail,
        mailGroups,
        meetings,
        attention,
        peopleDue,
        dueLoop,
        runway,
        lastNight: {
          logged: lastNightLogged,
          hours: Math.round(lastNightHours * 10) / 10,
          bedtime: lastNightLookup?.bedtime,
          wake: lastNightLookup?.wake,
        },
        workout: {
          name: workoutLabel.name,
          rest: workoutLabel.rest,
          done: workoutsTodayN > 0,
        },
      },
      window: {
        meals: Number((nutr[0] as { meals: number })?.meals || 0),
        calories: Number((nutr[0] as { calories: number })?.calories || 0),
        proteinToday: Math.round(Number(nToday?.protein) || 0),
        proteinGoal: Math.round(Number(gToday?.proteinGoal) || 150),
        caloriesToday: Math.round(Number(nToday?.calories) || 0),
        calorieGoal: Math.round(Number(gToday?.calorieGoal) || 2200),
        lastNightHours: Math.round(lastNightHours * 10) / 10,
        shortNights,
        workoutsToday: workoutsTodayN,
        moodLogs: Number((moods[0] as { logs: number })?.logs || 0),
        avgEnergy: Number((moods[0] as { energy: number })?.energy || 0),
        habitChecks,
        habits: habitNames,
        sleepNights: sleepRows.length,
        avgSleepHours: Math.round(sleepHours * 10) / 10,
        spend: Number((spend[0] as { total: number })?.total || 0),
        weeklyBudget: Math.round(Number((budgetRow[0] as { weeklyBudget?: number })?.weeklyBudget) || 400),
        workouts: Number((workouts[0] as { n: number })?.n || 0),
        learningQueued: queued,
        learningDone: done,
        gratitude: Number((gratitude[0] as { n: number })?.n || 0),
        decisionsOpen: Number((decisions[0] as { open: number })?.open || 0),
        decisionsResolved: Number((decisions[0] as { resolved: number })?.resolved || 0),
      },
      moodTrend: moodTrendRows.map((m) => ({
        emoji: m.emoji,
        energy: m.energy,
        date: localDateStrInTz(new Date(m.createdAt), tzLocal),
      })),
      // The three-week ordered rows, not this week's: the client takes the last
      // seven of what it is given, so the week rows made the chart start over on
      // a Monday and drew whatever order Postgres happened to return.
      sleepTrend: (sleepTrendRows as Array<{ sleepDate: string; bedtime: string; wake: string; quality: number }>).map(
        (r) => ({
          date: ymdOf(r.sleepDate),
          hours: sleepHoursBetween(r.bedtime, r.wake),
          quality: r.quality,
        }),
      ),
      spendByCategory: spendByCat as Array<{ category: string; amount: number }>,
      prs: (prs as Array<{ exercise: string; weight: number }>).map((p) => ({ exercise: p.exercise, weight: p.weight })),
      nextLearning: (learningNext[0] as { title?: string } | undefined)?.title || null,
      currentReview,
      reviews,
    })
  }

  return null
}
