import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { appendThread } from './memory'
import { runHireTurn } from './runHireTurn'

describe('explicit navigation wins over conversation history', () => {
  let dataDir: string
  const originalFetch = globalThis.fetch
  const envKeys = ['HIREALPHA_API_URL', 'HIREALPHA_INTERNAL_KEY', 'GMI_API_KEY'] as const
  let savedEnv: (string | undefined)[]
  let requests: string[]
  let profileUnavailable: boolean
  let hired: boolean
  let modelInputs: string[]

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'hirealpha-turn-test-'))
    savedEnv = envKeys.map((key) => process.env[key])
    process.env.HIREALPHA_API_URL = 'https://hirealpha.test'
    process.env.HIREALPHA_INTERNAL_KEY = 'test-key'
    process.env.GMI_API_KEY = 'test-key'
    requests = []
    profileUnavailable = false
    hired = false
    modelInputs = []
    globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const url = String(input)
      requests.push(url)
      if (url.includes('/chat/completions')) {
        modelInputs.push(String(init?.body || ''))
        return Response.json({ choices: [{ message: { content: "Hey, I'm Alpha, your personal sidekick. Your calendar isn't connected." } }] })
      }
      if (url.includes('/api/internal/mini/token')) return new Response('Unavailable', { status: 503 })
      if (profileUnavailable && url.includes('/api/internal/live?')) return new Response('Unavailable', { status: 503 })
      if (hired && url.includes('/api/internal/live?')) return Response.json({ found: true, hired: true, connected: [], context: {}, memories: [{ key: 'preferred_name', value: 'Test' }, { key: 'city', value: 'Austin' }] })
      return Response.json({ found: false, hired: false })
    }) as typeof fetch
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
    envKeys.forEach((key, i) => {
      if (savedEnv[i] === undefined) delete process.env[key]
      else process.env[key] = savedEnv[i]
    })
    rmSync(dataDir, { recursive: true, force: true })
  })

  for (const prior of ['food', 'calendar']) {
    for (const userText of ['Apps', 'Show me the apps']) {
      it(`${userText}: card only after ${prior}, even when profile and token lookup fail`, async () => {
        appendThread(dataDir, 'test-user', [
          { role: 'user', content: prior === 'food' ? 'I had wings and an eclair' : 'Plan my day for tomorrow' },
          { role: 'assistant', content: prior === 'food' ? 'Want me to find food nearby?' : "Your calendar isn't connected. Connect it first." },
        ])
        const result = await runHireTurn({ agentId: 'friend', dataDir, senderId: 'test-user', userText })
        expect(result.reply).toBe('')
        expect(result.bubbles).toEqual([])
        expect(result.card?.url).toContain('/app/mini/friend/apps')
        expect(requests.every((url) => url.includes('/api/internal/mini/token'))).toBe(true)
      })
    }
  }

  it('repeated apps requests and a first-ever apps request each get a card', async () => {
    for (const userText of ['Apps', 'Show me the apps', 'Apps']) {
      const result = await runHireTurn({ agentId: 'friend', dataDir, senderId: 'test-user', userText })
      expect(result.bubbles).toEqual([])
      expect(result.card?.url).toContain('/app/mini/friend/apps')
      expect(result.contactCardFirst).toBeUndefined()
    }
  })

  it('connect calendar gives a direct setup link without inventing connection status', async () => {
    const result = await runHireTurn({ agentId: 'friend', dataDir, senderId: 'test-user', userText: 'Connect to my calendar' })
    expect(result.reply).toContain('connect=calendar')
    expect(result.reply).not.toMatch(/not connected|isn't connected|I'm Alpha/i)
    expect(requests.some((url) => url.includes('/chat/completions'))).toBe(false)
  })

  it('acknowledges a saved contact without interpreting it as a savings habit', async () => {
    const result = await runHireTurn({ agentId: 'friend', dataDir, senderId: 'test-user', userText: 'I did saved already' })
    expect(result.reply).toContain('contact')
    expect(result.reply).not.toMatch(/I'm Alpha|habit|saving already/i)
    expect(requests.some((url) => url.includes('/chat/completions'))).toBe(false)
  })

  it('removes a repeated introduction from a returning user reply', async () => {
    appendThread(dataDir, 'test-user', [
      { role: 'user', content: 'Hello' },
      { role: 'assistant', content: "Hey, I'm Alpha." },
    ])
    const result = await runHireTurn({ agentId: 'friend', dataDir, senderId: 'test-user', userText: 'How is it going?' })
    expect(result.reply).not.toMatch(/I'm Alpha|personal sidekick/i)
  })

  it('answers a first request beginning with Hey instead of replacing it with a welcome', async () => {
    const result = await runHireTurn({ agentId: 'friend', dataDir, senderId: 'test-user', userText: 'Hey, can you explain compound interest?' })
    expect(result.contactCardFirst).toBeUndefined()
    expect(requests.some((url) => url.includes('/chat/completions'))).toBe(true)
  })

  it('reports a profile outage without claiming the user needs to reconnect', async () => {
    profileUnavailable = true
    const result = await runHireTurn({ agentId: 'friend', dataDir, senderId: 'test-user', userText: 'Plan my day for tomorrow' })
    expect(result.reply).toContain('could not load')
    expect(result.reply).not.toMatch(/isn't connected|not connected|sign in/i)
    expect(requests.some((url) => url.includes('/chat/completions'))).toBe(false)
  })

  it('does not replace an actual request with onboarding or save it as a priority', async () => {
    hired = true
    appendThread(dataDir, 'test-user', [
      { role: 'user', content: 'Hello' },
      { role: 'assistant', content: 'What should I help with most right now?' },
    ])
    await runHireTurn({ agentId: 'friend', dataDir, senderId: 'test-user', userText: 'Explain recursion' })
    expect(modelInputs.length).toBeGreaterThan(0)
    expect(modelInputs.every((body) => !body.includes('You are mid onboarding'))).toBe(true)
    expect(requests.some((url) => url.endsWith('/api/internal/memory'))).toBe(false)
  })
})
