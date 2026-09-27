import { describe, expect, it } from 'bun:test'
import { computeIdempotencyKey, withIdempotency } from './idempotency'

describe('Idempotency utilities', () => {
  it('computes deterministic key regardless of property order', () => {
    const key1 = computeIdempotencyKey('test', { a: 1, b: 'two', c: [1, 2] })
    const key2 = computeIdempotencyKey('test', { c: [1, 2], b: 'two', a: 1 })
    expect(key1).toBe(key2)
    expect(key1.startsWith('test_')).toBe(true)
  })

  it('preserves type and structure boundaries in idempotency inputs', () => {
    const values = [null, undefined, '', 1, '1', true, 'true', false, 0, -0]
    const keys = values.map((value) => computeIdempotencyKey('typed', { value }))
    expect(new Set(keys).size).toBe(values.length)
    expect(computeIdempotencyKey('typed', { a: 'x,b:y' })).not.toBe(computeIdempotencyKey('typed', { a: 'x', b: 'y' }))
    expect(computeIdempotencyKey('typed', [1, 2])).not.toBe(computeIdempotencyKey('typed', [2, 1]))
    expect(computeIdempotencyKey('typed', { nested: { a: 1, b: 2 } })).toBe(computeIdempotencyKey('typed', { nested: { b: 2, a: 1 } }))
  })

  it('withIdempotency caches completed execution and prevents duplicate execution', async () => {
    let executions = 0
    const key = `test_key_${Date.now()}_1`

    const run = async () => {
      executions++
      return { answer: 42 }
    }

    const first = await withIdempotency(key, run)
    expect(first.cached).toBe(false)
    expect(first.result.answer).toBe(42)
    expect(executions).toBe(1)

    // Second call with same key must return cached
    const second = await withIdempotency(key, run)
    expect(second.cached).toBe(true)
    expect(second.result.answer).toBe(42)
    expect(executions).toBe(1)
  })

  it('deduplicates concurrent in-flight executions', async () => {
    let executions = 0
    const key = `test_key_${Date.now()}_concurrent`

    const runSlow = async () => {
      executions++
      await new Promise((resolve) => setTimeout(resolve, 50))
      return { runId: executions }
    }

    const [res1, res2] = await Promise.all([
      withIdempotency(key, runSlow),
      withIdempotency(key, runSlow),
    ])

    expect(executions).toBe(1)
    expect(res1.result.runId).toBe(1)
    expect(res2.result.runId).toBe(1)
  })

  it('allows retry after failed execution', async () => {
    let attempts = 0
    const key = `test_key_${Date.now()}_failure`

    const runFailOnce = async () => {
      attempts++
      if (attempts === 1) throw new Error('Network timeout')
      return { success: true }
    }

    expect(withIdempotency(key, runFailOnce)).rejects.toThrow('Network timeout')

    // Retry should be allowed after failure
    const retry = await withIdempotency(key, runFailOnce)
    expect(retry.result.success).toBe(true)
    expect(attempts).toBe(2)
  })
})
