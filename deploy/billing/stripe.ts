import { createHmac, timingSafeEqual } from 'node:crypto'
import type { SQL } from 'bun'
import { isPersona, type Persona } from '../personas'
import { json } from '../utils/http'
import { noteSetupCompleted, queuePaidPurchaseFinalization } from '../userPayments'

export function paymentsOn(): boolean {
  return process.env.HIREALPHA_PAYMENTS === '1'
}

export function stripeSecret(): string {
  return process.env.STRIPE_SECRET_KEY?.trim() || ''
}

export function appBaseFromEnv(): string {
  return process.env.APP_BASE_URL?.trim() || 'https://hirealpha.chat'
}

export function stripePriceFor(persona: Persona): string {
  const key =
    persona === 'friend'
      ? 'STRIPE_PRICE_FRIEND'
      : persona === 'coworker'
        ? 'STRIPE_PRICE_COWORKER'
        : 'STRIPE_PRICE_COFOUNDER'
  return process.env[key]?.trim() || ''
}

export function stripePromoPrice(): string {
  return process.env.STRIPE_PRICE_FRIEND_PROMO?.trim() || ''
}

export function billingConfigured(persona: Persona): boolean {
  return !!stripeSecret() && !!stripePriceFor(persona)
}

const STRIPE_ACTIVE_STATUSES = new Set(['active', 'trialing'])

export function subscriptionActive(status: string): boolean {
  return STRIPE_ACTIVE_STATUSES.has(status)
}

/** Stripe signs webhooks as `t=timestamp,v1=hmac` over `${t}.${rawBody}`. */
export function verifyStripeSignature(payload: string, header: string, secret: string): boolean {
  const parts = Object.fromEntries(
    header.split(',').map((kv) => kv.split('=') as [string, string]),
  )
  const t = parts['t']
  const v1 = parts['v1']
  if (!t || !v1) return false
  // Replay window: Stripe recommends tolerating some clock skew; 5 minutes.
  if (Math.abs(Date.now() / 1000 - Number(t)) > 300) return false
  const expected = createHmac('sha256', secret).update(`${t}.${payload}`).digest('hex')
  const a = Buffer.from(expected)
  const b = Buffer.from(v1)
  return a.length === b.length && timingSafeEqual(a, b)
}

export async function stripeRequest(
  path: string,
  params: URLSearchParams,
  method: 'POST' | 'GET' = 'POST',
): Promise<Record<string, unknown>> {
  const res = await fetch(`https://api.stripe.com/v1${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${stripeSecret()}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    // GET must not carry a body; params are for POST form data.
    ...(method === 'POST' ? { body: params } : {}),
  })
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>
  if (!res.ok) {
    const err = data['error'] as { message?: string; code?: string } | undefined
    const thrown = new Error(err?.message || `stripe ${path} failed (${res.status})`)
    // Stripe's machine-readable code (e.g. resource_already_exists) lets
    // callers do create-or-reuse; keep it attached to the error.
    if (err?.code) (thrown as Error & { code?: string }).code = err.code
    throw thrown
  }
  return data
}

export async function upsertSubscription(
  sql: SQL,
  opts: {
    userId: string
    persona: Persona | 'all'
    stripeSubscriptionId?: string | null
    stripeCustomerId?: string | null
    status: string
    priceId?: string | null
    currentPeriodEnd?: Date | null
    promoStartedAt?: Date | null
  },
): Promise<void> {
  await sql`
    INSERT INTO hire_subscriptions (id, user_id, persona, stripe_customer_id, stripe_subscription_id, status, price_id, current_period_end, promo_started_at)
    VALUES (${crypto.randomUUID()}, ${opts.userId}, ${opts.persona}, ${opts.stripeCustomerId || null}, ${opts.stripeSubscriptionId || null}, ${opts.status}, ${opts.priceId || null}, ${opts.currentPeriodEnd || null}, ${opts.promoStartedAt || null})
    ON CONFLICT (user_id, persona) DO UPDATE SET
      stripe_customer_id = EXCLUDED.stripe_customer_id,
      stripe_subscription_id = EXCLUDED.stripe_subscription_id,
      status = EXCLUDED.status,
      price_id = EXCLUDED.price_id,
      current_period_end = EXCLUDED.current_period_end,
      promo_started_at = COALESCE(EXCLUDED.promo_started_at, hire_subscriptions.promo_started_at),
      updated_at = now()
  `
}

export async function handleBillingWebhook(req: Request, sql: SQL): Promise<Response> {
  const secret = process.env.STRIPE_WEBHOOK_SECRET?.trim() || ''
  const payload = await req.text()
  if (!secret || !verifyStripeSignature(payload, req.headers.get('stripe-signature') || '', secret)) {
    return json({ error: 'Bad signature' }, 400)
  }
  let event: {
    type?: string
    data?: { object?: Record<string, unknown> }
  }
  try {
    event = JSON.parse(payload)
  } catch {
    return json({ error: 'Invalid JSON' }, 400)
  }

  const obj = event.data?.object || {}
  const type = event.type || ''
  if (type === 'payment_intent.succeeded') {
    const result = await queuePaidPurchaseFinalization(sql, obj)
    if (result.status === 'ignored') {
      console.log(`[purchase] ignored payment_intent.succeeded: ${result.reason}`)
    } else {
      console.log(`[purchase] finalization ${result.status}${'jobId' in result ? ` (${result.jobId})` : ''}`)
    }
  } else if (type === 'checkout.session.completed') {
    // Wallet-connect sessions (mode=setup, purpose=user_wallet) carry no
    // subscription — log and return before the subscription machinery.
    const metadata = obj['metadata'] as Record<string, unknown> | undefined
    if (String(metadata?.purpose || '') === 'user_wallet') {
      await noteSetupCompleted({ data: { object: obj as Record<string, unknown> } })
      return new Response('ok')
    }
    // client_reference_id is `${userId}:${persona}` set at checkout creation.
    const ref = String(obj['client_reference_id'] || '')
    const [userId, persona] = ref.split(':')
    const subscriptionId = typeof obj['subscription'] === 'string' ? obj['subscription'] : null
    const customerId = typeof obj['customer'] === 'string' ? obj['customer'] : null
    const promoPrice = stripePromoPrice()

    // Friend monthly with the promo: Stripe's checkout cannot run schedules,
    // so the checkout sub is just the first $5 month. Convert it to the real
    // lifecycle here — the promo price for two months, then the regular price
    // forever — and let Stripe's schedule drive the rest.
    if (
      subscriptionId &&
      customerId &&
      persona === 'friend' &&
      stripePromoPrice()
    ) {
      try {
        const remote = (await stripeRequest(
          `/subscriptions/${subscriptionId}`,
          new URLSearchParams(),
        )) as {
          items?: { data?: Array<{ id: string; price?: { id: string } }> }
          metadata?: Record<string, string>
          trial_end?: number | null
          status?: string
        }
        const item = remote.items?.data?.[0]
        const onPromo = item?.price?.id === stripePromoPrice()
        const alreadyScheduled = String(remote.metadata?.promo_scheduled || '').length > 0
        if (onPromo && item?.id && !alreadyScheduled) {
          // Mark the subscription FIRST so a webhook retry cannot double-build
          // the schedule (Stripe replays events; the metadata write is the lock).
          await stripeRequest(
            `/subscriptions/${subscriptionId}`,
            new URLSearchParams({ 'metadata[promo_scheduled]': 'true' }),
          )
          // Cancel this sub at period end and replace it with the schedule.
          await stripeRequest(
            `/subscriptions/${subscriptionId}`,
            new URLSearchParams({ cancel_at_period_end: 'true' }),
          )
          const nowSec = Math.floor(Date.now() / 1000)
          // A trialing checkout hands over to the schedule when the trial ends;
          // otherwise the schedule starts now. Starting it mid-trial would bill
          // the first $5 before the free days are up.
          const start = remote.trial_end && remote.trial_end > nowSec ? remote.trial_end : nowSec
          const regular = stripePriceFor('friend')
          // Phase 1: two $5 months (bounded by an end date — this API version
          // rejects phases[iterations]), phase 2: $19 forever (open-ended).
          const promoEnd = start + 61 * 24 * 60 * 60
          await stripeRequest('/subscription_schedules', new URLSearchParams({
            customer: customerId,
            start_date: String(start),
            'phases[0][items][0][price]': stripePromoPrice(),
            'phases[0][items][0][quantity]': '1',
            'phases[0][end_date]': String(promoEnd),
            'phases[1][items][0][price]': regular,
            'phases[1][items][0][quantity]': '1',
          }))
        }
      } catch (err) {
        console.error('[billing] promo schedule conversion failed', err)
      }
    }
    // 'all' is the synthetic persona a bundle checkout writes; it owns one
    // subscription row that covers every hire.
    if (userId && persona && (isPersona(persona) || persona === 'all') && subscriptionId) {
      // The session completes before the subscription ticks active; fetch it
      // so the row starts in Stripe's own state rather than guessed state.
      let status = 'active'
      let currentPeriodEnd: Date | null = null
      try {
        const sub = (await stripeRequest(
          `/subscriptions/${subscriptionId}`,
          new URLSearchParams(),
        )) as { status?: string; current_period_end?: number }
        if (sub.status) status = sub.status
        if (sub.current_period_end) currentPeriodEnd = new Date(sub.current_period_end * 1000)
      } catch (err) {
        console.error('[billing] subscription fetch after checkout failed', err)
      }
      await upsertSubscription(sql, {
        userId,
        persona,
        stripeSubscriptionId: subscriptionId,
        stripeCustomerId: customerId,
        status,
        currentPeriodEnd,
        promoStartedAt: promoPrice ? new Date() : null,
      })
    }
  } else if (type === 'customer.subscription.updated' || type === 'customer.subscription.deleted') {
    const subscriptionId = String(obj['id'] || '')
    const status = String(obj['status'] || (type.endsWith('deleted') ? 'canceled' : ''))
    if (subscriptionId && status) {
      const periodEnd = typeof obj['current_period_end'] === 'number' ? new Date(obj['current_period_end'] * 1000) : null
      await sql`
        UPDATE hire_subscriptions SET status = ${status}, current_period_end = ${periodEnd}, updated_at = now()
        WHERE stripe_subscription_id = ${subscriptionId}
      `
    }
  }
  return json({ received: true })
}

/** Upgrade promo subscriptions ($5/mo) to regular price ($19/mo) after 60 days.
 *  Called daily from the web server. Safe to run multiple times — only touches
 *  subscriptions where promo_started_at is older than 60 days. */
export async function upgradePromoSubscriptions(sql: SQL): Promise<void> {
  const promoPrice = stripePromoPrice()
  const regularPrice = stripePriceFor('friend')
  if (!promoPrice || !regularPrice || !stripeSecret()) return

  const stale = (await sql`
    SELECT id, stripe_subscription_id, user_id
    FROM hire_subscriptions
    WHERE promo_started_at IS NOT NULL
      AND promo_started_at < now() - interval '60 days'
      AND status IN ('active', 'trialing')
      AND price_id = ${promoPrice}
  `) as Array<{ id: string; stripe_subscription_id: string; user_id: string }>

  for (const sub of stale) {
    try {
      // The price swap targets the subscription ITEM (si_...), which only
      // Stripe knows — our table stores the subscription id (sub_...). The
      // old code passed sub_... as the item id and Stripe rejected it, so the
      // day-60 upgrade never fired and promo customers stayed at $5 forever.
      const remote = (await stripeRequest(
        `/subscriptions/${sub.stripe_subscription_id}`,
        new URLSearchParams(),
      )) as { items?: { data?: Array<{ id: string }> } }
      const itemId = remote.items?.data?.[0]?.id
      if (!itemId) throw new Error('no subscription item on remote sub')
      await stripeRequest(
        `/subscriptions/${sub.stripe_subscription_id}`,
        new URLSearchParams({
          'items[0][id]': itemId,
          'items[0][price]': regularPrice,
          proration_behavior: 'create_prorations',
        }),
      )
      await sql`
        UPDATE hire_subscriptions
        SET price_id = ${regularPrice}, promo_started_at = NULL, updated_at = now()
        WHERE id = ${sub.id}
      `
      console.log(`[billing] upgraded promo sub ${sub.id} user ${sub.user_id} to ${regularPrice}`)
    } catch (err) {
      console.error(`[billing] promo upgrade failed for ${sub.id}`, err)
    }
  }
  if (stale.length) console.log(`[billing] promo upgrade check: ${stale.length} subscriptions upgraded`)
}
