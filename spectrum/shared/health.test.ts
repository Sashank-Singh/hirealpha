import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { healthHandler } from './health'

describe('health diagnostics access', () => {
  let saved: string | undefined
  beforeEach(() => {
    saved = process.env.HIREALPHA_INTERNAL_KEY
    process.env.HIREALPHA_INTERNAL_KEY = 'test-key'
  })
  afterEach(() => {
    if (saved === undefined) delete process.env.HIREALPHA_INTERNAL_KEY
    else process.env.HIREALPHA_INTERNAL_KEY = saved
  })
  it('keeps liveness public', async () => {
    const response = await healthHandler('friend')(new Request('https://bot.test/healthz'))
    expect(response.status).toBe(200)
  })
  it('rejects unauthorized reads and scoring before running callbacks', async () => {
    let calls = 0
    const handler = healthHandler('friend', {
      readEvals: () => { calls++; return [] },
      scoreEvals: async () => { calls++; return 0 },
    })
    for (const [path, method] of [['/evals', 'GET'], ['/evals/score', 'POST']]) {
      for (const auth of ['', 'Bearer wrong']) {
        const response = await handler(new Request(`https://bot.test${path}`, { method, headers: { Authorization: auth! } }))
        expect(response.status).toBe(401)
      }
    }
    expect(calls).toBe(0)
  })
  it('fails closed when no key is configured', async () => {
    delete process.env.HIREALPHA_INTERNAL_KEY
    const response = await healthHandler('friend', { readEvals: () => [] })(new Request('https://bot.test/evals', { headers: { Authorization: 'Bearer undefined' } }))
    expect(response.status).toBe(401)
  })
  it('allows an authenticated diagnostic read', async () => {
    const response = await healthHandler('friend', { readEvals: () => [] })(new Request('https://bot.test/evals', { headers: { Authorization: 'Bearer test-key' } }))
    expect(response.status).toBe(200)
  })
  it('returns a real HTTP 500 without leaking scoring exceptions', async () => {
    const response = await healthHandler('friend', { scoreEvals: async () => { throw new Error('private detail') } })(new Request('https://bot.test/evals/score', { method: 'POST', headers: { Authorization: 'Bearer test-key' } }))
    expect(response.status).toBe(500)
    expect(await response.text()).not.toContain('private detail')
  })
})
