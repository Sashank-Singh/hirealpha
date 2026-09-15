import { describe, expect, it } from 'bun:test'
import {
  TaskNotFoundError,
  appendEvent,
  createTask,
  loadProjection,
} from './taskStore'
import { TaskTransitionError, seedProjection, type TaskProjection } from './taskContract'
import {
  classifyStuck,
  closeReconciliation,
  reconciliationReport,
  sweepTasks,
  VERDICT_KINDS,
  type ReportedProjection,
  type TimedProjection,
} from './recovery'

type Row = Record<string, unknown>

/* ---------------------------------------------------------- fake SQL (copy) */

/**
 * Stateful fake: implements just the shapes taskStore emits (pattern copied
 * from taskStore.test.ts). Rows store JSONB as strings; updated_at stays at
 * the injected creation time so tests control staleness directly.
 */
function fakeTaskDb() {
  const tasks = new Map<string, Row>()
  const events: Row[] = []

  const sql = ((strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.join('?')
    if (text.includes('INSERT INTO hire_tasks')) {
      const row: Row = {
        id: `task-${tasks.size + 1}`,
        user_id: values[0],
        persona: values[1],
        conversation_id: values[2] ?? null,
        request: values[3],
        state: 'DRAFT',
        resumed_state: null,
        monitor_state: 'OFF',
        monitor_policy: null,
        monitor_next_check_at: null,
        plan_version: 0,
        plan: null,
        current_step: null,
        constraints: '{}',
        options: '[]',
        selected_option_id: null,
        grants: '[]',
        external_ops: '[]',
        artifacts: '[]',
        verification: null,
        sync_state: '{}',
        failure: null,
        version: 0,
        event_seq: 0,
        created_at: '2026-09-14T00:00:00Z',
        updated_at: '2026-09-14T00:00:00Z',
      }
      tasks.set(String(row.id), row)
      return Promise.resolve([row])
    }
    if (text.includes('UPDATE hire_tasks') && text.includes('SET version = 1')) {
      const row = tasks.get(String(values[0]))
      if (row) Object.assign(row, { version: 1, event_seq: 1 })
      return Promise.resolve(row ? [row] : [])
    }
    if (text.includes('UPDATE hire_tasks') && text.includes('SET state')) {
      const [state, resumed, constraints, monitorState, monitorPolicy, monitorNext, planVersion, plan, currentStep, options, selected, grants, ops, artifacts, verification, sync, failure, seq, taskId, userId, expectedVersion] = values
      const row = tasks.get(String(taskId))
      if (!row || row.user_id !== userId || row.version !== expectedVersion) return Promise.resolve([])
      Object.assign(row, {
        state, resumed_state: resumed, constraints, monitor_state: monitorState,
        monitor_policy: monitorPolicy, monitor_next_check_at: monitorNext,
        plan_version: planVersion, plan, current_step: currentStep, options,
        selected_option_id: selected, grants, external_ops: ops, artifacts,
        verification, sync_state: sync, failure,
        version: Number(row.version) + 1, event_seq: seq,
      })
      return Promise.resolve([row])
    }
    if (text.includes('INSERT INTO hire_task_events')) {
      if (text.includes('causation_id')) {
        const [eventId, taskId, userId, type, actor, causation, correlation, idemKey, payload, seq] = values
        events.push({
          event_id: eventId, task_id: taskId, user_id: userId, schema_version: 1,
          type, actor, causation_id: causation, correlation_id: correlation,
          idempotency_key: idemKey, occurred_at: '2026-09-14T00:00:01Z', payload, task_seq: seq,
        })
      } else {
        const [eventId, taskId, userId, type, actor, payload, seq] = values
        events.push({
          event_id: eventId, task_id: taskId, user_id: userId, schema_version: 1,
          type, actor, causation_id: null, correlation_id: null, idempotency_key: null,
          occurred_at: '2026-09-14T00:00:00Z', payload, task_seq: seq,
        })
      }
      return Promise.resolve([events[events.length - 1]])
    }
    if (text.includes('FROM hire_task_events') && text.includes('idempotency_key =')) {
      const [taskId, idemKey] = values
      return Promise.resolve(events.filter((e) => e.task_id === taskId && e.idempotency_key === idemKey).slice(0, 1))
    }
    if (text.includes('FROM hire_task_events')) {
      const [taskId, userId, afterSeq] = values
      return Promise.resolve(
        events
          .filter((e) => e.task_id === taskId && e.user_id === userId && Number(e.task_seq) > Number(afterSeq))
          .sort((a, b) => Number(a.task_seq) - Number(b.task_seq)),
      )
    }
    if (text.includes('FROM hire_tasks') && text.includes('ORDER BY updated_at')) {
      const all = [...tasks.values()]
      if (text.includes('WHERE user_id')) return Promise.resolve(all.filter((row) => row.user_id === values[0]))
      return Promise.resolve(all)
    }
    if (text.includes('FROM hire_tasks')) {
      const [taskId, userId] = values
      const row = tasks.get(String(taskId))
      return Promise.resolve(row && row.user_id === userId ? [row] : [])
    }
    throw new Error(`fakeTaskDb: unmatched query: ${text.slice(0, 120)}`)
  }) as { begin: (cb: (tx: never) => Promise<unknown>) => Promise<unknown> }
  sql.begin = (cb) => cb(sql as never)

  return { sql: sql as never, tasks, events }
}

/* ------------------------------------------------------------------ helpers */

const NOW = '2026-09-14T12:00:00Z'
const HOUR_MS = 3_600_000
const DAY_MS = 24 * HOUR_MS
const THRESHOLDS = { executingWallMs: HOUR_MS, verifyStallMs: 30 * 60_000 }

function projection(over: Partial<TaskProjection> & { updated_at: string }): TimedProjection {
  return { ...seedProjection('buy groceries', 'friend', null), ...over }
}

async function makeTask(db: ReturnType<typeof fakeTaskDb>, userId = 'user-1', request = 'do a thing') {
  return createTask(db.sql, { userId, request, persona: 'friend' })
}

/** DRAFT -> PLANNING_ACTION -> EXECUTING (no options, authority not required). */
async function driveToExecuting(db: ReturnType<typeof fakeTaskDb>, taskId: string, userId = 'user-1') {
  await appendEvent(db.sql, { userId, taskId, type: 'state_changed', payload: { to: 'PLANNING_ACTION' }, actor: 'alpha' })
  await appendEvent(db.sql, {
    userId, taskId, type: 'state_changed',
    payload: { to: 'EXECUTING', authority: 'not_required' }, actor: 'alpha',
  })
}

async function driveToNeedsReconciliation(db: ReturnType<typeof fakeTaskDb>, taskId: string, userId = 'user-1') {
  await driveToExecuting(db, taskId, userId)
  await appendEvent(db.sql, {
    userId, taskId, type: 'state_changed',
    payload: { to: 'NEEDS_RECONCILIATION', reason_code: 'needs_reconciliation' }, actor: 'alpha',
  })
}

function ageRow(db: ReturnType<typeof fakeTaskDb>, taskId: string, updatedAt: string) {
  const row = db.tasks.get(taskId)
  if (!row) throw new Error(`no such row: ${taskId}`)
  row.updated_at = updatedAt
}

const emptyVerdictCounts = (): Record<(typeof VERDICT_KINDS)[number], number> =>
  ({ 'in-flight': 0, reconcile: 0, unverified: 0, 'awaiting-user': 0, terminal: 0, 'idle-monitor': 0 })

/* --------------------------------------------------------- classifyStuck */

describe('classifyStuck', () => {
  it('EXECUTING older than executingWallMs is a dead worker -> reconcile', () => {
    const v = classifyStuck(
      projection({ state: 'EXECUTING', updated_at: '2026-09-14T09:00:00Z' }),
      NOW,
      THRESHOLDS,
    )
    expect(v.kind).toBe('reconcile')
    expect(v.reason).toBe('executing_stalled')
    expect(v.age_ms).toBe(3 * HOUR_MS)
  })

  it('fresh EXECUTING stays in-flight', () => {
    const v = classifyStuck(projection({ state: 'EXECUTING', updated_at: NOW }), NOW, THRESHOLDS)
    expect(v.kind).toBe('in-flight')
  })

  it('VERIFYING with failed verification -> unverified (age irrelevant)', () => {
    const v = classifyStuck(
      projection({
        state: 'VERIFYING',
        updated_at: '2026-09-01T00:00:00Z',
        verification: { passed: false, evidence: ['receipt_incomplete:purchase:total_cents'] },
      }),
      NOW,
      THRESHOLDS,
    )
    expect(v.kind).toBe('unverified')
    expect(v.reason).toBe('verification_failed')
  })

  it('VERIFYING stalled with no verification at all -> reconcile (verifying_stalled)', () => {
    const v = classifyStuck(
      projection({ state: 'VERIFYING', updated_at: '2026-09-14T11:00:00Z' }),
      NOW,
      THRESHOLDS,
    )
    expect(v.kind).toBe('reconcile')
    expect(v.reason).toBe('verifying_stalled')
  })

  it('VERIFYING with passed verification is not stalled even when old (receipts/finish own it)', () => {
    const v = classifyStuck(
      projection({ state: 'VERIFYING', updated_at: '2026-09-01T00:00:00Z', verification: { passed: true, evidence: ['sha256:x'] } }),
      NOW,
      THRESHOLDS,
    )
    expect(v.kind).toBe('in-flight')
  })

  it('user-held states -> awaiting-user', () => {
    for (const state of ['WAITING_FOR_AUTHORITY', 'PAUSED_BY_USER', 'HUMAN_TAKEOVER'] as const) {
      const v = classifyStuck(projection({ state, updated_at: '2026-01-01T00:00:00Z' }), NOW, THRESHOLDS)
      expect(v.kind).toBe('awaiting-user')
    }
  })

  it('FAILED_FINAL / CLOSED / CANCELLED / FULFILLED -> terminal', () => {
    for (const state of ['FAILED_FINAL', 'CLOSED', 'CANCELLED', 'FULFILLED'] as const) {
      const v = classifyStuck(projection({ state, updated_at: '2026-01-01T00:00:00Z' }), NOW, THRESHOLDS)
      expect(v.kind).toBe('terminal')
    }
  })

  it('terminal with a live monitor -> idle-monitor', () => {
    for (const monitor of ['SCHEDULED', 'CHECKING', 'DEGRADED'] as const) {
      const v = classifyStuck(
        projection({ state: 'FULFILLED', monitor_state: monitor, updated_at: '2026-01-01T00:00:00Z' }),
        NOW,
        THRESHOLDS,
      )
      expect(v.kind).toBe('idle-monitor')
      expect(v.reason).toBe('monitor_live')
    }
    const ended = classifyStuck(
      projection({ state: 'CLOSED', monitor_state: 'ENDED', updated_at: '2026-01-01T00:00:00Z' }),
      NOW,
      THRESHOLDS,
    )
    expect(ended.kind).toBe('terminal')
  })

  it('NEEDS_RECONCILIATION reads as reconcile/already_reconciling, never as work to run', () => {
    const v = classifyStuck(
      projection({ state: 'NEEDS_RECONCILIATION', updated_at: '2026-09-10T00:00:00Z' }),
      NOW,
      THRESHOLDS,
    )
    expect(v.kind).toBe('reconcile')
    expect(v.reason).toBe('already_reconciling')
  })

  it('a corrupt updated_at never manufactures a stall verdict', () => {
    const v = classifyStuck(projection({ state: 'EXECUTING', updated_at: 'not-a-date' }), NOW, THRESHOLDS)
    expect(v.age_ms).toBe(0)
    expect(v.kind).toBe('in-flight')
  })
})

/* ----------------------------------------------------------------- sweep */

describe('sweepTasks', () => {
  it('marks stalled executions once and counts every verdict', async () => {
    const db = fakeTaskDb()
    const stalled = await makeTask(db, 'user-1', 'order flowers')
    await driveToExecuting(db, stalled.id)
    ageRow(db, stalled.id, '2026-09-14T08:00:00Z')
    const healthy = await makeTask(db, 'user-1', 'fresh draft')
    const held = await makeTask(db, 'user-2', 'paused thing')
    await appendEvent(db.sql, { userId: 'user-2', taskId: held.id, type: 'state_changed', payload: { to: 'PAUSED_BY_USER' }, actor: 'alpha' })

    const result = await sweepTasks(db.sql, { now: NOW, ...THRESHOLDS, actor: 'sweeper' })

    expect(result.scanned).toBe(3)
    expect(result.marked).toHaveLength(1)
    expect(result.marked[0]?.taskId).toBe(stalled.id)
    expect(result.marked[0]?.idempotencyKey).toBe(`reconcile:${stalled.id}:3`)
    expect(result.alreadyReconciling).toBe(0)
    expect(result.byVerdict).toEqual({ ...emptyVerdictCounts(), reconcile: 1, 'in-flight': 1, 'awaiting-user': 1 })

    const marked = await loadProjection(db.sql, { userId: 'user-1', taskId: stalled.id })
    expect(marked?.state).toBe('NEEDS_RECONCILIATION')
    expect(marked?.failure).toBe(null) // a mark is a state move, not a failure record
  })

  it('is idempotent: a second sweep marks nothing and never double-writes', async () => {
    const db = fakeTaskDb()
    const task = await makeTask(db)
    await driveToExecuting(db, task.id)
    ageRow(db, task.id, '2026-09-13T00:00:00Z')

    const first = await sweepTasks(db.sql, { now: NOW, ...THRESHOLDS, actor: 'sweeper' })
    const second = await sweepTasks(db.sql, { now: NOW, ...THRESHOLDS, actor: 'sweeper' })

    expect(first.marked).toHaveLength(1)
    expect(second.marked).toHaveLength(0)
    expect(second.alreadyReconciling).toBe(1)
    const reconcileEvents = db.events.filter(
      (e) => typeof e.idempotency_key === 'string' && (e.idempotency_key as string).startsWith('reconcile:'),
    )
    expect(reconcileEvents).toHaveLength(1)
  })

  it('respects the userIds filter', async () => {
    const db = fakeTaskDb()
    const mine = await makeTask(db, 'user-1')
    await driveToExecuting(db, mine.id)
    ageRow(db, mine.id, '2026-09-13T00:00:00Z')
    const theirs = await makeTask(db, 'user-2')
    await driveToExecuting(db, theirs.id, 'user-2')
    ageRow(db, theirs.id, '2026-09-13T00:00:00Z')

    const scoped = await sweepTasks(db.sql, { userIds: ['user-1'], now: NOW, ...THRESHOLDS, actor: 'sweeper' })
    expect(scoped.scanned).toBe(1)
    expect(scoped.marked.map((m) => m.taskId)).toEqual([mine.id])
    const theirProjection = await loadProjection(db.sql, { userId: 'user-2', taskId: theirs.id })
    expect(theirProjection?.state).toBe('EXECUTING')
  })

  it('unverified VERIFYING is reported, not silently requeued', async () => {
    const db = fakeTaskDb()
    const task = await makeTask(db)
    await driveToExecuting(db, task.id)
    await appendEvent(db.sql, { userId: 'user-1', taskId: task.id, type: 'state_changed', payload: { to: 'VERIFYING' }, actor: 'alpha' })
    await appendEvent(db.sql, {
      userId: 'user-1', taskId: task.id, type: 'verification_recorded',
      payload: { passed: false, evidence: ['receipt_incomplete:purchase:confirmation_id'] }, actor: 'receipt_engine',
    })
    ageRow(db, task.id, '2026-09-01T00:00:00Z')

    const result = await sweepTasks(db.sql, { now: NOW, ...THRESHOLDS, actor: 'sweeper' })
    expect(result.byVerdict.unverified).toBe(1)
    expect(result.marked).toHaveLength(0)
  })

  it('NEVER auto-retries: a reconciling task is never read as runnable and cannot move to EXECUTING', async () => {
    const db = fakeTaskDb()
    const task = await makeTask(db)
    await driveToExecuting(db, task.id)
    ageRow(db, task.id, '2026-09-13T00:00:00Z')
    await sweepTasks(db.sql, { now: NOW, ...THRESHOLDS, actor: 'sweeper' })

    const projectionNow = await loadProjection(db.sql, { userId: 'user-1', taskId: task.id })
    expect(projectionNow?.state).toBe('NEEDS_RECONCILIATION')
    const verdict = classifyStuck(
      { ...projectionNow!, updated_at: '2026-09-13T00:00:00Z' },
      NOW,
      THRESHOLDS,
    )
    // A dead worker's stall must never resurface as an in-flight/runnable verdict.
    expect(verdict.kind).toBe('reconcile')
    expect(VERDICT_KINDS as readonly string[]).not.toContain('executing')

    await expect(
      appendEvent(db.sql, { userId: 'user-1', taskId: task.id, type: 'state_changed', payload: { to: 'EXECUTING' }, actor: 'sweeper' }),
    ).rejects.toBeInstanceOf(TaskTransitionError)

    // Sweeping repeatedly keeps it parked.
    await sweepTasks(db.sql, { now: NOW, ...THRESHOLDS, actor: 'sweeper' })
    await sweepTasks(db.sql, { now: NOW, ...THRESHOLDS, actor: 'sweeper' })
    const still = await loadProjection(db.sql, { userId: 'user-1', taskId: task.id })
    expect(still?.state).toBe('NEEDS_RECONCILIATION')
  })
})

/* ---------------------------------------------------------------- report */

describe('reconciliationReport', () => {
  const base = () => seedProjection('request', 'friend', null)
  const p = (over: Partial<TaskProjection> & { task_id: string; updated_at: string }): ReportedProjection => ({
    ...base(),
    ...over,
  })

  it('rolls up backlog size, oldest age, and per-reason counts with an injected clock', () => {
    const report = reconciliationReport(
      [
        p({
          task_id: 't-old', state: 'NEEDS_RECONCILIATION', updated_at: '2026-09-12T12:00:00Z',
          failure: { reason_code: 'needs_reconciliation' },
        }),
        p({
          task_id: 't-replan', state: 'NEEDS_RECONCILIATION', updated_at: '2026-09-14T11:00:00Z',
          failure: { reason_code: 'browser_replan_required' },
        }),
        p({
          task_id: 't-unverified', state: 'VERIFYING', updated_at: '2026-09-14T10:00:00Z',
          verification: { passed: false, evidence: ['sha256:nope'] },
        }),
        p({ task_id: 't-live', state: 'DRAFT', updated_at: '2026-09-14T11:59:00Z' }),
      ],
      { now: NOW },
    )
    expect(report.backlog_size).toBe(3)
    expect(report.oldest_age_ms).toBe(2 * DAY_MS)
    expect(report.per_reason).toEqual({
      needs_reconciliation: 1,
      browser_replan_required: 1,
      verification_failed: 1,
    })
    expect(report.now_ms).toBe(Date.parse(NOW))
  })

  it('empty backlog reports null oldest age and zero counts', () => {
    const report = reconciliationReport([p({ task_id: 't', state: 'DRAFT', updated_at: NOW })], { now: NOW })
    expect(report.backlog_size).toBe(0)
    expect(report.oldest_age_ms).toBe(null)
    expect(report.per_reason).toEqual({})
    expect(report.uncertain_ops_in_reconciliation).toEqual([])
    expect(report.retry_lane_violations).toEqual([])
  })

  it('joins non-done external ops to reconciling tasks ("outcome unknown, checking before retrying")', () => {
    const report = reconciliationReport(
      [
        p({
          task_id: 't-parked', state: 'NEEDS_RECONCILIATION', updated_at: '2026-09-14T11:00:00Z',
          failure: { reason_code: 'needs_reconciliation' },
          external_ops: [
            { operation: 'charge', idempotency_key: 'k-1', status: 'submitted' },
            { operation: 'email_receipt', idempotency_key: 'k-2', status: 'done' },
          ],
        }),
        p({
          task_id: 't-closed-fine', state: 'CLOSED', updated_at: '2026-09-14T11:00:00Z',
          external_ops: [{ operation: 'charge', idempotency_key: 'k-3', status: 'done' }],
        }),
      ],
      { now: NOW },
    )
    expect(report.uncertain_ops_in_reconciliation).toEqual([
      { task_id: 't-parked', ops: [{ operation: 'charge', idempotency_key: 'k-1', status: 'submitted' }] },
    ])
    expect(report.retry_lane_violations).toEqual([])
  })

  it('flags loudly any canAutoRetry:false task left in the retry lane', () => {
    const report = reconciliationReport(
      [
        p({
          task_id: 't-danger', state: 'FAILED_RETRYABLE', updated_at: '2026-09-14T11:00:00Z',
          resumed_state: 'EXECUTING',
          external_ops: [{ operation: 'charge', idempotency_key: 'k-9', status: 'unknown' }],
        }),
      ],
      { now: NOW },
    )
    expect(report.retry_lane_violations).toHaveLength(1)
    expect(report.retry_lane_violations[0]?.task_id).toBe('t-danger')
  })
})

/* ----------------------------------------------------------------- close */

describe('closeReconciliation', () => {
  it('verified closes back to VERIFYING with an artifact trail', async () => {
    const db = fakeTaskDb()
    const task = await makeTask(db)
    await driveToNeedsReconciliation(db, task.id)
    ageRow(db, task.id, '2026-09-13T00:00:00Z')

    const before = await loadProjection(db.sql, { userId: 'user-1', taskId: task.id })
    const result = await closeReconciliation(db.sql, {
      userId: 'user-1', taskId: task.id, outcome: 'verified', actor: 'ops', note: 'provider portal shows confirmed',
    })
    expect(before?.state).toBe('NEEDS_RECONCILIATION')
    expect(result.task.state).toBe('VERIFYING')
    expect(result.events.map((e) => e.type)).toEqual(['artifact_recorded', 'artifact_recorded', 'state_changed'])
    expect(result.events.every((e) => typeof e.idempotency_key === 'string' && (e.idempotency_key as string).startsWith('reconcile-close:'))).toBe(true)
  })

  it('takeover closes to HUMAN_TAKEOVER with a failure trail', async () => {
    const db = fakeTaskDb()
    const task = await makeTask(db)
    await driveToNeedsReconciliation(db, task.id)
    const result = await closeReconciliation(db.sql, {
      userId: 'user-1', taskId: task.id, outcome: 'takeover', actor: 'ops',
    })
    expect(result.task.state).toBe('HUMAN_TAKEOVER')
    expect(result.events.map((e) => e.type)).toEqual(['failure_recorded', 'state_changed'])
    const failure = result.events[0]?.payload as Record<string, unknown>
    expect(failure.reason_code).toBe('human_takeover_required')
  })

  it('cancelled closes to CANCELLED with a failure trail', async () => {
    const db = fakeTaskDb()
    const task = await makeTask(db)
    await driveToNeedsReconciliation(db, task.id)
    const result = await closeReconciliation(db.sql, {
      userId: 'user-1', taskId: task.id, outcome: 'cancelled', actor: 'ops', note: 'user confirmed nothing was charged',
    })
    expect(result.task.state).toBe('CANCELLED')
    const failure = result.events[0]?.payload as Record<string, unknown>
    expect(failure.reason_code).toBe('needs_reconciliation')
    expect(failure.detail).toBe('user confirmed nothing was charged')
  })

  it('rejects a close from any other state and touches nothing', async () => {
    const db = fakeTaskDb()
    const task = await makeTask(db)
    const before = db.events.length
    await expect(
      closeReconciliation(db.sql, { userId: 'user-1', taskId: task.id, outcome: 'verified', actor: 'ops' }),
    ).rejects.toBeInstanceOf(TaskTransitionError)
    expect(db.events).toHaveLength(before)
  })

  it('a replayed close cannot double-append: the second attempt hits the state gate', async () => {
    const db = fakeTaskDb()
    const task = await makeTask(db)
    await driveToNeedsReconciliation(db, task.id)
    await closeReconciliation(db.sql, { userId: 'user-1', taskId: task.id, outcome: 'cancelled', actor: 'ops' })
    await expect(
      closeReconciliation(db.sql, { userId: 'user-1', taskId: task.id, outcome: 'cancelled', actor: 'ops' }),
    ).rejects.toBeInstanceOf(TaskTransitionError)
    const stateEvents = db.events.filter(
      (e) => typeof e.idempotency_key === 'string' && (e.idempotency_key as string).startsWith('reconcile-close:'),
    )
    expect(stateEvents).toHaveLength(2) // trail + state, once
  })

  it('unknown task -> TaskNotFoundError; bad outcome -> plain validation error', async () => {
    const db = fakeTaskDb()
    await expect(
      closeReconciliation(db.sql, { userId: 'user-1', taskId: 'missing', outcome: 'verified', actor: 'ops' }),
    ).rejects.toBeInstanceOf(TaskNotFoundError)
    const task = await makeTask(db)
    await expect(
      closeReconciliation(db.sql, {
        userId: 'user-1', taskId: task.id, outcome: 'retry-harder' as 'verified', actor: 'ops',
      }),
    ).rejects.toThrow('Unknown reconciliation outcome')
  })
})
