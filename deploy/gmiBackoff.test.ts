import { describe, expect, it } from 'bun:test'

// Verify gmiChat retries 429 with backoff instead of surfacing a canned failure.
describe('gmi 429 backoff', () => {
  it('retries a rate limit once, after a wait long enough to clear the window', async () => {
    const { gmiChat } = await import('/Users/sashanksingh/Projects/HireAlpha/spectrum/shared/gmi')
    const realFetch = globalThis.fetch
    const times: number[] = []
    let calls = 0
    globalThis.fetch = (async () => {
      calls++
      times.push(Date.now())
      if (calls < 2) return new Response(JSON.stringify({ error: 'Rate limit exceeded' }), { status: 429 })
      return new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }), { status: 200 })
    }) as unknown as typeof fetch
    try {
      const reply = await gmiChat({ messages: [{ role: 'user', content: 'hi' }], timeoutMs: 20_000, apiKey: 'k' })
      expect(reply).toBe('ok')
      expect(calls).toBe(2)
      // Exactly one retry: a longer ladder is itself a burst and made the
      // refusals worse (measured). The wait clears the provider's per-second
      // window so the retry lands in a fresh one.
      expect(times[1]! - times[0]!).toBeGreaterThanOrEqual(1_000)
    } finally {
      globalThis.fetch = realFetch
    }
  }, 30_000)

  it('stops retrying when the deadline cannot fit another attempt', async () => {
    const { gmiChat } = await import('/Users/sashanksingh/Projects/HireAlpha/spectrum/shared/gmi')
    const realFetch = globalThis.fetch
    let calls = 0
    globalThis.fetch = (async () => { calls++; return new Response('{}', { status: 429 }) }) as unknown as typeof fetch
    try {
      await expect(gmiChat({ messages: [{ role: 'user', content: 'hi' }], timeoutMs: 700, apiKey: 'k' }))
        .rejects.toThrow('429')
      expect(calls).toBe(1)
    } finally {
      globalThis.fetch = realFetch
    }
  }, 15_000)
})

describe('gmi 400-body rate limits', () => {
  it('retries a 400 whose body says Rate limit exceeded', async () => {
    const { gmiChat } = await import('/Users/sashanksingh/Projects/HireAlpha/spectrum/shared/gmi')
    const realFetch = globalThis.fetch
    let calls = 0
    globalThis.fetch = (async () => {
      calls++
      if (calls < 2) {
        return new Response(JSON.stringify({ error: 'Rate limit exceeded' }), { status: 400 })
      }
      return new Response(JSON.stringify({ choices: [{ message: { content: 'recovered' } }] }), { status: 200 })
    }) as unknown as typeof fetch
    try {
      expect(await gmiChat({ messages: [{ role: 'user', content: 'hi' }], timeoutMs: 20_000, apiKey: 'k' })).toBe('recovered')
      expect(calls).toBe(2)
    } finally {
      globalThis.fetch = realFetch
    }
  }, 30_000)

  it('does not retry an unrelated 400', async () => {
    const { gmiChat } = await import('/Users/sashanksingh/Projects/HireAlpha/spectrum/shared/gmi')
    const realFetch = globalThis.fetch
    let calls = 0
    globalThis.fetch = (async () => {
      calls++
      return new Response(JSON.stringify({ error: 'invalid request' }), { status: 400 })
    }) as unknown as typeof fetch
    try {
      await expect(gmiChat({ messages: [{ role: 'user', content: 'hi' }], timeoutMs: 20_000, apiKey: 'k' })).rejects.toThrow('400')
      expect(calls).toBe(1)
    } finally {
      globalThis.fetch = realFetch
    }
  }, 15_000)
})
