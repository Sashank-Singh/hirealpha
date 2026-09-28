import { describe, expect, test } from 'bun:test'
import { ClaimLedger, enforceClaimEvidence } from './claimEvidence'

describe('claim provenance — positive claims', () => {
  test('"Sent." without a send receipt is downgraded', () => {
    const l = new ClaimLedger()
    const out = enforceClaimEvidence('Sent it to Dana just now.', l)
    expect(out.violations.length).toBe(1)
    expect(out.reply).toMatch(/drafted for your review/)
    expect(out.reply).not.toMatch(/Sent it to Dana/)
  })

  test('"Sent." with a provider receipt passes untouched', () => {
    const l = new ClaimLedger()
    l.record('mail_send', 'verified_success', { providerId: 'smtp_1' })
    const out = enforceClaimEvidence('Sent it to Dana just now.', l)
    expect(out.violations).toEqual([])
    expect(out.reply).toBe('Sent it to Dana just now.')
  })

  test('reminder success claim requires a reminder write', () => {
    const l = new ClaimLedger()
    const out = enforceClaimEvidence('Reminder is set for 6pm.', l)
    expect(out.violations.length).toBe(1)
    expect(out.reply).toMatch(/did not save/)
    l.record('reminder', 'verified_success', { id: 'r1' })
    expect(enforceClaimEvidence('Reminder is set for 6pm.', l).violations).toEqual([])
  })

  test('booking completion claims about browser runs are downgraded even when staged', () => {
    const l = new ClaimLedger()
    l.record('browser', 'verified_success', { active: true, label: 'runnerreg.io run', receipt: false })
    const out = enforceClaimEvidence('You are registered for the Founders Run Club.', l)
    expect(out.violations.length).toBe(1)
    expect(out.reply).toMatch(/queued and pauses/)
  })

  test('payment claims require a verified charge', () => {
    const l = new ClaimLedger()
    const out = enforceClaimEvidence('Payment received, order placed.', l)
    expect(out.violations.length).toBeGreaterThanOrEqual(1)
    expect(out.reply).toMatch(/No payment is confirmed/)
  })
})

describe('claim provenance — negative claims', () => {
  test('"I could not reach your calendar" with zero calendar attempts is rewritten', () => {
    const l = new ClaimLedger()
    l.record('mail_read', 'verified_empty')
    const out = enforceClaimEvidence("I couldn't reach your calendar, so I can't confirm Tuesday.", l)
    expect(out.violations.length).toBe(1)
    expect(out.reply).toMatch(/have not actually checked your calendar/)
  })

  test('calendar failure claim passes after a real failed calendar attempt', () => {
    const l = new ClaimLedger()
    l.record('calendar_read', 'provider_unavailable', { error: 'timeout' })
    const out = enforceClaimEvidence("I couldn't reach your calendar just now.", l)
    expect(out.violations).toEqual([])
  })

  test('"The email failed" without any attempt is rewritten', () => {
    const l = new ClaimLedger()
    const out = enforceClaimEvidence('The email failed to go through.', l)
    expect(out.violations.length).toBe(1)
    expect(out.reply).toMatch(/have not attempted that yet/)
  })

  test('mail failure claim passes after a real failed send attempt', () => {
    const l = new ClaimLedger()
    l.record('mail_send', 'verified_failure', { error: 'SMTP 451' })
    const out = enforceClaimEvidence('The send failed — SMTP rejected it.', l)
    expect(out.violations).toEqual([])
  })

  test('"It failed twice" is rewritten when the write actually succeeded', () => {
    const l = new ClaimLedger()
    l.record('reminder', 'verified_success', { id: 'r1' })
    const out = enforceClaimEvidence('The reminder failed to save twice, so it is not set.', l)
    expect(out.violations.length).toBe(1)
    expect(out.reply).toMatch(/have not attempted|did not save/)
    expect(out.reply).not.toMatch(/failed to save twice/)
  })
})

describe('claim provenance — cancellation and active work', () => {
  test('"Cancelled." requires a confirmed cancellation, not just a request', () => {
    const l = new ClaimLedger()
    l.record('browser', 'cancellation_requested')
    const out = enforceClaimEvidence('Cancelled — nothing is running anymore.', l)
    expect(out.violations.length).toBeGreaterThanOrEqual(1)
    expect(out.reply).toMatch(/Cancel was requested/)
  })

  test('confirmed cancellation passes', () => {
    const l = new ClaimLedger()
    l.record('browser', 'cancelled', { jobId: 'job_1' })
    const out = enforceClaimEvidence('Cancelled the runnerreg run.', l)
    expect(out.violations).toEqual([])
  })

  test('"Nothing is ticking" is corrected when durable work is still active', () => {
    const l = new ClaimLedger()
    l.record('followup', 'verified_success', { active: true, label: 'Sam reply watch' })
    const out = enforceClaimEvidence("Done — nothing's ticking anymore.", l)
    expect(out.violations.length).toBeGreaterThanOrEqual(1)
    expect(out.reply).toMatch(/Sam reply watch is still active/)
  })

  test('"Nothing is running" passes when a verified read showed no active work', () => {
    const l = new ClaimLedger()
    l.record('browser', 'verified_empty', { active: false })
    const out = enforceClaimEvidence('Nothing is running right now.', l)
    expect(out.violations).toEqual([])
  })
})

describe('claim provenance — capability and policy language', () => {
  test('policy refusals are never rewritten', () => {
    const l = new ClaimLedger()
    const reply = 'For your security, I will never initiate direct bank wires from chat.'
    const out = enforceClaimEvidence(reply, l)
    expect(out.violations).toEqual([])
    expect(out.reply).toBe(reply)
  })

  test('questions and hypotheticals are not treated as claims', () => {
    const l = new ClaimLedger()
    const out = enforceClaimEvidence('Should I send it now, or wait for the corrected total?', l)
    expect(out.violations).toEqual([])
  })

  test('incapability claim backed by verified_empty (read ran, nothing there) passes', () => {
    const l = new ClaimLedger()
    l.record('calendar_read', 'verified_empty')
    const out = enforceClaimEvidence("I can't see any trip on your calendar.", l)
    expect(out.violations).toEqual([])
  })
})
