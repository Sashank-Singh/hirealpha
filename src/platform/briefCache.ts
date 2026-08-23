/**
 * The last brief this device saw, held so that reopening one paints the brief you
 * left instead of a spinner. Home already does this with [homeCache](./homeCache.ts);
 * the brief is the screen that most needed it and had none — it is the one Alpha
 * texts you a link to, and it is the slowest thing in the app, because building it
 * cold means a hop into Google Calendar, a hop into Gmail, and a model pass.
 *
 * Same three refusals as home, for the same reasons:
 *
 * - Not across days. A brief carries its own `date` line and a "Tomorrow"
 *   section, so yesterday's copy is not a stale brief, it is a wrong one.
 * - Not across kinds. Morning and evening are different briefs with different
 *   sections; the kind is in the key and checked again in the envelope.
 * - Not a half-built answer. When the server says `pending`, storing it would pin
 *   "Closing out your day" onto every later open until something overwrote it.
 *
 * A brief is mostly other people's mail — subjects and senders — so writing it
 * here puts that text in localStorage for the rest of the day, per account, just
 * as the home snapshot already does.
 */
import { homeCacheIdentity, safeStorage, type HomeCacheWho, type StorageLike } from './homeCache'

export const BRIEF_CACHE_VERSION = 1

/**
 * Shorter than home's four hours. A brief is a claim about a slice of the day —
 * mail "since this morning", what is "left this evening" — and after an hour and
 * a half that claim has usually stopped being true.
 */
export const BRIEF_CACHE_MAX_AGE_MS = 90 * 60 * 1000

export type BriefCacheWho = HomeCacheWho
export type BriefEnvelope<T> = { v: number; day: string; kind: string; at: number; brief: T }

/** What the cache needs to see to decide a payload is worth keeping. The two briefs
 * do not share a shape — the evening one is `sections`, the morning one is
 * `calendar`/`emails`/`story` — so both are named here. */
export type CacheableBrief = {
  pending?: boolean
  error?: string
  sections?: Array<{ heading: string; items: string[] }>
  calendar?: string[]
  emails?: string[]
  story?: unknown
}

/** Null when there is no identity to key on — an unattributed brief is not cacheable. */
export function briefCacheKey(who: BriefCacheWho, kind: string): string | null {
  const id = homeCacheIdentity(who)
  if (!id || !kind) return null
  return `brief:v${BRIEF_CACHE_VERSION}:${who.persona}:${kind}:${id}`
}

export function packBrief<T>(brief: T, kind: string, day: string, at: number) {
  return JSON.stringify({ v: BRIEF_CACHE_VERSION, day, kind, at, brief } satisfies BriefEnvelope<T>)
}

/** Returns null for anything we cannot vouch for: garbage, old shape, other day, other kind, too old. */
export function unpackBrief<T>(raw: string | null, kind: string, today: string, now: number): T | null {
  if (!raw) return null
  let parsed: BriefEnvelope<T>
  try {
    parsed = JSON.parse(raw) as BriefEnvelope<T>
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== 'object') return null
  if (parsed.v !== BRIEF_CACHE_VERSION) return null
  if (parsed.day !== today) return null
  if (parsed.kind !== kind) return null
  if (!Number.isFinite(parsed.at) || now - parsed.at > BRIEF_CACHE_MAX_AGE_MS) return null
  if (parsed.at > now + 60_000) return null // clock moved backwards; don't trust it
  return parsed.brief ?? null
}

/**
 * A brief is worth keeping only if it actually said something. `pending` means the
 * server answered before the brief was built, and an `error` payload is worth even
 * less; a brief with none of its content fields has nothing to paint, and storing
 * it would replace a good earlier copy with a blank one.
 */
export function shouldCacheBrief(brief: CacheableBrief | null | undefined) {
  if (!brief || brief.pending || brief.error) return false
  if (brief.sections?.length) return true
  if (brief.calendar?.length) return true
  if (brief.emails?.length) return true
  return !!brief.story
}

export function readBriefCache<T>(
  who: BriefCacheWho,
  kind: string,
  today: string,
  now: number,
  store = safeStorage(),
): T | null {
  const key = store && briefCacheKey(who, kind)
  if (!store || !key) return null
  try {
    return unpackBrief<T>(store.getItem(key), kind, today, now)
  } catch {
    return null
  }
}

export function writeBriefCache<T extends CacheableBrief>(
  who: BriefCacheWho,
  kind: string,
  brief: T | null | undefined,
  today: string,
  now: number,
  store = safeStorage(),
) {
  const key = store && briefCacheKey(who, kind)
  // Leave a good earlier copy alone rather than replacing it with a worse one.
  if (!store || !key || !shouldCacheBrief(brief)) return
  try {
    store.setItem(key, packBrief(brief, kind, today, now))
  } catch {
    try {
      store.removeItem(key)
    } catch {
      /* nothing left to try */
    }
  }
}

export type { StorageLike }
