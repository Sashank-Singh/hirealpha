import { describe, expect, it } from 'bun:test'
import { buildCommitmentRescueText, detectCommitment } from './commitmentRescue'
import { LOOP_HANDLERS } from './taskLoops'

describe('commitment rescue', () => {
  const now = new Date('2026-09-21T16:00:00Z') // Monday, 9am PDT

  it('captures an explicit actionable promise and resolves Friday in the user timezone', () => {
    const got = detectCommitment("I'll send Priya the deck by Friday", 'America/Los_Angeles', now)
    expect(got?.title).toBe('Send Priya the deck')
    expect(got?.dueAt.toISOString()).toBe('2026-09-26T00:00:00.000Z')
    expect(got?.rescueAt.toISOString()).toBe('2026-09-25T00:00:00.000Z')
  })

  it('uses end of day in the user timezone and schedules an imminent rescue safely', () => {
    const got = detectCommitment('I will submit the application by end of day', 'America/New_York', now)
    expect(got?.dueAt.toISOString()).toBe('2026-09-22T00:00:00.000Z')
    expect(got?.rescueAt.toISOString()).toBe('2026-09-21T16:01:00.000Z')
  })

  it('keeps an explicit clock time across the spring DST boundary', () => {
    const beforeSpringForward = new Date('2026-03-07T17:00:00Z')
    const got = detectCommitment('I’ll send Alex the deck by tomorrow at 9am', 'America/Los_Angeles', beforeSpringForward)
    expect(got?.title).toBe('Send Alex the deck')
    expect(got?.dueAt.toISOString()).toBe('2026-03-08T16:00:00.000Z')
  })

  it('keeps an explicit clock time across the fall DST boundary', () => {
    const beforeFallBack = new Date('2026-10-31T17:00:00Z')
    const got = detectCommitment("I'll send Alex the deck by tomorrow at 9am", 'America/Los_Angeles', beforeFallBack)
    expect(got?.dueAt.toISOString()).toBe('2026-11-01T17:00:00.000Z')
  })

  it('rejects vague intentions, non-user promises, and promises without deadlines', () => {
    expect(detectCommitment("I'll maybe send it by Friday", 'UTC', now)).toBeNull()
    expect(detectCommitment('Priya will send it by Friday', 'UTC', now)).toBeNull()
    expect(detectCommitment("I'll send it", 'UTC', now)).toBeNull()
    expect(detectCommitment("I'll see you Friday", 'UTC', now)).toBeNull()
    expect(detectCommitment('Alex said “I’ll send the deck by tomorrow at 9am”', 'UTC', now)).toBeNull()
    expect(detectCommitment('“I’ll send the deck by tomorrow at 9am” — Alex', 'UTC', now)).toBeNull()
  })

  it('produces an evidence-based intervention with a concrete deadline', () => {
    expect(buildCommitmentRescueText({
      title: 'Send Priya the deck', dueAt: '2026-09-26T00:00:00Z', timezone: 'America/Los_Angeles',
    })).toBe('You promised to send Priya the deck by Fri 5:00 PM. Want me to help finish it before it slips?')
  })

  it('is delivered by the normal proactive task-loop safety path', async () => {
    const result = await LOOP_HANDLERS.commitment_rescue!({
      id: 'task-1', phone: '+15551234567', kind: 'commitment_rescue:loop-1',
      payload: { title: 'Send Priya the deck', dueAt: '2026-09-26T00:00:00Z', timezone: 'America/Los_Angeles' },
    })
    expect(result.outcome).toBe('done')
    expect(result.note).toBe('commitment_rescue')
    expect(result.text).toContain('You promised to send Priya the deck')
  })
})
