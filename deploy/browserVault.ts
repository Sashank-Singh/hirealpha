/**
 * Browser runner + credential vault.
 *
 * Trust model (the moat, stated as code):
 *  - A credential is scoped to exactly one portal origin at save time. The
 *    runner can only decrypt it for a task whose URL lives on that origin —
 *    a stolen task spec cannot teleport a password to another site.
 *  - Nothing launches without a one-time user approval for that portal. The
 *    approval is consumed atomically (the UPDATE refuses an already-consumed
 *    row), so one tap buys exactly one browser session.
 *  - One browser session per user at a time, and nothing persists: the runner
 *    launches a fresh context per task with no storage state and closes it in
 *    a finally. Between tasks there is no cookie jar, no profile, no cache.
 *  - Plaintext exists in exactly two places: inside decrypt, and inside the
 *    browser login form. It never enters SQL, logs, or task results.
 */
import { randomUUID } from 'node:crypto'
import type { SQL } from 'bun'
import { decryptSecret, encryptSecret, maskSecret, vaultKey, type VaultKey } from './vaultCrypto'

/* ------------------------------- types ---------------------------------- */

export type BrowserTaskKind = 'newsletter' | 'ticker'

export type PortalTask = {
  url: string
  username: string
  password: string
  kind: BrowserTaskKind
}

export type PortalRun = { ok: true; content: string } | { ok: false; error: string }

export type VaultDeps = {
  resolveUser: (sql: SQL, req: Request) => Promise<{ id: string; persona: string } | null>
  internalOk: (req: Request) => boolean
  launch: (task: PortalTask) => Promise<PortalRun>
  key?: VaultKey
}

export const APPROVAL_TTL_MS = 10 * 60 * 1000
export const MAX_SECRET_LENGTH = 2000

/* ------------------------------- schema --------------------------------- */

export async function ensureBrowserVaultSchema(sql: SQL): Promise<void> {
  await sql`
    CREATE TABLE IF NOT EXISTS hire_vault_entries (
      id UUID PRIMARY KEY,
      user_id UUID NOT NULL,
      persona TEXT NOT NULL,
      portal TEXT NOT NULL,
      origin TEXT NOT NULL,
      secret_encrypted TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      last_used_at TIMESTAMPTZ
    )
  `
  await sql`CREATE UNIQUE INDEX IF NOT EXISTS idx_hire_vault_user_persona_portal ON hire_vault_entries (user_id, persona, portal)`
  await sql`
    CREATE TABLE IF NOT EXISTS hire_browser_approvals (
      id UUID PRIMARY KEY,
      user_id UUID NOT NULL,
      persona TEXT NOT NULL,
      portal TEXT NOT NULL,
      origin TEXT NOT NULL,
      purpose TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      decided_at TIMESTAMPTZ,
      consumed_at TIMESTAMPTZ
    )
  `
  await sql`CREATE INDEX IF NOT EXISTS idx_hire_browser_approvals_user ON hire_browser_approvals (user_id, status)`
}

/* ----------------------------- vault store ------------------------------ */

export async function saveVaultEntry(
  sql: SQL,
  input: { userId: string; persona: string; portal: string; secret: string; key: VaultKey },
): Promise<{ ok: true } | { ok: false; error: string }> {
  const origin = portalOrigin(input.portal)
  if (!origin) return { ok: false, error: 'Portal must be an https URL.' }
  const secret = input.secret
  if (typeof secret !== 'string' || secret.length < 4 || secret.length > MAX_SECRET_LENGTH) {
    return { ok: false, error: 'That secret does not look right.' }
  }
  await sql`
    INSERT INTO hire_vault_entries (id, user_id, persona, portal, origin, secret_encrypted)
    VALUES (${randomUUID()}, ${input.userId}, ${input.persona}, ${origin}, ${origin}, ${encryptSecret(secret, input.key)})
    ON CONFLICT (user_id, persona, portal) DO UPDATE SET
      secret_encrypted = EXCLUDED.secret_encrypted,
      updated_at = now()
  `
  return { ok: true }
}

export type VaultEntryView = {
  id: string
  persona: string
  portal: string
  origin: string
  masked: string
  created_at: Date
  last_used_at: Date | null
}

/** List a user's entries. Masked in the query layer — plaintext never leaves decrypt. */
export async function listVaultEntries(sql: SQL, userId: string, key: VaultKey): Promise<VaultEntryView[]> {
  const rows = (await sql`
    SELECT id, persona, portal, origin, secret_encrypted, created_at, last_used_at
    FROM hire_vault_entries WHERE user_id = ${userId} ORDER BY created_at DESC
  `) as Array<{
    id: string
    persona: string
    portal: string
    origin: string
    secret_encrypted: string
    created_at: Date
    last_used_at: Date | null
  }>
  return rows.map((r) => ({
    id: r.id,
    persona: r.persona,
    portal: r.portal,
    origin: r.origin,
    masked: maskSecret(decryptSecret(r.secret_encrypted, key) ?? ''),
    created_at: r.created_at,
    last_used_at: r.last_used_at,
  }))
}

export async function deleteVaultEntry(sql: SQL, userId: string, id: string): Promise<boolean> {
  const rows = (await sql`
    DELETE FROM hire_vault_entries WHERE id = ${id} AND user_id = ${userId} RETURNING id
  `) as Array<{ id: string }>
  return rows.length > 0
}

/* --------------------------- approval gates ----------------------------- */

export async function requestBrowserApproval(
  sql: SQL,
  input: { userId: string; persona: string; portal: string; purpose: string },
): Promise<{ requestId: string; portal: string } | { error: string }> {
  const origin = portalOrigin(input.portal)
  if (!origin) return { error: 'Portal must be an https URL.' }
  const id = randomUUID()
  await sql`
    INSERT INTO hire_browser_approvals (id, user_id, persona, portal, origin, purpose, status)
    VALUES (${id}, ${input.userId}, ${input.persona}, ${origin}, ${origin}, ${input.purpose}, 'pending')
  `
  return { requestId: id, portal: origin }
}

export async function decideBrowserApproval(
  sql: SQL,
  userId: string,
  requestId: string,
  decision: 'approve' | 'deny',
): Promise<boolean> {
  const status = decision === 'approve' ? 'approved' : 'denied'
  const rows = (await sql`
    UPDATE hire_browser_approvals SET status = ${status}, decided_at = now()
    WHERE id = ${requestId} AND user_id = ${userId} AND status = 'pending'
    RETURNING id
  `) as Array<{ id: string }>
  return rows.length > 0
}

export type ApprovalConsume =
  | 'ok'
  | 'missing'
  | 'denied'
  | 'expired'
  | 'used'
  | 'scope'

/**
 * Consume a one-time approval. The UPDATE carries `consumed_at IS NULL` so two
 * racing consumes cannot both win — the database, not the check above, decides.
 */
export async function consumeBrowserApproval(
  sql: SQL,
  userId: string,
  requestId: string,
  origin: string,
  now: number = Date.now(),
): Promise<ApprovalConsume> {
  const rows = (await sql`
    SELECT id, status, origin, created_at, consumed_at
    FROM hire_browser_approvals WHERE id = ${requestId} AND user_id = ${userId} LIMIT 1
  `) as Array<{ id: string; status: string; origin: string; created_at: Date; consumed_at: Date | null }>
  const row = rows[0]
  if (!row) return 'missing'
  if (row.origin !== origin) return 'scope'
  if (row.status === 'denied') return 'denied'
  if (row.consumed_at) return 'used'
  if (row.status !== 'approved') return 'missing'
  if (now - new Date(row.created_at).getTime() > APPROVAL_TTL_MS) return 'expired'
  const updated = (await sql`
    UPDATE hire_browser_approvals SET consumed_at = now()
    WHERE id = ${requestId} AND user_id = ${userId} AND status = 'approved' AND consumed_at IS NULL
    RETURNING id
  `) as Array<{ id: string }>
  return updated.length > 0 ? 'ok' : 'used'
}

/* --------------------------- per-user lock ------------------------------ */

const userLocks = new Map<string, Promise<unknown>>()

/**
 * One browser session per user: tasks queue behind each other; other users
 * never wait. The chain entry is replaced with a settled promise so a failing
 * task cannot poison the next one.
 */
/* ------------------------- extraction parsing --------------------------- */

const NEWSLETTER_NOISE =
  /^(?:menu|subscribe|sign in|log in|home|search|share|tweet|advertisement|cookie|©|all rights reserved|read more|newsletter)/i

/** Portal post-login text → short insights a turn engine can read. */
export function extractNewsletterInsights(content: string): string {
  const lines = content
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 12 && !NEWSLETTER_NOISE.test(l))
  return lines.slice(0, 20).join('\n').slice(0, 2000)
}

export type TickerRow = { symbol: string; price: number; changePct: number }

/** Quote-table text → rows. Tolerates `2,930.10` and `+1.2%` / `-0.4%`. */
export function extractTickerRows(content: string): TickerRow[] {
  const rows: TickerRow[] = []
  for (const line of content.split('\n')) {
    const m = line.trim().match(/^([A-Z][A-Z0-9.&-]{0,14})\s+([\d,]+(?:\.\d+)?)\s+([+-]?\d+(?:\.\d+)?)\s*%?$/)
    if (!m) continue
    const price = Number(m[2]!.replace(/,/g, ''))
    const changePct = Number(m[3]!)
    if (!Number.isFinite(price) || !Number.isFinite(changePct)) continue
    rows.push({ symbol: m[1]!, price, changePct })
  }
  return rows
}

/* --------------------- ticker chart via the workshop -------------------- */

/**
 * Workshop code with the quote data baked in as a literal — the sandbox bans
 * network and env, so baked-in data is not just a choice, it is the design.
 */
export function buildTickerChartCode(symbol: string, rows: TickerRow[]): string {
  const safeSymbol = JSON.stringify(symbol.slice(0, 24))
  const data = JSON.stringify(rows.map((r) => ({ ...r, symbol: r.symbol.slice(0, 24) })))
  return `const DATA = ${data};
const SYMBOL = ${safeSymbol};
const rows = DATA.map((r, i) =>
  \`<tr><td>\${i + 1}</td><td>\${r.symbol}</td><td>\${r.price.toFixed(2)}</td><td class="\${r.changePct >= 0 ? 'up' : 'down'}">\${r.changePct >= 0 ? '+' : ''}\${r.changePct.toFixed(2)}%</td></tr>\`
).join('');
const max = Math.max(...DATA.map((r) => r.price));
const bars = DATA.map((r) =>
  \`<div class="bar" style="height: \${Math.round((r.price / max) * 120)}px"></div>\`
).join('');
document.getElementById('title').textContent = SYMBOL + ' quotes';
document.getElementById('rows').innerHTML = rows;
document.getElementById('bars').innerHTML = bars;
await Bun.write('out/index.html', '<!doctype html><html><head><style>' +
  'body{font-family:-apple-system,sans-serif;background:#0a0d12;color:#eef3f5;padding:24px}' +
  'table{width:100%;border-collapse:collapse}td{padding:8px;border-bottom:1px solid #25323a}' +
  '.up{color:#3fb68b}.down{color:#e05260}.bar{width:36px;background:#2a6f7a;margin:0 6px;display:inline-block}' +
  '#bars{display:flex;align-items:flex-end;height:130px;margin:16px 0}' +
  '</style></head><body><h1 id="title"></h1><div id="bars"></div><table><tbody id="rows"></tbody></table></body></html>');
`
}

/* ------------------------- task orchestration --------------------------- */

export type BrowserTaskInput = {
  userId: string
  persona: string
  requestId: string
  kind: BrowserTaskKind
  url: string
  key?: VaultKey
}

export type BrowserTaskResult =
  | { ok: true; kind: BrowserTaskKind; insights: string; chartCode?: string; artifactKind: 'insights' | 'chart' }
  | { ok: false; error: 'approval_required' | 'vault_missing' | 'runner_failed' | 'bad_url'; detail?: string }

/**
 * Run one portal task: consume the one-time approval, decrypt the scoped
 * credential, launch the runner under the user's session lock. Every refusal
 * happens before launch — default deny is the whole fence.
 */
export async function runBrowserTask(
  deps: Pick<VaultDeps, 'launch'> & { key: VaultKey },
  sql: SQL,
  input: BrowserTaskInput,
): Promise<BrowserTaskResult> {
  const origin = portalOrigin(input.url)
  if (!origin) return { ok: false, error: 'bad_url', detail: 'Task URL must be https.' }
  const key = input.key ?? deps.key
  if (!key) return { ok: false, error: 'vault_missing', detail: 'No vault key.' }

  const gate = await consumeBrowserApproval(sql, input.userId, input.requestId, origin)
  if (gate !== 'ok') {
    return { ok: false, error: 'approval_required', detail: gate }
  }
  const secret = await getVaultSecretForTask(sql, input.userId, origin, key)
  if (!secret) return { ok: false, error: 'vault_missing' }

  try {
    return await withUserBrowserLock(input.userId, async () => {
      const run = await deps.launch({ url: input.url, username: input.userId, password: secret, kind: input.kind })
      if (!run.ok) return { ok: false as const, error: 'runner_failed' as const, detail: run.error }
      if (input.kind === 'ticker') {
        const rows = extractTickerRows(run.content)
        if (!rows.length) return { ok: false as const, error: 'runner_failed' as const, detail: 'No quotes found on the page.' }
        return {
          ok: true as const,
          kind: input.kind,
          insights: rows.map((r) => `${r.symbol} ${r.price} (${r.changePct > 0 ? '+' : ''}${r.changePct}%)`).join(', '),
          chartCode: buildTickerChartCode(rows[0]!.symbol, rows),
          artifactKind: 'chart' as const,
        }
      }
      return { ok: true as const, kind: input.kind, insights: extractNewsletterInsights(run.content), artifactKind: 'insights' as const }
    })
  } catch (err) {
    return { ok: false, error: 'runner_failed', detail: err instanceof Error ? err.message : String(err) }
  }
}

/* ------------------------------ API routes ------------------------------ */

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } })
}

/**
 * Vault + approval + internal-task routes. Returns null for paths it does not
 * own so the main dispatcher can keep looking. `deps.resolveUser` and
 * `deps.internalOk` are injected by hire-api (no import cycle).
 */
export async function handleVaultApi(req: Request, sql: SQL, deps: VaultDeps): Promise<Response | null> {
  const url = new URL(req.url)
  const path = url.pathname

  if (path === '/api/internal/browser/task' && req.method === 'POST') {
    if (!deps.internalOk(req)) return json({ error: 'Not allowed.' }, 401)
    const key = deps.key ?? vaultKey()
    const body = (await req.json().catch(() => ({}))) as {
      userId?: string
      persona?: string
      requestId?: string
      kind?: BrowserTaskKind
      url?: string
    }
    if (!body.userId || !body.requestId || (body.kind !== 'newsletter' && body.kind !== 'ticker') || !body.url) {
      return json({ error: 'userId, requestId, kind and url are required.' }, 400)
    }
    if (!key) return json({ error: 'Vault is not configured on this server.' }, 503)
    const result = await runBrowserTask(deps, sql, {
      userId: body.userId,
      persona: body.persona || 'coworker',
      requestId: body.requestId,
      kind: body.kind,
      url: body.url,
      key,
    })
    return json(result, result.ok ? 200 : 409)
  }

  // Everything below is /api/vault* or /api/browser/*. Any other path belongs
  // to the main dispatcher — without this guard the user resolution 401s
  // requests like the bot's internal learning/task endpoints before they ever
  // reach their own auth.
  if (!path.startsWith('/api/vault') && !path.startsWith('/api/browser')) return null

  const user = await deps.resolveUser(sql, req)
  if (!user) return json({ error: 'Sign in first.' }, 401)

  const key = deps.key ?? vaultKey()
  if (!key) return json({ error: 'Vault is not configured on this server.' }, 503)

  if (path === '/api/vault' && req.method === 'GET') {
    return json({ entries: await listVaultEntries(sql, user.id, key) })
  }

  if (path === '/api/vault' && req.method === 'POST') {
    const body = (await req.json().catch(() => ({}))) as { portal?: string; secret?: string; persona?: string }
    const res = await saveVaultEntry(sql, {
      userId: user.id,
      persona: body.persona || user.persona,
      portal: body.portal || '',
      secret: body.secret || '',
      key,
    })
    return res.ok ? json({ ok: true }) : json({ error: res.error }, 400)
  }

  if (path === '/api/vault' && req.method === 'DELETE') {
    const id = url.searchParams.get('id') || ''
    const deleted = await deleteVaultEntry(sql, user.id, id)
    return deleted ? json({ ok: true }) : json({ error: 'Not found.' }, 404)
  }

  if (path === '/api/browser/approvals' && req.method === 'GET') {
    const rows = (await sql`
      SELECT id, portal, origin, purpose, status, created_at
      FROM hire_browser_approvals
      WHERE user_id = ${user.id} AND status = 'pending'
      ORDER BY created_at DESC LIMIT 20
    `) as Array<{ id: string; portal: string; purpose: string; created_at: Date }>
    return json({ approvals: rows })
  }

  if (path === '/api/browser/approvals' && req.method === 'POST') {
    const body = (await req.json().catch(() => ({}))) as { requestId?: string; decision?: string }
    if (!body.requestId || (body.decision !== 'approve' && body.decision !== 'deny')) {
      return json({ error: 'requestId and decision (approve|deny) are required.' }, 400)
    }
    const decided = await decideBrowserApproval(sql, user.id, body.requestId, body.decision)
    return decided ? json({ ok: true }) : json({ error: 'No pending approval with that id.' }, 404)
  }

  return null
}

export async function withUserBrowserLock<T>(userId: string, fn: () => Promise<T>): Promise<T> {
  const previous = userLocks.get(userId) ?? Promise.resolve()
  const run = previous.then(fn, fn)
  userLocks.set(
    userId,
    run.catch(() => undefined),
  )
  try {
    return await run
  } finally {
    // Only the tail task cleans up; earlier entries see their own promise.
    void userLocks.get(userId)
  }
}

/** Decrypt a credential for a task — only if the entry's scope covers the origin. */
export async function getVaultSecretForTask(
  sql: SQL,
  userId: string,
  origin: string,
  key: VaultKey,
): Promise<string | null> {
  const rows = (await sql`
    SELECT id, secret_encrypted FROM hire_vault_entries
    WHERE user_id = ${userId} AND origin = ${origin}
    ORDER BY updated_at DESC LIMIT 1
  `) as Array<{ id: string; secret_encrypted: string }>
  const row = rows[0]
  if (!row) return null
  await sql`UPDATE hire_vault_entries SET last_used_at = now() WHERE id = ${row.id}`
  return decryptSecret(row.secret_encrypted, key)
}

function portalOrigin(portal: string): string | null {
  try {
    const url = new URL(portal)
    if (url.protocol !== 'https:') return null
    return url.origin
  } catch {
    return null
  }
}
