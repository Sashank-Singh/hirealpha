import { describe, expect, test } from 'bun:test'
import {
  HOME_CACHE_MAX_AGE_MS,
  homeCacheIdentity,
  homeCacheKey,
  packHomeCache,
  readHomeCache,
  shouldCacheHome,
  unpackHomeCache,
  writeHomeCache,
  type StorageLike,
} from './homeCache'

function memStore(seed: Record<string, string> = {}): StorageLike & { map: Map<string, string> } {
  const map = new Map(Object.entries(seed))
  return {
    map,
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => void map.set(k, v),
    removeItem: (k) => void map.delete(k),
  }
}

const NOW = 1_700_000_000_000
const TODAY = '2026-08-22'
const AMY = { email: 'a@x.com', persona: 'friend' }

describe('homeCacheIdentity', () => {
  test('prefers the email, case and whitespace insensitively', () => {
    expect(homeCacheIdentity({ email: '  A@X.com ', persona: 'friend' })).toBe('e:a@x.com')
  })

  test('falls back to the token tail, which is how texted links arrive', () => {
    expect(homeCacheIdentity({ token: 'abcdefghijklmnopqrstuvwxyz012345', persona: 'friend' })).toBe(
      't:qrstuvwxyz012345',
    )
  })

  test('uses exactly the last 16 characters of the token', () => {
    expect(homeCacheIdentity({ token: 'x'.repeat(20) + 'ABCDEFGHIJKLMNOP', persona: 'friend' })).toBe(
      't:ABCDEFGHIJKLMNOP',
    )
  })

  test('two tokens differing only in the tail do not collide', () => {
    const a = homeCacheIdentity({ token: `${'z'.repeat(40)}aaaaaaaaaaaaaaa1`, persona: 'friend' })
    const b = homeCacheIdentity({ token: `${'z'.repeat(40)}aaaaaaaaaaaaaaa2`, persona: 'friend' })
    expect(a).not.toBe(b)
  })

  test('is null with no identity at all, or a token too short to trust', () => {
    expect(homeCacheIdentity({ persona: 'friend' })).toBeNull()
    expect(homeCacheIdentity({ email: '   ', token: 'abc', persona: 'friend' })).toBeNull()
  })
})

describe('homeCacheKey', () => {
  test('separates accounts and personas', () => {
    expect(homeCacheKey(AMY)).not.toBe(homeCacheKey({ email: 'b@x.com', persona: 'friend' }))
    expect(homeCacheKey(AMY)).not.toBe(homeCacheKey({ email: 'a@x.com', persona: 'coworker' }))
  })

  test('an email key and a token key are never the same', () => {
    expect(homeCacheKey({ email: 'a@x.com', persona: 'friend' })).not.toBe(
      homeCacheKey({ token: 'tok-aaaaaaaaaaaaaaaa', persona: 'friend' }),
    )
  })

  test('is null with nothing to key on', () => {
    expect(homeCacheKey({ persona: 'friend' })).toBeNull()
  })
})

describe('unpackHomeCache', () => {
  test('round-trips a same-day snapshot', () => {
    const packed = packHomeCache({ home: { weekday: 'Sat' } }, TODAY, NOW)
    expect(unpackHomeCache<{ home: { weekday: string } }>(packed, TODAY, NOW)).toEqual({ home: { weekday: 'Sat' } })
  })

  test('rejects a different day', () => {
    expect(unpackHomeCache(packHomeCache({ n: 1 }, '2026-08-21', NOW), TODAY, NOW)).toBeNull()
  })

  test('rejects a copy past the max age but keeps one just inside', () => {
    expect(unpackHomeCache(packHomeCache({ n: 1 }, TODAY, NOW - HOME_CACHE_MAX_AGE_MS - 1), TODAY, NOW)).toBeNull()
    expect(unpackHomeCache(packHomeCache({ n: 1 }, TODAY, NOW - HOME_CACHE_MAX_AGE_MS + 1000), TODAY, NOW)).toEqual({
      n: 1,
    })
  })

  test('rejects a future stamp', () => {
    expect(unpackHomeCache(packHomeCache({ n: 1 }, TODAY, NOW + 10 * 60_000), TODAY, NOW)).toBeNull()
  })

  test('rejects garbage, empty, and an older version', () => {
    expect(unpackHomeCache('not json', TODAY, NOW)).toBeNull()
    expect(unpackHomeCache(null, TODAY, NOW)).toBeNull()
    expect(unpackHomeCache('"a string"', TODAY, NOW)).toBeNull()
    expect(unpackHomeCache(JSON.stringify({ v: 0, day: TODAY, at: NOW, snap: { n: 1 } }), TODAY, NOW)).toBeNull()
  })
})

describe('shouldCacheHome', () => {
  test('skips a pending snapshot and null', () => {
    expect(shouldCacheHome({ worldPending: true })).toBe(false)
    expect(shouldCacheHome(null)).toBe(false)
    expect(shouldCacheHome({ worldPending: false })).toBe(true)
    expect(shouldCacheHome({})).toBe(true)
  })
})

describe('read/write', () => {
  test('a written snapshot reads back for the same account', () => {
    const store = memStore()
    writeHomeCache(AMY, { worldPending: false, n: 1 }, TODAY, NOW, store)
    expect(readHomeCache(AMY, TODAY, NOW, store)).toEqual({ worldPending: false, n: 1 })
    expect(readHomeCache({ email: 'other@x.com', persona: 'friend' }, TODAY, NOW, store)).toBeNull()
  })

  test('a token-only open caches and reads back, since that is the common link', () => {
    const store = memStore()
    const who = { token: 'sig-1234567890abcdef', persona: 'friend' }
    writeHomeCache(who, { worldPending: false, n: 7 }, TODAY, NOW, store)
    expect(readHomeCache(who, TODAY, NOW, store)).toEqual({ worldPending: false, n: 7 })
  })

  test('a pending snapshot does not overwrite a good copy', () => {
    const store = memStore()
    writeHomeCache(AMY, { worldPending: false, mail: ['real'] }, TODAY, NOW, store)
    writeHomeCache(AMY, { worldPending: true, mail: [] }, TODAY, NOW, store)
    expect(readHomeCache<{ mail: string[] }>(AMY, TODAY, NOW, store)?.mail).toEqual(['real'])
  })

  test('a throwing store never propagates', () => {
    const store: StorageLike = {
      getItem: () => {
        throw new Error('denied')
      },
      setItem: () => {
        throw new Error('quota')
      },
      removeItem: () => {
        throw new Error('denied')
      },
    }
    expect(readHomeCache(AMY, TODAY, NOW, store)).toBeNull()
    expect(() => writeHomeCache(AMY, { worldPending: false }, TODAY, NOW, store)).not.toThrow()
  })

  test('yesterday’s stored copy is ignored today', () => {
    const store = memStore()
    writeHomeCache(AMY, { worldPending: false, n: 1 }, '2026-08-21', NOW, store)
    expect(readHomeCache(AMY, TODAY, NOW, store)).toBeNull()
  })

  test('no identity means nothing is stored or read', () => {
    const store = memStore()
    writeHomeCache({ persona: 'friend' }, { worldPending: false, n: 1 }, TODAY, NOW, store)
    expect(store.map.size).toBe(0)
    expect(readHomeCache({ persona: 'friend' }, TODAY, NOW, store)).toBeNull()
  })
})
