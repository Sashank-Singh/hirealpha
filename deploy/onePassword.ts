/**
 * 1Password backing store for the credential vault — two official transports,
 * one contract.
 *
 * Transport 1 (preferred): the official @1password/sdk with a Service Account
 * token. `OP_SERVICE_ACCOUNT_TOKEN` is the only env var needed — no Connect
 * server to host. Matches 1Password's AI-agent guidance: the server (not the
 * agent) resolves secrets, scoped to one vault, least privilege.
 *
 * Transport 2: a self-hosted 1Password Connect server
 * (`OP_CONNECT_HOST` + `OP_CONNECT_TOKEN` + `OP_VAULT_ID`).
 *
 * When either is configured, saving a vault entry creates/updates a LOGIN
 * item in that vault and hire_vault_entries keeps only an opaque
 * `op1p:<vaultId>:<itemId>` reference — the secret itself lives in 1Password.
 * Without them the vault falls back to local AES-256-GCM (vaultCrypto.ts),
 * so dev and tests stay zero-config.
 *
 * Both paths share one task-time contract: getItemFields(ref) returns
 * { username?, password? } or null, and plaintext only exists for the moment
 * the browser runner needs it.
 */

const OP_REF_PREFIX = 'op1p:'

export type OpFields = { username?: string; password?: string }
export type OpItemRef = string // `op1p:<vaultId>:<itemId>`

/** Minimal structural slice of @1password/sdk's client, for injection in tests. */
export type OpSdkClient = {
  items: {
    list: (vaultId: string) => Promise<Array<{ id?: string; title?: string }>>
    get: (vaultId: string, itemId: string) => Promise<{ id?: string; title?: string; fields?: Array<{ title?: string; fieldType?: string; value?: string }> }>
    create: (params: Record<string, unknown>) => Promise<{ id?: string; fields?: Array<{ title?: string; fieldType?: string; value?: string }> }>
    put: (item: Record<string, unknown>) => Promise<{ id?: string }>
  }
}

type OpClientOpts = { fetchFn?: typeof fetch; sdk?: OpSdkClient }

/* ------------------------------- mode ------------------------------------ */

export type OpMode = 'sdk' | 'connect'

export function opMode(): OpMode | null {
  if (process.env.OP_SERVICE_ACCOUNT_TOKEN?.trim()) return 'sdk'
  if (process.env.OP_CONNECT_HOST?.trim() && process.env.OP_CONNECT_TOKEN?.trim() && process.env.OP_VAULT_ID?.trim()) return 'connect'
  return null
}

export function onePasswordConfigured(): boolean {
  return opMode() !== null
}

export function isOpRef(value: string | null | undefined): value is OpItemRef {
  return typeof value === 'string' && value.startsWith(OP_REF_PREFIX) && value.split(':').length === 3
}

function opVaultId(): string {
  return process.env.OP_VAULT_ID?.trim() || ''
}

function hostOf(origin: string): string {
  try {
    return new URL(origin).host || origin
  } catch {
    return origin
  }
}

export function opItemTitle(userId: string, persona: string, origin: string): string {
  return `alpha ${userId.slice(0, 8)} ${persona} ${hostOf(origin)}`
}

/* --------------------------- SDK (service account) ----------------------- */

let sdkClientPromise: Promise<unknown> | null = null

async function getSdkClient(opts?: OpClientOpts): Promise<OpSdkClient> {
  if (opts?.sdk) return opts.sdk
  if (!sdkClientPromise) {
    sdkClientPromise = (async () => {
      const mod = (await eval('import("@1password/sdk")')) as {
        createClient: (cfg: { auth: string; integrationName: string; integrationVersion: string }) => Promise<unknown>
      }
      return mod.createClient({
        auth: process.env.OP_SERVICE_ACCOUNT_TOKEN!.trim(),
        integrationName: 'HireAlpha',
        integrationVersion: 'v1',
      })
    })()
    sdkClientPromise.catch(() => {
      sdkClientPromise = null
    })
  }
  return sdkClientPromise as Promise<OpSdkClient>
}

async function sdkSaveItem(
  input: { userId: string; persona: string; origin: string; username?: string; password: string },
  opts?: OpClientOpts,
): Promise<OpItemRef | null> {
  const vaultId = opVaultId()
  if (!vaultId) return null
  const client = await getSdkClient(opts)
  const title = opItemTitle(input.userId, input.persona, input.origin)
  const fields = [
    ...(input.username
      ? [{ id: 'username', title: 'username', fieldType: 'Text', value: input.username }]
      : []),
    { id: 'password', title: 'password', fieldType: 'Concealed', value: input.password },
  ]

  try {
    const overviews = (await client.items.list(vaultId)) as Array<{ id?: string; title?: string }>
    const existing = overviews.find((it) => it.title === title && it.id)
    if (existing?.id) {
      const item = (await client.items.get(vaultId, existing.id)) as Record<string, unknown>
      await client.items.put({ ...item, fields })
      return `${OP_REF_PREFIX}${vaultId}:${existing.id}`
    }
    const created = (await client.items.create({
      category: 'Login',
      vaultId,
      title,
      fields,
      websites: [{ url: input.origin, label: 'website' }],
    })) as { id?: string }
    return created.id ? `${OP_REF_PREFIX}${vaultId}:${created.id}` : null
  } catch {
    return null
  }
}

async function sdkGetItemFields(ref: OpItemRef, opts?: OpClientOpts): Promise<OpFields | null> {
  const vaultId = opVaultId()
  if (!vaultId) return null
  const client = await getSdkClient(opts)
  const itemId = ref.split(':')[2]!
  try {
    const item = (await client.items.get(vaultId, itemId)) as {
      fields?: Array<{ title?: string; fieldType?: string; value?: string }>
    }
    const out: OpFields = {}
    for (const f of item.fields || []) {
      if (f.title === 'username' && typeof f.value === 'string') out.username = f.value
      if (f.title === 'password' && typeof f.value === 'string') out.password = f.value
    }
    return out.password ? out : null
  } catch {
    return null
  }
}

/* --------------------------- Connect (self-hosted) ----------------------- */

function opFetch(opts?: OpClientOpts): typeof fetch {
  return opts?.fetchFn ?? fetch
}

function opHeaders(): HeadersInit {
  return {
    authorization: `Bearer ${process.env.OP_CONNECT_TOKEN?.trim()}`,
    'content-type': 'application/json',
    accept: 'application/json',
  }
}

function opHost(): string {
  return (process.env.OP_CONNECT_HOST?.trim() || '').replace(/\/+$/, '')
}

type OpItem = {
  id?: string
  title?: string
  fields?: Array<{ label?: string; type?: string; value?: string }>
}

async function connectSaveItem(
  input: { userId: string; persona: string; origin: string; username?: string; password: string },
  opts?: OpClientOpts,
): Promise<OpItemRef | null> {
  const title = opItemTitle(input.userId, input.persona, input.origin)
  const fields = [
    ...(input.username ? [{ label: 'username', type: 'STRING', value: input.username }] : []),
    { label: 'password', type: 'CONCEALED', value: input.password },
  ]

  try {
    const existing = await connectFindItemByTitle(title, opts)
    if (existing?.id) {
      const res = await opFetch(opts)(`${opHost()}/v1/vaults/${opVaultId()}/items/${existing.id}`, {
        method: 'PUT',
        headers: opHeaders(),
        body: JSON.stringify({ ...existing, fields }),
        signal: AbortSignal.timeout(10_000),
      })
      if (!res.ok) return null
      const item = (await res.json()) as OpItem
      return item.id ? `${OP_REF_PREFIX}${opVaultId()}:${item.id}` : null
    }
    const res = await opFetch(opts)(`${opHost()}/v1/vaults/${opVaultId()}/items`, {
      method: 'POST',
      headers: opHeaders(),
      body: JSON.stringify({
        title,
        vault: { id: opVaultId() },
        category: 'LOGIN',
        fields,
      }),
      signal: AbortSignal.timeout(10_000),
    })
    if (!res.ok) return null
    const item = (await res.json()) as OpItem
    return item.id ? `${OP_REF_PREFIX}${opVaultId()}:${item.id}` : null
  } catch {
    return null
  }
}

async function connectGetItemFields(ref: OpItemRef, opts?: OpClientOpts): Promise<OpFields | null> {
  const [, vaultId, itemId] = ref.split(':')
  try {
    const res = await opFetch(opts)(`${opHost()}/v1/vaults/${vaultId}/items/${itemId}`, {
      headers: opHeaders(),
      signal: AbortSignal.timeout(10_000),
    })
    if (!res.ok) return null
    const item = (await res.json()) as OpItem
    const out: OpFields = {}
    for (const f of item.fields || []) {
      if (f.label === 'username' && typeof f.value === 'string') out.username = f.value
      if (f.label === 'password' && typeof f.value === 'string') out.password = f.value
    }
    return out.password ? out : null
  } catch {
    return null
  }
}

async function connectFindItemByTitle(title: string, opts?: OpClientOpts): Promise<OpItem | null> {
  const res = await opFetch(opts)(`${opHost()}/v1/vaults/${opVaultId()}/items`, {
    headers: opHeaders(),
    signal: AbortSignal.timeout(10_000),
  })
  if (!res.ok) return null
  const list = (await res.json()) as Array<OpItem>
  return list.find((it) => it.title === title) ?? null
}

/* ------------------------------ public API -------------------------------- */

/** Save (create or update) a LOGIN item; returns the opaque reference. */
export async function opSaveItem(
  input: { userId: string; persona: string; origin: string; username?: string; password: string },
  opts?: OpClientOpts,
): Promise<OpItemRef | null> {
  const mode = opMode()
  if (mode === 'sdk') return sdkSaveItem(input, opts)
  if (mode === 'connect') return connectSaveItem(input, opts)
  return null
}

/** Read the username/password fields back out of a stored reference. */
export async function opGetItemFields(ref: OpItemRef, opts?: OpClientOpts): Promise<OpFields | null> {
  if (!onePasswordConfigured() || !isOpRef(ref)) return null
  const mode = opMode()
  if (mode === 'sdk') return sdkGetItemFields(ref, opts)
  return connectGetItemFields(ref, opts)
}
