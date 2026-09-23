import { createHmac, timingSafeEqual } from 'node:crypto'
import type { SQL } from 'bun'
import type { Persona } from '../personas'
import { type AuthedUser, getUserByEmail, getUserByPhone } from '../db/users'
import { json } from '../utils/http'
import { requestIdentity } from './identity'

export { requestIdentity }

/** How long a signed web-session token stays valid. */
export const SESSION_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000

export const MINI_TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000

export interface SessionToken {
  email: string
  exp: number
}

export interface MiniToken {
  phone: string
  persona: string
  kind: string
  exp: number
}

export function miniTokenSecret(): string | null {
  const key = process.env.HIREALPHA_INTERNAL_KEY || ''
  return key || null
}

export function signMiniToken(payload: string, secret: string): string {
  return createHmac('sha256', secret).update(payload).digest('base64url')
}

/** Mint a signed, expiring identity token for a mini-app card URL. */
export function mintMiniToken(phone: string, persona: Persona, kind: string): string | null {
  const secret = miniTokenSecret()
  if (!secret) return null
  const payload: MiniToken = { phone, persona, kind, exp: Date.now() + MINI_TOKEN_TTL_MS }
  const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url')
  return `${encoded}.${signMiniToken(encoded, secret)}`
}

/** Verify + decode a mini-app token. Returns null when missing/invalid/expired. */
export function verifyMiniToken(token: string): MiniToken | null {
  const secret = miniTokenSecret()
  if (!secret) return null
  const dot = token.lastIndexOf('.')
  if (dot <= 0) return null
  const encoded = token.slice(0, dot)
  const sig = token.slice(dot + 1)
  const expected = signMiniToken(encoded, secret)
  const a = Buffer.from(sig)
  const b = Buffer.from(expected)
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null
  let payload: MiniToken
  try {
    payload = JSON.parse(Buffer.from(encoded, 'base64url').toString()) as MiniToken
  } catch {
    return null
  }
  if (!payload.phone || !payload.persona || !payload.kind || typeof payload.exp !== 'number') {
    return null
  }
  if (payload.exp < Date.now()) return null
  return payload
}

/** HMAC secret for signed web sessions. Falls back to the mini-token secret. */
export function sessionTokenSecret(): string | null {
  const dedicated = process.env.HIREALPHA_SESSION_SECRET || ''
  return dedicated || miniTokenSecret()
}

export function signSessionToken(payload: string, secret: string): string {
  return createHmac('sha256', secret).update(payload).digest('base64url')
}

/** Mint a signed, expiring web-session token bound to an email. */
export function mintSessionToken(email: string): string | null {
  const secret = sessionTokenSecret()
  if (!secret) return null
  const payload: SessionToken = { email, exp: Date.now() + SESSION_TOKEN_TTL_MS }
  const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url')
  return `${encoded}.${signSessionToken(encoded, secret)}`
}

/** Verify + decode a web-session token. Returns null when missing/invalid/expired. */
export function verifySessionToken(token: string): SessionToken | null {
  const secret = sessionTokenSecret()
  if (!secret) return null
  const dot = token.lastIndexOf('.')
  if (dot <= 0) return null
  const encoded = token.slice(0, dot)
  const sig = token.slice(dot + 1)
  const expected = signSessionToken(encoded, secret)
  const a = Buffer.from(sig)
  const b = Buffer.from(expected)
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null
  let payload: SessionToken
  try {
    payload = JSON.parse(Buffer.from(encoded, 'base64url').toString()) as SessionToken
  } catch {
    return null
  }
  if (typeof payload.email !== 'string' || typeof payload.exp !== 'number') return null
  if (payload.exp < Date.now()) return null
  return payload
}

/** The exact response shape the Google ticket exchange returns, plus the session token. */
export function sessionTokenResponse(user: { email: string; name: string | null; phone: string | null }): Response {
  const session = mintSessionToken(user.email)
  if (!session) return json({ error: 'Sign in temporarily unavailable' }, 503)
  const response = json({
    email: user.email,
    name: user.name,
    phone: user.phone,
    ...(session ? { session } : {}),
  })
  response.headers.set(
    'Set-Cookie',
    `hirealpha_session=${session}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${SESSION_TOKEN_TTL_MS / 1000}`,
  )
  response.headers.set('Cache-Control', 'no-store')
  return response
}


/** Resolve only verified identities. Email is a selector, never a credential. */
export async function resolveAuthedUser(
  sql: SQL,
  input: { token?: string; session?: string; email?: string },
): Promise<{ user: AuthedUser | null; error?: Response }> {
  const email = String(input.email || '').trim().toLowerCase()
  if (input.session) {
    const ses = verifySessionToken(input.session)
    if (!ses) {
      return {
        user: null,
        error: json({ error: 'Session expired. Sign in again.', code: 'session_invalid' }, 401),
      }
    }
    const user = await getUserByEmail(sql, ses.email)
    if (!user) return { user: null, error: json({ error: 'No account found for that email' }, 404) }
    return { user }
  }
  if (input.token) {
    const tok = verifyMiniToken(input.token)
    if (tok) {
      const user = await getUserByPhone(sql, tok.phone)
      if (!user) return { user: null, error: json({ error: 'No account found for that phone' }, 404) }
      return { user }
    }
  }
  const verified = requestIdentity.getStore()
  if (verified && (!email || email === verified.email)) {
    const user = await getUserByEmail(sql, verified.email)
    if (!user) return { user: null, error: json({ error: 'No account found for that email' }, 404) }
    return { user }
  }
  if (input.token) {
    return {
      user: null,
      error: json({ error: 'This link expired. Sign in to keep using it.', code: 'token_invalid' }, 401),
    }
  }
  return { user: null, error: json({ error: 'session or token required' }, 400) }
}
