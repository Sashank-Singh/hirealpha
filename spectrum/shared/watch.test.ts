import { afterAll, afterEach, beforeAll, describe, expect, it } from 'bun:test'
import { createWatch } from './reminders'

/* Live, 2026-09-19, head-to-head on the proactive dimension. Instinct answered
 * "watch the sonos era 100 price for me and text me if it drops under 180" with
 * "I'll check hourly and text you if a new Sonos Era 100 drops below $180."
 * Alpha answered "One honest limitation: I can't watch the price continuously
 * in the background. … want me to set that up, daily or every few days?" — true
 * to its prompt, because the reminder capability is forbidden from standing in
 * for a watch and no capability could arm the browser_watch loop that already
 * exists server-side. An explicit watch ask now arms one. */

const savedFetch = globalThis.fetch
const savedUrl = process.env.HIREALPHA_API_URL
const savedKey = process.env.HIREALPHA_INTERNAL_KEY

let calls: Array<{ url: string; auth: string | null; body: Record<string, unknown> }> = []
let response: { ok: boolean; status: number; json: () => Promise<unknown> } = { ok: true, status: 200, json: async () => ({ ok: true, intervalHours: 6 }) }

beforeAll(() => {
  process.env.HIREALPHA_API_URL = 'http://watch.test'
  process.env.HIREALPHA_INTERNAL_KEY = 'secret-key'
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({
      url: String(input),
      auth: new Headers(init?.headers).get('authorization'),
      body: JSON.parse(String(init?.body || '{}')) as Record<string, unknown>,
    })
    return response as unknown as Response
  }) as typeof fetch
})

afterEach(() => { calls = [] })

afterAll(() => {
  globalThis.fetch = savedFetch
  if (savedUrl) process.env.HIREALPHA_API_URL = savedUrl
  else delete process.env.HIREALPHA_API_URL
  if (savedKey) process.env.HIREALPHA_INTERNAL_KEY = savedKey
  else delete process.env.HIREALPHA_INTERNAL_KEY
})

describe('createWatch', () => {
  it('arms the real browser_watch loop with the internal key', async () => {
    const result = await createWatch({
      phone: '+12163032166',
      persona: 'friend',
      url: 'https://www.amazon.com/dp/B0BXYZ',
      goal: 'price under $180',
      intervalHours: 6,
    })
    expect(result).toEqual({ ok: true, intervalHours: 6 })
    expect(calls).toHaveLength(1)
    expect(calls[0]!.url).toBe('http://watch.test/api/internal/loops/watch')
    expect(calls[0]!.auth).toBe('Bearer secret-key')
    expect(calls[0]!.body).toMatchObject({
      phone: '+12163032166',
      persona: 'friend',
      url: 'https://www.amazon.com/dp/B0BXYZ',
      goal: 'price under $180',
      intervalHours: 6,
    })
  })

  it('reports the honest failure when the server refuses the watch', async () => {
    response = { ok: false, status: 400, json: async () => ({ error: 'watch needs an https site URL' }) }
    const result = await createWatch({ phone: '+12163032166', persona: 'friend', url: 'not-a-url', goal: 'price under $180' })
    expect(result.ok).toBe(false)
    response = { ok: true, status: 200, json: async () => ({ ok: true, intervalHours: 6 }) }
  })

  it('reports the honest failure when the API is unreachable', async () => {
    const reachable = process.env.HIREALPHA_API_URL
    delete process.env.HIREALPHA_API_URL
    const result = await createWatch({ phone: '+12163032166', persona: 'friend', url: 'https://example.com/x', goal: 'back in stock' })
    expect(result.ok).toBe(false)
    process.env.HIREALPHA_API_URL = reachable
  })
})
