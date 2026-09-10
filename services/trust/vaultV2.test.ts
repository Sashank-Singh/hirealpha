import { describe, expect, it } from 'bun:test'
import { consumeVaultCredential, listVaultItems, revokeVaultItem, saveVaultItem } from './vaultV2'
import type { UserKeyBroker } from './userKeyBroker'

function fakeSql(existing: Array<{ id: string }> = []) {
  const queries: Array<{ text: string; values: unknown[] }> = []
  const sql = ((strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.join('?')
    queries.push({ text, values })
    if (text.includes('FROM vault_items_v2') && text.includes('SELECT id')) return Promise.resolve(existing)
    if (text.includes('FROM user_wrapped_keys')) return Promise.resolve([{ wrapped_dek: 'vault:v1:key' }])
    if (text.includes('INSERT INTO vault_items_v2')) return Promise.resolve([{ id: values[0] }])
    if (text.includes('UPDATE vault_items_v2') && text.includes('RETURNING id')) return Promise.resolve([{ id: values[0] }])
    if (text.includes('SELECT id, exact_origin')) return Promise.resolve([])
    return Promise.resolve([])
  }) as never
  return { sql, queries }
}

const broker: UserKeyBroker = {
  generate: async () => { throw new Error('not expected') },
  unwrap: async () => Buffer.alloc(32, 9),
}

describe('Vault v2', () => {
  it('stores only exact-origin-bound ciphertext and a masked username hint', async () => {
    const { sql, queries } = fakeSql()
    await saveVaultItem(sql, broker, {
      userId: 'user-1', origin: 'https://example.com/login?next=/account', label: 'Work',
      username: 'person@example.com', password: 'not-in-the-database',
    })
    const insert = queries.find((query) => query.text.includes('INSERT INTO vault_items_v2'))!
    expect(insert.values).toContain('https://example.com')
    expect(insert.values).toContain('pe•••@example.com')
    expect(JSON.stringify(insert.values)).not.toContain('not-in-the-database')
    expect(JSON.stringify(insert.values)).toContain('v2.')
  })

  it('rejects non-HTTPS credential origins', async () => {
    const { sql } = fakeSql()
    await expect(saveVaultItem(sql, broker, {
      userId: 'user-1', origin: 'http://example.com', label: 'Work', password: 'password',
    })).rejects.toThrow('HTTPS')
  })

  it('lists metadata without loading ciphertext', async () => {
    const { sql, queries } = fakeSql()
    await listVaultItems(sql, 'user-1')
    const select = queries.find((query) => query.text.includes('ORDER BY updated_at'))!
    expect(select.text).not.toContain('ciphertext')
  })

  it('crypto-shreds a revoked item while retaining its lifecycle row', async () => {
    const { sql, queries } = fakeSql()
    expect(await revokeVaultItem(sql, { userId: 'user-1', itemId: 'item-1' })).toBe(true)
    const update = queries.find((query) => query.text.includes('UPDATE vault_items_v2'))!
    expect(update.text).toContain('ciphertext = NULL')
    expect(update.text).toContain('revoked_at = now()')
  })

  it('closes a claimed capability when its immutable vault scope does not match', async () => {
    const queries: string[] = []
    const sql = ((strings: TemplateStringsArray) => {
      const text = strings.join('?')
      queries.push(text)
      if (text.includes("SET status = 'consuming'")) return Promise.resolve([{
        id: 'cap-1', user_id: 'user-1', task_id: 'task-1', resource_type: 'credential',
        resource_id: 'different-item', action: 'autofill', exact_origin: 'https://example.com',
        amount_cents: null, currency: null, merchant: null, recipient: null, cart: [],
        requesting_agent: 'alpha', purpose: 'Sign in', request_digest: new Uint8Array(32),
        status: 'consuming', expires_at: new Date(Date.now() + 60_000), revocation_requested_at: null,
      }])
      if (text.includes('SET status = ?')) return Promise.resolve([{ status: 'revoked' }])
      return Promise.resolve([])
    }) as never
    const result = await consumeVaultCredential(sql, broker, {
      userId: 'user-1', taskId: 'task-1', itemId: 'item-1', capabilityId: 'cap-1',
      digest: 'a'.repeat(64), origin: 'https://example.com',
    })
    expect(result).toBeNull()
    expect(queries.some((query) => query.includes('finalized_at = now()'))).toBe(true)
  })
})
