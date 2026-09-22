import { expect, it } from 'bun:test'
import { gmiChat } from './gmi'

it('expires a queued request promptly and never sends it after its deadline', async () => {
  const originalFetch = globalThis.fetch
  let release!: () => void
  let started!: () => void
  const blockerStarted = new Promise<void>(resolve => { started = resolve })
  const blocked = new Promise<void>(resolve => { release = resolve })
  const calls: string[] = []
  const opts = { apiKey: 'test', baseUrl: 'https://queue-deadline.test/v1', model: 'test' }
  globalThis.fetch = (async (_url, init) => {
    const prompt = JSON.parse(String(init?.body)).messages[0].content
    calls.push(prompt)
    if (prompt === 'arm throttle') return new Response('{}', { status: 429 })
    if (prompt === 'blocking request') { started(); await blocked }
    return Response.json({ choices: [{ message: { content: 'Answered.' } }] })
  }) as typeof fetch
  let first: Promise<string> | undefined
  let queued: Promise<string> | undefined
  try {
    await expect(gmiChat({ ...opts, messages: [{ role: 'user', content: 'arm throttle' }], timeoutMs: 100 })).rejects.toThrow('429')
    first = gmiChat({ ...opts, messages: [{ role: 'user', content: 'blocking request' }], timeoutMs: 3000 })
    await blockerStarted
    queued = gmiChat({ ...opts, messages: [{ role: 'user', content: 'expired request' }], timeoutMs: 30 })
    const outcome = await Promise.race([
      queued.then(() => 'answered', () => 'expired'),
      new Promise<string>(resolve => setTimeout(() => resolve('still queued'), 150)),
    ])
    expect(outcome).toBe('expired')
  } finally {
    release()
    await Promise.allSettled([first, queued])
    globalThis.fetch = originalFetch
  }
  expect(calls).toEqual(['arm throttle', 'blocking request'])
})
