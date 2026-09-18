import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import {
  NUDGE_SKIP_LOG_INTERVAL_MS,
  extractFlightEvent,
  outboundNudgeBlock,
  pickWatchtowerCandidates,
  shouldEmitNudgeSkip,
} from './hire-api'
import { classifyBriefMail, scoreMail } from './gmailHelpers'

const savedFetch = globalThis.fetch
beforeEach(() => {
  globalThis.fetch = (async () => new Response('', { status: 200 })) as typeof fetch
})
afterEach(() => {
  globalThis.fetch = savedFetch
})

/* The 10s poll logged one identical "[nudge] skip" line every cycle for hours
 * while the unanswered cap was held (measured live: ~dozens/minute for one
 * user). The guard stays; the log repeats only on change or every 6h. */
describe('nudge skip log throttling', () => {
  const at = 1_000_000

  it('logs the first skip and repeats only after the interval', () => {
    expect(shouldEmitNudgeSkip(undefined, 'awaiting reply', at)).toBe(true)
    expect(shouldEmitNudgeSkip({ reason: 'awaiting reply', at }, 'awaiting reply', at + 10_000)).toBe(false)
    expect(shouldEmitNudgeSkip({ reason: 'awaiting reply', at }, 'awaiting reply', at + NUDGE_SKIP_LOG_INTERVAL_MS)).toBe(true)
  })

  it('logs immediately when the reason changes', () => {
    expect(shouldEmitNudgeSkip({ reason: 'awaiting reply', at }, 'quiet hours', at + 10_000)).toBe(true)
  })
})

/* Dimension 6/15: urgent items skip the unanswered cap (a flight ping must not
 * be swallowed because a meal nudge is unanswered), but urgency never buys a
 * 3 AM text. Only a provably imminent item may break quiet hours. */
describe('outbound nudge gating', () => {
  const ctx = (over: Record<string, string> = {}) => ({
    proactive: 'on',
    unanswered_proactive: '2',
    quiet_hours: '00:00-00:00',
    ...over,
  })
  // A last inbound three hours ago, so "in conversation" does not shadow the
  // guard under test.
  const stale = new Date(Date.now() - 3 * 3_600_000)

  it('lets an urgent item through a reached cap', () => {
    expect(outboundNudgeBlock(ctx(), stale, 'America/Los_Angeles', true, 'flight_delay')).toBeNull()
  })

  it('still holds a routine item at the cap', () => {
    expect(outboundNudgeBlock(ctx(), stale, 'America/Los_Angeles', false, 'meal_checkin')).toBe('awaiting reply')
  })

  it('holds even an urgent item during quiet hours', () => {
    expect(
      outboundNudgeBlock(ctx({ quiet_hours: '00:00-23:59' }), stale, 'America/Los_Angeles', true, 'email_urgent'),
    ).toBe('quiet hours')
  })

  it('admits a provably imminent item through quiet hours', () => {
    expect(
      outboundNudgeBlock(ctx({ quiet_hours: '00:00-23:59' }), stale, 'America/Los_Angeles', true, 'flight_delay', true),
    ).toBeNull()
  })

  it('keeps a fresh conversation and an off switch ahead of everything', () => {
    expect(outboundNudgeBlock(ctx(), new Date(), 'America/Los_Angeles', true, 'x')).toBe('in conversation')
    expect(outboundNudgeBlock(ctx({ proactive: 'off' }), null, 'America/Los_Angeles', true, 'x')).toBe('proactive off')
  })
})

/* The bot has had a flight_checkin handler forever; nothing armed one. These
 * pin the narrow detector the new arm scan uses. */
describe('flight detection from a calendar event', () => {
  const start = new Date('2026-09-18T15:00:00.000Z')

  it('reads a carrier code out of a flight title', () => {
    const hit = extractFlightEvent({ title: 'UA 2100 SFO to ORD', start })
    expect(hit?.flight).toBe('UA 2100')
    expect(hit?.airline).toBe('UA')
    expect(hit?.departAt).toBe(start.toISOString())
    expect(hit?.destination).toBe('ORD')
  })

  it('reads a confirmation link from the description', () => {
    const hit = extractFlightEvent({
      title: 'Flight to Chicago',
      description: 'Check in: https://united.com/checkin/ABC123',
      start,
    })
    expect(hit?.confirmationUrl).toBe('https://united.com/checkin/ABC123')
  })

  it('ignores ordinary events and all-day placeholders', () => {
    expect(extractFlightEvent({ title: 'Team sync', location: 'Zoom', start })).toBeNull()
    expect(extractFlightEvent({ title: 'Flight to SFO', start, allDay: true })).toBeNull()
  })

  it('does not mistreat a concert named Flight as air travel', () => {
    expect(extractFlightEvent({ title: 'Flight of the Conchords', location: 'The Fillmore', start })).toBeNull()
  })

  it('accepts a route or airport mention without a carrier code', () => {
    expect(extractFlightEvent({ title: 'Flight to Chicago', start })?.departAt).toBe(start.toISOString())
    expect(
      extractFlightEvent({ title: 'Red-eye', location: 'SFO Airport, Terminal 3', start })?.departAt,
    ).toBe(start.toISOString())
  })
})

/* Dimension 15: the package is the low-risk item Alpha can act on alone. It
 * was previously classified 'other', culled as automated mail (carriers send
 * from no-reply), and never surfaced. */
describe('delivery mail is low-risk, not noise', () => {
  it('classifies carrier delay notices as delivery', () => {
    expect(classifyBriefMail({ from: 'UPS <no-reply@ups.com>', subject: 'Your package is delayed' })).toBe('delivery')
    expect(classifyBriefMail({ from: 'Amazon', subject: 'Your package is out for delivery' })).toBe('delivery')
  })

  it('does not file a person as a parcel', () => {
    expect(classifyBriefMail({ from: 'Sam Lee <sam@acme.com>', subject: 'Sorry for the delayed reply' })).toBe('reply')
    expect(classifyBriefMail({ from: 'UPS <deals@ups.com>', subject: 'Big sale on shipping supplies' })).not.toBe('delivery')
  })

  it('scores a delivery notice over the watchtower bar despite no-reply', () => {
    const m = { id: 'm1', from: 'UPS <no-reply@ups.com>', subject: 'Your package is delayed', kind: 'delivery' }
    expect(scoreMail(m).score).toBeGreaterThanOrEqual(70)
    const candidates = pickWatchtowerCandidates(
      [{ id: 'm1', from: m.from, subject: m.subject, snippet: 'New delivery date Sep 18' }],
      () => undefined,
      new Set(),
    )
    expect(candidates.map((c) => c.kind)).toEqual(['delivery'])
  })
})
