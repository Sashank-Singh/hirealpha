import { describe, expect, it } from 'bun:test'
import { seedProjection, type TaskProjection } from './taskContract'
import { renderItineraryLines, validateTripLeg, type TripLeg } from './trip'
import {
  TRIP_TEXT_CAP,
  buildTripView,
  diffTripViews,
  renderTripText,
  type TripView,
} from './tripView'

/* ------------------------------------------------------------------ fixtures */

let counter = 0

type Seed = {
  id?: string
  kind?: 'flight' | 'stay' | 'transport' | 'restaurant' | 'activity'
  title?: string
  start: string
  end?: string | null
  city?: string
  ref?: string | null
  url?: string | null
  priceCents?: number
  currency?: string
}

/** Legs go through the REAL trip.ts validation — nothing stubbed. */
function leg(seed: Seed): TripLeg {
  counter += 1
  const raw: Record<string, unknown> = {
    id: seed.id ?? `leg-${counter}`,
    kind: seed.kind ?? 'activity',
    title: seed.title ?? 'Test leg',
    start_at: seed.start,
    end_at: seed.end ?? null,
    location: { city: seed.city ?? 'Chicago' },
  }
  if (seed.ref !== undefined) raw.confirmation_ref = seed.ref
  if (seed.url !== undefined) raw.booking_url = seed.url
  if (seed.priceCents !== undefined) raw.price_cents = seed.priceCents
  if (seed.currency !== undefined) raw.currency = seed.currency
  return validateTripLeg(raw)
}

const NOW = '2026-09-17T12:00:00Z'

function projection(overrides: Partial<TaskProjection> = {}): TaskProjection {
  return { ...seedProjection('Trip to Chicago', 'friend', 'conv-1'), ...overrides }
}

/* -------------------------------------------------------------------- status */

describe('buildTripView: status', () => {
  it('planning when legs are unconfirmed and nothing is on fire', () => {
    const view = buildTripView([leg({ start: '2026-09-18T10:00:00Z' })], projection({ state: 'RESEARCHING' }), { now: NOW })
    expect(view.status).toBe('planning')
  })

  it('planning (not booked) for an empty itinerary — vacuous truth is not booked', () => {
    const view = buildTripView([], projection(), { now: NOW })
    expect(view.status).toBe('planning')
    expect(view.timeline).toEqual([])
    expect(view.budget).toEqual({ totalCents: 0, confirmedCents: 0, currency: null })
    expect(view.documents).toEqual([])
    expect(view.blockers).toEqual([])
  })

  it('booked when every leg carries a confirmation ref', () => {
    const legs = [
      leg({ start: '2026-09-18T10:00:00Z', ref: 'A1' }),
      leg({ start: '2026-09-19T10:00:00Z', ref: 'B2' }),
    ]
    expect(buildTripView(legs, projection({ state: 'SYNCHRONIZING' }), { now: NOW }).status).toBe('booked')
  })

  it('conflicts outrank booked when findConflicts is non-empty', () => {
    const legs = [
      leg({ kind: 'restaurant', id: 'dinner', start: '2026-09-18T19:00:00Z', end: '2026-09-18T21:00:00Z', ref: 'D1' }),
      leg({ kind: 'activity', id: 'show', start: '2026-09-18T20:00:00Z', end: '2026-09-18T22:00:00Z', ref: 'S2' }),
    ]
    const view = buildTripView(legs, projection({ state: 'SYNCHRONIZING' }), { now: NOW })
    expect(view.status).toBe('conflicts')
    expect(view.conflicts).toHaveLength(1)
    expect(view.conflicts[0].reason).toBe('overlap')
    expect(view.conflicts[0].legIds).toEqual(['dinner', 'show'])
    expect(view.conflicts[0].severityLabel).toBe('Double-booked')
    expect(view.conflicts[0].note).toContain('overlap')
  })

  it('needs-attention for NEEDS_RECONCILIATION and HUMAN_TAKEOVER', () => {
    const l = leg({ start: '2026-09-18T10:00:00Z', ref: 'A1' })
    expect(buildTripView([l], projection({ state: 'NEEDS_RECONCILIATION' }), { now: NOW }).status).toBe('needs-attention')
    expect(buildTripView([l], projection({ state: 'HUMAN_TAKEOVER' }), { now: NOW }).status).toBe('needs-attention')
  })

  it('needs-attention for VERIFYING with a failed verification; not when it passed', () => {
    const l = leg({ start: '2026-09-18T10:00:00Z', ref: 'A1' })
    const failed = projection({ state: 'VERIFYING', verification: { passed: false, evidence: ['sha256:x'] } })
    expect(buildTripView([l], failed, { now: NOW }).status).toBe('needs-attention')
    const passed = projection({ state: 'VERIFYING', verification: { passed: true, evidence: ['sha256:x'] } })
    expect(buildTripView([l], passed, { now: NOW }).status).toBe('booked')
  })
})

/* -------------------------------------------------------------- day grouping */

describe('buildTripView: timeline', () => {
  it('groups legs by UTC day, chronologically, across a timezone-crossing flight', () => {
    // Departs Tokyo 2026-09-19 01:30 (+09:00) = 2026-09-18 16:30 UTC:
    // the UTC rule (trip.ts convention) puts it on Sep 18, not the local Sep 19.
    const tokyo = leg({ id: 'tz', kind: 'flight', title: 'JL006 HND→ORD', start: '2026-09-19T01:30:00+09:00', city: 'Chicago' })
    const sameUtcDay = leg({ id: 'late', title: 'Late check-in', start: '2026-09-18T23:00:00Z', city: 'Chicago' })
    const nextDay = leg({ id: 'next', title: 'Morning run', start: '2026-09-19T02:00:00Z', city: 'Chicago' })
    const view = buildTripView([nextDay, tokyo, sameUtcDay], projection(), { now: NOW })
    expect(view.timeline.map((group) => group.dayKey)).toEqual(['2026-09-18', '2026-09-19'])
    expect(view.timeline[0].legs.map((l) => l.id)).toEqual(['tz', 'late'])
    expect(view.timeline[1].legs.map((l) => l.id)).toEqual(['next'])
    expect(view.timeline[0].legs[0].dayKey).toBe('2026-09-18')
  })

  it('labels reuse renderItineraryLines for the single leg, without a past-marker', () => {
    const l = leg({ id: 'x', title: 'AA248 SFO→ORD', start: '2026-09-18T18:00:00Z', end: '2026-09-18T21:30:00Z', ref: 'ORD887' })
    const view = buildTripView([l], projection(), { now: '2099-01-01T00:00:00Z' })
    expect(view.timeline[0].legs[0].label).toBe(renderItineraryLines([l])[0])
    expect(view.timeline[0].legs[0].label).toContain('(confirmed ORD887)')
    expect(view.timeline[0].legs[0].label).not.toContain('past')
  })

  it('carries price, sourceUrl and ref honestly; unknowns are 0 and null', () => {
    const priced = leg({ start: '2026-09-18T10:00:00Z', priceCents: 32000, url: 'https://book.alpha.test/a', ref: 'R1' })
    const bare = leg({ start: '2026-09-18T11:00:00Z' })
    const view = buildTripView([priced, bare], projection(), { now: NOW })
    expect(view.timeline[0].legs[0]).toMatchObject({ price_cents: 32000, sourceUrl: 'https://book.alpha.test/a', ref: 'R1', confirmed: true })
    expect(view.timeline[0].legs[1]).toMatchObject({ price_cents: 0, sourceUrl: null, ref: null, confirmed: false })
  })
})

/* -------------------------------------------------------------------- budget */

describe('buildTripView: budget honest split', () => {
  it('confirmedCents counts only legs whose own ref is present', () => {
    const legs = [
      leg({ start: '2026-09-18T10:00:00Z', ref: 'OK', priceCents: 30000, currency: 'usd' }),
      leg({ start: '2026-09-18T12:00:00Z', priceCents: 10000, currency: 'USD' }),
      leg({ start: '2026-09-18T14:00:00Z', ref: 'NOPRICE' }), // no price: contributes 0
    ]
    const view = buildTripView(legs, projection(), { now: NOW })
    expect(view.budget).toEqual({ totalCents: 40000, confirmedCents: 30000, currency: 'USD' })
  })

  it('mixed currencies across priced legs say mixed; no currency info says null', () => {
    const legs = [
      leg({ start: '2026-09-18T10:00:00Z', priceCents: 1000, currency: 'USD' }),
      leg({ start: '2026-09-18T12:00:00Z', priceCents: 2000, currency: 'EUR' }),
    ]
    expect(buildTripView(legs, projection(), { now: NOW }).budget.currency).toBe('mixed')
    const noCurrency = [leg({ start: '2026-09-18T10:00:00Z', priceCents: 1000 })]
    expect(buildTripView(noCurrency, projection(), { now: NOW }).budget.currency).toBeNull()
  })
})

/* ----------------------------------------------------------------- documents */

describe('buildTripView: documents', () => {
  it('dedups repeated refs and sorts by value', () => {
    const legs = [
      leg({ id: 'a', start: '2026-09-18T10:00:00Z', ref: 'ZZ999' }),
      leg({ id: 'b', start: '2026-09-18T12:00:00Z', ref: 'HTL77' }),
      leg({ id: 'c', start: '2026-09-18T14:00:00Z', ref: 'HTL77' }), // same hotel, two entries
      leg({ id: 'd', start: '2026-09-18T16:00:00Z' }), // no ref, no document
    ]
    const view = buildTripView(legs, projection(), { now: NOW })
    expect(view.documents).toEqual([
      { label: 'Confirmation HTL77', value: 'HTL77' },
      { label: 'Confirmation ZZ999', value: 'ZZ999' },
    ])
  })
})

/* ------------------------------------------------------------------ blockers */

describe('buildTripView: blockers', () => {
  it('WAITING_FOR_AUTHORITY yields an approval blocker naming the pending grant', () => {
    const p = projection({
      state: 'WAITING_FOR_AUTHORITY',
      grants: [{ grant_id: 'g-42', status: 'requested' }],
    })
    const view = buildTripView([leg({ start: '2026-09-18T10:00:00Z' })], p, { now: NOW })
    expect(view.blockers).toEqual([{ kind: 'approval', text: 'Waiting on your approval to proceed (grant g-42).' }])
  })

  it('selected-but-not-executed yields an approval blocker naming the option', () => {
    const p = projection({
      state: 'PLANNING_ACTION',
      options: [{ id: 'opt-1', title: 'Hilton Chicago', reason: 'r', source_url: 'https://x.test', freshness: NOW }],
      selected_option_id: 'opt-1',
    })
    const [blocker] = buildTripView([], p, { now: NOW }).blockers
    expect(blocker?.kind).toBe('approval')
    expect(blocker && 'text' in blocker ? blocker.text : '').toContain('Hilton Chicago')
  })

  it('credential/payment/unknown handoffs map to their blocker kinds; resumed ones clear', () => {
    const p = projection({
      state: 'HUMAN_TAKEOVER',
      artifacts: [
        { kind: 'handoff:credential', ref: 'vault://cred-1' },
        { kind: 'handoff:credential', ref: 'vault://cred-dup' },
        { kind: 'handoff:payment', ref: 'checkout://pay-9' },
        { kind: 'handoff:identity-docs', ref: null },
        { kind: 'handoff_resumed:credential', ref: null },
      ],
    })
    const view = buildTripView([], p, { now: NOW })
    expect(view.blockers).toEqual([
      { kind: 'payment', label: 'payment (checkout://pay-9)' },
      { kind: 'human', label: 'identity-docs' },
    ])
  })

  it('VERIFYING parked on a failed verification yields a proof blocker with the reason', () => {
    const p = projection({
      state: 'VERIFYING',
      verification: { passed: false, evidence: ['sha256:junk'] },
      failure: { reason_code: 'verification_failed' },
    })
    expect(buildTripView([], p, { now: NOW }).blockers).toEqual([
      { kind: 'proof', text: 'Verification failed (verification_failed) — independent proof still needed.' },
    ])
  })

  it('a clean projection yields zero blockers', () => {
    const p = projection({ state: 'FULFILLED', verification: { passed: true, evidence: ['ok'] } })
    expect(buildTripView([leg({ start: '2026-09-18T10:00:00Z', ref: 'A' })], p, { now: NOW }).blockers).toEqual([])
  })
})

/* ---------------------------------------------------------------- monitoring */

describe('buildTripView: monitoring', () => {
  it('active + due for an armed SCHEDULED monitor past its next check', () => {
    const p = projection({ monitor_state: 'SCHEDULED', monitor_next_check_at: '2026-09-17T11:00:00Z' })
    const view = buildTripView([], p, { now: NOW })
    expect(view.monitoring).toEqual({ active: true, nextCheckAt: '2026-09-17T11:00:00Z', due: true })
  })

  it('active but not due yet; CHECKING/DEGRADED are active, OFF/TRIGGERED/ENDED are not', () => {
    const armed = projection({ monitor_state: 'SCHEDULED', monitor_next_check_at: '2026-09-17T18:00:00Z' })
    expect(buildTripView([], armed, { now: NOW }).monitoring.due).toBe(false)
    for (const state of ['CHECKING', 'DEGRADED'] as const) {
      expect(buildTripView([], projection({ monitor_state: state }), { now: NOW }).monitoring.active).toBe(true)
    }
    for (const state of ['OFF', 'TRIGGERED', 'ENDED'] as const) {
      const v = buildTripView([], projection({ monitor_state: state, monitor_next_check_at: '2026-09-17T11:00:00Z' }), { now: NOW })
      expect(v.monitoring.active).toBe(false)
      expect(v.monitoring.due).toBe(false) // real nextCheckDue says not_scheduled
      expect(v.monitoring.nextCheckAt).toBe('2026-09-17T11:00:00Z') // carried through honestly
    }
  })

  it('junk next_check_at and a junk now never crash the view: due=false', () => {
    const junkStamp = projection({ monitor_state: 'SCHEDULED', monitor_next_check_at: 'someday-ish' })
    expect(buildTripView([], junkStamp, { now: NOW }).monitoring.due).toBe(false)
    const junkNow = projection({ monitor_state: 'SCHEDULED', monitor_next_check_at: '2026-09-17T11:00:00Z' })
    const view = buildTripView([], junkNow, { now: 'whenever' })
    expect(view.monitoring.due).toBe(false)
    expect(view.monitoring.active).toBe(true)
  })
})

/* -------------------------------------------------------------- text surface */

function sampleView(): TripView {
  const legs = [
    leg({ id: 'f', kind: 'flight', title: 'AA248 SFO→ORD', start: '2026-09-18T18:00:00Z', end: '2026-09-18T21:30:00Z', city: 'Chicago', ref: 'ORD887', priceCents: 30000, currency: 'usd' }),
    leg({ id: 'd', title: 'Dinner', start: '2026-09-19T00:30:00Z', city: 'Chicago', priceCents: 10000, currency: 'USD' }),
  ]
  return buildTripView(legs, projection({ state: 'EXECUTING' }), { now: NOW })
}

describe('renderTripText', () => {
  it('renders title+status, day headers, the same leg labels, and one budget line', () => {
    const view = sampleView()
    const text = renderTripText(view)
    expect(text.split('\n')[0]).toBe('Trip to Chicago · planning')
    expect(text).toContain('Fri, Sep 18')
    expect(text).toContain('Sat, Sep 19')
    expect(text).toContain(view.timeline[0].legs[0].label)
    expect(text).toContain('Total $400 · booked $300')
    expect(text).not.toContain('Conflicts:')
    expect(text).not.toContain('Needs you:')
  })

  it('adds exactly one conflicts line and one blockers line when present', () => {
    const legs = [
      leg({ id: 'r', title: 'Dinner', start: '2026-09-18T19:00:00Z', end: '2026-09-18T21:00:00Z', priceCents: 5000 }),
      leg({ id: 's', title: 'Show', start: '2026-09-18T20:00:00Z', end: '2026-09-18T22:00:00Z' }),
    ]
    const p = projection({
      state: 'NEEDS_RECONCILIATION',
      artifacts: [{ kind: 'handoff:payment', ref: 'checkout://9' }],
    })
    const lines = renderTripText(buildTripView(legs, p, { now: NOW })).split('\n')
    const conflictLines = lines.filter((line) => line.startsWith('Conflicts:'))
    const blockerLines = lines.filter((line) => line.startsWith('Needs you:'))
    expect(conflictLines).toHaveLength(1)
    expect(conflictLines[0]).toContain('Double-booked')
    expect(blockerLines).toHaveLength(1)
    expect(blockerLines[0]).toContain('payment (checkout://9)')
  })

  it('labels mixed-currency budgets honestly', () => {
    const legs = [
      leg({ start: '2026-09-18T10:00:00Z', priceCents: 1000, currency: 'USD' }),
      leg({ start: '2026-09-18T12:00:00Z', priceCents: 250, currency: 'EUR' }),
    ]
    const text = renderTripText(buildTripView(legs, projection(), { now: NOW }))
    expect(text).toContain('Total $12.50 · booked $0 · mixed currencies')
  })

  it('caps at 3200 chars cut at the last newline — never mid-line', () => {
    const legs: TripLeg[] = []
    for (let i = 0; i < 150; i += 1) {
      const day = String((i % 25) + 1).padStart(2, '0')
      const hour = String(i % 23).padStart(2, '0')
      legs.push(leg({ title: `Long-tailed review checkpoint number ${i}`, start: `2026-09-${day}T${hour}:15:00Z`, city: 'Somecitytonia' }))
    }
    const view = buildTripView(legs, projection(), { now: NOW })
    // Rebuild the uncapped text the same way the renderer does, to locate the cut.
    const header = new Intl.DateTimeFormat('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' })
    const full = [
      `${view.title} · ${view.status}`,
      ...view.timeline.flatMap((group) => [
        header.format(new Date(`${group.dayKey}T00:00:00Z`)),
        ...group.legs.map((l) => l.label),
      ]),
      'Total $0 · booked $0',
    ].join('\n')
    expect(full.length).toBeGreaterThan(TRIP_TEXT_CAP) // fixture really overflows
    const text = renderTripText(view)
    expect(text.length).toBeLessThanOrEqual(TRIP_TEXT_CAP)
    expect(full.startsWith(text)).toBe(true)
    expect(full[text.length]).toBe('\n') // cut exactly at a line boundary
    expect(text.length).toBeLessThan(TRIP_TEXT_CAP) // a newline lived under the cap, not a raw slice
  })
})

/* --------------------------------------------------------------------- diff */

describe('diffTripViews', () => {
  it('reports added, removed, and label/confirmed/price changes', () => {
    const a = leg({ id: 'a', title: 'Alpha', start: '2026-09-18T10:00:00Z' })
    const b = leg({ id: 'b', title: 'Bravo', start: '2026-09-18T12:00:00Z' })
    const c = leg({ id: 'c', title: 'Charlie', start: '2026-09-18T14:00:00Z' })
    const before = buildTripView([a, b], projection(), { now: NOW })
    // b got confirmed (change) and repriced; a dropped; c added.
    const b2 = leg({ id: 'b', title: 'Bravo', start: '2026-09-18T12:00:00Z', ref: 'BEEF', priceCents: 9900, currency: 'USD' })
    const after = buildTripView([b2, c], projection(), { now: NOW })
    const diff = diffTripViews(before, after)
    expect(diff.added).toEqual(['c'])
    expect(diff.removed).toEqual(['a'])
    expect(diff.changed).toEqual(['b'])
    expect(diff.conflictDelta).toBe(0)
    expect(diff.statusChanged).toBeNull() // both builds are 'planning'
  })

  it('conflictDelta and statusChanged', () => {
    const calm = [leg({ id: 'x', start: '2026-09-18T10:00:00Z', ref: 'X' }), leg({ id: 'y', start: '2026-09-19T10:00:00Z', ref: 'Y' })]
    const before = buildTripView(calm, projection({ state: 'SYNCHRONIZING' }), { now: NOW })
    expect(before.status).toBe('booked')
    const chaos = [
      leg({ id: 'x', start: '2026-09-18T10:00:00Z', end: '2026-09-18T12:00:00Z', ref: 'X' }),
      leg({ id: 'y', start: '2026-09-18T11:00:00Z', end: '2026-09-18T13:00:00Z', ref: 'Y', city: 'Detroit' }),
    ]
    const after = buildTripView(chaos, projection({ state: 'SYNCHRONIZING' }), { now: NOW })
    const diff = diffTripViews(before, after)
    expect(after.status).toBe('conflicts')
    expect(diff.conflictDelta).toBe(1)
    expect(diff.statusChanged).toEqual({ from: 'booked', to: 'conflicts' })
    expect(diff.added).toEqual([])
    expect(diff.removed).toEqual([])
  })

  it('identical builds diff to nothing', () => {
    const legs = [leg({ id: 'z', start: '2026-09-18T10:00:00Z', ref: 'Z', priceCents: 100 })]
    const p = projection({ state: 'EXECUTING' })
    const v1 = buildTripView(legs, p, { now: NOW })
    const v2 = buildTripView(legs, p, { now: NOW })
    expect(diffTripViews(v1, v2)).toEqual({ added: [], removed: [], changed: [], conflictDelta: 0, statusChanged: null })
  })
})
