import { describe, expect, it } from 'bun:test'
import { selectMemoriesForRecall, type MemoryRow } from './memory/store'

describe('semantic memory candidate selection', () => {
  it('can select a relevant fact beyond the former 200-row recency window', () => {
    const rows: MemoryRow[] = Array.from({ length: 250 }, (_, index) => ({
      key: `fact_${index}`,
      value: `value ${index}`,
      durable: false,
      updatedAt: new Date(Date.UTC(2026, 0, 250 - index)).toISOString(),
    }))

    const selected = selectMemoriesForRecall(rows, [{ key: 'fact_249' }], 40)

    expect(selected).toHaveLength(40)
    expect(selected[0]?.key).toBe('fact_249')
  })

  it('uses authoritative text and de-duplicates repeated index hits', () => {
    const rows: MemoryRow[] = [
      { key: 'drink_order', value: 'authoritative flat white', durable: false },
      { key: 'recent', value: 'new fact', durable: false },
    ]

    const selected = selectMemoriesForRecall(
      rows,
      [{ key: 'drink_order' }, { key: 'drink_order' }, { key: 'missing' }],
      10,
    )

    expect(selected.map((row) => row.key)).toEqual(['drink_order', 'recent'])
    expect(selected[0]?.value).toBe('authoritative flat white')
  })
})
