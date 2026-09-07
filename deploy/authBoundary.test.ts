import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { createHmac } from 'node:crypto'
import { handleHireApi } from './hire-api'

describe('real API authentication boundary', () => {
  const actor = { id: 'owner', email: 'owner@example.com', phone: '+14155551212', name: 'Owner', timezone: 'UTC' }
  let savedKey: string | undefined
  let savedSessionKey: string | undefined
  let queries: { text: string; values: unknown[] }[]
  const sql = ((parts: TemplateStringsArray, ...values: unknown[]) => {
    const text = parts.join('?')
    queries.push({ text, values })
    return Promise.resolve(text.includes('FROM hire_users') ? [actor] : [])
  }) as unknown as NonNullable<Parameters<typeof handleHireApi>[1]>
  beforeEach(() => {
    savedKey = process.env.HIREALPHA_INTERNAL_KEY
    savedSessionKey = process.env.HIREALPHA_SESSION_SECRET
    process.env.HIREALPHA_INTERNAL_KEY = 'auth-test-key'
    process.env.HIREALPHA_SESSION_SECRET = 'auth-test-key'
    queries = []
  })
  afterEach(() => {
    if (savedKey === undefined) delete process.env.HIREALPHA_INTERNAL_KEY
    else process.env.HIREALPHA_INTERNAL_KEY = savedKey
    if (savedSessionKey === undefined) delete process.env.HIREALPHA_SESSION_SECRET
    else process.env.HIREALPHA_SESSION_SECRET = savedSessionKey
  })
  function token(payload: Record<string, unknown>) {
    const encoded = Buffer.from(JSON.stringify({ exp: Date.now() + 60_000, ...payload })).toString('base64url')
    return `${encoded}.${createHmac('sha256', 'auth-test-key').update(encoded).digest('base64url')}`
  }
  function request(path: string, body?: Record<string, unknown>, cookie?: string, origin?: string) {
    return new Request(`https://hirealpha.chat${path}`, {
      method: body ? 'POST' : 'GET',
      headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: `hirealpha_session=${cookie}` } : {}), ...(origin ? { Origin: origin } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    })
  }
  it('rejects email-only reads and writes before touching the database', async () => {
    for (const req of [request('/api/me?email=owner@example.com'), request('/api/work/send', { email: actor.email, toAddr: 'other@example.com', subject: 'test' }), request('/api/kill-switch', { phone: actor.phone, armed: false })]) {
      expect((await handleHireApi(req, sql))?.status).toBe(401)
    }
    expect(queries).toEqual([])
  })
  it('does not let an expired token fall back to a supplied email', async () => {
    expect((await handleHireApi(request('/api/work/send', { token: 'expired', email: actor.email }), sql))?.status).toBe(401)
    expect(queries).toEqual([])
  })
  it('rejects cross-account email selection with a valid session', async () => {
    const signed = token({ email: actor.email })
    for (const req of [request('/api/me?email=victim@example.com', undefined, signed), request('/api/work/send', { email: 'victim@example.com' }, signed)]) {
      expect((await handleHireApi(req, sql))?.status).toBe(403)
    }
    expect(queries).toEqual([])
  })
  it('allows a valid cookie and derives the identity without an email parameter', async () => {
    const res = await handleHireApi(request('/api/auth/session', undefined, token({ email: actor.email })), sql)
    expect(res?.status).toBe(200)
    expect(await res?.json()).toEqual({ email: actor.email })
  })
  it('accepts a signed mini card even if a browser cookie has expired', async () => {
    const mini = token({ phone: actor.phone, persona: 'friend', kind: 'apps' })
    const res = await handleHireApi(request(`/api/auth/session?t=${mini}`, undefined, token({ email: actor.email, exp: 0 })), sql)
    expect(res?.status).toBe(200)
  })
  it('rejects a different owner phone for stop switches and loop controls', async () => {
    for (const path of ['/api/kill-switch', '/api/loops/task/pause']) {
      expect((await handleHireApi(request(path, { phone: '+14155559999' }, token({ email: actor.email })), sql))?.status).toBe(403)
    }
    expect(queries.some((q) => /UPDATE|INSERT/.test(q.text))).toBe(false)
  })
  it('scopes action undo to the authenticated user', async () => {
    const res = await handleHireApi(request('/api/actions/action/undo', {}, token({ email: actor.email })), sql)
    expect(res?.status).toBe(200)
    const update = queries.find((q) => q.text.includes('UPDATE hire_action_log'))
    expect(update?.text).toContain('AND user_id =')
    expect(update?.values).toContain(actor.id)
  })
  it('rejects a cross-origin mutation even with a valid cookie', async () => {
    const res = await handleHireApi(request('/api/work/send', {}, token({ email: actor.email }), 'https://other.example'), sql)
    expect(res?.status).toBe(403)
    expect(queries).toEqual([])
  })
  it('clears the HttpOnly cookie on logout', async () => {
    const res = await handleHireApi(request('/api/auth/logout', {}), sql)
    expect(res?.headers.get('Set-Cookie')).toContain('Max-Age=0')
    expect(res?.headers.get('Set-Cookie')).toContain('HttpOnly')
  })
})
