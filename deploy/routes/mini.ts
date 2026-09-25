import type { SQL } from 'bun'
import { isPersona, type Persona } from '../personas'
import { appBase, json, jsonRevalidated } from '../utils/http'
import { getUserByPhone, getUserByEmail } from '../db/users'
import { mintMiniToken, verifyMiniToken } from '../auth/session'
import { localDateStrInTz } from '../timezones'
import { readBriefDb, briefRowSameDay } from '../briefs/judgment'

export async function handleMiniRoutes(
  req: Request,
  sql: SQL,
  options: {
    internalOk: (r: Request) => boolean
    miniPayload: (sql: SQL, user: any, persona: Persona, kind: string) => Promise<any>
    eveningCache: {
      drop: (key: string) => void
      read: (key: string, fn: () => Promise<any>, ttlMs?: number) => Promise<any>
    }
    briefLoader: (
      sql: SQL,
      userId: string,
      persona: Persona,
      kind: string,
      load: () => Promise<any>,
      day: string,
      opts?: { force?: boolean },
    ) => Promise<any>
  },
): Promise<Response | null> {
  const url = new URL(req.url)
  const path = url.pathname

  if (path === '/api/internal/mini/run' && req.method === 'GET') {
    if (!options.internalOk(req)) return json({ error: 'Unauthorized' }, 401)
    const phone = url.searchParams.get('phone') || ''
    const persona = url.searchParams.get('persona') || ''
    const kind = url.searchParams.get('kind') || ''
    if (!phone || !isPersona(persona) || !kind) {
      return json({ error: 'phone, persona, and kind required' }, 400)
    }
    const user = await getUserByPhone(sql, phone)
    if (!user) return json({ error: 'User not found' }, 404)
    return json(await options.miniPayload(sql, user, persona as Persona, kind))
  }

  if (path === '/api/internal/mini/token' && req.method === 'GET') {
    if (!options.internalOk(req)) return json({ error: 'Unauthorized' }, 401)
    const phone = url.searchParams.get('phone') || ''
    const persona = url.searchParams.get('persona') || ''
    const kind = url.searchParams.get('kind') || ''
    if (!phone || !isPersona(persona) || !kind) {
      return json({ error: 'phone, persona, and kind required' }, 400)
    }
    const user = await getUserByPhone(sql, phone)
    if (!user) return json({ error: 'User not found' }, 404)
    const token = mintMiniToken(phone, persona as Persona, kind)
    if (!token) return json({ error: 'Mini tokens not configured' }, 503)
    return json({ token, url: `${appBase(req)}/app/mini/${persona}/${kind}?t=${token}` })
  }

  if (path === '/api/mini' && req.method === 'GET') {
    const t = url.searchParams.get('t') || ''
    const email = String(url.searchParams.get('email') || '')
      .trim()
      .toLowerCase()
    const persona = url.searchParams.get('persona') || ''
    const kind = url.searchParams.get('kind') || ''
    if (!isPersona(persona) || !kind) return json({ error: 'persona and kind required' }, 400)
    let user: { id: string; email: string; name: string | null; timezone: string | null; phone: string | null } | null =
      null
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
    /* The evening brief is the one mini heavy enough to be worth caching: a
     * two-day calendar range, an inbox pull, and a model pass. The rest are a
     * query or two and are cheaper to just run. */
    if (kind === 'pick_night') {
      const day = localDateStrInTz(new Date(), user!.timezone || 'America/Los_Angeles')
      const force = url.searchParams.has('_t')
      if (force) options.eveningCache.drop(`${user!.id}|${persona}`)
      /* Same-day persisted row = the brief already exists (built when the text
       * was sent, or on an earlier open). Serve it the instant the tap lands and
       * rebuild behind the response — the morning brief has worked this way, the
       * evening one rebuilt in the foreground and made the user watch. */
      const dbRow = force ? null : await readBriefDb(sql, user!.id, persona as Persona, 'pick_night')
      const sameDayCached = dbRow && briefRowSameDay(dbRow.day, day) ? dbRow : null
      const brief = await options.eveningCache.read(
        `${user!.id}|${persona}`,
        () =>
          options.briefLoader(
            sql,
            user!.id,
            persona as Persona,
            'pick_night',
            () => options.miniPayload(sql, user!, persona as Persona, 'pick_night'),
            day,
            { force },
          ),
        force ? 0 : sameDayCached ? 0 : undefined,
      )
      if (!brief.value && brief.pending) {
        // Still loading behind this response. Never cached, or the retry reads it.
        if (sameDayCached) {
          return jsonRevalidated(req, 0, { ...sameDayCached.payload, revalidating: true })
        }
        return json({ pending: true, note: 'Closing out your day.' }, 200)
      }
      /* Nothing cached and nothing running: the build failed, or is inside the
       * failure cooldown. Only `pending` earns a retry — the ladder is shorter
       * than the cooldown, so promising one here would just stall and then lie. */
      if (!brief.value) {
        if (sameDayCached) {
          return jsonRevalidated(req, 0, { ...sameDayCached.payload })
        }
        return json({ error: 'Your evening brief did not build. Open again in a minute.' }, 200)
      }
      const load = brief.value
      // A stale hit refreshing behind the response must not come from the browser
      // cache next open, or that refresh would never be seen.
      return jsonRevalidated(req, brief.pending ? 0 : 60, {
        ...load.payload,
        limited: load.throttled || undefined,
        used: load.used,
        limit: load.limit,
      })
    }
    return json(await options.miniPayload(sql, user, persona as Persona, kind))
  }

  return null
}
