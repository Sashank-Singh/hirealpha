import { afterEach, beforeEach, expect, it } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { runHireTurn } from './runHireTurn'
import { loadMemory, setPendingSpend } from './memory'
import { executeSpendApproval } from './liveContext'
import { isAffirmativeApprovalIntent } from './conversationalApproval'
const originalFetch = globalThis.fetch
const originalEnv = { ...process.env }
let dir: string
let decisions: any[]
let response: any
const phone = '+15555550123'
beforeEach(() => {
  dir = mkdtempSync('/tmp/alpha-spend-trust-')
  decisions = []
  response = { ok: true, state: 'cancelled', decision: 'denied' }
  process.env.HIREALPHA_API_URL = 'https://audit.invalid'
  process.env.HIREALPHA_INTERNAL_KEY = 'fixture'
  globalThis.fetch = (async (input: any, init: any) => {
    const url = String(input)
    if (url.includes('/live?')) return Response.json({ found: true, hired: true, context: {}, connected: [], memories: [] })
    if (url.includes('/spend/decide')) { decisions.push(JSON.parse(init.body)); return Response.json(response) }
    if (url.includes('/chat/completions')) return Response.json({ choices: [{ message: { content: '{"kind":"chat"}' } }] })
    return Response.json({ ok: false })
  }) as typeof fetch
  setPendingSpend(dir, phone, { id: 'pending-123', item: 'headphones', amount: 99, url: 'https://store.example/item', createdAt: Date.now() })
})
afterEach(() => { globalThis.fetch = originalFetch; process.env = { ...originalEnv }; rmSync(dir, { recursive: true, force: true }) })
const turn = (userText: string) => runHireTurn({ agentId: 'friend', senderId: phone, dataDir: dir, userText })
for (const message of ['Should I buy it?', 'yes?', 'buy it if shipping is free', 'I can get it cheaper elsewhere', 'Would you go for it?', 'sure, but use a different address']) {
  it(`UX01: does not authorize ${message}`, async () => {
    expect(isAffirmativeApprovalIntent(message)).toBe(false)
    const result = await turn(message)
    expect(decisions).toEqual([])
    expect(loadMemory(dir, phone).pendingSpend?.id).toBe('pending-123')
    expect(result.reply).not.toMatch(/payment received|cancelled the order/i)
    await turn(message)
    expect(decisions).toEqual([])
  })
}
it('UX01 binds an explicit approval to the pending terms', async () => {
  response = { ok: true, state: 'succeeded', charged: true, paymentIntentId: 'pi_verified' }
  const result = await turn('yes please')
  expect(decisions[0]).toMatchObject({ requestId: 'pending-123', decision: 'approve', terms: { amountCents: 9900, purpose: 'headphones', url: 'https://store.example/item' } })
  expect(result.reply).toContain('Payment received')
  expect(loadMemory(dir, phone).pendingSpend).toBeUndefined()
})
it('UX02 verifies remote denial before clearing pending state', async () => {
  const result = await turn('cancel that')
  expect(decisions).toHaveLength(1)
  expect(decisions[0].decision).toBe('deny')
  expect(result.reply).toContain('pending approval')
  expect(loadMemory(dir, phone).pendingSpend).toBeUndefined()
})
for (const state of ['executing', 'succeeded', 'outcome_unknown']) {
  it(`UX02 preserves state when cancellation reports ${state}`, async () => {
    response = { ok: false, state, error: 'Cancellation not confirmed' }
    const result = await turn('cancel that')
    expect(result.reply).not.toMatch(/^Cancelled/i)
    expect(loadMemory(dir, phone).pendingSpend?.id).toBe('pending-123')
    await turn('cancel that')
    expect(decisions).toHaveLength(2)
  })
}
for (const failure of ['missing-url', 'missing-key', 'unavailable', 'malformed', 'ok-without-receipt']) {
  it(`UX04 fails closed for ${failure}`, async () => {
    if (failure === 'missing-url') delete process.env.HIREALPHA_API_URL
    if (failure === 'missing-key') delete process.env.HIREALPHA_INTERNAL_KEY
    if (failure === 'unavailable') globalThis.fetch = (async () => { throw new Error('provider unavailable') }) as typeof fetch
    if (failure === 'malformed') globalThis.fetch = (async () => new Response('not-json')) as typeof fetch
    if (failure === 'ok-without-receipt') response = { ok: true }
    const approved = await executeSpendApproval(phone, 'pending-123')
    expect(approved.ok).toBe(false)
    const result = await turn('yes please')
    expect(result.reply).not.toContain('Payment received')
    expect(loadMemory(dir, phone).pendingSpend?.id).toBe('pending-123')
  })
}
