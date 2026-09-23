import type { SQL } from 'bun'
import { normalizePhone } from '../utils/phone'
import { appBase, json } from '../utils/http'
import type { AuthedUser } from '../db/users'
import { defaultLoginLockout, hashPassword, isPlausiblePassword, isValidEmailFormat } from '../auth/passwords'
import { googleCreds, LOGIN_SCOPES, LOGIN_STATE_USER } from '../auth/google'
import { sessionTokenResponse } from '../auth/session'

export interface AuthRouteOptions {
  onUserRegistered?: (sql: SQL, user: AuthedUser) => Promise<void>
}

export async function handleAuthRoutes(
  req: Request,
  sql: SQL,
  options?: AuthRouteOptions,
): Promise<Response | null> {
  const url = new URL(req.url)
  const path = url.pathname

  if (path === '/api/auth/logout' && req.method === 'POST') {
    const response = json({ ok: true })
    response.headers.set('Set-Cookie', 'hirealpha_session=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0')
    return response
  }

  if (path === '/api/auth/google' && req.method === 'GET') {
    const creds = googleCreds()
    if (!creds) {
      return Response.redirect(`${appBase(req)}/app/login?error=google`, 302)
    }
    const state = crypto.randomUUID()
    const afterLogin = `${appBase(req)}/app/login`
    await sql`
      INSERT INTO hire_oauth_state (state, user_id, redirect_after)
      VALUES (${state}, ${LOGIN_STATE_USER}, ${afterLogin})
    `
    const auth = new URL('https://accounts.google.com/o/oauth2/v2/auth')
    auth.searchParams.set('client_id', creds.clientId)
    auth.searchParams.set('redirect_uri', `${appBase(req)}/api/oauth/google/callback`)
    auth.searchParams.set('response_type', 'code')
    auth.searchParams.set('scope', LOGIN_SCOPES)
    auth.searchParams.set('access_type', 'online')
    auth.searchParams.set('prompt', 'select_account')
    auth.searchParams.set('state', state)
    return Response.redirect(auth.toString(), 302)
  }

  if (path === '/api/auth/ticket' && req.method === 'GET') {
    const ticket = url.searchParams.get('ticket') || ''
    if (!ticket) return json({ error: 'ticket required' }, 400)
    const rows = await sql`
      DELETE FROM hire_login_tickets WHERE ticket = ${ticket}
      RETURNING email, name, phone_e164 AS phone, created_at
    `
    const row = rows[0] as { email: string; name: string | null; phone: string | null; created_at: Date } | undefined
    if (!row) return json({ error: 'Sign in expired. Try Google again.' }, 400)
    if (Date.now() - new Date(row.created_at).getTime() > 10 * 60 * 1000) {
      return json({ error: 'Sign in expired. Try Google again.' }, 400)
    }
    return sessionTokenResponse(row)
  }

  if (path === '/api/auth/register' && req.method === 'POST') {
    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>
    const email = String(body.email || '')
      .trim()
      .toLowerCase()
    const password = body.password
    const phone = typeof body.phone === 'string' ? body.phone : undefined
    const name = typeof body.name === 'string' ? body.name : undefined
    if (!isValidEmailFormat(email)) return json({ error: 'Enter a valid email' }, 400)
    if (!isPlausiblePassword(password)) {
      return json({ error: 'Password needs at least 8 characters' }, 400)
    }
    let user: AuthedUser
    try {
      const hash = await hashPassword(password)
      const rows = await sql`
        INSERT INTO hire_users (id, email, phone_e164, name, password_hash)
        VALUES (${crypto.randomUUID()}, ${email}, ${normalizePhone(phone || '')}, ${name?.trim() || null}, ${hash})
        ON CONFLICT (email) DO NOTHING
        RETURNING id, email, name, timezone, phone_e164 AS phone
      `
      if (!rows.length) return json({ error: 'Account already exists. Sign in instead.' }, 409)
      user = rows[0] as AuthedUser
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      if (msg.toLowerCase().includes('unique') || msg.includes('hire_users_phone')) {
        return json({ error: 'That phone is already linked to another account' }, 409)
      }
      console.error('[hire] register user failed', err)
      return json({ error: 'Could not create account' }, 500)
    }
    // A number on the account means Alpha (friend) can greet it: same wiring
    // the landing waitlist uses — roster, intro queue, default loops — so a
    // /app registration is never invisible to the bot or missing from Photon.
    if (user.phone && options?.onUserRegistered) {
      try {
        await options.onUserRegistered(sql, user)
      } catch (err) {
        console.warn('[hire] auto-hire after register failed', err)
      }
    }
    return sessionTokenResponse(user)
  }

  if (path === '/api/auth/login' && req.method === 'POST') {
    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>
    const email = String(body.email || '')
      .trim()
      .toLowerCase()
    const password = body.password
    if (!email.includes('@') || typeof password !== 'string' || !password) {
      return json({ error: 'Email or password is wrong' }, 401)
    }
    const lockedMs = defaultLoginLockout.lockedRemainingMs(email)
    if (lockedMs > 0) {
      return json({ error: 'Too many attempts. Try again in a few minutes.' }, 429)
    }
    const rows = await sql`
      SELECT id, email, name, timezone, phone_e164 AS phone, password_hash
      FROM hire_users
      WHERE email = ${email}
      LIMIT 1
    `
    const row = rows[0] as
      | { id: string; email: string; name: string | null; timezone: string | null; phone: string | null; password_hash: unknown }
      | undefined
    const hash = typeof row?.password_hash === 'string' ? row.password_hash : ''
    if (!row || !hash) return json({ error: 'Email or password is wrong' }, 401)
    const ok = await Bun.password.verify(password, hash)
    if (!ok) {
      defaultLoginLockout.recordFailure(email)
      return json({ error: 'Email or password is wrong' }, 401)
    }
    defaultLoginLockout.clear(email)
    return sessionTokenResponse(row)
  }

  return null
}
