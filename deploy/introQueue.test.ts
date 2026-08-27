import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { ackIntro, claimIntros, enqueueIntro, ensurePhoneUser, handleHireApi } from './hire-api'

/* The intro queue is the signup-to-first-text pipeline: the waitlist enqueues
 * a phone, a bot claims it, sends the intro, and acks. These tests pin the
 * state machine — a wrong transition here either texts nobody or texts the
 * same number forever. */

type Captured = { text: string; values: unknown[] }

function fakeSql(rowsFor: (text: string) => unknown[] = () => []) {
  const queries: Captured[] = []
  const sql = ((strings: TemplateStringsArray, ...values: unknown[]) => {
    queries.push({ text: strings.join('?'), values })
    return Promise.resolve(rowsFor(strings.join('?')))
  }) as unknown as Parameters<typeof enqueueIntro>[0]
  return { sql, queries }
}

const savedKey = process.env.HIREALPHA_INTERNAL_KEY

beforeEach(() => {
  process.env.HIREALPHA_INTERNAL_KEY = 'test-key'
})

afterEach(() => {
  if (savedKey === undefined) delete process.env.HIREALPHA_INTERNAL_KEY
  else process.env.HIREALPHA_INTERNAL_KEY = savedKey
})

describe('enqueueIntro', () => {
  it('normalizes a 10 digit number to E.164', async () => {
    const { sql, queries } = fakeSql()
    await enqueueIntro(sql, '(415) 555-1212', 'friend')
    expect(queries[0].values).toContain('+14155551212')
    expect(queries[0].text).toContain('ON CONFLICT (phone_e164, persona) DO NOTHING')
  })

  it('rejects a number too short to be real', async () => {
    const { sql, queries } = fakeSql()
    await expect(enqueueIntro(sql, '123', 'friend')).rejects.toThrow('invalid phone')
    expect(queries).toEqual([])
  })

  it('rejects an unknown persona', async () => {
    const { sql } = fakeSql()
    await expect(enqueueIntro(sql, '+14155551212', 'boss' as 'friend')).rejects.toThrow(
      'invalid persona',
    )
  })
})

describe('claimIntros', () => {
  it('resets stale claiming rows and claims pending ones', async () => {
    const claimed = [{ id: 'q1', phone: '+14155551212' }]
    const { sql, queries } = fakeSql((text) =>
      /RETURNING id, phone_e164/i.test(text) ? claimed : [],
    )
    const rows = await claimIntros(sql, 'friend', 3)
    expect(rows).toEqual(claimed)
    expect(queries[0].text).toContain("status = 'claiming' AND created_at < now()")
    expect(queries[1].text).toContain('FOR UPDATE SKIP LOCKED')
    expect(queries[1].text).toContain("status = 'pending'")
  })
})

describe('ackIntro', () => {
  it('marks a successful claim sent', async () => {
    const { sql, queries } = fakeSql()
    await ackIntro(sql, 'q1', true)
    expect(queries[0].text).toContain("status = 'sent'")
  })

  it('sends a failed claim back to pending while attempts remain', async () => {
    const { sql, queries } = fakeSql()
    await ackIntro(sql, 'q1', false, 'Target not allowed')
    expect(queries[0].text).toContain("WHEN attempts < ? THEN 'pending' ELSE 'failed' END")
    expect(queries[0].text).toContain("status = 'claiming'")
  })
})

describe('ensurePhoneUser', () => {
  it('enqueues the intro, creates a placeholder account, and arms the roster', async () => {
    const { sql, queries } = fakeSql((text) =>
      /INSERT INTO hire_users/i.test(text) ? [{ id: 'u-new' }] : [],
    )
    await ensurePhoneUser(sql, '(415) 555-1212', 'coworker')
    expect(queries.some((q) => q.text.includes('hire_intro_queue'))).toBe(true)
    const userInsert = queries.find((q) => /INSERT INTO hire_users/i.test(q.text))
    expect(userInsert?.values).toContain('+14155551212')
    expect(userInsert?.values).toContain('14155551212@phone.hirealpha.chat')
    const roster = queries.find((q) => /INSERT INTO hire_roster/i.test(q.text))
    expect(roster?.values).toContain('u-new')
    expect(roster?.values).toContain('coworker')
  })

  it('adopts an existing phone account instead of colliding on the unique index', async () => {
    const { sql, queries } = fakeSql((text) =>
      /FROM hire_users/i.test(text) ? [{ id: 'u-old', email: 'x@y.co' }] : [],
    )
    await ensurePhoneUser(sql, '+14155551212', 'friend')
    expect(queries.some((q) => /INSERT INTO hire_users/i.test(q.text))).toBe(false)
    const roster = queries.find((q) => /INSERT INTO hire_roster/i.test(q.text))
    expect(roster?.values).toContain('u-old')
  })
})

describe('internal intro routes', () => {
  it('claim requires the internal key', async () => {
    const { sql } = fakeSql()
    const res = await handleHireApi(
      new Request('https://hirealpha.chat/api/internal/intros/claim?persona=friend'),
      sql,
    )
    expect(res!.status).toBe(401)
  })

  it('claim returns rows for the persona', async () => {
    const { sql } = fakeSql(() => [{ id: 'q1', phone: '+14155551212' }])
    const res = await handleHireApi(
      new Request('https://hirealpha.chat/api/internal/intros/claim?persona=friend&limit=2', {
        headers: { Authorization: 'Bearer test-key' },
      }),
      sql,
    )
    expect(res!.status).toBe(200)
    const body = (await res!.json()) as { intros: Array<{ id: string }> }
    expect(body.intros[0].id).toBe('q1')
  })

  it('ack requires the internal key and accepts a body', async () => {
    const { sql, queries } = fakeSql()
    const res = await handleHireApi(
      new Request('https://hirealpha.chat/api/internal/intros/ack', {
        method: 'POST',
        headers: { Authorization: 'Bearer test-key', 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: 'q1', ok: true }),
      }),
      sql,
    )
    expect(res!.status).toBe(200)
    expect(queries[0].text).toContain("status = 'sent'")
  })
})
