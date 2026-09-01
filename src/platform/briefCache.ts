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

export const BRIEF_CACHE_VERSION = 2

/**
 * Same window as home's snapshot: ninety minutes. A brief is a claim about a
 * slice of the day — mail "since this morning", what is "left this evening" —
 * and it is far better to paint the answer you left instantly and refresh
 * behind it than to stare at "Pulling your day together" for a full rebuild
 * every time the screen reopens. The network fetch still runs on every open, so
 * mail that landed since the last look arrives within a second or two of the
 * paint. Four hours let yesterday's mail stick around past when the user would
 * notice — ninety minutes is long enough to be useful on a second open and
 * short enough to trust again.
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
  /* Free-tier rationing served a stale-but-same-day payload on purpose. Kept
   * through cache so the banner survives a second open until the user
   * upgrades or a fresh build rolls in. */
  limited?: boolean
  used?: number
  limit?: number
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

/**
 * The day the payload actually claims to be about — read from the brief itself,
 * not the client clock. A brief is "today's mail" and "tomorrow's calendar";
 * if the server says it is the Aug 29 brief, no localStorage entry should let
 * the device serve it on Aug 30. Trusting the server's date instead of the
 * client's `localYmd()` is what stops yesterday's brief from showing up as
 * "today, but with two-day-old mail" after the user's clock has crossed midnight.
 *
 * Both briefs carry the date in their payload, but under different keys —
 * morning's is `date` ("Friday, August 29"), evening's is also `date` with the
 * same shape — and an old cached row without either falls back to the envelope
 * `day` so it still expires cross-day.
 */
export function briefDayOf(brief: unknown): string | null {
  if (!brief || typeof brief !== 'object') return null
  const raw = (brief as { date?: unknown }).date
  if (typeof raw !== 'string') return null
  const months = [
    'January',
    'February',
    'March',
    'April',
    'May',
    'June',
    'July',
    'August',
    'September',
    'October',
    'November',
    'December',
  ]
  // ISO first — the cleanest shape the server emits.
  const iso = raw.match(/(\d{4}-\d{2}-\d{2})/)
  if (iso) return iso[1]
  // Then "<Month> <day>, <year>" or "<Month> <day> <year>" — matches "August 29, 2026"
  // and skips weekday prefixes like "Friday, August 29, 2026" by requiring a real month.
  const longForm = raw.match(/\b(January|February|March|April|May|June|July|August|September|October|November|December) (\d{1,2}),? (\d{4})\b/)
  if (longForm) {
    const mi = months.indexOf(longForm[1])
    if (mi >= 0) {
      const dd = String(longForm[2]).padStart(2, '0')
      const mm = String(mi + 1).padStart(2, '0')
      return `${longForm[3]}-${mm}-${dd}`
    }
  }
  // No year at all (e.g. "August 29") — refuse so cross-year bugs surface instead
  // of silently matching by month-and-day only.
  return null
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
  if (parsed.kind !== kind) return null
  /* Day check uses the brief's own claimed date when we can read it. The
   * envelope's `day` was the client clock at write time, which is exactly the
   * one we do NOT want to trust across a midnight boundary — the server's own
   * `date` field carries the truth. Falls back to `parsed.day` so old envelopes
   * without a parseable date still expire properly. */
  const payloadDay = briefDayOf(parsed.brief)
  if (payloadDay) {
    if (payloadDay !== today) return null
  } else if (parsed.day !== today) {
    return null
  }
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
