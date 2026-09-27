import type { SQL } from 'bun'
import { isPersona, type Persona } from '../personas'
import {
  loopTimezone,
  localWall,
  nextDailyUtc,
  nextWeeklyUtc,
  wallTimeToUtc,
  shiftDateStr,
} from '../timezones'
import { normalizePhone } from '../utils/phone'

export const TASK_LOOP_MAX_ATTEMPTS = 5

/** Default loops armed when a phone joins a roster. Deduped per (user, persona,
 * kind), so re-arming the same number never grows the list. */
export async function seedDefaultLoops(
  sql: SQL,
  userId: string,
  phone: string,
  persona: Persona,
  timezone?: string | null,
): Promise<void> {
  const tz = loopTimezone(timezone)
  const seeds = [
    { kind: 'wakeup', title: 'Morning wakeup', nextRun: nextDailyUtc(tz, 8), payload: { hour: 8 } },
    {
      kind: 'refund_hunter',
      title: 'Hunt refunds and unused subscriptions',
      nextRun: nextWeeklyUtc(tz, 10, 2),
      payload: {},
    },
    {
      kind: 'memory_resurface',
      title: 'Resurface one saved memory',
      nextRun: nextWeeklyUtc(tz, 12, 5),
      payload: {},
    },
  ]
  for (const seed of seeds) {
    await sql`
      INSERT INTO hire_task_loops (id, user_id, persona, phone_e164, kind, title, payload, status, next_run)
      VALUES (${crypto.randomUUID()}, ${userId}, ${persona}, ${phone}, ${seed.kind}, ${seed.title},
        ${JSON.stringify(seed.payload)}::jsonb, 'pending', ${seed.nextRun})
      ON CONFLICT (user_id, persona, kind) DO NOTHING
    `
  }
}

/** Friendly tier label for the trial-ending text, from what the checkout
 * wrote. persona 'all' means a bundle/ultra subscription: price_id picks
 * Ultra when it matches, otherwise every 'all' row covers all three hires.
 * A bare friend row is the single hire, which the product calls Alpha. */
export function trialTierLabel(persona: string, priceId: string | null): string {
  if (persona === 'all') {
    const ultra = process.env.STRIPE_PRICE_ULTRA?.trim()
    return ultra && priceId === ultra ? 'Ultra' : 'All three'
  }
  if (persona === 'coworker') return 'Coworker'
  if (persona === 'cofounder') return 'Cofounder'
  return 'Alpha'
}

/** Daily arm for backlog #58 (free-trial ending in 2 days). Fact triggered:
 * only trialing hire_subscriptions whose current_period_end is inside the
 * window get a trial_ending loop, and only once per trial — an already-sent
 * (done) loop whose last_result marker matches the trial-end date is skipped,
 * as are loops still queued (pending/running). Bundle/ultra rows live
 * under persona 'all', so one loop is armed per roster hire they actually own. */
export async function armTrialEndingLoops(sql: SQL, windowDays = 2): Promise<number> {
  const rows = (await sql`
    SELECT s.user_id AS "userId", s.persona, u.phone_e164 AS phone, u.timezone,
           s.current_period_end AS "currentPeriodEnd", s.price_id AS "priceId"
    FROM hire_subscriptions s
    JOIN hire_users u ON u.id = s.user_id
    WHERE s.status = 'trialing'
      AND s.current_period_end IS NOT NULL
      AND s.current_period_end > now()
      AND s.current_period_end <= now() + make_interval(days => ${windowDays})
      AND u.phone_e164 IS NOT NULL
    ORDER BY s.current_period_end
  `) as Array<{
    userId: string
    persona: string
    phone: string
    timezone: string | null
    currentPeriodEnd: Date
    priceId: string | null
  }>

  let armed = 0
  for (const sub of rows) {
    const periodEnd = new Date(sub.currentPeriodEnd)
    if (Number.isNaN(periodEnd.getTime())) continue
    // A bundle/ultra row owns every hire; arm the touch for each persona on
    // the roster. Single rows arm only for their own hire.
    let personas: string[]
    if (sub.persona === 'all') {
      const roster = (await sql`
        SELECT persona FROM hire_roster WHERE user_id = ${sub.userId}
      `) as Array<{ persona: string }>
      personas = roster.map((r) => r.persona).filter((p) => isPersona(p))
      if (!personas.length) personas = ['friend']
    } else {
      personas = isPersona(sub.persona) ? [sub.persona] : []
    }
    if (!personas.length) continue

    for (const persona of personas) {
      const existing = (await sql`
        SELECT status, last_result AS "lastResult", payload
        FROM hire_task_loops
        WHERE user_id = ${sub.userId} AND persona = ${persona} AND kind = 'trial_ending'
        LIMIT 1
      `) as Array<{ status: string; lastResult: string | null; payload: unknown }>
      const row = existing[0]
      const marker = periodEnd.toISOString().slice(0, 10)
      if (row) {
        // Still queued or in flight: already armed, do not double arm. If the
        // trial date shifted (webhook re-sync), refresh the payload so the bot
        // texts the true end date.
        if (row.status === 'pending' || row.status === 'running') {
          const oldEnd =
            (row.payload as { trial_end?: string } | null)?.trial_end?.slice(0, 10) || ''
          if (oldEnd && oldEnd !== marker) {
            await sql`
              UPDATE hire_task_loops SET payload = ${JSON.stringify({
                trial_end: periodEnd.toISOString(),
                tier: trialTierLabel(sub.persona, sub.priceId),
                tz: sub.timezone || undefined,
              })}::jsonb, updated_at = now()
              WHERE id = (SELECT id FROM hire_task_loops
                WHERE user_id = ${sub.userId} AND persona = ${persona} AND kind = 'trial_ending' LIMIT 1)
            `
          }
          continue
        }
        // Already sent for this exact trial end (marker lives in last_result),
        // or permanently parked: never text the same trial twice.
        const sentFor = row.lastResult?.includes(marker)
        if (row.status === 'done' && sentFor) continue
        if (row.status === 'failed' || row.status === 'paused') continue
        // A done loop from an older trial, or an aborted one: re-arm for the
        // new trial cycle.
        await sql`
          UPDATE hire_task_loops SET
            title = 'Free trial ends in two days',
            payload = ${JSON.stringify({
              trial_end: periodEnd.toISOString(),
              tier: trialTierLabel(sub.persona, sub.priceId),
              tz: sub.timezone || undefined,
            })}::jsonb,
            status = 'pending',
            attempts = 0,
            last_result = NULL,
            next_run = now(),
            updated_at = now()
          WHERE id = (SELECT id FROM hire_task_loops
            WHERE user_id = ${sub.userId} AND persona = ${persona} AND kind = 'trial_ending' LIMIT 1)
        `
        armed++
        continue
      }
      await sql`
        INSERT INTO hire_task_loops (id, user_id, persona, phone_e164, kind, title, payload, status, next_run)
        VALUES (${crypto.randomUUID()}, ${sub.userId}, ${persona}, ${sub.phone}, 'trial_ending',
          'Free trial ends in two days',
          ${JSON.stringify({
            trial_end: periodEnd.toISOString(),
            tier: trialTierLabel(sub.persona, sub.priceId),
            tz: sub.timezone || undefined,
          })}::jsonb,
          'pending', now())
        ON CONFLICT (user_id, persona, kind) DO NOTHING
      `
      armed++
    }
  }
  if (armed) console.log(`[billing] trial_ending armed: ${armed} loop${armed === 1 ? '' : 's'}`)
  return armed
}

/** Backlog #33. For each friend-roster user with at least one person whose
 * birthday is today (in the user's timezone), arm one birthday_reminder loop.
 * The handler decides which person to text each time it runs; this arm just
 * keeps one row alive per (user, today) so the handler can find the right
 * people. The payload carries the local date and a marker used for dedupe. */
export async function armBirthdayReminders(sql: SQL, now = new Date()): Promise<number> {
  const rows = (await sql`
    SELECT u.id AS "userId", u.timezone, u.phone_e164 AS phone
    FROM hire_users u
    WHERE u.phone_e164 IS NOT NULL
      AND EXISTS (
        SELECT 1 FROM hire_network n
        WHERE n.user_id = u.id AND n.birthday IS NOT NULL
      )
  `) as Array<{ userId: string; timezone: string | null; phone: string }>
  let armed = 0
  for (const u of rows) {
    const tz = loopTimezone(u.timezone)
    const todayYmd = localWall(tz, now).ymd
    const match = (await sql`
      SELECT count(*)::int AS n FROM hire_network
      WHERE user_id = ${u.userId}
        AND birthday IS NOT NULL
        AND to_char(birthday, 'MM-DD') = substr(${todayYmd}, 6, 5)
    `) as Array<{ n: number }>
    if (!match[0]?.n) continue
    const marker = todayYmd
    const existing = (await sql`
      SELECT status, last_result AS "lastResult"
      FROM hire_task_loops
      WHERE user_id = ${u.userId} AND persona = 'friend' AND kind = 'birthday_reminder'
      LIMIT 1
    `) as Array<{ status: string; lastResult: string | null }>
    const row = existing[0]
    if (row) {
      // Already armed (pending or running) — leave it for the bot.
      if (row.status === 'pending' || row.status === 'running') continue
      // Sent for this exact date: do not double fire the same birthday.
      if (row.status === 'done' && row.lastResult?.includes(marker)) continue
      // Re-arm for today.
      await sql`
        UPDATE hire_task_loops SET
          title = 'Wish happy birthday',
          payload = ${JSON.stringify({ date: todayYmd, tz })}::jsonb,
          status = 'pending',
          attempts = 0,
          last_result = NULL,
          next_run = now(),
          updated_at = now()
        WHERE id = (SELECT id FROM hire_task_loops
          WHERE user_id = ${u.userId} AND persona = 'friend' AND kind = 'birthday_reminder' LIMIT 1)
      `
      armed++
      continue
    }
    await sql`
      INSERT INTO hire_task_loops (id, user_id, persona, phone_e164, kind, title, payload, status, next_run)
      VALUES (${crypto.randomUUID()}, ${u.userId}, 'friend', ${u.phone}, 'birthday_reminder',
        'Wish happy birthday',
        ${JSON.stringify({ date: todayYmd, tz })}::jsonb,
        'pending', now())
      ON CONFLICT (user_id, persona, kind) DO NOTHING
    `
    armed++
  }
  if (armed) console.log(`[loops] birthday_reminder armed: ${armed}`)
  return armed
}

/** Backlog #25. Find one habit per user where the past streak was at least 21
 * days and the user has not logged for 3+ days. Arm once per (user, habit),
 * dedupe on habit_id inside last_result so a re-arm after a one-day false
 * alarm does not text again about the same ended run. */
export async function armStreakEndedLoops(sql: SQL, now = new Date()): Promise<number> {
  const rows = (await sql`
    SELECT h.id AS "habitId", h.name, h.user_id AS "userId", u.timezone, u.phone_e164 AS phone
    FROM hire_habits h
    JOIN hire_users u ON u.id = h.user_id
    WHERE u.phone_e164 IS NOT NULL
  `) as Array<{
    habitId: string
    name: string
    userId: string
    timezone: string | null
    phone: string
  }>
  let armed = 0
  for (const h of rows) {
    const tz = loopTimezone(h.timezone)
    const todayYmd = localWall(tz, now).ymd
    const cutoff = shiftDateStr(todayYmd, -3)
    const recent = (await sql`
      SELECT date FROM hire_habit_logs
      WHERE user_id = ${h.userId} AND habit_id = ${h.habitId} AND date <= ${todayYmd}
      ORDER BY date DESC LIMIT 120
    `) as Array<{ date: string }>
    if (!recent.length) continue
    const dates = new Set(recent.map((r) => String(r.date).slice(0, 10)))
    if (
      dates.has(todayYmd) ||
      dates.has(shiftDateStr(todayYmd, -1)) ||
      dates.has(shiftDateStr(todayYmd, -2))
    ) {
      // The streak is alive within the last 2 days; not "ended".
      continue
    }
    /* Compute the longest streak ending at the most recent log date. If that
     * recent run was >= 21 days, the run mattered. */
    let lastDate = ''
    for (const d of [...dates].sort()) lastDate = d
    if (!lastDate || lastDate > cutoff) continue
    let streak = 0
    let cursor = lastDate
    while (dates.has(cursor)) {
      streak++
      cursor = shiftDateStr(cursor, -1)
    }
    if (streak < 21) continue
    const marker = `${h.habitId.slice(0, 8)}:${lastDate}`
    const existing = (await sql`
      SELECT status, last_result AS "lastResult"
      FROM hire_task_loops
      WHERE user_id = ${h.userId} AND persona = 'friend' AND kind = 'streak_ended'
      LIMIT 1
    `) as Array<{ status: string; lastResult: string | null }>
    const row = existing[0]
    if (row) {
      if (row.status === 'pending' || row.status === 'running') continue
      if (row.status === 'done' && row.lastResult?.includes(marker)) continue
      await sql`
        UPDATE hire_task_loops SET
          title = 'Habit streak ended',
          payload = ${JSON.stringify({
            habitId: h.habitId,
            habitName: h.name,
            streak,
            lastDate,
            tz,
          })}::jsonb,
          status = 'pending',
          attempts = 0,
          last_result = NULL,
          next_run = now(),
          updated_at = now()
        WHERE id = (SELECT id FROM hire_task_loops
          WHERE user_id = ${h.userId} AND persona = 'friend' AND kind = 'streak_ended' LIMIT 1)
      `
      armed++
      continue
    }
    await sql`
      INSERT INTO hire_task_loops (id, user_id, persona, phone_e164, kind, title, payload, status, next_run)
      VALUES (${crypto.randomUUID()}, ${h.userId}, 'friend', ${h.phone}, 'streak_ended',
        'Habit streak ended',
        ${JSON.stringify({ habitId: h.habitId, habitName: h.name, streak, lastDate, tz })}::jsonb,
        'pending', now())
      ON CONFLICT (user_id, persona, kind) DO NOTHING
    `
    armed++
  }
  if (armed) console.log(`[loops] streak_ended armed: ${armed}`)
  return armed
}

/** Backlog #48 and #80. Conservative overwork check: did the user clearly
 * work past 8pm today? We look at hire_habit_logs (date + a reasonable proxy
 * for evening entries is unavailable since date is just YYYY-MM-DD, so use
 * spend/workout/nutrition timestamps and last_touch on network rows), then
 * count touches after 20:00 local. Four or more distinct evening touches is
 * evidence. Otherwise no-op. */
export async function armOverworkCheckLoops(sql: SQL, now = new Date()): Promise<number> {
  const rows = (await sql`
    SELECT u.id AS "userId", u.timezone, u.phone_e164 AS phone
    FROM hire_users u
    WHERE u.phone_e164 IS NOT NULL
  `) as Array<{ userId: string; timezone: string | null; phone: string }>
  let armed = 0
  for (const u of rows) {
    const tz = loopTimezone(u.timezone)
    const todayYmd = localWall(tz, now).ymd
    const eight = wallTimeToUtc(todayYmd, 20, 0, tz)
    const probe = (await sql`
      SELECT
        (SELECT count(*)::int FROM hire_spending
            WHERE user_id = ${u.userId} AND spent_at >= ${eight.toISOString()}::timestamptz) AS spend_n,
        (SELECT count(*)::int FROM hire_workouts
            WHERE user_id = ${u.userId} AND logged_at >= ${eight.toISOString()}::timestamptz) AS workout_n,
        (SELECT count(*)::int FROM hire_nutrition_logs
            WHERE user_id = ${u.userId} AND eaten_at >= ${eight.toISOString()}::timestamptz) AS nutrition_n,
        (SELECT count(*)::int FROM hire_network
            WHERE user_id = ${u.userId} AND last_touch >= ${eight.toISOString()}::timestamptz) AS network_n,
        (SELECT max(last_inbound_at)::text FROM hire_roster
            WHERE user_id = ${u.userId} AND last_inbound_at >= ${eight.toISOString()}::timestamptz) AS inbound_max
    `) as Array<{
      spend_n: number
      workout_n: number
      nutrition_n: number
      network_n: number
      inbound_max: string | null
    }>
    const p = probe[0]
    if (!p) continue
    const touches =
      (p.spend_n || 0) + (p.workout_n || 0) + (p.nutrition_n || 0) + (p.network_n || 0)
    const hasEveningInbound = !!p.inbound_max
    const triggered = touches >= 4 || hasEveningInbound
    if (!triggered) continue
    const marker = todayYmd
    const existing = (await sql`
      SELECT status, last_result AS "lastResult"
      FROM hire_task_loops
      WHERE user_id = ${u.userId} AND persona = 'friend' AND kind = 'overwork_check'
      LIMIT 1
    `) as Array<{ status: string; lastResult: string | null }>
    const row = existing[0]
    if (row) {
      if (row.status === 'pending' || row.status === 'running') continue
      if (row.status === 'done' && row.lastResult?.includes(marker)) continue
      await sql`
        UPDATE hire_task_loops SET
          title = 'Overwork check',
          payload = ${JSON.stringify({ date: todayYmd, touches, tz })}::jsonb,
          status = 'pending',
          attempts = 0,
          last_result = NULL,
          next_run = now(),
          updated_at = now()
        WHERE id = (SELECT id FROM hire_task_loops
          WHERE user_id = ${u.userId} AND persona = 'friend' AND kind = 'overwork_check' LIMIT 1)
      `
      armed++
      continue
    }
    await sql`
      INSERT INTO hire_task_loops (id, user_id, persona, phone_e164, kind, title, payload, status, next_run)
      VALUES (${crypto.randomUUID()}, ${u.userId}, 'friend', ${u.phone}, 'overwork_check',
        'Overwork check',
        ${JSON.stringify({ date: todayYmd, touches, tz })}::jsonb,
        'pending', now())
      ON CONFLICT (user_id, persona, kind) DO NOTHING
    `
    armed++
  }
  if (armed) console.log(`[loops] overwork_check armed: ${armed}`)
  return armed
}

/** Backlog #93. Cross-domain quiet check (every ~3 days). No inbound in last 3
 * days, no habit/nutrition/workout/spend logs in last 3 days, but the user
 * was previously active (older inbound exists). Arm at most once per window. */
export async function armQuietCheckLoops(sql: SQL, now = new Date()): Promise<number> {
  const rows = (await sql`
    SELECT u.id AS "userId", u.timezone, u.phone_e164 AS phone
    FROM hire_users u
    WHERE u.phone_e164 IS NOT NULL
  `) as Array<{ userId: string; timezone: string | null; phone: string }>
  let armed = 0
  for (const u of rows) {
    const tz = loopTimezone(u.timezone)
    const todayYmd = localWall(tz, now).ymd
    const threeAgo = shiftDateStr(todayYmd, -3)
    const probe = (await sql`
      SELECT
        (SELECT max(last_inbound_at)::text FROM hire_roster
            WHERE user_id = ${u.userId}) AS "inboundMax",
        (SELECT count(*)::int FROM hire_habit_logs
            WHERE user_id = ${u.userId} AND date >= ${threeAgo}) AS habits_n,
        (SELECT count(*)::int FROM hire_nutrition_logs
            WHERE user_id = ${u.userId} AND eaten_at::date >= ${threeAgo}) AS nutrition_n,
        (SELECT count(*)::int FROM hire_workouts
            WHERE user_id = ${u.userId} AND logged_at::date >= ${threeAgo}) AS workouts_n,
        (SELECT count(*)::int FROM hire_spending
            WHERE user_id = ${u.userId} AND spent_at::date >= ${threeAgo}) AS spend_n
    `) as Array<{
      inboundMax: string | null
      habits_n: number
      nutrition_n: number
      workouts_n: number
      spend_n: number
    }>
    const p = probe[0]
    if (!p) continue
    const inboundMax = p.inboundMax ? new Date(p.inboundMax) : null
    if (!inboundMax || Number.isNaN(inboundMax.getTime())) continue
    const nowMs = now.getTime()
    const threeDaysMs = 3 * 24 * 60 * 60 * 1000
    const inboundRecent = nowMs - inboundMax.getTime() <= threeDaysMs
    if (inboundRecent) continue
    const logTotal =
      (p.habits_n || 0) + (p.nutrition_n || 0) + (p.workouts_n || 0) + (p.spend_n || 0)
    if (logTotal > 0) continue
    const marker = threeAgo
    const existing = (await sql`
      SELECT status, last_result AS "lastResult", payload
      FROM hire_task_loops
      WHERE user_id = ${u.userId} AND persona = 'friend' AND kind = 'quiet_check'
      LIMIT 1
    `) as Array<{ status: string; lastResult: string | null; payload: unknown }>
    const row = existing[0]
    if (row) {
      if (row.status === 'pending' || row.status === 'running') continue
      if (row.status === 'done' && row.lastResult?.includes(marker)) continue
      await sql`
        UPDATE hire_task_loops SET
          title = 'Cross-domain quiet check',
          payload = ${JSON.stringify({ windowStart: threeAgo, tz })}::jsonb,
          status = 'pending',
          attempts = 0,
          last_result = NULL,
          next_run = now(),
          updated_at = now()
        WHERE id = (SELECT id FROM hire_task_loops
          WHERE user_id = ${u.userId} AND persona = 'friend' AND kind = 'quiet_check' LIMIT 1)
      `
      armed++
      continue
    }
    await sql`
      INSERT INTO hire_task_loops (id, user_id, persona, phone_e164, kind, title, payload, status, next_run)
      VALUES (${crypto.randomUUID()}, ${u.userId}, 'friend', ${u.phone}, 'quiet_check',
        'Cross-domain quiet check',
        ${JSON.stringify({ windowStart: threeAgo, tz })}::jsonb,
        'pending', now())
      ON CONFLICT (user_id, persona, kind) DO NOTHING
    `
    armed++
  }
  if (armed) console.log(`[loops] quiet_check armed: ${armed}`)
  return armed
}

/** Day 1 check-in: one day after the first text lands, the same hire follows
 * up to hear how the first day went. Needs the phone-only account to exist so
 * the loop has an owner; a waitlist-only number that never signed up is skipped. */
export async function scheduleDay1Checkin(
  sql: SQL,
  phone: string,
  persona: Persona,
): Promise<void> {
  const e164 = normalizePhone(phone)
  if (!e164) return
  const rows = (await sql`
    SELECT id FROM hire_users WHERE phone_e164 = ${e164} LIMIT 1
  `) as Array<{ id: string }>
  const userId = rows[0]?.id
  if (!userId) return
  await sql`
    INSERT INTO hire_task_loops (id, user_id, persona, phone_e164, kind, title, payload, status, next_run)
    VALUES (${crypto.randomUUID()}, ${userId}, ${persona}, ${e164}, 'day1_checkin',
      'Check how the first day went', '{}'::jsonb, 'pending',
      ${new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString()})
    ON CONFLICT (user_id, persona, kind) DO NOTHING
  `
}

/** Hand due loops for one persona to the bot that owns the line, same claim
 * protocol as the intro queue: attempts bump on claim, claims stuck in
 * 'running' past the reset window go back to pending on the next pass.
 *
 * Browser-run reports live in their own per-job table (a run's report must not
 * be overwritten by the next run before it is sent) but are handed to the bot
 * with the same shape and kind, so dispatch is unchanged. They are claimed
 * first: that message is the one the person is actively waiting on. */
export async function claimDueLoops(
  sql: SQL,
  persona: Persona,
  limit: number,
): Promise<
  Array<{
    id: string
    userId: string
    persona: Persona
    phone: string
    kind: string
    title: string
    payload: unknown
  }>
> {
  await sql`
    UPDATE hire_task_loops SET status = 'pending'
    WHERE status = 'running' AND updated_at < now() - interval '10 minutes'
  `
  await sql`
    UPDATE hire_browser_result_deliveries SET status = 'pending'
    WHERE status = 'running' AND updated_at < now() - interval '10 minutes'
  `
  // A promise completed from the Promises card retires its pending rescue.
  // The open loop remains the source of truth, so stale nudges cannot fire.
  await sql`
    UPDATE hire_task_loops t SET status = 'done', last_result = 'commitment already closed', updated_at = now()
    WHERE t.persona = ${persona} AND t.status = 'pending' AND t.kind LIKE 'commitment_rescue:%'
      AND NOT EXISTS (
        SELECT 1 FROM hire_loops l
        WHERE l.id = t.payload->>'loopId' AND l.user_id = t.user_id AND l.status = 'open'
      )
  `
  const deliveries = (await sql`
    UPDATE hire_browser_result_deliveries SET status = 'running', attempts = attempts + 1, updated_at = now()
    WHERE id IN (
      SELECT id FROM hire_browser_result_deliveries
      WHERE persona = ${persona} AND status = 'pending' AND attempts < ${TASK_LOOP_MAX_ATTEMPTS}
        AND (next_run IS NULL OR next_run <= now())
      ORDER BY next_run
      LIMIT ${limit}
      FOR UPDATE SKIP LOCKED
    )
    RETURNING id, user_id AS "userId", persona, phone_e164 AS phone, 'browser_result' AS kind,
      'Browser run result' AS title, payload
  `) as Array<{
    id: string
    userId: string
    persona: Persona
    phone: string
    kind: string
    title: string
    payload: unknown
  }>
  const remaining = Math.max(0, limit - deliveries.length)
  const rows =
    remaining === 0
      ? []
      : ((await sql`
    UPDATE hire_task_loops SET status = 'running', updated_at = now()
    WHERE id IN (
      SELECT id FROM hire_task_loops
      WHERE persona = ${persona} AND status = 'pending' AND attempts < ${TASK_LOOP_MAX_ATTEMPTS}
        AND (next_run IS NULL OR next_run <= now())
      ORDER BY next_run
      LIMIT ${remaining}
      FOR UPDATE SKIP LOCKED
    )
    RETURNING id, user_id AS "userId", persona, phone_e164 AS phone, kind, title, payload
  `) as Array<{
          id: string
          userId: string
          persona: Persona
          phone: string
          kind: string
          title: string
          payload: unknown
        }>)
  return [...deliveries, ...rows]
}

/** A claimed loop reports back: done ends it, a failure burns one of the five
 * attempts before parking as terminal, a snooze sets the next run. A claimed
 * browser delivery carries an id from its own table, so the first update that
 * matches no loop row falls through to it. */
export async function finishTaskLoop(
  sql: SQL,
  id: string,
  outcome: 'done' | 'failed' | 'snoozed',
  note?: string,
  nextRun?: string | null,
  payload?: Record<string, unknown>,
): Promise<void> {
  const result = String(note || '').slice(0, 500)
  const target = async (
    loops: () => Promise<unknown>,
    deliveries: () => Promise<unknown>,
  ): Promise<void> => {
    const rows = (await loops()) as Array<{ id?: string }>
    if (Array.isArray(rows) && rows.length === 0) await deliveries()
  }
  if (outcome === 'done') {
    await target(
      () => sql`
        UPDATE hire_task_loops SET status = 'done', last_result = ${result},
          payload = COALESCE(${payload ? JSON.stringify(payload) : null}::jsonb, payload), updated_at = now()
        WHERE id = ${id} RETURNING id
      `,
      () => sql`
        UPDATE hire_browser_result_deliveries SET status = 'done', last_result = ${result}, updated_at = now()
        WHERE id = ${id}
      `,
    )
    return
  }
  if (outcome === 'failed') {
    await target(
      () => sql`
        UPDATE hire_task_loops SET
          status = CASE WHEN attempts + 1 < ${TASK_LOOP_MAX_ATTEMPTS} THEN 'pending' ELSE 'failed' END,
          attempts = attempts + 1,
          last_result = ${result},
          updated_at = now()
        WHERE id = ${id} RETURNING id
      `,
      () => sql`
        UPDATE hire_browser_result_deliveries SET
          status = 'pending',
          attempts = attempts + 1,
          next_run = now() + (LEAST(POWER(2, LEAST(attempts + 1, 6)), 36) * interval '10 minutes'),
          last_result = ${result},
          updated_at = now()
        WHERE id = ${id}
      `,
    )
    return
  }
  const when = new Date(String(nextRun || ''))
  const snoozedTo = Number.isNaN(when.getTime())
    ? new Date(Date.now() + 60 * 60 * 1000).toISOString()
    : when.toISOString()
  await target(
    () => sql`
      UPDATE hire_task_loops SET status = 'pending', next_run = ${snoozedTo}, last_result = ${result},
        payload = COALESCE(${payload ? JSON.stringify(payload) : null}::jsonb, payload), updated_at = now()
      WHERE id = ${id} RETURNING id
    `,
    () => sql`
      UPDATE hire_browser_result_deliveries SET status = 'pending', next_run = ${snoozedTo}, last_result = ${result}, updated_at = now()
      WHERE id = ${id}
    `,
  )
}
