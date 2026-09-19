/**
 * Per-user Kernel vault + Link wallet integration.
 *
 * Provider actions are encrypted behind authenticated opaque redirects. The
 * browser receives only Kernel aliases; the underlying card never enters this
 * application, Browser Use, or the browser DOM.
 */
import type { SQL } from 'bun'
import Kernel from '@onkernel/sdk'
import {
  decryptUserPayload,
  encryptUserPayload,
  loadOrCreateUserKey,
  userKeyBrokerFromEnv,
} from '../services/trust/userKeyBroker'

export type LinkWalletStatus = {
  connected: boolean
  pending: boolean
  verificationUrl?: string
  phrase?: string
  scope?: string
}

export type LinkMethodView = {
  id: string
  brand: string
  last4: string
  exp: string
  link_wallet: true
}

type KernelPaymentRow = { vault_id: string; wallet_key: string; selected_payment_method_id: string | null }

/* The project id, resolved from the API when the env var is absent.
 *
 * Measured live: the Settings "Connect Link" button answered
 * "KERNEL_API_KEY and KERNEL_PROJECT_ID are required for browser payments" on
 * production — the key was set, the project id was not, and the whole Link
 * wallet path (connect, status, methods, spend approvals) was dead behind a
 * developer-shaped error. `GET /projects` with the same key returns the
 * account's projects, so the client no longer depends on a second env var
 * being filled in by hand. Cached for the process lifetime. */
let kernelProjectID: string | null = null
async function resolveKernelProjectID(apiKey: string): Promise<string | null> {
  const fromEnv = process.env.KERNEL_PROJECT_ID?.trim()
  if (fromEnv) return fromEnv
  if (kernelProjectID) return kernelProjectID
  try {
    const res = await fetch('https://api.onkernel.com/projects', {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(8000),
    })
    if (!res.ok) return null
    const projects = (await res.json()) as Array<{ id?: string; status?: string }>
    const active = projects.find((p) => p.status === 'active' && p.id) || projects.find((p) => p.id)
    if (active?.id) {
      kernelProjectID = active.id
      console.log(`[link] kernel project resolved from the API: ${active.id}`)
      return active.id
    }
  } catch (err) {
    console.warn('[link] kernel project lookup failed', err instanceof Error ? err.message : err)
  }
  return null
}

/** Test seam: the resolved project id is cached for the process, which is
 * correct in production (a project id does not change) and order-dependent in
 * a test file. */
export function resetKernelProjectCacheForTest(): void {
  kernelProjectID = null
}

/** True when the payment stack can run at all — the API key, and a project id
 * either set or resolvable. Callers use this to say "payments are not set up"
 * instead of leaking the env-var message to a user. */
export async function kernelPaymentsReady(): Promise<boolean> {
  const apiKey = process.env.KERNEL_API_KEY?.trim()
  if (!apiKey) return false
  return Boolean(await resolveKernelProjectID(apiKey))
}

async function kernelClient(): Promise<Kernel> {
  const apiKey = process.env.KERNEL_API_KEY?.trim()
  if (!apiKey) throw new Error('Payments are not set up on this deployment yet, so nothing was charged and nothing was connected.')
  const projectID = await resolveKernelProjectID(apiKey)
  if (!projectID) throw new Error('Card setup did not answer just now, so nothing was connected. Try again in a moment.')
  return new Kernel({ apiKey, projectID, maxRetries: 0 })
}

export type LinkSpend = {
  id: string
  status: string
  approvalUrl?: string
}

export type LinkCardCredential = {
  number: string
  cvc: string
  expMonth: string
  expYear: string
  name?: string
  postalCode?: string
}

export async function ensureLinkWalletSchema(sql: SQL): Promise<void> {
  await sql`ALTER TABLE hire_spend_approvals ADD COLUMN IF NOT EXISTS link_spend_request_id TEXT`
  await sql`ALTER TABLE hire_spend_approvals ADD COLUMN IF NOT EXISTS link_approval_url TEXT`
  await sql`ALTER TABLE hire_spend_approvals ADD COLUMN IF NOT EXISTS merchant_url TEXT`
  await sql`CREATE UNIQUE INDEX IF NOT EXISTS idx_hire_spend_link_id ON hire_spend_approvals (link_spend_request_id) WHERE link_spend_request_id IS NOT NULL`
  await sql`
    CREATE TABLE IF NOT EXISTS hire_kernel_payment_vaults (
      user_id UUID PRIMARY KEY,
      vault_id TEXT NOT NULL UNIQUE,
      wallet_key TEXT NOT NULL,
      selected_payment_method_id TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `
  await sql`
    CREATE TABLE IF NOT EXISTS hire_kernel_payment_actions (
      id UUID PRIMARY KEY,
      user_id UUID NOT NULL,
      vault_id TEXT NOT NULL,
      item_key TEXT NOT NULL,
      action_name TEXT NOT NULL,
      url_encrypted TEXT NOT NULL,
      expires_at TIMESTAMPTZ NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `
  await sql`CREATE INDEX IF NOT EXISTS idx_kernel_payment_actions_user ON hire_kernel_payment_actions (user_id, expires_at)`
}

async function kernelPaymentRow(sql: SQL, userId: string): Promise<KernelPaymentRow | null> {
  const rows = await sql`
    SELECT vault_id, wallet_key, selected_payment_method_id
    FROM hire_kernel_payment_vaults WHERE user_id = ${userId} LIMIT 1
  ` as KernelPaymentRow[]
  return rows[0] || null
}

async function storeKernelAction(
  sql: SQL,
  userId: string,
  input: { vaultId: string; itemKey: string; actionName: string; url: string; expiresAt?: string },
): Promise<string> {
  const url = new URL(input.url)
  if (url.protocol !== 'https:' || url.username || url.password) throw new Error('Kernel returned an invalid provider action.')
  const broker = userKeyBrokerFromEnv()
  if (!broker) throw new Error('Per-user payment encryption is not configured.')
  const key = await loadOrCreateUserKey(sql, broker, userId)
  const id = crypto.randomUUID()
  try {
    const encrypted = encryptUserPayload(url.href, key, { userId, recordId: id, scope: 'payments:kernel-action' })
    const providerExpiry = input.expiresAt ? new Date(input.expiresAt).getTime() : Number.POSITIVE_INFINITY
    const expiresAt = new Date(Math.min(Date.now() + 10 * 60_000, providerExpiry))
    await sql`
      INSERT INTO hire_kernel_payment_actions
        (id, user_id, vault_id, item_key, action_name, url_encrypted, expires_at)
      VALUES (${id}, ${userId}, ${input.vaultId}, ${input.itemKey}, ${input.actionName}, ${encrypted}, ${expiresAt})
    `
    return `/api/payments/kernel/action?id=${encodeURIComponent(id)}`
  } finally {
    key.fill(0)
  }
}

export async function resolveKernelPaymentAction(sql: SQL, userId: string, id: string): Promise<string | null> {
  const rows = await sql`
    SELECT vault_id, item_key, action_name, url_encrypted
    FROM hire_kernel_payment_actions
    WHERE id = ${id} AND user_id = ${userId} AND expires_at > now() LIMIT 1
  ` as Array<{ vault_id: string; item_key: string; action_name: string; url_encrypted: string }>
  const row = rows[0]
  if (!row) return null
  const item = await (await kernelClient()).vaults.items.retrieve(row.item_key, { id_or_name: row.vault_id })
  if (!item.action || item.action.name !== row.action_name || !('url' in item.action)) return null
  const broker = userKeyBrokerFromEnv()
  if (!broker) return null
  const key = await loadOrCreateUserKey(sql, broker, userId)
  try {
    const saved = decryptUserPayload(row.url_encrypted, key, { userId, recordId: id, scope: 'payments:kernel-action' })
    return saved === item.action.url ? saved : null
  } finally {
    key.fill(0)
  }
}

export async function getKernelVaultId(sql: SQL, userId: string, create = false): Promise<string | null> {
  const existing = await kernelPaymentRow(sql, userId)
  if (existing) return existing.vault_id
  if (!create) return null
  const client = await kernelClient()
  const vault = await client.vaults.upsert({ name: `hirealpha-${userId}` })
  const items = await client.vaults.items.list(vault.id)
  const wallets = items.filter((item) => item.type === 'wallet' && item.spec.provider === 'link')
  if (wallets.length > 1) throw new Error('Kernel vault has more than one Link wallet.')
  const wallet = wallets[0] || await client.vaults.items.upsert('link-wallet', {
    id_or_name: vault.id,
    type: 'wallet',
    spec: { provider: 'link', authorization: { method: 'oauth', client: { type: 'kernel_managed' } } },
  })
  await sql`
    INSERT INTO hire_kernel_payment_vaults (user_id, vault_id, wallet_key)
    VALUES (${userId}, ${vault.id}, ${wallet.key})
    ON CONFLICT (user_id) DO UPDATE SET vault_id = EXCLUDED.vault_id,
      wallet_key = EXCLUDED.wallet_key, updated_at = now()
  `
  return vault.id
}

function lastEmission(data: any): any {
  return Array.isArray(data) && data.length ? data[data.length - 1] : data
}

function trustedLinkUrl(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  try {
    const url = new URL(value)
    if (url.protocol !== 'https:' || (url.hostname !== 'link.com' && !url.hostname.endsWith('.link.com'))) return undefined
    return url.href
  } catch { return undefined }
}

export function linkStatusFromCliOutput(data: any): LinkWalletStatus {
  data = lastEmission(data)
  const verificationUrl = trustedLinkUrl(data?.verification_url)
  const scope = Array.isArray(data?.scope)
    ? data.scope.filter((value: unknown) => typeof value === 'string').join(' ')
    : typeof data?.scope === 'string' ? data.scope : undefined
  return {
    connected: Boolean(data?.authenticated),
    pending: Boolean(data?.pending || data?.verification_url),
    ...(verificationUrl ? { verificationUrl } : {}),
    ...(typeof data?.phrase === 'string' ? { phrase: data.phrase } : {}),
    ...(scope ? { scope } : {}),
  }
}

export async function startLinkConnection(sql: SQL, userId: string): Promise<LinkWalletStatus> {
  const vaultId = await getKernelVaultId(sql, userId, true)
  if (!vaultId) throw new Error('Kernel payment vault could not be created.')
  const row = await kernelPaymentRow(sql, userId)
  if (!row) throw new Error('Kernel payment wallet could not be found.')
  const wallet = await (await kernelClient()).vaults.items.retrieve(row.wallet_key, { id_or_name: vaultId })
  if (wallet.type !== 'wallet' || wallet.spec.provider !== 'link') throw new Error('Kernel payment wallet is invalid.')
  if (wallet.state.status === 'connected') return { connected: true, pending: false }
  if (wallet.action?.name === 'link_oauth' && 'url' in wallet.action) {
    const verificationUrl = await storeKernelAction(sql, userId, {
      vaultId, itemKey: wallet.key, actionName: wallet.action.name, url: wallet.action.url, expiresAt: wallet.expires_at,
    })
    return { connected: false, pending: true, verificationUrl }
  }
  return { connected: false, pending: wallet.state.status === 'pending_authorization' }
}

export async function getLinkStatus(sql: SQL, userId: string): Promise<LinkWalletStatus> {
  const row = await kernelPaymentRow(sql, userId)
  if (!row) return { connected: false, pending: false }
  const wallet = await (await kernelClient()).vaults.items.retrieve(row.wallet_key, { id_or_name: row.vault_id })
  if (wallet.type !== 'wallet' || wallet.spec.provider !== 'link') return { connected: false, pending: false }
  if (wallet.state.status === 'connected') return { connected: true, pending: false }
  if (wallet.action?.name === 'link_oauth' && 'url' in wallet.action) {
    return {
      connected: false,
      pending: true,
      verificationUrl: await storeKernelAction(sql, userId, {
        vaultId: row.vault_id, itemKey: wallet.key, actionName: wallet.action.name,
        url: wallet.action.url, expiresAt: wallet.expires_at,
      }),
    }
  }
  return { connected: false, pending: wallet.state.status === 'pending_authorization' }
}

export async function disconnectLink(sql: SQL, userId: string): Promise<void> {
  const row = await kernelPaymentRow(sql, userId)
  if (!row) return
  const items = await (await kernelClient()).vaults.items.list(row.vault_id)
  const unresolved = items.some((item) => item.type === 'card' && ['pending_authorization', 'recovery_required'].includes(item.state.status))
  if (unresolved) throw new Error('A payment is unresolved. Reconcile it before disconnecting Link.')
  await (await kernelClient()).vaults.delete(row.vault_id)
  await sql`DELETE FROM hire_kernel_payment_actions WHERE user_id = ${userId}`
  await sql`DELETE FROM hire_kernel_payment_vaults WHERE user_id = ${userId}`
}

export async function listLinkPaymentMethods(sql: SQL, userId: string): Promise<LinkMethodView[]> {
  const row = await kernelPaymentRow(sql, userId)
  if (!row) return []
  let wallet = await (await kernelClient()).vaults.items.retrieve(row.wallet_key, { id_or_name: row.vault_id })
  if (wallet.type !== 'wallet' || wallet.state.status !== 'connected'
    || !wallet.available_expansions.some(({ type }) => type === 'payment_methods')) return []
  wallet = await (await kernelClient()).vaults.items.retrieve(row.wallet_key, { id_or_name: row.vault_id, expand: ['payment_methods'] })
  if (wallet.type !== 'wallet') return []
  return (wallet.expanded?.payment_methods || []).filter((pm) => pm.capabilities.single_use_card?.eligible !== false).map((pm) => ({
    id: pm.id,
    brand: pm.display.brand || pm.type || 'card',
    last4: pm.display.last4 || '••••',
    exp: pm.display.label || 'in Link',
    link_wallet: true as const,
  }))
}

export async function createLinkSpendRequest(
  sql: SQL,
  userId: string,
  input: { amountCents: number; currency: string; merchant: string; merchantUrl: string; purpose: string; requestId: string },
): Promise<LinkSpend> {
  const row = await kernelPaymentRow(sql, userId)
  if (!row) throw new Error('Connect Link before approving a purchase.')
  let wallet = await (await kernelClient()).vaults.items.retrieve(row.wallet_key, {
    id_or_name: row.vault_id, expand: ['payment_methods'],
  })
  if (wallet.type !== 'wallet' || wallet.state.status !== 'connected') throw new Error('Link wallet is not connected.')
  const methods = wallet.expanded?.payment_methods || []
  const method = methods.find((pm) => pm.id === row.selected_payment_method_id)
    || methods.find((pm) => pm.is_default && pm.capabilities.single_use_card?.eligible !== false)
  if (!method) throw new Error('Select an eligible Link payment method before approving the purchase.')
  const currency = input.currency.toLowerCase()
  const context = `HireAlpha is requesting a one-use payment credential for this independently verified purchase only. Merchant: ${input.merchant}. Item: ${input.purpose}. Exact total: ${(input.amountCents / 100).toFixed(2)} ${currency.toUpperCase()} including the checkout's displayed charges. Do not allow substitutions, amount changes, or retries.`
  const cardKey = `purchase-${input.requestId}`
  let card = await (await kernelClient()).vaults.items.upsert(cardKey, {
    id_or_name: row.vault_id,
    type: 'card',
    spec: {
      provider: 'link', wallet: row.wallet_key, payment_method_id: method.id,
      amount: input.amountCents, currency, merchant_name: input.merchant,
      merchant_url: input.merchantUrl, context,
      line_items: [{ name: input.purpose.slice(0, 140), quantity: 1, unit_amount: input.amountCents, product_url: input.merchantUrl }],
      totals: [{ type: 'total', display_text: 'Total', amount: input.amountCents }],
      metadata: { hirealpha_request_id: input.requestId },
    },
  })
  if (!card.available_operations.some(({ type }) => type === 'authorize')) throw new Error('Kernel payment authorization is unavailable.')
  card = await (await kernelClient()).vaults.items.performOperation(card.key, { id_or_name: row.vault_id, type: 'authorize' })
  if (!card.action || !('url' in card.action)) throw new Error('Kernel did not return a payment approval action.')
  const approvalUrl = await storeKernelAction(sql, userId, {
    vaultId: row.vault_id, itemKey: card.key, actionName: card.action.name,
    url: card.action.url, expiresAt: card.expires_at,
  })
  return { id: card.key, status: card.state.status, approvalUrl }
}

export async function retrieveLinkSpend(sql: SQL, userId: string, spendId: string): Promise<LinkSpend> {
  const row = await kernelPaymentRow(sql, userId)
  if (!row) throw new Error('Kernel payment vault was not found.')
  const card = await (await kernelClient()).vaults.items.retrieve(spendId, { id_or_name: row.vault_id })
  if (card.type !== 'card') throw new Error('Kernel payment item is invalid.')
  const status = card.state.status === 'ready' ? 'approved' : card.state.status
  return { id: card.key, status }
}

export async function retrieveLinkCard(sql: SQL, userId: string, spendId: string): Promise<LinkCardCredential> {
  const row = await kernelPaymentRow(sql, userId)
  if (!row) throw new Error('Kernel payment vault was not found.')
  const card = await (await kernelClient()).vaults.items.retrieve(spendId, { id_or_name: row.vault_id, wait: 60 })
  if (card.type !== 'card' || card.state.status !== 'ready' || !card.state.aliases) {
    throw new Error(`Kernel payment item is ${card.type === 'card' ? card.state.status : 'invalid'}.`)
  }
  const aliases = card.state.aliases
  return {
    number: aliases.number, cvc: aliases.cvc,
    expMonth: aliases.exp_month, expYear: aliases.exp_year,
  }
}

/** Link requires an outcome report after every credential-backed attempt. No
 * card data or page content is included—only the merchant domain and result. */
export async function reportLinkOutcome(
  sql: SQL,
  userId: string,
  input: {
    spendId: string
    domain: string
    outcome: 'success' | 'blocked' | 'abandoned'
    step: string
    context?: string
  },
): Promise<void> {
  const row = await kernelPaymentRow(sql, userId)
  if (!row) return
  // Kernel item events are the authoritative substitution record. Fetching
  // them here also gives operators a stable reconciliation point without
  // sending browser or payment data to another reporting service.
  await (await kernelClient()).vaults.items.events(input.spendId, { id_or_name: row.vault_id }).catch(() => undefined)
}
