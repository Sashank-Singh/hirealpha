/**
 * Per-user payment connection — the "user connects their OWN wallet" pillar.
 *
 * Trust model (stated as code):
 *  - The operator's account never funds anything. Each user gets their own
 *    Stripe Customer (namespace `stripe_payment_customer` on hire_users,
 *    separate from the subscription customer), connects their own card via
 *    Checkout setup mode — Link users get Link autofill there automatically.
 *  - A charge is ask-first, twice over: the user must have an approved
 *    spend request for THIS amount to THIS merchant, consumed atomically by
 *    the PaymentIntent call, and the amount is capped (USER_SPEND_MAX_CENTS).
 *  - Plaintext card data never touches this server — Stripe holds it; we
 *    store nothing but customer ids and brand/last4 views.
 */
import { randomUUID } from 'node:crypto'
import type { SQL } from 'bun'

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
  const amount = Math.floor(input.amountCents)
  if (!Number.isFinite(amount) || amount < 50) return { error: 'Minimum charge is $0.50.' }
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
  if (!methods.length) return { ok: false, error: 'No card connected yet.' }
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
  if (!intent.ok) {
    const msg = String(intent.data?.error?.message || 'The charge was declined.')
    await sql`UPDATE hire_spend_approvals SET last_error = ${msg} WHERE id = ${requestId}`
    return { ok: false, error: msg }
  }
  await sql`UPDATE hire_spend_approvals SET payment_intent_id = ${String(intent.data.id)} WHERE id = ${requestId}`
  return { ok: true, paymentIntentId: String(intent.data.id) }
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

export type UserPaymentsDeps = {
  resolveUser: (sql: SQL, req: Request) => Promise<{ id: string } | null>
}

async function userEmail(sql: SQL, userId: string): Promise<string> {
  const rows = (await sql`SELECT email FROM hire_users WHERE id = ${userId} LIMIT 1`) as Array<{ email: string | null }>
  return rows[0]?.email || ''
}

/** Returns null for paths it does not own. All routes require a signed-in user. */
export async function handleUserPaymentsApi(req: Request, sql: SQL, deps: UserPaymentsDeps): Promise<Response | null> {
  const url = new URL(req.url)
  const path = url.pathname
  if (!path.startsWith('/api/payments')) return null

  const user = await deps.resolveUser(sql, req)
  if (!user) return json({ error: 'Sign in first.' }, 401)
  if (!stripeKey()) return json({ error: 'Stripe is not configured on this server.' }, 503)

  const email = await userEmail(sql, user.id)

  // Start the connect flow: Checkout setup mode on the user's own customer.
  if (path === '/api/payments/connect' && req.method === 'POST') {
    const session = await createConnectSession(sql, req, user.id, email)
    return session.url ? json({ url: session.url }) : json({ error: session.error }, 400)
  }

  // Saved methods (masked views only — brand/last4).
  if (path === '/api/payments/methods' && req.method === 'GET') {
    const rows = (await sql`
      SELECT stripe_payment_customer FROM hire_users WHERE id = ${user.id} LIMIT 1
    `) as Array<{ stripe_payment_customer: string | null }>
    const customerId = rows[0]?.stripe_payment_customer
    if (!customerId) return json({ methods: [] })
    return json({ methods: await listPaymentMethods(customerId) })
  }

  // Remove a saved method.
  if (path === '/api/payments/methods' && req.method === 'DELETE') {
    const id = url.searchParams.get('id') || ''
    if (!id.startsWith('pm_')) return json({ error: 'That is not a payment method id.' }, 400)
    const rows = (await sql`
      SELECT stripe_payment_customer FROM hire_users WHERE id = ${user.id} LIMIT 1
    `) as Array<{ stripe_payment_customer: string | null }>
    const customerId = rows[0]?.stripe_payment_customer
    if (!customerId) return json({ error: 'No wallet connected.' }, 404)
    // Ownership fence: the method must belong to THIS user's customer.
    const own = await listPaymentMethods(customerId)
    if (!own.some((m) => m.id === id)) return json({ error: 'Not found.' }, 404)
    const detached = await stripeCall('POST', `/payment_methods/${encodeURIComponent(id)}/detach`)
    return detached.ok ? json({ ok: true }) : json({ error: detached.data?.error?.message || 'Detach failed.' }, 400)
  }

  // Spend requests: create → pending; user approves/denies; charge consumes.
  if (path === '/api/payments/spend' && req.method === 'POST') {
    const body = (await req.json().catch(() => ({}))) as { action?: string; requestId?: string; amountCents?: number; merchant?: string; purpose?: string }
    const action = body.action || 'create'
    if (action === 'create') {
      const res = await createSpendRequest(sql, user.id, {
        amountCents: Number(body.amountCents),
        merchant: String(body.merchant || ''),
        purpose: String(body.purpose || ''),
      })
      return res.requestId ? json(res) : json({ error: res.error }, 400)
    }
    if (action === 'approve' || action === 'deny') {
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
      SELECT id, amount_cents, merchant, purpose, status, created_at, last_error
      FROM hire_spend_approvals WHERE user_id = ${user.id} ORDER BY created_at DESC LIMIT 20
    `) as Array<{ id: string; amount_cents: number; merchant: string; purpose: string; status: string; created_at: Date; last_error: string | null }>
    return json({
      requests: rows.map((r) => ({
        ...r,
        amount: `$${(r.amount_cents / 100).toFixed(2)}`,
        pending: r.status === 'pending',
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
