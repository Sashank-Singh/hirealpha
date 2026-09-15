import { describe, expect, it } from 'bun:test'
import { appendEvent, createTask, loadProjection } from './taskStore'
import { seedProjection, type TaskProjection } from './taskContract'
import type { ReportedProjection } from './recovery'
import {
  buildReconcileDigest,
  createRecoveryLoopState,
  digestClaimKey,
  mountRecoveryLoop,
  nextDigestDue,
  runRecoveryPassOnce,
  runRecoverySweep,
  type RecoveryLoopState,
} from './recoveryLoop'

type Row = Record<string, unknown>

/* ---------------------------------------------------------- fake SQL (copy) */

/**
 * Stateful fake, copied from recovery.test.ts: implements just the shapes
 * taskStore emits. updated_at stays at the injected value so tests control
 * staleness directly (the UPDATE branch never bumps it).
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
const NOW_MS = Date.parse(NOW)
const HOUR_MS = 3_600_000

function rp(over: Partial<TaskProjection> & { task_id: string; updated_at: string }): ReportedProjection {
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

async function driveToFailedVerification(db: ReturnType<typeof fakeTaskDb>, taskId: string, userId = 'user-1') {
  await driveToExecuting(db, taskId, userId)
  await appendEvent(db.sql, { userId, taskId, type: 'state_changed', payload: { to: 'VERIFYING' }, actor: 'alpha' })
  await appendEvent(db.sql, {
    userId, taskId, type: 'verification_recorded',
    payload: { passed: false, evidence: ['receipt_incomplete:purchase:confirmation_id'] }, actor: 'receipt_engine',
  })
}

function ageRow(db: ReturnType<typeof fakeTaskDb>, taskId: string, updatedAt: string) {
  const row = db.tasks.get(taskId)
  if (!row) throw new Error(`no such row: ${taskId}`)
  row.updated_at = updatedAt
}

/** Stale EXECUTING task: the sweep's canonical victim (age 1h > 11min lease). */
async function makeStaleExecuting(db: ReturnType<typeof fakeTaskDb>, userId = 'user-1', request = 'order flowers') {
  const task = await makeTask(db, userId, request)
  await driveToExecuting(db, task.id, userId)
  ageRow(db, task.id, '2026-09-14T11:00:00Z')
  return task
}

/* --------------------------------------------------- buildReconcileDigest */

describe('buildReconcileDigest', () => {
  it('returns null when nothing needs eyes (empty, fresh, or terminal only)', () => {
    expect(buildReconcileDigest([], { now: NOW })).toBe(null)
    const healthy = rp({ task_id: 't-1', state: 'DRAFT', updated_at: NOW })
    const done = rp({ task_id: 't-2', state: 'CLOSED', updated_at: '2026-09-01T00:00:00Z' })
    const running = rp({ task_id: 't-3', state: 'EXECUTING', updated_at: NOW })
    expect(buildReconcileDigest([healthy, done, running], { now: NOW })).toBe(null)
  })

  it('counts verdicts honestly and never claims completion', () => {
    const text = buildReconcileDigest(
      [
        rp({ task_id: 't-a', state: 'EXECUTING', updated_at: '2026-09-14T08:00:00Z' }),
        rp({ task_id: 't-b', state: 'NEEDS_RECONCILIATION', updated_at: '2026-09-14T09:00:00Z' }),
        rp({
          task_id: 't-c', state: 'VERIFYING', updated_at: '2026-09-14T10:00:00Z',
          verification: { passed: false, evidence: ['receipt_incomplete:x'] },
        }),
      ],
      { now: NOW },
    )
    expect(text).not.toBe(null)
    const [header] = text!.split('\n')
    expect(header).toBe(
      '3 of your tasks need a look: 2 interrupted (I could not confirm what they did), ' +
        '1 finished without proof. Reply check on t-a to review.',
    )
    for (const banned of ['completed', 'done', 'finished for you', 'fixed']) {
      expect(text!.toLowerCase()).not.toContain(banned)
    }
  })

  it('lists awaiting-user tasks phrased as waiting on you', () => {
    const text = buildReconcileDigest(
      [
        rp({ task_id: 't-h', state: 'HUMAN_TAKEOVER', updated_at: '2026-09-14T10:00:00Z' }),
        rp({ task_id: 't-i', state: 'WAITING_FOR_AUTHORITY', updated_at: '2026-09-14T10:00:00Z' }),
      ],
      { now: NOW },
    )
    expect(text!.split('\n')[0]).toBe(
      '2 of your tasks need a look: 2 waiting on you. Reply check on t-h to review.',
    )
  })

  it('mixes all three lanes with honest phrases', () => {
    const text = buildReconcileDigest(
      [
        rp({ task_id: 't-1', state: 'NEEDS_RECONCILIATION', updated_at: '2026-09-14T10:00:00Z' }),
        rp({ task_id: 't-2', state: 'VERIFYING', updated_at: '2026-09-14T10:00:00Z', verification: { passed: false, evidence: ['x'] } }),
        rp({ task_id: 't-3', state: 'PAUSED_BY_USER', updated_at: '2026-09-14T10:00:00Z' }),
      ],
      { now: NOW },
    )
    expect(text!.split('\n')[0]).toBe(
      '3 of your tasks need a look: 1 interrupted (I could not confirm what they did), ' +
        '1 finished without proof, 1 waiting on you. Reply check on t-1 to review.',
    )
  })

  it('caps the listing at 5 lines and truncates requests at 70 chars (slice only)', () => {
    const long = 'x'.repeat(100)
    const many: ReportedProjection[] = []
    for (let i = 0; i < 7; i++) {
      many.push(rp({ task_id: `t-${i}`, state: 'NEEDS_RECONCILIATION', updated_at: '2026-09-14T10:00:00Z', request: long }))
    }
    const text = buildReconcileDigest(many, { now: NOW })!
    const lines = text.split('\n')
    expect(lines).toHaveLength(6) // header + 5 task lines
    expect(lines[1]).toBe(`t-0: ${'x'.repeat(70)}`)
    expect(text).not.toContain('t-6')
    expect(lines.slice(1).every((line) => !line.includes('x'.repeat(71)))).toBe(true)
  })

  it('is pure: does not mutate its input', () => {
    const input = [rp({ task_id: 't-1', state: 'NEEDS_RECONCILIATION', updated_at: '2026-09-14T10:00:00Z' })]
    const before = JSON.stringify(input)
    buildReconcileDigest(input, { now: NOW })
    expect(JSON.stringify(input)).toBe(before)
  })
})

/* -------------------------------------------------------------- cadence */

describe('nextDigestDue', () => {
  it('first ever run is always due', () => {
    expect(nextDigestDue(null, NOW)).toBe(true)
    expect(nextDigestDue(undefined, NOW)).toBe(true)
  })

  it('exactly 24h elapsed is due; one second short is not', () => {
    expect(nextDigestDue('2026-09-13T12:00:00Z', NOW)).toBe(true)
    expect(nextDigestDue('2026-09-13T12:00:01Z', NOW)).toBe(false)
  })

  it('a back-jumped clock does not fire (and the real crossing still does)', () => {
    expect(nextDigestDue('2026-09-14T18:00:00Z', NOW)).toBe(false)
    expect(nextDigestDue('2026-09-14T12:00:00Z', '2026-09-14T06:00:00Z')).toBe(false)
    expect(nextDigestDue('2026-09-13T12:00:00Z', '2026-09-14T13:00:00Z')).toBe(true)
  })

  it('honors a custom cadence and garbage inputs', () => {
    expect(nextDigestDue('2026-09-14T11:00:00Z', NOW, 1)).toBe(true)
    expect(nextDigestDue('2026-09-14T11:30:00Z', NOW, 1)).toBe(false)
    expect(nextDigestDue('not-a-date', NOW)).toBe(true) // unknown marker -> treat as never run
    expect(nextDigestDue(NOW, 'not-a-date')).toBe(false) // unparseable clock -> stay quiet
  })
})

describe('digestClaimKey', () => {
  it('derives reconcile-digest:YYYY-MM-DD from the injected now', () => {
    expect(digestClaimKey(NOW)).toBe('reconcile-digest:2026-09-14')
  })

  it('is stable across string, epoch ms, and Date representations of the same instant', () => {
    const a = digestClaimKey(NOW)
    const b = digestClaimKey(NOW_MS)
    const c = digestClaimKey(new Date(NOW_MS))
    expect(a).toBe(b)
    expect(b).toBe(c)
  })

  it('changes at the UTC day boundary', () => {
    expect(digestClaimKey('2026-09-14T23:59:59Z')).toBe('reconcile-digest:2026-09-14')
    expect(digestClaimKey('2026-09-15T00:00:00Z')).toBe('reconcile-digest:2026-09-15')
  })
})

/* ---------------------------------------------------------- sweep wrapper */

describe('runRecoverySweep', () => {
  it('marks a stale EXECUTING row and reports the summary', async () => {
    const db = fakeTaskDb()
    const stale = await makeStaleExecuting(db)
    const fresh = await makeTask(db, 'user-1', 'fresh draft')

    const summary = await runRecoverySweep(db.sql, { now: NOW })
    expect(summary).toMatchObject({ scanned: 2, marked: 1, backlogSize: 1 })
    expect(summary.markedTasks[0]?.taskId).toBe(stale.id)
    const marked = await loadProjection(db.sql, { userId: 'user-1', taskId: stale.id })
    expect(marked?.state).toBe('NEEDS_RECONCILIATION')
    const healthy = await loadProjection(db.sql, { userId: 'user-1', taskId: fresh.id })
    expect(healthy?.state).toBe('DRAFT')
  })

  it('is safe to call every tick: a second call adds nothing', async () => {
    const db = fakeTaskDb()
    await makeStaleExecuting(db)

    const first = await runRecoverySweep(db.sql, { now: NOW })
    const second = await runRecoverySweep(db.sql, { now: NOW })
    expect(first.marked).toBe(1)
    expect(second.marked).toBe(0)
    expect(second.backlogSize).toBe(1) // still waiting on a human, not double-counted
    const reconcileEvents = db.events.filter(
      (e) => typeof e.idempotency_key === 'string' && (e.idempotency_key as string).startsWith('reconcile:'),
    )
    expect(reconcileEvents).toHaveLength(1)
  })
})

/* -------------------------------------------------------- pass once */

describe('runRecoveryPassOnce', () => {
  it('sweeps, groups by user, and notifies only users with tasks needing eyes', async () => {
    const db = fakeTaskDb()
    const mine = await makeStaleExecuting(db, 'user-1', 'order flowers')
    await makeTask(db, 'user-2', 'healthy draft') // nothing needing eyes for user-2
    const calls: Array<{ userId: string; persona: string; text: string }> = []

    const summary = await runRecoveryPassOnce(db.sql, {
      now: NOW,
      notify: (userId, persona, text) => {
        calls.push({ userId, persona, text })
      },
    })

    expect(summary).toEqual({ scanned: 2, marked: 1, digestsSent: ['user-1'] })
    expect(calls).toHaveLength(1)
    expect(calls[0]!.userId).toBe('user-1')
    expect(calls[0]!.persona).toBe('friend')
    expect(calls[0]!.text).toContain('1 of your tasks need a look')
    expect(calls[0]!.text).toContain(mine.id)
    expect(calls[0]!.text).toContain('order flowers')
  })

  it('digest cadence: same tick again is silent, +24h fires once more', async () => {
    const db = fakeTaskDb()
    await makeStaleExecuting(db)
    const state: RecoveryLoopState = createRecoveryLoopState()
    let sends = 0
    const notify = () => {
      sends += 1
    }

    await runRecoveryPassOnce(db.sql, { now: NOW, notify, state })
    await runRecoveryPassOnce(db.sql, { now: NOW, notify, state }) // no double text on one day
    expect(sends).toBe(1)

    await runRecoveryPassOnce(db.sql, { now: '2026-09-14T13:00:00Z', notify, state }) // later same day
    expect(sends).toBe(1)

    await runRecoveryPassOnce(db.sql, { now: '2026-09-15T12:00:00Z', notify, state }) // exactly +24h
    expect(sends).toBe(2)
  })

  it('backlog threshold crossing sends immediately, even mid-day', async () => {
    const db = fakeTaskDb()
    await makeStaleExecuting(db, 'user-1', 'first stalled')
    const state = createRecoveryLoopState()
    let sends = 0
    const notify = () => {
      sends += 1
    }

    await runRecoveryPassOnce(db.sql, { now: NOW, notify, state, backlogThreshold: 2 })
    expect(sends).toBe(1) // first digest: due (never sent), backlog 1 < threshold

    await makeStaleExecuting(db, 'user-1', 'second stalled')
    await runRecoveryPassOnce(db.sql, { now: NOW, notify, state, backlogThreshold: 2 })
    expect(sends).toBe(2) // 2 needs-eyes >= threshold 2: rising edge, not yet 24h due

    // Still above threshold; no new cross, still same day -> quiet.
    await runRecoveryPassOnce(db.sql, { now: NOW, notify, state, backlogThreshold: 2 })
    expect(sends).toBe(2)
  })

  it('a throwing notify warns and the pass (and loop) stay alive for other users', async () => {
    const db = fakeTaskDb()
    await makeStaleExecuting(db, 'user-1')
    await makeStaleExecuting(db, 'user-2')
    const warnings: string[] = []

    await runRecoveryPassOnce(db.sql, {
      now: NOW,
      notify: (userId) => {
        if (userId === 'user-1') throw new Error('carrier rejected the send')
      },
      warn: (message) => warnings.push(message),
    })

    expect(warnings.some((w) => w.includes('user-1'))).toBe(true)
    // user-1 never recorded as sent, so it is due again next pass; user-2 was reached.
    const state = createRecoveryLoopState()
    let sends = 0
    await runRecoveryPassOnce(db.sql, {
      now: NOW,
      notify: (userId) => {
        if (userId === 'user-1') throw new Error('still down')
        sends += 1
      },
      state,
      warn: () => undefined,
    })
    expect(sends).toBe(1)
  })
})

/* ---------------------------------------------------------------- mount */

describe('mountRecoveryLoop', () => {
  it('ticks on an interval, survives a throwing notify, and stop() halts it', async () => {
    const db = fakeTaskDb()
    await makeStaleExecuting(db)
    let sends = 0
    let stopCalls = 0

    const stop = mountRecoveryLoop(db.sql, {
      getIntervalMs: 5,
      now: () => new Date(Date.parse(NOW) + stopCalls * HOUR_MS),
      notify: () => {
        sends += 1
        throw new Error('send failed; loop must live')
      },
      warn: () => undefined,
    })

    await new Promise((resolve) => setTimeout(resolve, 30))
    stop()
    stopCalls += 1
    const afterStop = sends
    await new Promise((resolve) => setTimeout(resolve, 20))

    expect(sends).toBeGreaterThan(0) // ran despite every notify throwing
    expect(sends).toBe(afterStop) // stopped cleanly
  })
})
