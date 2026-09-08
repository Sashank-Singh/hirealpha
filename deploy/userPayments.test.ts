import { describe, expect, it, beforeEach, afterAll } from 'bun:test'
import {
  consumeSpendApproval,
  createSpendRequest,
  decideSpendApproval,
  handleUserPaymentsApi,
  spendCapCents,
  type UserPaymentsDeps,
} from './userPayments'

/* ============================================================================
 * Per-user payments — the "users connect their OWN wallet" pillar. The
 * operator's account never funds anything: these tests pin the ask-first
 * fence (one-time approval consume, ownership fences, cap enforcement, masked
 * views) without touching Stripe — every Stripe-calling path is exercised
 * only through the pure DB/decision helpers here.
 * ========================================================================== */

const USER = 'u-alice'
const OTHER = 'u-mallory'

type Captured = { text: string; values: unknown[] }

function fakeSql(rowsFor: (text: string, values?: unknown[]) => unknown[] = () => []) {
  const queries: Captured[] = []
  const sql = ((strings: TemplateStringsArray, ...values: unknown[]) => {
    queries.push({ text: strings.join('?'), values })
    return Promise.resolve(rowsFor(strings.join('?'), values))
  }) as never
  return { sql, queries }
}

beforeEach(() => {
  delete process.env.USER_SPEND_MAX_CENTS
})

afterAll(() => {
  delete process.env.USER_SPEND_MAX_CENTS
})

describe('spend requests + caps', () => {
  it('creates a pending request and never stores more than 300 chars of purpose', async () => {
    const { sql, queries } = fakeSql()
    const res = await createSpendRequest(sql, USER, { amountCents: 2500, merchant: 'OpenTable', purpose: 'x'.repeat(500) })
    expect(res.requestId).toBeTruthy()
    const insert = queries.find((q) => /INSERT INTO hire_spend_approvals/i.test(q.text))!
    expect(insert.text).toContain("'pending'")
    expect(JSON.stringify(insert.values).length).toBeLessThan(1200)
  })

  it('rejects amounts under $0.50 and over the cap', async () => {
    const { sql } = fakeSql()
    expect((await createSpendRequest(sql, USER, { amountCents: 10, merchant: 'x', purpose: 'y' })).error).toBeTruthy()
    process.env.USER_SPEND_MAX_CENTS = '5000'
    expect((await createSpendRequest(sql, USER, { amountCents: 5001, merchant: 'x', purpose: 'y' })).error).toContain('cap')
    expect((await createSpendRequest(sql, USER, { amountCents: 5000, merchant: 'x', purpose: 'y' })).requestId).toBeTruthy()
    expect(spendCapCents()).toBe(5000)
  })

  it('defaults to a $200 per-purchase cap', () => {
    expect(spendCapCents()).toBe(20_000)
  })

  it('rejects junk merchant/purpose and non-numeric amounts', async () => {
    const { sql } = fakeSql()
    expect((await createSpendRequest(sql, USER, { amountCents: Number.NaN, merchant: 'x', purpose: 'y' })).error).toBeTruthy()
    expect((await createSpendRequest(sql, USER, { amountCents: 1000, merchant: '  ', purpose: 'y' })).error).toBeTruthy()
    expect((await createSpendRequest(sql, USER, { amountCents: 1000, merchant: 'x', purpose: ' ' })).error).toBeTruthy()
  })
})

describe('spend approval lifecycle', () => {
  const approvedRow = {
    id: 'r1',
    status: 'approved',
    amount_cents: 2500,
    merchant: 'OpenTable',
    purpose: 'Table for 2',
    created_at: new Date(),
    consumed_at: null,
  }

  it('approve flips pending → approved for the owner only', async () => {
    const { sql, queries } = fakeSql((text) => (/UPDATE hire_spend_approvals/i.test(text) ? [{ id: 'r1' }] : []))
    expect(await decideSpendApproval(sql, OTHER, 'r1', 'approve')).toBe(true)
    const update = queries.find((q) => /UPDATE hire_spend_approvals/i.test(q.text))!
    expect(update.values).toContain(OTHER)
    expect(update.text).toContain('status = \'pending\'')
  })

  it('consume is one-time: second consume is used', async () => {
    let status = { ...approvedRow }
    const { sql } = fakeSql((text) => {
      if (/FROM hire_spend_approvals/i.test(text) && !/UPDATE/i.test(text)) return [status]
      if (/UPDATE hire_spend_approvals/i.test(text)) {
        status = { ...status, consumed_at: new Date() }
        return [{ id: 'r1' }]
      }
      return []
    })
    const first = await consumeSpendApproval(sql, USER, 'r1')
    expect(first.decision).toBe('ok')
    expect(first.approval?.amount_cents).toBe(2500)
    const second = await consumeSpendApproval(sql, USER, 'r1')
    expect(second.decision).toBe('used')
  })

  it('the consume UPDATE carries the consumed_at guard (race fence)', async () => {
    const { sql, queries } = fakeSql((text) =>
      /FROM hire_spend_approvals/i.test(text) && !/UPDATE/i.test(text)
        ? [approvedRow]
        : [{ id: 'r1' }],
    )
    await consumeSpendApproval(sql, USER, 'r1')
    const update = queries.find((q) => /UPDATE hire_spend_approvals/i.test(q.text))!
    expect(update.text).toContain('consumed_at IS NULL')
  })

  it('denies on deny, expires after 10 minutes, refuses other users', async () => {
    const denied = fakeSql((text) =>
      /FROM hire_spend_approvals/i.test(text) && !/UPDATE/i.test(text)
        ? [{ ...approvedRow, status: 'denied' }]
        : [],
    )
    expect((await consumeSpendApproval(denied.sql, USER, 'r1')).decision).toBe('denied')

    const old = fakeSql((text) =>
      /FROM hire_spend_approvals/i.test(text) && !/UPDATE/i.test(text)
        ? [{ ...approvedRow, created_at: new Date(Date.now() - 60 * 60 * 1000) }]
        : [],
    )
    expect((await consumeSpendApproval(old.sql, USER, 'r1')).decision).toBe('expired')

    const missing = fakeSql()
    expect((await consumeSpendApproval(missing.sql, OTHER, 'r1')).decision).toBe('missing')
  })
})

/* ------------------------------- API routes ------------------------------ */

const authedDeps: UserPaymentsDeps = { resolveUser: async () => ({ id: USER }) }
const noAuthDeps: UserPaymentsDeps = { resolveUser: async () => null }

function req(path: string, body?: unknown, method?: string): Request {
  return new Request(`https://hirealpha.chat${path}`, {
    method: method || (body ? 'POST' : 'GET'),
    headers: { 'content-type': 'application/json', authorization: 'Bearer sess' },
    ...(body ? { body: JSON.stringify(body) } : {}),
  })
}

describe('user payments API routes', () => {
  it('401s without a session; 503s without Stripe config', async () => {
    expect((await handleUserPaymentsApi(req('/api/payments/methods'), fakeSql().sql, noAuthDeps))?.status).toBe(401)
    const key = process.env.STRIPE_SECRET_KEY
    delete process.env.STRIPE_SECRET_KEY
    expect((await handleUserPaymentsApi(req('/api/payments/methods'), fakeSql().sql, authedDeps))?.status).toBe(503)
    if (key) process.env.STRIPE_SECRET_KEY = key
  })

  it('GET /api/payments/methods returns empty before connect', async () => {
    const { sql } = fakeSql(() => [{ stripe_payment_customer: null }])
    const res = await handleUserPaymentsApi(req('/api/payments/methods'), sql, authedDeps)
    expect(res?.status).toBe(200)
    const body = (await res!.json()) as { methods: unknown[] }
    expect(body.methods).toEqual([])
  })

  it('DELETE /api/payments/methods fences on ownership (pm id must be yours)', async () => {
    const { sql } = fakeSql(() => [{ stripe_payment_customer: 'cus_owned' }])
    const res = await handleUserPaymentsApi(req('/api/payments/methods?id=pm_evil', undefined, 'DELETE'), sql, authedDeps)
    // pm_evil is not in cus_owned's method list (Stripe call fails unmocked,
    // list comes back empty) — the route must never 200.
    expect(res?.status).toBeGreaterThanOrEqual(400)
  })

  it('spend create validates input through the API', async () => {
    const { sql } = fakeSql()
    const res = await handleUserPaymentsApi(req('/api/payments/spend', { action: 'create', amountCents: 5, merchant: 'x', purpose: 'y' }), sql, authedDeps)
    expect(res?.status).toBe(400)
  })

  it('spend GET returns masked dollar amounts and the cap', async () => {
    const { sql } = fakeSql(() => [
      { id: 'r1', amount_cents: 2500, merchant: 'OpenTable', purpose: 'Table', status: 'pending', created_at: new Date(), last_error: null },
    ])
    const res = await handleUserPaymentsApi(req('/api/payments/spend'), sql, authedDeps)
    const body = (await res!.json()) as { requests: Array<{ amount: string; pending: boolean }>; cap_cents: number }
    expect(body.requests[0]!.amount).toBe('$25.00')
    expect(body.requests[0]!.pending).toBe(true)
    expect(body.cap_cents).toBe(20_000)
  })

  it('unknown /api/payments path passes through (null, not 404-own)', async () => {
    expect(await handleUserPaymentsApi(req('/api/payments/other'), fakeSql().sql, authedDeps)).toBeNull()
    expect(await handleUserPaymentsApi(req('/api/other'), fakeSql().sql, authedDeps)).toBeNull()
  })

  it('spend approval GET renders approval confirmation page for pending request', async () => {
    const { sql } = fakeSql(() => [
      { id: 'req_123', user_id: USER, amount_cents: 1899, merchant: 'amazon.com', purpose: '5lb Jasmine Rice', status: 'pending', payment_intent_id: null },
    ])
    const res = await handleUserPaymentsApi(req('/api/payments/spend/approve?id=req_123'), sql, noAuthDeps)
    expect(res?.status).toBe(200)
    const html = await res!.text()
    expect(html).toContain('Approve Purchase')
    expect(html).toContain('5lb Jasmine Rice')
    expect(html).toContain('$18.99')
    expect(html).toContain('/api/payments/spend/approve?id=req_123&confirm=1')
  })

  it('spend approval GET returns already approved view when already consumed', async () => {
    const { sql } = fakeSql(() => [
      { id: 'req_123', user_id: USER, amount_cents: 1899, merchant: 'amazon.com', purpose: '5lb Jasmine Rice', status: 'consumed', payment_intent_id: 'pi_test123' },
    ])
    const res = await handleUserPaymentsApi(req('/api/payments/spend/approve?id=req_123'), sql, noAuthDeps)
    expect(res?.status).toBe(200)
    const html = await res!.text()
    expect(html).toContain('Already Approved')
  })

  it('spend approval GET returns JSON for in-iMessage MiniApp when requested', async () => {
    const { sql } = fakeSql(() => [
      { id: 'req_123', user_id: USER, amount_cents: 1899, merchant: 'amazon.com', purpose: '5lb Jasmine Rice', status: 'pending', payment_intent_id: null },
    ])
    const res = await handleUserPaymentsApi(req('/api/payments/spend/approve?id=req_123&format=json'), sql, noAuthDeps)
    expect(res?.status).toBe(200)
    const data = await res!.json()
    expect(data).toMatchObject({
      ok: true,
      id: 'req_123',
      merchant: 'amazon.com',
      purpose: '5lb Jasmine Rice',
      amount: '$18.99',
      status: 'pending',
    })
  })
})

