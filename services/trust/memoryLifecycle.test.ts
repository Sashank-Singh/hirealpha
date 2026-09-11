import { describe, expect, it } from 'bun:test'
import {
  categoryForKey,
  deleteUserMemories,
  ensureMemoryConsent,
  grantMemoryConsent,
  listConsentedMemories,
  purgeAccountTrustData,
  storeConsentedMemory,
  type MemoryCategory,
} from './memoryLifecycle'
import type { UserKeyBroker } from './userKeyBroker'
import type { MemoryIndex, MemoryIndexRecord } from './memoryIndex'

function fakeSql(consent = true) {
  const queries: Array<{ text: string; values: unknown[] }> = []
  const sql = ((strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.join('?')
    queries.push({ text, values })
    if (text.includes('FROM consent_records')) return Promise.resolve(consent ? [{ id: 'consent-1' }] : [])
    if (text.includes('FROM user_wrapped_keys')) return Promise.resolve([{ wrapped_dek: 'vault:v1:key' }])
    if (text.includes('UPDATE memory_records')) return Promise.resolve([{ id: 'memory-1' }, { id: 'memory-2' }])
    return Promise.resolve([])
  }) as never
  return { sql, queries }
}

const broker: UserKeyBroker = {
  generate: async () => { throw new Error('not expected') },
  unwrap: async () => Buffer.alloc(32, 5),
}

/** Records what the index was asked to do, without needing pgvector. */
function fakeIndex() {
  const indexed: MemoryIndexRecord[] = []
  const removed: Array<{ userId: string; persona: string; keys: string[] }> = []
  const dropped: string[] = []
  const index: MemoryIndex = {
    index: async (record) => { indexed.push(record); return true },
    search: async () => [],
    removeKeys: async (input) => { removed.push(input); return input.keys.length },
    dropByUser: async (userId) => { dropped.push(userId); return 3 },
  }
  return { index, indexed, removed, dropped }
}

describe('categorized memory lifecycle', () => {
  it('refuses memory without exact category and purpose consent', async () => {
    const { sql } = fakeSql(false)
    await expect(storeConsentedMemory(sql, broker, {
      userId: 'user-1', category: 'work', purpose: 'Prepare weekly brief', content: 'Prefers concise updates', retentionDays: 30,
    })).rejects.toThrow('Active consent')
  })

  it('encrypts consented memory and never sends plaintext to SQL', async () => {
    const { sql, queries } = fakeSql(true)
    await storeConsentedMemory(sql, broker, {
      userId: 'user-1', category: 'work', purpose: 'Prepare weekly brief', content: 'Prefers concise updates', retentionDays: 30,
    })
    const insert = queries.find((query) => query.text.includes('INSERT INTO memory_records'))!
    expect(JSON.stringify(insert.values)).not.toContain('Prefers concise updates')
    expect(JSON.stringify(insert.values)).toContain('v2.')
  })

  it('enforces stricter retention for health and financial data', async () => {
    for (const category of ['health', 'financial'] as MemoryCategory[]) {
      const { sql } = fakeSql(true)
      await expect(storeConsentedMemory(sql, broker, {
        userId: 'user-1', category, purpose: 'Temporary assistance', content: 'Sensitive fact', retentionDays: 31,
      })).rejects.toThrow('Retention exceeds')
    }
  })

  it('deletes content while retaining a minimal lifecycle receipt', async () => {
    const { sql, queries } = fakeSql()
    expect(await deleteUserMemories(sql, { userId: 'user-1', category: 'work', reason: 'user_request' })).toBe(2)
    const update = queries.find((query) => query.text.includes('UPDATE memory_records'))!
    expect(update.text).toContain('ciphertext = NULL')
    expect(update.text).toContain('deleted_at = now()')
    expect(update.values).toContain('user-1')
  })

  it('records consent version and source with every grant', async () => {
    const { sql, queries } = fakeSql()
    await grantMemoryConsent(sql, {
      userId: 'user-1', category: 'preference', purpose: 'Personalize suggestions',
      consentVersion: 3, source: 'trust-center',
    })
    const insert = queries.find((query) => query.text.includes('INSERT INTO consent_records'))!
    expect(insert.text).toContain('consent_version')
    expect(insert.values).toContain(3)
    expect(insert.values).toContain('trust-center')
  })

  it('purges every trust-adjacent store for account deletion', async () => {
    const queries: string[] = []
    const sql = ((strings: TemplateStringsArray) => {
      const text = strings.join('?')
      queries.push(text)
      if (text.includes('DELETE FROM memory_records')) return Promise.resolve([{ id: 'm-1' }])
      if (text.includes('DELETE FROM hire_memories')) return Promise.resolve([{ persona: 'friend' }])
      if (text.includes('DELETE FROM consent_records')) return Promise.resolve([{ id: 'c-1' }])
      if (text.includes('DELETE FROM vault_items_v2')) return Promise.resolve([{ id: 'v-1' }])
      if (text.includes('UPDATE capability_grants')) return Promise.resolve([{ id: 'g-1' }])
      if (text.includes('UPDATE user_wrapped_keys')) return Promise.resolve([{ user_id: 'user-1' }])
      return Promise.resolve([])
    }) as never
    const deleted = await purgeAccountTrustData(sql, 'user-1')
    expect(deleted).toEqual({
      memory_records: 1, hire_memories: 1, consent_records: 1,
      vault_items_v2: 1, capability_grants_revoked: 1, user_keys_destroyed: 1,
      memory_index_rows: 0,
    })
    const joined = queries.join('\n')
    for (const table of ['memory_records', 'hire_memories', 'consent_records', 'vault_items_v2', 'capability_grants', 'user_wrapped_keys']) {
      expect(joined).toContain(table)
    }
    // Every purge statement is scoped to the one account.
    for (const statement of queries) {
      if (statement.includes('DELETE FROM') || statement.includes('UPDATE capability_grants') || statement.includes('UPDATE user_wrapped_keys')) {
        expect(statement).toContain('user_id = ?')
      }
    }
  })

  it('drops the account from the retrieval index, which holds plaintext', async () => {
    const { index, dropped } = fakeIndex()
    const sql = (() => Promise.resolve([])) as never
    const deleted = await purgeAccountTrustData(sql, 'user-1', index)
    expect(dropped).toEqual(['user-1'])
    expect(deleted.memory_index_rows).toBe(3)
  })

  it('projects a stored fact into the index with its retention date', async () => {
    const { sql } = fakeSql(true)
    const { index, indexed } = fakeIndex()
    await storeConsentedMemory(sql, broker, {
      userId: 'user-1', category: 'preference', purpose: 'personalize this hire',
      content: 'hard_nos: no pork', retentionDays: 365, persona: 'friend', key: 'hard_nos', index,
    })
    expect(indexed).toHaveLength(1)
    expect(indexed[0]!.key).toBe('hard_nos')
    expect(indexed[0]!.persona).toBe('friend')
    // The index must be retention-bound so it cannot outlive memory_records.
    expect(indexed[0]!.expiresAt).toBeInstanceOf(Date)
  })

  it('removes index rows by key when memories are shredded', async () => {
    const { index, removed } = fakeIndex()
    const sql = ((strings: TemplateStringsArray) => {
      const text = strings.join('?')
      if (text.includes('SELECT user_id, persona, memory_key')) {
        return Promise.resolve([
          { user_id: 'user-1', persona: 'friend', memory_key: 'hard_nos' },
          { user_id: 'user-1', persona: 'friend', memory_key: 'city' },
        ])
      }
      if (text.includes('UPDATE memory_records')) return Promise.resolve([{ id: 'm-1' }, { id: 'm-2' }])
      return Promise.resolve([])
    }) as never
    expect(await deleteUserMemories(sql, { userId: 'user-1', reason: 'user_request', index })).toBe(2)
    expect(removed).toEqual([{ userId: 'user-1', persona: 'friend', keys: ['hard_nos', 'city'] }])
  })

  it('files constraints under a 365-day bucket, not the 30-day health cap', () => {
    // The bug this guards: `hard_nos` filed as health would expire after 30
    // days and the hire would start offering the thing the user refused.
    expect(categoryForKey('hard_nos')).toBe('relationship')
    expect(categoryForKey('diet')).toBe('preference')
    expect(categoryForKey('preferred_name')).toBe('identity')
    expect(categoryForKey('protein')).toBe('health')
    expect(categoryForKey('runway_months')).toBe('financial')
    expect(categoryForKey('some_unknown_fact')).toBe('preference')
  })

  it('reuses an existing consent grant instead of duplicating it', async () => {
    const inserted: unknown[][] = []
    const sql = ((strings: TemplateStringsArray, ...values: unknown[]) => {
      const text = strings.join('?')
      if (text.includes('FROM consent_records')) {
        return Promise.resolve([{ category: 'identity' }, { category: 'preference' }])
      }
      if (text.includes('INSERT INTO consent_records')) {
        inserted.push(values)
        return Promise.resolve([])
      }
      return Promise.resolve([])
    }) as never
    const granted = await ensureMemoryConsent(sql, { userId: 'user-1', persona: 'friend' })
    expect(granted).toEqual(['identity', 'preference', 'relationship', 'health'])
    // Only the two not already granted are inserted.
    expect(inserted).toHaveLength(2)
  })

  it('returns decrypted facts and strips the key prefix from the value', async () => {
    const { encryptUserPayload } = await import('./userKeyBroker')
    const sealed = encryptUserPayload('diet: vegetarian', Buffer.alloc(32, 5), {
      userId: 'user-1', recordId: 'm-1', scope: 'memory:preference',
    })
    const sql = ((strings: TemplateStringsArray) => {
      const text = strings.join('?')
      if (text.includes('SELECT id, category, persona, memory_key, durable, ciphertext')) {
        return Promise.resolve([
          { id: 'm-1', category: 'preference', persona: 'friend', memory_key: 'diet', durable: true, ciphertext: sealed, created_at: new Date(0) },
        ])
      }
      if (text.includes('FROM user_wrapped_keys')) return Promise.resolve([{ wrapped_dek: 'vault:v1:key' }])
      return Promise.resolve([])
    }) as never
    const memories = await listConsentedMemories(sql, broker, { userId: 'user-1', persona: 'friend' })
    expect(memories).toHaveLength(1)
    // The prompt renders `key: value` itself, so the stored prefix is stripped.
    expect(memories[0]!.key).toBe('diet')
    expect(memories[0]!.value).toBe('vegetarian')
  })
})
