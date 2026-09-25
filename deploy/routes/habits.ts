import type { SQL } from 'bun'
import { isPersona } from '../personas'
import { json, jsonRevalidated } from '../utils/http'
import { resolveAuthedUser } from '../auth/session'
import { getUserByPhone } from '../db/users'
import {
  localDateStrInTz,
  mondayOfDateStr,
  weekDaysFromMonday,
  shiftDateStr,
  todayWindowUtc,
  weekWindowUtc,
  userMonday,
} from '../timezones'
import {
  isClock,
  parseWorkoutText,
  parseSleepText,
  sleepFromHours,
  parseGratitudeText,
  parseMoodReply,
  parseSpendText,
  SPEND_CATEGORIES,
  clampNum,
  estimateNutrition,
  nutritionModelConfig,
  imageMimeFromBase64,
} from '../habits/parsers'
import { loadMiniPrefs, saveMiniPrefs, type MiniPrefs } from '../habits/prefs'
import { spendWouldBreakCap } from '../weekRun'
import { computeIdempotencyKey, withIdempotency } from '../utils/idempotency'

export async function handleHabitRoutes(
  req: Request,
  sql: SQL,
  options: { internalOk: (r: Request) => boolean },
): Promise<Response | null> {
  const url = new URL(req.url)
  const path = url.pathname

  /* ---- Habits ---- */
  if (path === '/api/habits' && req.method === 'GET') {
    const { user, error } = await resolveAuthedUser(sql, {
      token: url.searchParams.get('t') || undefined,
      session: url.searchParams.get('s') || undefined,
      email: url.searchParams.get('email') || undefined,
    })
    if (error) return error
    const rows = await sql`
      SELECT id, name, emoji, created_at AS "createdAt"
      FROM hire_habits WHERE user_id = ${user!.id} ORDER BY created_at ASC
    `
    const tz = user!.timezone || 'America/Los_Angeles'
    const today = localDateStrInTz(new Date(), tz)
    const weekStart = mondayOfDateStr(today)
    const weekDays = weekDaysFromMonday(weekStart)
    const cutoff = shiftDateStr(today, -400)
    const logRows = await sql`
      SELECT habit_id AS "habitId", date FROM hire_habit_logs
      WHERE user_id = ${user!.id} AND date >= ${cutoff}
    `
    const logMap = new Map<string, Set<string>>()
    for (const lr of logRows as Array<{ habitId: string; date: string }>) {
      if (!logMap.has(lr.habitId)) logMap.set(lr.habitId, new Set())
      logMap.get(lr.habitId)!.add(lr.date.slice(0, 10))
    }
    const habits = (rows as Array<{ id: string; name: string; emoji: string; createdAt: string }>).map((h) => {
      const dates = logMap.get(h.id) || new Set()
      let cursor = dates.has(today) ? today : shiftDateStr(today, -1)
      let streak = 0
      while (dates.has(cursor)) {
        streak++
        cursor = shiftDateStr(cursor, -1)
      }
      const cutoff12w = shiftDateStr(today, -84)
      const logDates = [...dates].filter((d) => d >= cutoff12w).sort()
      return { ...h, streak, recentDays: weekDays.filter((d) => dates.has(d)), logDates }
    })
    return json({ habits, weekDays, weekStart })
  }

  if (path === '/api/habits' && req.method === 'POST') {
    const body = (await req.json().catch(() => ({}))) as {
      token?: string; email?: string; name?: string; emoji?: string
    }
    const name = String(body.name || '').trim().slice(0, 100)
    if (!name) return json({ error: 'name required' }, 400)
    const { user, error } = await resolveAuthedUser(sql, { token: body.token, session: (body as { session?: string }).session, email: body.email })
    if (error) return error
    const id = crypto.randomUUID()
    const emoji = String(body.emoji || '💪').slice(0, 8)
    await sql`INSERT INTO hire_habits (id, user_id, name, emoji) VALUES (${id}, ${user!.id}, ${name}, ${emoji})`
    return json({ ok: true, id })
  }

  if (path === '/api/habits/toggle' && req.method === 'POST') {
    const body = (await req.json().catch(() => ({}))) as {
      token?: string; email?: string; habitId?: string; date?: string
    }
    if (!body.habitId || !body.date) return json({ error: 'habitId and date required' }, 400)
    const { user, error } = await resolveAuthedUser(sql, { token: body.token, session: (body as { session?: string }).session, email: body.email })
    if (error) return error
    const dateStr = body.date.slice(0, 10)
    const del = await sql`DELETE FROM hire_habit_logs WHERE user_id = ${user!.id} AND habit_id = ${body.habitId} AND date = ${dateStr}`
    const done = !(del && (del as { count?: number }).count)
    if (done) {
      await sql`INSERT INTO hire_habit_logs (id, user_id, habit_id, date) VALUES (${crypto.randomUUID()}, ${user!.id}, ${body.habitId}, ${dateStr})`
    }
    return json({ ok: true, done })
  }

  if (path.startsWith('/api/habits/') && req.method === 'POST') {
    const body = (await req.json().catch(() => ({}))) as { token?: string; email?: string; _delete?: boolean }
    if (!body._delete) return json({ error: 'Not found' }, 404)
    const habitId = path.split('/')[3]
    if (!habitId) return json({ error: 'habitId required' }, 400)
    const { user, error } = await resolveAuthedUser(sql, { token: body.token, session: (body as { session?: string }).session, email: body.email })
    if (error) return error
    await sql`DELETE FROM hire_habit_logs WHERE user_id = ${user!.id} AND habit_id = ${habitId}`
    await sql`DELETE FROM hire_habits WHERE id = ${habitId} AND user_id = ${user!.id}`
    return json({ ok: true })
  }

  if (path === '/api/internal/habits/done' && req.method === 'POST') {
    if (!options.internalOk(req)) return json({ error: 'Unauthorized' }, 401)
    const body = (await req.json().catch(() => ({}))) as {
      phone?: string; persona?: string; text?: string; date?: string
    }
    if (!body.phone || !isPersona(body.persona || '') || !String(body.text || '').trim()) {
      return json({ error: 'phone, persona, and text required' }, 400)
    }
    const user = await getUserByPhone(sql, body.phone)
    if (!user) return json({ error: 'User not found' }, 404)
    const tz = user.timezone || 'America/Los_Angeles'
    const dateStr = body.date || localDateStrInTz(new Date(), tz)
    const rows = await sql`SELECT id, name FROM hire_habits WHERE user_id = ${user.id} ORDER BY created_at ASC LIMIT 12`
    const text = String(body.text || '')
    const match =
      (rows as Array<{ id: string; name: string }>).find((h) =>
        text.toLowerCase().includes(h.name.toLowerCase()) || h.name.toLowerCase().includes(text.toLowerCase()),
      ) || (rows as Array<{ id: string; name: string }>)[0]
    if (!match) return json({ ok: false, logged: false, error: 'No habits set up yet' })
    const dup = await sql`
      SELECT 1 FROM hire_habit_logs WHERE user_id = ${user.id} AND habit_id = ${match.id} AND date = ${dateStr} LIMIT 1
    `
    if (!dup[0]) {
      await sql`
        INSERT INTO hire_habit_logs (id, user_id, habit_id, date)
        VALUES (${crypto.randomUUID()}, ${user.id}, ${match.id}, ${dateStr})
      `
    }
    return json({ ok: true, logged: true, habit: match.name, done: true, date: dateStr })
  }

  /* ---- Workouts ---- */
  if (path === '/api/workouts' && req.method === 'GET') {
    const { user, error } = await resolveAuthedUser(sql, {
      token: url.searchParams.get('t') || undefined,
      session: url.searchParams.get('s') || undefined,
      email: url.searchParams.get('email') || undefined,
    })
    if (error) return error
    const logs = await sql`
      SELECT id, exercise, sets, reps, weight, notes, logged_at AS "loggedAt"
      FROM hire_workouts WHERE user_id = ${user!.id}
      ORDER BY logged_at DESC LIMIT 40
    `
    const prRows = await sql`
      SELECT DISTINCT ON (lower(exercise)) exercise, weight, reps, logged_at AS "loggedAt"
      FROM hire_workouts WHERE user_id = ${user!.id} AND weight > 0
      ORDER BY lower(exercise), weight DESC, reps DESC
    `
    const prefs = await loadMiniPrefs(sql, user!.id)
    return json({
      logs,
      prs: prRows,
      workoutPlace: prefs.workoutPlace,
      workoutMoveCount: prefs.workoutMoveCount,
      workoutDays: prefs.workoutDays,
    })
  }

  if (path === '/api/workouts' && req.method === 'POST') {
    const body = (await req.json().catch(() => ({}))) as {
      token?: string; email?: string; exercise?: string; sets?: number; reps?: number; weight?: number; notes?: string
    }
    const exercise = String(body.exercise || '').trim().slice(0, 80)
    if (!exercise) return json({ error: 'exercise required' }, 400)
    const { user, error } = await resolveAuthedUser(sql, { token: body.token, session: (body as { session?: string }).session, email: body.email })
    if (error) return error
    const id = crypto.randomUUID()
    const sets = Math.max(1, Math.min(20, Math.round(body.sets || 1)))
    const reps = Math.max(1, Math.min(100, Math.round(body.reps || 1)))
    const weight = Math.max(0, Number(body.weight) || 0)
    const notes = String(body.notes || '').trim().slice(0, 300) || null
    await sql`
      INSERT INTO hire_workouts (id, user_id, exercise, sets, reps, weight, notes)
      VALUES (${id}, ${user!.id}, ${exercise}, ${sets}, ${reps}, ${weight}, ${notes})
    `
    return json({ ok: true, id })
  }

  if (path.startsWith('/api/workouts/') && req.method === 'POST') {
    const body = (await req.json().catch(() => ({}))) as { token?: string; email?: string; _delete?: boolean }
    if (!body._delete) return json({ error: 'Not found' }, 404)
    const id = path.split('/')[3]
    if (!id) return json({ error: 'id required' }, 400)
    const { user, error } = await resolveAuthedUser(sql, { token: body.token, session: (body as { session?: string }).session, email: body.email })
    if (error) return error
    await sql`DELETE FROM hire_workouts WHERE id = ${id} AND user_id = ${user!.id}`
    return json({ ok: true })
  }

  if (path === '/api/internal/workouts' && req.method === 'POST') {
    if (!options.internalOk(req)) return json({ error: 'Unauthorized' }, 401)
    const body = (await req.json().catch(() => ({}))) as { phone?: string; persona?: string; text?: string }
    if (!body.phone || !isPersona(body.persona || '') || !String(body.text || '').trim()) {
      return json({ error: 'phone, persona, and text required' }, 400)
    }
    const user = await getUserByPhone(sql, body.phone)
    if (!user) return json({ error: 'User not found' }, 404)
    const parsed = parseWorkoutText(String(body.text))
    if (!parsed) return json({ ok: false, logged: false, error: 'Could not parse workout' })
    const id = crypto.randomUUID()
    await sql`
      INSERT INTO hire_workouts (id, user_id, exercise, sets, reps, weight, notes)
      VALUES (${id}, ${user.id}, ${parsed.exercise}, ${parsed.sets}, ${parsed.reps}, ${parsed.weight}, NULL)
    `
    return json({ ok: true, logged: true, id, ...parsed })
  }

  /* ---- Sleep ---- */
  if (path === '/api/sleep' && req.method === 'GET') {
    const { user, error } = await resolveAuthedUser(sql, {
      token: url.searchParams.get('t') || undefined,
      session: url.searchParams.get('s') || undefined,
      email: url.searchParams.get('email') || undefined,
    })
    if (error) return error
    const nights = await sql`
      SELECT id, sleep_date AS "sleepDate", bedtime, wake, quality, note, source, created_at AS "createdAt"
      FROM hire_sleep WHERE user_id = ${user!.id}
      ORDER BY sleep_date DESC LIMIT 21
    `
    const prefs = await loadMiniPrefs(sql, user!.id)
    return json({ nights, sleepBedtime: prefs.sleepBedtime, sleepWake: prefs.sleepWake })
  }

  if (path === '/api/sleep' && req.method === 'POST') {
    const body = (await req.json().catch(() => ({}))) as {
      token?: string; email?: string; sleepDate?: string; bedtime?: string; wake?: string; quality?: number; note?: string
    }
    const bedtime = String(body.bedtime || '').trim()
    const wake = String(body.wake || '').trim()
    if (!bedtime || !wake) return json({ error: 'bedtime and wake required' }, 400)
    const { user, error } = await resolveAuthedUser(sql, { token: body.token, session: (body as { session?: string }).session, email: body.email })
    if (error) return error
    const sleepDate = String(body.sleepDate || shiftDateStr(localDateStrInTz(new Date(), user!.timezone), -1)).slice(0, 10)
    const quality = Math.max(1, Math.min(5, Math.round(body.quality || 3)))
    const note = String(body.note || '').trim().slice(0, 300) || null
    const id = crypto.randomUUID()
    await sql`
      INSERT INTO hire_sleep (id, user_id, sleep_date, bedtime, wake, quality, note)
      VALUES (${id}, ${user!.id}, ${sleepDate}, ${bedtime}, ${wake}, ${quality}, ${note})
      ON CONFLICT (user_id, sleep_date) DO UPDATE SET
        bedtime = excluded.bedtime, wake = excluded.wake, quality = excluded.quality, note = excluded.note
    `
    if (isClock(bedtime) && isClock(wake)) {
      await saveMiniPrefs(sql, user!.id, { sleepBedtime: bedtime, sleepWake: wake })
    }
    return json({ ok: true })
  }

  if (path.startsWith('/api/sleep/') && req.method === 'POST') {
    const sleepSegment = path.split('/')[3]

    if (sleepSegment === 'ingest') {
      const body = (await req.json().catch(() => ({}))) as {
        token?: string; email?: string; session?: string
        sleepDate?: string; bedtime?: string; wake?: string; hours?: number; source?: string
      }
      const bedtime = String(body.bedtime || '').trim()
      const wake = String(body.wake || '').trim()
      if (!isClock(bedtime) || !isClock(wake)) return json({ error: 'bedtime and wake required as HH:MM' }, 400)
      const { user, error } = await resolveAuthedUser(sql, { token: body.token, session: (body as { session?: string }).session, email: body.email })
      if (error) return error
      const sleepDate = String(body.sleepDate || shiftDateStr(localDateStrInTz(new Date(), user!.timezone), -1)).slice(0, 10)
      const source = String(body.source || 'apple_health').slice(0, 40)
      const id = crypto.randomUUID()
      await sql`
        INSERT INTO hire_sleep (id, user_id, sleep_date, bedtime, wake, quality, note, source)
        VALUES (${id}, ${user!.id}, ${sleepDate}, ${bedtime}, ${wake}, 3, NULL, ${source})
        ON CONFLICT (user_id, sleep_date) DO UPDATE SET
          bedtime = excluded.bedtime, wake = excluded.wake, source = excluded.source
      `
      if (isClock(bedtime) && isClock(wake)) {
        await saveMiniPrefs(sql, user!.id, { sleepBedtime: bedtime, sleepWake: wake })
      }
      return json({ ok: true, sleepDate, bedtime, wake })
    }

    const body = (await req.json().catch(() => ({}))) as { token?: string; email?: string; _delete?: boolean }
    if (!body._delete) return json({ error: 'Not found' }, 404)
    const id = path.split('/')[3]
    if (!id) return json({ error: 'id required' }, 400)
    const { user, error } = await resolveAuthedUser(sql, { token: body.token, session: (body as { session?: string }).session, email: body.email })
    if (error) return error
    await sql`DELETE FROM hire_sleep WHERE id = ${id} AND user_id = ${user!.id}`
    return json({ ok: true })
  }

  if (path === '/api/internal/sleep' && req.method === 'POST') {
    if (!options.internalOk(req)) return json({ error: 'Unauthorized' }, 401)
    const body = (await req.json().catch(() => ({}))) as { phone?: string; persona?: string; text?: string }
    if (!body.phone || !isPersona(body.persona || '') || !String(body.text || '').trim()) {
      return json({ error: 'phone, persona, and text required' }, 400)
    }
    const user = await getUserByPhone(sql, body.phone)
    if (!user) return json({ error: 'User not found' }, 404)
    const prefs = await loadMiniPrefs(sql, user.id)
    const parsed = parseSleepText(String(body.text)) || sleepFromHours(String(body.text), prefs.sleepBedtime)
    if (!parsed) return json({ ok: false, logged: false, error: 'Could not parse sleep times' })
    const sleepDate = shiftDateStr(localDateStrInTz(new Date(), user.timezone), -1)
    const id = crypto.randomUUID()
    await sql`
      INSERT INTO hire_sleep (id, user_id, sleep_date, bedtime, wake, quality, note)
      VALUES (${id}, ${user.id}, ${sleepDate}, ${parsed.bedtime}, ${parsed.wake}, 3, NULL)
      ON CONFLICT (user_id, sleep_date) DO UPDATE SET
        bedtime = excluded.bedtime, wake = excluded.wake
    `
    await saveMiniPrefs(sql, user.id, { sleepBedtime: parsed.bedtime, sleepWake: parsed.wake })
    return json({ ok: true, logged: true, id, sleepDate, ...parsed })
  }

  /* ---- Nutrition ---- */
  if (path === '/api/nutrition' && req.method === 'GET') {
    const { user, error } = await resolveAuthedUser(sql, {
      token: url.searchParams.get('t') || undefined,
      session: url.searchParams.get('s') || undefined,
      email: url.searchParams.get('email') || undefined,
    })
    if (error) return error
    const goalRows = await sql`
      SELECT calorie_goal AS "calorieGoal", protein_goal AS "proteinGoal",
             carbs_goal AS "carbsGoal", fat_goal AS "fatGoal"
      FROM hire_nutrition_goals WHERE user_id = ${user!.id} LIMIT 1
    `
    const goals = goalRows[0] as
      | { calorieGoal: number; proteinGoal: number; carbsGoal: number; fatGoal: number }
      | undefined
    const { start, end } = todayWindowUtc(user!.timezone || 'America/Los_Angeles')
    const logs = await sql`
      SELECT id, description, image_url AS "imageUrl", calories, protein, carbs, fat,
             eaten_at AS "eatenAt"
      FROM hire_nutrition_logs
      WHERE user_id = ${user!.id} AND eaten_at >= ${start.toISOString()} AND eaten_at < ${end.toISOString()}
      ORDER BY eaten_at ASC
    `
    const historyFrom = new Date(start.getTime() - 14 * 86_400_000)
    const history = await sql`
      SELECT id, description, image_url AS "imageUrl", calories, protein, carbs, fat,
             eaten_at AS "eatenAt"
      FROM hire_nutrition_logs
      WHERE user_id = ${user!.id}
        AND eaten_at >= ${historyFrom.toISOString()}
        AND eaten_at < ${start.toISOString()}
      ORDER BY eaten_at DESC
      LIMIT 40
    `
    const totals = (logs as Array<{ calories: number; protein: number; carbs: number; fat: number }>).reduce(
      (acc, l) => ({
        calories: acc.calories + clampNum(l.calories),
        protein: acc.protein + clampNum(l.protein),
        carbs: acc.carbs + clampNum(l.carbs),
        fat: acc.fat + clampNum(l.fat),
      }),
      { calories: 0, protein: 0, carbs: 0, fat: 0 },
    )
    return json({
      goals: goals || { calorieGoal: 2200, proteinGoal: 150, carbsGoal: 220, fatGoal: 70 },
      logs,
      history,
      totals,
    })
  }

  if (path === '/api/nutrition' && req.method === 'POST') {
    const body = (await req.json().catch(() => ({}))) as {
      token?: string; email?: string; description?: string
      calories?: number; protein?: number; carbs?: number; fat?: number
      eatenAt?: string; imageUrl?: string
    }
    const description = String(body.description || '').trim().slice(0, 300)
    if (!description) return json({ error: 'description required' }, 400)
    const { user, error } = await resolveAuthedUser(sql, { token: body.token, session: (body as { session?: string }).session, email: body.email })
    if (error) return error
    const id = crypto.randomUUID()
    await sql`
      INSERT INTO hire_nutrition_logs (id, user_id, description, image_url, calories, protein, carbs, fat, eaten_at)
      VALUES (${id}, ${user!.id}, ${description}, ${body.imageUrl || null},
        ${clampNum(body.calories)}, ${clampNum(body.protein)}, ${clampNum(body.carbs)}, ${clampNum(body.fat)},
        ${body.eatenAt ? new Date(body.eatenAt).toISOString() : new Date().toISOString()})
    `
    return json({ ok: true, id })
  }

  if (path === '/api/nutrition/goals' && req.method === 'PUT') {
    const body = (await req.json().catch(() => ({}))) as {
      token?: string; email?: string
      calorieGoal?: number; proteinGoal?: number; carbsGoal?: number; fatGoal?: number
    }
    const { user, error } = await resolveAuthedUser(sql, { token: body.token, session: (body as { session?: string }).session, email: body.email })
    if (error) return error
    const cal = clampNum(body.calorieGoal, 2200)
    const pro = clampNum(body.proteinGoal, 150)
    const carb = clampNum(body.carbsGoal, 220)
    const fat = clampNum(body.fatGoal, 70)
    await sql`
      INSERT INTO hire_nutrition_goals (user_id, calorie_goal, protein_goal, carbs_goal, fat_goal)
      VALUES (${user!.id}, ${cal}, ${pro}, ${carb}, ${fat})
      ON CONFLICT (user_id)
      DO UPDATE SET calorie_goal = ${cal}, protein_goal = ${pro}, carbs_goal = ${carb}, fat_goal = ${fat},
        updated_at = now()
    `
    return json({ ok: true })
  }

  if (path === '/api/nutrition/analyze' && req.method === 'POST') {
    const body = (await req.json().catch(() => ({}))) as {
      token?: string; email?: string; description?: string; imageBase64?: string
    }
    const { user, error } = await resolveAuthedUser(sql, { token: body.token, session: (body as { session?: string }).session, email: body.email })
    if (error) return error
    void user
    const estimate = await estimateNutrition(String(body.description || '').slice(0, 500), body.imageBase64 || '')
    return json(estimate)
  }

  if (path === '/api/nutrition/photo' && req.method === 'POST') {
    const body = (await req.json().catch(() => ({}))) as {
      token?: string; email?: string; description?: string; imageBase64?: string
    }
    const imageBase64 = String(body.imageBase64 || '')
    if (imageBase64.length < 64) return json({ error: 'Photo is required' }, 400)
    const { user, error } = await resolveAuthedUser(sql, { token: body.token, session: (body as { session?: string }).session, email: body.email })
    if (error) return error
    const described = String(body.description || '').trim().slice(0, 300)
    let estimate: Awaited<ReturnType<typeof estimateNutrition>> = { ok: false, needsKey: true }
    if (nutritionModelConfig()) {
      try {
        estimate = await estimateNutrition(described || 'Estimate the macros of the meal in this photo.', imageBase64)
      } catch {
        estimate = { ok: false, error: 'Estimator unavailable' }
      }
    }
    const id = crypto.randomUUID()
    const detail = described || 'Meal from photo'
    const imageUrl = `data:${imageMimeFromBase64(imageBase64)};base64,${imageBase64}`
    const macros = estimate.ok
      ? {
          calories: clampNum(estimate.calories),
          protein: clampNum(estimate.protein),
          carbs: clampNum(estimate.carbs),
          fat: clampNum(estimate.fat),
        }
      : { calories: 0, protein: 0, carbs: 0, fat: 0 }
    await sql`
      INSERT INTO hire_nutrition_logs (id, user_id, description, image_url, calories, protein, carbs, fat, eaten_at)
      VALUES (${id}, ${user!.id}, ${estimate.ok ? (estimate.guess || detail) : `${detail} (estimate pending)`}, ${imageUrl},
        ${macros.calories}, ${macros.protein}, ${macros.carbs}, ${macros.fat}, now())
    `
    return json({ ok: true, id, imageUrl, estimated: estimate.ok, needsKey: estimate.needsKey === true })
  }

  if (path.startsWith('/api/nutrition/') && req.method === 'POST') {
    const body = (await req.json().catch(() => ({}))) as { token?: string; email?: string; _delete?: boolean }
    if (!body._delete) return json({ error: 'Not found' }, 404)
    const logId = path.split('/')[3]
    if (!logId) return json({ error: 'id required' }, 400)
    const { user, error } = await resolveAuthedUser(sql, { token: body.token, session: (body as { session?: string }).session, email: body.email })
    if (error) return error
    await sql`DELETE FROM hire_nutrition_logs WHERE id = ${logId} AND user_id = ${user!.id}`
    return json({ ok: true })
  }

  if (path === '/api/internal/nutrition' && req.method === 'POST') {
    if (!options.internalOk(req)) return json({ error: 'Unauthorized' }, 401)
    const body = (await req.json().catch(() => ({}))) as {
      phone?: string; persona?: string; description?: string; idempotencyKey?: string
    }
    const description = String(body.description || '').trim().slice(0, 500)
    if (!body.phone || !isPersona(body.persona || '') || !description) {
      return json({ error: 'phone, persona, and description required' }, 400)
    }
    const user = await getUserByPhone(sql, body.phone || '')
    if (!user) return json({ error: 'User not found' }, 404)

    const idempotencyKey =
      body.idempotencyKey ||
      req.headers.get('idempotency-key') ||
      req.headers.get('x-idempotency-key') ||
      computeIdempotencyKey('nutrition', {
        userId: user.id,
        description,
      })

    const { result } = await withIdempotency(idempotencyKey, async () => {
      const existing = (await sql`
        SELECT id, description, calories FROM hire_nutrition_logs
        WHERE user_id = ${user.id} AND description LIKE ${`${description.slice(0, 50)}%`}
          AND eaten_at > now() - interval '10 minutes'
        ORDER BY eaten_at DESC LIMIT 1
      `) as Array<{ id: string; description: string; calories: number | null }>

      if (existing[0]) {
        return {
          ok: true,
          logged: true,
          deduplicated: true,
          id: existing[0].id,
          guess: existing[0].description,
        }
      }

      let estimate: Awaited<ReturnType<typeof estimateNutrition>> = { ok: false, needsKey: true }
      if (nutritionModelConfig()) {
        try {
          estimate = await estimateNutrition(description, '')
        } catch {
          estimate = { ok: false, error: 'Estimator unavailable' }
        }
      }
      const id = crypto.randomUUID()
      const saved = estimate.ok ? (estimate.guess || description).slice(0, 300) : `${description.slice(0, 300)} (estimate pending)`
      await sql`
        INSERT INTO hire_nutrition_logs (id, user_id, description, image_url, calories, protein, carbs, fat, eaten_at)
        VALUES (${id}, ${user.id}, ${saved}, NULL,
          ${clampNum(estimate.calories)}, ${clampNum(estimate.protein)}, ${clampNum(estimate.carbs)}, ${clampNum(estimate.fat)}, now())
      `
      return { ok: true, logged: true, id, estimated: estimate.ok, needsKey: estimate.needsKey === true, guess: estimate.guess || undefined }
    })

    return json(result)
  }

  if (path === '/api/internal/nutrition/photo' && req.method === 'POST') {
    if (!options.internalOk(req)) return json({ error: 'Unauthorized' }, 401)
    const body = (await req.json().catch(() => ({}))) as {
      phone?: string; persona?: string; description?: string; imageBase64?: string
    }
    const imageBase64 = String(body.imageBase64 || '')
    if (!body.phone || !isPersona(body.persona || '') || imageBase64.length < 64) {
      return json({ error: 'phone, persona, and imageBase64 required' }, 400)
    }
    const user = await getUserByPhone(sql, body.phone)
    if (!user) return json({ error: 'User not found' }, 404)
    const described = String(body.description || '').trim().slice(0, 300)
    let estimate: Awaited<ReturnType<typeof estimateNutrition>> = { ok: false, needsKey: true }
    if (nutritionModelConfig()) {
      try {
        estimate = await estimateNutrition(described || 'Estimate the macros of the meal in this photo.', imageBase64)
      } catch {
        estimate = { ok: false, error: 'Estimator unavailable' }
      }
    }
    const id = crypto.randomUUID()
    const detail = described || 'Meal from photo'
    const imageUrl = `data:${imageMimeFromBase64(imageBase64)};base64,${imageBase64}`
    const macros = estimate.ok
      ? {
          calories: clampNum(estimate.calories),
          protein: clampNum(estimate.protein),
          carbs: clampNum(estimate.carbs),
          fat: clampNum(estimate.fat),
        }
      : { calories: 0, protein: 0, carbs: 0, fat: 0 }
    await sql`
      INSERT INTO hire_nutrition_logs (id, user_id, description, image_url, calories, protein, carbs, fat, eaten_at)
      VALUES (${id}, ${user.id}, ${estimate.ok ? (estimate.guess || detail) : `${detail} (estimate pending)`}, ${imageUrl},
        ${macros.calories}, ${macros.protein}, ${macros.carbs}, ${macros.fat}, now())
    `
    return json({ ok: true, logged: true, id, estimated: estimate.ok, needsKey: estimate.needsKey === true, ...macros })
  }

  /* ---- Moods ---- */
  if (path === '/api/moods' && req.method === 'GET') {
    const { user, error } = await resolveAuthedUser(sql, {
      token: url.searchParams.get('t') || undefined,
      session: url.searchParams.get('s') || undefined,
      email: url.searchParams.get('email') || undefined,
    })
    if (error) return error
    const entries = await sql`
      SELECT id, emoji, energy, note, created_at AS "createdAt"
      FROM hire_moods WHERE user_id = ${user!.id}
      ORDER BY created_at DESC LIMIT 30
    `
    const tz = user!.timezone || 'America/Los_Angeles'
    const days = new Set(
      (entries as Array<{ createdAt: Date | string }>).map((e) =>
        localDateStrInTz(new Date(e.createdAt), tz),
      ),
    )
    let streak = 0
    let cursor = localDateStrInTz(new Date(), tz)
    while (days.has(cursor) && streak < 30) {
      streak++
      cursor = shiftDateStr(cursor, -1)
    }
    return json({ entries, streak })
  }

  if (path === '/api/moods' && req.method === 'POST') {
    const body = (await req.json().catch(() => ({}))) as {
      token?: string; email?: string; emoji?: string; energy?: number; note?: string
    }
    if (!body.emoji) return json({ error: 'emoji required' }, 400)
    const { user, error } = await resolveAuthedUser(sql, { token: body.token, session: (body as { session?: string }).session, email: body.email })
    if (error) return error
    const id = crypto.randomUUID()
    const energy = Math.max(1, Math.min(5, Math.round(body.energy || 3)))
    const note = String(body.note || '').trim().slice(0, 500) || null
    const { start, end } = todayWindowUtc(user!.timezone || 'America/Los_Angeles')
    await sql`
      DELETE FROM hire_moods
      WHERE user_id = ${user!.id}
        AND created_at >= ${start.toISOString()}
        AND created_at < ${end.toISOString()}
    `
    await sql`INSERT INTO hire_moods (id, user_id, emoji, energy, note) VALUES (${id}, ${user!.id}, ${body.emoji}, ${energy}, ${note})`
    return json({ ok: true, id })
  }

  if (path === '/api/internal/moods' && req.method === 'POST') {
    if (!options.internalOk(req)) return json({ error: 'Unauthorized' }, 401)
    const body = (await req.json().catch(() => ({}))) as {
      phone?: string; persona?: string; emoji?: string; energy?: number; text?: string; note?: string
    }
    if (!body.phone || !isPersona(body.persona || '')) {
      return json({ error: 'phone and persona required' }, 400)
    }
    const user = await getUserByPhone(sql, body.phone)
    if (!user) return json({ error: 'User not found' }, 404)
    const parsed = parseMoodReply(body.emoji || body.text || '')
    if (!parsed) return json({ ok: false, logged: false, error: 'Could not parse a mood' })
    const tz = user.timezone || 'America/Los_Angeles'
    const ds = localDateStrInTz(new Date(), tz)
    const has = await sql`SELECT 1 FROM hire_moods WHERE user_id = ${user.id} AND (created_at AT TIME ZONE ${tz})::date = ${ds} LIMIT 1`
    if (has[0]) return json({ ok: true, logged: true, id: crypto.randomUUID(), ...parsed, existing: true })
    const id = crypto.randomUUID()
    await sql`
      INSERT INTO hire_moods (id, user_id, emoji, energy, note)
      VALUES (${id}, ${user.id}, ${parsed.emoji}, ${parsed.energy}, ${parsed.note})
    `
    return json({ ok: true, logged: true, id, ...parsed })
  }

  /* ---- Gratitude ---- */
  if (path === '/api/gratitude' && req.method === 'GET') {
    const { user, error } = await resolveAuthedUser(sql, {
      token: url.searchParams.get('t') || undefined,
      session: url.searchParams.get('s') || undefined,
      email: url.searchParams.get('email') || undefined,
    })
    if (error) return error
    const entries = await sql`
      SELECT id, text, created_at AS "createdAt"
      FROM hire_gratitude WHERE user_id = ${user!.id}
      ORDER BY created_at DESC LIMIT 40
    `
    const monday = userMonday(user!)
    const weekWindow = weekWindowUtc(monday, user!.timezone || 'America/Los_Angeles')
    const weekCount = await sql`
      SELECT count(*)::int AS n FROM hire_gratitude
      WHERE user_id = ${user!.id} AND created_at >= ${weekWindow.start.toISOString()} AND created_at < ${weekWindow.end.toISOString()}
    `
    return json({ entries, weekCount: Number((weekCount[0] as { n: number })?.n || 0) })
  }

  if (path === '/api/gratitude' && req.method === 'POST') {
    const body = (await req.json().catch(() => ({}))) as { token?: string; email?: string; text?: string }
    const text = String(body.text || '').trim().slice(0, 280)
    if (!text) return json({ error: 'text required' }, 400)
    const { user, error } = await resolveAuthedUser(sql, { token: body.token, session: (body as { session?: string }).session, email: body.email })
    if (error) return error
    const id = crypto.randomUUID()
    await sql`INSERT INTO hire_gratitude (id, user_id, text) VALUES (${id}, ${user!.id}, ${text})`
    return json({ ok: true, id })
  }

  if (path.startsWith('/api/gratitude/') && req.method === 'POST') {
    const body = (await req.json().catch(() => ({}))) as { token?: string; email?: string; _delete?: boolean }
    if (!body._delete) return json({ error: 'Not found' }, 404)
    const id = path.split('/')[3]
    if (!id) return json({ error: 'id required' }, 400)
    const { user, error } = await resolveAuthedUser(sql, { token: body.token, session: (body as { session?: string }).session, email: body.email })
    if (error) return error
    await sql`DELETE FROM hire_gratitude WHERE id = ${id} AND user_id = ${user!.id}`
    return json({ ok: true })
  }

  if (path === '/api/internal/gratitude' && req.method === 'POST') {
    if (!options.internalOk(req)) return json({ error: 'Unauthorized' }, 401)
    const body = (await req.json().catch(() => ({}))) as { phone?: string; persona?: string; text?: string }
    if (!body.phone || !isPersona(body.persona || '') || !String(body.text || '').trim()) {
      return json({ error: 'phone, persona, and text required' }, 400)
    }
    const user = await getUserByPhone(sql, body.phone)
    if (!user) return json({ error: 'User not found' }, 404)
    const parsed = parseGratitudeText(String(body.text))
    if (!parsed) return json({ ok: false, logged: false, error: 'Could not parse gratitude' })
    const id = crypto.randomUUID()
    await sql`INSERT INTO hire_gratitude (id, user_id, text) VALUES (${id}, ${user.id}, ${parsed})`
    return json({ ok: true, logged: true, id, text: parsed })
  }

  /* ---- Spending ---- */
  if (path === '/api/spending' && req.method === 'GET') {
    const { user, error } = await resolveAuthedUser(sql, {
      token: url.searchParams.get('t') || undefined,
      session: url.searchParams.get('s') || undefined,
      email: url.searchParams.get('email') || undefined,
    })
    if (error) return error
    const weekStart = userMonday(user!)
    const weekWindow = weekWindowUtc(weekStart, user!.timezone || 'America/Los_Angeles')
    const [logs, week, budgetRow] = await Promise.all([
      sql`
        SELECT id, amount, category, description, spent_at AS "spentAt"
        FROM hire_spending WHERE user_id = ${user!.id}
        ORDER BY spent_at DESC LIMIT 40
      `,
      sql`
        SELECT category, coalesce(sum(amount), 0)::real AS total
        FROM hire_spending
        WHERE user_id = ${user!.id} AND spent_at >= ${weekWindow.start.toISOString()} AND spent_at < ${weekWindow.end.toISOString()}
        GROUP BY category
      `,
      sql`SELECT weekly_budget AS "weeklyBudget" FROM hire_spending_budget WHERE user_id = ${user!.id}`,
    ])
    const weeklyBudget = Number((budgetRow[0] as { weeklyBudget?: number })?.weeklyBudget || 400)
    const weekTotal = (week as Array<{ total: number }>).reduce((s, r) => s + Number(r.total), 0)
    return jsonRevalidated(req, 15, { logs, byCategory: week, weekTotal, weeklyBudget, weekStart })
  }

  if (path === '/api/spending' && req.method === 'POST') {
    const body = (await req.json().catch(() => ({}))) as {
      token?: string; email?: string; amount?: number; category?: string; description?: string
    }
    const amount = Number(body.amount)
    if (!Number.isFinite(amount) || amount <= 0) return json({ error: 'amount required' }, 400)
    const { user, error } = await resolveAuthedUser(sql, { token: body.token, session: (body as { session?: string }).session, email: body.email })
    if (error) return error
    const category = SPEND_CATEGORIES.includes(String(body.category) as (typeof SPEND_CATEGORIES)[number])
      ? String(body.category)
      : 'other'
    const description = String(body.description || '').trim().slice(0, 160)
    const id = crypto.randomUUID()
    await sql`
      INSERT INTO hire_spending (id, user_id, amount, category, description)
      VALUES (${id}, ${user!.id}, ${amount}, ${category}, ${description})
    `
    return json({ ok: true, id })
  }

  if (path === '/api/spending/budget' && req.method === 'PUT') {
    const body = (await req.json().catch(() => ({}))) as { token?: string; email?: string; weeklyBudget?: number }
    const { user, error } = await resolveAuthedUser(sql, { token: body.token, session: (body as { session?: string }).session, email: body.email })
    if (error) return error
    const weeklyBudget = Math.max(10, Number(body.weeklyBudget) || 400)
    await sql`
      INSERT INTO hire_spending_budget (user_id, weekly_budget) VALUES (${user!.id}, ${weeklyBudget})
      ON CONFLICT (user_id) DO UPDATE SET weekly_budget = excluded.weekly_budget, updated_at = now()
    `
    return json({ ok: true })
  }

  if (path.startsWith('/api/spending/') && req.method === 'POST') {
    const body = (await req.json().catch(() => ({}))) as { token?: string; email?: string; _delete?: boolean }
    if (!body._delete) return json({ error: 'Not found' }, 404)
    const id = path.split('/')[3]
    if (!id) return json({ error: 'id required' }, 400)
    const { user, error } = await resolveAuthedUser(sql, { token: body.token, session: (body as { session?: string }).session, email: body.email })
    if (error) return error
    await sql`DELETE FROM hire_spending WHERE id = ${id} AND user_id = ${user!.id}`
    return json({ ok: true })
  }

  if (path === '/api/internal/spending' && req.method === 'POST') {
    if (!options.internalOk(req)) return json({ error: 'Unauthorized' }, 401)
    const body = (await req.json().catch(() => ({}))) as { phone?: string; persona?: string; text?: string }
    if (!body.phone || !isPersona(body.persona || '') || !String(body.text || '').trim()) {
      return json({ error: 'phone, persona, and text required' }, 400)
    }
    const user = await getUserByPhone(sql, body.phone)
    if (!user) return json({ error: 'User not found' }, 404)
    const parsed = parseSpendText(String(body.text))
    if (!parsed) return json({ ok: false, logged: false, error: 'Could not parse spend' })
    const weekStart = userMonday(user)
    const weekWindow = weekWindowUtc(weekStart, user.timezone || 'America/Los_Angeles')
    const spent = await sql`
      SELECT coalesce(sum(amount), 0)::real AS total FROM hire_spending
      WHERE user_id = ${user.id} AND spent_at >= ${weekWindow.start.toISOString()} AND spent_at < ${weekWindow.end.toISOString()}
    `
    const budget = await sql`SELECT weekly_budget AS "weeklyBudget" FROM hire_spending_budget WHERE user_id = ${user.id}`
    const weekTotal = Number((spent[0] as { total?: number })?.total || 0)
    const weeklyBudget = Math.round(Number((budget[0] as { weeklyBudget?: number })?.weeklyBudget) || 400)
    if (spendWouldBreakCap(weekTotal, weeklyBudget, parsed.amount)) {
      return json({
        ok: false,
        logged: false,
        overCap: true,
        amount: parsed.amount,
        weekTotal,
        weeklyBudget,
      })
    }
    const id = crypto.randomUUID()
    await sql`
      INSERT INTO hire_spending (id, user_id, amount, category, description)
      VALUES (${id}, ${user.id}, ${parsed.amount}, ${parsed.category}, ${parsed.description})
    `
    return json({ ok: true, logged: true, id, ...parsed })
  }

  /* ---- Mini Preferences ---- */
  if (path === '/api/mini-prefs' && req.method === 'GET') {
    const { user, error } = await resolveAuthedUser(sql, {
      token: url.searchParams.get('t') || undefined,
      session: url.searchParams.get('s') || undefined,
      email: url.searchParams.get('email') || undefined,
    })
    if (error) return error
    const prefs = await loadMiniPrefs(sql, user!.id)
    return json(prefs)
  }

  if (path === '/api/mini-prefs' && req.method === 'PUT') {
    const body = (await req.json().catch(() => ({}))) as {
      token?: string; email?: string
      workoutPlace?: string; workoutMoveCount?: number; workoutDays?: number[]
      sleepBedtime?: string; sleepWake?: string
      currentWeightLb?: number; targetWeightLb?: number; weightGoal?: string
    }
    const { user, error } = await resolveAuthedUser(sql, { token: body.token, session: (body as { session?: string }).session, email: body.email })
    if (error) return error
    const prefs = await saveMiniPrefs(sql, user!.id, {
      workoutPlace: body.workoutPlace === 'home' || body.workoutPlace === 'gym' ? body.workoutPlace : undefined,
      workoutMoveCount: body.workoutMoveCount === 4 || body.workoutMoveCount === 5 || body.workoutMoveCount === 6
        ? body.workoutMoveCount
        : undefined,
      workoutDays: Array.isArray(body.workoutDays) ? body.workoutDays : undefined,
      sleepBedtime: body.sleepBedtime,
      sleepWake: body.sleepWake,
      currentWeightLb: typeof body.currentWeightLb === 'number' ? body.currentWeightLb : undefined,
      targetWeightLb: typeof body.targetWeightLb === 'number' ? body.targetWeightLb : undefined,
      weightGoal: body.weightGoal === 'loss' || body.weightGoal === 'gain' || body.weightGoal === 'muscle' ? body.weightGoal : undefined,
    })
    return json({ ok: true, ...prefs })
  }

  if (path === '/api/internal/budget' && req.method === 'POST') {
    if (!options.internalOk(req)) return json({ error: 'Unauthorized' }, 401)
    const body = (await req.json().catch(() => ({}))) as { phone?: string; persona?: string; text?: string }
    if (!body.phone || !isPersona(body.persona || '') || !String(body.text || '').trim()) {
      return json({ error: 'phone, persona, and text required' }, 400)
    }
    const user = await getUserByPhone(sql, body.phone)
    if (!user) return json({ error: 'User not found' }, 404)
    const m = String(body.text).match(/\$?\s*(\d{2,6})/)
    if (!m) return json({ ok: false, logged: false, error: 'Could not read a budget amount' })
    const amount = Math.min(50000, Math.max(50, Number(m[1])))
    await sql`
      INSERT INTO hire_spending_budget (user_id, weekly_budget, updated_at)
      VALUES (${user.id}, ${amount}, now())
      ON CONFLICT (user_id) DO UPDATE SET weekly_budget = ${amount}, updated_at = now()
    `
    return json({ ok: true, logged: true, weeklyBudget: amount })
  }

  if (path === '/api/internal/prefs' && req.method === 'POST') {
    if (!options.internalOk(req)) return json({ error: 'Unauthorized' }, 401)
    const body = (await req.json().catch(() => ({}))) as { phone?: string; persona?: string; text?: string }
    if (!body.phone || !isPersona(body.persona || '') || !String(body.text || '').trim()) {
      return json({ error: 'phone, persona, and text required' }, 400)
    }
    const user = await getUserByPhone(sql, body.phone)
    if (!user) return json({ error: 'User not found' }, 404)
    const text = String(body.text)
    const patch: Partial<MiniPrefs> = {}

    const place = text.match(/\b(?:workout|train)\w*[\s\S]{0,24}?\b(home|gym)\b/i)
    if (place) patch.workoutPlace = place[1]!.toLowerCase() as 'home' | 'gym'
    const moves = text.match(/moves?\s*(?:per\s+day)?\s*(?:to|at)?\s*(4|5|6)\b/i) || text.match(/\b(4|5|6)\s+moves?\b/i)
    if (moves) patch.workoutMoveCount = Number(moves[1]) as 4 | 5 | 6

    const DAY_NUM: Record<string, number> = { sunday: 0, monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6 }
    if (/\bevery\s+day\b/i.test(text)) {
      patch.workoutDays = [0, 1, 2, 3, 4, 5, 6]
    } else {
      const named = Object.keys(DAY_NUM).filter((n) => new RegExp(`\\b${n}\\b`, 'i').test(text))
      if (named.length) patch.workoutDays = named.map((n) => DAY_NUM[n]!)
    }

    const clockAt = (label: string) => {
      const m = text.match(new RegExp(`${label}\\s*(?:at)?\\s*(\\d{1,2})(?::(\\d{2}))?\\s*(am|pm)?`, 'i'))
      if (!m) return ''
      let h = Number(m[1])
      const min = m[2] ? Number(m[2]) : 0
      const ap = (m[3] || '').toLowerCase()
      if (ap === 'pm' && h < 12) h += 12
      if (ap === 'am' && h === 12) h = 0
      if (h > 23 || min > 59) return ''
      return `${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}`
    }
    const bedtime = clockAt('bedtime') || clockAt('sleep')
    const wake = clockAt('wake')
    if (bedtime) patch.sleepBedtime = bedtime
    if (wake) patch.sleepWake = wake

    if (!Object.keys(patch).length) {
      return json({ ok: false, changed: false, error: 'Could not read a setting to change' })
    }
    const prefs = await saveMiniPrefs(sql, user.id, patch)
    return json({ ok: true, changed: true, ...prefs })
  }

  /* Recent spending logs for the bot's billguard: category, amount, note. */
  if (path === '/api/internal/spending' && req.method === 'GET') {
    if (!options.internalOk(req)) return json({ error: 'Unauthorized' }, 401)
    const phone = url.searchParams.get('phone') || ''
    if (!phone) return json({ error: 'phone required' }, 400)
    const user = await getUserByPhone(sql, phone)
    if (!user) return json({ logs: [], weekly: 0, budget: 0 })
    const rows = await sql`
      SELECT amount, category, description, spent_at AS "spentAt" FROM hire_spending
      WHERE user_id = ${user.id} AND spent_at >= now() - interval '60 days'
      ORDER BY spent_at DESC LIMIT 60
    `
    const week = await sql`
      SELECT coalesce(sum(amount), 0)::float AS total FROM hire_spending
      WHERE user_id = ${user.id} AND spent_at >= now() - interval '7 days'
    `
    const weekly = Number((week[0] as { total?: number } | undefined)?.total || 0)
    const budgetRows = await sql`
      SELECT weekly_budget AS "weeklyBudget" FROM hire_spending_budget WHERE user_id = ${user.id} LIMIT 1
    `
    const budget = Number((budgetRows[0] as { weeklyBudget?: number } | undefined)?.weeklyBudget || 0)
    return json({ logs: rows, weekly, budget })
  }

  return null
}
