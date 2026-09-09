import { describe, expect, it } from 'bun:test'
import {
  readSpendCache,
  readSpendSeed,
  writeSpendCache,
  type SpendCachePayload,
} from './spendCache'
import { packHomeCache, type StorageLike } from './homeCache'

function memoryStorage(): StorageLike {
  const map = new Map<string, string>()
  return {
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => map.set(k, v),
    removeItem: (k) => map.delete(k),
  }
}

const AMY = { email: 'amy@example.com', persona: 'friend' }
const TODAY = '2026-09-08'
const NOW = 1788890000000

describe('spendCache', () => {
  it('reads null on cold cache', () => {
    const store = memoryStorage()
    expect(readSpendCache(AMY, TODAY, NOW, store)).toBeNull()
  })

  it('writes and reads back spend cache', () => {
    const store = memoryStorage()
    const payload: SpendCachePayload = {
      logs: [{ id: '1', amount: 25, category: 'food', description: 'Lunch', spentAt: '2026-09-08T12:00:00Z' }],
      byCategory: [{ category: 'food', total: 25 }],
      weekTotal: 25,
      weeklyBudget: 500,
      weekStart: TODAY,
    }
    writeSpendCache(AMY, payload, TODAY, NOW, store)
    const read = readSpendCache(AMY, TODAY, NOW, store)
    expect(read).not.toBeNull()
    expect(read?.weekTotal).toBe(25)
    expect(read?.weeklyBudget).toBe(500)
    expect(read?.byCategory).toEqual([{ category: 'food', total: 25 }])
  })

  it('falls back to homeCache seed when direct spendCache is empty', () => {
    const store = memoryStorage()
    // Seed home cache
    const homeKey = 'home:v1:friend:e:amy@example.com'
    const homeSnap = {
      window: { spend: 120, weeklyBudget: 450 },
      spendByCategory: [
        { category: 'food', amount: 80 },
        { category: 'transport', amount: 40 },
      ],
    }
    store.setItem(homeKey, packHomeCache(homeSnap, TODAY, NOW))

    const seed = readSpendSeed(AMY, TODAY, NOW, store)
    expect(seed.weekTotal).toBe(120)
    expect(seed.weeklyBudget).toBe(450)
    expect(seed.byCategory).toEqual([
      { category: 'food', total: 80 },
      { category: 'transport', total: 40 },
    ])
  })

  it('two-way syncs writeSpendCache into homeCache', () => {
    const store = memoryStorage()
    const homeKey = 'home:v1:friend:e:amy@example.com'
    const homeSnap = {
      window: { spend: 120, weeklyBudget: 450 },
      spendByCategory: [{ category: 'food', amount: 120 }],
    }
    store.setItem(homeKey, packHomeCache(homeSnap, TODAY, NOW))

    const updatedSpend: SpendCachePayload = {
      logs: [],
      byCategory: [
        { category: 'food', total: 120 },
        { category: 'shopping', total: 50 },
      ],
      weekTotal: 170,
      weeklyBudget: 450,
      weekStart: TODAY,
    }
    writeSpendCache(AMY, updatedSpend, TODAY, NOW, store)

    const homeRaw = store.getItem(homeKey)
    expect(homeRaw).not.toBeNull()
    const parsed = JSON.parse(homeRaw!)
    expect(parsed.snap.window.spend).toBe(170)
    expect(parsed.snap.spendByCategory).toEqual([
      { category: 'food', amount: 120 },
      { category: 'shopping', amount: 50 },
    ])
  })
})
