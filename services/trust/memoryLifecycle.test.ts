import { describe, expect, it } from 'bun:test'
import { deleteUserMemories, storeConsentedMemory, type MemoryCategory } from './memoryLifecycle'
import type { UserKeyBroker } from './userKeyBroker'

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
})
