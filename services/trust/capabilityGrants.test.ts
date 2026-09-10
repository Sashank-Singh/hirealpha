import { describe, expect, it } from 'bun:test'
import {
  beginCapabilityConsumption,
  canTransitionCapability,
  canonicalizeCapabilityRequest,
  capabilityRequestDigest,
  createCapabilityGrant,
  expireCapabilityGrants,
  finalizeCapabilityConsumption,
  isTerminalCapabilityStatus,
  normalizeExactOrigin,
  requestCapabilityRevocation,
  type CapabilityRequest,
} from './capabilityGrants'

type Captured = { text: string; values: unknown[] }

function fakeSql(rowsFor: (text: string, values: unknown[]) => unknown[] = () => []) {
  const queries: Captured[] = []
  const sql = ((strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.join('?')
    queries.push({ text, values })
    return Promise.resolve(rowsFor(text, values))
  }) as never
  return { sql, queries }
}

const BASE: CapabilityRequest = {
  userId: 'user-1',
  taskId: 'task-1',
  resourceType: 'credential',
  resourceId: 'credential-1',
  action: 'autofill',
  exactOrigin: 'https://Example.com/login?next=/account',
  requestingAgent: 'alpha-coworker',
  purpose: 'Sign in to read the user-approved account page',
  expiresAt: '2026-09-10T05:00:00.000Z',
}

describe('capability request canonicalization', () => {
  it('normalizes a URL to an exact HTTPS origin', () => {
    expect(normalizeExactOrigin('https://EXAMPLE.com:443/path?q=1')).toBe('https://example.com')
    expect(normalizeExactOrigin('https://example.com:8443/path')).toBe('https://example.com:8443')
  })

  it('rejects insecure origins and embedded credentials', () => {
    for (const value of ['http://example.com', 'https://user:pass@example.com', 'javascript:alert(1)', 'not-a-url']) {
      expect(() => normalizeExactOrigin(value)).toThrow()
    }
  })

  it('produces the same digest after harmless URL normalization', () => {
    const first = capabilityRequestDigest(BASE)
    const second = capabilityRequestDigest({ ...BASE, exactOrigin: 'https://example.com:443/another/path' })
    expect(first).toBe(second)
  })

  it('does not depend on object insertion order for canonical input', () => {
    const canonical = canonicalizeCapabilityRequest(BASE)
    const reordered = Object.fromEntries(Object.entries(canonical).reverse()) as unknown as typeof canonical
    expect(capabilityRequestDigest(reordered)).toBe(capabilityRequestDigest(canonical))
  })

  it('changes the digest for every security-relevant mutation', () => {
    const digest = capabilityRequestDigest(BASE)
    const mutations: CapabilityRequest[] = [
      { ...BASE, userId: 'user-2' },
      { ...BASE, taskId: 'task-2' },
      { ...BASE, resourceId: 'credential-2' },
      { ...BASE, action: 'submit' },
      { ...BASE, exactOrigin: 'https://evil.example' },
      { ...BASE, requestingAgent: 'different-agent' },
      { ...BASE, purpose: 'Different purpose' },
      { ...BASE, expiresAt: '2026-09-10T05:01:00.000Z' },
    ]
    for (const mutation of mutations) expect(capabilityRequestDigest(mutation)).not.toBe(digest)
  })

  it('binds payment approval to recipient and exact cart total', () => {
    const payment: CapabilityRequest = {
      ...BASE,
      resourceType: 'payment',
      resourceId: 'link-wallet-1',
      action: 'purchase',
      amountCents: 2_500,
      currency: 'usd',
      merchant: 'Example Store',
      recipient: 'Jane Doe',
      cart: [{ sku: 'BOOK-1', description: 'Book', quantity: 2, unitAmountCents: 1_250 }],
    }
    const canonical = canonicalizeCapabilityRequest(payment)
    expect(canonical.currency).toBe('USD')
    expect(canonical.amount_cents).toBe(2_500)
    expect(capabilityRequestDigest({ ...payment, recipient: 'Mallory' })).not.toBe(capabilityRequestDigest(payment))
    expect(() => canonicalizeCapabilityRequest({ ...payment, amountCents: 2_501 })).toThrow('Cart total')
  })

  it('rejects payment fields on non-payment grants', () => {
    expect(() => canonicalizeCapabilityRequest({ ...BASE, amountCents: 100 })).toThrow('Payment scope')
  })
})

describe('capability lifecycle', () => {
  it('allows only explicit safe transitions', () => {
    expect(canTransitionCapability('pending', 'approved')).toBe(true)
    expect(canTransitionCapability('approved', 'consuming')).toBe(true)
    expect(canTransitionCapability('consuming', 'needs_reconciliation')).toBe(true)
    expect(canTransitionCapability('consumed', 'approved')).toBe(false)
    expect(canTransitionCapability('denied', 'consuming')).toBe(false)
    expect(isTerminalCapabilityStatus('consumed')).toBe(true)
    expect(isTerminalCapabilityStatus('needs_reconciliation')).toBe(false)
  })

  it('stores only the digest and canonical scope, never a secret', async () => {
    const { sql, queries } = fakeSql()
    const created = await createCapabilityGrant(sql, BASE)
    expect(created.digest).toHaveLength(64)
    const insert = queries[0]!
    expect(insert.text).toContain('INSERT INTO capability_grants')
    expect(insert.values.some((value) => Buffer.isBuffer(value))).toBe(true)
    expect(JSON.stringify(insert.values)).not.toContain('password')
  })

  it('atomically consumes only an approved, unexpired, unrevoked exact digest', async () => {
    const row = { id: 'grant-1', status: 'consuming' }
    const { sql, queries } = fakeSql((text) => text.includes("status = 'consuming'") ? [row] : [])
    const result = await beginCapabilityConsumption(sql, {
      id: 'grant-1', userId: 'user-1', taskId: 'task-1', digest: capabilityRequestDigest(BASE),
    })
    expect(result).toBe(row as never)
    const claim = queries[0]!
    expect(claim.text).toContain("status = 'approved'")
    expect(claim.text).toContain('expires_at > now()')
    expect(claim.text).toContain('revocation_requested_at IS NULL')
    expect(claim.values).toContain('user-1')
    expect(claim.values).toContain('task-1')
  })

  it('rejects malformed digests before querying the database', async () => {
    const { sql, queries } = fakeSql()
    await expect(beginCapabilityConsumption(sql, {
      id: 'grant-1', userId: 'user-1', taskId: 'task-1', digest: 'not-a-digest',
    })).rejects.toThrow('SHA-256')
    expect(queries).toHaveLength(0)
  })

  it('requests cancellation instead of lying about an in-flight revocation', async () => {
    const { sql } = fakeSql(() => [{ status: 'consuming' }])
    expect(await requestCapabilityRevocation(sql, { id: 'grant-1', userId: 'user-1', taskId: 'task-1' }))
      .toBe('cancellation_requested')
  })

  it('moves an unknown side-effect outcome to reconciliation, never retry', async () => {
    const { sql, queries } = fakeSql(() => [{ status: 'needs_reconciliation' }])
    expect(await finalizeCapabilityConsumption(sql, {
      id: 'grant-1', userId: 'user-1', taskId: 'task-1', outcome: 'unknown', providerReference: 'provider-op-1',
    })).toBe('needs_reconciliation')
    expect(queries[0]!.values).toContain('needs_reconciliation')
    expect(queries[0]!.text).toContain("status = 'consuming'")
  })

  it('expires stale grants in bounded SKIP LOCKED batches', async () => {
    const rows = [{ id: 'grant-1' }, { id: 'grant-2' }]
    const { sql, queries } = fakeSql(() => rows)
    expect(await expireCapabilityGrants(sql)).toBe(2)
    const query = queries[0]!
    expect(query.text).toContain("status IN ('proposed', 'pending', 'approved')")
    expect(query.text).toContain('expires_at <= now()')
    expect(query.text).toContain('SKIP LOCKED')
    expect(query.text).toContain('LIMIT ?')
    expect(query.values).toContain(500)
  })

  it('caps the expiry sweep to a sane batch size', async () => {
    const { sql, queries } = fakeSql(() => [])
    await expireCapabilityGrants(sql, 100_000)
    expect(queries[0]!.values).toContain(5000)
  })
})
