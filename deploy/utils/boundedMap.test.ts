import { describe, expect, it } from 'bun:test'
import { createBoundedMap } from './boundedMap'

describe('createBoundedMap', () => {
  it('enforces maxEntries via LRU eviction', () => {
    const map = createBoundedMap<string, number>({ maxEntries: 3 })
    map.set('a', 1)
    map.set('b', 2)
    map.set('c', 3)
    expect(map.size()).toBe(3)
    expect(map.get('a')).toBe(1)

    // Accessing 'a' makes it most recently used. Oldest is now 'b'.
    map.set('d', 4)
    expect(map.size()).toBe(3)
    expect(map.get('b')).toBeUndefined() // evicted
    expect(map.get('a')).toBe(1) // retained
    expect(map.get('c')).toBe(3)
    expect(map.get('d')).toBe(4)
  })

  it('expires entries after TTL', () => {
    let fakeTime = 1000
    const map = createBoundedMap<string, string>({
      maxEntries: 10,
      ttlMs: 500,
      now: () => fakeTime,
    })

    map.set('key1', 'val1')
    expect(map.get('key1')).toBe('val1')
    expect(map.has('key1')).toBe(true)

    // Fast-forward beyond TTL
    fakeTime += 600
    expect(map.get('key1')).toBeUndefined()
    expect(map.has('key1')).toBe(false)
    expect(map.size()).toBe(0)
  })

  it('prune sweeps all expired entries', () => {
    let fakeTime = 1000
    const map = createBoundedMap<string, string>({
      maxEntries: 10,
      ttlMs: 200,
      now: () => fakeTime,
    })

    map.set('k1', 'v1')
    map.set('k2', 'v2', 5000) // custom long TTL

    fakeTime += 300
    expect(map.prune()).toBe(1)
    expect(map.get('k1')).toBeUndefined()
    expect(map.get('k2')).toBe('v2')
  })
})
