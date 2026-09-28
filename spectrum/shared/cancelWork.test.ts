import { describe, expect, test } from 'bun:test'
import { cancelWork } from './cancelWork'
import { setPendingSpend } from './memory'
import { ClaimLedger } from './claimEvidence'
import * as fs from 'node:fs/promises'

function makeDir() {
  return fs.mkdtemp('/tmp/cancel-work-')
}

describe('cancel_work — durable cancellation state model', () => {
  test('pending purchase: deny path runs and clears thread state', async () => {
    const dataDir = await makeDir()
    setPendingSpend(dataDir, '+15550001234', { id: 'req_7', item: 'Standard Whey', amount: 42, createdAt: Date.now() })
    const evidence = new ClaimLedger()
    const calls: Array<{ path: string; body: Record<string, unknown> }> = []
    const result = await cancelWork({
      dataDir, senderId: '+15550001234',
      userText: 'actually nvm dont buy it',
      evidence,
      call: async (path, body) => {
        calls.push({ path, body })
        if (path === '/api/internal/spend/state') return { ok: true, state: 'pending_approval' }
        if (path === '/api/internal/spend/decide') return { ok: true, state: 'cancelled' }
        return { ok: true, results: [] }
      },
    })
    expect(calls.map((c) => c.path)).toEqual(['/api/internal/spend/state', '/api/internal/spend/decide'])
    expect(result.results[0]).toMatchObject({ target: 'purchase', outcome: 'cancelled_before_execution' })
    expect(result.reply).toMatch(/cancelled before it ran/)
    expect(evidence.hasKind('purchase', ['cancelled'])).toBe(true)
    const mem = JSON.parse(await fs.readFile(`${dataDir}/threads/+15550001234.json`, 'utf8').catch(() => '{}'))
    expect(mem.pendingSpend).toBeUndefined()
  })

  test('bare "cancel that" cancels every active target and reports each typed state', async () => {
    const evidence = new ClaimLedger()
    const result = await cancelWork({
      dataDir: '/tmp/unused', senderId: '+15550001234', userText: 'cancel that',
      evidence,
      call: async (path, body) => {
        expect(path).toBe('/api/internal/work/cancel')
        expect((body as { kinds: string[] }).kinds).toEqual(['browser', 'watch', 'followup', 'scheduled_text'])
        return {
          ok: true,
          results: [
            { target: 'browser', id: 'job_1', state: 'cancellation_requested', priorStatus: 'running' },
            { target: 'watch', id: 'w_2', state: 'cancelled_before_execution', priorStatus: 'pending' },
            { target: 'followup', id: null, state: 'not_cancellable' },
            { target: 'scheduled_text', id: null, state: 'not_cancellable' },
          ],
        }
      },
    })
    expect(result.results.map((r) => r.outcome)).toEqual([
      'cancellation_requested', 'cancelled_before_execution', 'not_cancellable', 'not_cancellable',
    ])
    // In-flight work must NOT be reported as a plain cancel.
    expect(result.reply).toMatch(/cancel requested/)
    expect(result.reply).toMatch(/possibly still running/)
    expect(result.reply).not.toMatch(/browser run: cancelled before it ran/)
    expect(result.anythingStillActive).toBe(true)
    expect(evidence.hasKind('browser', ['cancellation_requested'])).toBe(true)
    expect(evidence.hasKind('watch', ['cancelled'])).toBe(true)
  })

  test('domain hint narrows the cancel to the named target', async () => {
    const kindsCalled: string[] = []
    await cancelWork({
      dataDir: '/tmp/unused', senderId: '+15550001234', userText: 'stop watching that price',
      call: async (path, body) => {
        if (path === '/api/internal/work/cancel') kindsCalled.push(...(((body as { kinds?: string[] }).kinds) || []))
        return { ok: true, results: [{ target: 'watch', id: 'w_1', state: 'cancelled_before_execution' }] }
      },
    })
    expect(kindsCalled).toEqual(['watch'])
  })

  test('already-completed work is reported, never hidden', async () => {
    const result = await cancelWork({
      dataDir: '/tmp/unused', senderId: '+15550001234', userText: 'cancel it',
      call: async () => ({
        ok: true,
        results: [{ target: 'browser', id: 'job_1', state: 'already_completed', priorStatus: 'succeeded' }],
      }),
    })
    expect(result.reply).toMatch(/already finished/)
    expect(result.anythingStillActive).toBe(false)
  })

  test('nothing active anywhere produces an honest no-work answer', async () => {
    const result = await cancelWork({
      dataDir: '/tmp/unused', senderId: '+15550001234', userText: 'cancel it',
      call: async () => ({
        ok: true,
        results: [
          { target: 'browser', id: null, state: 'not_cancellable' },
          { target: 'watch', id: null, state: 'not_cancellable' },
          { target: 'followup', id: null, state: 'not_cancellable' },
          { target: 'scheduled_text', id: null, state: 'not_cancellable' },
        ],
      }),
    })
    expect(result.reply).toMatch(/not found among active work/)
    expect(result.anythingStillActive).toBe(false)
  })

  test('a failed cancel write is outcome_unknown, never a claim either way', async () => {
    const evidence = new ClaimLedger()
    const result = await cancelWork({
      dataDir: '/tmp/unused', senderId: '+15550001234', userText: 'stop the browser run',
      evidence,
      call: async () => { throw new Error('timeout') },
    })
    expect(result.anythingStillActive).toBe(true)
    expect(result.reply).toMatch(/will not claim it either way|not confirmed/i)
  })
})
