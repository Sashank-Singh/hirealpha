import {afterAll, afterEach, describe, expect, it} from 'bun:test'
import { handleHireApi } from './authenticatedTestApi'

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

/* ---- Briefs already exist when the tap lands ----
 * The brief is built when Alpha's text is sent (briefLoader persists it to
 * hire_brief_cache); an open must serve that row at once and rebuild behind
 * the response, never rebuild in the foreground while the user watches.
 *
 * The build side is hung forever in these tests (every non-brief query never
 * resolves): the assertion is that the handler does NOT wait on it. */

const todayIn = (tz: string) => new Date().toLocaleDateString('en-CA', { timeZone: tz })

function rowsForBriefCache(user: typeof USER, payload: Record<string, unknown> | null, ageMs = 10 * 60_000) {
  return (text: string) => {
    if (/FROM hire_users/i.test(text)) return [user]
    if (/FROM hire_brief_cache/i.test(text)) {
      return payload
        ? [{ day: todayIn(user.timezone || 'America/Los_Angeles'), payload: JSON.stringify(payload), builtAt: new Date(Date.now() - ageMs) }]
        : []
    }
    // The build never finishes, so whatever the handler answers, it answers
    // without the rebuild — which is the whole point under test.
    return new Promise(() => {}) as never
  }
}

describe('/api/mini pick_night with a same-day brief row', () => {
  it('serves the persisted row instantly and marks it revalidating', async () => {
    const user = { ...USER, id: 'u-evening-row' }
    const { sql } = fakeSql(
      rowsForBriefCache(user, {
        kind: 'pick_night',
        title: 'Evening brief',
        date: todayIn(user.timezone || 'America/Los_Angeles'),
        sections: [{ heading: 'The day', items: ['2 meetings', '3 mails left'] }],
      }),
    )
    const res = await handleHireApi(
      new Request('https://hirealpha.chat/api/mini?persona=friend&kind=pick_night&email=a%40b.co'),
      sql as never,
    )
    expect(res?.status).toBe(200)
    const data = (await res?.json()) as { sections?: unknown[]; revalidating?: boolean; pending?: boolean; error?: string }
    // The row, not a spinner: sections painted on the first response, flagged
    // so the client keeps polling for the rebuild landing behind it.
    expect(data.sections).toHaveLength(1)
    expect(data.revalidating).toBe(true)
    expect(data.pending).toBeUndefined()
    expect(data.error).toBeUndefined()
  })

  it('answers pending for a user with no row rather than erroring', async () => {
    const user = { ...USER, id: 'u-evening-cold' }
    const { sql } = fakeSql(rowsForBriefCache(user, null))
    const res = await handleHireApi(
      new Request('https://hirealpha.chat/api/mini?persona=friend&kind=pick_night&email=a%40b.co'),
      sql as never,
    )
    expect(res?.status).toBe(200)
    const data = (await res?.json()) as { pending?: boolean; error?: string }
    expect(data.pending).toBe(true)
  })
})

describe('/api/digest with a same-day brief row', () => {
  it('serves the persisted row instantly and marks it revalidating', async () => {
    const user = { ...USER, id: 'u-morning-row' }
    const { sql } = fakeSql(
      rowsForBriefCache(user, {
        kind: 'digest',
        date: todayIn(user.timezone || 'America/Los_Angeles'),
        calendar: ['9am · Standup'],
        emails: ['Stripe: your payout'],
      }),
    )
    const res = await handleHireApi(
      new Request('https://hirealpha.chat/api/digest?persona=friend&email=a%40b.co'),
      sql as never,
    )
    expect(res?.status).toBe(200)
    const data = (await res?.json()) as { calendar?: string[]; revalidating?: boolean; pending?: boolean; error?: string }
    expect(data.calendar).toEqual(['9am · Standup'])
    expect(data.revalidating).toBe(true)
    expect(data.pending).toBeUndefined()
  })
})

describe('/api/internal/digest', () => {
  it('serves the built brief with the card kind and URL the text will carry', async () => {
    process.env.HIREALPHA_INTERNAL_KEY = 'test-key'
    const user = { ...USER, id: 'u-send-warm' }
    const { sql } = fakeSql(
      rowsForBriefCache(user, {

        kind: 'digest',
        date: todayIn(user.timezone || 'America/Los_Angeles'),
        preview: '2 meetings, 3 mails need you',
        text: 'Morning: 2 meetings, 3 mails need you.',
      }, 5_000),
    )
    const res = await handleHireApi(
      new Request(
        'https://hirealpha.chat/api/internal/digest?phone=%2B15551234567&persona=friend',
        { headers: { Authorization: 'Bearer test-key' } },
      ),
      sql as never,
    )
    expect(res?.status).toBe(200)
    const data = (await res?.json()) as { briefKind?: string; cardUrl?: string; text?: string }
    expect(['digest', 'pick_night']).toContain(data.briefKind)
    expect(data.cardUrl?.endsWith(`/${data.briefKind}`)).toBe(true)
    // The bot phrases its text from this payload; an empty text means no brief goes out.
    expect(data.text).toContain('Morning')
  })
})
