import { describe, expect, it } from 'bun:test'
import {
  answerBrowserHandoff,
  beginBrowserHandoff,
  claimBrowserJobs,
  enqueueBrowserJob,
  findAwaitingQuestionJob,
  finishBrowserJob,
  generateSessionViewToken,
  getBrowserJob,
  verifySessionViewToken,
  waitForBrowserHandoff,
  waitForBrowserHandoffAnswer,
} from './browserJobs'
import {
  buildVisionParts,
  DEFAULT_AGENT_LIMITS,
  executeAgentAction,
  isTerminal,
  makeVisionCaller,
  pageShowsExactTotal,
  parseAgentAction,
  parseVerification,
} from './agentDriver'
import { executeKernelAction, readVerifiedKernelPurchase } from './kernelSession'

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
    const { sql, queries } = fakeSql((text, values) => /RETURNING id/i.test(text) ? [{ id: String(values?.[0]) }] : [])
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

  it('returns the existing active job when a duplicate launch loses the unique race', async () => {
    const { sql, queries } = fakeSql((text) => {
      if (/INSERT INTO hire_browser_jobs/i.test(text)) return []
      if (/SELECT id, status FROM hire_browser_jobs/i.test(text)) return [{ id: 'existing-job', status: 'pending' }]
      return []
    })
    const id = await enqueueBrowserJob(sql, {
      userId: USER,
      persona: 'friend',
      phone: '+14155550100',
      kind: 'task',
      url: 'https://campusnet.csuohio.edu',
      goal: 'Check Fall 2024 payment history',
      approvalId: 'fresh-approval',
      resolveHost: async () => ['93.184.216.34'],
    })
    expect(id).toBe('existing-job')
    expect(queries.some((q) => /status IN \('pending', 'running', 'waiting'\)/i.test(q.text))).toBe(true)
    const refresh = queries.find((q) => /UPDATE hire_browser_jobs SET[\s\S]*approval_id/i.test(q.text))
    expect(refresh).toBeTruthy()
    expect(refresh!.values).toContain('fresh-approval')
  })

  it('never replaces authority on a running duplicate job', async () => {
    const { sql, queries } = fakeSql((text) => {
      if (/INSERT INTO hire_browser_jobs/i.test(text)) return []
      if (/SELECT id, status FROM hire_browser_jobs/i.test(text)) return [{ id: 'running-job', status: 'running' }]
      return []
    })
    const id = await enqueueBrowserJob(sql, {
      userId: USER,
      persona: 'friend',
      phone: '+14155550100',
      kind: 'task',
      url: 'https://campusnet.csuohio.edu',
      goal: 'Check Fall 2024 payment history',
      approvalId: 'new-approval',
      resolveHost: async () => ['93.184.216.34'],
    })
    expect(id).toBe('running-job')
    expect(queries.some((q) => /UPDATE hire_browser_jobs SET[\s\S]*approval_id/i.test(q.text))).toBe(false)
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

  it('tolerates markdown fences, prose, and bracketed reasoning around the JSON', () => {
    const raw = '```json\n{"action":"done","answer":"$4.20"}\n```'
    expect(parseAgentAction(raw)).toEqual({ type: 'done', answer: '$4.20' })
    const reasoningWithBrackets = '<think>I see { item: 123 } on page. Next action should be click.</think>\n{"action":"click","selector":"#submit"}'
    expect(parseAgentAction(reasoningWithBrackets)).toEqual({ type: 'click', selector: '#submit' })
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

  it('makeVisionCaller returns reasoning_content if content is omitted', async () => {
    const realFetch = globalThis.fetch
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ choices: [{ message: { reasoning_content: '{"action":"click","selector":"#ok"}' } }] }), { status: 200 })) as typeof fetch
    try {
      const call = makeVisionCaller({ apiKey: 'k', baseUrl: 'https://api.gmi-serving.com/v1', model: 'test-model' })
      expect(await call([])).toBe('{"action":"click","selector":"#ok"}')
    } finally {
      globalThis.fetch = realFetch
    }
  })

  it('makeVisionCaller gracefully falls back to text-only if image decoding fails with 400', async () => {
    const realFetch = globalThis.fetch
    let attempts = 0
    globalThis.fetch = (async (_url: unknown, init?: { body?: string }) => {
      attempts++
      const body = JSON.parse(init?.body || '{}')
      const hasImage = body.messages?.[1]?.content?.some((p: any) => p?.type === 'image_url')
      if (hasImage) {
        return new Response('Failed to decode image data', { status: 400 })
      }
      return new Response(JSON.stringify({ choices: [{ message: { content: '{"action":"press","key":"Enter"}' } }] }), { status: 200 })
    }) as typeof fetch
    try {
      const call = makeVisionCaller({ apiKey: 'k', baseUrl: 'https://api.gmi-serving.com/v1', model: 'test-model' })
      const parts = [
        { type: 'text', text: 'prompt' },
        { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,123' } },
      ]
      const res = await call(parts)
      expect(res).toBe('{"action":"press","key":"Enter"}')
      expect(attempts).toBe(2)
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

describe('answer evidence verification', () => {
  it('fails closed when the auditor returns malformed output', () => {
    expect(parseVerification('', 'Hotel Alpha: $189.00')).toEqual({
      supported: false,
      unsupported: ['verification response was not valid JSON'],
    })
    expect(parseVerification('{"answer":"looks good"}', 'Hotel Alpha: $189.00')).toEqual({
      supported: false,
      unsupported: ['verification response did not contain an items array'],
    })
  })
})

describe('real-site pacing and explicit action failures', () => {
  it('budgets the measured real-run time with headroom', () => {
    // Live booking runs measured 76-293s on the happy path, before a slow
    // page, a retry, or a handoff. The wall must clear that comfortably.
    expect(DEFAULT_AGENT_LIMITS.wallMs).toBeGreaterThanOrEqual(450_000)
    expect(DEFAULT_AGENT_LIMITS.maxSteps).toBeGreaterThanOrEqual(30)
    expect(DEFAULT_AGENT_LIMITS.maxSteps).toBeLessThanOrEqual(60)
  })

  it('caps one vision step so a hot model tier cannot eat the whole run', async () => {
    const realFetch = globalThis.fetch
    const hangUntilAbort = (_url: unknown, init?: { signal?: AbortSignal }) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('aborted by budget')))
      })
    globalThis.fetch = hangUntilAbort as unknown as typeof fetch
    try {
      const call = makeVisionCaller({
        apiKey: 'k',
        baseUrl: 'https://api.gmi-serving.com/v1',
        model: 'm1',
        fallbackModels: ['m2'],
        timeoutMs: 40,
        totalBudgetMs: 250,
      })
      const started = Date.now()
      await expect(call([])).rejects.toThrow(/budget|aborted/)
      expect(Date.now() - started).toBeLessThan(2_000)
    } finally {
      globalThis.fetch = realFetch
    }
  })

  it('reports why a navigation failed instead of pretending it worked', async () => {
    const page = {
      goto: async () => { throw new Error('net::ERR_TIMED_OUT at https://slow.example/') },
    } as unknown as import('playwright').Page
    const outcome = await executeAgentAction(page, { type: 'navigate', url: 'https://slow.example/' })
    expect(outcome.ok).toBe(false)
    expect(outcome.error).toContain('ERR_TIMED_OUT')
  })

  it('rechecks the live Playwright checkout total before filling an approved card', async () => {
    const page = {
      evaluate: async () => 'Order total $20.42',
      frames: () => { throw new Error('card fields must not be touched when the total changed') },
    } as unknown as import('playwright').Page
    const outcome = await executeAgentAction(page, { type: 'fill_payment' }, {
      number: '4242424242424242', cvc: '123', expMonth: '12', expYear: '2030',
    }, 1899)
    expect(outcome).toEqual({ ok: false, error: 'the live checkout total no longer matches the approved amount' })
  })

  it('uses live Kernel page text to validate the approved total', async () => {
    const scripts: string[] = []
    const browser = {
      run: async (script: string) => {
        scripts.push(script)
        if (script.includes('document.body?.innerText')) return 'Order total $18.99'
        return { ok: true }
      },
    } as unknown as import('./kernelPage').KernelBrowser
    const outcome = await executeKernelAction(browser, { type: 'fill_payment' }, {
      url: 'https://shop.example/checkout',
      paymentAuthorized: true,
      paymentAmountCents: 1899,
      paymentCard: { number: '4242424242424242', cvc: '123', expMonth: '12', expYear: '2030' },
    })
    expect(outcome.ok).toBe(true)
    expect(scripts.some((script) => script.includes('document.body?.innerText'))).toBe(true)
  })

  it('requires structured checkout data plus the same rendered total', async () => {
    const browser = {
      run: async () => ({
        amountCents: 2306, currency: 'USD', merchant: 'shop.example',
        item: 'One notebook', url: 'https://shop.example/checkout',
      }),
      text: async () => 'One notebook\nOrder total USD $23.06',
    } as unknown as import('./kernelPage').KernelBrowser
    expect(await readVerifiedKernelPurchase(browser)).toEqual({
      amountCents: 2306, currency: 'USD', merchant: 'shop.example',
      item: 'One notebook', url: 'https://shop.example/checkout',
    })
  })

  it('fails payment verification when the structured and rendered totals disagree', async () => {
    const browser = {
      run: async () => ({
        amountCents: 2306, currency: 'USD', merchant: 'shop.example',
        item: 'One notebook', url: 'https://shop.example/checkout',
      }),
      text: async () => 'Order total USD $29.99',
    } as unknown as import('./kernelPage').KernelBrowser
    expect(await readVerifiedKernelPurchase(browser)).toBeNull()
  })
})

/* ============================================================================
 * Route A: chat answers for paused browser runs. The agent may ask a
 * `question`; the user's reply (iMessage or the session page) lands in
 * handoff_answer, resumes the run, and is surfaced to the agent loop.
 * ========================================================================== */

describe('chat-answer handoff (Route A)', () => {
  it('parses a question handoff action', () => {
    expect(parseAgentAction('{"action":"handoff","kind":"question","message":"What is the billing zip code"}'))
      .toEqual({ type: 'handoff', kind: 'question', message: 'What is the billing zip code' })
  })

  it('rejects a question handoff with no message', () => {
    expect(parseAgentAction('{"action":"handoff","kind":"question","message":""}')).toBeNull()
  })

  it('answerBrowserHandoff resumes only a waiting question row', async () => {
    const { sql, queries } = fakeSql((text) => (text.includes('RETURNING id') ? [{ id: 'job-1' }] : []))
    expect(await answerBrowserHandoff(sql, 'job-1', '94105')).toBe(true)
    const query = queries[0]!.text
    expect(query).toContain("status = 'waiting'")
    expect(query).toContain("handoff_kind = 'question'")
    expect(query).toContain("SET status = 'running'")
    expect(query).toContain('handoff_answer')
  })

  it('a non-question handoff is never resumed by a chat answer', async () => {
    const { sql } = fakeSql()
    expect(await answerBrowserHandoff(sql, 'job-1', '94105')).toBe(false)
  })

  it('beginBrowserHandoff clears a stale answer when arming a new wait', async () => {
    const { sql, queries } = fakeSql()
    await beginBrowserHandoff(sql, 'job-1', 'question', 'What is the billing zip code')
    expect(queries[0]!.text).toContain('handoff_answer = NULL')
  })

  it('waitForBrowserHandoffAnswer surfaces the answer on resume', async () => {
    const { sql } = fakeSql((text) => (
      text.includes('SELECT status, handoff_resumed_at, handoff_answer')
        ? [{ status: 'running', handoff_resumed_at: new Date(), handoff_answer: '94105' }]
        : []
    ))
    expect(await waitForBrowserHandoffAnswer(sql, 'job-1')).toEqual({ outcome: 'resumed', answer: '94105' })
  })

  it('findAwaitingQuestionJob scopes to waiting question rows', async () => {
    const { sql, queries } = fakeSql((text) => (
      text.includes('FROM hire_browser_jobs') ? [{ id: 'job-9', handoff_message: 'What is the billing zip code' }] : []
    ))
    const job = await findAwaitingQuestionJob(sql, 'user-1')
    expect(job?.id).toBe('job-9')
    expect(queries[0]!.text).toContain("handoff_kind = 'question'")
    expect(queries[0]!.text).toContain("status = 'waiting'")
  })

  it('waitForBrowserHandoff auto-resumes when checkAutoResume detects completed login', async () => {
    let resumedRow = false
    const { sql, queries } = fakeSql((text) => {
      if (text.includes('UPDATE hire_browser_jobs')) {
        resumedRow = true
        return [{ id: 'job-1' }]
      }
      if (text.includes('SELECT status, handoff_resumed_at')) {
        return resumedRow
          ? [{ status: 'running', handoff_resumed_at: new Date() }]
          : [{ status: 'waiting', handoff_resumed_at: null }]
      }
      return []
    })

    let checked = false
    const outcome = await waitForBrowserHandoff(sql, 'job-1', 5_000, async () => {
      checked = true
      return { resumed: true, reason: 'User logged in: navigated to dashboard' }
    })

    expect(checked).toBe(true)
    expect(outcome).toBe('resumed')
    expect(queries.some((q) => q.text.includes("status = 'running'"))).toBe(true)
  })
})
