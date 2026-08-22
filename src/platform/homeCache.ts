/**
 * Home's last answer, held on the device so reopening the app paints the screen
 * you left instead of a shimmer. The fresh copy lands a moment later and
 * replaces it, so the cache only ever buys the first frame.
 *
 * Two things this deliberately does NOT do:
 *
 * - It does not cache across days. The snapshot carries its own `weekday` and
 *   `dateLabel` and a "Today" list, so yesterday's copy would render a wrong
 *   date and a stale agenda — a shimmer is the honest answer there.
 * - It does not cache an incomplete answer. When the server says the calendar
 *   and inbox are still filling in, storing that would pin an empty inbox onto
 *   every later open until something else overwrote it.
 *
 * Note that the snapshot includes mail subjects, senders, and the names of
 * people you owe a reply — writing it here puts that text in the browser's
 * localStorage for the rest of the day, per account.
 */
export const HOME_CACHE_VERSION = 1

/** Past this the same-day copy is too old to be worth showing. */
export const HOME_CACHE_MAX_AGE_MS = 4 * 60 * 60 * 1000

export type StorageLike = {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

export type HomeCacheWho = { email?: string; token?: string; persona: string }
export type HomeCacheEnvelope<T> = { v: number; day: string; at: number; snap: T }

/**
 * Whose snapshot this is. Email when we have it — but home is usually opened
 * from a texted link that carries a token and no email at all, so fall back to
 * the token's tail: enough to tell two accounts on one device apart, already
 * sitting in the URL, and not a usable credential by itself.
 */
export function homeCacheIdentity(who: HomeCacheWho): string | null {
  const email = (who.email || '').trim().toLowerCase()
  if (email) return `e:${email}`
  const token = (who.token || '').trim()
  if (token.length >= 8) return `t:${token.slice(-16)}`
  return null
}

/** Null when there is no identity to key on — an unattributed snapshot is not cacheable. */
export function homeCacheKey(who: HomeCacheWho): string | null {
  const id = homeCacheIdentity(who)
  return id ? `home:v${HOME_CACHE_VERSION}:${who.persona}:${id}` : null
}

export function packHomeCache<T>(snap: T, day: string, at: number) {
  return JSON.stringify({ v: HOME_CACHE_VERSION, day, at, snap } satisfies HomeCacheEnvelope<T>)
}

/** Returns null for anything we cannot vouch for: garbage, old shape, other day, too old. */
export function unpackHomeCache<T>(raw: string | null, today: string, now: number): T | null {
  if (!raw) return null
  let parsed: HomeCacheEnvelope<T>
  try {
    parsed = JSON.parse(raw) as HomeCacheEnvelope<T>
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== 'object') return null
  if (parsed.v !== HOME_CACHE_VERSION) return null
  if (parsed.day !== today) return null
  if (!Number.isFinite(parsed.at) || now - parsed.at > HOME_CACHE_MAX_AGE_MS) return null
  if (parsed.at > now + 60_000) return null // clock moved backwards; don't trust it
  return parsed.snap ?? null
}

export function shouldCacheHome(snap: { worldPending?: boolean } | null | undefined) {
  return !!snap && !snap.worldPending
}

/** localStorage throws in private mode and when quota is full — never let it break a render. */
export function safeStorage(): StorageLike | null {
  try {
    return globalThis.localStorage || null
  } catch {
    return null
  }
}

export function readHomeCache<T>(who: HomeCacheWho, today: string, now: number, store = safeStorage()): T | null {
  const key = store && homeCacheKey(who)
  if (!store || !key) return null
  try {
    return unpackHomeCache<T>(store.getItem(key), today, now)
  } catch {
    return null
  }
}

export function writeHomeCache<T extends { worldPending?: boolean }>(
  who: HomeCacheWho,
  snap: T | null | undefined,
  today: string,
  now: number,
  store = safeStorage(),
) {
  const key = store && homeCacheKey(who)
  // Leave a good earlier copy alone rather than replacing it with a worse one.
  if (!store || !key || !shouldCacheHome(snap)) return
  try {
    store.setItem(key, packHomeCache(snap, today, now))
  } catch {
    try {
      store.removeItem(key)
    } catch {
      /* nothing left to try */
    }
  }
}
