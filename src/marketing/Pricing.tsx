import type { AgentId } from '../agents/types'
import { useState } from 'react'
import { planFor } from './format'

type Tier = 'free' | 'single' | 'bundle' | 'ultra'

const TIERS: { id: Tier; name: string; price: string; per: string; blurb: string; badge?: string; cta: string }[] = [
  {
    id: 'free',
    name: 'Free',
    price: '$0',
    per: 'forever',
    blurb: '1 brief a week. 1 hire.',
    cta: 'Start free',
  },
  {
    id: 'single',
    name: 'Single hire',
    price: '$19',
    per: 'a month',
    blurb: 'One hire. Unlimited texts. Apps in the thread.',
    badge: 'Most picked',
    cta: 'Hire one',
  },
  {
    id: 'bundle',
    name: 'All three',
    price: '$39',
    per: 'a month',
    blurb: 'Friend, Coworker, and Cofounder. Save $18.',
    badge: 'Best value',
    cta: 'Hire all three',
  },
  {
    id: 'ultra',
    name: 'Ultra',
    price: '$199',
    per: 'a month',
    blurb: 'All hires, priority replies, and real phone calls.',
    cta: 'Go Ultra',
  },
]

/** Plan names the billing endpoint expects, with the annual variant folded in. */
export function Pricing() {
  const [email, setEmail] = useState('')
  const [hire, setHire] = useState<AgentId>('friend')
  const [annual, setAnnual] = useState(false)
  const [busy, setBusy] = useState('')
  const [note, setNote] = useState('')

  async function checkout(tier: Tier) {
    const emailValue = email.trim().toLowerCase()
    if (!emailValue) {
      setNote('Leave your email so the bill has somewhere to go.')
      return
    }
    setBusy(tier)
    setNote('')
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
      setNote("Billing coming soon. You're on the list.")
    } catch {
      setNote("Billing coming soon. You're on the list.")
    } finally {
      setBusy('')
    }
  }

  return (
    <section className="pricing section" id="pricing" aria-labelledby="pricing-heading">
      <div className="container">
        <p className="deed__eyebrow">Pricing</p>
        <h2 id="pricing-heading">Hire one. Or the whole bench.</h2>

        <div className="pricing__setup">
          <input
            type="email"
            placeholder="you@example.com"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            aria-label="Email for the bill"
          />
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
              </button>
            ))}
          </div>
          <label className="pricing__annual">
            <input type="checkbox" checked={annual} onChange={(e) => setAnnual(e.target.checked)} />
            2 months free annual
          </label>
        </div>

        <div className="pricing__grid">
          {TIERS.map((tier) => (
            <article key={tier.id} className={`price-card${tier.badge ? ' price-card--hot' : ''}`}>
              {tier.badge && <span className="price-card__badge">{tier.badge}</span>}
              <h3>{tier.name}</h3>
              <p className="price-card__price">
                <strong>{tier.price}</strong>
                <span>{tier.per}</span>
              </p>
              <p className="price-card__blurb">{tier.blurb}</p>
              <button
                type="button"
                className={`btn ${tier.badge ? 'btn--accent' : 'btn--ghost'}`}
                disabled={busy === tier.id}
                onClick={() => void checkout(tier.id)}
              >
                {busy === tier.id ? 'Opening…' : tier.cta}
              </button>
            </article>
          ))}
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
