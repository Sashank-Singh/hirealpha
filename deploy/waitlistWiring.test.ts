import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { handleWaitlist } from './web-server'

/* Regression guard for the signup wiring itself. The ensurePhoneUser branch
 * once silently fell out of this file during a parallel-agent merge — the
 * intro still texted people, but nobody got an account, so memory and pokes
 * never attached. These tests pin the branch per hire. */

type Captured = { text: string; values: unknown[] }

function fakeSql() {
  const queries: Captured[] = []
  const sql = ((strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.join('?')
    queries.push({ text, values })
    if (/FROM hire_users/i.test(text)) return Promise.resolve([])
    if (/count\(\*\)/i.test(text)) return Promise.resolve([{ n: 0 }])
    if (/INSERT INTO hire_users/i.test(text)) return Promise.resolve([{ id: 'u-new' }])
    return Promise.resolve([])
  }) as unknown as NonNullable<Parameters<typeof handleWaitlist>[1]>
  return { sql, queries }
}

function post(body: Record<string, unknown>) {
  return new Request('https://hirealpha.chat/api/waitlist', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

const savedUrl = process.env.DATABASE_URL
beforeEach(() => delete process.env.DATABASE_URL)
afterEach(() => {
  if (savedUrl !== undefined) process.env.DATABASE_URL = savedUrl
})

describe('waitlist signup wiring', () => {
  it('a live hire books the intro and arms a placeholder account', async () => {
    const { sql, queries } = fakeSql()
    const res = await handleWaitlist(post({ phone: '(415) 555-1212', hire: 'friend' }), sql)
    expect((await res.json() as { ok?: boolean }).ok).toBe(true)
    expect(queries.some((q) => /INSERT INTO hire_intro_queue/i.test(q.text))).toBe(true)
    expect(queries.some((q) => /INSERT INTO hire_users/i.test(q.text))).toBe(true)
    expect(queries.some((q) => /INSERT INTO hire_roster/i.test(q.text))).toBe(true)
  })

  it('a coming-soon hire is captured without any intro or account', async () => {
    const { sql, queries } = fakeSql()
    const res = await handleWaitlist(post({ phone: '(415) 555-1212', hire: 'coworker' }), sql)
    expect((await res.json() as { ok?: boolean }).ok).toBe(true)
    expect(queries.some((q) => /INSERT INTO hire_soon_waitlist/i.test(q.text))).toBe(true)
    expect(queries.some((q) => /INSERT INTO hire_intro_queue/i.test(q.text))).toBe(false)
    expect(queries.some((q) => /INSERT INTO hire_users/i.test(q.text))).toBe(false)
    const soon = queries.find((q) => /INSERT INTO hire_soon_waitlist/i.test(q.text))
    expect(soon?.values).toContain('coworker')
    expect(soon?.values).toContain('+14155551212')
  })

  it('an invalid phone still rejects', async () => {
    const { sql, queries } = fakeSql()
    const res = await handleWaitlist(post({ phone: '12', hire: 'friend' }), sql)
    expect(res.status).toBe(400)
    expect(queries).toEqual([])
  })
})
