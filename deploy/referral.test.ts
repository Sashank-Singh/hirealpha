import { afterEach, describe, expect, it } from 'bun:test'
import { claimInvite, handleHireApi } from './hire-api'

/* Referral rewards: a redeemed invite code earns the referrer one free month
 * (a hire_referral_credits row), and the next checkout spends it as a 100% off
 * coupon. A burned or double-credited month here is real money, so each step
 * of the ledger is pinned against the captured-SQL fake. */

type Captured = { text: string; values: unknown[] }

function fakeSql(rowsFor: (text: string) => unknown[] = () => []) {
  const queries: Captured[] = []
  const sql = ((strings: TemplateStringsArray, ...values: unknown[]) => {
    queries.push({ text: strings.join('?'), values })
    return Promise.resolve(rowsFor(strings.join('?')))
  }) as unknown as Parameters<typeof claimInvite>[0]
  return { sql, queries }
}

const REFERRER = '+15550001111'
const FRIEND = '+15550002222'

function userRow(phone: string | null) {
  return { id: 'u-test', email: 'a@b.co', name: 'Alpha', timezone: 'America/Los_Angeles', phone }
}

describe('claimInvite credits', () => {
  it('inserts a referral credit for the referrer when a code is redeemed', async () => {
    const { sql, queries } = fakeSql((text) =>
      /FROM hire_invites WHERE code/i.test(text) ? [{ referrer: REFERRER, redeemed: null }] : [],
    )
    const result = await claimInvite(sql, FRIEND, 'ALPHA-ABC234')
    expect(result.ok).toBe(true)
    const credit = queries.find((q) => /INSERT INTO hire_referral_credits/i.test(q.text))
    expect(credit).toBeTruthy()
    expect(credit!.values).toContain(REFERRER)
    expect(credit!.values).toContain('ALPHA-ABC234')
    // One credit per code, enforced in the insert itself.
    expect(credit!.text).toContain('ON CONFLICT (source_code) DO NOTHING')
  })
})

describe('/api/invites/status', () => {
  it('counts only unused credits as free months', async () => {
    const { sql } = fakeSql((text) => {
      if (/SELECT code FROM hire_invites/i.test(text)) return [{ code: 'ALPHA-ABC234' }, { code: 'ALPHA-DEF345' }]
      if (/FROM hire_invites\s.*WHERE phone_e164.*redeemed_by_phone IS NOT NULL/is.test(text)) return [{ n: 2 }]
      if (/FROM hire_referral_rewards/i.test(text)) return []
      if (/FROM hire_referral_credits/i.test(text)) return [{ n: 1 }]
      return []
    })
    const res = await handleHireApi(
      new Request('https://hirealpha.chat/api/invites/status?phone=%2B15550001111'),
      sql as never,
    )
    expect(res?.status).toBe(200)
    const data = (await res?.json()) as { codes?: string[]; redeemedCount?: number; freeMonths?: number }
    expect(data.codes).toEqual(['ALPHA-ABC234', 'ALPHA-DEF345'])
    expect(data.redeemedCount).toBe(2)
    expect(data.freeMonths).toBe(1)
  })
})

/* ---- Checkout harness: Stripe over stubbed fetch, SQL captured ---- */

const STRIPE_ENV = ['STRIPE_SECRET_KEY', 'STRIPE_PRICE_FRIEND']
const savedStripe = new Map<string, string | undefined>()

type StripeCall = { url: string; method: string; body: string }

function stubStripe(handler: (call: StripeCall) => Record<string, unknown> | { status: number; data: Record<string, unknown> }) {
  const calls: StripeCall[] = []
  const original = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    const call: StripeCall = {
      url,
      method: String(init?.method || 'GET'),
      body: String(init?.body || ''),
    }
    if (url.startsWith('https://api.stripe.com/')) {
      calls.push(call)
      const out = handler(call)
      const status = 'status' in out ? out.status : 200
      const data = 'status' in out ? out.data : out
      return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } })
    }
    return original(input, init)
  }) as typeof fetch
  return calls
}

function checkoutSql(rows: { credits?: unknown[]; phone: string | null }) {
  return fakeSql((text) => {
    if (/FROM hire_users/i.test(text)) return [userRow(rows.phone)]
    if (/FROM hire_referral_credits/i.test(text) && /SELECT id/i.test(text)) return rows.credits ?? []
    return []
  })
}

function checkoutRequest() {
  return new Request('https://hirealpha.chat/api/billing/checkout', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'a@b.co', hire: 'friend', plan: 'single' }),
  })
}

afterEach(() => {
  for (const [k, v] of savedStripe) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
  savedStripe.clear()
})

function withStripeEnv() {
  for (const k of STRIPE_ENV) {
    savedStripe.set(k, process.env[k])
    process.env[k] = k === 'STRIPE_SECRET_KEY' ? 'sk_test_referral' : 'price_friend_test'
  }
}

describe('/api/billing/checkout with a referral credit', () => {
  it('creates the coupon, adds the discounts param, and marks the credit used', async () => {
    withStripeEnv()
    const { sql, queries } = checkoutSql({ phone: REFERRER, credits: [{ id: 'c-1' }] })
    const calls = stubStripe((call) => {
      if (call.url.endsWith('/v1/coupons')) return { id: 'referral-u-test' }
      if (call.url.endsWith('/v1/checkout/sessions')) return { id: 'cs_1', url: 'https://checkout.stripe.com/pay/cs_1' }
      return { status: 400, data: { error: { message: 'unexpected stripe call' } } }
    })
    const res = await handleHireApi(checkoutRequest(), sql as never)
    expect(res?.status).toBe(200)
    // The coupon is created before the session, with the fixed properties.
    const create = calls.find((c) => c.url.endsWith('/v1/coupons'))
    expect(create).toBeTruthy()
    expect(create!.body).toContain('percent_off=100')
    expect(create!.body).toContain('duration=once')
    expect(create!.body).toContain('name=Referral+free+month')
    // The session carries the coupon as a discount.
    const session = calls.find((c) => c.url.endsWith('/v1/checkout/sessions'))
    expect(session!.body).toContain('discounts%5B0%5D%5Bcoupon%5D=referral-u-test')
    // Spent immediately at checkout creation, not at completion.
    const spent = queries.find((q) => /UPDATE hire_referral_credits/i.test(q.text))
    expect(spent).toBeTruthy()
    expect(spent!.text).toContain('used_at = now()')
    expect(spent!.values).toContain('friend')
  })

  it('reuses an existing coupon when create reports resource_already_exists', async () => {
    withStripeEnv()
    const { sql } = checkoutSql({ phone: REFERRER, credits: [{ id: 'c-1' }] })
    stubStripe((call) => {
      if (call.url.endsWith('/v1/coupons') && call.method === 'POST')
        return { status: 400, data: { error: { code: 'resource_already_exists', message: 'Coupon already exists.' } } }
      if (call.url.endsWith('/v1/coupons/referral-u-test')) return { id: 'referral-u-test' }
      if (call.url.endsWith('/v1/checkout/sessions')) return { id: 'cs_1', url: 'https://checkout.stripe.com/pay/cs_1' }
      return { status: 400, data: { error: { message: 'unexpected stripe call' } } }
    })
    const res = await handleHireApi(checkoutRequest(), sql as never)
    expect(res?.status).toBe(200)
    const data = (await res?.json()) as { url?: string }
    expect(data.url).toBe('https://checkout.stripe.com/pay/cs_1')
  })
})

describe('/api/billing/checkout without a credit', () => {
  it('adds no discounts param and burns nothing', async () => {
    withStripeEnv()
    const { sql, queries } = checkoutSql({ phone: REFERRER, credits: [] })
    const calls = stubStripe((call) =>
      call.url.endsWith('/v1/checkout/sessions')
        ? { id: 'cs_2', url: 'https://checkout.stripe.com/pay/cs_2' }
        : { status: 400, data: { error: { message: 'no coupon calls expected' } } },
    )
    const res = await handleHireApi(checkoutRequest(), sql as never)
    expect(res?.status).toBe(200)
    const session = calls.find((c) => c.url.endsWith('/v1/checkout/sessions'))
    expect(session).toBeTruthy()
    expect(session!.body).not.toContain('discounts')
    // No coupon attempt, no credit spent.
    expect(calls.find((c) => c.url.endsWith('/v1/coupons'))).toBeUndefined()
    expect(queries.find((q) => /UPDATE hire_referral_credits/i.test(q.text))).toBeUndefined()
  })

  it('skips credits entirely for an email-only account', async () => {
    withStripeEnv()
    const { sql, queries } = checkoutSql({ phone: null })
    const calls = stubStripe((call) =>
      call.url.endsWith('/v1/checkout/sessions')
        ? { id: 'cs_3', url: 'https://checkout.stripe.com/pay/cs_3' }
        : { status: 400, data: { error: { message: 'no coupon calls expected' } } },
    )
    const res = await handleHireApi(checkoutRequest(), sql as never)
    expect(res?.status).toBe(200)
    const session = calls.find((c) => c.url.endsWith('/v1/checkout/sessions'))
    expect(session!.body).not.toContain('discounts')
    expect(queries.find((q) => /hire_referral_credits/i.test(q.text))).toBeUndefined()
  })
})
