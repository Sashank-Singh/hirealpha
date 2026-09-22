import { afterEach, beforeEach, expect, it, spyOn } from 'bun:test'
import { gmiChat } from './gmi'

const keys = ['GMI_API_KEY', 'GMI_BASE_URL', 'GMI_MODEL', 'GMI_MODEL_FALLBACK',
  'HIREALPHA_MODEL_FALLBACK_API_KEY', 'HIREALPHA_MODEL_FALLBACK_BASE_URL', 'HIREALPHA_MODEL_FALLBACK_MODEL'] as const
let saved: Array<string | undefined>
const originalFetch = globalThis.fetch
const originalNow = Date.now
const messages = [{ role: 'user' as const, content: 'What does Copeland do?' }]
const answer = () => Response.json({ choices: [{ message: { content: 'Recovered original question.' } }] })
beforeEach(() => {
  saved = keys.map(key => process.env[key])
  Object.assign(process.env, {
    GMI_API_KEY: 'primary-test-key', GMI_BASE_URL: 'https://primary.test/v1', GMI_MODEL: 'primary-model',
    GMI_MODEL_FALLBACK: 'legacy-model', HIREALPHA_MODEL_FALLBACK_API_KEY: 'backup-test-key',
    HIREALPHA_MODEL_FALLBACK_BASE_URL: 'https://backup.test/v1', HIREALPHA_MODEL_FALLBACK_MODEL: 'backup-model',
  })
})
afterEach(() => {
  globalThis.fetch = originalFetch
  Date.now = originalNow
  keys.forEach((key, index) => {
    if (saved[index] === undefined) delete process.env[key]
    else process.env[key] = saved[index]
  })
})

it('recovers a timed-out primary through an independent endpoint with unchanged context', async () => {
  let elapsed = 0
  Date.now = () => originalNow() + elapsed
  const calls: Array<{ url: string; auth: string | null; body: Record<string, unknown> }> = []
  const timeout = spyOn(AbortSignal, 'timeout')
  try {
    globalThis.fetch = (async (url, init) => {
      calls.push({ url: String(url), auth: new Headers(init?.headers).get('Authorization'), body: JSON.parse(String(init?.body)) })
      if (calls.length === 1) {
        elapsed += 3003
        throw new DOMException('The operation timed out.', 'TimeoutError')
      }
      return answer()
    }) as typeof fetch
    expect(await gmiChat({ messages, timeoutMs: 6000 })).toBe('Recovered original question.')
    expect(calls.map(call => [call.url, call.auth, call.body.model])).toEqual([
      ['https://primary.test/v1/chat/completions', 'Bearer primary-test-key', 'primary-model'],
      ['https://backup.test/v1/chat/completions', 'Bearer backup-test-key', 'backup-model'],
    ])
    expect(calls[1]?.body.messages).toEqual(messages)
    expect(timeout.mock.calls[0]?.[0]).toBe(3000)
    expect(timeout.mock.calls[1]?.[0]).toBeLessThanOrEqual(2997)
    expect(timeout.mock.calls[1]?.[0]).toBeGreaterThan(2900)
  } finally { timeout.mockRestore() }
})

it('does not contact backup when primary succeeds', async () => {
  let calls = 0
  globalThis.fetch = (async () => { calls++; return answer() }) as typeof fetch
  expect(await gmiChat({ messages, timeoutMs: 6000 })).toContain('Recovered')
  expect(calls).toBe(1)
})

it('does not treat a bad request as a service outage', async () => {
  let calls = 0
  globalThis.fetch = (async () => { calls++; return new Response('invalid request', { status: 400 }) }) as typeof fetch
  await expect(gmiChat({ messages, timeoutMs: 6000 })).rejects.toThrow('400')
  expect(calls).toBe(1)
})

it('bounds a total outage to primary and backup without cycling models', async () => {
  const urls: string[] = []
  globalThis.fetch = (async url => { urls.push(String(url)); throw new Error('fetch failed') }) as typeof fetch
  await expect(gmiChat({ messages, timeoutMs: 6000 })).rejects.toThrow('fetch failed')
  expect(urls).toEqual(['https://primary.test/v1/chat/completions', 'https://backup.test/v1/chat/completions'])
})

it('rejects incomplete backup settings before sending credentials', async () => {
  delete process.env.HIREALPHA_MODEL_FALLBACK_API_KEY
  let calls = 0
  globalThis.fetch = (async () => { calls++; return answer() }) as typeof fetch
  await expect(gmiChat({ messages })).rejects.toThrow('requires API_KEY, BASE_URL and MODEL')
  expect(calls).toBe(0)
})

it('keeps explicit endpoint callers isolated from the environment backup', async () => {
  const urls: string[] = []
  globalThis.fetch = (async url => { urls.push(String(url)); throw new Error('invalid custom configuration') }) as typeof fetch
  await expect(gmiChat({ messages, apiKey: 'custom-key', baseUrl: 'https://custom.test/v1' })).rejects.toThrow('invalid custom')
  expect(urls).toEqual(['https://custom.test/v1/chat/completions'])
})

it('keeps GLM 5.3 Flash on OpenRouter and excludes the failing GMI host', async () => {
  let payload: Record<string, unknown> = {}
  globalThis.fetch = (async (_url, init) => {
    payload = JSON.parse(String(init?.body))
    return answer()
  }) as typeof fetch
  await gmiChat({ messages, apiKey: 'router-test-key', baseUrl: 'https://openrouter.ai/api/v1',
    model: 'zai-org/GLM-5.3-Flash', reasoningEffort: 'low' })
  expect(payload.model).toBe('z-ai/glm-5.3-flash')
  expect(payload.provider).toEqual({ sort: 'latency', allow_fallbacks: true, ignore: ['gmicloud'] })
  expect(payload.reasoning).toEqual({ effort: 'low' })
  expect(payload.reasoning_effort).toBeUndefined()
  expect(payload.models).toBeUndefined()
})

it('never falls back to a different model on OpenRouter', async () => {
  let calls = 0
  globalThis.fetch = (async () => { calls++; throw new Error('fetch failed') }) as typeof fetch
  await expect(gmiChat({ messages, apiKey: 'router-test-key', baseUrl: 'https://openrouter.ai/api/v1',
    model: 'z-ai/glm-5.3-flash' })).rejects.toThrow('fetch failed')
  expect(calls).toBe(1)
})
