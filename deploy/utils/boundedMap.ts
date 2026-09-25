/**
 * Zero-dependency bounded in-memory map with TTL and LRU eviction.
 */
export interface BoundedMapOptions {
  maxEntries: number
  ttlMs?: number
  now?: () => number
}

export interface BoundedMap<K, V> {
  get(key: K): V | undefined
  set(key: K, value: V, customTtlMs?: number): void
  has(key: K): boolean
  delete(key: K): boolean
  clear(): void
  prune(): number
  size(): number
}

export function createBoundedMap<K, V>(options: BoundedMapOptions): BoundedMap<K, V> {
  const maxEntries = Math.max(1, options.maxEntries)
  const defaultTtlMs = options.ttlMs && options.ttlMs > 0 ? options.ttlMs : undefined
  const now = options.now ?? (() => Date.now())

  interface MapEntry {
    value: V
    expiresAt?: number
  }

  const map = new Map<K, MapEntry>()

  function evictExpired(): number {
    const current = now()
    let pruned = 0
    for (const [key, entry] of map.entries()) {
      if (entry.expiresAt !== undefined && current > entry.expiresAt) {
        map.delete(key)
        pruned++
      }
    }
    return pruned
  }

  function evictOldest(): void {
    // Evict expired first if map is full
    if (evictExpired() > 0 && map.size < maxEntries) return

    // Evict LRU (first item in Map iteration order)
    const firstKey = map.keys().next().value
    if (firstKey !== undefined) {
      map.delete(firstKey)
    }
  }

  return {
    get(key: K): V | undefined {
      const entry = map.get(key)
      if (!entry) return undefined
      if (entry.expiresAt !== undefined && now() > entry.expiresAt) {
        map.delete(key)
        return undefined
      }
      // Re-insert to refresh LRU order
      map.delete(key)
      map.set(key, entry)
      return entry.value
    },

    set(key: K, value: V, customTtlMs?: number): void {
      const ttl = customTtlMs ?? defaultTtlMs
      const expiresAt = ttl !== undefined ? now() + ttl : undefined

      if (map.has(key)) {
        map.delete(key)
      } else if (map.size >= maxEntries) {
        evictOldest()
      }

      map.set(key, { value, expiresAt })
    },

    has(key: K): boolean {
      const entry = map.get(key)
      if (!entry) return false
      if (entry.expiresAt !== undefined && now() > entry.expiresAt) {
        map.delete(key)
        return false
      }
      return true
    },

    delete(key: K): boolean {
      return map.delete(key)
    },

    clear(): void {
      map.clear()
    },

    prune(): number {
      return evictExpired()
    },

    size(): number {
      evictExpired()
      return map.size
    },
  }
}
