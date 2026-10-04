import { describe, expect, it } from 'bun:test'

// Verify gmiChat retries 429 with backoff instead of surfacing a canned failure.
describe('gmi 429 backoff', () => {
  it('retries a rate limit once, after a wait long enough to clear the window', async () => {
    const { gmiChat } = await import('../spectrum/shared/gmi')
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
    const { gmiChat } = await import('../spectrum/shared/gmi')
    const realFetch = globalThis.fetch
    let calls = 0
    globalThis.fetch = (async () => { calls++; return new Response('{}', { status: 429 }) }) as unknown as typeof fetch
    try {
      // Isolate this refusal from the previous test's live throttle state.
      // An already-queued request now correctly expires before being sent.
      await expect(gmiChat({ messages: [{ role: 'user', content: 'hi' }], timeoutMs: 700, apiKey: 'k', baseUrl: 'https://short-rate-limit.test/v1' }))
        .rejects.toThrow('429')
      expect(calls).toBe(1)
    } finally {
      globalThis.fetch = realFetch
    }
  }, 15_000)
})

describe('gmi 400-body rate limits', () => {
  it('retries a 400 whose body says Rate limit exceeded', async () => {
    const { gmiChat } = await import('../spectrum/shared/gmi')
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
    const { gmiChat } = await import('../spectrum/shared/gmi')
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

describe('gmi empty completion', () => {
  /* The measured workshop failure: 200, finish=length, 4383 reasoning tokens
   * and a content field of zero characters. The old retry repeated the request
   * with reasoning_effort 'none', which this backend 400s outright — a second
   * request that could never answer. It now walks down the effort ladder. */
  it('retries an empty completion at a lower thinking effort', async () => {
    const { gmiChat } = await import('../spectrum/shared/gmi')
    const realFetch = globalThis.fetch
    const efforts: Array<string | undefined> = []
    globalThis.fetch = (async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as { reasoning_effort?: string }
      efforts.push(body.reasoning_effort)
      if (efforts.length === 1) {
        return new Response(JSON.stringify({ choices: [{ finish_reason: 'length', message: { content: '', reasoning_content: 'x'.repeat(500) } }] }), { status: 200 })
      }
      return new Response(JSON.stringify({ choices: [{ message: { content: '{"title":"Touch Pong","code":"…"}' } }] }), { status: 200 })
    }) as unknown as typeof fetch
    try {
      const reply = await gmiChat({ messages: [{ role: 'user', content: 'build a ping pong game' }], maxTokens: 4000, timeoutMs: 20_000, apiKey: 'k' })
      expect(reply).toContain('Touch Pong')
      expect(efforts[0]).toBeUndefined()
      expect(efforts[1]).toBe('low')
    } finally {
      globalThis.fetch = realFetch
    }
  }, 30_000)

  it('keeps walking the ladder when a backend rejects low effort', async () => {
    const { gmiChat } = await import('../spectrum/shared/gmi')
    const realFetch = globalThis.fetch
    const efforts: Array<string | undefined> = []
    globalThis.fetch = (async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as { reasoning_effort?: string }
      efforts.push(body.reasoning_effort)
      if (efforts.length === 1) return new Response(JSON.stringify({ choices: [{ message: { content: '' } }] }), { status: 200 })
      if (body.reasoning_effort === 'low') return new Response(JSON.stringify({ error: 'Invalid request parameters' }), { status: 400 })
      return new Response(JSON.stringify({ choices: [{ message: { content: 'recovered' } }] }), { status: 200 })
    }) as unknown as typeof fetch
    try {
      expect(await gmiChat({ messages: [{ role: 'user', content: 'hi' }], timeoutMs: 20_000, apiKey: 'k' })).toBe('recovered')
      // 'omit' means the field is absent from the body, so the third rung reads
      // as undefined — the point is that the ladder kept walking past 'low'.
      expect(efforts).toEqual([undefined, 'low', undefined])
    } finally {
      globalThis.fetch = realFetch
    }
  }, 30_000)
})
