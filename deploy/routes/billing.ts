import type { SQL } from 'bun'
import { isPersona, PERSONAS, type Persona } from '../personas'
import { appBase, json } from '../utils/http'
import { ensureUser, getUserByEmail } from '../db/users'
import {
  handleBillingWebhook,
  paymentsOn,
  stripePromoPrice,
  stripeRequest,
  stripeSecret,
  subscriptionActive,
} from '../billing/stripe'

export async function handleBillingRoutes(req: Request, sql: SQL): Promise<Response | null> {
  const url = new URL(req.url)
  const path = url.pathname

  if (path === '/api/billing/status' && req.method === 'GET') {
    const email = String(url.searchParams.get('email') || '')
      .trim()
      .toLowerCase()
    const user = email.includes('@') ? await getUserByEmail(sql, email) : null
    if (!user) return json({ error: 'Sign in first' }, 401)
    const rows = (await sql`
      SELECT persona, status, current_period_end AS "currentPeriodEnd"
      FROM hire_subscriptions WHERE user_id = ${user.id}
    `) as Array<{ persona: Persona | 'all'; status: string; currentPeriodEnd: string | null }>
    const hires: Record<string, boolean> = {}
    for (const p of PERSONAS) hires[p] = false
    for (const row of rows) {
      if (row.persona === 'all') {
        // A bundle covers every hire at once.
        if (subscriptionActive(row.status)) for (const p of PERSONAS) hires[p] = true
        continue
      }
      hires[row.persona] = subscriptionActive(row.status)
    }
    const subscriptions = rows.map((r) => ({
      persona: r.persona,
      status: r.status,
      currentPeriodEnd: r.currentPeriodEnd,
    }))
    return json({ hires, subscriptions })
  }

  if (path === '/api/billing/manage' && req.method === 'GET') {
    // Stripe customer portal: where a user cancels or updates the card.
    const email = String(url.searchParams.get('email') || '')
      .trim()
      .toLowerCase()
    const user = email.includes('@') ? await getUserByEmail(sql, email) : null
    if (!user) return json({ error: 'Sign in first' }, 401)
    const rows = (await sql`
      SELECT stripe_customer_id AS "stripeCustomerId"
      FROM hire_subscriptions
      WHERE user_id = ${user.id} AND stripe_customer_id IS NOT NULL
      LIMIT 1
    `) as Array<{ stripeCustomerId: string }>
    const customer = rows[0]?.stripeCustomerId
    if (!customer) return json({ error: 'No billing account yet' }, 404)
    if (!stripeSecret()) return json({ error: 'Billing is not configured on the server yet.' }, 503)
    try {
      const session = (await stripeRequest(
        '/billing_portal/sessions',
        new URLSearchParams({
          customer,
          return_url: `${appBase(req)}/app`,
        }),
      )) as { url?: string }
      if (!session.url) throw new Error('Portal session returned no URL')
      return json({ url: session.url })
    } catch (err) {
      return json(
        { error: err instanceof Error ? err.message : 'Could not open billing portal' },
        502,
      )
    }
  }

  if (path === '/api/billing/webhook' && req.method === 'POST') {
    return handleBillingWebhook(req, sql)
  }

  if (path === '/api/billing/checkout' && req.method === 'POST') {
    /* Free mode: signup must not touch Stripe. Every client treats a response
     * with no `url` as "carry on into the app", which is exactly the skip the
     * founder asked for — so the whole paid path below stays as it is and this
     * one early return is the switch. */
    if (!paymentsOn()) {
      return json({
        ok: true,
        free: true,
        url: null,
        message: 'HireAlpha is free while it is in beta. No card, no trial to cancel.',
      })
    }
    const body = (await req.json().catch(() => ({}))) as {
      email?: string
      hire?: string
      plan?: string
      interval?: string
      trial_days?: number
      discount?: string
    }
    const email = String(body.email || '')
      .trim()
      .toLowerCase()
    // The landing page folds the billing period into the plan name ("bundle-annual");
    // accept both that shape and the split plan+interval form.
    const rawPlan = String(body.plan || '')
    const basePlan = rawPlan.endsWith('-annual') ? rawPlan.slice(0, -'-annual'.length) : rawPlan
    const plan = basePlan === 'bundle' || basePlan === 'ultra' || basePlan === 'free' ? basePlan : 'single'
    const annual = body.interval === 'annual' || rawPlan.endsWith('-annual')
    let promoApplied = false
    const persona = String(body.hire || (body as { persona?: string }).persona || '')
    if (!email.includes('@') || (plan === 'single' && !isPersona(persona))) {
      return json({ error: 'email and hire required' }, 400)
    }
    // Bundle and ultra are one subscription for every hire, stored under the
    // synthetic persona 'all'; single keeps the per-hire rows it always had.
    const effectivePersona = plan === 'single' ? (persona as Persona | 'all') : 'all'
    const priceFor = (per: string, isAnnual: boolean) => {
      const keys =
        plan === 'free'
          ? ['STRIPE_PRICE_FREE']
          : plan === 'bundle'
            ? ['STRIPE_PRICE_BUNDLE']
            : plan === 'ultra'
              ? ['STRIPE_PRICE_ULTRA']
              : [`STRIPE_PRICE_${per.toUpperCase()}`]
      const envs = isAnnual && plan !== 'free' ? keys.map((k) => `${k}_ANNUAL`) : keys
      return envs.map((k) => process.env[k]?.trim() || '').find(Boolean) || ''
    }
    let priceId = priceFor(persona, annual)
    // Promo: $5/mo for first 2 months on Friend monthly (non-annual, single plan)
    const promoPrice = stripePromoPrice()
    if (plan === 'single' && persona === 'friend' && !annual && promoPrice) {
      priceId = promoPrice
      promoApplied = true
    }
    // An annual price that was never configured quietly falls back to monthly
    // rather than failing checkout; the response says so.
    let fallback = false
    if (!priceId && annual) {
      priceId = priceFor(persona, false)
      fallback = true
    }
    if (!stripeSecret() || !priceId) return json({ error: 'Billing is not set up yet' }, 503)
    // Guest checkout: the email on the checkout session IS the account. A brand
    // new visitor should reach Stripe without signing up first; the account is
    // created here and awaits their number whenever they land.
    let user = await getUserByEmail(sql, email)
    if (!user) user = await ensureUser(sql, email)
    const trialDays = Number(body.trial_days) > 0 ? Math.floor(Number(body.trial_days)) : 7
    // A $0 plan with a trial attached is just a longer forms experience. Stripe
    // rejects trial_period_days of 0 outright, so the free plan omits the param.
    const effectiveTrialDays = plan === 'free' ? null : trialDays
    // Referral free month: an unspent credit becomes a 100% off coupon on the
    // first invoice. The credit is marked used at checkout creation, not at
    // completion, so an abandoned session burns it (accepted for v1).
    // trial_days stays as-is; the coupon already covers the first invoice and
    // a trial would double-free the same month. Email-only accounts have no
    // phone, earn nothing, and spend nothing.
    let referralCouponId = ''
    if (!body.discount && user.phone) {
      const creditRows = (await sql`
        SELECT id FROM hire_referral_credits
        WHERE phone_e164 = ${user.phone} AND used_at IS NULL
        ORDER BY created_at LIMIT 1
      `) as Array<{ id: string }>
      const credit = creditRows[0]
      if (credit) {
        const couponId = `referral-${user.id}`
        try {
          await stripeRequest(
            '/coupons',
            new URLSearchParams({
              id: couponId,
              percent_off: '100',
              duration: 'once',
              name: 'Referral free month',
            }),
          )
          referralCouponId = couponId
        } catch (err) {
          if ((err as Error & { code?: string }).code === 'resource_already_exists') {
            try {
              const coupon = await stripeRequest(`/coupons/${couponId}`, new URLSearchParams(), 'GET')
              if (coupon['id'] === couponId) referralCouponId = couponId
            } catch (fetchErr) {
              console.error('[billing] referral coupon fetch failed', fetchErr)
            }
          } else {
            console.error('[billing] referral coupon create failed', err)
          }
        }
        if (referralCouponId) {
          await sql`
            UPDATE hire_referral_credits SET used_at = now(), used_for_persona = ${effectivePersona}
            WHERE id = ${credit.id} AND used_at IS NULL
          `
        }
      }
    }
    const params = new URLSearchParams({
      mode: 'subscription',
      customer_email: email,
      client_reference_id: `${user.id}:${effectivePersona}`,
      'line_items[0][price]': priceId,
      'line_items[0][quantity]': '1',
      // Guest buyers have no session yet: land them on login to set a
      // password, which claims the account this checkout just created.
      success_url: `${appBase(req)}/app/login`,
      cancel_url: `${appBase(req)}/app/login`,
      'subscription_data[metadata][user_id]': user.id,
      'subscription_data[metadata][persona]': effectivePersona,
      ...(promoApplied
        ? {
            'custom_text[submit][message]':
              'Your first 2 months are $5. Then it is $19 a month. You can cancel anytime.',
          }
        : {}),
      ...(effectiveTrialDays !== null
        ? { 'subscription_data[trial_period_days]': String(effectiveTrialDays) }
        : {}),
    })
    if (referralCouponId) params.set('discounts[0][coupon]', referralCouponId)
    try {
      const session = await stripeRequest('/checkout/sessions', params)
      return json({ url: session['url'], fallback })
    } catch (err) {
      console.error('[billing] checkout session failed', err)
      return json({ error: 'Could not start checkout' }, 502)
    }
  }

  return null
}
