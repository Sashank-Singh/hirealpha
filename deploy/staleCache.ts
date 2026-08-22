/* ---- Serve the last answer, fetch the next one behind it ----
 * Home's slow half is other people's networks: a calendar fetch, a Gmail fetch,
 * and a model call to label the mail. None of it changes minute to minute, and
 * all of it was on the critical path of a screen the user opens several times a
 * day. So it is read from here instead: a fresh entry returns with no work, a
 * stale one returns immediately and refreshes behind the response, and a cold
 * one gets a short wait before the page gives up and paints without it.
 *
 * `pending` is the caller's cue that what it got is not the whole story, so a
 * client can come back once rather than poll.
 */

export type StaleRead<T> = {
  /** The cached value, or null when nothing has ever loaded for this key. */
  value: T | null
  /** True when `value` is inside the TTL. */
  fresh: boolean
  /** True when a load is running or about to be retried, so a later read gets more. */
  pending: boolean
}

export type StaleCacheOptions = {
  /** How long a loaded value counts as fresh. */
  ttlMs: number
  /** How long a cold read waits for a first value before painting without it. */
  maxWaitMs: number
  /** How long to leave a failing loader alone. Without this, every request retries it. */
  failureCooldownMs?: number
  /** Cap on remembered keys; the oldest is dropped first. */
  maxEntries?: number
  now?: () => number
  sleep?: (ms: number) => Promise<void>
  onError?: (key: string, err: unknown) => void
}

const TIMED_OUT = Symbol('stale-cache-timeout')

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms)
    // Nothing is waiting on this timer once the race is decided.
    timer.unref?.()
  })
}

export function createStaleCache<T>(opts: StaleCacheOptions) {
  const now = opts.now ?? (() => Date.now())
  const sleep = opts.sleep ?? defaultSleep
  const cooldownMs = opts.failureCooldownMs ?? 5_000
  const maxEntries = opts.maxEntries ?? 500
  const entries = new Map<string, { value: T; at: number }>()
  const inflight = new Map<string, Promise<T | typeof TIMED_OUT | null>>()
  const failedAt = new Map<string, number>()

  function evict() {
    while (entries.size > maxEntries) {
      let oldestKey: string | null = null
      let oldestAt = Number.POSITIVE_INFINITY
      for (const [key, entry] of entries) {
        if (entry.at < oldestAt) {
          oldestAt = entry.at
          oldestKey = key
        }
      }
      if (oldestKey === null) return
      entries.delete(oldestKey)
    }
  }

  /** Kicks a load unless one is already running or the last one just failed. */
  function start(key: string, load: () => Promise<T>): Promise<T | null> | null {
    const running = inflight.get(key)
    if (running) return running as Promise<T | null>
    const failed = failedAt.get(key)
    if (failed !== undefined && now() - failed < cooldownMs) return null
    const job = load().then(
      (value) => {
        entries.set(key, { value, at: now() })
        failedAt.delete(key)
        evict()
        inflight.delete(key)
        return value
      },
      (err) => {
        // The old value stays exactly as stale as it was — the cooldown, not a
        // forged timestamp, is what stops the retry storm.
        failedAt.set(key, now())
        inflight.delete(key)
        opts.onError?.(key, err)
        return null
      },
    )
    inflight.set(key, job)
    return job
  }

  return {
    /**
     * The value for `key`, loading it with `load` when what is held is missing or
     * past its TTL. `load` is passed per read so it can close over the request
     * that asked; concurrent reads of one key still share a single call.
     */
    async read(key: string, load: () => Promise<T>): Promise<StaleRead<T>> {
      const hit = entries.get(key)
      if (hit && now() - hit.at < opts.ttlMs) return { value: hit.value, fresh: true, pending: false }
      const job = start(key, load)
      // Something to show: hand it over and let the refresh land behind the response.
      if (hit) return { value: hit.value, fresh: false, pending: job !== null }
      if (!job) return { value: null, fresh: false, pending: false }
      const raced = await Promise.race([job, sleep(opts.maxWaitMs).then(() => TIMED_OUT)])
      // Still running: it will finish into the cache, so the next read is cheap.
      if (raced === TIMED_OUT) return { value: null, fresh: false, pending: true }
      if (raced === null) return { value: null, fresh: false, pending: false }
      return { value: raced as T, fresh: true, pending: false }
    },

    /** The cached value without loading anything. For tests and diagnostics. */
    peek(key: string): T | null {
      return entries.get(key)?.value ?? null
    },

    /** Forget a key so the next read loads it again. */
    drop(key: string): void {
      entries.delete(key)
      failedAt.delete(key)
    },
  }
}
