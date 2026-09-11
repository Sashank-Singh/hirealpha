import { randomUUID } from 'node:crypto'
import type { SQL } from 'bun'
import { decryptUserPayload, encryptUserPayload, loadOrCreateUserKey, type UserKeyBroker } from './userKeyBroker'
import type { MemoryIndex } from './memoryIndex'

export const MEMORY_CATEGORIES = ['identity', 'preference', 'relationship', 'work', 'health', 'financial', 'other'] as const
export type MemoryCategory = (typeof MEMORY_CATEGORIES)[number]

const MAX_RETENTION_DAYS: Record<MemoryCategory, number> = {
  identity: 365, preference: 365, relationship: 365, work: 180,
  health: 30, financial: 30, other: 90,
}

/**
 * Which retention bucket a conversational fact belongs to.
 *
 * Facts are bucketed to PREFERENCE (365 days) by default, not by topic
 * keyword. That is deliberate and load-bearing: `hard_nos` and `diet` are
 * constraints of the friend persona, and filing them under `health` would
 * silently expire them after 30 days — the hire would start offering pork to
 * someone who said they don't eat it. Only keys that are unambiguously
 * health or financial telemetry take those shorter caps, and those are the
 * logs the retention schedule actually intends to bound.
 */
const CATEGORY_FOR_KEY: Array<[RegExp, MemoryCategory]> = [
  [/^(preferred_name|name|timezone|city|locale|language)/i, 'identity'],
  [/^(people|partner|sister|family|relationship|hard_nos|anniversary|birthday)/i, 'relationship'],
  [/^(company|company_name|role_title|projects|standup_time|weekly_focus|stage|this_weeks_decision|pipeline|okr)/i, 'work'],
  [/^(calories|protein|macros|weight|sleep_hours|resting_hr|workout_split)/i, 'health'],
  [/^(runway|burn|spend|budget|salary|revenue|mrr|arr)/i, 'financial'],
]

export function categoryForKey(key: string): MemoryCategory {
  const k = key.trim().toLowerCase()
  if (!k) return 'preference'
  for (const [pattern, category] of CATEGORY_FOR_KEY) {
    if (pattern.test(k)) return category
  }
  return 'preference'
}

/** The longest retention a category permits, i.e. what a freshly written fact
 * gets. Re-confirming a fact extends its window back out to this. */
export function maxRetentionDays(category: MemoryCategory): number {
  return MAX_RETENTION_DAYS[category]
}

/** Categories auto-granted per persona when a hire is activated. Kept narrow so
 * a consent row means something specific rather than "everything". */
const CATEGORIES_FOR_PERSONA: Record<string, MemoryCategory[]> = {
  friend: ['identity', 'preference', 'relationship', 'health'],
  coworker: ['identity', 'preference', 'work'],
  cofounder: ['identity', 'preference', 'work', 'financial'],
}

export const CONSENT_PURPOSE = 'personalize this hire'

/**
 * Grant the consent rows a hire needs to remember anything at all.
 *
 * Without this the consent gate is absolute: `storeConsentedMemory` refuses a
 * category with no active grant, and no UI path ever granted one, so every
 * memory write failed and the bot remembered nothing.
 *
 * Idempotent — an existing active grant for the category and purpose is reused
 * rather than duplicated, so this is safe to call on every activation and from
 * the backfill.
 */
export async function ensureMemoryConsent(
  sql: SQL,
  input: { userId: string; persona: string; source?: string },
): Promise<MemoryCategory[]> {
  const wanted = CATEGORIES_FOR_PERSONA[input.persona] ?? ['identity', 'preference']
  const granted: MemoryCategory[] = []
  const existing = (await sql`
    SELECT category FROM consent_records
    WHERE user_id = ${input.userId} AND resource_type = 'memory'
      AND purpose = ${CONSENT_PURPOSE} AND status = 'granted'
      AND (expires_at IS NULL OR expires_at > now())
  `) as Array<{ category: string | null }>
  const have = new Set(existing.map((row) => row.category).filter(Boolean) as string[])
  for (const category of wanted) {
    if (have.has(category)) {
      granted.push(category)
      continue
    }
    await grantMemoryConsent(sql, {
      userId: input.userId,
      category,
      purpose: CONSENT_PURPOSE,
      source: input.source,
    })
    granted.push(category)
  }
  return granted
}

function categoryOf(value: string): MemoryCategory {
  if (!(MEMORY_CATEGORIES as readonly string[]).includes(value)) throw new Error('Memory category is invalid.')
  return value as MemoryCategory
}

function cleanPurpose(value: string): string {
  const purpose = value.trim()
  if (purpose.length < 3 || purpose.length > 300) throw new Error('Memory purpose is invalid.')
  return purpose
}

export async function grantMemoryConsent(
  sql: SQL,
  input: { userId: string; category: string; purpose: string; expiresAt?: Date | null; consentVersion?: number; source?: string },
): Promise<string> {
  const id = randomUUID()
  const category = categoryOf(input.category)
  const purpose = cleanPurpose(input.purpose)
  const consentVersion = Math.floor(input.consentVersion ?? 1)
  if (consentVersion < 1 || consentVersion > 1_000_000) throw new Error('Consent version is invalid.')
  await sql`
    INSERT INTO consent_records (id, user_id, resource_type, category, purpose, status, expires_at, consent_version, source)
    VALUES (${id}, ${input.userId}, 'memory', ${category}, ${purpose}, 'granted', ${input.expiresAt ?? null},
      ${consentVersion}, ${input.source?.slice(0, 200) ?? null})
  `
  return id
}

export async function revokeMemoryConsent(sql: SQL, input: { userId: string; consentId: string }): Promise<boolean> {
  const rows = (await sql`
    UPDATE consent_records SET status = 'revoked', revoked_at = now()
    WHERE id = ${input.consentId} AND user_id = ${input.userId} AND resource_type = 'memory' AND status = 'granted'
    RETURNING id
  `) as Array<{ id: string }>
  return rows.length === 1
}

export type ConsentedMemoryInput = {
  userId: string
  category: string
  purpose: string
  content: string
  retentionDays: number
  source?: string
  /** Partition. Empty for free-form memories that predate personas. */
  persona?: string
  /** Stable fact key. Present means this is a structured fact and the write
   * upserts on (user, persona, key) rather than appending. */
  key?: string | null
  durable?: boolean
  /** Caller-chosen id, so the backfill can be re-run without duplicating. */
  id?: string
  /** Write-through to the derived retrieval index. Best-effort. */
  index?: MemoryIndex | null
}

/**
 * Store one consented memory, then project it into the retrieval index.
 *
 * The database write is the one that matters: it throws on a missing consent
 * or an over-cap retention. The index write is deliberately after it and
 * deliberately non-fatal — a dead index must not lose the memory itself, and
 * the index is rebuildable from this table at any time.
 */
export async function storeConsentedMemory(
  sql: SQL,
  broker: UserKeyBroker,
  input: ConsentedMemoryInput,
): Promise<string> {
  const category = categoryOf(input.category)
  const purpose = cleanPurpose(input.purpose)
  const content = input.content.trim()
  if (!content || content.length > 20_000) throw new Error('Memory content is invalid.')
  const retentionDays = Math.floor(input.retentionDays)
  if (retentionDays < 1 || retentionDays > MAX_RETENTION_DAYS[category]) throw new Error(`Retention exceeds the ${category} category limit.`)
  const consent = (await sql`
    SELECT id FROM consent_records
    WHERE user_id = ${input.userId} AND resource_type = 'memory' AND category = ${category}
      AND purpose = ${purpose} AND status = 'granted' AND (expires_at IS NULL OR expires_at > now())
    ORDER BY granted_at DESC LIMIT 1
  `) as Array<{ id: string }>
  if (!consent[0]) throw new Error('Active consent is required for this memory category and purpose.')

  const persona = input.persona ?? ''
  const memoryKey = input.key?.trim() ? input.key.trim() : null
  const durable = input.durable ?? false

  // Upsert keyed facts. The record id is reused on update because it is bound
  // into the ciphertext's AAD — re-encrypting under a new id would make the
  // row undecryptable.
  let id = input.id ?? randomUUID()
  if (memoryKey) {
    const existing = (await sql`
      SELECT id FROM memory_records
      WHERE user_id = ${input.userId} AND persona = ${persona} AND memory_key = ${memoryKey} AND deleted_at IS NULL
      LIMIT 1
    `) as Array<{ id: string }>
    if (existing[0]) id = existing[0].id
  }

  const key = await loadOrCreateUserKey(sql, broker, input.userId)
  let expiresAt: Date
  try {
    const ciphertext = encryptUserPayload(content, key, { userId: input.userId, recordId: id, scope: `memory:${category}` })
    const rows = (await sql`
      INSERT INTO memory_records (id, user_id, persona, memory_key, durable, category, purpose, ciphertext, source, consent_id, retention_days, expires_at)
      VALUES (${id}, ${input.userId}, ${persona}, ${memoryKey}, ${durable}, ${category}, ${purpose}, ${ciphertext},
        ${input.source?.slice(0, 200) ?? null}, ${consent[0].id}, ${retentionDays}, now() + (${retentionDays} * interval '1 day'))
      ON CONFLICT (id) DO UPDATE SET
        ciphertext = excluded.ciphertext,
        category = excluded.category,
        purpose = excluded.purpose,
        persona = excluded.persona,
        memory_key = excluded.memory_key,
        durable = excluded.durable,
        retention_days = excluded.retention_days,
        expires_at = excluded.expires_at
      RETURNING expires_at
    `) as Array<{ expires_at: Date }>
    expiresAt = rows[0]?.expires_at ?? new Date(Date.now() + retentionDays * 86_400_000)
  } finally {
    key.fill(0)
  }

  if (input.index) {
    await input.index.index({
      id,
      userId: input.userId,
      persona: persona || 'friend',
      key: memoryKey,
      text: content,
      expiresAt,
    })
  }
  return id
}

export type StoredMemory = {
  id: string
  key: string | null
  value: string
  durable: boolean
  category: string
  persona: string
  updatedAt: Date
}

/**
 * Every live memory for one persona, decrypted.
 *
 * This is the authoritative read. The retrieval index only ranks; the values
 * injected into a prompt always come from here, so a stale or missing index
 * can change the ORDER facts are recalled in but can never change or lose a
 * fact's content.
 */
export async function listConsentedMemories(
  sql: SQL,
  broker: UserKeyBroker,
  input: { userId: string; persona: string },
): Promise<StoredMemory[]> {
  const rows = (await sql`
    SELECT id, category, persona, memory_key, durable, ciphertext, created_at
    FROM memory_records
    WHERE user_id = ${input.userId} AND deleted_at IS NULL AND expires_at > now()
      AND (persona = ${input.persona} OR persona = '')
    ORDER BY durable DESC, created_at DESC
  `) as Array<{ id: string; category: string; persona: string; memory_key: string | null; durable: boolean; ciphertext: string; created_at: Date }>
  if (!rows.length) return []
  const key = await loadOrCreateUserKey(sql, broker, input.userId)
  try {
    return rows.flatMap((row) => {
      const value = decryptUserPayload(row.ciphertext, key, { userId: input.userId, recordId: row.id, scope: `memory:${row.category}` })
      if (value === null) return []
      const stored = value.startsWith(`${row.memory_key}: `) && row.memory_key
        ? value.slice(row.memory_key.length + 2)
        : value
      return [{
        id: row.id,
        key: row.memory_key,
        value: stored,
        durable: !!row.durable,
        category: row.category,
        persona: row.persona,
        updatedAt: row.created_at,
      }]
    })
  } finally {
    key.fill(0)
  }
}

export async function exportUserMemories(sql: SQL, broker: UserKeyBroker, userId: string): Promise<Array<Record<string, unknown>>> {
  const rows = (await sql`
    SELECT id, category, purpose, ciphertext, source, created_at, expires_at
    FROM memory_records WHERE user_id = ${userId} AND deleted_at IS NULL AND expires_at > now()
    ORDER BY created_at ASC
  `) as Array<{ id: string; category: string; purpose: string; ciphertext: string; source: string | null; created_at: Date; expires_at: Date }>
  if (!rows.length) return []
  const key = await loadOrCreateUserKey(sql, broker, userId)
  try {
    return rows.flatMap((row) => {
      const content = decryptUserPayload(row.ciphertext, key, { userId, recordId: row.id, scope: `memory:${row.category}` })
      return content === null ? [] : [{ id: row.id, category: row.category, purpose: row.purpose, content, source: row.source, created_at: row.created_at, expires_at: row.expires_at }]
    })
  } finally {
    key.fill(0)
  }
}

/**
 * Crypto-shred memories, and drop them from the retrieval index.
 *
 * Index rows are collected BEFORE the shred because the plaintext is what the
 * index is matched on. Deleting the ciphertext without dropping the index
 * would leave readable copies of "deleted" memories in the vector table — the
 * failure mode this whole two-layer design exists to prevent.
 */
export async function deleteUserMemories(
  sql: SQL,
  input: { userId: string; category?: string; reason: 'user_request' | 'retention_expired' | 'account_deletion'; index?: MemoryIndex | null },
): Promise<number> {
  const category = input.category ? categoryOf(input.category) : null
  const doomed = (await sql`
    SELECT user_id, persona, memory_key FROM memory_records
    WHERE user_id = ${input.userId} AND deleted_at IS NULL ${category ? sql`AND category = ${category}` : sql``}
  `) as Array<{ user_id: string; persona: string; memory_key: string | null }>
  const rows = (await sql`
    UPDATE memory_records SET ciphertext = NULL, deleted_at = now(), deletion_reason = ${input.reason}
    WHERE user_id = ${input.userId} AND deleted_at IS NULL ${category ? sql`AND category = ${category}` : sql``}
    RETURNING id
  `) as Array<{ id: string }>
  await dropIndexRows(input.index, doomed)
  return rows.length
}

/** Remove these records' projections from the index, grouped by user+persona. */
async function dropIndexRows(
  index: MemoryIndex | null | undefined,
  rows: Array<{ user_id: string; persona: string; memory_key: string | null }>,
): Promise<void> {
  if (!index) return
  const byScope = new Map<string, { userId: string; persona: string; keys: Set<string> }>()
  for (const row of rows) {
    if (!row.memory_key) continue
    const persona = row.persona || 'friend'
    const scope = `${row.user_id}\u0000${persona}`
    if (!byScope.has(scope)) byScope.set(scope, { userId: row.user_id, persona, keys: new Set() })
    byScope.get(scope)!.keys.add(row.memory_key)
  }
  for (const { userId, persona, keys } of byScope.values()) {
    await index.removeKeys({ userId, persona, keys: [...keys] })
  }
}

export async function sweepExpiredMemories(
  sql: SQL,
  limit = 1000,
  index?: MemoryIndex | null,
): Promise<number> {
  const capped = Math.max(1, Math.min(5000, Math.floor(limit)))
  // Read the doomed set first: the sweep is cross-user, and the index is
  // matched on plaintext, which the UPDATE below is about to destroy.
  const doomed = (await sql`
    SELECT user_id, persona, memory_key FROM memory_records
    WHERE deleted_at IS NULL AND expires_at <= now()
    ORDER BY expires_at LIMIT ${capped}
  `) as Array<{ user_id: string; persona: string; memory_key: string | null }>
  const rows = (await sql`
    WITH expired AS (
      SELECT id FROM memory_records WHERE deleted_at IS NULL AND expires_at <= now()
      ORDER BY expires_at LIMIT ${capped} FOR UPDATE SKIP LOCKED
    )
    UPDATE memory_records m SET ciphertext = NULL, deleted_at = now(), deletion_reason = 'retention_expired'
    FROM expired WHERE m.id = expired.id RETURNING m.id
  `) as Array<{ id: string }>
  if (rows.length) await dropIndexRows(index, doomed)
  return rows.length
}

/** Account-deletion propagation inside the trust layer: memory ciphertext and
 * metadata, consent records, the per-user data key, and every outstanding
 * capability are destroyed. The hire_memories bot store and the Link wallet
 * row are included so no personal data survives in any trust-adjacent table.
 * Deletion evidence stays in audit_events, which has no FK on this path.
 *
 * The retrieval index is dropped first and without ceremony: it holds
 * plaintext, so an account deletion that left it behind would be the most
 * visible possible failure of this whole design. */
export async function purgeAccountTrustData(
  sql: SQL,
  userId: string,
  index?: MemoryIndex | null,
): Promise<Record<string, number>> {
  const indexRowsDropped = index ? await index.dropByUser(userId) : 0
  const memories = (await sql`
    DELETE FROM memory_records WHERE user_id = ${userId} RETURNING id
  `) as Array<{ id: string }>
  const botMemories = (await sql`
    DELETE FROM hire_memories WHERE user_id = ${userId} RETURNING persona
  `) as Array<{ persona: string }>
  const consents = (await sql`
    DELETE FROM consent_records WHERE user_id = ${userId} RETURNING id
  `) as Array<{ id: string }>
  const vaultItems = (await sql`
    DELETE FROM vault_items_v2 WHERE user_id = ${userId} RETURNING id
  `) as Array<{ id: string }>
  const grants = (await sql`
    UPDATE capability_grants SET status = 'revoked', revoked_at = now(), finalized_at = now()
    WHERE user_id = ${userId} AND status NOT IN ('revoked', 'expired', 'denied', 'consumed')
    RETURNING id
  `) as Array<{ id: string }>
  const keys = (await sql`
    UPDATE user_wrapped_keys SET wrapped_dek = NULL, destroyed_at = now()
    WHERE user_id = ${userId} AND destroyed_at IS NULL RETURNING user_id
  `) as Array<{ user_id: string }>
  return {
    memory_records: memories.length,
    hire_memories: botMemories.length,
    consent_records: consents.length,
    vault_items_v2: vaultItems.length,
    capability_grants_revoked: grants.length,
    user_keys_destroyed: keys.length,
    memory_index_rows: indexRowsDropped,
  }
}
