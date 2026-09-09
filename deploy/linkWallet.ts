/**
 * Per-user Link wallet sessions.
 *
 * The Link CLI auth document is encrypted at rest and materialized as a 0600
 * temporary file only for the duration of one CLI call. A user's document is
 * never shared with another user and full card credentials are returned only
 * to the browser worker, in memory, after a one-time spend approval.
 */
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { tmpdir } from 'node:os'
import type { SQL } from 'bun'
import { decryptSecret, encryptSecret, vaultKey } from './vaultCrypto'

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

type WalletRow = { auth_encrypted: string; status: string }
const walletLocks = new Map<string, Promise<unknown>>()

export async function ensureLinkWalletSchema(sql: SQL): Promise<void> {
  await sql`
    CREATE TABLE IF NOT EXISTS hire_link_wallets (
      user_id UUID PRIMARY KEY,
      auth_encrypted TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `
  await sql`ALTER TABLE hire_spend_approvals ADD COLUMN IF NOT EXISTS link_spend_request_id TEXT`
  await sql`ALTER TABLE hire_spend_approvals ADD COLUMN IF NOT EXISTS link_approval_url TEXT`
  await sql`ALTER TABLE hire_spend_approvals ADD COLUMN IF NOT EXISTS merchant_url TEXT`
  await sql`CREATE UNIQUE INDEX IF NOT EXISTS idx_hire_spend_link_id ON hire_spend_approvals (link_spend_request_id) WHERE link_spend_request_id IS NOT NULL`
}

function parseCliJson(stdout: string): any {
  const trimmed = stdout.trim()
  if (!trimmed) throw new Error('Link returned an empty response.')
  try { return JSON.parse(trimmed) } catch {}
  const lines = trimmed.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
  for (let i = lines.length - 1; i >= 0; i--) {
    try { return JSON.parse(lines[i]!) } catch {}
  }
  throw new Error('Link returned an unreadable response.')
}

function lastEmission(data: any): any {
  return Array.isArray(data) && data.length ? data[data.length - 1] : data
}

async function runCli(authPath: string, args: string[], timeoutMs = 25_000): Promise<any> {
  // Keep Link's Ink/React dependency tree isolated from the web app. Production
  // installs this executable under /opt; local development may use a global
  // CLI, but --auth always points at the per-user temporary document above.
  const isolatedCli = '/opt/hirealpha-link/node_modules/.bin/link-cli'
  const cli = process.env.LINK_CLI_BIN?.trim() || (existsSync(isolatedCli) ? isolatedCli : 'link-cli')
  const proc = Bun.spawn([cli, '--auth', authPath, '--format', 'json', ...args], {
    stdout: 'pipe',
    stderr: 'pipe',
    env: { ...process.env, NO_COLOR: '1' },
  })
  const timer = setTimeout(() => proc.kill(), timeoutMs)
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]).finally(() => clearTimeout(timer))
  if (exitCode !== 0) {
    let message = 'Link request failed.'
    try {
      const parsed = lastEmission(parseCliJson(stdout || stderr))
      message = String(parsed?.error?.message || parsed?.message || message)
    } catch {}
    throw new Error(message.slice(0, 300))
  }
  return parseCliJson(stdout)
}

async function walletRow(sql: SQL, userId: string): Promise<WalletRow | null> {
  const rows = (await sql`
    SELECT auth_encrypted, status FROM hire_link_wallets WHERE user_id = ${userId} LIMIT 1
  `) as WalletRow[]
  return rows[0] || null
}

async function withUserAuthUnlocked<T>(sql: SQL, userId: string, create: boolean, fn: (path: string) => Promise<T>): Promise<T> {
  const key = vaultKey()
  if (!key) throw new Error('Wallet encryption is not configured on this server.')
  const row = await walletRow(sql, userId)
  if (!row && !create) throw new Error('Link wallet is not connected.')
  const existing = row ? decryptSecret(row.auth_encrypted, key) : null
  if (row && existing === null) throw new Error('This Link connection cannot be decrypted. Reconnect it in Settings.')

  const dir = await mkdtemp(resolve(tmpdir(), 'hirealpha-link-'))
  const path = resolve(dir, 'auth.json')
  try {
    await writeFile(path, existing || JSON.stringify({ auth: null, pendingDeviceAuth: null }), { mode: 0o600 })
    await chmod(path, 0o600)
    const result = await fn(path)
    const updated = await readFile(path, 'utf8')
    const encrypted = encryptSecret(updated, key)
    const connected = Boolean(lastEmission(result)?.authenticated) || row?.status === 'connected'
    if (row) {
      // Optimistic fence: a concurrent disconnect/delete must win and must not
      // be undone by an in-flight status poll or credential retrieval.
      await sql`
        UPDATE hire_link_wallets SET auth_encrypted = ${encrypted},
          status = ${connected ? 'connected' : 'pending'}, updated_at = now()
        WHERE user_id = ${userId} AND auth_encrypted = ${row.auth_encrypted}
      `
    } else {
      await sql`
        INSERT INTO hire_link_wallets (user_id, auth_encrypted, status, updated_at)
        VALUES (${userId}, ${encrypted}, ${connected ? 'connected' : 'pending'}, now())
        ON CONFLICT (user_id) DO NOTHING
      `
    }
    return result
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

async function withUserAuth<T>(sql: SQL, userId: string, create: boolean, fn: (path: string) => Promise<T>): Promise<T> {
  const previous = walletLocks.get(userId) ?? Promise.resolve()
  const run = previous.then(
    () => withUserAuthUnlocked(sql, userId, create, fn),
    () => withUserAuthUnlocked(sql, userId, create, fn),
  )
  const tail = run.catch(() => undefined)
  walletLocks.set(userId, tail)
  try { return await run }
  finally { if (walletLocks.get(userId) === tail) walletLocks.delete(userId) }
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
  const existing = await getLinkStatus(sql, userId).catch(() => null)
  const requiredScopes = ['userinfo:read', 'payment_methods.agentic']
  const currentScopes = new Set((existing?.scope || '').split(/\s+/).filter(Boolean))
  if (existing?.connected && requiredScopes.every((scope) => currentScopes.has(scope))) return existing
  if (existing?.pending) return existing
  if (existing?.connected) {
    const result = await withUserAuth(sql, userId, false, (path) => runCli(path, [
      'auth', 'upgrade', '--client-name', 'HireAlpha', '--scope', requiredScopes.join(' '), '--interval', '0',
    ]))
    return linkStatusFromCliOutput(result)
  }
  const result = await withUserAuth(sql, userId, true, (path) => runCli(path, [
    'auth', 'login', '--client-name', 'HireAlpha', '--scope', requiredScopes.join(' '), '--interval', '0',
  ]))
  return linkStatusFromCliOutput(result)
}

export async function getLinkStatus(sql: SQL, userId: string): Promise<LinkWalletStatus> {
  const row = await walletRow(sql, userId)
  if (!row) return { connected: false, pending: false }
  const result = await withUserAuth(sql, userId, false, (path) => runCli(path, [
    'auth', 'status', '--interval', '0', '--max-attempts', '1',
  ]))
  return linkStatusFromCliOutput(result)
}

export async function disconnectLink(sql: SQL, userId: string): Promise<void> {
  const row = await walletRow(sql, userId)
  if (!row) return
  await withUserAuth(sql, userId, false, (path) => runCli(path, ['auth', 'logout'])).catch(() => undefined)
  await sql`DELETE FROM hire_link_wallets WHERE user_id = ${userId}`
}

export async function listLinkPaymentMethods(sql: SQL, userId: string): Promise<LinkMethodView[]> {
  const data = await withUserAuth(sql, userId, false, (path) => runCli(path, ['payment-methods', 'list']))
  const items = Array.isArray(data) ? data : Array.isArray(data?.data) ? data.data : []
  return items.map((pm: any) => ({
    id: String(pm.id || ''),
    brand: String(pm.card_brand || pm.brand || pm.type || 'card'),
    last4: String(pm.card_last4 || pm.last4 || '••••'),
    exp: pm.exp_month && pm.exp_year ? `${pm.exp_month}/${String(pm.exp_year).slice(-2)}` : 'in Link',
    link_wallet: true as const,
  })).filter((pm: LinkMethodView) => pm.id)
}

export async function createLinkSpendRequest(
  sql: SQL,
  userId: string,
  input: { amountCents: number; merchant: string; merchantUrl: string; purpose: string; requestId: string },
): Promise<LinkSpend> {
  const context = `HireAlpha found the requested item and is asking permission to use a one-time Link card for this exact purchase. Merchant: ${input.merchant}. Item: ${input.purpose}. Total: $${(input.amountCents / 100).toFixed(2)}. No substitutions or total changes are allowed.`
  const line = `name:${input.purpose.replace(/[,\r\n]/g, ' ').slice(0, 140)},unit_amount:${input.amountCents},quantity:1,product_url:${input.merchantUrl}`
  const total = `type:total,display_text:Total,amount:${input.amountCents}`
  const raw = await withUserAuth(sql, userId, false, (path) => runCli(path, [
    'spend-request', 'create', '--credential-type', 'card', '--amount', String(input.amountCents),
    '--currency', 'usd', '--merchant-name', input.merchant, '--merchant-url', input.merchantUrl,
    '--context', context, '--line-item', line, '--total', total, '--request-approval',
    '--metadata', `hirealpha_request_id:${input.requestId}`,
  ]))
  const data = lastEmission(raw)
  return { id: String(data.id || ''), status: String(data.status || ''), approvalUrl: trustedLinkUrl(data.approval_url) }
}

export async function retrieveLinkSpend(sql: SQL, userId: string, spendId: string): Promise<LinkSpend> {
  const raw = await withUserAuth(sql, userId, false, (path) => runCli(path, [
    'spend-request', 'retrieve', spendId, '--interval', '0', '--max-attempts', '1',
  ]))
  const data = lastEmission(raw)
  return { id: String(data.id || spendId), status: String(data.status || ''), approvalUrl: trustedLinkUrl(data.approval_url) }
}

export async function retrieveLinkCard(sql: SQL, userId: string, spendId: string): Promise<LinkCardCredential> {
  return withUserAuth(sql, userId, false, async (path) => {
    const dir = await mkdtemp(resolve(tmpdir(), 'hirealpha-card-'))
    const output = resolve(dir, 'credential.json')
    try {
      await runCli(path, ['spend-request', 'retrieve', spendId, '--include', 'card', '--output-file', output, '--force', '--interval', '0'])
      const credential = JSON.parse(await readFile(output, 'utf8')) as any
      const card = credential.card || {}
      const result = {
        number: String(card.number || ''), cvc: String(card.cvc || ''),
        expMonth: String(card.exp_month || ''), expYear: String(card.exp_year || ''),
        name: card.billing_address?.name ? String(card.billing_address.name) : card.name ? String(card.name) : undefined,
        postalCode: card.billing_address?.postal_code ? String(card.billing_address.postal_code) : undefined,
      }
      if (!/^\d{12,19}$/.test(result.number) || !/^\d{3,4}$/.test(result.cvc)) throw new Error('Link did not return an approved card credential.')
      return result
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
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
  const domain = input.domain.trim().toLowerCase().replace(/^www\./, '').slice(0, 253)
  if (!domain || !input.spendId.startsWith('lsrq_')) return
  await withUserAuth(sql, userId, false, (path) => runCli(path, [
    'report', '--domain', domain, '--outcome', input.outcome,
    '--spend-request-id', input.spendId, '--step', input.step.slice(0, 100),
    ...(input.context ? ['--freeform-context', input.context.slice(0, 500)] : []),
  ]))
}
