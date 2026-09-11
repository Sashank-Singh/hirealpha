/**
 * Exercises the retrieval index against a real pgvector database and a real
 * embedding server. Skips (never fakes a pass) when neither is reachable.
 *
 *   MEM0_TEST_DATABASE_URL=postgres:///mem0_test \
 *   MEM0_TEST_OLLAMA_URL=http://127.0.0.1:11434 \
 *   bun test services/trust/memoryIndex.live.test.ts
 *
 * These assertions encode behaviour that was established by running the stack,
 * because the documentation is wrong or silent about all three:
 *  - `infer: false` must not require an LLM anywhere, or a turn would need a
 *    second model call we do not pay for today.
 *  - Re-indexing the same fact must not append a duplicate row. mem0's own
 *    dedup is part of the extraction pipeline, which `infer: false` disables.
 *  - Custom `metadata` is not persisted, so deletion must match on the memory
 *    text. A test that trusted metadata would pass here and lose data in prod.
 */
import { describe, expect, it } from 'bun:test'
import { SQL } from 'bun'
import { createMemoryIndex, keyOf, type MemoryIndex } from './memoryIndex'

const databaseUrl = process.env.MEM0_TEST_DATABASE_URL?.trim() || ''
const ollamaUrl = process.env.MEM0_TEST_OLLAMA_URL?.trim() || ''
const model = process.env.MEM0_TEST_EMBED_MODEL?.trim() || 'qwen3-embedding:0.6b'
const dims = Number(process.env.MEM0_TEST_EMBED_DIMS || 1024)
const live = Boolean(databaseUrl && ollamaUrl)

const COLLECTION = 'hh_memory_index_test'
const USER = 'live-test-user'
const PERSONA = 'friend'

async function resetCollection(sql: SQL) {
  await sql.unsafe(`DROP TABLE IF EXISTS ${COLLECTION} CASCADE`)
  await sql.unsafe(`DROP TABLE IF EXISTS ${COLLECTION}_entities CASCADE`)
}

function newIndex(): MemoryIndex {
  return createMemoryIndex({
    connectionString: databaseUrl,
    ollamaUrl,
    model,
    dimensions: dims,
    collection: COLLECTION,
    timeoutMs: 30_000,
  })
}

describe.skipIf(!live)('memory index against pgvector and a live embedder', () => {
  it('indexes, recalls semantically, replaces on re-index and deletes by key', async () => {
    const sql = new SQL(databaseUrl, { max: 1 })
    try {
      await resetCollection(sql)
      const index = newIndex()

      expect(
        await index.index({
          id: 'rec-1',
          userId: USER,
          persona: PERSONA,
          key: 'drink_order',
          text: 'drink_order: oat milk flat white, no sugar',
        }),
      ).toBe(true)
      await index.index({
        id: 'rec-2',
        userId: USER,
        persona: PERSONA,
        key: 'seat_pref',
        text: 'seat_pref: aisle seat, always',
      })

      const rows = (await sql.unsafe(`SELECT count(*)::int AS n FROM ${COLLECTION}`)) as Array<{ n: number }>
      expect(rows[0]!.n).toBe(2)

      // Semantic, not lexical: the query shares no content words with the fact.
      const hits = await index.search({ userId: USER, persona: PERSONA, query: 'what do I drink in the morning?', k: 5 })
      expect(hits.length).toBeGreaterThan(0)
      expect(hits.some((hit) => /oat milk flat white/i.test(hit.text))).toBe(true)
      expect(hits.find((hit) => /oat milk/i.test(hit.text))!.key).toBe('drink_order')

      // Re-indexing must replace, not append: mem0's dedup is part of the
      // extraction pipeline that `infer: false` skips.
      await index.index({
        id: 'rec-1',
        userId: USER,
        persona: PERSONA,
        key: 'drink_order',
        text: 'drink_order: oat milk flat white, extra shot',
      })
      const after = (await sql.unsafe(`SELECT count(*)::int AS n FROM ${COLLECTION}`)) as Array<{ n: number }>
      expect(after[0]!.n).toBe(2)

      const updated = await index.search({ userId: USER, persona: PERSONA, query: 'coffee order', k: 5 })
      expect(updated.filter((hit) => hit.key === 'drink_order')).toHaveLength(1)
      expect(updated.find((hit) => hit.key === 'drink_order')!.text).toContain('extra shot')

      // Deletion is by fact key, because metadata is not persisted.
      const removed = await index.removeKeys({ userId: USER, persona: PERSONA, keys: ['drink_order'] })
      expect(removed).toBeGreaterThan(0)
      const left = await index.search({ userId: USER, persona: PERSONA, query: 'what do I drink in the morning?', k: 5 })
      expect(left.some((hit) => hit.key === 'drink_order')).toBe(false)
      expect(left.some((hit) => hit.key === 'seat_pref')).toBe(true)
    } finally {
      await resetCollection(sql).catch(() => {})
      await sql.close()
    }
  }, 120_000)

  it('scopes recall to one persona and drops an entire user', async () => {
    const sql = new SQL(databaseUrl, { max: 1 })
    try {
      await resetCollection(sql)
      const index = newIndex()
      await index.index({
        id: 'a', userId: USER, persona: 'friend', key: 'pipeline', text: 'pipeline: enterprise deal, 40k',
      })
      await index.index({
        id: 'b', userId: USER, persona: 'cofounder', key: 'pipeline', text: 'pipeline: seed round, 2M',
      })

      const asFriend = await index.search({ userId: USER, persona: 'friend', query: 'pipeline', k: 5 })
      expect(asFriend.map((hit) => hit.text)).toEqual(['pipeline: enterprise deal, 40k'])

      const asCofounder = await index.search({ userId: USER, persona: 'cofounder', query: 'pipeline', k: 5 })
      expect(asCofounder.map((hit) => hit.text)).toEqual(['pipeline: seed round, 2M'])

      await index.dropByUser(USER)
      const rows = (await sql.unsafe(`SELECT count(*)::int AS n FROM ${COLLECTION}`)) as Array<{ n: number }>
      expect(rows[0]!.n).toBe(0)
    } finally {
      await resetCollection(sql).catch(() => {})
      await sql.close()
    }
  }, 120_000)
})

/**
 * The fail-open contract, which needs no database: an unreachable index must
 * return empty results rather than throw, because a memory lookup failure must
 * never fail a user's turn.
 */
describe('memory index fails open', () => {
  const broken = () =>
    createMemoryIndex({
      connectionString: 'postgresql://127.0.0.1:1/nope',
      ollamaUrl: 'http://127.0.0.1:1',
      model: 'missing',
      dimensions: 8,
      collection: 'nope',
      timeoutMs: 300,
    })

  it('returns empty results instead of throwing when the backend is broken', async () => {
    const index = broken()
    expect(await index.search({ userId: 'u', persona: 'friend', query: 'q', k: 5 })).toEqual([])
    expect(await index.index({ id: 'r', userId: 'u', persona: 'friend', key: 'k', text: 'k: v' })).toBe(false)
    expect(await index.removeKeys({ userId: 'u', persona: 'friend', keys: ['k'] })).toBe(0)
    expect(await index.dropByUser('u')).toBe(0)
  }, 60_000)
})

describe('key parsing', () => {
  it('reads the fact key back out of indexed text', () => {
    expect(keyOf('drink_order: oat milk')).toBe('drink_order')
    expect(keyOf('seat_pref: aisle')).toBe('seat_pref')
    expect(keyOf('no separator here')).toBeNull()
    expect(keyOf(': leading colon')).toBeNull()
    expect(keyOf('multi word key: value')).toBeNull()
  })
})
