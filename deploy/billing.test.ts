import { describe, expect, it } from 'bun:test'
import { createHmac } from 'node:crypto'
import { subscriptionActive, verifyStripeSignature } from './hire-api'

/* Billing runs unattended against real money events, so the two things that
 * can silently corrupt state — a forged webhook and a wrong active-status
 * read — are pinned here. */

const SECRET = 'whsec_test_123'

function signedHeader(payload: string, secret = SECRET, timestamp = Math.floor(Date.now() / 1000)) {
  const v1 = createHmac('sha256', secret).update(`${timestamp}.${payload}`).digest('hex')
  return `t=${timestamp},v1=${v1}`
}

describe('verifyStripeSignature', () => {
  it('accepts a correctly signed payload', () => {
    const payload = JSON.stringify({ id: 'evt_1', type: 'checkout.session.completed' })
    expect(verifyStripeSignature(payload, signedHeader(payload), SECRET)).toBe(true)
  })

  it('rejects a signature made with a different secret', () => {
    const payload = '{"id":"evt_1"}'
    expect(verifyStripeSignature(payload, signedHeader(payload, 'whsec_other'), SECRET)).toBe(false)
  })

  it('rejects a body that was swapped after signing', () => {
    const payload = '{"id":"evt_1"}'
    const header = signedHeader(payload)
    expect(verifyStripeSignature('{"id":"evt_2"}', header, SECRET)).toBe(false)
  })

  it('rejects a replay older than the 5 minute window', () => {
    const payload = '{"id":"evt_1"}'
    const stale = Math.floor(Date.now() / 1000) - 3600
    expect(verifyStripeSignature(payload, signedHeader(payload, SECRET, stale), SECRET)).toBe(false)
  })

  it('rejects a malformed header', () => {
    expect(verifyStripeSignature('{}', 'v1=abc', SECRET)).toBe(false)
    expect(verifyStripeSignature('{}', '', SECRET)).toBe(false)
  })
})

describe('subscriptionActive', () => {
  it('treats trialing as active and past_due as not', () => {
    expect(subscriptionActive('active')).toBe(true)
    expect(subscriptionActive('trialing')).toBe(true)
    expect(subscriptionActive('past_due')).toBe(false)
    expect(subscriptionActive('canceled')).toBe(false)
    expect(subscriptionActive('incomplete')).toBe(false)
  })
})
