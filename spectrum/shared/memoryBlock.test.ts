import { describe, expect, it } from 'bun:test'
import {
  estimateTokens,
  formatMemoryFacts,
  liveFactsToInput,
  localFactsToInput,
  MEMORY_BLOCK_MAX_FACTS,
  mergeMemoryFacts,
  selectMemoryFacts,
  type MemoryFactInput,
} from './memoryBlock'

function fact(key: string, value: string, at: number): MemoryFactInput {
  return { key, value, at }
}

describe('memory block selection', () => {
  /**
   * The regression that motivated this module. The previous selector took the
   * first twelve entries of a Map built in insertion order, so once a user had
   * more than twelve facts the *oldest* survived and everything learned since
   * was dropped from the prompt — the hire got more forgetful the more it was
   * told. Sixty facts must keep the newest ones.
   */
  it('keeps the newest facts when there are more than fit', () => {
    const facts = Array.from({ length: 60 }, (_, i) =>
      fact(`topic_${i}`, `value ${i}`, 1_000 + i),
    )
    const selected = selectMemoryFacts(mergeMemoryFacts(facts, []), { maxFacts: 12 })
    const keys = selected.map((f) => f.key)

    expect(selected).toHaveLength(12)
    expect(keys).toContain('topic_59')
    expect(keys).toContain('topic_48')
    expect(keys).not.toContain('topic_0')
    expect(keys).not.toContain('topic_10')
  })

  it('never drops an identity fact, however old', () => {
    const facts = [
      fact('preferred_name', 'Sashank', 1),
      fact('timezone', 'America/Los_Angeles', 2),
      fact('hard_nos', 'no pork', 3),
      ...Array.from({ length: 40 }, (_, i) => fact(`topic_${i}`, `value ${i}`, 1_000 + i)),
    ]
    const keys = selectMemoryFacts(mergeMemoryFacts(facts, []), { maxFacts: 5 }).map((f) => f.key)

    expect(keys).toContain('preferred_name')
    expect(keys).toContain('timezone')
    expect(keys).toContain('hard_nos')
  })

  it('orders identity facts deterministically, not by age', () => {
    const facts = [
      fact('hard_nos', 'no pork', 900),
      fact('city', 'Austin', 100),
      fact('preferred_name', 'Sashank', 500),
    ]
    const keys = selectMemoryFacts(mergeMemoryFacts(facts, [])).map((f) => f.key)
    expect(keys).toEqual(['preferred_name', 'city', 'hard_nos'])
  })

  it('lets the server value win but keeps the freshest timestamp', () => {
    const merged = mergeMemoryFacts(
      [fact('diet', 'vegetarian', 100)],
      [{ key: 'diet', value: 'vegan', at: 50 }],
    )
    expect(merged).toHaveLength(1)
    expect(merged[0]!.value).toBe('vegan')
    expect(merged[0]!.at).toBe(100)
  })

  it('stops at the token budget', () => {
    const facts = Array.from({ length: 50 }, (_, i) =>
      fact(`topic_${i}`, 'x'.repeat(400), 1_000 + i),
    )
    const selected = selectMemoryFacts(mergeMemoryFacts(facts, []), { budget: 300 })
    expect(selected.length).toBeGreaterThan(0)
    expect(selected.length).toBeLessThan(10)
  })

  it('takes one oversized fact rather than returning nothing', () => {
    const selected = selectMemoryFacts(mergeMemoryFacts([fact('bio', 'y'.repeat(5000), 1)], []), {
      budget: 10,
    })
    expect(selected).toHaveLength(1)
  })

  it('holds the count cap', () => {
    const facts = Array.from({ length: 200 }, (_, i) => fact(`topic_${i}`, `value ${i}`, 1_000 + i))
    expect(selectMemoryFacts(mergeMemoryFacts(facts, [])).length).toBe(MEMORY_BLOCK_MAX_FACTS)
  })

  it('is deterministic for equal timestamps', () => {
    const a = selectMemoryFacts(mergeMemoryFacts([fact('b', '1', 5), fact('a', '2', 5)], []))
    const b = selectMemoryFacts(mergeMemoryFacts([fact('a', '2', 5), fact('b', '1', 5)], []))
    expect(a.map((f) => f.key)).toEqual(b.map((f) => f.key))
  })

  it('ignores blank keys and values', () => {
    expect(mergeMemoryFacts([fact('  ', 'x', 1), fact('ok', '', 1)], [])).toHaveLength(0)
  })
})

describe('memory block formatting', () => {
  it('renders the facts section and nothing when empty', () => {
    expect(formatMemoryFacts([])).toBe('')
    const block = formatMemoryFacts([fact('preferred_name', 'Sashank', 1)])
    expect(block).toContain('## Known facts about this person')
    expect(block).toContain('preferred_name: Sashank')
  })

  it('parses server timestamps and tolerates missing ones', () => {
    const input = liveFactsToInput([
      { key: 'a', value: '1', updatedAt: '2026-09-11T00:00:00.000Z' },
      { key: 'b', value: '2' },
    ])
    expect(input[0]!.at).toBe(Date.parse('2026-09-11T00:00:00.000Z'))
    expect(input[1]!.at).toBeUndefined()
  })

  it('reads local facts off lastSeen, falling back to ts', () => {
    const input = localFactsToInput([
      { key: 'x', value: '1', ts: 10, lastSeen: 20 },
      { key: 'y', value: '2', ts: 30, lastSeen: undefined as unknown as number },
    ])
    expect(input[0]!.at).toBe(20)
    expect(input[1]!.at).toBe(30)
  })

  it('estimates tokens monotonically', () => {
    expect(estimateTokens('')).toBe(0)
    expect(estimateTokens('abcd')).toBe(1)
    expect(estimateTokens('abcde')).toBe(2)
  })
})
