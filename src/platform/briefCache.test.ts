import { describe, expect, test } from 'bun:test'
import {
  BRIEF_CACHE_MAX_AGE_MS,
  briefCacheKey,
  briefDayOf,
  packBrief,
  readBriefCache,
  shouldCacheBrief,
  unpackBrief,
  writeBriefCache,
  type StorageLike,
} from './briefCache'

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
const YESTERDAY = '2026-08-21'
const AMY = { email: 'a@x.com', persona: 'friend' }
const brief = (heading = 'Left this evening') => ({
  kind: 'pick_night',
  title: 'Evening brief',
  date: 'Saturday, August 22, 2026',
  sections: [{ heading, items: ['6:00 PM  Amy  Meeting'] }],
})

describe('briefCacheKey', () => {
  test('separates the two briefs so morning never paints over evening', () => {
    expect(briefCacheKey(AMY, 'digest')).toBe('brief:v2:friend:digest:e:a@x.com')
    expect(briefCacheKey(AMY, 'pick_night')).toBe('brief:v2:friend:pick_night:e:a@x.com')
  })

  test('separates personas, since one device opens more than one', () => {
    expect(briefCacheKey({ ...AMY, persona: 'coworker' }, 'digest')).not.toBe(briefCacheKey(AMY, 'digest'))
  })

  test('is null without an identity or without a kind', () => {
    expect(briefCacheKey({ persona: 'friend' }, 'digest')).toBeNull()
    expect(briefCacheKey(AMY, '')).toBeNull()
  })
})

describe('shouldCacheBrief', () => {
  test('keeps the evening brief, whose shape is sections', () => {
    expect(shouldCacheBrief(brief())).toBe(true)
  })

  test('keeps the morning brief, whose shape is not sections at all', () => {
    expect(shouldCacheBrief({ calendar: ['9:00 AM  Amy'] })).toBe(true)
    expect(shouldCacheBrief({ emails: ['Amy — the deck'] })).toBe(true)
    expect(shouldCacheBrief({ story: { lead: 'Two meetings and a deck' } })).toBe(true)
  })

  test('refuses the pending answer, which is what the server sends on a cold miss', () => {
    expect(shouldCacheBrief({ ...brief(), pending: true })).toBe(false)
  })

  test('refuses an error payload — the next open should try again, not read this', () => {
    expect(shouldCacheBrief({ error: "Couldn't load your brief right now." })).toBe(false)
  })

  test('refuses a brief with nothing to paint', () => {
    expect(shouldCacheBrief({ sections: [] })).toBe(false)
    expect(shouldCacheBrief({ calendar: [], emails: [] })).toBe(false)
    expect(shouldCacheBrief({})).toBe(false)
    expect(shouldCacheBrief(null)).toBe(false)
    expect(shouldCacheBrief(undefined)).toBe(false)
  })
})

describe('unpackBrief', () => {
  test('round-trips a brief saved a moment ago', () => {
    const raw = packBrief(brief(), 'pick_night', TODAY, NOW)
    expect(unpackBrief(raw, 'pick_night', TODAY, NOW + 60_000)).toEqual(brief())
  })

  test('refuses yesterday, because a brief carries its own date line', () => {
    const yesterBrief = { ...brief(), date: 'Friday, August 21, 2026' }
    const raw = packBrief(yesterBrief, 'pick_night', YESTERDAY, NOW)
    expect(unpackBrief(raw, 'pick_night', TODAY, NOW)).toBeNull()
  })

  test('refuses yesterday even when the envelope day was stamped at write time as today — the brief itself says so', () => {
    /* This is the "stuck on Aug 29" shape: a brief whose payload date is
     * yesterday, written into localStorage under an envelope that claimed
     * today. The previous code accepted it because it compared envelope.day
     * to localYmd(); the fix reads the brief's own date. */
    const yesterBrief = { ...brief(), date: 'Friday, August 29, 2026' }
    const raw = packBrief(yesterBrief, 'pick_night', TODAY, NOW)
    expect(unpackBrief(raw, 'pick_night', TODAY, NOW)).toBeNull()
  })

  test('refuses garbage, a missing entry, and an older envelope shape', () => {
    expect(unpackBrief(null, 'digest', TODAY, NOW)).toBeNull()
    expect(unpackBrief('{not json', 'digest', TODAY, NOW)).toBeNull()
    expect(unpackBrief('"a string"', 'digest', TODAY, NOW)).toBeNull()
    expect(
      unpackBrief(JSON.stringify({ v: 0, day: TODAY, kind: 'digest', at: NOW, brief: brief() }), 'digest', TODAY, NOW),
    ).toBeNull()
    // The bumped version: prior envelopes must be refused too.
    expect(
      unpackBrief(
        JSON.stringify({ v: 1, day: TODAY, kind: 'digest', at: NOW, brief: brief() }),
        'digest',
        TODAY,
        NOW,
      ),
    ).toBeNull()
  })
})

describe('briefDayOf', () => {
  test('reads ISO dates', () => {
    expect(briefDayOf({ date: '2026-08-22' })).toBe('2026-08-22')
  })

  test('reads "Friday, August 29, 2026"', () => {
    expect(briefDayOf({ date: 'Friday, August 29, 2026' })).toBe('2026-08-29')
  })

  test('reads "August 29"', () => {
    expect(briefDayOf({ date: 'August 29' })).toBeNull() // no year — refuse so cross-year bugs surface, not silently match
  })

  test('returns null when there is no date', () => {
    expect(briefDayOf({})).toBeNull()
    expect(briefDayOf(null)).toBeNull()
    expect(briefDayOf({ date: 42 })).toBeNull()
  })

  test('refuses the other brief even if the key were reused', () => {
    const raw = packBrief(brief(), 'digest', TODAY, NOW)
    expect(unpackBrief(raw, 'pick_night', TODAY, NOW)).toBeNull()
  })

  test('refuses a copy older than the window, and keeps one inside it', () => {
    const raw = packBrief(brief(), 'digest', TODAY, NOW)
    expect(unpackBrief(raw, 'digest', TODAY, NOW + BRIEF_CACHE_MAX_AGE_MS + 1)).toBeNull()
    expect(unpackBrief(raw, 'digest', TODAY, NOW + BRIEF_CACHE_MAX_AGE_MS - 1)).not.toBeNull()
  })

  test('refuses a stamp from the future — the clock moved, so nothing here is trustworthy', () => {
    const raw = packBrief(brief(), 'digest', TODAY, NOW + 10 * 60_000)
    expect(unpackBrief(raw, 'digest', TODAY, NOW)).toBeNull()
  })

  test('refuses garbage, a missing entry, and an older envelope shape', () => {
    expect(unpackBrief(null, 'digest', TODAY, NOW)).toBeNull()
    expect(unpackBrief('{not json', 'digest', TODAY, NOW)).toBeNull()
    expect(unpackBrief('"a string"', 'digest', TODAY, NOW)).toBeNull()
    expect(
      unpackBrief(JSON.stringify({ v: 0, day: TODAY, kind: 'digest', at: NOW, brief: brief() }), 'digest', TODAY, NOW),
    ).toBeNull()
  })
})

describe('readBriefCache and writeBriefCache', () => {
  test('what was written is what comes back', () => {
    const store = memStore()
    writeBriefCache(AMY, 'pick_night', brief(), TODAY, NOW, store)
    expect(readBriefCache(AMY, 'pick_night', TODAY, NOW, store)).toEqual(brief())
  })

  test('a pending answer never overwrites the good copy already there', () => {
    const store = memStore()
    writeBriefCache(AMY, 'digest', brief('Mail since this morning'), TODAY, NOW, store)
    writeBriefCache(AMY, 'digest', { pending: true, sections: [] }, TODAY, NOW + 1000, store)
    expect(readBriefCache(AMY, 'digest', TODAY, NOW + 1000, store)).toEqual(brief('Mail since this morning'))
  })

  test('writes nothing when there is no identity to key on', () => {
    const store = memStore()
    writeBriefCache({ persona: 'friend' }, 'digest', brief(), TODAY, NOW, store)
    expect(store.map.size).toBe(0)
  })

  test('a storage that throws on write never breaks the caller', () => {
    const throwing: StorageLike = {
      getItem: () => null,
      setItem: () => {
        throw new Error('quota')
      },
      removeItem: () => {},
    }
    expect(() => writeBriefCache(AMY, 'digest', brief(), TODAY, NOW, throwing)).not.toThrow()
  })

  test('a storage that throws on read yields null rather than a blank screen', () => {
    const throwing: StorageLike = {
      getItem: () => {
        throw new Error('blocked')
      },
      setItem: () => {},
      removeItem: () => {},
    }
    expect(readBriefCache(AMY, 'digest', TODAY, NOW, throwing)).toBeNull()
  })
})
