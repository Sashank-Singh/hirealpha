import { describe, expect, it } from 'bun:test'
import { buildOpsSnapshot, renderOpsText, DEFAULT_WINDOW_MS, type OpsSnapshotInput } from './dashboard'
import { seedProjection, MONITOR_STATES, TASK_STATES, type TaskProjection, type TaskState } from './taskContract'
import type { TaskRecord } from './taskStore'

const NOW = Date.parse('2026-09-14T12:00:00Z')
const MIN = 60_000

function isoAgo(msAgo: number): string {
  return new Date(NOW - msAgo).toISOString()
}

function entry(
  id: string,
  state: TaskState,
  opts: {
    updatedMsAgo?: number
    persona?: string
    userId?: string
    monitor?: TaskRecord['monitor_state']
    projection?: Partial<TaskProjection>
  } = {},
): OpsSnapshotInput {
  const task: TaskRecord = {
    id,
    user_id: opts.userId ?? `user-${id}`,
    persona: opts.persona ?? 'friend',
    conversation_id: null,
    request: 'book the cheapest flight',
    state,
    resumed_state: null,
    monitor_state: opts.monitor ?? 'OFF',
    plan_version: 0,
    version: 3,
    event_seq: 9,
    created_at: isoAgo((opts.updatedMsAgo ?? 0) + 60 * MIN),
    updated_at: isoAgo(opts.updatedMsAgo ?? 0),
  }
  return { task, projection: { ...seedProjection(task.request, task.persona, null), ...opts.projection } }
}

describe('buildOpsSnapshot: state coverage', () => {
  it('zero-fills every TASK_STATES and MONITOR_STATES key on empty input', () => {
    const snap = buildOpsSnapshot([], { now: NOW })
    for (const state of TASK_STATES) expect(snap.byState[state]).toBe(0)
    for (const monitor of MONITOR_STATES) expect(snap.byMonitorState[monitor]).toBe(0)
    expect(snap.totals.tasks).toBe(0)
    expect(snap.outcomes.verifiedRate).toBeNull()
    expect(snap.handoffResume.rate).toBeNull()
    expect(snap.syncLag.maxLagMs).toBeNull()
    expect(snap.unapprovedActions).toBe('not-instrumented')
    expect(snap.generated_at).toBe('2026-09-14T12:00:00.000Z')
    expect(snap.window_ms).toBe(DEFAULT_WINDOW_MS)
    // 24-hour ops window (integrator correction: the dispatch spec's literal
    // 24*60_000 was a typo for 24h; overdue-by-state wants a day, not a lap).
    expect(snap.window_start).toBe('2026-09-13T12:00:00.000Z')
  })

  it('counts every task state and monitor state', () => {
    const inputs = TASK_STATES.map((state, i) =>
      entry(`t-${state}`, state, {
        updatedMsAgo: 2 * MIN,
        monitor: MONITOR_STATES[i % MONITOR_STATES.length],
      }),
    )
    const snap = buildOpsSnapshot(inputs, { now: NOW })
    for (const state of TASK_STATES) expect(snap.byState[state]).toBe(1)
    expect(snap.byMonitorState['OFF']).toBe(Math.ceil(TASK_STATES.length / MONITOR_STATES.length))
    expect(snap.totals.tasks).toBe(TASK_STATES.length)
  })
})

describe('buildOpsSnapshot: age buckets and overdue', () => {
  it('buckets non-terminal age from updated_at with injected now', () => {
    const snap = buildOpsSnapshot(
      [
        entry('young', 'EXECUTING', { updatedMsAgo: 5 * MIN }),
        entry('mid', 'SYNCHRONIZING', { updatedMsAgo: 30 * MIN }),
        entry('old', 'RESEARCHING', { updatedMsAgo: 120 * MIN }),
        entry('done', 'CANCELLED', { updatedMsAgo: 240 * MIN }), // terminal: excluded
      ],
      { now: NOW, windowMs: 60 * MIN }, // only the 120m-old task is overdue past the window
    )
    expect(snap.age).toEqual({ nonTerminal: 3, under10m: 1, to10to60m: 1, over60m: 1, unparseableTimestamp: 0 })
    expect(snap.overdue).toEqual([{ id: 'old', state: 'RESEARCHING', ageMinutes: 120 }])
    expect(snap.overdueTotal).toBe(1)
  })

  it('overdue uses the window threshold, sorts oldest-first and caps at 20', () => {
    const windowMs = 10 * MIN
    const inputs: OpsSnapshotInput[] = []
    for (let i = 0; i < 21; i += 1) {
      inputs.push(entry(`stuck-${String(i).padStart(2, '0')}`, 'CLARIFYING', { updatedMsAgo: (11 + i) * MIN }))
    }
    inputs.push(entry('fresh', 'CLARIFYING', { updatedMsAgo: 1 * MIN }))
    const snap = buildOpsSnapshot(inputs, { now: NOW, windowMs })
    expect(snap.overdueTotal).toBe(21)
    expect(snap.overdue.length).toBe(20)
    expect(snap.overdue[0].id).toBe('stuck-20')
    expect(snap.overdue[0].ageMinutes).toBe(31)
    expect(snap.overdue[19].id).toBe('stuck-01') // stuck-00 sits at exactly 11m... verify below
    for (const row of snap.overdue) expect(row.ageMinutes).toBeGreaterThan(windowMs / MIN)
  })

  it('flags non-terminal rows whose updated_at cannot be parsed instead of guessing', () => {
    const broken = entry('broken', 'EXECUTING')
    broken.task.updated_at = 'not-a-date'
    const snap = buildOpsSnapshot([broken], { now: NOW })
    expect(snap.age.unparseableTimestamp).toBe(1)
    expect(snap.age.under10m + snap.age.to10to60m + snap.age.over60m).toBe(0)
    expect(snap.overdue).toEqual([])
  })
})

describe('buildOpsSnapshot: outcomes and trust numbers', () => {
  it('computes verifiedRate, catches CLOSED without verification, and respects the window', () => {
    const verifiedClose = entry('closed-ok', 'CLOSED', {
      updatedMsAgo: 2 * MIN,
      projection: { verification: { passed: true, evidence: ['ev-1'] } },
    })
    const lyingClose = entry('closed-lie', 'CLOSED', { updatedMsAgo: 3 * MIN }) // no verification at all
    const fulfilled = entry('fulfilled-ok', 'FULFILLED', {
      updatedMsAgo: 4 * MIN,
      persona: 'concierge',
      projection: { verification: { passed: true, evidence: ['ev-2'] } },
    })
    const cancelled = entry('cancelled', 'CANCELLED', { updatedMsAgo: 5 * MIN })
    const stale = entry('closed-stale', 'CLOSED', { updatedMsAgo: 30 * 60 * MIN }) // outside window
    const snap = buildOpsSnapshot([verifiedClose, lyingClose, fulfilled, cancelled, stale], { now: NOW })
    expect(snap.outcomes.finished).toBe(4)
    expect(snap.outcomes.verified).toBe(3)
    expect(snap.outcomes.verifiedRate).toBe(0.75)
    expect(snap.outcomes.falseCompletions).toBe(1)
    expect(snap.outcomes.falseCompletionIds).toEqual(['closed-lie'])
    expect(snap.outcomes.byCategory).toEqual([
      { category: 'concierge', finished: 1, verified: 1, verifiedRate: 1 },
      { category: 'friend', finished: 3, verified: 2, verifiedRate: 0.6667 },
    ])
  })

  it('treats passed:false as a false completion too', () => {
    const snap = buildOpsSnapshot(
      [entry('bad', 'CLOSED', { updatedMsAgo: MIN, projection: { verification: { passed: false, evidence: [] } } })],
      { now: NOW },
    )
    expect(snap.outcomes.falseCompletions).toBe(1)
  })

  it('counts reconciliation backlog and the four awaiting-user states', () => {
    const snap = buildOpsSnapshot(
      [
        entry('recon-1', 'NEEDS_RECONCILIATION'),
        entry('recon-2', 'NEEDS_RECONCILIATION'),
        entry('paused', 'PAUSED_BY_USER'),
        entry('takeover', 'HUMAN_TAKEOVER'),
        entry('authority', 'WAITING_FOR_AUTHORITY'),
        entry('selection', 'WAITING_FOR_SELECTION'),
        entry('executing', 'EXECUTING'),
      ],
      { now: NOW },
    )
    expect(snap.outcomes.needsReconciliationBacklog).toBe(2)
    expect(snap.outcomes.awaitingUser).toEqual({
      total: 4,
      byState: { PAUSED_BY_USER: 1, HUMAN_TAKEOVER: 1, WAITING_FOR_AUTHORITY: 1, WAITING_FOR_SELECTION: 1 },
    })
  })
})

describe('buildOpsSnapshot: handoff resume, interventions, sync lag', () => {
  it('exposes numerator/denominator and per-kind counts for handoff resume', () => {
    const byArtifact = entry('h-1', 'VERIFYING', {
      projection: {
        artifacts: [
          { kind: 'handoff:credential', ref: 'vault://x' },
          { kind: 'handoff_resumed:credential', ref: null },
        ],
      },
    })
    const byStateResume = entry('h-2', 'EXECUTING', {
      projection: { artifacts: [{ kind: 'handoff:payment', ref: 'stripe://y' }] },
    })
    const notResumed = entry('h-3', 'WAITING_FOR_AUTHORITY', {
      projection: { artifacts: [{ kind: 'handoff:payment', ref: 'stripe://z' }] },
    })
    const untouched = entry('h-4', 'RESEARCHING')
    const snap = buildOpsSnapshot([byArtifact, byStateResume, notResumed, untouched], { now: NOW })
    expect(snap.handoffResume.tasksRequested).toBe(3)
    expect(snap.handoffResume.tasksResumed).toBe(2)
    expect(snap.handoffResume.rate).toBe(0.6667)
    // payment's resume comes from the EXECUTING state, not a resumed artifact,
    // so the artifact-level byKind tally honestly shows 0 resumed artifacts.
    expect(snap.handoffResume.byKind).toEqual([
      { kind: 'credential', requested: 1, resumed: 1 },
      { kind: 'payment', requested: 2, resumed: 0 },
    ])
    expect(snap.handoffResume.basis).toContain('EXECUTING')
    // Resume only counts when it comes after a request, not when artifacts
    // appear in the impossible order (request must precede resume).
    const backwards = entry('h-5', 'SYNCHRONIZING', {
      projection: {
        verification: { passed: true, evidence: [] },
        artifacts: [
          { kind: 'handoff_resumed:credential', ref: null },
          { kind: 'handoff:credential', ref: 'vault://x' },
        ],
      },
    })
    const back = buildOpsSnapshot([backwards], { now: NOW })
    expect(back.handoffResume.tasksRequested).toBe(1)
    expect(back.handoffResume.tasksResumed).toBe(0)
  })

  it('counts interventions from handoff artifacts or current takeover state', () => {
    const snap = buildOpsSnapshot(
      [
        entry('i-1', 'HUMAN_TAKEOVER'),
        entry('i-2', 'EXECUTING', { projection: { artifacts: [{ kind: 'handoff:credential', ref: 'v' }] } }),
        entry('i-3', 'RESEARCHING'),
        entry('i-4', 'RESEARCHING'),
      ],
      { now: NOW },
    )
    expect(snap.interventions).toEqual({
      tasks: 4,
      intervened: 2,
      rate: 0.5,
      basis: snap.interventions.basis,
    })
  })

  it('approximates sync lag from updated_at and only counts tasks with surfaces', () => {
    const lagA = entry('s-1', 'SYNCHRONIZING', {
      updatedMsAgo: 10 * MIN,
      projection: { sync_state: { calendar: { status: 'ok' } } },
    })
    const lagB = entry('s-2', 'SYNCHRONIZING', {
      updatedMsAgo: 30 * MIN,
      projection: { sync_state: { calendar: { status: 'ok' }, email: { status: 'pending' } } },
    })
    const noSync = entry('s-3', 'SYNCHRONIZING', { updatedMsAgo: 60 * MIN })
    const snap = buildOpsSnapshot([lagA, lagB, noSync], { now: NOW })
    expect(snap.syncLag.tasksWithSync).toBe(2)
    expect(snap.syncLag.surfaces).toBe(3)
    expect(snap.syncLag.maxLagMs).toBe(30 * MIN)
    expect(snap.syncLag.avgLagMs).toBe(20 * MIN)
    expect(snap.syncLag.basis).toContain('updated_at')
  })
})

describe('buildOpsSnapshot: failures and user load', () => {
  it('ranks failure reason counts deterministically (count desc, code asc)', () => {
    const snap = buildOpsSnapshot(
      [
        entry('f-1', 'FAILED_RETRYABLE', { projection: { failure: { reason_code: 'sync_retryable' } } }),
        entry('f-2', 'FAILED_RETRYABLE', { projection: { failure: { reason_code: 'sync_retryable' } } }),
        entry('f-3', 'HUMAN_TAKEOVER', { projection: { failure: { reason_code: 'credential_required' } } }),
        entry('f-4', 'FAILED_FINAL', { projection: { failure: { reason_code: 'browser_replan_required' } } }),
        entry('f-5', 'RESEARCHING', { updatedMsAgo: MIN }),
      ],
      { now: NOW },
    )
    expect(snap.topFailureReasons).toEqual([
      { reason_code: 'sync_retryable', count: 2 },
      { reason_code: 'browser_replan_required', count: 1 },
      { reason_code: 'credential_required', count: 1 },
    ])
  })

  it('lists top 20 users by unfinished count, tie-broken by user id', () => {
    const inputs: OpsSnapshotInput[] = []
    for (let i = 0; i < 5; i += 1) inputs.push(entry(`hot-${i}`, 'EXECUTING', { userId: 'user-hot' }))
    for (let u = 0; u < 25; u += 1) {
      inputs.push(entry(`one-${u}`, 'RESEARCHING', { userId: `user-${String(u).padStart(2, '0')}` }))
    }
    inputs.push(entry('done', 'CLOSED', { userId: 'user-hot' })) // finished, does not count
    const snap = buildOpsSnapshot(inputs, { now: NOW })
    expect(snap.perUser.length).toBe(20)
    expect(snap.perUser[0]).toEqual({ user_id: 'user-hot', unfinished: 5 })
    expect(snap.perUser[1]).toEqual({ user_id: 'user-00', unfinished: 1 })
    expect(snap.perUser[19]).toEqual({ user_id: 'user-18', unfinished: 1 })
  })
})

describe('buildOpsSnapshot: purity and determinism', () => {
  it('same input produces byte-identical JSON', () => {
    const inputs = [
      entry('a', 'CLOSED', { updatedMsAgo: 3 * MIN }),
      entry('b', 'EXECUTING', { updatedMsAgo: 70 * MIN, projection: { artifacts: [{ kind: 'handoff:payment', ref: 'p' }] } }),
      entry('c', 'NEEDS_RECONCILIATION', { projection: { failure: { reason_code: 'needs_reconciliation' } } }),
      entry('d', 'WAITING_FOR_SELECTION', { persona: 'concierge' }),
    ]
    expect(JSON.stringify(buildOpsSnapshot(inputs, { now: NOW }))).toBe(
      JSON.stringify(buildOpsSnapshot(inputs, { now: NOW })),
    )
  })

  it('input order does not change the JSON', () => {
    const inputs = [
      entry('x-1', 'RESEARCHING', { updatedMsAgo: 200 * MIN, projection: { failure: { reason_code: 'research_retryable' } } }),
      entry('x-2', 'RESEARCHING', { updatedMsAgo: 200 * MIN, projection: { failure: { reason_code: 'research_retryable' } } }),
      entry('x-3', 'EXECUTING', { updatedMsAgo: 200 * MIN, projection: { failure: { reason_code: 'sync_retryable' } } }),
      entry('x-4', 'CLOSED', { updatedMsAgo: MIN }),
      entry('x-5', 'HUMAN_TAKEOVER', { updatedMsAgo: MIN, userId: 'user-z' }),
    ]
    const forward = JSON.stringify(buildOpsSnapshot(inputs, { now: NOW }))
    const backward = JSON.stringify(buildOpsSnapshot([...inputs].reverse(), { now: NOW }))
    expect(backward).toBe(forward)
  })

  it('is JSON-safe: no undefined values and integers stay integers', () => {
    const snap = buildOpsSnapshot([entry('j', 'SYNCHRONIZING', { updatedMsAgo: 90 * MIN })], { now: NOW })
    const round = JSON.parse(JSON.stringify(snap))
    expect(round).toEqual(snap)
    expect(Number.isInteger(snap.age.over60m)).toBe(true)
  })
})

describe('renderOpsText', () => {
  it('shouts both ZERO-TOLERANCE lines', () => {
    const snap = buildOpsSnapshot(
      [
        entry('lie-1', 'CLOSED', { updatedMsAgo: 2 * MIN }),
        entry('ok-1', 'FULFILLED', { updatedMsAgo: MIN }),
        entry('gone-1', 'CANCELLED', { updatedMsAgo: MIN }),
      ],
      { now: NOW },
    )
    const text = renderOpsText(snap)
    expect(text).toContain('false completions: 1')
    expect(text).toContain('unapproved actions: not-instrumented')
    expect(text).toContain('!! ZERO-TOLERANCE')
    expect(text.split('\n').length).toBeLessThanOrEqual(40)
    expect(text).toContain('OPS SNAPSHOT')
    expect(text).toContain('verifiedRate 66.67%')
  })

  it('renders a clean zero-tolerance pass line when nothing is wrong', () => {
    const snap = buildOpsSnapshot([], { now: NOW })
    const text = renderOpsText(snap)
    expect(text).toContain('false completions: 0')
    expect(text).toContain('unapproved actions: not-instrumented')
  })
})
