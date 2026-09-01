import {afterAll, afterEach, describe, expect, it} from 'bun:test'
import { handleHireApi } from './hire-api'

/* ---- Route-level harness ----
 * The 221 helper tests never executed the request handlers, so the bugs that
 * actually bit users this release — a failed estimate silently dropping a meal,
 * home's "today" window read at midnight in the DB session timezone, a touch
 * that never reached the row — lived in routing and shipped. This harness runs
 * the real handler against a fake SQL: every query is captured so a test can
 * assert not just the response but the SQL the handler chose to run.
 */

type Captured = { text: string; values: unknown[] }

const USER = {
  id: 'u-test',
  email: 'a@b.co',
  name: 'Alpha',
  timezone: 'America/Los_Angeles',
  phone: '+15551234567',
  phone_e164: '+15551234567',
}

function fakeSql(rowsFor: (text: string) => unknown[] = () => []) {
  const queries: Captured[] = []
  const sql = ((strings: TemplateStringsArray, ...values: unknown[]) => {
    queries.push({ text: strings.join('?'), values })
    return Promise.resolve(rowsFor(strings.join('?')))
  }) as unknown as {
    (strings: TemplateStringsArray, ...values: unknown[]): Promise<unknown[]>
  }
  return { sql, queries }
}

function rowsForUsers(text: string) {
  if (/FROM hire_users/i.test(text)) return [USER]
  return []
}

function isIsoInstant(v: unknown) {
  return typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(v)
}

const KEY_ENV = ['GMI_API_KEY', 'NUTRITION_API_KEY', 'HIREALPHA_API_KEY', 'NUTRITION_BASE_URL', 'GMI_BASE_URL', 'HIREALPHA_BASE_URL']
const savedKeys = new Map<string, string | undefined>()
for (const k of KEY_ENV) {
  savedKeys.set(k, process.env[k])
  delete process.env[k] // no live estimator calls in route tests
}

afterAll(() => {
  delete process.env.HIREALPHA_INTERNAL_KEY
  for (const [k, v] of savedKeys) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
})

describe('/api/internal/nutrition', () => {
  it('logs the meal even when the estimator has no answer', async () => {
    process.env.HIREALPHA_INTERNAL_KEY = 'test-key'
    const { sql, queries } = fakeSql(rowsForUsers)
    const res = await handleHireApi(
      new Request('https://hirealpha.chat/api/internal/nutrition', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test-key' },
        body: JSON.stringify({ phone: '+15551234567', persona: 'friend', description: 'burger and fries' }),
      }),
      sql as never,
    )
    expect(res?.status).toBe(200)
    const data = (await res?.json()) as { logged?: boolean; estimated?: boolean }
    expect(data.logged).toBe(true)
    expect(data.estimated).toBe(false)
    const insert = queries.find((q) => /INSERT INTO hire_nutrition_logs/i.test(q.text))
    expect(insert).toBeTruthy()
    // The meal is kept, marked pending rather than dropped.
    expect(insert!.values.map(String).join(' ')).toContain('estimate pending')
  })
})

describe('/api/home', () => {
  it('queries today with UTC instants, never a bare local date', async () => {
    const { sql, queries } = fakeSql(rowsForUsers)
    const res = await handleHireApi(
      new Request('https://hirealpha.chat/api/home?email=a%40b.co'),
      sql as never,
    )
    expect(res?.status).toBe(200)
    const nutrToday = queries.find((q) => /FROM hire_nutrition_logs/i.test(q.text) && /protein/i.test(q.text))
    expect(nutrToday).toBeTruthy()
    const values = nutrToday!.values.map(String)
    // The two window bounds must be instants, not local midnight strings.
    const bound = values.find((v) => isIsoInstant(v))
    expect(bound).toBeTruthy()
    // Every day-window bound in the home queries is an instant with a time part.
    expect(values).not.toContain('2026-08-23') // a bare date would be the old ::date cast
  })

  it('answers 200 without a database for the shared fields', async () => {
    const { sql } = fakeSql(rowsForUsers)
    const res = await handleHireApi(
      new Request('https://hirealpha.chat/api/home?email=a%40b.co'),
      sql as never,
    )
    expect(res?.status).toBe(200)
  })
})

describe('/api/network/:id touch', () => {
  it('runs the touch UPDATE with the right row id', async () => {
    const { sql, queries } = fakeSql(rowsForUsers)
    const res = await handleHireApi(
      new Request('https://hirealpha.chat/api/network/row-42', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'a@b.co', context: 'talking about YC' }),
      }),
      sql as never,
    )
    expect(res?.status).toBe(200)
    const touch = queries.find((q) => /UPDATE hire_network/i.test(q.text) && /last_touch = now\(\)/i.test(q.text))
    expect(touch).toBeTruthy()
    expect(touch!.values).toContain('row-42')
  })
})
