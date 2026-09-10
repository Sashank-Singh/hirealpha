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

/** Stateful fake for the capability claim protocol: the UPDATE ... WHERE
 * status = 'approved' claim only succeeds while the grant is approved, and
 * finalize moves it to a terminal state — so reuse, concurrency, and the
 * crash-after-consumption case behave like real Postgres. */
function capabilitySql(options: {
  grant?: Record<string, unknown>
  item?: { id: string; exact_origin: string; ciphertext: string }
  decryptSucceeds?: boolean
}) {
  const queries: string[] = []
  let status = options.grant ? 'approved' : 'missing'
  const sql = ((strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.join('?')
    queries.push(`${text} :: ${JSON.stringify(values.map(String))}`)
    if (text.includes("SET status = 'consuming'")) {
      // Emulate the real claim fencing: id + user_id + task_id + digest must
      // all match the stored grant, and it must still be approved.
      const [id, userId, taskId, digest] = values as [string, string, string, Uint8Array]
      const grant = options.grant
      const fenced = grant
        && grant.id === id && grant.user_id === userId && grant.task_id === taskId
        && Buffer.from(grant.request_digest as Uint8Array).equals(Buffer.from(digest))
      if (fenced && status === 'approved') {
        status = 'consuming'
        return Promise.resolve([grant])
      }
      return Promise.resolve([])
    }
    if (text.includes('finalized_at = now()')) {
      status = 'terminal'
      return Promise.resolve([{ status: 'consumed' }])
    }
    if (text.includes('FROM vault_items_v2') && text.includes('ciphertext FROM')) {
      return Promise.resolve(options.item ? [options.item] : [])
    }
    if (text.includes('FROM user_wrapped_keys')) return Promise.resolve([{ wrapped_dek: 'vault:v1:key' }])
    return Promise.resolve([])
  }) as never
  return { sql, queries, statusAfter: () => status }
}

const baseGrant = {
  id: 'cap-1', user_id: 'user-1', task_id: 'task-1', resource_type: 'credential',
  resource_id: 'item-1', action: 'autofill', exact_origin: 'https://example.com',
  amount_cents: null, currency: null, merchant: null, recipient: null, cart: [],
  requesting_agent: 'alpha', purpose: 'Sign in', request_digest: new Uint8Array(32).fill(0xaa),
  status: 'approved', expires_at: new Date(Date.now() + 60_000), revocation_requested_at: null,
}

const realItem = {
  id: 'item-1',
  exact_origin: 'https://example.com',
  ciphertext: '',
}

describe('Vault v2 capability security matrix', () => {
  it('delivers the credential exactly once and finalizes the grant as consumed', async () => {
    const { encryptUserPayload } = await import('./userKeyBroker')
    realItem.ciphertext = encryptUserPayload(
      JSON.stringify({ username: 'person@example.com', password: 'once-only' }),
      Buffer.alloc(32, 9),
      { userId: 'user-1', recordId: 'item-1', scope: 'vault:https://example.com' },
    )
    const { sql, queries, statusAfter } = capabilitySql({ grant: baseGrant, item: realItem })
    const first = await consumeVaultCredential(sql, broker, {
      userId: 'user-1', taskId: 'task-1', itemId: 'item-1', capabilityId: 'cap-1',
      digest: 'a'.repeat(64), origin: 'https://example.com',
    })
    expect(first).toEqual({ username: 'person@example.com', password: 'once-only' })
    expect(statusAfter()).toBe('terminal')
    expect(queries.some((q) => q.includes("SET status = 'consuming'"))).toBe(true)

    // Second use — including a crash-free replay by the same task — is denied.
    const replay = await consumeVaultCredential(sql, broker, {
      userId: 'user-1', taskId: 'task-1', itemId: 'item-1', capabilityId: 'cap-1',
      digest: 'a'.repeat(64), origin: 'https://example.com',
    })
    expect(replay).toBeNull()
  })

  it('never writes the plaintext credential into any database statement', async () => {
    const { sql, queries } = capabilitySql({ grant: baseGrant, item: realItem })
    await consumeVaultCredential(sql, broker, {
      userId: 'user-1', taskId: 'task-1', itemId: 'item-1', capabilityId: 'cap-1',
      digest: 'a'.repeat(64), origin: 'https://example.com',
    })
    expect(JSON.stringify(queries)).not.toContain('once-only')
  })

  it('rejects a different exact origin, including a deceptive subdomain', async () => {
    for (const origin of ['https://evil.com', 'https://login.example.com', 'https://example.com.evil.com']) {
      const { sql, statusAfter } = capabilitySql({ grant: baseGrant, item: realItem })
      const result = await consumeVaultCredential(sql, broker, {
        userId: 'user-1', taskId: 'task-1', itemId: 'item-1', capabilityId: 'cap-1',
        digest: 'a'.repeat(64), origin,
      })
      expect(result).toBeNull()
      expect(statusAfter()).toBe('terminal')
    }
  })

  it('rejects the wrong item, user, task, and digest bindings', async () => {
    // Wrong user / task / digest never even claim the grant: the SQL fencing
    // leaves it approved, so the capability is untouched.
    for (const [field, value] of [['userId', 'user-2'], ['taskId', 'task-2'], ['digest', 'b'.repeat(64)]] as const) {
      const { sql, statusAfter } = capabilitySql({ grant: baseGrant, item: realItem })
      const result = await consumeVaultCredential(sql, broker, {
        userId: 'user-1', taskId: 'task-1', itemId: 'item-1', capabilityId: 'cap-1',
        digest: 'a'.repeat(64), origin: 'https://example.com',
        [field]: value,
      } as never)
      expect(result).toBeNull()
      expect(statusAfter()).toBe('approved')
    }
    // Wrong item claims the grant (id/digest match), then the immutable scope
    // check closes it without ever decrypting.
    const { sql, statusAfter } = capabilitySql({ grant: baseGrant, item: realItem })
    const wrongItem = await consumeVaultCredential(sql, broker, {
      userId: 'user-1', taskId: 'task-1', itemId: 'item-2', capabilityId: 'cap-1',
      digest: 'a'.repeat(64), origin: 'https://example.com',
    })
    expect(wrongItem).toBeNull()
    expect(statusAfter()).toBe('terminal')
  })

  it('denies consumption when the vault item was revoked or deleted mid-queue', async () => {
    const { sql, statusAfter } = capabilitySql({ grant: baseGrant, item: undefined })
    const result = await consumeVaultCredential(sql, broker, {
      userId: 'user-1', taskId: 'task-1', itemId: 'item-1', capabilityId: 'cap-1',
      digest: 'a'.repeat(64), origin: 'https://example.com',
    })
    expect(result).toBeNull()
    expect(statusAfter()).toBe('terminal')
  })

  it('denies consumption when the credential cannot be decrypted with the user key', async () => {
    // Ciphertext sealed under a different (rotated-away) key.
    realItem.ciphertext = 'v2.aaaaaaaaaaaaaaaa.aaaaaaaaaaaaaaaaaaaa.aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
    const { sql, statusAfter } = capabilitySql({ grant: baseGrant, item: realItem })
    const result = await consumeVaultCredential(sql, broker, {
      userId: 'user-1', taskId: 'task-1', itemId: 'item-1', capabilityId: 'cap-1',
      digest: 'a'.repeat(64), origin: 'https://example.com',
    })
    expect(result).toBeNull()
    expect(statusAfter()).toBe('terminal')
    realItem.ciphertext = ''
  })
})
