import type { SQL } from 'bun'
import { userKeyBrokerFromEnv } from '../../services/trust/userKeyBroker'
import {
  CONSENT_PURPOSE,
  categoryForKey,
  ensureMemoryConsent,
  listConsentedMemories,
  maxRetentionDays,
  storeConsentedMemory,
} from '../../services/trust/memoryLifecycle'
import {
  memoryIndexFromEnv,
  type MemoryIndexHit,
} from '../../services/trust/memoryIndex'
import type { Persona } from '../personas'

export type MemoryRow = { key: string; value: string; durable: boolean; updatedAt?: string }

/**
 * One retrieval index for the process. `memoryIndexFromEnv()` reads config and
 * constructs, and the mem0 backend caches its own connection lazily — calling
 * it per write would open a new pool and re-initialise the embedder each time.
 */
let memoryIndexSingleton: ReturnType<typeof memoryIndexFromEnv> | null = null
export function getMemoryIndex(): ReturnType<typeof memoryIndexFromEnv> {
  if (!memoryIndexSingleton) memoryIndexSingleton = memoryIndexFromEnv()
  return memoryIndexSingleton
}

export const DURABLE_KEYS = new Set([
  'preferred_name',
  'people',
  'timezone',
  'check_ins',
  'company',
  'role_title',
  'projects',
  'standup_time',
  'company_name',
  'stage',
  'weekly_focus',
  'hard_nos',
  'name',
  'sister',
  'sister_flight',
  'partner',
  'city',
  'this_weeks_decision',
  /* The bot's own isDurableFactKey treats these as durable preferences, so the
   * server was storing them as loose notes: unpinned, ranked last, and able to
   * fall out of a 40-fact payload once enough newer facts existed. Measured
   * with 60 newer facts, `seat_preference` was gone from recall. */
  'seat_preference',
  'flight_preference',
  'diet',
  'tone_playfulness',
])

export function isDurableKey(key: string) {
  const k = key.trim().toLowerCase()
  return DURABLE_KEYS.has(k)
}

export async function loadMemories(sql: SQL, userId: string, persona: Persona, limit: number | null = 12): Promise<MemoryRow[]> {
  // The encrypted, consent-gated memory_records table is authoritative. The
  // plaintext hire_memories store is read only as a fallback for accounts the
  // backfill has not reached yet, so deploying this cannot make a user's
  // existing memory disappear.
  const broker = userKeyBrokerFromEnv()
  if (broker) {
    try {
      const stored = await listConsentedMemories(sql, broker, { userId, persona })
      const rows = stored
        .filter((memory) => memory.key)
        .map((memory) => ({
          key: memory.key as string,
          value: memory.value,
          durable: memory.durable,
          updatedAt: memory.updatedAt.toISOString(),
        }))
      if (rows.length) return limit === null ? rankMemories(rows, rows.length) : rankMemories(rows, limit)
    } catch (err) {
      console.warn('[memory] authoritative read failed; falling back to the legacy store', err)
    }
  }
  const legacy = limit === null
    ? await sql`
        SELECT key, value, durable, updated_at AS "updatedAt"
        FROM hire_memories
        WHERE user_id = ${userId} AND persona = ${persona}
        ORDER BY durable DESC, updated_at DESC
      `
    : await sql`
        SELECT key, value, durable, updated_at AS "updatedAt"
        FROM hire_memories
        WHERE user_id = ${userId} AND persona = ${persona}
        ORDER BY durable DESC, updated_at DESC
        LIMIT ${limit}
      `
  return (legacy as { key: string; value: string; durable: boolean; updatedAt: Date }[]).map((r) => ({
    key: r.key,
    value: r.value,
    durable: !!r.durable,
    updatedAt: r.updatedAt ? new Date(r.updatedAt).toISOString() : undefined,
  }))
}

/**
 * The candidate set of facts for one turn.
 *
 * Three sources, unioned and capped:
 *  - every identity/durable fact, because a turn is broken without them and
 *    they must never lose a ranking contest to a recent triviality;
 *  - the semantically nearest facts to what the user just said, which is the
 *    whole point of the index — "what do I drink" has to reach a fact stored
 *    as "drink_order" even though no word overlaps;
 *  - the most recent facts, so a fresh fact is never invisible just because
 *    the embedder has not been asked about it yet.
 *
 * Callers may treat failures as "no recall": a missing index degrades this to
 * recency, which is exactly the previous behaviour.
 */
export async function recallMemories(
  sql: SQL,
  userId: string,
  persona: Persona,
  query: string | undefined,
  limit: number,
): Promise<MemoryRow[]> {
  // Semantic hits may point at facts older than the recency window. Load the
  // complete authoritative set so every hit can be resolved to trusted text;
  // the final prompt remains capped by `limit` below.
  const all = await loadMemories(sql, userId, persona, null)
  if (!all.length) return []

  let hits: MemoryIndexHit[] = []
  if (query && query.trim()) {
    try {
      hits = await getMemoryIndex().search({
        userId, persona, query: query.slice(0, 500), k: 20,
      })
    } catch (err) {
      console.warn('[memory] recall failed; serving recency instead', err)
    }
  }

  return selectMemoriesForRecall(all, hits, limit)
}

/** Merge trusted source rows in identity, semantic-relevance, then recency order. */
export function selectMemoriesForRecall(
  all: MemoryRow[],
  hits: Array<Pick<MemoryIndexHit, 'key'>>,
  limit: number,
): MemoryRow[] {
  const pinned = all.filter((row) => isDurableKey(row.key))
  const rest = all.filter((row) => !isDurableKey(row.key))
  const byKey = new Map(all.map((row) => [row.key, row]))
  const seenRecalled = new Set<string>()
  const recalled = hits.flatMap((hit) => {
    const row = hit.key ? byKey.get(hit.key) : undefined
    if (!row || seenRecalled.has(row.key)) return []
    seenRecalled.add(row.key)
    return [row]
  })

  const merged: MemoryRow[] = []
  const taken = new Set<string>()
  for (const row of [...pinned, ...recalled, ...rest]) {
    if (taken.has(row.key)) continue
    taken.add(row.key)
    merged.push(row)
    if (merged.length >= limit) break
  }
  return merged
}

/**
 * Order facts for the prompt: durable and identity first, then newest.
 *
 * This replaces `ORDER BY durable DESC, updated_at DESC` because the
 * authoritative store returns facts by insertion, and identity facts must not
 * be pushed out of a `LIMIT` by a recent trivial one.
 */
export function rankMemories(rows: MemoryRow[], limit: number): MemoryRow[] {
  return [...rows]
    .sort((a, b) => {
      const rank = (row: MemoryRow) => (isDurableKey(row.key) ? 0 : 1)
      if (rank(a) !== rank(b)) return rank(a) - rank(b)
      const left = a.updatedAt ? Date.parse(a.updatedAt) : 0
      const right = b.updatedAt ? Date.parse(b.updatedAt) : 0
      if (left !== right) return right - left
      return a.key.localeCompare(b.key)
    })
    .slice(0, limit)
}

/**
 * Write facts to the authoritative store and project them into the retrieval
 * index. Consent is granted on demand here as well as at hire activation, so
 * an account that predates that flow still starts remembering rather than
 * silently failing every write.
 */
export async function upsertMemories(
  sql: SQL,
  userId: string,
  persona: Persona,
  facts: Array<{ key: string; value: string; durable?: boolean }>,
) {
  const broker = userKeyBrokerFromEnv()
  const index = getMemoryIndex()
  const cleaned = facts.flatMap((fact) => {
    let key = String(fact.key || '').trim().toLowerCase().replaceAll(' ', '_')
    while (key.includes('__')) key = key.replaceAll('__', '_')
    key = key.slice(0, 80)
    const value = String(fact.value || '').trim().slice(0, 500)
    if (!key || !value) return []
    return [{ key, value, durable: fact.durable ?? isDurableKey(key) }]
  })
  if (!cleaned.length) return

  if (!broker) {
    // No key broker configured: fall back to the legacy plaintext store rather
    // than dropping the fact. This is the un-migrated deployment path.
    for (const fact of cleaned) {
      await sql`
        INSERT INTO hire_memories (user_id, persona, key, value, durable, updated_at)
        VALUES (${userId}, ${persona}, ${fact.key}, ${fact.value}, ${fact.durable}, now())
        ON CONFLICT (user_id, persona, key)
        DO UPDATE SET value = excluded.value, durable = hire_memories.durable OR excluded.durable, updated_at = now()
      `
    }
    return
  }

  try {
    await ensureMemoryConsent(sql, { userId, persona, source: 'memory_write' })
  } catch (err) {
    console.warn('[memory] could not ensure consent; memory write skipped', err)
    return
  }

  for (const fact of cleaned) {
    const category = categoryForKey(fact.key)
    try {
      await storeConsentedMemory(sql, broker, {
        userId,
        persona,
        key: fact.key,
        durable: fact.durable,
        category,
        purpose: CONSENT_PURPOSE,
        // Stored as `key: value` so the index can match a row back to its fact
        // key without a metadata round-trip, which mem0 does not provide.
        content: `${fact.key}: ${fact.value}`,
        retentionDays: maxRetentionDays(category),
        source: 'chat',
        index,
      })
    } catch (err) {
      console.warn(`[memory] store failed for key ${fact.key}`, err)
    }
  }
}

export async function syncContextMemories(sql: SQL, userId: string, persona: Persona, fields: Record<string, string>) {
  const facts = Object.entries(fields)
    .filter(([k, v]) => k !== 'setup' && typeof v === 'string' && v.trim())
    .map(([key, value]) => ({ key, value: value.trim(), durable: true }))
  if (facts.length) await upsertMemories(sql, userId, persona, facts)
}
