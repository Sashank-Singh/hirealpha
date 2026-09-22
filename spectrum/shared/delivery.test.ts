import { expect, it } from 'bun:test'
import { FAST_REPLY_WALL_MS, fastReplyBudget, recoverChatReply, onceAsync } from './delivery'

it('reuses one turn across concurrent calls and a delivery retry', async () => {
  let executions = 0
  const getTurn = onceAsync(async () => { executions++; return { reply: 'Sent.' } })
  const [first, second] = await Promise.all([getTurn(), getTurn()])
  expect(await getTurn()).toBe(first)
  expect(second).toBe(first)
  expect(executions).toBe(1)
})

it('does not replay potentially completed side effects after an ambiguous turn failure', async () => {
  let executions = 0
  const getTurn = onceAsync(async () => { executions++; throw new Error('failed after write') })
  await expect(getTurn()).rejects.toThrow('failed after write')
  await expect(getTurn()).rejects.toThrow('failed after write')
  expect(executions).toBe(1)
})

/* Live, 2026-09-21: a brand-new user's first message — "Hey, Alpha!" — timed out
 * at 6s against an 8.5s wall, which left 2497ms and no room for the retry, so the
 * turn went straight to the canned local line and the first thing the assistant
 * ever said was "I hit a quick snag thinking through that. Can you say that once
 * more?". The first message now gets a budget that can absorb a timeout and still
 * retry.
 */
it('gives a first contact room to time out and still retry', () => {
  const first = fastReplyBudget({ firstContact: true })
  expect(first.attemptMs).toBeGreaterThanOrEqual(12_000)
  // The retry threshold is 2500ms, so the wall must leave more than that after a
  // full attempt — otherwise the retry branch is unreachable, which is the bug.
  expect(first.wallMs - first.attemptMs).toBeGreaterThan(2_500)
  // And an attempt must still fit inside the wall.
  expect(first.attemptMs).toBeLessThan(first.wallMs)
})

it('keeps the fast path for an established thread', () => {
  const later = fastReplyBudget({ firstContact: false })
  expect(later.attemptMs).toBe(6_000)
  expect(later.wallMs).toBe(FAST_REPLY_WALL_MS)
  // An operator can still move the budget, and it stays inside sane bounds.
  expect(fastReplyBudget({ firstContact: false, configuredMs: 900 }).attemptMs).toBe(2_500)
  expect(fastReplyBudget({ firstContact: false, configuredMs: 99_000 }).attemptMs).toBe(15_000)
  // A first contact never gets LESS than the configured budget.
  expect(fastReplyBudget({ firstContact: true, configuredMs: 15_000 }).attemptMs).toBe(15_000)
})

// Reproduce a returning user's full timeout: the old 8.5s wall left only
// 2497ms, skipping the retry entirely for the Copeland question.
it('recovers the original conversation after a full fast timeout', async () => {
  const budgets: number[] = []
  const reply = await recoverChatReply(async (timeoutMs) => {
    budgets.push(timeoutMs)
    if (budgets.length === 1) throw new Error('The operation timed out.')
    return 'Copeland makes climate-control technology.'
  }, 6000)
  expect(reply).toContain('Copeland')
  expect(budgets).toEqual([6000, 20000])
})

it('does not retry a successful response', async () => {
  let calls = 0
  expect(await recoverChatReply(async () => { calls++; return 'Answer' }, 6000)).toBe('Answer')
  expect(calls).toBe(1)
})

it('retries an empty sanitized reply and bounds persistent failures', async () => {
  let calls = 0
  await expect(recoverChatReply(async () => { calls++; return '  ' }, 6000)).rejects.toThrow('Empty conversational reply')
  expect(calls).toBe(2)
})

it('surfaces persistent outages after one recovery attempt', async () => {
  let calls = 0
  await expect(recoverChatReply(async () => { calls++; throw new Error('unavailable') }, 6000)).rejects.toThrow('unavailable')
  expect(calls).toBe(2)
})

it('answers the screenshot question after timeout with unchanged context and one stored reply', async () => {
  const { runConversationalFriend } = await import('./conversationalFriend')
  const { mkdtempSync, readFileSync, rmSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const dataDir = mkdtempSync(join(tmpdir(), 'alpha-recovery-'))
  const originalFetch = globalThis.fetch
  const originalNow = Date.now
  const originalEnv = { key: process.env.GMI_API_KEY, model: process.env.GMI_MODEL, fallback: process.env.GMI_MODEL_FALLBACK }
  let elapsed = 0
  const requests: unknown[] = []
  try {
    process.env.GMI_API_KEY = 'test-only'
    process.env.GMI_MODEL = process.env.GMI_MODEL_FALLBACK = 'test-model'
    Date.now = () => originalNow() + elapsed
    globalThis.fetch = (async (_url, init) => {
      const body = JSON.parse(String(init?.body))
      const chat = body.messages[0].content.includes('FAST_CHAT:')
      if (chat) {
        requests.push(body.messages)
        if (requests.length === 1) {
          elapsed += 6003
          throw new Error('The operation timed out.')
        }
      }
      return Response.json({ choices: [{ message: { content: chat ? 'Recovered answer for the original question.' : '{"kind":"chat"}' } }] })
    }) as typeof fetch
    const result = await runConversationalFriend({
      dataDir, senderId: 'recovery-test', userText: 'What does Copeland do ?',
      live: { found: true, hired: true, context: {}, connected: [], memories: [], email: null },
      memory: { facts: [], summary: '', history: [{ role: 'user', content: 'We were discussing companies.' }] },
      contacts: [],
    })
    expect(result.reply).toBe('Recovered answer for the original question.')
    expect(result.source).toBe('gmi')
    expect(requests).toHaveLength(2)
    expect(requests[1]).toEqual(requests[0])
    const saved = JSON.parse(readFileSync(join(dataDir, 'threads', 'recovery-test.json'), 'utf8'))
    expect(saved.history.filter((m: { role: string }) => m.role === 'assistant')).toHaveLength(1)
    expect(saved.history.at(-2).content).toBe('What does Copeland do ?')
  } finally {
    globalThis.fetch = originalFetch
    Date.now = originalNow
    for (const [key, value] of Object.entries({ GMI_API_KEY: originalEnv.key, GMI_MODEL: originalEnv.model, GMI_MODEL_FALLBACK: originalEnv.fallback })) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    rmSync(dataDir, { recursive: true, force: true })
  }
})
