/**
 * Per-user payment connection — the "user connects their OWN wallet" pillar.
 *
 * Trust model (stated as code):
 *  - The operator's account never funds anything. Each user authorizes their
 *    own Link wallet, whose auth document is isolated and encrypted per user.
 *  - Every new purchase is ask-first for THIS amount and THIS merchant and is
 *    capped (USER_SPEND_MAX_CENTS). Link issues a one-time credential only
 *    after that exact request is approved.
 *  - Full card data is never persisted or sent to the model. The browser
 *    worker retrieves it into memory and fills checkout fields directly.
 *
 * Legacy Stripe Customer helpers remain below only to finalize already-issued
 * PaymentIntents during migration; new product purchases use Link spend
 * requests and do not charge the platform's Stripe account.
 */
import { randomUUID } from 'node:crypto'
import type { SQL } from 'bun'
import { enqueueBrowserJob } from './browserJobs'
import { authorizePaidPurchaseBrowserRun, pushBrowserResultLoop } from './browserVault'
import type { HostResolver } from './browserNetworkPolicy'
import {
  createLinkSpendRequest,
  disconnectLink,
  ensureLinkWalletSchema,
  getLinkStatus,
  listLinkPaymentMethods,
  retrieveLinkSpend,
  startLinkConnection,
} from './linkWallet'
import {
  createCapabilityGrant,
  decideCapabilityGrant,
  requestCapabilityRevocation,
} from '../services/trust/capabilityGrants'

/* ------------------------------- schema --------------------------------- */

export async function ensureUserPaymentsSchema(sql: SQL): Promise<void> {
  await sql`ALTER TABLE hire_users ADD COLUMN IF NOT EXISTS stripe_payment_customer TEXT`
  await sql`
    CREATE TABLE IF NOT EXISTS hire_spend_approvals (
      id UUID PRIMARY KEY,
      user_id UUID NOT NULL,
      amount_cents INTEGER NOT NULL,
      merchant TEXT NOT NULL,
      purpose TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      payment_intent_id TEXT,
      last_error TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      decided_at TIMESTAMPTZ,
      consumed_at TIMESTAMPTZ
    )
  `
  await sql`CREATE INDEX IF NOT EXISTS idx_hire_spend_approvals_user ON hire_spend_approvals (user_id, status)`
  await sql`ALTER TABLE hire_spend_approvals ADD COLUMN IF NOT EXISTS paid_at TIMESTAMPTZ`
  await sql`ALTER TABLE hire_spend_approvals ADD COLUMN IF NOT EXISTS finalization_status TEXT NOT NULL DEFAULT 'pending'`
  await sql`ALTER TABLE hire_spend_approvals ADD COLUMN IF NOT EXISTS finalization_job_id UUID`
  await sql`ALTER TABLE hire_spend_approvals ADD COLUMN IF NOT EXISTS order_confirmation TEXT`
  await ensureLinkWalletSchema(sql)
}

/* ------------------------------ stripe io -------------------------------- */

const STRIPE_API = 'https://api.stripe.com/v1'

function stripeKey(): string | null {
  return process.env.STRIPE_SECRET_KEY?.trim() || null
}

async function stripeCall(method: 'GET' | 'POST', path: string, params?: URLSearchParams, idempotencyKey?: string): Promise<{ ok: boolean; status: number; data: any }> {
  const key = stripeKey()
  if (!key) return { ok: false, status: 503, data: { error: { message: 'Stripe is not configured.' } } }
  const headers: Record<string, string> = { authorization: `Bearer ${key}` }
  if (idempotencyKey) headers['idempotency-key'] = idempotencyKey
  const res = await fetch(`${STRIPE_API}${path}`, {
    method,
    headers,
    body: method === 'POST' ? params : undefined,
    signal: AbortSignal.timeout(20_000),
  }).catch(() => null)
  if (!res) return { ok: false, status: 502, data: { error: { message: 'Stripe unreachable.' } } }
  const data = (await res.json().catch(() => ({}))) as any
  return { ok: res.ok, status: res.status, data }
}

/* ------------------------------ customers -------------------------------- */

export async function getOrCreatePaymentCustomer(sql: SQL, userId: string, email: string): Promise<string | null> {
  const rows = (await sql`
    SELECT stripe_payment_customer FROM hire_users WHERE id = ${userId} LIMIT 1
  `) as Array<{ stripe_payment_customer: string | null }>
  const existing = rows[0]?.stripe_payment_customer
  if (existing) return existing

  // Reuse by metadata before creating: re-connecting after a wiped DB must not
  // orphan the user's saved card on a second customer.
  const search = await stripeCall('GET', `/customers?email=${encodeURIComponent(email)}&limit=100`)
  if (search.ok) {
    for (const c of search.data.data ?? []) {
      if (c.metadata?.user_id === userId) {
        await sql`UPDATE hire_users SET stripe_payment_customer = ${c.id} WHERE id = ${userId}`
        return c.id as string
      }
    }
  }

  const created = await stripeCall('POST', '/customers', new URLSearchParams({
    email,
    'metadata[user_id]': userId,
  }))
  if (!created.ok) return null
  const id = created.data.id as string
  await sql`UPDATE hire_users SET stripe_payment_customer = ${id} WHERE id = ${userId}`
  return id
}

/* --------------------------- connect (setup mode) ------------------------ */

export function appBaseOf(req: Request): string {
  const url = new URL(req.url)
  return `${url.protocol}//${url.host}`
}

/** Checkout session in setup mode: saves the user's card (or Link wallet) to
 * THEIR customer. No charge happens. Link autofill shows automatically. */
export async function createConnectSession(sql: SQL, req: Request, userId: string, email: string): Promise<{ url: string } | { error: string }> {
  const customer = await getOrCreatePaymentCustomer(sql, userId, email)
  if (!customer) return { error: 'Could not create your payment account.' }
  const session = await stripeCall('POST', '/checkout/sessions', new URLSearchParams({
    mode: 'setup',
    customer,
    success_url: `${appBaseOf(req)}/app?payments=connected`,
    cancel_url: `${appBaseOf(req)}/app?payments=cancelled`,
    'metadata[user_id]': userId,
    'metadata[purpose]': 'user_wallet',
  }))
  if (!session.ok || !session.data.url) return { error: session.data?.error?.message || 'Checkout session failed.' }
  return { url: session.data.url as string }
}

export type MethodView = { id: string; brand: string; last4: string; exp: string; link_wallet: boolean }

export async function listPaymentMethods(customerId: string): Promise<MethodView[]> {
  const res = await stripeCall('GET', `/payment_methods?customer=${encodeURIComponent(customerId)}&type=card&limit=10`)
  if (!res.ok) return []
  return (res.data.data ?? []).map((pm: any) => ({
    id: pm.id as string,
    brand: String(pm.card?.brand || 'card'),
    last4: String(pm.card?.last4 || '••••'),
    exp: `${pm.card?.exp_month ?? '?'}/${String(pm.card?.exp_year ?? '?').slice(-2)}`,
    link_wallet: pm.card?.wallet?.type === 'link',
  }))
}

/* ------------------------- spend approvals + charge ---------------------- */

export const DEFAULT_SPEND_CAP_CENTS = 20_000

export function spendCapCents(): number {
  const raw = Number(process.env.USER_SPEND_MAX_CENTS)
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : DEFAULT_SPEND_CAP_CENTS
}

export async function createSpendRequest(
  sql: SQL,
  userId: string,
  input: { amountCents: number; merchant: string; purpose: string },
): Promise<{ requestId: string } | { error: string }> {
  const amount = Number(input.amountCents)
  if (!Number.isInteger(amount) || amount < 50) return { error: 'Amount must be an exact number of cents and at least $0.50.' }
  if (amount > spendCapCents()) return { error: `Above the per-purchase cap ($${(spendCapCents() / 100).toFixed(0)}). Ask in chat to raise it.` }
  const merchant = input.merchant.trim().slice(0, 120)
  const purpose = input.purpose.trim().slice(0, 300)
  if (!merchant || !purpose) return { error: 'Merchant and purpose are required.' }
  const id = randomUUID()
  await sql`
    INSERT INTO hire_spend_approvals (id, user_id, amount_cents, merchant, purpose, status)
    VALUES (${id}, ${userId}, ${amount}, ${merchant}, ${purpose}, 'pending')
  `
  return { requestId: id }
}

/** Create the user-visible Link approval only after the exact merchant total
 * is known. Link issues the one-time checkout credential after approval. */
export async function createLinkBackedSpendRequest(
  sql: SQL,
  userId: string,
  input: { amountCents: number; merchant: string; merchantUrl: string; purpose: string },
): Promise<{ requestId: string; approvalUrl: string } | { error: string }> {
  let merchantUrl: URL
  try { merchantUrl = new URL(input.merchantUrl) } catch { return { error: 'Purchase needs a valid merchant URL.' } }
  if (merchantUrl.protocol !== 'https:' || merchantUrl.username || merchantUrl.password) return { error: 'Purchase merchant URL must be secure.' }
  const merchant = merchantUrl.hostname.toLowerCase().replace(/^www\./, '')
  const local = await createSpendRequest(sql, userId, { ...input, merchant })
  if (!('requestId' in local)) return local
  const capability = await createCapabilityGrant(sql, {
    userId,
    taskId: local.requestId,
    resourceType: 'payment',
    resourceId: local.requestId,
    action: 'issue_one_time_payment_credential',
    exactOrigin: merchantUrl.origin,
    amountCents: input.amountCents,
    currency: 'USD',
    merchant,
    recipient: merchant,
    cart: [{ description: input.purpose, quantity: 1, unitAmountCents: input.amountCents }],
    requestingAgent: 'alpha',
    purpose: input.purpose,
    expiresAt: new Date(Date.now() + 10 * 60 * 1000),
  })
  try {
    const spend = await createLinkSpendRequest(sql, userId, { ...input, merchant, merchantUrl: merchantUrl.href, requestId: local.requestId })
    if (!spend.id || !spend.approvalUrl) throw new Error('Link did not return an approval link.')
    const approvalUrl = new URL(spend.approvalUrl)
    if (approvalUrl.protocol !== 'https:' || approvalUrl.username || approvalUrl.password) throw new Error('Link returned an invalid approval link.')
    await sql`
      UPDATE hire_spend_approvals
      SET link_spend_request_id = ${spend.id}, link_approval_url = ${approvalUrl.href},
        merchant_url = ${merchantUrl.href}, capability_grant_id = ${capability.id},
        finalization_status = 'awaiting_link', last_error = NULL
      WHERE id = ${local.requestId} AND user_id = ${userId}
    `
    await sql`UPDATE capability_grants SET provider_reference = ${spend.id} WHERE id = ${capability.id}`
    return { requestId: local.requestId, approvalUrl: approvalUrl.href }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Could not create Link approval.'
    await requestCapabilityRevocation(sql, { id: capability.id, userId, taskId: local.requestId })
    await sql`UPDATE hire_spend_approvals SET status = 'failed', last_error = ${message.slice(0, 300)} WHERE id = ${local.requestId} AND user_id = ${userId}`
    return { error: message }
  }
}

export type SpendDecision = 'ok' | 'missing' | 'denied' | 'expired' | 'used'

/** One-time consume. The UPDATE's consumed_at guard makes two racing charges impossible. */
export async function consumeSpendApproval(
  sql: SQL,
  userId: string,
  requestId: string,
  now: number = Date.now(),
): Promise<{ decision: SpendDecision; approval?: { amount_cents: number; merchant: string; purpose: string } }> {
  const rows = (await sql`
    SELECT id, status, amount_cents, merchant, purpose, created_at, consumed_at
    FROM hire_spend_approvals WHERE id = ${requestId} AND user_id = ${userId} LIMIT 1
  `) as Array<{ id: string; status: string; amount_cents: number; merchant: string; purpose: string; created_at: Date; consumed_at: Date | null }>
  const row = rows[0]
  if (!row) return { decision: 'missing' }
  if (row.status === 'denied') return { decision: 'denied' }
  if (row.consumed_at) return { decision: 'used' }
  if (row.status !== 'approved') return { decision: 'missing' }
  if (now - new Date(row.created_at).getTime() > 10 * 60 * 1000) return { decision: 'expired' }
  const updated = (await sql`
    UPDATE hire_spend_approvals SET consumed_at = now()
    WHERE id = ${requestId} AND user_id = ${userId} AND status = 'approved' AND consumed_at IS NULL
    RETURNING id
  `) as Array<{ id: string }>
  return updated.length > 0
    ? { decision: 'ok', approval: { amount_cents: row.amount_cents, merchant: row.merchant, purpose: row.purpose } }
    : { decision: 'used' }
}

export async function decideSpendApproval(sql: SQL, userId: string, requestId: string, decision: 'approve' | 'deny'): Promise<boolean> {
  const status = decision === 'approve' ? 'approved' : 'denied'
  const rows = (await sql`
    UPDATE hire_spend_approvals SET status = ${status}, decided_at = now()
    WHERE id = ${requestId} AND user_id = ${userId} AND status = 'pending' RETURNING id
  `) as Array<{ id: string }>
  return rows.length > 0
}

/** Off-session charge against the user's own saved method. Idempotent per request. */
export async function chargeApprovedSpend(
  sql: SQL,
  userId: string,
  requestId: string,
): Promise<{ ok: true; paymentIntentId: string } | { ok: false; error: string; decision?: SpendDecision }> {
  const methods = await listPaymentMethodsForUser(sql, userId)
  if (!methods) return { ok: false, error: 'No card connected yet.' }
  const gate = await consumeSpendApproval(sql, userId, requestId)
  if (gate.decision !== 'ok' || !gate.approval) return { ok: false, error: `Approval is ${gate.decision}.`, decision: gate.decision }

  const intent = await stripeCall(
    'POST',
    '/payment_intents',
    new URLSearchParams({
      amount: String(gate.approval.amount_cents),
      currency: 'usd',
      customer: methods.customerId,
      payment_method: methods.defaultId,
      off_session: 'true',
      confirm: 'true',
      description: `${gate.approval.merchant}: ${gate.approval.purpose}`.slice(0, 300),
      'metadata[user_id]': userId,
      'metadata[spend_request]': requestId,
    }),
    `spend-${requestId}`,
  )
  if (!intent.ok || intent.data?.status !== 'succeeded') {
    const msg = String(intent.data?.error?.message || 'The charge was declined.')
    await sql`UPDATE hire_spend_approvals SET last_error = ${msg} WHERE id = ${requestId}`
    return { ok: false, error: msg }
  }
  await sql`UPDATE hire_spend_approvals SET payment_intent_id = ${String(intent.data.id)} WHERE id = ${requestId}`
  return { ok: true, paymentIntentId: String(intent.data.id) }
}

export type PurchasePaymentIntent = {
  id?: unknown
  status?: unknown
  amount_received?: unknown
  currency?: unknown
  metadata?: unknown
}

export type PurchaseFinalizationResult =
  | { status: 'ignored'; reason: string }
  | { status: 'already_queued'; jobId: string }
  | { status: 'resumed'; jobId: string }
  | { status: 'queued'; jobId: string }
  | { status: 'needs_attention'; reason: string }

/** Turn one verified payment_intent.succeeded event into exactly one final
 * merchant browser job. Stripe can retry or deliver events concurrently: the
 * spend UUID is reused for both the browser approval and job IDs, making every
 * insert idempotent at the database boundary. */
export async function queuePaidPurchaseFinalization(
  sql: SQL,
  intent: PurchasePaymentIntent,
  opts?: { resolveHost?: HostResolver },
): Promise<PurchaseFinalizationResult> {
  const intentId = typeof intent.id === 'string' ? intent.id : ''
  const metadata = intent.metadata && typeof intent.metadata === 'object'
    ? intent.metadata as Record<string, unknown>
    : {}
  const requestId = typeof metadata.spend_request === 'string' ? metadata.spend_request : ''
  const metadataUserId = typeof metadata.user_id === 'string' ? metadata.user_id : ''
  if (!intentId.startsWith('pi_') || intent.status !== 'succeeded' || !requestId || !metadataUserId) {
    return { status: 'ignored', reason: 'not a HireAlpha succeeded spend PaymentIntent' }
  }

  const approvals = (await sql`
    SELECT a.id, a.user_id, a.amount_cents, a.merchant, a.purpose, a.payment_intent_id,
      a.finalization_job_id, u.phone_e164
    FROM hire_spend_approvals a
    JOIN hire_users u ON u.id = a.user_id
    WHERE a.id = ${requestId} AND a.user_id = ${metadataUserId}
    LIMIT 1
  `) as Array<{
    id: string
    user_id: string
    amount_cents: number
    merchant: string
    purpose: string
    payment_intent_id: string | null
    finalization_job_id: string | null
    phone_e164: string | null
  }>
  const approval = approvals[0]
  if (!approval) return { status: 'ignored', reason: 'spend approval not found or owner mismatch' }
  if (approval.payment_intent_id && approval.payment_intent_id !== intentId) {
    return { status: 'ignored', reason: 'PaymentIntent does not match the spend approval' }
  }
  if (String(intent.currency || '').toLowerCase() !== 'usd' || Number(intent.amount_received) !== approval.amount_cents) {
    return { status: 'ignored', reason: 'paid currency or amount does not match the spend approval' }
  }
  if (approval.finalization_job_id) {
    const staged = (await sql`
      SELECT id, status, handoff_kind, spend_request_id
      FROM hire_browser_jobs
      WHERE id = ${approval.finalization_job_id} AND user_id = ${approval.user_id}
      LIMIT 1
    `) as Array<{ id: string; status: string; handoff_kind: string | null; spend_request_id: string | null }>
    const live = staged[0]
    if (live?.status === 'waiting' && live.handoff_kind === 'payment' && live.spend_request_id === requestId) {
      await sql`
        UPDATE hire_spend_approvals
        SET payment_intent_id = ${intentId}, paid_at = COALESCE(paid_at, now()),
          finalization_status = 'running', last_error = NULL
        WHERE id = ${requestId} AND user_id = ${approval.user_id}
      `
      await sql`
        UPDATE hire_browser_jobs
        SET status = 'running', handoff_resumed_at = now(), claimed_at = now()
        WHERE id = ${live.id} AND user_id = ${approval.user_id} AND status = 'waiting' AND handoff_kind = 'payment'
      `
      return { status: 'resumed', jobId: live.id }
    }
    return { status: 'already_queued', jobId: approval.finalization_job_id }
  }

  const drafts = (await sql`
    SELECT persona, to_addr, subject, body
    FROM hire_drafts
    WHERE user_id = ${approval.user_id} AND kind = 'purchase'
    ORDER BY created_at DESC
    LIMIT 50
  `) as Array<{ persona: string; to_addr: string; subject: string; body: string }>
  const draft = drafts.find((candidate) => {
    try {
      return String((JSON.parse(candidate.body) as Record<string, unknown>).requestId || '') === requestId
    } catch {
      return false
    }
  })
  let productUrl: URL | null = null
  try {
    productUrl = draft?.to_addr ? new URL(draft.to_addr) : null
  } catch {}
  const expectedMerchant = approval.merchant.toLowerCase().replace(/^www\./, '')
  const actualMerchant = productUrl?.hostname.toLowerCase().replace(/^www\./, '') || ''
  if (!draft || !productUrl || productUrl.protocol !== 'https:' || productUrl.username || productUrl.password || actualMerchant !== expectedMerchant) {
    const reason = 'Payment succeeded, but the staged merchant checkout could not be found. No merchant order was submitted.'
    await sql`
      UPDATE hire_spend_approvals
      SET payment_intent_id = ${intentId}, paid_at = COALESCE(paid_at, now()), finalization_status = 'needs_attention', last_error = ${reason}
      WHERE id = ${requestId} AND user_id = ${approval.user_id}
    `
    await pushBrowserResultLoop(sql, {
      userId: approval.user_id,
      persona: draft?.persona || 'friend',
      origin: productUrl?.origin || 'https://hirealpha.chat',
      insights: reason,
    })
    return { status: 'needs_attention', reason }
  }

  const browserApproval = await authorizePaidPurchaseBrowserRun(sql, {
    requestId,
    userId: approval.user_id,
    persona: draft.persona || 'friend',
    portal: productUrl.href,
    purpose: `Finalize paid purchase: ${approval.purpose}`.slice(0, 200),
  })
  if ('error' in browserApproval) return { status: 'needs_attention', reason: browserApproval.error }

  const amount = `$${(approval.amount_cents / 100).toFixed(2)}`
  const goal = [
    `Complete the already authorized checkout for "${approval.purpose}".`,
    `Use the merchant's existing cart and saved checkout details, and verify the final total is exactly ${amount}.`,
    'Do not add, remove, substitute, or change quantities. If the cart or total differs, use giveup without ordering and explain the mismatch.',
    'If everything matches, click the final Place Order/Submit Order control exactly once. Use done only after the confirmation page is visible, and include the merchant order confirmation number.',
  ].join(' ')
  const jobId = await enqueueBrowserJob(sql, {
    userId: approval.user_id,
    persona: draft.persona || 'friend',
    phone: approval.phone_e164,
    kind: 'task',
    url: productUrl.href,
    goal,
    approvalId: browserApproval.requestId,
    spendRequestId: requestId,
    idempotencyId: requestId,
    resolveHost: opts?.resolveHost,
  })
  await sql`
    UPDATE hire_spend_approvals
    SET payment_intent_id = ${intentId}, paid_at = COALESCE(paid_at, now()),
      finalization_status = 'queued', finalization_job_id = ${jobId}, last_error = NULL
    WHERE id = ${requestId} AND user_id = ${approval.user_id}
  `
  return { status: 'queued', jobId }
}

/** Poll pending Link approvals and queue the merchant checkout only after Link
 * says this exact spend request was approved. Safe to run in every worker. */
export async function promoteApprovedLinkPurchases(sql: SQL, limit = 3): Promise<number> {
  const rows = (await sql`
    SELECT a.id, a.user_id, a.amount_cents, a.merchant, a.merchant_url, a.purpose,
      a.link_spend_request_id, a.finalization_job_id, a.capability_grant_id, u.phone_e164
    FROM hire_spend_approvals a
    JOIN hire_users u ON u.id = a.user_id::text
    WHERE a.link_spend_request_id IS NOT NULL AND a.status = 'pending'
      AND a.finalization_status = 'awaiting_link'
    ORDER BY a.created_at ASC LIMIT ${limit}
  `) as Array<{
    id: string; user_id: string; amount_cents: number; merchant: string; merchant_url: string;
    purpose: string; link_spend_request_id: string; finalization_job_id: string | null;
    capability_grant_id: string | null; phone_e164: string | null
  }>
  let promoted = 0
  for (const row of rows) {
    let remote
    try { remote = await retrieveLinkSpend(sql, row.user_id, row.link_spend_request_id) }
    catch { continue }
    if (['denied', 'expired', 'failed', 'canceled'].includes(remote.status)) {
      if (row.capability_grant_id) {
        const grants = (await sql`SELECT task_id, encode(request_digest, 'hex') AS digest FROM capability_grants WHERE id = ${row.capability_grant_id} LIMIT 1`) as Array<{ task_id: string; digest: string }>
        if (grants[0]) await decideCapabilityGrant(sql, {
          id: row.capability_grant_id, userId: row.user_id, taskId: grants[0].task_id,
          digest: grants[0].digest, decision: 'denied',
        })
      }
      await sql`UPDATE hire_spend_approvals SET status = ${remote.status}, decided_at = now(), finalization_status = 'cancelled' WHERE id = ${row.id} AND status = 'pending'`
      continue
    }
    if (!['approved', 'succeeded'].includes(remote.status)) continue
    if (row.capability_grant_id) {
      const grants = (await sql`SELECT task_id, encode(request_digest, 'hex') AS digest FROM capability_grants WHERE id = ${row.capability_grant_id} LIMIT 1`) as Array<{ task_id: string; digest: string }>
      if (!grants[0] || !await decideCapabilityGrant(sql, {
        id: row.capability_grant_id, userId: row.user_id, taskId: grants[0].task_id,
        digest: grants[0].digest, decision: 'approved',
      })) continue
    }

    // A discovery browser may be paused on the checkout page. It was launched
    // before the Link credential existed, so close that credential-less run;
    // the deterministic finalization job below starts with the approved card
    // injected in memory. Never mutate a live model session to add secrets.
    if (row.finalization_job_id && row.finalization_job_id !== row.id) {
      await sql`
        UPDATE hire_browser_jobs SET status = 'failed', error = 'Superseded by Link-approved checkout', finished_at = now()
        WHERE id = ${row.finalization_job_id} AND user_id = ${row.user_id} AND status = 'waiting' AND handoff_kind = 'payment'
      `
    }

    const drafts = (await sql`
      SELECT persona FROM hire_drafts WHERE user_id = ${row.user_id} AND kind = 'purchase'
        AND body LIKE ${`%${row.id}%`} ORDER BY created_at DESC LIMIT 1
    `) as Array<{ persona: string }>
    const persona = drafts[0]?.persona || 'friend'
    const browserApproval = await authorizePaidPurchaseBrowserRun(sql, {
      requestId: row.id, userId: row.user_id, persona, portal: row.merchant_url,
      purpose: `Complete Link-approved purchase: ${row.purpose}`.slice(0, 200),
    })
    if ('error' in browserApproval) continue
    const amount = `$${(row.amount_cents / 100).toFixed(2)}`
    const goal = [
      `Complete the Link-approved checkout for "${row.purpose}".`,
      `Verify the final total is exactly ${amount}; do not change the cart or accept substitutions.`,
      'When the payment form is visible, use fill_payment. Never ask for or type card numbers yourself.',
      'Click the final Place Order control exactly once. Use done only after a merchant confirmation number is visible.',
    ].join(' ')
    const jobId = await enqueueBrowserJob(sql, {
      userId: row.user_id, persona, phone: row.phone_e164, kind: 'task', url: row.merchant_url,
      goal, approvalId: browserApproval.requestId, spendRequestId: row.id, idempotencyId: row.id,
    })
    await sql`
      UPDATE hire_spend_approvals SET status = 'approved', decided_at = now(), consumed_at = now(),
        finalization_status = 'queued', finalization_job_id = ${jobId}, last_error = NULL
      WHERE id = ${row.id} AND user_id = ${row.user_id} AND status = 'pending'
    `
    promoted++
  }
  return promoted
}

/** Customer id + default (newest) payment method in one call. */
export async function listPaymentMethodsForUser(
  sql: SQL,
  userId: string,
): Promise<{ customerId: string; defaultId: string } | null> {
  const rows = (await sql`
    SELECT stripe_payment_customer FROM hire_users WHERE id = ${userId} LIMIT 1
  `) as Array<{ stripe_payment_customer: string | null }>
  const customerId = rows[0]?.stripe_payment_customer
  if (!customerId) return null
  const methods = await listPaymentMethods(customerId)
  if (!methods.length) return null
  return { customerId, defaultId: methods[0]!.id }
}

/* ------------------------------ API routes ------------------------------- */

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } })
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[char]!)
}

export type UserPaymentsDeps = {
  resolveUser: (sql: SQL, req: Request) => Promise<{ id: string } | null>
}

/** Returns null for paths it does not own. All routes require a signed-in user. */
export async function handleUserPaymentsApi(req: Request, sql: SQL, deps: UserPaymentsDeps): Promise<Response | null> {
  const url = new URL(req.url)
  const path = url.pathname
  if (!path.startsWith('/api/payments')) return null

  // One-tap spend approval from iMessage / chat links
  if (path === '/api/payments/spend/approve' && req.method === 'GET') {
    const id = url.searchParams.get('id') || ''
    const isJson = url.searchParams.get('format') === 'json' || req.headers.get('accept')?.includes('application/json')
    if (!id) return isJson ? json({ error: 'Missing request id' }, 400) : new Response('Missing request id', { status: 400 })
    const rows = (await sql`
      SELECT id, user_id, amount_cents, merchant, purpose, status, payment_intent_id,
        finalization_status, link_spend_request_id, link_approval_url
      FROM hire_spend_approvals WHERE id = ${id} LIMIT 1
    `) as Array<{ id: string; user_id: string; amount_cents: number; merchant: string; purpose: string; status: string; payment_intent_id: string | null; finalization_status: string; link_spend_request_id: string | null; link_approval_url: string | null }>
    const item = rows[0]
    if (!item) {
      if (isJson) return json({ error: 'Request not found' }, 404)
      return new Response('<html><body style="font-family:sans-serif;padding:40px;text-align:center;"><h2>Request Not Found</h2><p>This spend approval link has expired or is invalid.</p></body></html>', {
        headers: { 'Content-Type': 'text/html; charset=utf-8' },
        status: 404,
      })
    }
    const amountStr = `$${(item.amount_cents / 100).toFixed(2)}`
    if (item.link_spend_request_id && item.link_approval_url && isJson) {
      return json({
        ok: true, id: item.id, merchant: item.merchant, purpose: item.purpose,
        amount_cents: item.amount_cents, amount: amountStr, status: item.status,
        approval_url: item.status === 'pending' ? item.link_approval_url : undefined,
        finalization_status: item.finalization_status,
        already_approved: ['approved', 'consumed'].includes(item.status) || item.finalization_status === 'completed',
      })
    }
    if (item.link_spend_request_id && item.link_approval_url && item.status === 'pending') {
      const safeMerchant = escapeHtml(item.merchant)
      const safePurpose = escapeHtml(item.purpose)
      const safeApprovalUrl = escapeHtml(item.link_approval_url)
      return new Response(`<html><body style="font-family:-apple-system,BlinkMacSystemFont,sans-serif;background:#0d1117;color:#fff;padding:40px 16px;text-align:center;">
        <div style="max-width:400px;margin:0 auto;background:#161b22;padding:32px;border-radius:16px;border:1px solid #30363d;">
          <div style="display:inline-block;padding:6px 14px;background:#635bff;color:#fff;border-radius:20px;font-size:12px;font-weight:600;margin-bottom:16px;">LINK APPROVAL</div>
          <h2 style="margin:0 0 8px;color:#f0f6fc;">Approve Purchase</h2>
          <p style="color:#8b949e;">Approve a one-time payment credential for this exact purchase. HireAlpha cannot reuse it for another order.</p>
          <div style="background:#21262d;padding:20px;border-radius:12px;margin:20px 0;text-align:left;">
            <div style="font-size:12px;color:#8b949e;">Merchant</div><div style="font-weight:600;margin-bottom:12px;">${safeMerchant}</div>
            <div style="font-size:12px;color:#8b949e;">Item</div><div style="font-weight:600;margin-bottom:12px;">${safePurpose}</div>
            <div style="font-size:12px;color:#8b949e;">Maximum total</div><div style="font-weight:700;font-size:24px;color:#58a6ff;">${amountStr}</div>
          </div>
          <a href="${safeApprovalUrl}" rel="noreferrer" style="display:block;background:#635bff;color:#fff;text-decoration:none;padding:16px;border-radius:12px;font-weight:600;">Continue to Link</a>
          <p style="font-size:12px;color:#8b949e;">Link shows the merchant, item, and exact total before you approve.</p>
        </div></body></html>`, { headers: { 'Content-Type': 'text/html; charset=utf-8' } })
    }
    if (item.status === 'approved' || item.status === 'consumed' || item.payment_intent_id) {
      if (isJson) {
        return json({ ok: true, already_approved: true, status: 'consumed', finalization_status: item.finalization_status, merchant: item.merchant, purpose: item.purpose, amount: amountStr })
      }
      return new Response(`<html><body style="font-family:-apple-system,BlinkMacSystemFont,sans-serif;background:#0d1117;color:#fff;padding:40px 16px;text-align:center;">
        <div style="max-width:400px;margin:0 auto;background:#161b22;padding:32px;border-radius:16px;border:1px solid #30363d;">
          <h2 style="color:#2ea043;margin-top:0;">✓ Already Approved</h2>
          <p style="color:#8b949e;font-size:15px;">You have already approved this purchase.</p>
          <div style="background:#21262d;padding:16px;border-radius:12px;margin:20px 0;text-align:left;">
            <div style="font-size:12px;color:#8b949e;">Merchant</div>
            <div style="font-weight:600;font-size:15px;color:#f0f6fc;margin-bottom:8px;">${item.merchant}</div>
            <div style="font-size:12px;color:#8b949e;">Item</div>
            <div style="font-weight:600;font-size:15px;color:#f0f6fc;margin-bottom:8px;">${item.purpose}</div>
            <div style="font-size:12px;color:#8b949e;">Amount</div>
            <div style="font-weight:700;font-size:20px;color:#58a6ff;">${amountStr}</div>
          </div>
          <p style="font-size:13px;color:#8b949e;">Payment was received. Alpha will confirm the merchant order separately in iMessage.</p>
        </div>
      </body></html>`, {
        headers: { 'Content-Type': 'text/html; charset=utf-8' },
      })
    }
    if (item.status !== 'pending') {
      if (isJson) return json({ ok: false, error: `Request ${item.status}`, status: item.status }, 409)
      return new Response(`<html><body style="font-family:-apple-system,BlinkMacSystemFont,sans-serif;background:#0d1117;color:#fff;padding:40px 16px;text-align:center;">
        <div style="max-width:400px;margin:0 auto;background:#161b22;padding:32px;border-radius:16px;border:1px solid #30363d;">
          <h2 style="color:#f85149;margin-top:0;">Request ${item.status}</h2>
          <p style="color:#8b949e;">This purchase request was ${item.status}.</p>
        </div>
      </body></html>`, {
        headers: { 'Content-Type': 'text/html; charset=utf-8' },
      })
    }

    const confirm = url.searchParams.get('confirm') === '1'
    if (!confirm) {
      if (isJson) {
        return json({ ok: true, id: item.id, merchant: item.merchant, purpose: item.purpose, amount_cents: item.amount_cents, amount: amountStr, status: item.status })
      }
      return new Response(`<html><body style="font-family:-apple-system,BlinkMacSystemFont,sans-serif;background:#0d1117;color:#fff;padding:40px 16px;text-align:center;">
        <div style="max-width:400px;margin:0 auto;background:#161b22;padding:32px;border-radius:16px;border:1px solid #30363d;box-shadow:0 8px 24px rgba(0,0,0,0.4);">
          <div style="display:inline-block;padding:6px 14px;background:#238636;color:#fff;border-radius:20px;font-size:12px;font-weight:600;margin-bottom:16px;">SPEND APPROVAL</div>
          <h2 style="margin:0 0 8px 0;font-size:22px;color:#f0f6fc;">Approve Purchase</h2>
          <p style="color:#8b949e;font-size:14px;margin-bottom:24px;">Alpha is requesting permission to charge your saved card.</p>
          <div style="background:#21262d;padding:20px;border-radius:12px;margin-bottom:24px;text-align:left;">
            <div style="font-size:12px;color:#8b949e;text-transform:uppercase;letter-spacing:0.5px;">Merchant</div>
            <div style="font-weight:600;font-size:15px;color:#f0f6fc;margin-bottom:12px;">${item.merchant}</div>
            <div style="font-size:12px;color:#8b949e;text-transform:uppercase;letter-spacing:0.5px;">Item</div>
            <div style="font-weight:600;font-size:15px;color:#f0f6fc;margin-bottom:12px;">${item.purpose}</div>
            <div style="font-size:12px;color:#8b949e;text-transform:uppercase;letter-spacing:0.5px;">Total Charge</div>
            <div style="font-weight:700;font-size:24px;color:#58a6ff;">${amountStr}</div>
          </div>
          <a href="/api/payments/spend/approve?id=${id}&confirm=1" style="display:block;background:#238636;color:#fff;text-decoration:none;padding:16px;border-radius:12px;font-weight:600;font-size:16px;margin-bottom:12px;">Approve &amp; Pay ${amountStr}</a>
          <p style="font-size:12px;color:#8b949e;margin:0;">Charged securely via Stripe using your connected payment method.</p>
        </div>
      </body></html>`, {
        headers: { 'Content-Type': 'text/html; charset=utf-8' },
      })
    }

    await decideSpendApproval(sql, item.user_id, id, 'approve')
    const chargeRes = await chargeApprovedSpend(sql, item.user_id, id)
    if (!chargeRes.ok) {
      if (isJson) return json({ ok: false, error: chargeRes.error || 'Payment failed' }, 402)
      return new Response(`<html><body style="font-family:-apple-system,BlinkMacSystemFont,sans-serif;background:#0d1117;color:#fff;padding:40px 16px;text-align:center;">
        <div style="max-width:400px;margin:0 auto;background:#161b22;padding:32px;border-radius:16px;border:1px solid #da3633;">
          <h2 style="color:#f85149;margin-top:0;">Payment Failed</h2>
          <p style="color:#8b949e;font-size:15px;">${chargeRes.error || 'The card charge could not be completed.'}</p>
          <p style="color:#8b949e;font-size:13px;">Please check your card details or connect a new payment method in Alpha settings.</p>
        </div>
      </body></html>`, {
        headers: { 'Content-Type': 'text/html; charset=utf-8' },
        status: 402,
      })
    }

    if (isJson) {
      return json({ ok: true, charged: true, finalization_status: 'awaiting_webhook', id: item.id, merchant: item.merchant, purpose: item.purpose, amount: amountStr })
    }

    return new Response(`<html><body style="font-family:-apple-system,BlinkMacSystemFont,sans-serif;background:#0d1117;color:#fff;padding:40px 16px;text-align:center;">
      <div style="max-width:400px;margin:0 auto;background:#161b22;padding:32px;border-radius:16px;border:1px solid #238636;box-shadow:0 8px 24px rgba(0,0,0,0.4);">
        <div style="font-size:48px;margin-bottom:16px;">✓</div>
        <h2 style="margin:0 0 8px 0;color:#3fb950;font-size:22px;">Payment Received</h2>
        <p style="color:#8b949e;font-size:14px;margin-bottom:20px;">Your saved card was successfully charged <strong>${amountStr}</strong> for ${item.purpose}.</p>
        <div style="background:#21262d;padding:16px;border-radius:12px;margin-bottom:20px;font-size:13px;color:#8b949e;">
          Payment ID: <span style="color:#f0f6fc;font-family:monospace;">${chargeRes.paymentIntentId}</span>
        </div>
        <p style="font-size:13px;color:#8b949e;margin:0;">Alpha is finalizing the merchant checkout. The order confirmation number will arrive in Messages.</p>
      </div>
    </body></html>`, {
      headers: { 'Content-Type': 'text/html; charset=utf-8' },
    })
  }

  const user = await deps.resolveUser(sql, req)
  if (!user) return json({ error: 'Sign in first.' }, 401)

  // Link device authorization belongs to this signed-in HireAlpha user only.
  if (path === '/api/payments/connect' && req.method === 'POST') {
    try {
      const status = await startLinkConnection(sql, user.id)
      return json({ ...status, url: status.verificationUrl })
    } catch (error) {
      return json({ error: error instanceof Error ? error.message : 'Could not start Link connection.' }, 400)
    }
  }

  if (path === '/api/payments/link/status' && req.method === 'GET') {
    try { return json(await getLinkStatus(sql, user.id)) }
    catch (error) { return json({ connected: false, pending: false, error: error instanceof Error ? error.message : 'Link status failed.' }, 400) }
  }

  if (path === '/api/payments/link' && req.method === 'DELETE') {
    await disconnectLink(sql, user.id)
    return json({ ok: true })
  }

  // Link returns only masked method views here. Card credentials never use this route.
  if (path === '/api/payments/methods' && req.method === 'GET') {
    try {
      const status = await getLinkStatus(sql, user.id)
      if (!status.connected) return json({ methods: [], link: status })
      return json({ methods: await listLinkPaymentMethods(sql, user.id), link: status })
    } catch { return json({ methods: [], link: { connected: false, pending: false } }) }
  }

  // Remove a saved method.
  if (path === '/api/payments/methods' && req.method === 'DELETE') {
    return json({ error: 'Manage individual cards in Link, or disconnect the wallet from HireAlpha.' }, 409)
  }

  // Spend requests: create → pending; user approves/denies; charge consumes.
  if (path === '/api/payments/spend' && req.method === 'POST') {
    const body = (await req.json().catch(() => ({}))) as { action?: string; requestId?: string; amountCents?: number; merchant?: string; merchantUrl?: string; purpose?: string }
    const action = body.action || 'create'
    if (action === 'create') {
      const res = await createLinkBackedSpendRequest(sql, user.id, {
        amountCents: Number(body.amountCents),
        merchant: String(body.merchant || ''),
        merchantUrl: String(body.merchantUrl || ''),
        purpose: String(body.purpose || ''),
      })
      return 'requestId' in res ? json(res) : json({ error: res.error }, 400)
    }
    if (action === 'approve' || action === 'deny') {
      if (action === 'approve') {
        const linkRows = (await sql`
          SELECT link_spend_request_id FROM hire_spend_approvals
          WHERE id = ${String(body.requestId || '')} AND user_id = ${user.id} LIMIT 1
        `) as Array<{ link_spend_request_id: string | null }>
        if (linkRows[0]?.link_spend_request_id) return json({ error: 'Approve this purchase in Link.' }, 409)
      }
      const ok = await decideSpendApproval(sql, user.id, String(body.requestId || ''), action)
      return ok ? json({ ok: true }) : json({ error: 'No pending request with that id.' }, 404)
    }
    if (action === 'charge') {
      const res = await chargeApprovedSpend(sql, user.id, String(body.requestId || ''))
      return res.ok ? json(res) : json({ error: res.error, decision: res.decision }, 409)
    }
    return json({ error: 'action must be create, approve, deny, or charge.' }, 400)
  }

  // Pending spend requests for the approvals UI.
  if (path === '/api/payments/spend' && req.method === 'GET') {
    const rows = (await sql`
      SELECT id, amount_cents, merchant, purpose, status, created_at, last_error, link_approval_url
      FROM hire_spend_approvals WHERE user_id = ${user.id} ORDER BY created_at DESC LIMIT 20
    `) as Array<{ id: string; amount_cents: number; merchant: string; purpose: string; status: string; created_at: Date; last_error: string | null; link_approval_url: string | null }>
    return json({
      requests: rows.map((r) => ({
        ...r,
        amount: `$${(r.amount_cents / 100).toFixed(2)}`,
        pending: r.status === 'pending',
        approval_url: r.link_approval_url,
      })),
      cap_cents: spendCapCents(),
    })
  }

  return null
}

/** Webhook branch for setup-mode completes: nothing to store beyond what the
 * customer already has — this only marks the connect flow done in logs. Call
 * from the billing webhook before its subscription handling. */
export async function noteSetupCompleted(event: { data?: { object?: { customer?: string; metadata?: Record<string, string> } } }): Promise<void> {
  const obj = event.data?.object
  if (obj?.metadata?.purpose === 'user_wallet' && obj.customer) {
    console.log(`[payments] wallet connected for customer ${obj.customer} (user ${obj.metadata.user_id || '?'})`)
  }
}
