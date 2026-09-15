import { describe, expect, it } from 'bun:test'
import {
  ASK_FIRST,
  AUTHORITY_ASK_REASONS,
  bindGrant,
  decide,
  isAlwaysAsk,
  parsePolicy,
  policyAuditSummary,
  simulatePolicy,
  type AuthorityPolicy,
  type SpendRequest,
} from './authority'

function policy(overrides: Partial<AuthorityPolicy> = {}): AuthorityPolicy {
  return {
    id: 'p-1',
    scope: { merchantHosts: ['example.com'], categories: ['software-subscription'], maxCents: 5000 },
    window: { perDayLimitCents: 10000, perMerchantMaxCents: 8000 },
    enabled: true,
    ...overrides,
  }
}

function greenRequest(overrides: Partial<SpendRequest> = {}): SpendRequest {
  return {
    merchantHost: 'example.com',
    category: 'software-subscription',
    priceCents: 2500,
    currency: 'USD',
    expires_at: '2026-09-15T00:00:00Z',
    ...overrides,
  }
}

/* ------------------------------------------------------------- parsePolicy */

describe('parsePolicy', () => {
  it('accepts a valid object policy and keeps hosts lowercased', () => {
    const p = parsePolicy({
      id: 'tools',
      scope: { merchantHosts: ['Example.COM', 'example.com', 'notion.so'], categories: ['saas'], maxCents: 1000 },
      window: { perDayLimitCents: 5000, perMerchantMaxCents: 3000 },
      enabled: false,
    })
    expect(p.scope.merchantHosts).toEqual(['example.com', 'notion.so'])
    expect(p.enabled).toBe(false)
  })

  it('accepts a JSON string', () => {
    const p = parsePolicy(
      JSON.stringify({
        id: 's',
        scope: { merchantHosts: ['a.com'], categories: [], maxCents: 1 },
        window: { perDayLimitCents: 0, perMerchantMaxCents: 0 },
        enabled: true,
        graceAskAboveCents: 500,
      }),
    )
    expect(p.graceAskAboveCents).toBe(500)
  })

  it('rejects an empty host list', () => {
    expect(() =>
      parsePolicy({
        id: 's',
        scope: { merchantHosts: [], categories: [], maxCents: 100 },
        window: { perDayLimitCents: 1, perMerchantMaxCents: 1 },
        enabled: true,
      }),
    ).toThrow(/non-empty/)
  })

  it('rejects hosts carrying a scheme or a path', () => {
    const base = {
      id: 's',
      scope: { categories: [], maxCents: 100 },
      window: { perDayLimitCents: 1, perMerchantMaxCents: 1 },
      enabled: true,
    }
    for (const bad of ['https://example.com', 'example.com/login', 'user@example.com', 'example.com:8443', 'exa mple.com']) {
      expect(() => parsePolicy({ ...base, scope: { ...base.scope, merchantHosts: [bad] } })).toThrow()
    }
  })

  it('rejects maxCents <= 0', () => {
    expect(() =>
      parsePolicy({
        id: 's',
        scope: { merchantHosts: ['a.com'], categories: [], maxCents: 0 },
        window: { perDayLimitCents: 1, perMerchantMaxCents: 1 },
        enabled: true,
      }),
    ).toThrow(/maxCents/)
  })

  it('rejects unknown keys at every level, fail closed', () => {
    expect(() =>
      parsePolicy({
        id: 's',
        scope: { merchantHosts: ['a.com'], categories: [], maxCents: 1 },
        window: { perDayLimitCents: 0, perMerchantMaxCents: 0 },
        enabled: true,
        autoSpendAll: true,
      }),
    ).toThrow(/unknown key/)
    expect(() =>
      parsePolicy({
        id: 's',
        scope: { merchantHosts: ['a.com'], categories: [], maxCents: 1, wildcard: '*.com' },
        window: { perDayLimitCents: 0, perMerchantMaxCents: 0 },
        enabled: true,
      }),
    ).toThrow(/unknown key/)
  })

  it('rejects non-boolean enabled (defaults never flip silently)', () => {
    expect(() =>
      parsePolicy({
        id: 's',
        scope: { merchantHosts: ['a.com'], categories: [], maxCents: 1 },
        window: { perDayLimitCents: 0, perMerchantMaxCents: 0 },
        enabled: 'yes',
      }),
    ).toThrow(/enabled/)
  })
})

describe('policyAuditSummary', () => {
  it('describes a policy with non-secret facts only', () => {
    const summary = policyAuditSummary(policy({ graceAskAboveCents: 900 }))
    expect(summary).toEqual({
      policy_id: 'p-1',
      enabled: true,
      always_ask: false,
      merchant_hosts: ['example.com'],
      categories: ['software-subscription'],
      max_cents: 5000,
      per_day_limit_cents: 10000,
      per_merchant_max_cents: 8000,
      grace_ask_above_cents: 900,
    })
    expect(JSON.stringify(summary)).not.toContain('expires')
  })
})

/* ------------------------------------------------------------------ decide */

describe('decide', () => {
  it('auto on a fully green request', () => {
    const d = decide(policy(), greenRequest())
    expect(d).toEqual({ verdict: 'auto', reasons: [] })
  })

  it('boundary: price equal to caps is still within budget', () => {
    const d = decide(policy(), greenRequest({ priceCents: 5000 }), {
      spentTodayCents: 5000,
      spentTodayForMerchant: 3000,
    })
    expect(d.verdict).toBe('auto')
  })

  // One assertion per reason path.
  it.each([
    ['disabled', () => decide(policy({ enabled: false }), greenRequest())],
    ['merchant-not-allowed', () => decide(policy(), greenRequest({ merchantHost: 'other.com' }))],
    ['category-not-allowed', () => decide(policy(), greenRequest({ category: 'flight' }))],
    ['price-unknown', () => decide(policy(), greenRequest({ priceCents: null }))],
    ['over-policy-cap', () => decide(policy(), greenRequest({ priceCents: 5001 }))],
    ['over-grace-threshold', () => decide(policy({ graceAskAboveCents: 1000 }), greenRequest({ priceCents: 1001 }))],
    ['over-daily-budget', () => decide(policy(), greenRequest(), { spentTodayCents: 8000 })],
    ['over-merchant-budget', () => decide(policy(), greenRequest(), { spentTodayForMerchant: 6000 })],
    ['currency-uncovered', () => decide(policy(), greenRequest({ currency: 'EUR' }))],
  ] as const)('reason %s is present and forces ask', (reason, run) => {
    const d = run()
    expect(d.verdict).toBe('ask')
    expect(d.reasons).toContain(reason)
  })

  it('every declared reason code is reachable', () => {
    const covered = new Set(
      [
        decide(policy({ enabled: false }), greenRequest()),
        decide(policy(), greenRequest({ merchantHost: 'other.com' })),
        decide(policy(), greenRequest({ category: 'flight' })),
        decide(policy(), greenRequest({ priceCents: undefined })),
        decide(policy(), greenRequest({ priceCents: 9999 })),
        decide(policy({ graceAskAboveCents: 1 }), greenRequest()),
        decide(policy(), greenRequest(), { spentTodayCents: 99999 }),
        decide(policy(), greenRequest(), { spentTodayForMerchant: 99999 }),
        decide(policy(), greenRequest({ currency: undefined })),
      ].flatMap((d) => d.reasons),
    )
    expect([...AUTHORITY_ASK_REASONS].every((r) => covered.has(r))).toBe(true)
  })

  it('multiple failed gates contribute multiple reasons and never auto', () => {
    const d = decide(policy({ enabled: false }), greenRequest({ merchantHost: 'x.com', currency: 'GBP' }))
    expect(d.verdict).toBe('ask')
    expect(d.reasons).toEqual(['disabled', 'merchant-not-allowed', 'currency-uncovered'])
  })

  it('host match is exact but case-insensitive', () => {
    expect(decide(policy(), greenRequest({ merchantHost: 'EXAMPLE.com ' })).verdict).toBe('auto')
  })

  it('subdomain deception is rejected (evil.example.com must not match example.com)', () => {
    for (const host of ['evil.example.com', 'example.com.evil.net', 'notexample.com']) {
      const d = decide(policy(), greenRequest({ merchantHost: host }))
      expect(d.reasons).toContain('merchant-not-allowed')
      expect(d.verdict).toBe('ask')
    }
  })

  it('unknown price asks even with a blown-out history and never touches budget gates', () => {
    const d = decide(policy(), greenRequest({ priceCents: Number.NaN }), { spentTodayCents: 99999 })
    expect(d).toEqual({ verdict: 'ask', reasons: ['price-unknown'] })
  })

  it('price-unknown alone with a clean history forces ask', () => {
    const d = decide(policy(), greenRequest({ priceCents: undefined }))
    expect(d).toEqual({ verdict: 'ask', reasons: ['price-unknown'] })
  })

  it('missing currency is currency-uncovered (single-currency until proven)', () => {
    expect(decide(policy(), greenRequest({ currency: ' usd ' })).verdict).toBe('auto')
    expect(decide(policy(), greenRequest({ currency: null })).reasons).toContain('currency-uncovered')
  })
})

/* -------------------------------------------------------------- simulation */

describe('simulatePolicy', () => {
  it('counts auto vs ask and breaks ask down by reason', () => {
    const p = policy()
    const samples: SpendRequest[] = [
      greenRequest(), // auto
      greenRequest(), // auto
      greenRequest({ merchantHost: 'evil.example.com' }), // merchant-not-allowed
      greenRequest({ priceCents: 6000 }), // over-policy-cap
      greenRequest({ priceCents: null }), // price-unknown
      greenRequest({ currency: 'EUR' }), // currency-uncovered
      greenRequest({ merchantHost: 'nope.com', currency: 'JPY' }), // two reasons, one ask
    ]
    const s = simulatePolicy(p, samples)
    expect(s.auto).toBe(2)
    expect(s.ask).toBe(5)
    expect(s.askBreakdown).toEqual({
      'merchant-not-allowed': 2,
      'over-policy-cap': 1,
      'price-unknown': 1,
      'currency-uncovered': 2,
    })
    expect(s.auto + s.ask).toBe(samples.length)
  })

  it('is pure: the input requests and the policy are untouched', () => {
    const p = policy()
    const samples = [greenRequest()]
    const before = JSON.stringify({ p, samples })
    simulatePolicy(p, samples)
    expect(JSON.stringify({ p, samples })).toBe(before)
  })

  it('simulates a disabled policy as all-ask', () => {
    const s = simulatePolicy(policy({ enabled: false }), [greenRequest(), greenRequest()])
    expect(s).toEqual({ auto: 0, ask: 2, askBreakdown: { disabled: 2 } })
  })
})

/* ---------------------------------------------------------------- bindGrant */

describe('bindGrant', () => {
  it('mirrors capability scope with values only, never secrets', () => {
    const b = bindGrant(policy(), greenRequest({ merchantHost: 'Example.com' }))
    expect(b).toEqual({
      policy_id: 'p-1',
      merchant_host: 'example.com',
      total_cents: 2500,
      currency: 'USD',
      expires_at: '2026-09-15T00:00:00Z',
    })
  })

  it('rejects a missing total', () => {
    expect(() => bindGrant(policy(), greenRequest({ priceCents: undefined }))).toThrow(/total_cents/)
  })

  it('rejects a missing or unparsable expiry', () => {
    expect(() => bindGrant(policy(), greenRequest({ expires_at: null }))).toThrow(/expiry/)
    expect(() => bindGrant(policy(), greenRequest({ expires_at: 'soon' }))).toThrow(/expires_at/)
  })

  it('rejects a missing currency and non-three-letter codes', () => {
    expect(() => bindGrant(policy(), greenRequest({ currency: undefined }))).toThrow(/currency/)
    expect(() => bindGrant(policy(), greenRequest({ currency: 'DOLLARS' }))).toThrow(/three-letter/)
  })

  it('refuses to bind a host outside the policy scope', () => {
    expect(() => bindGrant(policy(), greenRequest({ merchantHost: 'evil.example.com' }))).toThrow(/outside policy/)
  })

  it('refuses a total above the policy cap', () => {
    expect(() => bindGrant(policy(), greenRequest({ priceCents: 99999 }))).toThrow(/cap/)
  })
})

/* ------------------------------------------------------------ ask-first law */

describe('ask-first default', () => {
  const anyRequests: SpendRequest[] = [
    greenRequest(),
    greenRequest({ merchantHost: 'evil.example.com' }),
    greenRequest({ priceCents: 1 }),
    { merchantHost: 'example.com', category: 'software-subscription', priceCents: 10, currency: 'USD' },
    {},
  ]

  it('ASK_FIRST is always-ask', () => {
    expect(isAlwaysAsk(ASK_FIRST)).toBe(true)
  })

  it('ASK_FIRST yields ask for every conceivable request', () => {
    for (const request of anyRequests) {
      const d = decide(ASK_FIRST, request, { spentTodayCents: 0, spentTodayForMerchant: 0 })
      expect(d.verdict).toBe('ask')
      expect(d.reasons).toContain('disabled')
    }
  })

  it('simulatePolicy over ASK_FIRST asks for all of them', () => {
    const s = simulatePolicy(ASK_FIRST, anyRequests)
    expect(s.auto).toBe(0)
    expect(s.ask).toBe(anyRequests.length)
  })

  it('a policy with no reachable auto is still always-ask even when enabled', () => {
    const emptyCategories = policy({ scope: { ...policy().scope, categories: [] } })
    expect(isAlwaysAsk(emptyCategories)).toBe(true)
    const zeroDaily = policy({ window: { perDayLimitCents: 0, perMerchantMaxCents: 8000 } })
    expect(isAlwaysAsk(zeroDaily)).toBe(true)
    expect(isAlwaysAsk(policy())).toBe(false)
  })
})
