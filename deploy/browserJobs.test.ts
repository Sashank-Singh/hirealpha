import { describe, expect, it } from 'bun:test'
import {
  claimBrowserJobs,
  enqueueBrowserJob,
  finishBrowserJob,
  generateSessionViewToken,
  getBrowserJob,
  verifySessionViewToken,
} from './browserJobs'
import {
  buildVisionParts,
  isTerminal,
  makeVisionCaller,
  pageShowsExactTotal,
  parseAgentAction,
} from './agentDriver'

/* ============================================================================
 * Cloud computer plumbing — queue protocol + agent action parser. The parser
 * is the ONLY path from model JSON to the browser, so it gets the brutal
 * half: junk, injection, oversized payloads, off-site navigation.
 * ========================================================================== */

type Captured = { text: string; values: unknown[] }

function fakeSql(rowsFor: (text: string, values?: unknown[]) => unknown[] = () => []) {
  const queries: Captured[] = []
  const sql = ((strings: TemplateStringsArray, ...values: unknown[]) => {
    queries.push({ text: strings.join('?'), values })
    return Promise.resolve(rowsFor(strings.join('?'), values))
  }) as never as import('bun').SQL
  return { sql, queries }
}

const USER = 'u-alice'

describe('browser job queue', () => {
  it('enqueue inserts a pending row with steps serialized', async () => {
    const { sql, queries } = fakeSql()
    const id = await enqueueBrowserJob(sql, {
      userId: USER,
      persona: 'friend',
      phone: '+14155550100',
      kind: 'task',
      url: 'https://portal.nseindia.com',
      steps: [{ action: 'click', selector: 'button' }],
      goal: null,
      resolveHost: async () => ['93.184.216.34'],
    })
    expect(id).toBeTruthy()
    const insert = queries.find((q) => /INSERT INTO hire_browser_jobs/i.test(q.text))!
    expect(insert.text).toContain("'pending'")
    expect(JSON.stringify(insert.values)).toContain('click')
  })

  it('kill switch env stops all new claims without touching the database', async () => {
    process.env.HIREALPHA_DISABLE_BROWSER_JOBS = '1'
    try {
      const { sql, queries } = fakeSql()
      expect(await claimBrowserJobs(sql, 5)).toEqual([])
      expect(queries).toHaveLength(0)
    } finally {
      delete process.env.HIREALPHA_DISABLE_BROWSER_JOBS
    }
  })

  it('claim fails stale running rows and requires a fresh, scoped, unused approval', async () => {
    const { sql, queries } = fakeSql((text) =>
      /RETURNING id, user_id/i.test(text)
        ? [{ id: 'j1', userId: USER, persona: 'friend', phone: null, kind: 'task', url: 'https://x.com', steps: null, goal: null, status: 'running', attempts: 1, result: null, error: null }]
        : [],
    )
    const jobs = await claimBrowserJobs(sql, 5)
    expect(jobs.length).toBe(1)
    expect(jobs[0]!.kind).toBe('task')
    const stale = queries.find((q) => /status = 'running' AND claimed_at/i.test(q.text))
    expect(stale).toBeTruthy()
    expect(stale!.text).toContain("status = 'failed'")
    const claim = queries.find((q) => /FOR UPDATE OF j SKIP LOCKED/i.test(q.text))
    expect(claim!.text).toContain('attempts < 3')
    expect(claim!.text).toContain('a.user_id = j.user_id')
    expect(claim!.text).toContain('a.consumed_at IS NULL')
    expect(claim!.text).toContain("interval '10 minutes'")
    expect(claim!.text).toContain('a.origin = substring')
  })

  it('finish: done closes the row; failure without retry marks failed', async () => {
    const { sql, queries } = fakeSql()
    await finishBrowserJob(sql, 'j1', { ok: true, result: 'Nifty ends higher' })
    const done = queries.find((q) => /SET status = 'done'/i.test(q.text))!
    expect(done.values).toContain('Nifty ends higher')
    await finishBrowserJob(sql, 'j1', { ok: false, error: 'page exploded' })
    const failed = queries.filter((q) => /SET status = 'failed'/i.test(q.text))
    expect(failed.length).toBe(1)
  })

  it('finish with retry goes back to pending under the attempts cap, failed at it', async () => {
    const { sql, queries } = fakeSql((text) => (/attempts >= 3/i.test(text) ? [] : []))
    await finishBrowserJob(sql, 'j1', { ok: false, error: 'flake', retry: true })
    const pending = queries.find((q) => /SET status = 'pending', error/i.test(q.text))!
    expect(pending.text).toContain('attempts < 3')
    const failed = queries.find((q) => /SET status = 'failed'/i.test(q.text))!
    expect(failed.text).toContain('attempts >= 3')
  })

  it('getBrowserJob scopes to the user when userId given', async () => {
    const { sql } = fakeSql(() => [
      { id: 'j1', userId: USER, persona: 'friend', phone: null, kind: 'task', url: 'https://x.com', steps: null, goal: null, status: 'done', attempts: 1, result: 'ok', error: null },
    ])
    const job = await getBrowserJob(sql, 'j1', USER)
    expect(job?.status).toBe('done')
  })

  it('generateSessionViewToken creates valid cryptographic token for session view', () => {
    const token = generateSessionViewToken('job-123', USER)
    expect(token).toBeTruthy()
    expect(verifySessionViewToken('job-123', USER, token)).toBe(true)

    // Fails with wrong job ID
    expect(verifySessionViewToken('other-job', USER, token)).toBe(false)
    // Fails with wrong user ID
    expect(verifySessionViewToken('job-123', 'other-user', token)).toBe(false)
    // Fails with tampered token
    expect(verifySessionViewToken('job-123', USER, `${token}bad`)).toBe(false)
    // Fails with empty token
    expect(verifySessionViewToken('job-123', USER, '')).toBe(false)
  })

  it('caps session links at seven days', () => {
    const token = generateSessionViewToken('job-123', USER, 86_400)
    const expires = Number(token.split('.')[0])
    expect(expires - Math.floor(Date.now() / 1000)).toBeLessThanOrEqual(604_800)
  })
})

describe('agent action parser (the only path from JSON to the browser)', () => {
  it('verifies the exact amount beside a real total label', () => {
    expect(pageShowsExactTotal('Subtotal $15.00 Shipping $3.99 Order total $18.99', 1899)).toBe(true)
    expect(pageShowsExactTotal('Order total\nUSD 1,899.00', 189900)).toBe(true)
    expect(pageShowsExactTotal('Item price $18.99\nTotal $20.42', 1899)).toBe(false)
    expect(pageShowsExactTotal('Total $18.99', 1900)).toBe(false)
  })

  it('parses every documented action', () => {
    expect(parseAgentAction('{"action":"click","selector":"#submit"}')).toEqual({ type: 'click', selector: '#submit' })
    expect(parseAgentAction('{"action":"click_at","x":640,"y":320}')).toEqual({ type: 'click_at', x: 640, y: 320 })
    expect(parseAgentAction('{"action":"fill","selector":"#q","value":"hello"}')).toEqual({ type: 'fill', selector: '#q', value: 'hello' })
    expect(parseAgentAction('{"action":"type_text","value":"hello"}')).toEqual({ type: 'type_text', value: 'hello' })
    expect(parseAgentAction('{"action":"press","key":"Enter"}')).toEqual({ type: 'press', key: 'Enter' })
    expect(parseAgentAction('{"action":"navigate","url":"https://x.com/a"}')).toEqual({ type: 'navigate', url: 'https://x.com/a' })
    expect(parseAgentAction('{"action":"scroll","direction":"up"}')).toEqual({ type: 'scroll', direction: 'up' })
    expect(parseAgentAction('{"action":"wait","ms":99}')).toEqual({ type: 'wait', ms: 200 })
    expect(parseAgentAction('{"action":"fill_payment"}')).toEqual({ type: 'fill_payment' })
    expect(parseAgentAction('{"action":"handoff","kind":"verification","message":"Enter the code from your phone"}')).toEqual({ type: 'handoff', kind: 'verification', message: 'Enter the code from your phone' })
    expect(parseAgentAction('{"action":"handoff","kind":"payment","message":"Approve total","amount_cents":1899,"merchant":"amazon.com","item":"5lb Jasmine Rice"}')).toEqual({
      type: 'handoff', kind: 'payment', message: 'Approve total', amountCents: 1899, merchant: 'amazon.com', item: '5lb Jasmine Rice',
    })
    expect(parseAgentAction('{"action":"done","answer":"Balance is $4.20"}')).toEqual({ type: 'done', answer: 'Balance is $4.20' })
    expect(parseAgentAction('{"action":"giveup","reason":"login wall"}')).toEqual({ type: 'giveup', reason: 'login wall' })
  })

  it('tolerates markdown fences and prose around the JSON', () => {
    const raw = '```json\n{"action":"done","answer":"$4.20"}\n```'
    expect(parseAgentAction(raw)).toEqual({ type: 'done', answer: '$4.20' })
  })

  it('rejects junk, non-https navigate, missing selectors, giant payloads', () => {
    expect(parseAgentAction('')).toBeNull()
    expect(parseAgentAction('not json at all')).toBeNull()
    expect(parseAgentAction('{"action":"exec","code":"process.exit(1)"}')).toBeNull()
    expect(parseAgentAction('{"action":"click"}')).toBeNull()
    expect(parseAgentAction('{"action":"click_at","x":9000,"y":20}')).toBeNull()
    expect(parseAgentAction('{"action":"navigate","url":"http://evil.com"}')).toBeNull()
    expect(parseAgentAction('{"action":"navigate","url":"javascript:alert(1)"}')).toBeNull()
    expect(parseAgentAction('{"action":"done"}')).toBeNull()
    expect(parseAgentAction('{"action":"handoff","kind":"secret","message":"do it"}')).toBeNull()
    expect(parseAgentAction('{"action":"handoff","kind":"payment","message":"pay"}')).toBeNull()
    expect(parseAgentAction('{"action":"handoff","kind":"payment","message":"pay","amount_cents":1899.5,"merchant":"x.com","item":"one item"}')).toBeNull()
    expect(parseAgentAction(`{"action":"click","selector":"${'x'.repeat(5000)}"}`)).toBeNull()
  })

  it('terminal detection: done and giveup only', () => {
    expect(isTerminal({ type: 'done', answer: 'x' })).toBe(true)
    expect(isTerminal({ type: 'giveup', reason: 'y' })).toBe(true)
    expect(isTerminal({ type: 'click', selector: 'a' })).toBe(false)
  })
})

describe('vision caller + parts', () => {
  it('builds text + image parts with goal, url, and recent actions', () => {
    const parts = buildVisionParts({
      pageText: 'Welcome back',
      url: 'https://portal.nseindia.com/dash',
      screenshotBase64: 'QUJD',
      goal: 'Find the portfolio value',
      stepNumber: 3,
      recentActions: ['click #nav', 'scroll down (failed)'],
    }) as Array<{ type: string; text?: string; image_url?: { url: string } }>
    expect(parts[0]!.type).toBe('text')
    expect(parts[0]!.text).toContain('Find the portfolio value')
    expect(parts[0]!.text).toContain('avoid repeating')
    expect(parts[0]!.text).toContain('PAYMENT STATUS: not authorized')
    expect(parts[1]!.image_url!.url).toContain('data:image/jpeg;base64,QUJD')
  })

  it('pins an approved Link credential to the exact authorized total', () => {
    const parts = buildVisionParts({
      pageText: 'Order total $18.99',
      url: 'https://shop.example/checkout',
      screenshotBase64: 'QUJD',
      goal: 'Buy one bag of rice',
      stepNumber: 8,
      recentActions: ['human completed payment handoff'],
      paymentAuthorized: true,
      paymentAmountCents: 1899,
    }) as Array<{ type: string; text?: string }>
    expect(parts[0]!.text).toContain('exactly $18.99')
    expect(parts[0]!.text).toContain('approved one-time credential')
  })

  it('makeVisionCaller posts to chat/completions and returns the message content', async () => {
    const realFetch = globalThis.fetch
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ choices: [{ message: { content: '{"action":"done","answer":"hi"}' } }] }), { status: 200 })) as typeof fetch
    try {
      const call = makeVisionCaller({ apiKey: 'k', baseUrl: 'https://api.gmi-serving.com/v1', model: 'test-model' })
      expect(await call(buildVisionParts({ pageText: '', url: 'https://x.com', screenshotBase64: 'z', goal: 'g', stepNumber: 1, recentActions: [] }))).toBe('{"action":"done","answer":"hi"}')
    } finally {
      globalThis.fetch = realFetch
    }
  })

  it('makeVisionCaller surfaces non-200s as errors (loop reports honestly)', async () => {
    const realFetch = globalThis.fetch
    globalThis.fetch = (async () => new Response('nope', { status: 503 })) as typeof fetch
    try {
      const call = makeVisionCaller({ apiKey: 'k', baseUrl: 'https://api.gmi-serving.com/v1', model: 'test-model' })
      await expect(call([])).rejects.toThrow('503')
    } finally {
      globalThis.fetch = realFetch
    }
  })
})
