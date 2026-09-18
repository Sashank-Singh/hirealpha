import { afterEach, describe, expect, it } from 'bun:test'
import { handleHireApi } from './authenticatedTestApi'

/* Permissions dimension: the connect link must be able to ask for read-only,
 * and disconnect must name what happened to the data — and actually drop the
 * cached copies of mailbox content rather than just the token. */

type Captured = { text: string; values: unknown[] }

function fakeSql(rowsFor: (text: string) => unknown[] = () => []) {
  const queries: Captured[] = []
  const sql = ((strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.join('?')
    queries.push({ text, values })
    if (/FROM hire_users[\s\S]*WHERE email/.test(text)) {
      return Promise.resolve([{ id: 'u1', email: 'a@b.co', name: 'A B', timezone: 'America/Los_Angeles' }])
    }
    return Promise.resolve(rowsFor(text))
  }) as unknown as Parameters<typeof handleHireApi>[1]
  return { sql, queries }
}

function request(path: string, method = 'GET') {
  return new Request(`https://hirealpha.chat${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
  })
}

const envBefore = {
  composio: process.env.COMPOSIO_API_KEY,
  clientId: process.env.GOOGLE_CLIENT_ID,
  clientSecret: process.env.GOOGLE_CLIENT_SECRET,
  internal: process.env.HIREALPHA_INTERNAL_KEY,
}
afterEach(() => {
  const restore = (key: string, value: string | undefined) => {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  restore('COMPOSIO_API_KEY', envBefore.composio)
  restore('GOOGLE_CLIENT_ID', envBefore.clientId)
  restore('GOOGLE_CLIENT_SECRET', envBefore.clientSecret)
  restore('HIREALPHA_INTERNAL_KEY', envBefore.internal)
})

describe('read-only Google connect (dim 9)', () => {
  it('asks Google for read-only scopes when the link carries readonly=1', async () => {
    delete process.env.COMPOSIO_API_KEY
    process.env.GOOGLE_CLIENT_ID = 'test-client'
    process.env.GOOGLE_CLIENT_SECRET = 'test-secret'
    const { sql } = fakeSql()
    const res = await handleHireApi(request('/api/connect/gmail?email=a@b.co&readonly=1&json=1'), sql)
    expect(res!.status).toBe(200)
    const body = (await res!.json()) as { url: string }
    const scope = new URL(body.url).searchParams.get('scope') || ''
    expect(scope).toContain('gmail.readonly')
    expect(scope).not.toContain('gmail.send')
    expect(scope).not.toContain('calendar.events')
  })

  it('keeps the read-write scopes when no read-only flag is present', async () => {
    delete process.env.COMPOSIO_API_KEY
    process.env.GOOGLE_CLIENT_ID = 'test-client'
    process.env.GOOGLE_CLIENT_SECRET = 'test-secret'
    const { sql } = fakeSql()
    const res = await handleHireApi(request('/api/connect/gmail?email=a@b.co&json=1'), sql)
    const body = (await res!.json()) as { url: string }
    const scope = new URL(body.url).searchParams.get('scope') || ''
    expect(scope).toContain('gmail.send')
  })
})

describe('disconnect says what happened to the data (dim 9)', () => {
  it('deletes the token and the cached mail copies, and names them', async () => {
    const { sql, queries } = fakeSql()
    const res = await handleHireApi(request('/api/connect/gmail?email=a@b.co', 'DELETE'), sql)
    expect(res!.status).toBe(200)
    const body = (await res!.json()) as { ok: boolean; message: string; purged: string[] }
    expect(body.ok).toBe(true)
    expect(queries.some((q) => /DELETE FROM hire_google_tokens/.test(q.text))).toBe(true)
    expect(queries.some((q) => /DELETE FROM hire_brief_cache/.test(q.text))).toBe(true)
    expect(queries.some((q) => /DELETE FROM hire_mail_kinds/.test(q.text))).toBe(true)
    expect(queries.some((q) => /DELETE FROM hire_mail_feedback/.test(q.text))).toBe(true)
    expect(body.message).toContain('no longer read or send')
    expect(body.message).toContain('stay in your account until you delete them')
  })
})
