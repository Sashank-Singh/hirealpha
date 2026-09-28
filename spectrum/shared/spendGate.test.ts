import { describe, expect, test } from 'bun:test'
import { classifyPendingReply } from './conversationalApproval'
import { pendingSpendReply } from './spendTurn'
import { ClaimLedger } from './claimEvidence'
import * as fs from 'node:fs/promises'

const PENDING = { id: 'req_7', item: 'Standard Whey', amount: 42, createdAt: Date.now() }

describe('typed pending-reply routing', () => {
  test('classification', () => {
    expect(classifyPendingReply('should I buy it?')).toBe('question')
    expect(classifyPendingReply('did it go through?')).toBe('status_query')
    expect(classifyPendingReply('did my card get charged')).toBe('status_query')
    expect(classifyPendingReply('yes but only if shipping is free')).toBe('conditional')
    expect(classifyPendingReply('actually never mind')).toBe('cancel')
    expect(classifyPendingReply('nvm dont buy it')).toBe('cancel')
    expect(classifyPendingReply('no get the other one')).toBe('correction')
    expect(classifyPendingReply('approve')).toBe('approve')
    expect(classifyPendingReply('go for it')).toBe('approve')
    expect(classifyPendingReply("no don't buy it")).toBe('cancel')
  })

  test('"nvm dont buy it" cancels the durable request instead of bouncing', async () => {
    const calls: Array<{ requestId: string; decision: string }> = []
    const { pendingSpendReply: gate } = await import('./spendTurn')
    const dataDir = await fs.mkdtemp('/tmp/spend-gate-')
    const evidence = new ClaimLedger()
    const reply = await gate({
      dataDir, senderId: '+15550001234', userText: 'actually nvm dont buy it',
      pending: { ...PENDING },
      evidence,
      deps: {
        executeSpendApproval: async (_phone: string, requestId: string, decision: string) => {
          calls.push({ requestId, decision })
          return { ok: true, state: 'cancelled' }
        },
      },
    })
    expect(calls).toEqual([{ requestId: 'req_7', decision: 'deny' }])
    expect(reply).toMatch(/Cancelled/i)
    expect(reply).toMatch(/before execution/)
    expect(reply).not.toMatch(/Questions or conditions/)
    expect(evidence.hasKind('purchase', ['cancelled'])).toBe(true)
    const memPath = `${dataDir}/threads/+15550001234.json`
    const raw = await fs.readFile(memPath, 'utf8').catch(() => '{}')
    const mem = JSON.parse(raw || '{}') as { pendingSpend?: unknown }
    expect(mem.pendingSpend).toBeUndefined()
  })

  test('a status question is answered from the server row, pending kept', async () => {
    const { pendingSpendReply: gate } = await import('./spendTurn')
    const evidence = new ClaimLedger()
    let decideCalls = 0
    const reply = await gate({
      dataDir: '/tmp/unused', senderId: '+15550001234', userText: 'did it go through?',
      pending: { ...PENDING },
      evidence,
      deps: {
        executeSpendApproval: async () => { decideCalls++; return { ok: false, state: 'failed' } },
        fetchSpendState: async () => ({ ok: true, state: 'pending_approval', amountCents: 4200, purpose: 'Standard Whey' }),
      },
    })
    expect(decideCalls).toBe(0)
    expect(reply).toMatch(/pending/i)
    expect(reply).toMatch(/Not charged/i)
    expect(evidence.hasKind('purchase', ['verified_empty'])).toBe(true)
  })

  test('a failed state read is reported as unknown, never guessed', async () => {
    const { pendingSpendReply: gate } = await import('./spendTurn')
    const reply = await gate({
      dataDir: '/tmp/unused', senderId: '+15550001234', userText: 'did it go through?',
      pending: { ...PENDING },
      deps: {
        fetchSpendState: async () => ({ ok: false, error: 'payment service down' }),
      },
    })
    expect(reply).toMatch(/could not read/i)
    expect(reply).toMatch(/not confirmed either way|won't guess|won’t guess/i)
  })

  test('conditional approval never charges', async () => {
    const { pendingSpendReply: gate } = await import('./spendTurn')
    let calls = 0
    const reply = await gate({
      dataDir: '/tmp/unused', senderId: '+15550001234', userText: 'yes but only if shipping is free',
      pending: { ...PENDING },
      deps: {
        executeSpendApproval: async () => { calls++; return { ok: true, state: 'succeeded', paymentIntentId: 'pi_1' } },
      },
    })
    expect(calls).toBe(0)
    expect(reply).toMatch(/condition/i)
  })

  test('correction cancels and asks for the replacement', async () => {
    const { pendingSpendReply: gate } = await import('./spendTurn')
    const decisions: string[] = []
    const reply = await gate({
      dataDir: '/tmp/unused', senderId: '+15550001234', userText: 'no get the other one',
      pending: { ...PENDING, item: 'United $240', amount: 240 },
      deps: {
        executeSpendApproval: async (_p: string, _id: string, decision: string) => {
          decisions.push(decision)
          return { ok: true, state: 'cancelled' }
        },
      },
    })
    expect(decisions).toEqual(['deny'])
    expect(reply).toMatch(/replacement/i)
  })
})
