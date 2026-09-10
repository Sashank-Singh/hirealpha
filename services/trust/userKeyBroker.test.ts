import { describe, expect, it } from 'bun:test'
import { decryptUserPayload, encryptUserPayload, loadOrCreateUserKey, type UserKeyBroker } from './userKeyBroker'

describe('per-user envelope encryption', () => {
  it('roundtrips with authenticated user, record, scope, and version context', () => {
    const key = Buffer.alloc(32, 7)
    const context = { userId: 'user-1', recordId: 'record-1', scope: 'https://example.com', version: 1 }
    const encrypted = encryptUserPayload('secret-value', key, context)
    expect(encrypted).not.toContain('secret-value')
    expect(decryptUserPayload(encrypted, key, context)).toBe('secret-value')
  })

  it('cannot move ciphertext between users, records, scopes, versions, or keys', () => {
    const key = Buffer.alloc(32, 7)
    const context = { userId: 'user-1', recordId: 'record-1', scope: 'https://example.com', version: 1 }
    const encrypted = encryptUserPayload('secret-value', key, context)
    expect(decryptUserPayload(encrypted, key, { ...context, userId: 'user-2' })).toBeNull()
    expect(decryptUserPayload(encrypted, key, { ...context, recordId: 'record-2' })).toBeNull()
    expect(decryptUserPayload(encrypted, key, { ...context, scope: 'https://evil.example' })).toBeNull()
    expect(decryptUserPayload(encrypted, key, { ...context, version: 2 })).toBeNull()
    expect(decryptUserPayload(encrypted, Buffer.alloc(32, 8), context)).toBeNull()
  })

  it('stores only the wrapped key and clears generated plaintext memory', async () => {
    const plaintext = Buffer.alloc(32, 9)
    const broker: UserKeyBroker = {
      generate: async () => ({ plaintext, wrapped: 'vault:v1:wrapped' }),
      unwrap: async () => { throw new Error('not expected') },
    }
    const queries: Array<{ text: string; values: unknown[] }> = []
    const sql = ((strings: TemplateStringsArray, ...values: unknown[]) => {
      const text = strings.join('?')
      queries.push({ text, values })
      if (text.includes('INSERT INTO user_wrapped_keys')) return Promise.resolve([{ user_id: 'user-1' }])
      return Promise.resolve([])
    }) as never
    const key = await loadOrCreateUserKey(sql, broker, 'user-1')
    expect(key).toEqual(Buffer.alloc(32, 9))
    expect(plaintext).toEqual(Buffer.alloc(32, 0))
    expect(JSON.stringify(queries)).not.toContain(Buffer.alloc(32, 9).toString('hex'))
  })
})
