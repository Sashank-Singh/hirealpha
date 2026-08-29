import type { AgentId } from '../agents/types'
import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { getSession } from '../platform/roster'
import { planFor } from './format'

type Tier = 'free' | 'single' | 'bundle' | 'ultra'

/* Alpha the Friend is the product today. Coworker and Cofounder are visible
 * everywhere but not buyable until they ship, so the multi-hire tiers stay on
 * the board to sell the roadmap, with the checkout door closed. */
const HIRES_LIVE: AgentId[] = ['friend']

const TIERS: { id: Tier; name: string; price: number; per: string; blurb: string; badge?: string; cta: string; soon?: boolean }[] = [
  {
    id: 'free',
    name: 'Free',
    price: 0,
    per: 'forever',
    blurb: '1 brief a week. 1 hire.',
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

/* Displayed annual figures are monthly x 10 (2 months free) and must be kept
 * in sync with the STRIPE_PRICE_*_ANNUAL env prices the checkout actually
 * charges. If a monthly price changes here, update those env vars too. */
function displayPrice(tier: (typeof TIERS)[number], annual: boolean) {
  const price = tier.id === 'free' ? tier.price : annual ? tier.price * 10 : tier.price
  return {
    price: `$${price.toLocaleString('en-US')}`,
    per: tier.id === 'free' ? tier.per : annual ? 'a year' : tier.per,
    freebie: tier.id !== 'free' && annual ? '2 months free' : '',
  }
}

/** Plan names the billing endpoint expects, with the annual variant folded in. */
export function Pricing() {
  const navigate = useNavigate()
  const [email, setEmail] = useState('')
  const [hire, setHire] = useState<AgentId>('friend')
  const [annual, setAnnual] = useState(false)
  const [busy, setBusy] = useState('')
  const [note, setNote] = useState('')

  async function checkout(tier: Tier) {
    const session = getSession()
    const emailValue = email.trim().toLowerCase() || session?.email?.trim().toLowerCase() || ''

    if (tier === 'free') {
      if (session?.email && session?.phone) {
        navigate('/app')
      } else {
        navigate(emailValue ? `/app/login?email=${encodeURIComponent(emailValue)}` : '/app/login')
      }
      return
    }

    setBusy(tier)
    setNote('')

    if (!emailValue) {
      setBusy('')
      navigate(`/app/login?hire=${hire}&plan=${planFor(tier, annual)}`)
      return
    }

    try {
      const res = await fetch('/api/billing/checkout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: emailValue, hire, plan: planFor(tier, annual) }),
      })
      const data = (await res.json().catch(() => ({}))) as { url?: string; error?: string }
      if (res.ok && data.url) {
        window.location.href = data.url
        return
      }
      navigate(`/app/login?email=${encodeURIComponent(emailValue)}&hire=${hire}&plan=${planFor(tier, annual)}`)
    } catch {
      navigate(`/app/login?email=${encodeURIComponent(emailValue)}&hire=${hire}&plan=${planFor(tier, annual)}`)
    } finally {
      setBusy('')
    }
  }

  return (
    <section className="pricing section" id="pricing" aria-labelledby="pricing-heading">
      <div className="container">
        <p className="deed__eyebrow">Pricing</p>
        <h2 id="pricing-heading">Hire Alpha. The bench is coming.</h2>

        <div className="pricing__setup">
          <input
            type="email"
            placeholder="you@example.com"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            aria-label="Email for the bill"
          />
          <div className="pricing__controls">
            <div className="pricing__hires" role="radiogroup" aria-label="First hire">
              {(['friend', 'coworker', 'cofounder'] as AgentId[]).map((id) => (
                <button
                  key={id}
                  type="button"
                  role="radio"
                  aria-checked={hire === id}
                  className={`pricing__chip${hire === id ? ' is-on' : ''}`}
                  onClick={() => setHire(id)}
                >
                  {id.charAt(0).toUpperCase() + id.slice(1)}
                  {!HIRES_LIVE.includes(id) && <em className="chip-soon">soon</em>}
                </button>
              ))}
            </div>
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
              </button>
            </div>
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
                  disabled={busy === tier.id}
                  onClick={() => void checkout(tier.id)}
                >
                  {busy === tier.id ? 'Opening…' : tier.cta}
                </button>
              )}
            </article>
            )
          })}
        </div>

        {note ? (
          <p className="pricing__note" role="status">
            {note}
          </p>
        ) : (
          <p className="pricing__family">One bill, many numbers. Ask us.</p>
        )}
      </div>
    </section>
  )
}
