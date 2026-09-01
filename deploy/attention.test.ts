import { afterAll, beforeEach, describe, expect, it } from 'bun:test'
import { handleHireApi, pickAttentionEmail, remainingTodayMeets } from './hire-api'

/* ---- Attention + remaining meetings ----
 * The briefs and home already load the calendar and the inbox; these pin the
 * packaging layer on top: which meetings are still ahead of the user, and which
 * one email surfaces above the pile counts. */

describe('pickAttentionEmail', () => {
  it('returns null for empty input', () => {
    expect(pickAttentionEmail([])).toBeNull()
  })

  it('picks money needing action over urgency and personal mail', () => {
    const pick = pickAttentionEmail([
      { id: 'u1', label: 'Report today · Manager', snippet: 'I need this by EOD' },
      { id: 'm1', label: 'Your August bill · City Water', snippet: 'Please pay by the 30th', kind: 'invoice' },
      { id: 'p1', label: 'lunch friday? · Priya Shah', snippet: 'want to grab food near the office' },
    ])
    expect(pick?.id).toBe('m1')
    expect(pick?.why).toBe('invoice due')
  })

  it('treats a receipt as money only when an amount is still owed', () => {
    const owed = pickAttentionEmail([
      { id: 'r1', label: 'Your statement · Card Services', kind: 'receipt', snippet: 'amount due $240 by Friday' },
    ])
    expect(owed?.id).toBe('r1')
    expect(owed?.why).toBe('payment due')
    const shipped = pickAttentionEmail([
      { id: 'r2', label: 'Order shipped · Shop', kind: 'receipt' },
    ])
    expect(shipped).toBeNull()
  })

  it('picks urgency words over a plain personal note', () => {
    const pick = pickAttentionEmail([
      { id: 'p1', label: 'lunch friday? · Priya Shah', snippet: 'want to grab food near the office' },
      { id: 'u1', label: 'tickets · Sam Ortiz', snippet: 'need a headcount for tonight' },
    ])
    expect(pick?.id).toBe('u1')
    expect(pick?.why).toBe('deadline today')
  })

  it('falls back to the first personal item and names the sender', () => {
    const pick = pickAttentionEmail([
      { id: 'n0', label: 'notes? · Dana Reed', snippet: 'can you send the notes from the review' },
      { id: 'p2', label: 'later? · Priya Shah', snippet: 'call me when you are free' },
    ])
    expect(pick?.id).toBe('n0')
    expect(pick?.why).toBe('from Dana Reed')
  })

  it('skips newsletters even when they carry money words', () => {
    const pick = pickAttentionEmail([
      {
        id: 'n1',
        label: 'This week in software · TechDeals',
        snippet: 'The best billing tools of August. Unsubscribe any time.',
        kind: 'newsletter',
      },
      { id: 'p1', label: 'hi · Dana Reed', snippet: 'can you send the notes' },
    ])
    expect(pick?.id).toBe('p1')
    expect(pickAttentionEmail([
      {
        id: 'n1',
        label: 'This week in software · TechDeals',
        snippet: 'The best billing tools of August. Unsubscribe any time.',
        kind: 'newsletter',
      },
    ])).toBeNull()
  })

  it('returns null when nothing qualifies', () => {
    expect(pickAttentionEmail([{ id: 'x1', label: 'Build finished · CI Bot' }])).toBeNull()
  })
})

describe('remainingTodayMeets', () => {
  const tz = 'UTC'
  // 6:00pm UTC.
  const now = new Date('2026-08-27T18:00:00Z')

  it('keeps upcoming meetings soonest first and drops the ones long past', () => {
    const meets = remainingTodayMeets(
      [
        { time: '8:00 PM', title: 'Dinner with Sam', who: 'Sam' },
        { time: '3:00 PM', title: 'Old standup', who: 'Old standup' },
        { time: '5:30 PM', title: 'Sprint review', who: 'Sprint review' },
      ],
      tz,
      now,
    )
    expect(meets.map((m) => m.title)).toEqual(['Sprint review', 'Sam'])
    expect(meets[0]!.startsInMin).toBe(0)
    expect(meets[1]!.startsInMin).toBe(120)
  })

  it('drops all day rows and rows without a clock time', () => {
    const meets = remainingTodayMeets(
      [
        { time: 'All day', title: 'Travel day', who: 'Travel day' },
        { time: 'later', title: 'Someday', who: 'Someday' },
        { time: '7:00 PM', title: 'Gym with Dana', who: 'Dana' },
      ],
      tz,
      now,
    )
    expect(meets).toHaveLength(1)
    expect(meets[0]!.title).toBe('Dana')
  })

  it('returns at most eight meetings', () => {
    const rows = [1, 2, 3, 4, 5, 6, 7, 8, 9].map((i) => ({
      time: `6:${String(i).padStart(2, '0')} PM`,
      title: `Meet ${i}`,
      who: `Meet ${i}`,
    }))
    expect(remainingTodayMeets(rows, tz, now)).toHaveLength(8)
  })
})

/* ---- Route test ----
 * The same fakeSql capture harness as the other route tests: the real handler
 * runs against a fake SQL so the response shape is pinned without Google, a
 * model, or Postgres. The digest build is cached with a short first-open wait,
 * so a cold read can answer pending while the build lands behind it; poll until
 * the payload arrives. */

type Captured = { text: string; values: unknown[] }

const USER = {
  id: 'u-att',
  email: 'att@b.co',
  name: 'Alpha',
  timezone: 'America/Los_Angeles',
  phone: '+15550001111',
}

function fakeSql(rowsFor: (text: string) => unknown[] = () => []) {
  const queries: Captured[] = []
  const sql = ((strings: TemplateStringsArray, ...values: unknown[]) => {
    queries.push({ text: strings.join('?'), values })
    return Promise.resolve(rowsFor(strings.join('?')))
  }) as unknown as Parameters<typeof handleHireApi>[1]
  return { sql, queries }
}

const KEY_ENV = ['GMI_API_KEY', 'NUTRITION_API_KEY', 'HIREALPHA_API_KEY', 'COMPOSIO_API_KEY']
const savedKeys = new Map<string, string | undefined>()
/* Saved at collection, wiped in afterAll — a module-level delete here runs while
 * other test files are mid-test (bun shares process.env across files). */
for (const k of KEY_ENV) {
  savedKeys.set(k, process.env[k])
}

afterAll(() => {
  for (const [k, v] of savedKeys) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
})

describe('/api/digest attention fields', () => {
  it('serves a meetings array in the payload', async () => {
    const { sql } = fakeSql((text) => (/FROM hire_users/i.test(text) ? [USER] : []))
    let body: Record<string, unknown> | null = null
    for (let i = 0; i < 50 && !body; i++) {
      const res = await handleHireApi(
        new Request('https://hirealpha.chat/api/digest?email=att%40b.co&persona=friend'),
        sql,
      )
      expect(res?.status).toBe(200)
      const data = (await res!.json()) as Record<string, unknown>
      // A cold cache may answer pending once while the build finishes behind it.
      if (!data.pending) body = data
      else await new Promise((r) => setTimeout(r, 200))
    }
    expect(body).toBeTruthy()
    expect(Array.isArray(body!.meetings)).toBe(true)
    expect('attention' in body!).toBe(true)
  })
})
