import type { SQL } from 'bun'
import { json } from '../utils/http'
import { resolveAuthedUser } from '../auth/session'
import { isPersona, type Persona } from '../personas'
import { SKILLS } from '../../src/agents/skills'
import { loadContext, parseSetupField } from '../db/context'
import { saveMiniPrefs, type MiniPrefs } from '../habits/prefs'
import { nextLocalTimeUtc } from '../timezones'

const PERSONA_MINI_APPS: Record<Persona, string[]> = {
  friend: [...SKILLS.friend.miniApps, 'digest'].filter((k) => k !== 'artifact'),
  coworker: [...SKILLS.coworker.miniApps, 'digest'].filter((k) => k !== 'artifact'),
  cofounder: [...SKILLS.cofounder.miniApps, 'digest'].filter((k) => k !== 'artifact'),
}

const DIGEST_BRIEF_TEXT = '[digest]Daily brief'
const JUDGE_MARKER = '[judge]'

export async function handleSetupRoutes(req: Request, sql: SQL): Promise<Response | null> {
  const url = new URL(req.url)
  const path = url.pathname

  if (path === '/api/setup/status' && req.method === 'GET') {
    const persona = url.searchParams.get('persona') || ''
    if (!isPersona(persona)) return json({ error: 'persona required' }, 400)
    const { user, error } = await resolveAuthedUser(sql, {
      token: url.searchParams.get('t') || undefined,
      session: url.searchParams.get('s') || undefined,
      email: url.searchParams.get('email') || undefined,
    })
    if (error) return error
    const fields = await loadContext(sql, user!.id, persona)
    const setup = parseSetupField(fields.setup)
    let setupDone = fields.setup_done === 'true'
    // Auto-detect: the wizard's per-step writes land in their own tables even
    // when the final done-POST is lost (stale token, closed tab). When the
    // account carries nutrition goals + mini prefs + a person + a saved place,
    // the wizard ran — report done instead of re-trapping the user in it.
    if (!setupDone && persona === 'friend') {
      try {
        const proof = (await sql`
          SELECT
            (SELECT 1 FROM hire_nutrition_goals WHERE user_id = ${user!.id} LIMIT 1) AS goals,
            (SELECT 1 FROM hire_mini_prefs WHERE user_id = ${user!.id} LIMIT 1) AS prefs,
            (SELECT 1 FROM hire_network WHERE user_id = ${user!.id} LIMIT 1) AS people,
            (SELECT 1 FROM hire_user_locations WHERE user_id = ${user!.id} AND kind IN ('home','work') LIMIT 1) AS places
        `) as Array<{ goals?: unknown; prefs?: unknown; people?: unknown; places?: unknown }>
        const p = proof[0]
        // Two of four signals is enough proof the wizard ran: skipping a page
        // (home/work blank, no people added) must not re-trap an onboarded user.
        const signals = [p?.goals, p?.prefs, p?.people, p?.places].filter(Boolean).length
        if (p && signals >= 2) setupDone = true
      } catch {
        /* status stays not-done; the wizard is the safe default */
      }
    }
    /* Has Alpha actually texted this person yet?
     *
     * The Text Alpha screen tells them where to pick the conversation up, and
     * that sentence is only true if the welcome went out. The onboard_done loop
     * row is the record of it: queued at done:true, flipped to 'done' by the bot
     * after a send that succeeded. Anything else — queued but never sent, failed
     * on the way (a Photon target restriction, a cooling period), or never
     * queued at all — reports false, and the screen says so instead of claiming a
     * message that does not exist.
     *
     * Live, 2026-09-21: the founder finished onboarding and read "Alpha already
     * texted you" on a number Alpha is not permitted to send to ("Target not
     * allowed for this project" in the friend log). */
    let welcomed = false
    try {
      const rows = (await sql`
        SELECT 1 FROM hire_task_loops
        WHERE user_id = ${user!.id} AND persona = ${persona} AND kind = 'onboard_done' AND status = 'done'
        LIMIT 1
      `) as Array<unknown>
      welcomed = rows.length > 0
    } catch {
      /* Unknown reads as not-yet: the screen must not assert a text it cannot confirm. */
    }
    return json({ setup, setupDone, welcomed })
  }

  if (path === '/api/setup' && req.method === 'POST') {
    const body = (await req.json().catch(() => ({}))) as {
      email?: string
      token?: string
      persona?: string
      feature?: string
      features?: unknown
      done?: boolean
    }
    const persona = body.persona || ''
    if (!isPersona(persona)) return json({ error: 'persona required' }, 400)

    const requested = Array.isArray(body.features)
      ? body.features.map(String)
      : body.feature
        ? [body.feature]
        : []
    if (body.done !== true && requested.length === 0) {
      return json({ error: 'feature or features required' }, 400)
    }
    for (const f of requested) {
      if (!PERSONA_MINI_APPS[persona].includes(f)) {
        return json({ error: `Unknown feature for this hire: ${f}` }, 400)
      }
    }

    const { user, error } = await resolveAuthedUser(sql, { token: body.token, session: (body as { session?: string }).session, email: body.email })
    if (error) return error

    const fields = await loadContext(sql, user!.id, persona)
    const existing = parseSetupField(fields.setup)
    const next =
      body.done === true && requested.length > 0
        ? [...new Set(requested)]
        : body.done === true && requested.length === 0
          ? existing
          : [...new Set([...existing, ...requested])]
    const setupDone = body.done === true || fields.setup_done === 'true'
    const nextFields = { ...fields, setup: next, setup_done: setupDone }
    await sql`
      INSERT INTO hire_context (user_id, persona, fields, updated_at)
      VALUES (${user!.id}, ${persona}, ${nextFields}, now())
      ON CONFLICT (user_id, persona)
      DO UPDATE SET fields = ${nextFields}, updated_at = now()
    `

    if (next.includes('digest')) {
      const tz = user!.timezone || 'America/Los_Angeles'
      const existingReminder = await sql`
        SELECT id FROM hire_reminders
        WHERE user_id = ${user!.id} AND persona = ${persona} AND recurrence = 'daily'
          AND text LIKE '[digest]%' LIMIT 1
      `
      if (!existingReminder[0]) {
        await sql`
          INSERT INTO hire_reminders (id, user_id, persona, text, scheduled_at, recurrence, timezone, status)
          VALUES (${crypto.randomUUID()}, ${user!.id}, ${persona}, ${DIGEST_BRIEF_TEXT},
            ${nextLocalTimeUtc(tz, 8, 0)}, 'daily', ${tz}, 'pending')
        `
      }
      await sql`
        DELETE FROM hire_reminders
        WHERE user_id = ${user!.id} AND persona = ${persona} AND text = ${JUDGE_MARKER + 'morning'}
      `
    }

    // Setup finished: the friend bot texts one onboarding-complete welcome
    // (connected tools + Alpha Apps). Only fires once per (user, persona): the
    // unique index plus the WHERE NOT EXISTS guard means re-submitting done can
    // never queue a second row. next_run = now() so the bot sends it on its
    // very next claim pass, once the row exists under an account with a phone.
    if (body.done === true && persona === 'friend' && user!.phone) {
      await sql`
        INSERT INTO hire_task_loops (id, user_id, persona, phone_e164, kind, title, payload, status, next_run)
        VALUES (${crypto.randomUUID()}, ${user!.id}, ${persona}, ${user!.phone}, 'onboard_done',
          'Welcome Alpha to the connected setup', '{}'::jsonb, 'pending', now())
        WHERE NOT EXISTS (
          SELECT 1 FROM hire_task_loops
          WHERE user_id = ${user!.id} AND persona = ${persona} AND kind = 'onboard_done'
        )
      `
    }

    return json({ ok: true, features: requested, setup: next, setupDone })
  }

  /* Public mini-prefs write for the onboarding wizard: workout days and sleep
   * baseline. The bot-side path is /api/internal/prefs (text-parsed); this one
   * takes structured values straight from the setup card. */
  if (path === '/api/mini-prefs' && req.method === 'PUT') {
    const body = (await req.json().catch(() => ({}))) as {
      email?: string
      token?: string
      session?: string
      workoutPlace?: string
      workoutMoveCount?: number
      workoutDays?: number[]
      sleepBedtime?: string
      sleepWake?: string
      currentWeightLb?: number
      targetWeightLb?: number
      weightGoal?: string
    }
    const cookieSession = (req.headers.get('cookie') || '')
      .split(';')
      .map((v) => v.trim())
      .find((v) => v.startsWith('hirealpha_session='))
      ?.slice('hirealpha_session='.length)
    const { user, error } = await resolveAuthedUser(sql, {
      token: body.token,
      session: (body as { session?: string }).session || cookieSession || undefined,
      email: body.email,
    })
    if (error) return error
    const patch: Partial<MiniPrefs> = {}
    if (body.workoutPlace === 'home' || body.workoutPlace === 'gym') patch.workoutPlace = body.workoutPlace
    if (body.workoutMoveCount === 4 || body.workoutMoveCount === 5 || body.workoutMoveCount === 6) {
      patch.workoutMoveCount = body.workoutMoveCount
    }
    if (Array.isArray(body.workoutDays)) patch.workoutDays = body.workoutDays
    if (typeof body.sleepBedtime === 'string' && body.sleepBedtime.trim()) {
      patch.sleepBedtime = body.sleepBedtime.trim().slice(0, 5)
    }
    if (typeof body.sleepWake === 'string' && body.sleepWake.trim()) {
      patch.sleepWake = body.sleepWake.trim().slice(0, 5)
    }
    if (typeof (body as { currentWeightLb?: number }).currentWeightLb === 'number' && (body as { currentWeightLb?: number }).currentWeightLb! > 0) {
      patch.currentWeightLb = (body as { currentWeightLb?: number }).currentWeightLb
    }
    if (typeof (body as { targetWeightLb?: number }).targetWeightLb === 'number' && (body as { targetWeightLb?: number }).targetWeightLb! > 0) {
      patch.targetWeightLb = (body as { targetWeightLb?: number }).targetWeightLb
    }
    const wg = (body as { weightGoal?: string }).weightGoal
    if (wg === 'loss' || wg === 'gain' || wg === 'muscle') patch.weightGoal = wg
    if (!Object.keys(patch).length) {
      return json({ error: 'Nothing to update' }, 400)
    }
    const prefs = await saveMiniPrefs(sql, user!.id, patch)
    return json({ ok: true, workoutDays: prefs.workoutDays, sleepBedtime: prefs.sleepBedtime, sleepWake: prefs.sleepWake })
  }

  return null
}
