import { localYmd } from './home'
import {
  HOME_CACHE_MAX_AGE_MS,
  homeCacheKey,
  readHomeCache,
  safeStorage,
  type HomeCacheWho,
} from './homeCache'
import type { HomeSnapshot, SpendLog } from './api'

export const SPEND_CACHE_VERSION = 1

export type SpendCachePayload = {
  logs: SpendLog[]
  byCategory: Array<{ category: string; total: number }>
  weekTotal: number
  weeklyBudget: number
  weekStart: string
}

type SpendCacheEnvelope = {
  v: number
  day: string
  at: number
  data: SpendCachePayload
}

export function spendCacheKey(who: HomeCacheWho): string | null {
  const base = homeCacheKey(who)
  return base ? base.replace(/^home:/, 'spend:') : null
}

export function readSpendCache(
  who: HomeCacheWho,
  today = localYmd(),
  now = Date.now(),
  store = safeStorage(),
): SpendCachePayload | null {
  const key = store && spendCacheKey(who)
  if (!store || !key) return null
  try {
    const raw = store.getItem(key)
    if (!raw) return null
    const env = JSON.parse(raw) as SpendCacheEnvelope
    if (!env || typeof env !== 'object') return null
    if (env.v !== SPEND_CACHE_VERSION) return null
    if (env.day !== today) return null
    if (!Number.isFinite(env.at) || now - env.at > HOME_CACHE_MAX_AGE_MS) return null
    return env.data || null
  } catch {
    return null
  }
}

/**
 * Instant seed: read directly from spend cache, or fallback to the already-cached
 * Home snapshot so the very first click on "Spend" renders with zero network wait.
 */
export function readSpendSeed(
  who: HomeCacheWho,
  today = localYmd(),
  now = Date.now(),
  store = safeStorage(),
): SpendCachePayload {
  const cached = readSpendCache(who, today, now, store)
  if (cached) return cached

  // Fall back to homeCache which already holds this week's spend & budget
  const homeSnap = readHomeCache<HomeSnapshot>(who, today, now, store)
  if (homeSnap?.window) {
    const weekTotal = Number(homeSnap.window.spend || 0)
    const weeklyBudget = Number(homeSnap.window.weeklyBudget || 400)
    const byCategory = (homeSnap.spendByCategory || []).map((c) => ({
      category: c.category,
      total: Number(c.amount || 0),
    }))
    return {
      logs: [],
      byCategory,
      weekTotal,
      weeklyBudget,
      weekStart: today,
    }
  }

  return {
    logs: [],
    byCategory: [],
    weekTotal: 0,
    weeklyBudget: 400,
    weekStart: today,
  }
}

export function writeSpendCache(
  who: HomeCacheWho,
  data: SpendCachePayload,
  today = localYmd(),
  now = Date.now(),
  store = safeStorage(),
) {
  const key = store && spendCacheKey(who)
  if (!store || !key) return
  try {
    const env: SpendCacheEnvelope = {
      v: SPEND_CACHE_VERSION,
      day: today,
      at: now,
      data,
    }
    store.setItem(key, JSON.stringify(env))
  } catch {
    // quota exceeded or private mode
  }

  // Two-way sync: update homeCache if it exists so Home immediately reflects new totals
  try {
    const homeKey = store && homeCacheKey(who)
    if (store && homeKey) {
      const homeRaw = store.getItem(homeKey)
      if (homeRaw) {
        const homeEnv = JSON.parse(homeRaw)
        if (homeEnv?.snap?.window) {
          homeEnv.snap.window.spend = data.weekTotal
          homeEnv.snap.window.weeklyBudget = data.weeklyBudget
          homeEnv.snap.spendByCategory = data.byCategory.map((c) => ({
            category: c.category,
            amount: c.total,
          }))
          store.setItem(homeKey, JSON.stringify(homeEnv))
        }
      }
    }
  } catch {
    // ignore
  }

  // Notify active listeners (e.g. HomeApp) on this window
  if (typeof window !== 'undefined') {
    try {
      window.dispatchEvent(
        new CustomEvent('spend:sync', {
          detail: {
            weekTotal: data.weekTotal,
            weeklyBudget: data.weeklyBudget,
            byCategory: data.byCategory,
          },
        }),
      )
    } catch {
      // ignore
    }
  }
}
