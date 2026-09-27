import { createBoundedMap } from './boundedMap'

export interface IdempotencyRecord<T = unknown> {
  status: 'in_progress' | 'completed' | 'failed'
  result?: T
  error?: string
  at: number
}

// 5,000 entries bounded, 15 minute TTL
const idempotencyStore = createBoundedMap<string, IdempotencyRecord>({
  maxEntries: 5000,
  ttlMs: 15 * 60_000,
})

const inFlightPromises = new Map<string, Promise<unknown>>()

/**
 * Deterministically compute an idempotency key from a scope and arbitrary parameters.
 */
export function computeIdempotencyKey(scope: string, params: unknown): string {
  const normalized = normalizeParams(params)
  const hasher = new Bun.CryptoHasher('sha256')
  hasher.update(`${scope}:${normalized}`)
  return `${scope}_${hasher.digest('hex').slice(0, 32)}`
}

function normalizeParams(value: unknown): string {
  return JSON.stringify(canonicalize(value))
}

function canonicalize(value: unknown): unknown {
  if (value === null) return ['null']
  if (value === undefined) return ['undefined']
  if (typeof value === 'string') return ['string', value]
  if (typeof value === 'boolean') return ['boolean', value]
  if (typeof value === 'number') {
    const encoded = Number.isNaN(value) ? 'NaN'
      : value === Infinity ? 'Infinity'
        : value === -Infinity ? '-Infinity'
          : Object.is(value, -0) ? '-0' : value
    return ['number', encoded]
  }
  if (typeof value === 'bigint') return ['bigint', value.toString()]
  if (Array.isArray(value)) return ['array', value.map(canonicalize)]
  if (value instanceof Date) return ['date', value.toISOString()]
  if (typeof value === 'object') {
    return ['object', Object.keys(value as Record<string, unknown>).sort()
      .map((key) => [key, canonicalize((value as Record<string, unknown>)[key])])]
  }
  return [typeof value, String(value)]
}

/**
 * Run an action with idempotency protection.
 * If key was already successfully completed, immediately returns the cached result.
 * If in-flight, waits on the current execution rather than duplicating the side-effect.
 */
export async function withIdempotency<T>(
  key: string,
  execute: () => Promise<T>,
): Promise<{ result: T; cached: boolean }> {
  const existing = idempotencyStore.get(key)
  if (existing?.status === 'completed') {
    return { result: existing.result as T, cached: true }
  }

  const running = inFlightPromises.get(key)
  if (running) {
    const res = await running
    return { result: res as T, cached: true }
  }

  idempotencyStore.set(key, { status: 'in_progress', at: Date.now() })

  const promise = (async () => {
    try {
      const res = await execute()
      idempotencyStore.set(key, { status: 'completed', result: res, at: Date.now() })
      return res
    } catch (err: any) {
      idempotencyStore.set(key, { status: 'failed', error: err?.message, at: Date.now() })
      throw err
    } finally {
      inFlightPromises.delete(key)
    }
  })()

  inFlightPromises.set(key, promise)
  const result = await promise
  return { result, cached: false }
}

export function getIdempotencyStore() {
  return idempotencyStore
}
