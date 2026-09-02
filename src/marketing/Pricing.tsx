import { useState } from 'react'
import { getSession } from '../platform/roster'

export type Tier = 'free' | 'single' | 'bundle' | 'ultra'

export const TIERS: { id: Tier; name: string; price: number; promo?: number; per: string; blurb: string; badge?: string; cta: string; soon?: boolean }[] = [
  {
    id: 'free',
    name: 'Free',
    price: 0,
    per: 'forever',
    blurb: 'Alpha Lite. One brief a week. One hire: Alpha the Friend. Core apps only.',
    cta: 'Start free',
  },
  {
    id: 'single',
    name: 'Single hire',
    price: 19,
    promo: 5,
    per: 'a month',
    blurb: 'Alpha the Friend. Unlimited texts. Apps in the thread.',
    badge: 'Live now',
    cta: 'Hire Alpha',
  },
  {
    id: 'bundle',
    name: 'All three',
    price: 39,
    per: 'a month',
    blurb: 'Friend, Coworker, and Cofounder. Save $18. Coworker and Cofounder are coming soon.',
    badge: 'Best value',
    cta: 'Hire all three',
    soon: true,
  },
  {
    id: 'ultra',
    name: 'Ultra',
    price: 199,
    per: 'a month',
    blurb: 'Everything, plus real phone calls. Calls are Ultra only. The full crew, when it lands.',
    cta: 'Go Ultra',
    soon: true,
  },
]

/** Display price reacts to the billing period. Annual figures are monthly x 10
 * (2 months free) and must stay in sync with the STRIPE_PRICE_*_ANNUAL envs. */
function displayPrice(tier: { id: Tier; price: number; promo?: number; per: string }, annual: boolean) {
  if (tier.id === 'free') return { price: '$0', per: 'forever', freebie: '', was: '' }
  if (annual) {
    return {
      price: '$' + (tier.price * 10).toLocaleString('en-US'),
      per: 'a year',
      freebie: '2 months free',
      was: '',
    }
  }
  // Intro deal on the monthly single: 7 days free to start, then $5 for two
  // months, then the real price. The old price stays visible, struck through.
  if (tier.promo) {
    return {
      price: '$' + tier.promo,
      per: 'a month',
      freebie: '7 days free, then $5 for 2 months',
      was: '$' + tier.price,
    }
  }
  return { price: '$' + tier.price, per: 'a month', freebie: '', was: '' }
}

/** Checkout needs an email and nothing else: a known account fires Stripe
 * immediately, a fresh visitor types theirs into the card and follows it.
 * Free has nothing to charge, so it walks to the signup form. */
async function choosePlan(tier: Tier, annual: boolean, email?: string) {
  if (tier === 'free') {
    document.getElementById('waitlist')?.scrollIntoView({ behavior: 'smooth' })
    return { ok: false, needsEmail: false }
  }
  const fromSession = getSession()?.email || ''
  const use = email || fromSession
  if (!use.includes('@')) return { ok: false, needsEmail: true }
  const plan = annual ? `${tier}-annual` : tier
  const res = await fetch('/api/billing/checkout', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: use, hire: 'friend', plan, trial_days: 7 }),
  })
  const data = (await res.json().catch(() => ({}))) as { url?: string }
  if (data.url) {
    window.location.href = data.url
    return { ok: true, needsEmail: false }
  }
  return { ok: false, needsEmail: true }
}

export function Pricing() {
  const [annual, setAnnual] = useState(false)


  return (
    <section className="pricing section" id="pricing" aria-labelledby="pricing-heading">
      <div className="container">
        <p className="deed__eyebrow">Pricing</p>
        <h2 id="pricing-heading">Hire Alpha. The bench is coming.</h2>
        <p className="pricing__sub">
          Sign up once below. Pick your plan now or later, the first text is the same.
        </p>

        <div className="pricing__controls">
          <div className="billing-toggle" role="radiogroup" aria-label="Billing period">
            <button
              type="button"
              role="radio"
              aria-checked={!annual}
              className={`billing-toggle__opt${!annual ? ' is-on' : ''}`}
              onClick={() => setAnnual(false)}
            >
              Monthly
            </button>
            <button
              type="button"
              role="radio"
              aria-checked={annual}
              className={`billing-toggle__opt${annual ? ' is-on' : ''}`}
              onClick={() => setAnnual(true)}
            >
              Yearly
              <span className="billing-toggle__badge">2 months free</span>
            </button>
          </div>
        </div>

        <div className="pricing__grid">
          {TIERS.map((tier) => {
            const shown = displayPrice(tier, annual)
            return (
              <article key={tier.id} className={`price-card${tier.badge ? ' price-card--hot' : ''}`}>
                {tier.badge && <span className="price-card__badge">{tier.badge}</span>}
                <h3>{tier.name}</h3>
                <p className="price-card__price">
                  {shown.was && <s className="price-card__was">{shown.was}</s>}
                  <strong>{shown.price}</strong>
                  <span>{shown.per}</span>
                </p>
                {shown.freebie && <p className="price-card__freebie">{shown.freebie}</p>}
                <p className="price-card__blurb">{tier.blurb}</p>
                {tier.soon ? (
                  <button type="button" className="btn btn--ghost" disabled aria-disabled="true">
                    Coming soon
                  </button>
                ) : (
                  <>
                    <button
                      type="button"
                      className={`btn ${tier.badge ? 'btn--accent' : 'btn--ghost'}`}
                      onClick={() => void choosePlan(tier.id, annual)}
                    >
                      {tier.cta}
                    </button>
                  </>
                )}
              </article>
            )
          })}
        </div>

        <p className="pricing__family">One bill, many numbers. Ask us.</p>
      </div>
    </section>
  )
}
