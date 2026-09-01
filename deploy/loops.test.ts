import {afterAll, afterEach, beforeEach, describe, expect, it} from 'bun:test'
import {
  TASK_LOOP_MAX_ATTEMPTS,
  claimDueLoops,
  ensurePhoneUser,
  finishTaskLoop,
  nextDailyUtc,
  nextWeeklyUtc,
  scheduleDay1Checkin,
  seedDefaultLoops,
} from './hire-api'

/* Task loops are the proactive side of a hire: seeded jobs arm when a phone
 * joins a roster, a bot claims what is due, and each run reports back through
 * the done/failed/snoozed state machine. A wrong transition here either texts
 * nobody or nags the same person forever, so the state machine is pinned. */

type Captured = { text: string; values: unknown[] }

function fakeSql(rowsFor: (text: string) => unknown[] = () => []) {
  const queries: Captured[] = []
  const sql = ((strings: TemplateStringsArray, ...values: unknown[]) => {
    queries.push({ text: strings.join('?'), values })
    return Promise.resolve(rowsFor(strings.join('?')))
  }) as unknown as Parameters<typeof claimDueLoops>[0]
  return { sql, queries }
}

const savedKey = process.env.HIREALPHA_INTERNAL_KEY

beforeEach(() => {
  process.env.HIREALPHA_INTERNAL_KEY = 'test-key'
})

afterAll(() => {
  if (savedKey === undefined) delete process.env.HIREALPHA_INTERNAL_KEY
  else process.env.HIREALPHA_INTERNAL_KEY = savedKey
})

describe('next run math', () => {
  it('lands the daily run at the next 8am local, in UTC', () => {
    const before = new Date('2026-08-27T14:30:00Z') // 7:30am Los Angeles
    const when = new Date(nextDailyUtc('America/Los_Angeles', 8, before))
    expect(when.toISOString()).toBe('2026-08-27T15:00:00.000Z')
  })

  it('rolls to tomorrow when this morning already passed', () => {
    const after = new Date('2026-08-27T16:30:00Z') // 9:30am Los Angeles
    const when = new Date(nextDailyUtc('America/Los_Angeles', 8, after))
    expect(when.toISOString()).toBe('2026-08-28T15:00:00.000Z')
  })

  it('picks the next occurrence of a weekday for weekly loops', () => {
    // 2026-08-27 is a Thursday. Next Tuesday 10am Pacific.
    const from = new Date('2026-08-27T20:00:00Z')
    const when = new Date(nextWeeklyUtc('America/Los_Angeles', 10, 2, from))
    expect(when.toISOString()).toBe('2026-09-01T17:00:00.000Z')
  })

  it('falls back to the default timezone for an unknown zone', () => {
    const from = new Date('2026-08-27T14:30:00Z')
    expect(nextDailyUtc('Mars/Olympus', 8, from)).toBe(nextDailyUtc('America/Los_Angeles', 8, from))
  })
})

describe('seedDefaultLoops', () => {
  it('arms wakeup, refund hunter, and memory resurface, deduped per persona', async () => {
    const { sql, queries } = fakeSql()
    await seedDefaultLoops(sql, 'u1', '+14155551212', 'friend', 'America/New_York')
    expect(queries.filter((q) => q.text.includes('hire_task_loops')).length).toBe(3)
    expect(queries.every((q) => q.text.includes('ON CONFLICT (user_id, persona, kind) DO NOTHING'))).toBe(true)
    // Kinds land as the fifth bind value in each insert.
    const inserted = queries.map((q) => q.values[4])
    expect(inserted).toContain('wakeup')
    expect(inserted).toContain('refund_hunter')
    expect(inserted).toContain('memory_resurface')
  })
})

describe('ensurePhoneUser arms seeded loops', () => {
  it('creates the account and seeds the default loops for the persona', async () => {
    const { sql, queries } = fakeSql((text) =>
      /INSERT INTO hire_users/i.test(text) ? [{ id: 'u-new' }] : [],
    )
    await ensurePhoneUser(sql, '(415) 555-1212', 'coworker')
    const seeds = queries.filter((q) => q.text.includes('INSERT INTO hire_task_loops'))
    expect(seeds.length).toBe(3)
    expect(seeds.every((q) => q.values.includes('u-new') && q.values.includes('coworker'))).toBe(true)
  })
})

describe('scheduleDay1Checkin', () => {
  it('queues a day1_checkin loop one day out for the phone owner', async () => {
    const { sql, queries } = fakeSql(() => [{ id: 'u1' }])
    await scheduleDay1Checkin(sql, '+14155551212', 'friend')
    const insert = queries.find((q) => q.text.includes('INSERT INTO hire_task_loops'))
    expect(insert).toBeTruthy()
    expect(insert!.text).toContain("'day1_checkin'")
    expect(insert!.text).toContain('Check how the first day went')
    const when = new Date(String(insert!.values.find((v) => String(v).endsWith('Z'))!))
    expect(when.getTime()).toBeGreaterThan(Date.now() + 23 * 60 * 60 * 1000)
  })

  it('skips phones with no account to own the loop', async () => {
    const { sql, queries } = fakeSql()
    await scheduleDay1Checkin(sql, '+14155551212', 'friend')
    expect(queries.some((q) => q.text.includes('INSERT INTO hire_task_loops'))).toBe(false)
  })
})

describe('claimDueLoops', () => {
  it('resets stale running rows and claims only due pending ones', async () => {
    const claimed = [
      { id: 't1', userId: 'u1', persona: 'friend', phone: '+14155551212', kind: 'wakeup', title: 'Morning wakeup', payload: {} },
    ]
    const { sql, queries } = fakeSql((text) =>
      /RETURNING id, user_id/i.test(text) ? claimed : [],
    )
    const rows = await claimDueLoops(sql, 'friend', 3)
    expect(rows).toEqual(claimed)
    expect(queries[0].text).toContain("status = 'running' AND updated_at < now()")
    expect(queries[1].text).toContain("status = 'running'")
    expect(queries[1].text).toContain("status = 'pending'")
    expect(queries[1].text).toContain('FOR UPDATE SKIP LOCKED')
    expect(queries[1].text).toContain(`attempts < ?`)
    expect(queries[1].values).toContain(TASK_LOOP_MAX_ATTEMPTS)
    expect(queries[1].text).toContain('next_run <= now()')
  })
})

describe('finishTaskLoop', () => {
  it('done closes the loop with its note', async () => {
    const { sql, queries } = fakeSql()
    await finishTaskLoop(sql, 't1', 'done', 'sent the wakeup')
    expect(queries[0].text).toContain("status = 'done'")
    expect(queries[0].text).toContain('last_result = ?')
  })

  it('failed burns an attempt and stays pending while attempts remain', async () => {
    const { sql, queries } = fakeSql()
    await finishTaskLoop(sql, 't1', 'failed', 'send bombed')
    expect(queries[0].text).toContain("CASE WHEN attempts + 1 < ? THEN 'pending' ELSE 'failed' END")
    expect(queries[0].text).toContain('attempts = attempts + 1')
    expect(queries[0].values).toContain(TASK_LOOP_MAX_ATTEMPTS)
  })

  it('snoozed parks it as pending with a next run', async () => {
    const { sql, queries } = fakeSql()
    const later = new Date(Date.now() + 60 * 60 * 1000).toISOString()
    await finishTaskLoop(sql, 't1', 'snoozed', 'not yet', later)
    expect(queries[0].text).toContain("status = 'pending'")
    expect(queries[0].text).toContain('next_run = ?')
    expect(queries[0].values).toContain(later)
  })

  it('snoozed without a valid next run defaults to one hour out', async () => {
    const { sql, queries } = fakeSql()
    await finishTaskLoop(sql, 't1', 'snoozed')
    const when = new Date(String(queries[0].values.find((v) => String(v).endsWith('Z'))!))
    expect(when.getTime()).toBeGreaterThan(Date.now() + 55 * 60 * 1000)
  })
})

describe('task loop routes', () => {
  it('internal claim requires the internal key', async () => {
    const { sql } = fakeSql()
    const { handleHireApi } = await import('./hire-api')
    const res = await handleHireApi(
      new Request('https://hirealpha.chat/api/internal/loops/claim?persona=friend'),
      sql,
    )
    expect(res!.status).toBe(401)
  })

  it('internal claim returns due loops for the persona', async () => {
    const { sql } = fakeSql(() => [
      { id: 't1', userId: 'u1', persona: 'friend', phone: '+14155551212', kind: 'wakeup', title: 'Morning wakeup', payload: {} },
    ])
    const { handleHireApi } = await import('./hire-api')
    const res = await handleHireApi(
      new Request('https://hirealpha.chat/api/internal/loops/claim?persona=friend', {
        headers: { Authorization: 'Bearer test-key' },
      }),
      sql,
    )
    expect(res!.status).toBe(200)
    const body = (await res!.json()) as { loops: Array<{ id: string }> }
    expect(body.loops[0].id).toBe('t1')
  })

  it('internal result rejects an unknown outcome', async () => {
    const { sql, queries } = fakeSql()
    const { handleHireApi } = await import('./hire-api')
    const res = await handleHireApi(
      new Request('https://hirealpha.chat/api/internal/loops/result', {
        method: 'POST',
        headers: { Authorization: 'Bearer test-key', 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: 't1', outcome: 'explode' }),
      }),
      sql,
    )
    expect(res!.status).toBe(400)
    expect(queries.length).toBe(0)
  })

  it('internal result routes a snooze into the state machine', async () => {
    const { sql, queries } = fakeSql()
    const { handleHireApi } = await import('./hire-api')
    const res = await handleHireApi(
      new Request('https://hirealpha.chat/api/internal/loops/result', {
        method: 'POST',
        headers: { Authorization: 'Bearer test-key', 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: 't1', outcome: 'snoozed', next_run: new Date(Date.now() + 3600_000).toISOString() }),
      }),
      sql,
    )
    expect(res!.status).toBe(200)
    expect(queries[0].text).toContain("status = 'pending'")
  })

  it('phone loops list returns task loops for the number', async () => {
    const { sql } = fakeSql(() => [
      { id: 't1', persona: 'friend', kind: 'wakeup', title: 'Morning wakeup', status: 'pending' },
    ])
    const { handleHireApi } = await import('./hire-api')
    const res = await handleHireApi(
      new Request('https://hirealpha.chat/api/loops?phone=(415)%20555-1212'),
      sql,
    )
    expect(res!.status).toBe(200)
    const body = (await res!.json()) as { loops: Array<{ id: string }> }
    expect(body.loops[0].id).toBe('t1')
  })

  it('pause and resume need the loop owner phone and flip the status', async () => {
    const { sql, queries } = fakeSql(() => [{ phone: '+14155551212' }])
    const { handleHireApi } = await import('./hire-api')
    const paused = await handleHireApi(
      new Request('https://hirealpha.chat/api/loops/t1/pause', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phone: '(415) 555-1212' }),
      }),
      sql,
    )
    expect(paused!.status).toBe(200)
    const pauseUpdate = queries.find((q) => q.text.includes("status = 'paused'"))
    expect(pauseUpdate).toBeTruthy()

    queries.length = 0
    const resumed = await handleHireApi(
      new Request('https://hirealpha.chat/api/loops/t1/resume', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phone: '+14155551212' }),
      }),
      sql,
    )
    expect(resumed!.status).toBe(200)
    const resumeUpdate = queries.find((q) => q.text.includes("status = 'pending'"))
    expect(resumeUpdate?.text).toContain('next_run = now()')
  })

  it('pause rejects a phone that does not own the loop', async () => {
    const { sql, queries } = fakeSql(() => [{ phone: '+14155551212' }])
    const { handleHireApi } = await import('./hire-api')
    const res = await handleHireApi(
      new Request('https://hirealpha.chat/api/loops/t1/pause', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phone: '+19995550000' }),
      }),
      sql,
    )
    expect(res!.status).toBe(404)
    expect(queries.some((q) => q.text.includes("status = 'paused'"))).toBe(false)
  })
})
