import { describe, expect, it } from 'bun:test'
import { createStaleCache } from './staleCache'

/** A clock and a sleep that only move when the test says so. */
function fakeClock(start = 1_000) {
  let t = start
  const timers: Array<{ at: number; resolve: () => void }> = []
  return {
    now: () => t,
    sleep: (ms: number) => new Promise<void>((resolve) => timers.push({ at: t + ms, resolve })),
    advance(ms: number) {
      t += ms
      const due = timers.filter((x) => x.at <= t)
      const unfired = timers.filter((x) => x.at > t)
      timers.length = 0
      timers.push(...unfired)
      for (const timer of due) timer.resolve()
    },
  }
}

/** A loader whose every call is resolved by hand. */
function deferredLoader<T>() {
  const calls: Array<{ key: string; resolve: (v: T) => void; reject: (e: unknown) => void }> = []
  const load = (key: string) =>
    new Promise<T>((resolve, reject) => {
      calls.push({ key, resolve, reject })
    })
  return { load, calls }
}

const settle = () => new Promise<void>((r) => setTimeout(r, 0))

describe('createStaleCache', () => {
  it('waits for a cold read and reports it fresh', async () => {
    const clock = fakeClock()
    const { load, calls } = deferredLoader<string>()
    const cache = createStaleCache<string>({ ttlMs: 1000, maxWaitMs: 100, now: clock.now, sleep: clock.sleep })

    const read = cache.read('u1', () => load('u1'))
    await settle()
    calls[0]!.resolve('world')
    expect(await read).toEqual({ value: 'world', fresh: true, pending: false })
    expect(calls).toHaveLength(1)
  })

  it('serves a fresh entry without loading again', async () => {
    const clock = fakeClock()
    const { load, calls } = deferredLoader<string>()
    const cache = createStaleCache<string>({ ttlMs: 1000, maxWaitMs: 100, now: clock.now, sleep: clock.sleep })

    const first = cache.read('u1', () => load('u1'))
    await settle()
    calls[0]!.resolve('world')
    await first

    clock.advance(500)
    expect(await cache.read('u1', () => load('u1'))).toEqual({ value: 'world', fresh: true, pending: false })
    expect(calls).toHaveLength(1)
  })

  it('returns a stale entry at once and refreshes behind it', async () => {
    const clock = fakeClock()
    const { load, calls } = deferredLoader<string>()
    const cache = createStaleCache<string>({ ttlMs: 1000, maxWaitMs: 100, now: clock.now, sleep: clock.sleep })

    const first = cache.read('u1', () => load('u1'))
    await settle()
    calls[0]!.resolve('old')
    await first

    clock.advance(1500)
    // Resolves without the second load finishing — that is the whole point.
    expect(await cache.read('u1', () => load('u1'))).toEqual({ value: 'old', fresh: false, pending: true })
    expect(calls).toHaveLength(2)

    calls[1]!.resolve('new')
    await settle()
    expect(cache.peek('u1')).toBe('new')
  })

  it('gives up on a cold read after maxWait and keeps loading', async () => {
    const clock = fakeClock()
    const { load, calls } = deferredLoader<string>()
    const cache = createStaleCache<string>({ ttlMs: 1000, maxWaitMs: 100, now: clock.now, sleep: clock.sleep })

    const read = cache.read('u1', () => load('u1'))
    await settle()
    clock.advance(100)
    expect(await read).toEqual({ value: null, fresh: false, pending: true })

    // The abandoned load still populates the cache for the next request.
    calls[0]!.resolve('late')
    await settle()
    expect(cache.peek('u1')).toBe('late')
    expect(await cache.read('u1', () => load('u1'))).toEqual({ value: 'late', fresh: true, pending: false })
  })

  it('runs one load for concurrent readers of the same key', async () => {
    const clock = fakeClock()
    const { load, calls } = deferredLoader<string>()
    const cache = createStaleCache<string>({ ttlMs: 1000, maxWaitMs: 100, now: clock.now, sleep: clock.sleep })

    const a = cache.read('u1', () => load('u1'))
    const b = cache.read('u1', () => load('u1'))
    await settle()
    expect(calls).toHaveLength(1)
    calls[0]!.resolve('world')
    expect((await a).value).toBe('world')
    expect((await b).value).toBe('world')
  })

  it('keeps keys apart', async () => {
    const clock = fakeClock()
    const { load, calls } = deferredLoader<string>()
    const cache = createStaleCache<string>({ ttlMs: 1000, maxWaitMs: 100, now: clock.now, sleep: clock.sleep })

    const a = cache.read('u1', () => load('u1'))
    const b = cache.read('u2', () => load('u2'))
    await settle()
    expect(calls.map((c) => c.key)).toEqual(['u1', 'u2'])
    calls[0]!.resolve('one')
    calls[1]!.resolve('two')
    expect((await a).value).toBe('one')
    expect((await b).value).toBe('two')
  })

  it('reports a failed cold read as empty and not pending', async () => {
    const clock = fakeClock()
    const { load, calls } = deferredLoader<string>()
    const errors: string[] = []
    const cache = createStaleCache<string>({
      ttlMs: 1000,
      maxWaitMs: 100,
      failureCooldownMs: 500,
      now: clock.now,
      sleep: clock.sleep,
      onError: (key) => errors.push(key),
    })

    const read = cache.read('u1', () => load('u1'))
    await settle()
    calls[0]!.reject(new Error('gmail down'))
    expect(await read).toEqual({ value: null, fresh: false, pending: false })
    expect(errors).toEqual(['u1'])
  })

  it('leaves a failing loader alone until the cooldown passes', async () => {
    const clock = fakeClock()
    const { load, calls } = deferredLoader<string>()
    const cache = createStaleCache<string>({
      ttlMs: 1000,
      maxWaitMs: 100,
      failureCooldownMs: 500,
      now: clock.now,
      sleep: clock.sleep,
    })

    const read = cache.read('u1', () => load('u1'))
    await settle()
    calls[0]!.reject(new Error('down'))
    await read

    clock.advance(100)
    expect(await cache.read('u1', () => load('u1'))).toEqual({ value: null, fresh: false, pending: false })
    expect(calls).toHaveLength(1)

    clock.advance(500)
    const retry = cache.read('u1', () => load('u1'))
    await settle()
    expect(calls).toHaveLength(2)
    calls[1]!.resolve('back')
    expect((await retry).value).toBe('back')
  })

  it('keeps serving the last good value when a refresh fails', async () => {
    const clock = fakeClock()
    const { load, calls } = deferredLoader<string>()
    const cache = createStaleCache<string>({
      ttlMs: 1000,
      maxWaitMs: 100,
      failureCooldownMs: 500,
      now: clock.now,
      sleep: clock.sleep,
    })

    const first = cache.read('u1', () => load('u1'))
    await settle()
    calls[0]!.resolve('old')
    await first

    clock.advance(1500)
    await cache.read('u1', () => load('u1'))
    calls[1]!.reject(new Error('down'))
    await settle()

    // Still the old answer, and no second attempt inside the cooldown.
    expect(await cache.read('u1', () => load('u1'))).toEqual({ value: 'old', fresh: false, pending: false })
    expect(calls).toHaveLength(2)
  })

  it('drops the oldest key past maxEntries', async () => {
    const clock = fakeClock()
    const { load, calls } = deferredLoader<string>()
    const cache = createStaleCache<string>({
      ttlMs: 10_000,
      maxWaitMs: 100,
      maxEntries: 2,
      now: clock.now,
      sleep: clock.sleep,
    })

    for (const key of ['a', 'b', 'c']) {
      const read = cache.read(key, () => load(key))
      await settle()
      calls.at(-1)!.resolve(key)
      await read
      clock.advance(10)
    }

    expect(cache.peek('a')).toBeNull()
    expect(cache.peek('b')).toBe('b')
    expect(cache.peek('c')).toBe('c')
  })

  it('forgets a dropped key', async () => {
    const clock = fakeClock()
    const { load, calls } = deferredLoader<string>()
    const cache = createStaleCache<string>({ ttlMs: 1000, maxWaitMs: 100, now: clock.now, sleep: clock.sleep })

    const first = cache.read('u1', () => load('u1'))
    await settle()
    calls[0]!.resolve('one')
    await first

    cache.drop('u1')
    expect(cache.peek('u1')).toBeNull()
    const second = cache.read('u1', () => load('u1'))
    await settle()
    expect(calls).toHaveLength(2)
    calls[1]!.resolve('two')
    expect((await second).value).toBe('two')
  })

  it('lets one read wait longer than the cache default', async () => {
    const clock = fakeClock()
    const { load, calls } = deferredLoader<string>()
    const cache = createStaleCache<string>({ ttlMs: 1000, maxWaitMs: 100, now: clock.now, sleep: clock.sleep })

    const read = cache.read('u1', () => load('u1'), 500)
    await settle()
    // Past the cache's own 100ms wait, and this reader is still holding on.
    clock.advance(100)
    await settle()
    calls[0]!.resolve('slow but worth it')
    expect(await read).toEqual({ value: 'slow but worth it', fresh: true, pending: false })
  })

  it('lets one read wait less than the cache default', async () => {
    const clock = fakeClock()
    const { load } = deferredLoader<string>()
    const cache = createStaleCache<string>({ ttlMs: 1000, maxWaitMs: 5000, now: clock.now, sleep: clock.sleep })

    const read = cache.read('u1', () => load('u1'), 100)
    await settle()
    clock.advance(100)
    expect(await read).toEqual({ value: null, fresh: false, pending: true })
  })

  it('shares one load between readers that disagree about the wait', async () => {
    const clock = fakeClock()
    const { load, calls } = deferredLoader<string>()
    const cache = createStaleCache<string>({ ttlMs: 1000, maxWaitMs: 100, now: clock.now, sleep: clock.sleep })

    const impatient = cache.read('u1', () => load('u1'), 50)
    const patient = cache.read('u1', () => load('u1'), 5000)
    await settle()
    clock.advance(50)
    expect(await impatient).toEqual({ value: null, fresh: false, pending: true })

    clock.advance(1000)
    calls[0]!.resolve('arrived')
    expect(await patient).toEqual({ value: 'arrived', fresh: true, pending: false })
    // One fetch, two answers — which is what makes sharing a cache across
    // screens with different patience worth doing.
    expect(calls).toHaveLength(1)
  })
})
