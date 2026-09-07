import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { isKillSwitchArmed, runLoopTask, startTaskLoopPoller } from './taskLoops'
import { gmiChat } from './gmi'

const savedFetch = globalThis.fetch
let savedUrl: string | undefined
let savedKey: string | undefined
beforeEach(() => {
  savedUrl = process.env.HIREALPHA_API_URL
  savedKey = process.env.HIREALPHA_INTERNAL_KEY
  process.env.HIREALPHA_API_URL = 'https://hirealpha.test'
  process.env.HIREALPHA_INTERNAL_KEY = 'test'
})
afterEach(() => {
  globalThis.fetch = savedFetch
  if (savedUrl === undefined) delete process.env.HIREALPHA_API_URL
  else process.env.HIREALPHA_API_URL = savedUrl
  if (savedKey === undefined) delete process.env.HIREALPHA_INTERNAL_KEY
  else process.env.HIREALPHA_INTERNAL_KEY = savedKey
})

describe('proactive send safety', () => {
  it('blocks sends when the stop-switch service fails or returns malformed state', async () => {
    for (const response of [new Response('', { status: 503 }), Response.json({}), Response.json({ armed: 'false' })]) {
      globalThis.fetch = (async () => response) as typeof fetch
      expect(await isKillSwitchArmed('test-user')).toBe(true)
    }
  })
  it('blocks sends on a network exception', async () => {
    globalThis.fetch = (async () => { throw new Error('offline') }) as typeof fetch
    expect(await isKillSwitchArmed('test-user')).toBe(true)
  })
  it('allows sends only when the server explicitly reports unarmed', async () => {
    globalThis.fetch = (async () => Response.json({ armed: false })) as typeof fetch
    expect(await isKillSwitchArmed('test-user')).toBe(false)
  })
  it('snoozes an approval that could not be delivered instead of marking it done', async () => {
    const results: { outcome: string; note?: string }[] = []
    let sends = 0
    await runLoopTask({ id: 'approval', phone: 'test-user', kind: 'trial_ending', payload: { action: 'purchase' } },
      () => { throw new Error('must not execute without approval') }, {
        persona: 'friend', send: async () => { sends++ }, checkKillSwitch: async () => true,
        postResult: async (_id, result) => { results.push(result) },
      })
    expect(sends).toBe(0)
    expect(results[0]?.outcome).toBe('snoozed')
  })
})

describe('bounded model requests', () => {
  it('rejects a stalled request when its deadline expires', async () => {
    globalThis.fetch = ((_input, init) => new Promise((_resolve, reject) => {
      const signal = init?.signal
      if (signal?.aborted) reject(signal.reason)
      else signal?.addEventListener('abort', () => reject(signal.reason), { once: true })
    })) as typeof fetch
    await expect(gmiChat({ apiKey: 'test', timeoutMs: 20, messages: [{ role: 'user', content: 'Hello' }] })).rejects.toThrow()
  })
  it('supplies a deadline to every request', async () => {
    let signal: AbortSignal | null | undefined
    globalThis.fetch = (async (_input, init) => {
      signal = init?.signal
      return Response.json({ choices: [{ message: { content: 'Hello.' } }] })
    }) as typeof fetch
    await gmiChat({ apiKey: 'test', messages: [{ role: 'user', content: 'Hello' }] })
    expect(signal).toBeInstanceOf(AbortSignal)
  })
})

it('does not start overlapping task claims while a poll is still running', async () => {
  let calls = 0
  let finish!: (response: Response) => void
  globalThis.fetch = (() => {
    calls++
    return new Promise<Response>((resolve) => { finish = resolve })
  }) as typeof fetch
  const stop = startTaskLoopPoller({ persona: 'friend', pollMs: 5, send: async () => {} })
  try {
    await new Promise((resolve) => setTimeout(resolve, 25))
    expect(calls).toBe(1)
  } finally {
    stop?.()
    finish(Response.json({ loops: [] }))
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
})
