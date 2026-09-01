import {afterAll, afterEach, beforeEach, describe, expect, it} from 'bun:test'
import { handleHireApi, resetLoginFailures } from './hire-api'
import { handleWaitlist } from './web-server'

/* Password auth: register, login, and the waitlist path that arms an account
 * for later sign in. The fakeSql harness pins what is stored (a hash, never
 * the plaintext) and what is answered (the same session contract as the
 * Google ticket exchange). Bun.password is stubbed so these stay hermetic. */

type Captured = { text: string; values: unknown[] }

const STUB_HASH = 'argon2id$stubhash'
let verifyResult: (password: string, hash: string) => boolean

const realHash = Bun.password.hash
const realVerify = Bun.password.verify

beforeEach(() => {
  process.env.HIREALPHA_INTERNAL_KEY = 'test-key'
  resetLoginFailures()
  ;(Bun.password as unknown as { hash: (p: string) => Promise<string> }).hash = async () => STUB_HASH
  ;(Bun.password as unknown as { verify: (p: string, h: string) => Promise<boolean> }).verify = async (
    password,
    hash,
  ) => verifyResult(password, hash)
})

afterAll(() => {
  ;(Bun.password as unknown as { hash: (p: string) => Promise<string> }).hash = realHash
  ;(Bun.password as unknown as { verify: (p: string, h: string) => Promise<boolean> }).verify = realVerify
  if (process.env.HIREALPHA_INTERNAL_KEY === 'test-key') delete process.env.HIREALPHA_INTERNAL_KEY
})

function fakeSql(rowsFor: (text: string) => unknown[] = () => []) {
  const queries: Captured[] = []
  const sql = ((strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.join('?')
    queries.push({ text, values })
    return Promise.resolve(rowsFor(text))
  }) as unknown as Parameters<typeof handleHireApi>[1]
  return { sql, queries }
}

function post(path: string, body: Record<string, unknown>) {
  return new Request(`https://hirealpha.chat${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

/** Rows for user lookups, hash lookups, and inserts. */
function authRows() {
  return (text: string) => {
    if (/SELECT id, email, name, timezone, phone_e164 AS phone, password_hash/.test(text)) {
      return [{ id: 'u1', email: 'a@b.co', name: 'A', timezone: null, phone: null, password_hash: STUB_HASH }]
    }
    if (/SELECT password_hash/.test(text)) return []
    if (/INSERT INTO hire_users/.test(text)) return [{ id: 'u1' }]
    return []
  }
}

describe('register', () => {
  it('stores a hash, never the plaintext, and answers the session contract', async () => {
    const { sql, queries } = fakeSql(authRows())
    const res = await handleHireApi(post('/api/auth/register', { email: 'a@b.co', password: 'correct horse' }), sql)
    expect(res!.status).toBe(200)
    const body = (await res!.json()) as { email?: string; name?: string | null; phone?: string | null; session?: string }
    expect(body.email).toBe('a@b.co')
    expect(typeof body.session).toBe('string')
    expect(body.session!.includes('.')).toBe(true)
    const stored = queries.find((q) => /password_hash = /.test(q.text))
    expect(stored).toBeTruthy()
    expect(stored!.values).toContain(STUB_HASH)
    expect(stored!.values).not.toContain('correct horse')
  })

  it('returns 409 when the account already has a password and stores nothing', async () => {
    const { sql, queries } = fakeSql((text) => {
      if (/SELECT password_hash/.test(text)) return [{ password_hash: STUB_HASH }]
      return []
    })
    const res = await handleHireApi(post('/api/auth/register', { email: 'a@b.co', password: 'correct horse' }), sql)
    expect(res!.status).toBe(409)
    expect(queries.some((q) => /password_hash = /.test(q.text))).toBe(false)
  })

  it('rejects a short password with 400 before touching the database', async () => {
    const { sql, queries } = fakeSql()
    const res = await handleHireApi(post('/api/auth/register', { email: 'a@b.co', password: 'short' }), sql)
    expect(res!.status).toBe(400)
    expect(queries).toEqual([])
  })

  it('rejects a bad email with 400', async () => {
    const { sql, queries } = fakeSql()
    const res = await handleHireApi(post('/api/auth/register', { email: 'nope', password: 'long enough 1' }), sql)
    expect(res!.status).toBe(400)
    expect(queries).toEqual([])
  })
})

describe('login', () => {
  it('mints the session token response on success and clears failures', async () => {
    verifyResult = () => true
    const { sql } = fakeSql(authRows())
    const res = await handleHireApi(post('/api/auth/login', { email: 'a@b.co', password: 'whatever1' }), sql)
    expect(res!.status).toBe(200)
    const body = (await res!.json()) as { email?: string; session?: string }
    expect(body.email).toBe('a@b.co')
    expect(typeof body.session).toBe('string')
    expect(body.session!.includes('.')).toBe(true)
  })

  it('answers a generic 401 on a wrong password', async () => {
    verifyResult = () => false
    const { sql } = fakeSql(authRows())
    const res = await handleHireApi(post('/api/auth/login', { email: 'a@b.co', password: 'wrong wrong' }), sql)
    expect(res!.status).toBe(401)
    expect(((await res!.json()) as { error: string }).error).toBe('Email or password is wrong')
  })

  it('answers the same generic 401 for an unknown email', async () => {
    verifyResult = () => true
    const { sql } = fakeSql()
    const res = await handleHireApi(post('/api/auth/login', { email: 'ghost@b.co', password: 'whatever1' }), sql)
    expect(res!.status).toBe(401)
    expect(((await res!.json()) as { error: string }).error).toBe('Email or password is wrong')
  })

  it('locks the email for 5 minutes after 8 wrong passwords', async () => {
    verifyResult = () => false
    const { sql } = fakeSql(authRows())
    for (let i = 0; i < 8; i++) {
      const res = await handleHireApi(post('/api/auth/login', { email: 'a@b.co', password: 'wrong wrong' }), sql)
      expect(res!.status).toBe(401)
    }
    const locked = await handleHireApi(post('/api/auth/login', { email: 'a@b.co', password: 'wrong wrong' }), sql)
    expect(locked!.status).toBe(429)
  })

  it('an unknown email is never locked out, however many times it fails', async () => {
    verifyResult = () => true
    const { sql } = fakeSql()
    for (let i = 0; i < 10; i++) {
      const res = await handleHireApi(post('/api/auth/login', { email: 'ghost@b.co', password: 'whatever1' }), sql)
      expect(res!.status).toBe(401)
    }
  })
})

describe('waitlist password', () => {
  it('arms the account with a hash when a password rides along', async () => {
    const { sql, queries } = fakeSql(authRows())
    const res = await handleWaitlist(
      post('/api/waitlist', { phone: '(415) 555-1212', email: 'a@b.co', password: 'correct horse', hire: 'friend' }),
      sql,
    )
    expect((await res.json() as { ok?: boolean }).ok).toBe(true)
    const stored = queries.find((q) => /password_hash = /.test(q.text))
    expect(stored).toBeTruthy()
    expect(stored!.values).toContain(STUB_HASH)
    expect(stored!.values).not.toContain('correct horse')
  })

  it('leaves the flow unchanged without a password', async () => {
    const { sql, queries } = fakeSql(authRows())
    const res = await handleWaitlist(
      post('/api/waitlist', { phone: '(415) 555-1212', email: 'a@b.co', hire: 'friend' }),
      sql,
    )
    expect((await res.json() as { ok?: boolean }).ok).toBe(true)
    expect(queries.some((q) => /password_hash = /.test(q.text))).toBe(false)
    expect(queries.some((q) => /INSERT INTO hire_intro_queue/i.test(q.text))).toBe(true)
  })

  it('rejects a too short password with 400', async () => {
    const { sql, queries } = fakeSql(authRows())
    const res = await handleWaitlist(
      post('/api/waitlist', { phone: '(415) 555-1212', email: 'a@b.co', password: 'short', hire: 'friend' }),
      sql,
    )
    expect(res.status).toBe(400)
    expect(queries).toEqual([])
  })

  it('ignores quietly when the account already has a password', async () => {
    const { sql, queries } = fakeSql((text) => {
      if (/SELECT password_hash/.test(text)) return [{ password_hash: STUB_HASH }]
      if (/INSERT INTO hire_users/.test(text)) return [{ id: 'u1' }]
      return []
    })
    const res = await handleWaitlist(
      post('/api/waitlist', { phone: '(415) 555-1212', email: 'a@b.co', password: 'correct horse', hire: 'friend' }),
      sql,
    )
    expect((await res.json() as { ok?: boolean }).ok).toBe(true)
    expect(queries.some((q) => /password_hash = /.test(q.text))).toBe(false)
  })
})
