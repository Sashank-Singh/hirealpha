import { describe, expect, test } from 'bun:test'
import {
  assessOffline,
} from './assessment'
import {
  buildReceipt, canTransition, completionKey, formatBlocker, formatCompletionReply,
  formatRetentionOffer, formatUnknownFollowUp,
  parseBlocker, parseCompletionEvidence,
} from './completion'

/** §22 acceptance coverage at the pure layer: evidence parsing, state machine,
 * receipts, dark patterns, blockers, exactly-once helpers, receipts-not-prose. */

describe('subscription cancellation — evidence parsing (6 merchant patterns)', () => {
  test('1. simple one-click: account state confirms', () => {
    const e = parseCompletionEvidence('subscription_cancel', 'Spotify — your subscription has been cancelled. Renewal is off. Access through October 31.')
    expect(e).not.toBeNull()
    expect(e!.type).toBe('account_state')
    expect(e!.renewalOff).toBe(true)
    expect(e!.accessThrough).toBe('October 31')
  })

  test('1b. confirmation number captured', () => {
    const e = parseCompletionEvidence('subscription_cancel', 'Cancellation complete. Confirmation #AB12CD. Your plan ends on Nov 2.')
    expect(e!.confirmationNumber).toBe('AB12CD')
    expect(e!.accessThrough).toBe('Nov 2')
  })

  test('2. multi-step retention flow: final state still wins', () => {
    const e = parseCompletionEvidence('subscription_cancel', 'Step 3 of 3 done. Your subscription is now cancelled. Auto-renew is off.')
    expect(e!.type).toBe('account_state')
    expect(e!.renewalOff).toBe(true)
  })

  test('3. reason-selection flow that ended in cancellation', () => {
    const e = parseCompletionEvidence('subscription_cancel', 'Thanks for telling us why. Your membership cancellation is confirmed. Confirmation #XYZ99')
    expect(e!.confirmationNumber).toBe('XYZ99')
  })

  test('4. logged out → blocker, not completion', () => {
    const e = parseCompletionEvidence('subscription_cancel', 'Session expired — please sign in again.')
    expect(e!.type).toBe('none')
    const b = parseBlocker('subscription_cancel', 'You have been logged out. Sign in to continue.')
    expect(b?.type).toBe('reauth')
  })

  test('4b. captcha → typed blocker', () => {
    const b = parseBlocker('subscription_cancel', 'Complete the captcha to verify you\'re human.')
    expect(b?.type).toBe('captcha')
    const e = parseCompletionEvidence('subscription_cancel', 'Verify you\'re human to continue.')
    expect(e!.type).toBe('none')
  })

  test('5. phone-only provider → phone_required with number', () => {
    const b = parseBlocker('subscription_cancel', 'Memberships must be cancelled by phone. Call customer support at (800) 555-0199 to cancel.')
    expect(b?.type).toBe('phone_required')
    expect((b as any).phone).toMatch(/800\)? 555-0199|800-555-0199/)
  })

  test('5b. support-only provider → typed blocker', () => {
    const b = parseBlocker('subscription_cancel', 'To cancel, please contact support by email.')
    expect(b?.type).toBe('support_only')
  })

  test('already cancelled reads as completed-state evidence', () => {
    const e = parseCompletionEvidence('subscription_cancel', 'Your subscription is already cancelled — no active subscription on this account.')
    expect(e!.type).toBe('account_state')
    expect(e!.summary).toMatch(/already/i)
  })

  test('plain submit with no state change is NOT completion', () => {
    const e = parseCompletionEvidence('subscription_cancel', 'Clicked the cancel button and the form submitted (HTTP 200).')
    expect(e).toBeNull()
  })
})

describe('retention dark patterns — never silently accepted', () => {
  test('50% off offer is a retention_offer, not completion', () => {
    const e = parseCompletionEvidence('subscription_cancel', 'Wait! Get 50% off your next 3 months if you stay.')
    expect(e!.type).toBe('retention_offer')
    expect(e!.retentionOffer).toMatch(/50% off/)
  })

  test('pause offer is a retention_offer', () => {
    const e = parseCompletionEvidence('subscription_cancel', 'Pause instead of cancelling — keep your playlists.')
    expect(e!.type).toBe('retention_offer')
  })

  test('offer + cancellation state together reads as completion (offer was on the way)', () => {
    const e = parseCompletionEvidence('subscription_cancel', 'We offered 50% off, you declined. Subscription cancelled. Renewal is off.')
    expect(e!.type).toBe('account_state')
  })

  test('retention message asks the user, never switches the goal', () => {
    const msg = formatRetentionOffer('Spotify', '50% off for 3 months')
    expect(msg).toMatch(/offered 50% off/)
    expect(msg).toMatch(/Want the offer, or should I continue cancelling/)
  })
})

describe('booking — evidence parsing', () => {
  test('reservation with confirmation number completes', () => {
    const e = parseCompletionEvidence('reservation', 'Reservation confirmed at Niku Steakhouse. Confirmation #A8F21. Friday 7:30 PM for two.')
    expect(e!.type).toBe('confirmation_number')
    expect(e!.confirmationNumber).toBe('A8F21')
  })

  test('no availability is a clean miss, not a blocker', () => {
    const e = parseCompletionEvidence('reservation', 'No tables available at that time — fully booked.')
    expect(e!.type).toBe('none')
    expect(e!.summary).toMatch(/No availability/)
  })

  test('login-required booking becomes a typed blocker', () => {
    const b = parseBlocker('reservation', 'You need to sign in to complete this booking — create an account to continue.')
    expect(b?.type).toBe('login_required')
  })

  test('form submit without confirmation is not completion', () => {
    expect(parseCompletionEvidence('reservation', 'Reservation form submitted (200 OK).')).toBeNull()
  })
})

describe('flight check-in — evidence parsing + upsell guard', () => {
  test('boarding pass = completed', () => {
    const e = parseCompletionEvidence('check_in', 'You\'re checked in. Your boarding pass is ready.')
    expect(e!.type).toBe('boarding_pass')
    expect(e!.checkedIn).toBe(true)
  })

  test('window not open is a typed miss with opens-at', () => {
    const e = parseCompletionEvidence('check_in', 'Check-in isn\'t open yet — it opens 24 hours before departure.')
    expect(e!.type).toBe('none')
    expect(e!.summary).toMatch(/not open/)
  })

  test('seat-upgrade offer WITHOUT confirmation is not completion', () => {
    const e = parseCompletionEvidence('check_in', 'Upgrade to extra legroom for $49 — add priority boarding and pay baggage fees now.')
    expect(e!.type).toBe('none')
    expect(e!.summary).toMatch(/upsell/)
  })

  test('passport verification becomes a blocker', () => {
    const b = parseBlocker('check_in', 'Passport verification is required before check-in.')
    expect(b?.type).toBe('passport')
    const e = parseCompletionEvidence('check_in', 'Passport verification required before check-in.')
    expect(e!.summary).toMatch(/passport/)
  })

  test('already checked in reads as done', () => {
    const e = parseCompletionEvidence('check_in', 'You are already checked in for this flight.')
    expect(e!.checkedIn).toBe(true)
  })
})

describe('state machine', () => {
  test('happy path', () => {
    expect(canTransition('pending', 'executing')).toBe(true)
    expect(canTransition('executing', 'verification_pending')).toBe(true)
    expect(canTransition('verification_pending', 'completed')).toBe(true)
  })
  test('verification_pending cannot jump to completed illegally is allowed; executing cannot complete directly', () => {
    expect(canTransition('executing', 'completed')).toBe(false)
  })
  test('unknown outcome can re-enter verification or resolve', () => {
    expect(canTransition('outcome_unknown', 'verification_pending')).toBe(true)
    expect(canTransition('outcome_unknown', 'completed')).toBe(true)
    expect(canTransition('outcome_unknown', 'cancellation_requested')).toBe(true)
  })
  test('completed is terminal', () => {
    expect(canTransition('completed', 'executing')).toBe(false)
    expect(canTransition('completed', 'cancelled')).toBe(false)
  })
  test('cancellation after submission stays honest', () => {
    expect(canTransition('executing', 'cancellation_requested')).toBe(true)
    expect(canTransition('cancellation_requested', 'outcome_unknown')).toBe(true)
    expect(canTransition('cancellation_requested', 'cancelled')).toBe(true)
  })
})

describe('receipts + user-visible Verified ✓', () => {
  test('cancellation receipt formats compactly', () => {
    const r = buildReceipt({
      kind: 'subscription_cancel', status: 'completed', evidence: {
        type: 'account_state', summary: 'Subscription cancelled.', renewalOff: true, accessThrough: 'Oct 31', provider: 'Spotify',
      }, resultSummary: 'cancelled', verifiedAt: '2026-09-28T12:00:00Z',
    })
    const msg = formatCompletionReply(r)
    expect(msg).toBe('Cancelled Spotify ✓\nRenewal: off\nAccess through: Oct 31')
  })

  test('reservation receipt shows confirmation number', () => {
    const r = buildReceipt({
      kind: 'reservation', status: 'completed', evidence: {
        type: 'confirmation_number', summary: 'Reserved.', confirmationNumber: 'A8F21', accessThrough: '7:30 PM · two people', provider: 'Niku Steakhouse',
      }, resultSummary: 'booked',
    })
    expect(formatCompletionReply(r)).toBe('Reserved Niku Steakhouse ✓\n7:30 PM · two people\nConfirmation #A8F21')
  })

  test('✓ NEVER appears without verified evidence', () => {
    const r = buildReceipt({
      kind: 'subscription_cancel', status: 'outcome_unknown', evidence: { type: 'none', summary: 'no state read' }, resultSummary: 'submitted',
    })
    const msg = formatCompletionReply(r)
    expect(msg).not.toContain('✓')
    expect(msg).toMatch(/can't verify/)
  })
})

describe('unknown-outcome follow-up', () => {
  test('first unknown check promises a re-check, not success', () => {
    expect(formatUnknownFollowUp('Spotify', 1, 3)).toMatch(/won't claim it's done/)
    expect(formatUnknownFollowUp('Spotify', 1, 3)).toMatch(/check again in 10 minutes/)
  })
  test('exhausted checks surface the blocker', () => {
    expect(formatUnknownFollowUp('Spotify', 3, 3)).toMatch(/may still be active/)
  })
})

describe('blocker formatting (§13/§14)', () => {
  test('captcha message is resumable', () => {
    expect(formatBlocker({ type: 'captcha', message: 'needs captcha' }, 'Spotify')).toMatch(/I'll continue from there/)
  })
  test('phone_required names the limit and the number', () => {
    const msg = formatBlocker({ type: 'phone_required', message: 'phone only', phone: '(800) 555-0199' }, 'Gold\'s Gym')
    expect(msg).toMatch(/only accepts cancellations by phone/)
    expect(msg).toMatch(/555-0199/)
  })
})

describe('exactly-once primitives', () => {
  test('idempotent create key derivation is stable per (user, kind, target)', () => {
    const a = completionKey('+15550001', 'friend', 'subscription_cancel', 'spotify')
    const b = completionKey('+15550001', 'friend', 'subscription_cancel', 'Spotify')
    const c = completionKey('+15550001', 'friend', 'subscription_cancel', 'spotify')
    expect(a).toBe(b)
    expect(a).toBe(c)
    expect(a).not.toBe(completionKey('+15550002', 'friend', 'subscription_cancel', 'spotify'))
  })
})
