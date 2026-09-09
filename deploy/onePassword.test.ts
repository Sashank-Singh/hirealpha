import { describe, expect, it } from 'bun:test'
import { isOpRef, onePasswordConfigured, opGetItemFields, opMode, opSaveItem, type OpSdkClient } from './onePassword'

/* ============================================================================
 * 1Password Connect client — the opt-in backing store. Fake fetch pins the
 * contract: item upsert by title, opaque op1p: refs, field readback. Env is
 * set per-test and restored; these must not leak into other files.
 * ========================================================================== */

const ENV_KEYS = ['OP_CONNECT_HOST', 'OP_CONNECT_TOKEN', 'OP_VAULT_ID'] as const

function withOpEnv(fn: () => Promise<void> | void): Promise<void> | void {
  process.env.OP_CONNECT_HOST = 'http://op-connect:8080'
  process.env.OP_CONNECT_TOKEN = 'tok'
  process.env.OP_VAULT_ID = 'vault-1'
  const done = fn()
  if (done instanceof Promise) {
    return done.finally(() => {
      for (const k of ENV_KEYS) delete process.env[k]
    })
  }
  for (const k of ENV_KEYS) delete process.env[k]
}

function fakeFetch(responses: Array<{ match: RegExp; body: unknown; status?: number; method?: string }>) {
  const calls: Array<{ url: string; init?: RequestInit }> = []
  const fetchFn = (async (url: string | URL, init?: RequestInit) => {
    calls.push({ url: String(url), init })
    const text = String(url)
    const hit = responses.find((r) => r.match.test(text) && (!r.method || (init?.method || 'GET') === r.method))
    if (!hit) return new Response(JSON.stringify({ error: 'unmatched' }), { status: 404 })
    return new Response(JSON.stringify(hit.body), { status: hit.status ?? 200 })
  }) as typeof fetch
  return { fetchFn, calls }
}

describe('1Password Connect client', () => {
  it('is off without env, on with all three vars', async () => {
    expect(onePasswordConfigured()).toBe(false)
    await withOpEnv(() => {
      expect(onePasswordConfigured()).toBe(true)
    })
    expect(onePasswordConfigured()).toBe(false)
  })

  it('opSaveItem creates a LOGIN item and returns an opaque ref', async () => {
    await withOpEnv(async () => {
      const { fetchFn, calls } = fakeFetch([
        { match: /\/v1\/vaults\/vault-1\/items$/, method: 'GET', body: [] },
        { match: /\/v1\/vaults\/vault-1\/items$/, method: 'POST', body: { id: 'item-9' }, status: 201 },
      ])
      const ref = await opSaveItem(
        { userId: 'u-alice', persona: 'friend', origin: 'https://portal.nseindia.com', username: 'me@x.com', password: 'hunter2!' },
        { fetchFn },
      )
      expect(ref).toBe('op1p:vault-1:item-9')
      expect(isOpRef(ref)).toBe(true)
      const post = calls.find((c) => (c.init?.method) === 'POST')!
      const payload = JSON.parse(String(post.init!.body)) as { category: string; fields: Array<{ label: string; type: string; value: string }> }
      expect(payload.category).toBe('LOGIN')
      const password = payload.fields.find((f) => f.label === 'password')!
      expect(password.type).toBe('CONCEALED')
      expect(password.value).toBe('hunter2!')
    })
  })

  it('opSaveItem updates an existing item by title instead of duplicating', async () => {
    await withOpEnv(async () => {
      const { fetchFn, calls } = fakeFetch([
        { match: /\/v1\/vaults\/vault-1\/items$/, method: 'GET', body: [{ id: 'item-9', title: 'alpha u-alice friend portal.nseindia.com' }] },
        { match: /\/v1\/vaults\/vault-1\/items\/item-9$/, method: 'PUT', body: { id: 'item-9' } },
      ])
      const ref = await opSaveItem(
        { userId: 'u-alice', persona: 'friend', origin: 'https://portal.nseindia.com', password: 'newpass' },
        { fetchFn },
      )
      expect(ref).toBe('op1p:vault-1:item-9')
      expect(calls.some((c) => c.init?.method === 'PUT')).toBe(true)
    })
  })

  it('opGetItemFields reads username/password back from the item', async () => {
    await withOpEnv(async () => {
      const { fetchFn, calls } = fakeFetch([
        {
          match: /\/v1\/vaults\/vault-1\/items\/item-9$/,
          body: { id: 'item-9', fields: [{ label: 'username', type: 'STRING', value: 'me@x.com' }, { label: 'password', type: 'CONCEALED', value: 'hunter2!' }] },
        },
      ])
      const fields = await opGetItemFields('op1p:vault-1:item-9', { fetchFn })
      expect(fields).toEqual({ username: 'me@x.com', password: 'hunter2!' })
      expect(calls[0]!.url).toContain('/v1/vaults/vault-1/items/item-9')
    })
  })

  it('returns null on a failed Connect call, never throws', async () => {
    await withOpEnv(async () => {
      const { fetchFn } = fakeFetch([])
      expect(await opGetItemFields('op1p:vault-1:item-404', { fetchFn })).toBeNull()
      expect(await opSaveItem({ userId: 'u', persona: 'friend', origin: 'https://x.com', password: 'p' }, { fetchFn })).toBeNull()
    })
  })

  it('refuses malformed refs', async () => {
    await withOpEnv(async () => {
      const { fetchFn } = fakeFetch([])
      expect(await opGetItemFields('op1p:only-two-parts', { fetchFn })).toBeNull()
      expect(await opGetItemFields('not-a-ref', { fetchFn })).toBeNull()
    })
  })
})

/* ----------------------------- SDK transport ------------------------------ */

const ENV_KEYS_SDK = ['OP_SERVICE_ACCOUNT_TOKEN', 'OP_VAULT_ID'] as const

function withSdkEnv(fn: () => Promise<void> | void): Promise<void> | void {
  process.env.OP_SERVICE_ACCOUNT_TOKEN = 'ops_fake-test-token'
  process.env.OP_VAULT_ID = 'vault-1'
  const done = fn()
  if (done instanceof Promise) {
    return done.finally(() => {
      for (const k of ENV_KEYS_SDK) delete process.env[k]
    })
  }
  for (const k of ENV_KEYS_SDK) delete process.env[k]
}

function sdkFake(): { sdk: OpSdkClient; calls: Array<{ op: string; args: unknown[] }> } {
  const calls: Array<{ op: string; args: unknown[] }> = []
  const sdk: OpSdkClient = {
    items: {
      list: async (vaultId) => {
        calls.push({ op: 'list', args: [vaultId] })
        return []
      },
      get: async (vaultId, itemId) => {
        calls.push({ op: 'get', args: [vaultId, itemId] })
        return {
          id: itemId,
          fields: [
            { title: 'username', fieldType: 'Text', value: 'me@x.com' },
            { title: 'password', fieldType: 'Concealed', value: 'hunter2!' },
          ],
        }
      },
      create: async (params) => {
        calls.push({ op: 'create', args: [params] })
        return { id: 'item-sdk-1' }
      },
      put: async (item) => {
        calls.push({ op: 'put', args: [item] })
        return { id: 'item-sdk-1' }
      },
    },
  }
  return { sdk, calls }
}

describe('1Password SDK transport (service account)', () => {
  it('mode = sdk when only the service account token is set', async () => {
    expect(opMode()).toBeNull()
    await withSdkEnv(() => {
      expect(opMode()).toBe('sdk')
      expect(onePasswordConfigured()).toBe(true)
    })
    expect(opMode()).toBeNull()
  })

  it('stays off when the service account token has no vault id', async () => {
    process.env.OP_SERVICE_ACCOUNT_TOKEN = 'ops_fake-test-token'
    delete process.env.OP_VAULT_ID
    try {
      expect(opMode()).toBeNull()
      expect(onePasswordConfigured()).toBe(false)
    } finally {
      delete process.env.OP_SERVICE_ACCOUNT_TOKEN
    }
  })

  it('opSaveItem creates a Login item with Concealed password + website', async () => {
    await withSdkEnv(async () => {
      const { sdk, calls } = sdkFake()
      const ref = await opSaveItem(
        { userId: 'u-alice', persona: 'friend', origin: 'https://portal.nseindia.com', username: 'me@x.com', password: 'hunter2!' },
        { sdk },
      )
      expect(ref).toBe('op1p:vault-1:item-sdk-1')
      const create = calls.find((c) => c.op === 'create')!
      const params = create.args[0] as { category: string; vaultId: string; fields: Array<{ fieldType: string; value: string; title: string }>; websites: Array<{ url: string; autofillBehavior: string }> }
      expect(params.category).toBe('Login')
      expect(params.vaultId).toBe('vault-1')
      expect(params.fields.find((f) => f.title === 'password')!.fieldType).toBe('Concealed')
      expect(params.fields.find((f) => f.title === 'password')!.value).toBe('hunter2!')
      expect(params.websites[0]!.url).toBe('https://portal.nseindia.com')
      expect(params.websites[0]!.autofillBehavior).toBe('ExactDomain')
    })
  })

  it('opSaveItem updates via put when the title already exists', async () => {
    await withSdkEnv(async () => {
      const { sdk, calls } = sdkFake()
      sdk.items.list = async () => [{ id: 'item-sdk-1', title: 'alpha u-alice friend portal.nseindia.com' }]
      const ref = await opSaveItem(
        { userId: 'u-alice', persona: 'friend', origin: 'https://portal.nseindia.com', password: 'newpass' },
        { sdk },
      )
      expect(ref).toBe('op1p:vault-1:item-sdk-1')
      expect(calls.some((c) => c.op === 'put')).toBe(true)
      expect(calls.some((c) => c.op === 'create')).toBe(false)
    })
  })

  it('opGetItemFields reads fields back through items.get', async () => {
    await withSdkEnv(async () => {
      const { sdk, calls } = sdkFake()
      const fields = await opGetItemFields('op1p:vault-1:item-sdk-1', { sdk })
      expect(fields).toEqual({ username: 'me@x.com', password: 'hunter2!' })
      expect(calls[0]).toEqual({ op: 'get', args: ['vault-1', 'item-sdk-1'] })
    })
  })

  it('fails soft: SDK errors become null, never throws', async () => {
    await withSdkEnv(async () => {
      const { sdk } = sdkFake()
      sdk.items.list = async () => {
        throw new Error('vault unreachable')
      }
      expect(await opSaveItem({ userId: 'u', persona: 'friend', origin: 'https://x.com', password: 'p' }, { sdk })).toBeNull()
      sdk.items.get = async () => {
        throw new Error('no item')
      }
      expect(await opGetItemFields('op1p:vault-1:item-sdk-1', { sdk })).toBeNull()
    })
  })

  it('requires OP_VAULT_ID alongside the token for saves', async () => {
    await withSdkEnv(async () => {
      delete process.env.OP_VAULT_ID
      const { sdk } = sdkFake()
      expect(await opSaveItem({ userId: 'u', persona: 'friend', origin: 'https://x.com', password: 'p' }, { sdk })).toBeNull()
    })
  })
})
