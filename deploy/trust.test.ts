import {afterAll, afterEach, beforeEach, describe, expect, it} from 'bun:test'
import { generateInviteCode, handleHireApi, PERSONAS } from './hire-api'

/* The trust surface: invite codes people read aloud over iMessage, a kill
 * switch a person can arm before a hire texts them, the public status page,
 * receipts for what a hire did, and the wishlist tally. These pin the shapes
 * the clients build against. */

type Captured = { text: string; values: unknown[] }

function fakeSql(rowsFor: (text: string) => unknown[] = () => []) {
  const queries: Captured[] = []
  const sql = ((strings: TemplateStringsArray, ...values: unknown[]) => {
    queries.push({ text: strings.join('?'), values })
    return Promise.resolve(rowsFor(strings.join('?')))
  }) as unknown as Parameters<typeof handleHireApi>[1]
  return { sql, queries }
}

function route(
  path: string,
  opts: { method?: string; body?: unknown; key?: boolean } = {},
) {
  return new Request(`https://hirealpha.chat${path}`, {
    method: opts.method || 'GET',
    headers: {
      'Content-Type': 'application/json',
      ...(opts.key ? { Authorization: 'Bearer test-key' } : {}),
    },
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  })
}

const saved: Record<string, string | undefined> = {}

beforeEach(() => {
  saved.key = process.env.HIREALPHA_INTERNAL_KEY
  process.env.HIREALPHA_INTERNAL_KEY = 'test-key'
  saved.secret = process.env.STRIPE_SECRET_KEY
})

afterAll(() => {
  if (saved.key === undefined) delete process.env.HIREALPHA_INTERNAL_KEY
  else process.env.HIREALPHA_INTERNAL_KEY = saved.key
  if (saved.secret === undefined) delete process.env.STRIPE_SECRET_KEY
  else process.env.STRIPE_SECRET_KEY = saved.secret
  delete process.env.STRIPE_PRICE_BUNDLE
  delete process.env.STRIPE_PRICE_BUNDLE_ANNUAL
  delete process.env.STRIPE_PRICE_ULTRA
  delete process.env.FREE_TIER_LIMIT
  delete process.env.RETENTION_DAYS
})

describe('generateInviteCode', () => {
  it('always produces ALPHA plus six unconfusable characters', () => {
    const allowed = /^[A-HJ-KM-NP-Z2-9]{6}$/
    for (let i = 0; i < 200; i++) {
      const code = generateInviteCode()
      expect(code.startsWith('ALPHA-')).toBe(true)
      expect(allowed.test(code.slice('ALPHA-'.length))).toBe(true)
    }
  })

  it('does not repeat itself across a big batch', () => {
    const codes = new Set(Array.from({ length: 500 }, () => generateInviteCode()))
    expect(codes.size).toBeGreaterThan(490)
  })
})

describe('invite routes', () => {
  it('returns the codes already on the phone', async () => {
    const { sql } = fakeSql((text) =>
      /FROM hire_invites/i.test(text) ? [{ code: 'ALPHA-AAAAAA' }, { code: 'ALPHA-BBBBBB' }, { code: 'ALPHA-CCCCCC' }] : [],
    )
    const res = await handleHireApi(route('/api/invites/for-phone?phone=(415)%20555-1212'), sql)
    expect(res!.status).toBe(200)
    const body = (await res!.json()) as { codes: string[] }
    expect(body.codes.length).toBe(3)
    expect(body.codes[0]).toBe('ALPHA-AAAAAA')
  })

  it('rejects a phone too short to be real', async () => {
    const { sql, queries } = fakeSql()
    const res = await handleHireApi(route('/api/invites/for-phone?phone=123'), sql)
    expect(res!.status).toBe(400)
    expect(queries.length).toBe(0)
  })

  it('redeem marks the row used and names the referrer', async () => {
    const { sql, queries } = fakeSql((text) =>
      /FROM hire_invites/i.test(text) ? [{ referrer: '+14155550000', redeemed: null }] : [],
    )
    const res = await handleHireApi(
      route('/api/invites/redeem', { method: 'POST', body: { code: 'alpha-aaaaaa', phone: '+14155551212' } }),
      sql,
    )
    expect(res!.status).toBe(200)
    const body = (await res!.json()) as { ok: boolean; referrer: string }
    expect(body.ok).toBe(true)
    expect(body.referrer).toBe('+14155550000')
    const update = queries.find((q) => q.text.includes('UPDATE hire_invites'))
    expect(update?.values).toContain('+14155551212')
  })

  it('redeem refuses a code that was already used', async () => {
    const { sql, queries } = fakeSql((text) =>
      /FROM hire_invites/i.test(text) ? [{ referrer: '+14155550000', redeemed: '+19995550000' }] : [],
    )
    const res = await handleHireApi(
      route('/api/invites/redeem', { method: 'POST', body: { code: 'ALPHA-AAAAAA', phone: '+14155551212' } }),
      sql,
    )
    expect(res!.status).toBe(409)
    expect(queries.some((q) => q.text.includes('UPDATE hire_invites'))).toBe(false)
  })

  it('position counts earlier signups plus the email waitlist', async () => {
    const { sql } = fakeSql(() => [{ ahead: 41, waiting: 7 }])
    const res = await handleHireApi(route('/api/invites/position?phone=+14155551212'), sql)
    expect(res!.status).toBe(200)
    const body = (await res!.json()) as { position: number }
    expect(body.position).toBe(48)
  })
})

describe('kill switch routes', () => {
  it('defaults to not armed when the phone never touched the switch', async () => {
    const { sql } = fakeSql()
    const res = await handleHireApi(route('/api/kill-switch?phone=+14155551212'), sql)
    expect(res!.status).toBe(200)
    expect(await res!.json()).toEqual({ armed: false })
  })

  it('arming sticks and reads back through the public and internal routes', async () => {
    const { sql, queries } = fakeSql()
    const armed = await handleHireApi(
      route('/api/kill-switch', { method: 'POST', body: { phone: '(415) 555-1212', armed: true } }),
      sql,
    )
    expect(armed!.status).toBe(200)
    const upsert = queries.find((q) => q.text.includes('INSERT INTO hire_kill_switch'))
    expect(upsert?.text).toContain('ON CONFLICT (phone_e164) DO UPDATE')
    expect(upsert?.values).toContain('+14155551212')
    expect(upsert?.values).toContain(true)

    const read = await handleHireApi(route('/api/kill-switch?phone=+14155551212'), sql)
    expect(await read!.json()).toEqual({ armed: false }) // fake db never returns the row
    const check = await handleHireApi(
      route('/api/internal/kill-switch/check', { method: 'POST', key: true, body: { phone: '+14155551212' } }),
      sql,
    )
    expect(check!.status).toBe(200)
    expect(await check!.json()).toEqual({ armed: false })
  })

  it('the internal check needs the internal key', async () => {
    const { sql } = fakeSql()
    const res = await handleHireApi(
      route('/api/internal/kill-switch/check', { method: 'POST', body: { phone: '+14155551212' } }),
      sql,
    )
    expect(res!.status).toBe(401)
  })
})

describe('status aggregation', () => {
  it('marks a hire up only while its last beat is fresh', async () => {
    const now = Date.now()
    const { sql } = fakeSql(() => [
      { persona: 'friend', lastBeat: new Date(now - 60 * 1000).toISOString(), replyMs: 812 },
      { persona: 'coworker', lastBeat: new Date(now - 30 * 60 * 1000).toISOString(), replyMs: null },
    ])
    const res = await handleHireApi(route('/api/status'), sql)
    expect(res!.status).toBe(200)
    const body = (await res!.json()) as {
      hires: Record<string, { up: boolean; lastReplyMs: number | null }>
    }
    expect(Object.keys(body.hires).sort()).toEqual([...PERSONAS].sort())
    expect(body.hires.friend).toEqual({ up: true, lastReplyMs: 812 })
    expect(body.hires.coworker).toEqual({ up: false, lastReplyMs: null })
    expect(body.hires.cofounder).toEqual({ up: false, lastReplyMs: null })
  })

  it('heartbeat needs the internal key and upserts by persona', async () => {
    const { sql, queries } = fakeSql()
    const denied = await handleHireApi(
      route('/api/internal/heartbeat', { method: 'POST', body: { persona: 'friend' } }),
      sql,
    )
    expect(denied!.status).toBe(401)
    const ok = await handleHireApi(
      route('/api/internal/heartbeat', { method: 'POST', key: true, body: { persona: 'friend', replyMs: 640 } }),
      sql,
    )
    expect(ok!.status).toBe(200)
    const upsert = queries.find((q) => q.text.includes('INSERT INTO hire_heartbeat'))
    expect(upsert?.text).toContain('ON CONFLICT (persona) DO UPDATE')
    expect(upsert?.values).toContain('friend')
  })
})

describe('action log routes', () => {
  it('internal actions record a receipt for the phone owner', async () => {
    const { sql, queries } = fakeSql((text) =>
      /FROM hire_users/i.test(text) ? [{ id: 'u1' }] : [],
    )
    const res = await handleHireApi(
      route('/api/internal/actions', {
        method: 'POST',
        key: true,
        body: { phone: '+14155551212', persona: 'friend', action: 'refunded', detail: 'Uber credit $12', undo_hint: 'reply UNDO' },
      }),
      sql,
    )
    expect(res!.status).toBe(200)
    const body = (await res!.json()) as { ok: boolean; id: string }
    expect(body.ok).toBe(true)
    expect(body.id).toBeTruthy()
    const insert = queries.find((q) => q.text.includes('INSERT INTO hire_action_log'))
    expect(insert?.values).toContain('u1')
    expect(insert?.values).toContain('refunded')
  })

  it('actions list returns the last 20 for all personas of a phone', async () => {
    const { sql } = fakeSql((text) =>
      /FROM hire_users/i.test(text) ? [{ id: 'u1' }] : /FROM hire_action_log/i.test(text)
        ? [{ id: 'a1', persona: 'friend', action: 'refunded', detail: '', undoHint: null, undoneAt: null, createdAt: new Date() }]
        : [],
    )
    const res = await handleHireApi(route('/api/actions?phone=+14155551212'), sql)
    expect(res!.status).toBe(200)
    const body = (await res!.json()) as { actions: Array<{ id: string }> }
    expect(body.actions[0].id).toBe('a1')
  })

  it('undo just marks the row', async () => {
    const { sql, queries } = fakeSql()
    const res = await handleHireApi(route('/api/actions/a1/undo', { method: 'POST' }), sql)
    expect(res!.status).toBe(200)
    expect(queries[0].text).toContain('undone_at = now()')
  })
})

describe('handoff route', () => {
  it('queues a handoff loop for the receiving hire', async () => {
    const { sql, queries } = fakeSql((text) =>
      /FROM hire_users/i.test(text) ? [{ id: 'u1' }] : [],
    )
    const res = await handleHireApi(
      route('/api/internal/handoff', {
        method: 'POST',
        key: true,
        body: { fromPersona: 'friend', toPersona: 'coworker', phone: '(415) 555-1212', note: 'saw the invoice' },
      }),
      sql,
    )
    expect(res!.status).toBe(200)
    const body = (await res!.json()) as { ok: boolean }
    expect(body.ok).toBe(true)
    const insert = queries.find((q) => q.text.includes('INSERT INTO hire_task_loops'))
    expect(insert?.values).toContain('coworker')
    expect(insert?.text).toContain("'handoff'")
    expect(insert?.text).toContain('ON CONFLICT (user_id, persona, kind) DO UPDATE')
  })

  it('rejects a bad persona pair', async () => {
    const { sql, queries } = fakeSql()
    const res = await handleHireApi(
      route('/api/internal/handoff', {
        method: 'POST',
        key: true,
        body: { fromPersona: 'friend', toPersona: 'boss', phone: '+14155551212' },
      }),
      sql,
    )
    expect(res!.status).toBe(400)
    expect(queries.length).toBe(0)
  })
})

describe('wishlist routes', () => {
  it('one vote per phone per idea', async () => {
    const { sql, queries } = fakeSql()
    const res = await handleHireApi(
      route('/api/wishlist', { method: 'POST', body: { phone: '(415) 555-1212', vote: 'email digests' } }),
      sql,
    )
    expect(res!.status).toBe(200)
    const insert = queries.find((q) => q.text.includes('INSERT INTO hire_wishlist'))
    expect(insert?.text).toContain('ON CONFLICT (phone_e164, vote) DO NOTHING')
    expect(insert?.values).toContain('+14155551212')
  })

  it('the tally is sorted, highest first', async () => {
    const { sql } = fakeSql(() => [
      { vote: 'email digests', count: '9' },
      { vote: 'voice notes', count: '3' },
    ])
    const res = await handleHireApi(route('/api/wishlist'), sql)
    expect(res!.status).toBe(200)
    const body = (await res!.json()) as { ideas: Array<{ vote: string; count: number }> }
    expect(body.ideas[0]).toEqual({ vote: 'email digests', count: 9 })
    expect(body.ideas[1].count).toBe(3)
  })
})

describe('billing checkout plans', () => {
  it('single stays the default and keeps the per-hire price', async () => {
    process.env.STRIPE_SECRET_KEY = 'sk_test'
    process.env.STRIPE_PRICE_COWORKER = 'price_monthly'
    const { sql } = fakeSql((text) =>
      /FROM hire_users/i.test(text) ? [{ id: 'u1' }] : [],
    )
    let posted = ''
    const realFetch = globalThis.fetch
    globalThis.fetch = (async (_url: unknown, init?: { body?: unknown }) => {
      posted = String(init?.body || '')
      return new Response(JSON.stringify({ url: 'https://stripe.test/session' }), { status: 200 })
    }) as typeof fetch
    try {
      const res = await handleHireApi(
        route('/api/billing/checkout', { method: 'POST', body: { email: 'a@b.co', hire: 'coworker' } }),
        sql,
      )
      expect(res!.status).toBe(200)
      const body = (await res!.json()) as { url: string; fallback: boolean }
      expect(body.url).toBe('https://stripe.test/session')
      expect(body.fallback).toBe(false)
      expect(posted).toContain('price_monthly')
      expect(posted).toContain('client_reference_id=u1%3Acoworker')
      expect(posted).toContain('subscription_data%5Btrial_period_days%5D=7')
    } finally {
      globalThis.fetch = realFetch
    }
  })

  it('bundle maps to the synthetic all persona and its own price', async () => {
    process.env.STRIPE_SECRET_KEY = 'sk_test'
    process.env.STRIPE_PRICE_BUNDLE = 'price_bundle'
    const { sql } = fakeSql((text) => (/FROM hire_users/i.test(text) ? [{ id: 'u1' }] : []))
    let posted = ''
    const realFetch = globalThis.fetch
    globalThis.fetch = (async (_url: unknown, init?: { body?: unknown }) => {
      posted = String(init?.body || '')
      return new Response(JSON.stringify({ url: 'https://stripe.test/session' }), { status: 200 })
    }) as typeof fetch
    try {
      const res = await handleHireApi(
        route('/api/billing/checkout', { method: 'POST', body: { email: 'a@b.co', plan: 'bundle' } }),
        sql,
      )
      expect(res!.status).toBe(200)
      expect(posted).toContain('price_bundle')
      expect(posted).toContain('client_reference_id=u1%3Aall')
      expect(posted).toContain('%5Bmetadata%5D%5Bpersona%5D=all')
    } finally {
      globalThis.fetch = realFetch
    }
  })

  it('ultra falls back to monthly with fallback true when no annual price exists', async () => {
    process.env.STRIPE_SECRET_KEY = 'sk_test'
    process.env.STRIPE_PRICE_ULTRA = 'price_ultra_monthly'
    const { sql } = fakeSql((text) => (/FROM hire_users/i.test(text) ? [{ id: 'u1' }] : []))
    let posted = ''
    const realFetch = globalThis.fetch
    globalThis.fetch = (async (_url: unknown, init?: { body?: unknown }) => {
      posted = String(init?.body || '')
      return new Response(JSON.stringify({ url: 'https://stripe.test/session' }), { status: 200 })
    }) as typeof fetch
    try {
      const res = await handleHireApi(
        route('/api/billing/checkout', { method: 'POST', body: { email: 'a@b.co', plan: 'ultra', interval: 'annual', trial_days: 30 } }),
        sql,
      )
      expect(res!.status).toBe(200)
      const body = (await res!.json()) as { fallback: boolean }
      expect(body.fallback).toBe(true)
      expect(posted).toContain('price_ultra_monthly')
      expect(posted).toContain('subscription_data%5Btrial_period_days%5D=30')
    } finally {
      globalThis.fetch = realFetch
    }
  })

  it('uses the annual price when it is configured', async () => {
    process.env.STRIPE_SECRET_KEY = 'sk_test'
    process.env.STRIPE_PRICE_BUNDLE = 'price_bundle_monthly'
    process.env.STRIPE_PRICE_BUNDLE_ANNUAL = 'price_bundle_annual'
    const { sql } = fakeSql((text) => (/FROM hire_users/i.test(text) ? [{ id: 'u1' }] : []))
    let posted = ''
    const realFetch = globalThis.fetch
    globalThis.fetch = (async (_url: unknown, init?: { body?: unknown }) => {
      posted = String(init?.body || '')
      return new Response(JSON.stringify({ url: 'https://stripe.test/session' }), { status: 200 })
    }) as typeof fetch
    try {
      const res = await handleHireApi(
        route('/api/billing/checkout', { method: 'POST', body: { email: 'a@b.co', plan: 'bundle', interval: 'annual' } }),
        sql,
      )
      expect(res!.status).toBe(200)
      const body = (await res!.json()) as { fallback: boolean }
      expect(body.fallback).toBe(false)
      expect(posted).toContain('price_bundle_annual')
    } finally {
      globalThis.fetch = realFetch
    }
  })

  it('accepts the landing page folded plan name and uses the annual price', async () => {
    process.env.STRIPE_SECRET_KEY = 'sk_test'
    process.env.STRIPE_PRICE_BUNDLE_ANNUAL = 'price_bundle_annual'
    const { sql } = fakeSql((text) => (/FROM hire_users/i.test(text) ? [{ id: 'u1' }] : []))
    let posted = ''
    const realFetch = globalThis.fetch
    globalThis.fetch = (async (_url: unknown, init?: { body?: unknown }) => {
      posted = String(init?.body || '')
      return new Response(JSON.stringify({ url: 'https://stripe.test/session' }), { status: 200 })
    }) as typeof fetch
    try {
      const res = await handleHireApi(
        route('/api/billing/checkout', { method: 'POST', body: { email: 'a@b.co', plan: 'bundle-annual' } }),
        sql,
      )
      expect(res!.status).toBe(200)
      const body = (await res!.json()) as { fallback: boolean }
      expect(body.fallback).toBe(false)
      expect(posted).toContain('price_bundle_annual')
      expect(posted).toContain('%5Bmetadata%5D%5Bpersona%5D=all')
    } finally {
      globalThis.fetch = realFetch
    }
  })

  it('a plan price that is not configured stays a 503', async () => {
    // Earlier tests in this file leak their price envs (by design: env restores
    // happen once in afterAll so cross-file pollution stays dead) — clear them
    // so this test really exercises the not-configured path.
    for (const k of Object.keys(process.env)) if (k.startsWith('STRIPE_PRICE_')) delete process.env[k]
    process.env.STRIPE_SECRET_KEY = 'sk_test'
    const { sql } = fakeSql((text) => (/FROM hire_users/i.test(text) ? [{ id: 'u1' }] : []))
    const res = await handleHireApi(
      route('/api/billing/checkout', { method: 'POST', body: { email: 'a@b.co', plan: 'ultra' } }),
      sql,
    )
    expect(res!.status).toBe(503)
  })
})

describe('internal mail context', () => {
  it('requires the internal key', async () => {
    const { sql } = fakeSql()
    const res = await handleHireApi(route('/api/internal/mail/context?phone=+14155551212'), sql)
    expect(res!.status).toBe(401)
  })

  it('maps rich gmail rows into the contract shape', async () => {
    const { sql } = fakeSql((text) =>
      /FROM hire_users/i.test(text) ? [{ id: 'u1' }] : [],
    )
    // loadGmailRich catches its own connector failures and returns [], which is
    // the graceful empty the refund hunter expects.
    const res = await handleHireApi(
      route('/api/internal/mail/context?phone=(415)%20555-1212', { key: true }),
      sql,
    )
    expect(res!.status).toBe(200)
    const body = (await res!.json()) as { mail: unknown[] }
    expect(Array.isArray(body.mail)).toBe(true)
  })
})
