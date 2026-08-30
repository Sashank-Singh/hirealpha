import { useState } from 'react'
import { getSession } from '../platform/roster'

type Tier = 'free' | 'single' | 'bundle' | 'ultra'

const TIERS: { id: Tier; name: string; price: number; per: string; blurb: string; badge?: string; cta: string; soon?: boolean }[] = [
  {
    id: 'free',
    name: 'Free',
    price: 0,
    per: 'forever',
    blurb: 'Alpha Lite. One brief a week and one hire (Alpha the Friend), with the core apps only. Alpha will remind you what the paid tiers unlock. Often.',
    cta: 'Start free',
  },
  {
    id: 'single',
    name: 'Single hire',
    price: 19,
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
    blurb: 'Friend, Coworker, and Cofounder. Save $18. Coworker and Cofounder are still in the workshop.',
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
function displayPrice(tier: { id: Tier; price: number; per: string }, annual: boolean) {
  if (tier.id === 'free') return { price: '$0', per: 'forever', freebie: '' }
  if (annual) {
    return {
      price: '$' + (tier.price * 10).toLocaleString('en-US'),
      per: 'a year',
      freebie: '2 months free',
    }
  }
  return { price: '$' + tier.price, per: 'a month', freebie: '' }
}

/** Picking a plan: a known account goes straight to Stripe; a fresh visitor
 * carries the plan down to the single signup form, whose success screen
 * offers checkout with the email it just collected. */
export async function choosePlan(tier: Tier, annual: boolean) {
  const email = getSession()?.email || ''
  if (email.includes('@')) {
    const plan = tier === 'free' ? 'free' : tier
    const res = await fetch('/api/billing/checkout', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, hire: 'friend', plan: annual ? `${plan}-annual` : plan, trial_days: 7 }),
    })
    const data = (await res.json().catch(() => ({}))) as { url?: string }
    if (data.url) {
      window.location.href = data.url
      return
    }
  }
  window.dispatchEvent(new CustomEvent('hirealpha:plan', { detail: { tier, annual } }))
  document.getElementById('waitlist')?.scrollIntoView({ behavior: 'smooth' })
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
                  <button
                    type="button"
                    className={`btn ${tier.badge ? 'btn--accent' : 'btn--ghost'}`}
                    onClick={() => void choosePlan(tier.id, annual)}
                  >
                    {tier.cta}
                  </button>
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
