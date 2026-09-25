import type { SQL } from 'bun'
import { json } from '../utils/http'
import { resolveAuthedUser } from '../auth/session'
import { userMonday, shiftDateStr, weekWindowUtc } from '../timezones'
import { sleepHoursBetween } from '../habits/parsers'

export async function handleReviewRoutes(req: Request, sql: SQL): Promise<Response | null> {
  const url = new URL(req.url)
  const path = url.pathname

  if (path === '/api/weekly-review' && req.method === 'GET') {
    const { user, error } = await resolveAuthedUser(sql, {
      token: url.searchParams.get('t') || undefined,
      session: url.searchParams.get('s') || undefined,
      email: url.searchParams.get('email') || undefined,
    })
    if (error) return error
    const weekStart = userMonday(user!)
    const weekEndStr = shiftDateStr(weekStart, 7)
    const weekWindow = weekWindowUtc(weekStart, user!.timezone || 'America/Los_Angeles')

    const nutr = await sql`
      SELECT count(*)::int AS meals, coalesce(sum(calories), 0)::real AS calories
      FROM hire_nutrition_logs WHERE user_id = ${user!.id} AND eaten_at >= ${weekWindow.start.toISOString()} AND eaten_at < ${weekWindow.end.toISOString()}
    `
    const moods = await sql`
      SELECT count(*)::int AS logs, coalesce(avg(energy), 0)::real AS energy
      FROM hire_moods WHERE user_id = ${user!.id} AND created_at >= ${weekWindow.start.toISOString()} AND created_at < ${weekWindow.end.toISOString()}
    `
    const habits = await sql`
      SELECT count(*)::int AS checks FROM hire_habit_logs
      WHERE user_id = ${user!.id} AND date >= ${weekStart} AND date < ${weekEndStr}
    `
    const sleep = await sql`
      SELECT sleep_date AS "sleepDate", bedtime, wake FROM hire_sleep
      WHERE user_id = ${user!.id} AND sleep_date >= ${weekStart} AND sleep_date < ${weekEndStr}
    `
    const spend = await sql`
      SELECT coalesce(sum(amount), 0)::real AS total FROM hire_spending
      WHERE user_id = ${user!.id} AND spent_at >= ${weekWindow.start.toISOString()} AND spent_at < ${weekWindow.end.toISOString()}
    `
    const gratitude = await sql`
      SELECT count(*)::int AS n FROM hire_gratitude
      WHERE user_id = ${user!.id} AND created_at >= ${weekWindow.start.toISOString()} AND created_at < ${weekWindow.end.toISOString()}
    `
    const duePeople = await sql`
      SELECT count(*)::int AS n FROM hire_network
      WHERE user_id = ${user!.id}
        AND (last_touch IS NULL OR last_touch < now() - (cadence_days || ' days')::interval)
    `

    let sleepHours = 0
    const sleepRows = sleep as Array<{ bedtime: string; wake: string }>
    if (sleepRows.length) {
      sleepHours = sleepRows.reduce((sum, r) => sum + sleepHoursBetween(r.bedtime, r.wake), 0) / sleepRows.length
    }

    const reviews = await sql`
      SELECT id, week_start AS "weekStart", done_text AS "doneText", slipped_text AS "slippedText",
             focus_text AS "focusText", created_at AS "createdAt"
      FROM hire_weekly_reviews WHERE user_id = ${user!.id}
      ORDER BY week_start DESC LIMIT 8
    `
    const current = (reviews as Array<{ weekStart: string }>).find((r) => r.weekStart === weekStart) || null

    return json({
      weekStart,
      snapshot: {
        meals: Number((nutr[0] as { meals: number })?.meals || 0),
        calories: Number((nutr[0] as { calories: number })?.calories || 0),
        moodLogs: Number((moods[0] as { logs: number })?.logs || 0),
        avgEnergy: Number((moods[0] as { energy: number })?.energy || 0),
        habitChecks: Number((habits[0] as { checks: number })?.checks || 0),
        sleepNights: sleepRows.length,
        avgSleepHours: Math.round(sleepHours * 10) / 10,
        spend: Number((spend[0] as { total: number })?.total || 0),
        gratitude: Number((gratitude[0] as { n: number })?.n || 0),
        followUpsDue: Number((duePeople[0] as { n: number })?.n || 0),
      },
      current,
      reviews,
    })
  }

  if (path === '/api/weekly-review' && req.method === 'POST') {
    const body = (await req.json().catch(() => ({}))) as {
      token?: string; email?: string; weekStart?: string; doneText?: string; slippedText?: string; focusText?: string
    }
    const { user, error } = await resolveAuthedUser(sql, { token: body.token, session: (body as { session?: string }).session, email: body.email })
    if (error) return error
    const weekStart = String(body.weekStart || userMonday(user!)).slice(0, 10)
    const doneText = String(body.doneText || '').trim().slice(0, 800)
    const slippedText = String(body.slippedText || '').trim().slice(0, 800)
    const focusText = String(body.focusText || '').trim().slice(0, 400)
    const id = crypto.randomUUID()
    await sql`
      INSERT INTO hire_weekly_reviews (id, user_id, week_start, done_text, slipped_text, focus_text)
      VALUES (${id}, ${user!.id}, ${weekStart}, ${doneText}, ${slippedText}, ${focusText})
      ON CONFLICT (user_id, week_start) DO UPDATE SET
        done_text = excluded.done_text,
        slipped_text = excluded.slipped_text,
        focus_text = excluded.focus_text
    `
    return json({ ok: true })
  }

  return null
}
