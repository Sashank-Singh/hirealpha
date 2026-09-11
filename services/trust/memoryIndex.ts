/**
 * The retrieval index for conversational memory.
 *
 * This is a DERIVED projection, never a system of record. `memory_records` is
 * authoritative: encrypted per user, consent-gated, retention-capped and
 * crypto-shredded. Everything here can be rebuilt from it by
 * `scripts/backfill-memory.ts`, and every deletion path drops the matching
 * rows. If this index disappears entirely the product degrades to recency
 * ordering, not to amnesia.
 *
 * Deliberate consequences:
 *  - The index stores memory text in plaintext. It has to: an embedding needs
 *    the text. That is why it is retention-bound (`expirationDate`) and
 *    deletion-propagated rather than trusted to hold anything durable.
 *  - Every method fails open. A lookup timeout must never blank the memory
 *    block or fail a turn; callers fall back to the authoritative store.
 *
 * Three behaviours were established by running the stack, not by reading docs:
 *  1. mem0's telemetry must be off. It defaults to on, the `init` event is
 *     always sent, it is AWAITED during initialisation, and it posts to
 *     PostHog. On a slow or egress-restricted host it hangs every memory
 *     operation, and it is a third-party data flow this product does not want.
 *  2. `add(..., { infer: false })` skips mem0's LLM extraction, so no LLM is
 *     needed anywhere in this layer. Fact extraction stays in
 *     `spectrum/shared/memoryMaintain.ts`, which knows the persona's durable-key
 *     vocabulary.
 *  3. Custom `metadata` is NOT round-tripped: rows persist only `data`, `hash`,
 *     `user_id`, `agent_id`. So identity is matched on the memory TEXT (which
 *     this layer formats as `key: value`), never on metadata. With
 *     `infer: false` there is also no dedup, so indexing is made idempotent by
 *     deleting a key's existing rows before inserting the new one.
 */

export type MemoryIndexRecord = {
  /** `memory_records.id`, for tracing. Not used as a lookup key — mem0 assigns
   * its own ids and does not persist ours. */
  id: string
  userId: string
  persona: string
  /** Stable fact key. Makes indexing idempotent and deletion exact. */
  key?: string | null
  /** The text to embed, conventionally `key: value`. */
  text: string
  /** Mirrors `memory_records.expires_at` so the index cannot outlive retention. */
  expiresAt?: Date | null
}

export type MemoryIndexHit = {
  /** mem0's row id, needed to delete it. */
  indexId: string
  /** Fact key parsed back out of the stored text, when it has the `k: v` shape. */
  key: string | null
  text: string
  score: number
}

export interface MemoryIndex {
  /** Idempotent per (userId, persona, key): replaces any existing row. Returns
   * false when the index is unavailable — never throws. */
  index(record: MemoryIndexRecord): Promise<boolean>
  search(input: { userId: string; persona: string; query: string; k: number }): Promise<MemoryIndexHit[]>
  /** Drop rows for these fact keys. Returns how many were removed. */
  removeKeys(input: { userId: string; persona: string; keys: string[] }): Promise<number>
  /** Drop everything for a user (account deletion, consent revocation). */
  dropByUser(userId: string): Promise<number>
}

export const MEMORY_INDEX_DEFAULT_K = 20
export const MEMORY_INDEX_DEFAULT_TIMEOUT_MS = 1500
/** mem0 pages `getAll`; this is the page size used when matching by text. */
const SCAN_LIMIT = 1000

/** The key prefix this layer writes, and the anchor for matching rows back. */
export function keyPrefix(key: string): string {
  return `${key}: `
}

/** Parse `key: value` back into its key. Null when the text is free-form. */
export function keyOf(text: string): string | null {
  const index = text.indexOf(': ')
  if (index <= 0) return null
  const key = text.slice(0, index).trim()
  if (!key || /\s/.test(key)) return null
  return key
}

/** Used when the index is disabled or unconfigured: a no-op that never throws. */
export class NullMemoryIndex implements MemoryIndex {
  async index(): Promise<boolean> {
    return false
  }
  async search(): Promise<MemoryIndexHit[]> {
    return []
  }
  async removeKeys(): Promise<number> {
    return 0
  }
  async dropByUser(): Promise<number> {
    return 0
  }
}

type Mem0Item = {
  id?: string
  memory?: string
  score?: number
}

type Mem0Like = {
  add(messages: Array<{ role: string; content: string }>, config: Record<string, unknown>): Promise<unknown>
  search(query: string, config: Record<string, unknown>): Promise<{ results?: Mem0Item[] }>
  getAll(config: Record<string, unknown>): Promise<{ results?: Mem0Item[] }>
  delete(memoryId: string): Promise<unknown>
  deleteAll(config: Record<string, unknown>): Promise<Record<string, unknown>>
}

export type MemoryIndexOptions = {
  /** Postgres connection string (the same database as memory_records). */
  connectionString: string
  /** Ollama base URL serving the embedding model. */
  ollamaUrl: string
  model: string
  dimensions: number
  collection?: string
  timeoutMs?: number
  /** Injectable for tests; defaults to loading mem0ai/oss on first use. */
  createBackend?: (config: unknown) => Promise<Mem0Like>
}

/** `YYYY-MM-DD`, the only format mem0's expirationDate accepts. */
function toExpirationDate(date: Date | null | undefined): string | null {
  if (!date || Number.isNaN(date.getTime())) return null
  return date.toISOString().slice(0, 10)
}

async function withTimeout<T>(work: Promise<T>, ms: number): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      work,
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), ms)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

async function loadDefaultMemory(config: unknown): Promise<Mem0Like> {
  // Must be set before the module is evaluated: mem0 reads it at import time
  // and defaults to ON. Left on, every init awaits a PostHog POST.
  process.env.MEM0_TELEMETRY = 'false'
  const mod = (await import('mem0ai/oss')) as unknown as { Memory: new (config: unknown) => Mem0Like }
  return new mod.Memory(config)
}

export function createMemoryIndex(options: MemoryIndexOptions): MemoryIndex {
  const timeoutMs = options.timeoutMs ?? MEMORY_INDEX_DEFAULT_TIMEOUT_MS
  const collection = options.collection || 'hirealpha_memories'
  const createBackend = options.createBackend ?? loadDefaultMemory
  let backendPromise: Promise<Mem0Like> | null = null

  const getBackend = async (): Promise<Mem0Like> => {
    if (!backendPromise) {
      backendPromise = createBackend({
        embedder: {
          provider: 'ollama',
          config: {
            model: options.model,
            baseURL: options.ollamaUrl,
            url: options.ollamaUrl,
            embeddingDims: options.dimensions,
          },
        },
        vectorStore: {
          provider: 'pgvector',
          config: {
            connectionString: options.connectionString,
            collectionName: collection,
            embeddingModelDims: options.dimensions,
            hnsw: true,
          },
        },
        disableHistory: true,
      }).catch((err) => {
        // Don't cache a broken constructor forever: let the next caller retry.
        backendPromise = null
        throw err
      })
    }
    return backendPromise
  }

  const filtersFor = (userId: string, persona: string) => ({ user_id: userId, agent_id: persona })

  /** Every stored row for this user+persona, or null when the scan fails. */
  const scan = async (userId: string, persona: string): Promise<Mem0Item[] | null> => {
    const backend = await getBackend()
    const all = await withTimeout(
      backend.getAll({ topK: SCAN_LIMIT, filters: filtersFor(userId, persona) }),
      timeoutMs,
    )
    if (!all) return null
    return all.results || []
  }

  const deleteIds = async (ids: string[]): Promise<number> => {
    if (!ids.length) return 0
    const backend = await getBackend()
    let removed = 0
    for (const id of ids) {
      const result = await withTimeout(backend.delete(id), timeoutMs)
      if (result !== null) removed += 1
    }
    return removed
  }

  return {
    async index(record: MemoryIndexRecord): Promise<boolean> {
      try {
        const backend = await getBackend()
        const prefix = record.key ? keyPrefix(record.key) : null
        if (prefix) {
          // infer:false disables mem0's own upsert, so replace explicitly.
          // Without this, every re-mention appends a duplicate row.
          const rows = await scan(record.userId, record.persona)
          if (rows) {
            const stale = rows
              .filter((item) => typeof item.memory === 'string' && item.memory.startsWith(prefix))
              .flatMap((item) => (item.id ? [item.id] : []))
            await deleteIds(stale)
          }
        }
        await withTimeout(
          backend.add([{ role: 'user', content: record.text }], {
            userId: record.userId,
            agentId: record.persona,
            infer: false,
            expirationDate: toExpirationDate(record.expiresAt),
          }),
          timeoutMs,
        )
        return true
      } catch (err) {
        console.warn('[memoryIndex] index failed', err)
        return false
      }
    },

    async search(input): Promise<MemoryIndexHit[]> {
      try {
        const backend = await getBackend()
        const result = await withTimeout(
          backend.search(input.query, {
            topK: input.k,
            filters: filtersFor(input.userId, input.persona),
          }),
          timeoutMs,
        )
        if (!result) {
          console.warn('[memoryIndex] search timed out; falling back to the memory store')
          return []
        }
        const seen = new Set<string>()
        return (result.results || []).flatMap((item) => {
          if (!item.id || !item.memory) return []
          // Duplicate rows (pre-dedup history, or a failed replace) would
          // otherwise repeat the same fact in the prompt.
          if (seen.has(item.memory)) return []
          seen.add(item.memory)
          return [
            {
              indexId: item.id,
              key: keyOf(item.memory),
              text: item.memory,
              score: typeof item.score === 'number' ? item.score : 0,
            },
          ]
        })
      } catch (err) {
        console.warn('[memoryIndex] search failed', err)
        return []
      }
    },

    async removeKeys(input): Promise<number> {
      const wanted = new Set(input.keys.filter(Boolean))
      if (!wanted.size) return 0
      try {
        const rows = await scan(input.userId, input.persona)
        if (!rows) return 0
        const ids = rows
          .filter((item) => {
            if (typeof item.memory !== 'string' || !item.id) return false
            const key = keyOf(item.memory)
            return key !== null && wanted.has(key)
          })
          .flatMap((item) => (item.id ? [item.id] : []))
        return await deleteIds(ids)
      } catch (err) {
        console.warn('[memoryIndex] removeKeys failed', err)
        return 0
      }
    },

    async dropByUser(userId: string): Promise<number> {
      let removed = 0
      try {
        const backend = await getBackend()
        for (const persona of ['friend', 'coworker', 'cofounder']) {
          const result = await withTimeout(
            backend.deleteAll({ userId, agentId: persona }),
            timeoutMs,
          )
          if (!result) continue
          const deleted = Number((result as { deleted?: number }).deleted ?? 0)
          removed += Number.isFinite(deleted) ? deleted : 0
        }
        return removed
      } catch (err) {
        console.warn('[memoryIndex] dropByUser failed', err)
        return removed
      }
    },
  }
}

/**
 * Build the index from the environment, or a no-op when it is not configured.
 *
 * Disabled by default is deliberate: recall degrades to the authoritative
 * store, so an unconfigured deployment behaves exactly as it did before this
 * layer existed rather than failing turns.
 */
export function memoryIndexFromEnv(env: NodeJS.ProcessEnv = process.env): MemoryIndex {
  if (env.MEM0_ENABLED !== 'true') return new NullMemoryIndex()
  const connectionString = env.DATABASE_URL?.trim()
  const ollamaUrl = env.OLLAMA_BASE_URL?.trim()
  const model = env.MEM0_EMBED_MODEL?.trim()
  const dimensions = Number(env.MEM0_EMBED_DIMS)
  if (!connectionString || !ollamaUrl || !model || !Number.isFinite(dimensions) || dimensions <= 0) {
    console.warn(
      '[memoryIndex] MEM0_ENABLED=true but DATABASE_URL, OLLAMA_BASE_URL, MEM0_EMBED_MODEL and MEM0_EMBED_DIMS are required; memory recall is disabled',
    )
    return new NullMemoryIndex()
  }
  return createMemoryIndex({
    connectionString,
    ollamaUrl,
    model,
    dimensions,
    collection: env.MEM0_COLLECTION?.trim() || undefined,
    timeoutMs: Number(env.MEM0_RECALL_TIMEOUT_MS) || undefined,
  })
}
