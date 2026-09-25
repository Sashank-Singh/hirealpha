import type { SQL } from 'bun'
import { json, jsonRevalidated, appBase } from '../utils/http'
import { normalizePhone } from '../utils/phone'
import { getUserByPhone, getUserByEmail } from '../db/users'
import { resolveAuthedUser, verifyMiniToken } from '../auth/session'
import { isPersona, type Persona } from '../personas'
import {
  localDateStrInTz,
  nextLocalTimeUtc,
  nextReminderAt,
  pickUserTimezone,
} from '../timezones'
import {
  readBriefDb,
  briefRowSameDay,
} from '../briefs/judgment'
import { loadContext } from '../db/context'
import { buildMeetingPrep } from '../work/prep'
import { listLinearIssues } from '../work/stack'
import { detectChangeResponses } from '../../services/tasks/changeResponse'
import type { StaleRead } from '../staleCache'

export interface BriefLoadResult<T> {
  payload: T
  throttled: boolean
  used?: number
  limit?: number
}

const DIGEST_BRIEF_TEXT = '[digest]Daily brief'
const JUDGE_MARKER = '[judge]'
const BRIEF_WARM_WAIT_MS = 60_000

export interface DigestRouteOptions {
  internalOk: (req: Request) => boolean
  connectedForUser: (sql: SQL, userId: string) => Promise<string[]>
  digestPayload: (sql: SQL, user: any, persona: any) => Promise<any>
  miniPayload: (sql: SQL, user: any, persona: any, kind: any) => Promise<any>
  cofounderDigest: (sql: SQL, userId: string, persona: string) => Promise<any>
  digestCache: {
    read: (key: string, loader: () => Promise<any>, waitMs?: number) => Promise<StaleRead<any>>
    drop: (key: string) => void
  }
  eveningCache: {
    read: (key: string, loader: () => Promise<any>, waitMs?: number) => Promise<StaleRead<any>>
    drop: (key: string) => void
  }
  todayMeetsCache: {
    read: (key: string, loader: () => Promise<any>, waitMs?: number) => Promise<StaleRead<any>>
    drop: (key: string) => void
  }
  briefLoader: <T>(
    sql: SQL,
    userId: string,
    persona: string,
    kind: string,
    build: () => Promise<T>,
    day: string,
    opts?: { force?: boolean },
  ) => Promise<BriefLoadResult<T>>
  prewarmHomeWorld: (sql: SQL, user: { id: string; name?: string | null; timezone: string | null }, tzLocal: string) => void
  armPokes: (sql: SQL, user: any, persona: Persona, context: Record<string, string>) => Promise<void>
  ensureJudgeTick: (
    sql: SQL,
    userId: string,
    persona: Persona,
    text: string,
    scheduledAt: string,
    recurrence: 'daily' | 'weekly',
    timezone: string,
  ) => Promise<void>
  judgmentStatePayload: (sql: SQL, user: any, persona: Persona, tick: string) => Promise<any>
}

export async function handleDigestRoutes(
  req: Request,
  sql: SQL,
  options: DigestRouteOptions,
): Promise<Response | null> {
  const url = new URL(req.url)
  const path = url.pathname

  if (path === '/api/digest' && req.method === 'GET') {
    const t = url.searchParams.get('t') || ''
    const email = String(url.searchParams.get('email') || '')
      .trim()
      .toLowerCase()
    const persona = url.searchParams.get('persona') || ''
    if (!isPersona(persona)) return json({ error: 'persona required' }, 400)
    let user: { id: string; email: string; name: string | null; timezone: string | null; phone: string | null } | null = null
    if (t) {
      const tok = verifyMiniToken(t)
      if (!tok || tok.persona !== persona) {
        return json({ error: 'This link expired. Sign in to keep using it.', code: 'token_invalid' }, 401)
      }
      user = await getUserByPhone(sql, tok.phone)
    } else if (email.includes('@')) {
      user = await getUserByEmail(sql, email)
    } else {
      return json({ error: 'email required' }, 400)
    }
    if (!user) return json({ error: 'No account found for that phone/email' }, 404)
    try {
      const day = localDateStrInTz(new Date(), user.timezone || 'America/Los_Angeles')
      /* A user tapping the brief's refresh button sends `_t=<now>`. The cache
       * buster makes the browser skip its SWR, but the server still has its own
       * short-TTL in-memory cache and a persisted row keyed by user+persona+kind
       * that could be reused. `force` propagates through every layer so the
       * answer that comes back is a real rebuild against the live calendar /
       * inbox / model — the answer a "refresh" button is supposed to mean.
       *
       * The in-memory layer must drop its row too: otherwise the 90s window
       * can hand back yesterday's payload even after the loader has the new
       * one in hand. */
      const force = url.searchParams.has('_t')
      if (force) {
        options.digestCache.drop(`${user.id}|${persona}`)
        options.todayMeetsCache.drop(`${user.id}|${persona}`)
        /* The judgment is part of what "Try again" promises to refresh. Without
         * dropping it, mail that arrived since the last judge run can never
         * reach Needs Reply: leads are built only from judged verdicts, and the
         * regex supplement runs only when there are zero leads. */
        await sql`DELETE FROM hire_judge_cache WHERE user_id = ${user.id}`.catch(() => undefined)
      }
      const dbRow = await readBriefDb(sql, user.id, persona, 'digest')
      const sameDayCached = !force && dbRow && briefRowSameDay(dbRow.day, day) ? dbRow : null

      const brief = await options.digestCache.read(`${user.id}|${persona}`, () =>
        options.briefLoader(
          sql,
          user.id,
          persona,
          'digest',
          () => options.digestPayload(sql, user, persona),
          day,
          { force },
        ),
        /* A same-day row means the brief was already built — at send time, or on
         * any earlier open today. Waiting 4s for a rebuild before serving it is
         * four seconds of spinner for data the user already owns; hand the row
         * back at once and let the rebuild land behind it instead. */
        sameDayCached ? 0 : force ? 6000 : 4000,
      )
      if (!brief.value && brief.pending) {
        if (sameDayCached) {
          return jsonRevalidated(req, 0, {
            ...sameDayCached.payload,
            /* `pending` is the only field the client's retry ladder reads
             * (MiniAppPage keys on it); `revalidating` was set here and
             * consumed nowhere, so every open showed the previous build — which
             * can be hours old — and the fresh one only appeared on a later
             * open. Both are set now: the row is handed back immediately, and
             * the ladder knows a rebuild is in flight behind it. */
            revalidating: true,
            pending: true,
            cardUrl: `${appBase(req)}/app/mini/${persona}/digest`,
          })
        }
        /* Not an error — the load is still running behind this response and will
         * be in the cache shortly. Saying `error` here made the client stop and
         * tell the user to reopen the screen by hand; `pending` alone lets it
         * come back on its own. Never cached, or the retry reads this. */
        return json({ pending: true, note: 'Pulling your day together.' }, 200)
      }
      if (!brief.value) {
        if (sameDayCached) {
          return jsonRevalidated(req, 0, {
            ...sameDayCached.payload,
            cardUrl: `${appBase(req)}/app/mini/${persona}/digest`,
          })
        }
        throw new Error('digest payload unavailable')
      }
      const load = brief.value
      // A stale hit refreshing behind the response must not be served from the
      // browser cache on the next open, or the refresh would never be seen.
      // The `limited` flag tells the client that the rationing path served a
      // stale-but-same-day row on purpose — the brief still paints (the data is
      // real, just not rebuilt on this tap) but the user gets a "refreshes
      // used up" line at the top so they know to upgrade.
      const tzWarm = user.timezone || 'America/Los_Angeles'
      options.prewarmHomeWorld(sql, user, tzWarm)
      return jsonRevalidated(req, brief.pending ? 0 : 60, {
        ...load.payload,
        limited: load.throttled || undefined,
        used: load.used,
        limit: load.limit,
        cardUrl: `${appBase(req)}/app/mini/${persona}/digest`,
      })
    } catch (err) {
      console.warn('[digest] payload failed', err)
      const tz = user.timezone || 'America/Los_Angeles'
      const date = new Date().toLocaleDateString('en-US', {
        weekday: 'long',
        month: 'long',
        day: 'numeric',
        timeZone: tz,
      })
      return json({
        date,
        calendar: [],
        meetings: [],
        attention: null,
        emails: [],
        reminders: [],
        loops: [],
        tomorrow: [],
        text: `${date}. Calendar and mail did not load. Open again in a minute.`,
        cardUrl: `${appBase(req)}/app/mini/${persona}/digest`,
      })
    }
  }

  /* Set the daily brief time: upserts the [digest] daily reminder at the chosen
   * local hour (defaults to 8:00) and re-arms the judge morning tick to match. */
  if (path === '/api/digest/time' && req.method === 'PUT') {
    const body = (await req.json().catch(() => ({}))) as {
      email?: string
      token?: string
      session?: string
      persona?: string
      time?: string
    }
    const persona = body.persona || ''
    if (!isPersona(persona)) return json({ error: 'persona required' }, 400)
    const { user, error } = await resolveAuthedUser(sql, { token: body.token, session: (body as { session?: string }).session, email: body.email })
    if (error) return error
    const tz = user!.timezone || 'America/Los_Angeles'
    const m = String(body.time || '').match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/i)
    if (!m) return json({ error: 'time must be like 8:00, 8am, or 19:30' }, 400)
    let h = Number(m[1])
    const min = m[2] ? Number(m[2]) : 0
    const ap = (m[3] || '').toLowerCase()
    if (ap === 'pm' && h < 12) h += 12
    if (ap === 'am' && h === 12) h = 0
    if (h > 23 || min > 59) return json({ error: 'time out of range' }, 400)
    const existing = await sql`
      SELECT id FROM hire_reminders
      WHERE user_id = ${user!.id} AND persona = ${persona} AND recurrence = 'daily'
        AND text LIKE '[digest]%' LIMIT 1
    `
    if (existing[0]) {
      await sql`
        UPDATE hire_reminders SET scheduled_at = ${nextLocalTimeUtc(tz, h, min)}, timezone = ${tz},
          status = 'pending', updated_at = now()
        WHERE id = ${(existing[0] as { id: string }).id}
      `
    } else {
      await sql`
        INSERT INTO hire_reminders (id, user_id, persona, text, scheduled_at, recurrence, timezone, status)
        VALUES (${crypto.randomUUID()}, ${user!.id}, ${persona}, ${DIGEST_BRIEF_TEXT},
          ${nextLocalTimeUtc(tz, h, min)}, 'daily', ${tz}, 'pending')
      `
    }
    // A digest row at a chosen hour supersedes the default judge morning tick;
    // leaving both would fire two briefs now that both are unconditional.
    await sql`
      DELETE FROM hire_reminders
      WHERE user_id = ${user!.id} AND persona = ${persona} AND text = ${JUDGE_MARKER + 'morning'}
    `
    return json({ ok: true, time: `${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}` })
  }

  /* Set the evening brief time: re-arms the judge evening tick (pick_night) at
   * the chosen local hour (defaults to 21:00) so Alpha text the wrap at night. */
  if (path === '/api/evening/time' && req.method === 'PUT') {
    const body = (await req.json().catch(() => ({}))) as {
      email?: string
      token?: string
      session?: string
      persona?: string
      time?: string
    }
    const persona = body.persona || ''
    if (!isPersona(persona)) return json({ error: 'persona required' }, 400)
    const { user, error } = await resolveAuthedUser(sql, { token: body.token, session: (body as { session?: string }).session, email: body.email })
    if (error) return error
    const tz = user!.timezone || 'America/Los_Angeles'
    const m = String(body.time || '').match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/i)
    if (!m) return json({ error: 'time must be like 21:00, 9pm, or 08:30' }, 400)
    let h = Number(m[1])
    const min = m[2] ? Number(m[2]) : 0
    const ap = (m[3] || '').toLowerCase()
    if (ap === 'pm' && h < 12) h += 12
    if (ap === 'am' && h === 12) h = 0
    if (h > 23 || min > 59) return json({ error: 'time out of range' }, 400)
    await options.ensureJudgeTick(sql, user!.id, persona, `${JUDGE_MARKER}evening`, nextLocalTimeUtc(tz, h, min), 'daily', tz)
    return json({ ok: true, time: `${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}` })
  }

  /* Cofounder digest: the staleness pass the bot reads before it says anything. */
  if (path === '/api/internal/cofounder/digest' && req.method === 'GET') {
    if (!options.internalOk(req)) return json({ error: 'Unauthorized' }, 401)
    const persona = url.searchParams.get('persona') || ''
    const phone = normalizePhone(url.searchParams.get('phone') || '')
    if (!isPersona(persona) || !phone) return json({ error: 'persona and phone required' }, 400)
    const user = await getUserByPhone(sql, phone)
    if (!user) return json({ error: 'User not found' }, 404)
    return json(await options.cofounderDigest(sql, user.id, persona))
  }

  /* Coworker digest: the shared staleness pass plus the live day view. */
  /* Who this persona serves. The Pro daily loops poll a per-user digest, but
   * the bots started them without a phone and the digest route requires one —
   * so every poll returned 400 and the coworker/cofounder daily digest had
   * never fired for anyone. A loop now asks for its users first. */
  if (path === '/api/internal/persona/users' && req.method === 'GET') {
    if (!options.internalOk(req)) return json({ error: 'Unauthorized' }, 401)
    const persona = url.searchParams.get('persona') || ''
    if (!isPersona(persona)) return json({ error: 'persona required' }, 400)
    const rows = (await sql`
      SELECT u.phone_e164 AS phone, u.timezone
      FROM hire_roster r
      JOIN hire_users u ON u.id = r.user_id
      WHERE r.persona = ${persona} AND u.phone_e164 IS NOT NULL AND u.phone_e164 <> ''
      ORDER BY u.created_at ASC
      LIMIT 500
    `) as Array<{ phone: string; timezone: string | null }>
    return json({ users: rows.map((r) => ({ phone: r.phone, timezone: r.timezone || 'America/Los_Angeles' })) })
  }

  if (path === '/api/internal/coworker/digest' && req.method === 'GET') {
    if (!options.internalOk(req)) return json({ error: 'Unauthorized' }, 401)
    const phone = normalizePhone(url.searchParams.get('phone') || '')
    if (!phone) return json({ error: 'phone required' }, 400)
    const user = await getUserByPhone(sql, phone)
    if (!user) return json({ error: 'User not found' }, 404)
    const tz = pickUserTimezone({ userTz: user.timezone })
    const connected = await options.connectedForUser(sql, user.id)
    const [base, waiting, standup, prep, linear] = await Promise.all([
      options.cofounderDigest(sql, user.id, 'coworker'),
      sql`SELECT count(*)::int AS n FROM hire_drafts WHERE user_id = ${user.id} AND status = 'pending'`,
      sql`SELECT id FROM hire_standups WHERE user_id = ${user.id} AND day = ${localDateStrInTz(new Date(), tz)} LIMIT 1`,
      buildMeetingPrep(sql, user),
      connected.includes('linear')
        ? listLinearIssues(user.id).catch(() => ({ issues: [], needConnect: false }))
        : Promise.resolve({ issues: [], needConnect: true }),
    ])
    const changeResponses = detectChangeResponses({
      now: new Date(),
      issues: (linear.issues as Array<{ id: string; title: string; state?: string; dueAt?: string }>)
        .flatMap((issue) => {
          const dueAt = 'dueAt' in issue ? issue.dueAt : undefined
          return dueAt ? [{
          id: issue.id,
          title: issue.title,
          dueAt,
          state: /done|complete/i.test(issue.state || '')
            ? 'completed' as const
            : /cancel/i.test(issue.state || '')
              ? 'cancelled' as const
              : /progress|started/i.test(issue.state || '')
                ? 'started' as const
                : 'backlog' as const,
          importance: /urgent/i.test(`${issue.title} ${issue.state}`) ? 1 : 0.7,
        }] : []
        }),
    }).slice(0, 3).map((item) => ({
      kind: item.kind,
      entityKey: item.entityKey.slice(0, 180),
      title: item.title.slice(0, 120),
      reason: item.reason.slice(0, 180),
      proposedAction: item.proposedAction.slice(0, 120),
      score: item.score,
    }))
    return json({
      ...base,
      nextMeeting: prep.event
        ? {
            ...prep.event,
            // The proactive channel only needs proof that preparation exists.
            // Keep subject/snippet/Gmail ids inside authenticated Meeting mode.
            prep: {
              agendaCount: Math.min(9, prep.prep.agenda.length),
              hasLastThread: Boolean(prep.prep.lastThread),
            },
          }
        : null,
      draftsWaiting: Number((waiting[0] as { n?: number } | undefined)?.n || 0),
      standupReady: !standup[0],
      changeResponses,
    })
  }

  if (path === '/api/internal/digest' && req.method === 'GET') {
    if (!options.internalOk(req)) return json({ error: 'Unauthorized' }, 401)
    const phone = url.searchParams.get('phone') || ''
    const persona = url.searchParams.get('persona') || ''
    if (!phone || !isPersona(persona)) return json({ error: 'phone and persona required' }, 400)
    const user = await getUserByPhone(sql, phone)
    if (!user) return json({ error: 'User not found' }, 404)
    /* The card this text carries must already have its brief on the server when
     * the tap lands. Building through briefLoader (not a bare payload) is what
     * makes that true: it persists the row to hire_brief_cache, so the open
     * serves instantly even after this process has restarted and its in-memory
     * cache is gone. The kind warmed is the kind the card opens — the evening
     * wrap used to pre-build only the morning shape and leave the evening brief
     * to build cold in front of the user. The text still comes from the digest
     * payload for both (the evening payload carries no text line), so the
     * evening warm runs beside it rather than instead of it. */
    const tzWarm = user.timezone || 'America/Los_Angeles'
    const hour = Number(
      new Date().toLocaleString('en-US', { hour: 'numeric', hour12: false, timeZone: tzWarm }),
    )
    const briefKind = hour >= 16 ? 'pick_night' : 'digest'
    const day = localDateStrInTz(new Date(), tzWarm)
    const eveningWarm =
      briefKind === 'pick_night'
        ? options.eveningCache
            .read(
              `${user.id}|${persona}`,
              () =>
                options.briefLoader(
                  sql,
                  user.id,
                  persona,
                  'pick_night',
                  () => options.miniPayload(sql, user, persona, 'pick_night'),
                  day,
                ),
              BRIEF_WARM_WAIT_MS,
            )
            .catch(() => null)
        : null
    const payload = (await options.digestCache.read(
      `${user.id}|${persona}`,
      () => options.briefLoader(sql, user.id, persona, 'digest', () => options.digestPayload(sql, user, persona), day),
      BRIEF_WARM_WAIT_MS,
    )).value?.payload
    if (!payload) return json({ error: 'Could not build the brief' }, 502)
    await eveningWarm
    // The card the bot texts must match the hour: the 21:00 evening wrap opens
    // the evening brief screen, not the morning one.
    options.prewarmHomeWorld(sql, user, tzWarm)
    return json({
      ...payload,
      briefKind,
      cardUrl: `${appBase(req)}/app/mini/${persona}/${briefKind}`,
    })
  }

  if (path === '/api/internal/judgment-state' && req.method === 'GET') {
    if (!options.internalOk(req)) return json({ error: 'Unauthorized' }, 401)
    const phone = url.searchParams.get('phone') || ''
    const persona = url.searchParams.get('persona') || ''
    const tick = url.searchParams.get('tick') || 'judge'
    if (!phone || !isPersona(persona)) return json({ error: 'phone and persona required' }, 400)
    const user = await getUserByPhone(sql, phone)
    if (!user) return json({ error: 'User not found' }, 404)
    const context = await loadContext(sql, user.id, persona)
    await options.armPokes(sql, user, persona, context)
    const payload = await options.judgmentStatePayload(sql, user, persona, tick)
    return json(payload)
  }

  /* Why are briefs (not) firing? One call: every reminder row for this
   * persona plus the exact judgment state the bot's guards evaluate. */
  if (path === '/api/internal/brief-debug' && req.method === 'GET') {
    if (!options.internalOk(req)) return json({ error: 'Unauthorized' }, 401)
    const phone = url.searchParams.get('phone') || ''
    const persona = url.searchParams.get('persona') || ''
    if (!phone || !isPersona(persona)) return json({ error: 'phone and persona required' }, 400)
    const user = await getUserByPhone(sql, phone)
    if (!user) return json({ error: 'User not found' }, 404)
    const reminders = await sql`
      SELECT text, status, recurrence, scheduled_at AS "scheduledAt", timezone
      FROM hire_reminders WHERE user_id = ${user.id} AND persona = ${persona}
      ORDER BY scheduled_at ASC LIMIT 12
    `
    let state: unknown = null
    try {
      state = await options.judgmentStatePayload(sql, user, persona, 'digest')
    } catch (err) {
      state = { error: String(err) }
    }
    return json({ reminders, state })
  }

  /* Chat-driven morning digest control. The wizard route (/api/digest/time)
   * needs a user session, so the bot literally had no way to honor "set my
   * weekday digest for 7am", "pause my digest", or "move it to 8". The bot
   * parses the ask with its intent parser and lands here. */
  if (path === '/api/internal/digest/manage' && req.method === 'POST') {
    if (!options.internalOk(req)) return json({ error: 'Unauthorized' }, 401)
    const body = (await req.json().catch(() => ({}))) as {
      phone?: string
      persona?: string
      action?: string
      time?: string
      recurrence?: string
      label?: string
    }
    const persona = body.persona || ''
    const action = String(body.action || '').toLowerCase()
    if (!body.phone || !isPersona(persona) || !['set', 'pause', 'resume', 'status'].includes(action)) {
      return json({ error: 'phone, persona, and action set|pause|resume|status required' }, 400)
    }
    const user = await getUserByPhone(sql, body.phone)
    if (!user) return json({ error: 'User not found' }, 404)
    const tz = user.timezone || 'America/Los_Angeles'
    const digestRows = (await sql`
      SELECT id, text, scheduled_at AS "scheduledAt", recurrence, status
      FROM hire_reminders
      WHERE user_id = ${user.id} AND persona = ${persona} AND text LIKE '[digest]%'
      ORDER BY scheduled_at ASC
    `) as Array<{ id: string; text: string; scheduledAt: Date; recurrence: string; status: string }>

    const state = () =>
      json({
        ok: true,
        action,
        digest: digestRows.map((r) => ({
          id: r.id,
          text: r.text.replace(/^\[digest\]\s*/i, ''),
          scheduledAt: new Date(r.scheduledAt).toISOString(),
          recurrence: r.recurrence,
          status: r.status,
        })),
      })

    if (action === 'status') return state()

    if (action === 'pause') {
      if (!digestRows.length) return json({ ok: true, action, digest: [], note: 'no digest scheduled' })
      await sql`
        UPDATE hire_reminders SET status = 'paused', updated_at = now()
        WHERE user_id = ${user.id} AND persona = ${persona} AND text LIKE '[digest]%'
      `
      // The default [judge]morning tick carries the same brief. Pausing one
      // while the other stays armed means the "pause" did nothing tomorrow.
      await sql`
        DELETE FROM hire_reminders
        WHERE user_id = ${user.id} AND persona = ${persona} AND text = ${JUDGE_MARKER + 'morning'}
      `
      for (const r of digestRows) r.status = 'paused'
      return state()
    }

    if (action === 'resume') {
      const paused = digestRows.find((r) => r.status === 'paused') || digestRows[0]
      if (!paused) {
        // Nothing to resume: arm the product default so the promise is real.
        await sql`
          INSERT INTO hire_reminders (id, user_id, persona, text, scheduled_at, recurrence, timezone, status)
          VALUES (${crypto.randomUUID()}, ${user.id}, ${persona}, ${DIGEST_BRIEF_TEXT},
            ${nextLocalTimeUtc(tz, 8, 0)}, 'daily', ${tz}, 'pending')
        `
        return json({ ok: true, action, digest: [{ text: 'Daily brief', recurrence: 'daily', status: 'pending' }] })
      }
      // Keep the wall-clock time the person chose before the pause.
      const at = new Date(paused.scheduledAt)
      const hh = Number(
        new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', hour12: false }).format(at),
      )
      const mm = Number(
        new Intl.DateTimeFormat('en-US', { timeZone: tz, minute: 'numeric' }).format(at),
      )
      let nextAt = nextLocalTimeUtc(tz, hh, Number.isFinite(mm) ? mm : 0)
      for (let i = 0; i < 7 && /^weekdays$/.test(paused.recurrence); i++) {
        const dow = new Date(nextAt).toLocaleDateString('en-US', { timeZone: tz, weekday: 'short' })
        if (dow !== 'Sat' && dow !== 'Sun') break
        nextAt = nextReminderAt(nextAt, 'weekdays', tz)
      }
      await sql`
        UPDATE hire_reminders SET status = 'pending', scheduled_at = ${nextAt}, updated_at = now()
        WHERE id = ${paused.id}
      `
      return json({
        ok: true,
        action,
        digest: [{ id: paused.id, status: 'pending', scheduledAt: nextAt, recurrence: paused.recurrence }],
      })
    }

    // action === 'set'
    const m = String(body.time || '08:00').match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/i)
    if (!m) return json({ error: 'time must be like 7:00, 7am, or 19:30' }, 400)
    let h = Number(m[1])
    const min = m[2] ? Number(m[2]) : 0
    const ap = (m[3] || '').toLowerCase()
    if (ap === 'pm' && h < 12) h += 12
    if (ap === 'am' && h === 12) h = 0
    if (h > 23 || min > 59) return json({ error: 'time out of range' }, 400)
    const recurrence = body.recurrence === 'weekdays' || body.recurrence === 'weekly' ? body.recurrence : 'daily'
    const label = String(body.label || '').trim().slice(0, 120) || DIGEST_BRIEF_TEXT.slice('[digest]'.length)
    let at = nextLocalTimeUtc(tz, h, min)
    for (let i = 0; i < 7 && recurrence === 'weekdays'; i++) {
      const dow = new Date(at).toLocaleDateString('en-US', { timeZone: tz, weekday: 'short' })
      if (dow !== 'Sat' && dow !== 'Sun') break
      at = nextReminderAt(at, 'weekdays', tz)
    }
    await sql`
      DELETE FROM hire_reminders
      WHERE user_id = ${user.id} AND persona = ${persona} AND text LIKE '[digest]%'
    `
    await sql`
      INSERT INTO hire_reminders (id, user_id, persona, text, scheduled_at, recurrence, timezone, status)
      VALUES (${crypto.randomUUID()}, ${user.id}, ${persona}, ${`[digest]${label}`},
        ${at}, ${recurrence}, ${tz}, 'pending')
    `
    await sql`
      DELETE FROM hire_reminders
      WHERE user_id = ${user.id} AND persona = ${persona} AND text = ${JUDGE_MARKER + 'morning'}
    `
    return json({ ok: true, action, digest: [{ text: label, scheduledAt: at, recurrence, status: 'pending' }] })
  }

  return null
}
