import { afterEach, describe, expect, it } from 'bun:test'
import { paymentsEnabled, resetPaymentsCache } from '/Users/sashanksingh/Projects/HireAlpha/src/platform/paymentsConfig'

const realFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = realFetch
  resetPaymentsCache()
})

describe('paymentsEnabled', () => {
  it('is false when the server says free', async () => {
    globalThis.fetch = (async () => new Response(JSON.stringify({ payments: false }), { status: 200 })) as unknown as typeof fetch
    expect(await paymentsEnabled()).toBe(false)
  })

  it('is true when the server says paid', async () => {
    globalThis.fetch = (async () => new Response(JSON.stringify({ payments: true }), { status: 200 })) as unknown as typeof fetch
    expect(await paymentsEnabled()).toBe(true)
  })

  it('assumes free when the config cannot be read', async () => {
    globalThis.fetch = (async () => { throw new Error('offline') }) as unknown as typeof fetch
    expect(await paymentsEnabled()).toBe(false)
  })

  it('asks once and reuses the answer', async () => {
    let calls = 0
    globalThis.fetch = (async () => { calls++; return new Response(JSON.stringify({ payments: true }), { status: 200 }) }) as unknown as typeof fetch
    await paymentsEnabled()
    await paymentsEnabled()
    expect(calls).toBe(1)
  })
})
