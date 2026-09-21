import { expect, it } from 'bun:test'
import { FAST_REPLY_WALL_MS, fastReplyBudget, onceAsync } from './delivery'

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
