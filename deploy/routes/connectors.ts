import type { SQL } from 'bun'
import { json, appBase } from '../utils/http'
import { getUserByEmail, ensureUser } from '../db/users'
import { googleCreds, LOGIN_STATE_USER } from '../auth/google'
import {
  UI_TO_COMPOSIO,
  composioKey,
  composioAuthorize,
  composioDisconnect,
  googleScopesFor,
  GOOGLE_SCOPES,
} from '../connectors/hub'
import type { Persona } from '../personas'

export const GOOGLE_CONNECTORS = new Set(['gmail', 'calendar', 'drive'])

export interface ConnectorRouteOptions {
  armMorningBrief: (sql: SQL, user: { id: string; timezone: string | null }, persona: Persona) => Promise<void>
  armCalendarDefense: (sql: SQL) => Promise<number>
}

export async function handleConnectorRoutes(
  req: Request,
  sql: SQL,
  options: ConnectorRouteOptions,
): Promise<Response | null> {
  const url = new URL(req.url)
  const path = url.pathname

  if (path.startsWith('/api/connect/') && req.method === 'GET') {
    const connector = path.slice('/api/connect/'.length).split('?')[0]
    const email = String(url.searchParams.get('email') || '')
      .trim()
      .toLowerCase()
    const persona = url.searchParams.get('persona') || ''
    const redirectAfter =
      url.searchParams.get('redirect') || `${appBase(req)}/app/hires/${persona || 'friend'}`
    const user = await getUserByEmail(sql, email)
    if (!user) return json({ error: 'Sign in first' }, 401)

    const toolkit = UI_TO_COMPOSIO[connector]
    const after = redirectAfter.startsWith('http')
      ? redirectAfter
      : `${appBase(req)}${redirectAfter}`
    const afterWithFlag = after.includes('?')
      ? `${after}&connected=${connector}`
      : `${after}?connected=${connector}`
    const asJson = url.searchParams.get('json') === '1'

    const sendUrl = (target: string) =>
      asJson ? json({ url: target }) : Response.redirect(target, 302)

    if (toolkit && composioKey()) {
      try {
        const urlOut = await composioAuthorize(sql, user.id, toolkit, afterWithFlag)
        if (urlOut) return sendUrl(urlOut)
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        console.error('[composio] authorize error', toolkit, msg)
        return json(
          {
            error: 'Composio authorization failed',
            message: `Could not start OAuth for ${connector}: ${msg}`,
          },
          502,
        )
      }
    }

    if (GOOGLE_CONNECTORS.has(connector) && googleCreds()) {
      const state = crypto.randomUUID()
      await sql`
        INSERT INTO hire_oauth_state (state, user_id, redirect_after)
        VALUES (${state}, ${user.id}, ${afterWithFlag})
      `
      const readonly = url.searchParams.get('readonly') || url.searchParams.get('scope') === 'readonly'
      const creds = googleCreds()!
      const auth = new URL('https://accounts.google.com/o/oauth2/v2/auth')
      auth.searchParams.set('client_id', creds.clientId)
      auth.searchParams.set('redirect_uri', `${appBase(req)}/api/oauth/google/callback`)
      auth.searchParams.set('response_type', 'code')
      auth.searchParams.set('scope', googleScopesFor(readonly))
      auth.searchParams.set('access_type', 'offline')
      auth.searchParams.set('prompt', 'consent')
      auth.searchParams.set('state', state)
      return sendUrl(auth.toString())
    }

    return json(
      {
        error: 'Connectors are not configured',
        message:
          'Set COMPOSIO_API_KEY on HireAlpha-Web for Gmail, Calendar, and the rest of the catalog. Or set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET for Google tools only.',
      },
      501,
    )
  }

  /* Disconnect a tool. Same path as connect, but DELETE. Removes the
   * Composio toolkit connection for non-Google tools, or the whole Google
   * token row for gmail/calendar/drive (the row carries all three scopes
   * together, so dropping it disconnects them all — same shape a re-Connect
   * would land back on). Auth: same email-keyed lookup the rest of the API
   * uses; the cookie session token backs the same route.
   *
   * The response says what happened to the data, and for Google the copies of
   * mailbox content Alpha had cached (daily briefs, sender kinds, triage
   * feedback) go with the access — otherwise "disconnect" would leave mail text
   * readable in a table the user thinks they revoked. Drafts Alpha wrote and
   * memories the user asked for are NOT silently purged; they are named in the
   * message so deleting them is the user's call. */
  if (path.startsWith('/api/connect/') && req.method === 'DELETE') {
    const connector = path.slice('/api/connect/'.length).split('?')[0]
    if (!connector) return json({ error: 'connector required' }, 400)
    const email = String(url.searchParams.get('email') || '')
      .trim()
      .toLowerCase()
    if (!email.includes('@')) return json({ error: 'sign in required' }, 401)
    const user = await getUserByEmail(sql, email)
    if (!user) return json({ error: 'sign in required' }, 401)
    try {
      if (GOOGLE_CONNECTORS.has(connector)) {
        await sql`DELETE FROM hire_google_tokens WHERE user_id = ${user.id}`
        const purged: string[] = []
        await sql`DELETE FROM hire_brief_cache WHERE user_id = ${user.id}`
          .then(() => purged.push('cached briefs')).catch(() => {})
        await sql`DELETE FROM hire_mail_kinds WHERE user_id = ${user.id}`
          .then(() => purged.push('sender kinds')).catch(() => {})
        await sql`DELETE FROM hire_mail_feedback WHERE user_id = ${user.id}`
          .then(() => purged.push('triage feedback')).catch(() => {})
        return json({
          ok: true,
          connector,
          provider: 'google',
          purged,
          message: `Google access removed — the stored token is deleted, so Alpha can no longer read or send from Gmail, Calendar or Drive until you connect again. Mail-derived copies Alpha had cached (${purged.join(', ') || 'none found'}) were deleted with it. Drafts Alpha already wrote for you and anything you saved to memory stay in your account until you delete them.`,
        })
      }
      const toolkit = UI_TO_COMPOSIO[connector]
      if (!toolkit) return json({ error: 'Unknown connector' }, 400)
      const removed = await composioDisconnect(user.id, toolkit)
      // Nothing to delete is still "this connector is off" — the end state the
      // caller wanted. Client just clears its local chip.
      return json({
        ok: true,
        connector,
        provider: 'composio',
        wasConnected: removed,
        message: `${connector} disconnected — the connected ${connector} account is removed from Alpha, so no further reads or actions on it are possible. Anything Alpha already saved from it (memories, drafts, logged items) stays in your account until you delete it.`,
      })
    } catch (err) {
      console.warn('[disconnect] failed', connector, err)
      return json({ error: 'Disconnect failed. Try again.' }, 500)
    }
  }

  if (path === '/api/oauth/google/callback' && req.method === 'GET') {
    const code = url.searchParams.get('code')
    const state = url.searchParams.get('state')
    const creds = googleCreds()
    if (!code || !state || !creds) return json({ error: 'OAuth callback missing code' }, 400)
    const rows = await sql`
      SELECT user_id, redirect_after FROM hire_oauth_state WHERE state = ${state} LIMIT 1
    `
    const st = rows[0] as { user_id: string; redirect_after: string | null } | undefined
    if (!st) return json({ error: 'Invalid OAuth state' }, 400)
    await sql`DELETE FROM hire_oauth_state WHERE state = ${state}`
    const tokRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: creds.clientId,
        client_secret: creds.clientSecret,
        redirect_uri: `${appBase(req)}/api/oauth/google/callback`,
        grant_type: 'authorization_code',
      }),
    })
    if (!tokRes.ok) return json({ error: 'Google token exchange failed' }, 400)
    const tok = (await tokRes.json()) as {
      access_token: string
      refresh_token?: string
      expires_in?: number
      scope?: string
    }

    if (st.user_id === LOGIN_STATE_USER) {
      const infoRes = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
        headers: { Authorization: `Bearer ${tok.access_token}` },
      })
      if (!infoRes.ok) return json({ error: 'Could not read Google profile' }, 400)
      const info = (await infoRes.json()) as { email?: string; name?: string }
      const email = String(info.email || '')
        .trim()
        .toLowerCase()
      if (!email.includes('@')) return json({ error: 'Google did not return an email' }, 400)
      const user = await ensureUser(sql, email, null, info.name)
      const ticket = crypto.randomUUID()
      await sql`
        INSERT INTO hire_login_tickets (ticket, email, name, phone_e164)
        VALUES (${ticket}, ${user.email}, ${user.name}, ${user.phone})
      `
      return Response.redirect(`${appBase(req)}/app/login?google=${ticket}`, 302)
    }

    const expiresAt = new Date(Date.now() + (tok.expires_in || 3600) * 1000).toISOString()
    await sql`
      INSERT INTO hire_google_tokens (user_id, access_token, refresh_token, expires_at, scopes, updated_at)
      VALUES (
        ${st.user_id},
        ${tok.access_token},
        ${tok.refresh_token || null},
        ${expiresAt},
        ${tok.scope || GOOGLE_SCOPES},
        now()
      )
      ON CONFLICT (user_id) DO UPDATE SET
        access_token = excluded.access_token,
        refresh_token = COALESCE(excluded.refresh_token, hire_google_tokens.refresh_token),
        expires_at = excluded.expires_at,
        scopes = excluded.scopes,
        updated_at = now()
    `
    // Proactive defaults-on: the moment calendar/mail is connected, arm the
    // morning brief (idempotent) and the calendar-defense scan so the bot
    // texts first without waiting for an inbound. Never blocks the redirect.
    void (async () => {
      try {
        const cu = (await sql`
          SELECT id, timezone FROM hire_users WHERE id = ${st.user_id} LIMIT 1
        `) as Array<{ id: string; timezone: string | null }>
        if (cu[0]) {
          await options.armMorningBrief(sql, { id: cu[0].id, timezone: cu[0].timezone }, 'friend')
          await options.armCalendarDefense(sql)
        }
      } catch (err) {
        console.warn('[oauth] proactive arm after connect failed', err)
      }
    })()
    return Response.redirect(st.redirect_after || `${appBase(req)}/app`, 302)
  }

  return null
}
