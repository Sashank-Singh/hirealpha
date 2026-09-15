import { describe, expect, it } from 'bun:test'
import {
  SyncGuardError,
  claimDelivery,
  pendingSyncLag,
  recordOutcome,
  wasAlreadyDelivered,
} from './syncGuard'
import { TaskNotFoundError, createTask, getTask, loadProjection } from './taskStore'
import { seedProjection, type TaskProjection } from './taskContract'

type Row = Record<string, unknown>

/**
 * Stateful fake (pattern copied from taskStore.test.ts, kept local — test
 * files must not import each other): implements just the query shapes
 * taskStore emits, with JSONB stored like the real driver's stringify.
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

async function newTask() {
  const db = fakeTaskDb()
  const task = await createTask(db.sql, {
    userId: 'user-1',
    request: 'confirm the reservation and put it on my calendar',
    persona: 'friend',
    conversationId: '+15550001111',
  })
  return { db, task }
}

async function projectionOf(db: ReturnType<typeof fakeTaskDb>, taskId: string): Promise<TaskProjection> {
  const projection = await loadProjection(db.sql, { userId: 'user-1', taskId })
  if (!projection) throw new Error('projection missing')
  return projection
}

describe('sync guard (idempotent iMessage / calendar synchronization)', () => {
  it('first claim is yours, fences with a sync_updated row keyed by the idempotency key', async () => {
    const { db, task } = await newTask()
    const claim = await claimDelivery(db.sql, {
      userId: 'user-1', taskId: task.id, surface: 'imessage', ref: 'message:msg-123',
    })
    expect(claim.claim).toBe('yours')
    expect(claim.event.type).toBe('sync_updated')
    expect(claim.event.idempotency_key).toBe('sync:imessage:message:msg-123:claim')
    const projection = await projectionOf(db, task.id)
    expect(projection.sync_state.imessage).toEqual({ status: 'pending', ref: 'message:msg-123' })
    // Timestamp marker for lag reporting rides along with the fresh claim.
    expect(projection.artifacts).toContainEqual({
      kind: 'sync:imessage', ref: 'message:msg-123', url: null, at: '2026-09-14T00:00:01Z',
    })
  })

  it('an identical retry returns duplicate with ZERO new rows (webhook replay case)', async () => {
    const { db, task } = await newTask()
    const args = { userId: 'user-1', taskId: task.id, surface: 'calendar' as const, ref: 'event:uid-9' }
    const first = await claimDelivery(db.sql, args)
    const rowsAfterFirst = db.events.length
    const second = await claimDelivery(db.sql, args)
    expect(first.claim).toBe('yours')
    expect(second.claim).toBe('duplicate')
    expect(second.event.event_id).toBe(first.event.event_id)
    // The duplicate surfaces the live task row (the fresh claim's response was
    // snapshotted before the timestamp-marker append, hence one version lower).
    expect(second.task.version).toBe((await getTask(db.sql, { userId: 'user-1', taskId: task.id }))?.version)
    expect(db.events).toHaveLength(rowsAfterFirst)
    expect(db.events.filter((e) => e.type === 'sync_updated')).toHaveLength(1)
  })

  it('a different ref on the same surface is a fresh claim', async () => {
    const { db, task } = await newTask()
    const a = await claimDelivery(db.sql, { userId: 'user-1', taskId: task.id, surface: 'imessage', ref: 'message:m1' })
    const b = await claimDelivery(db.sql, { userId: 'user-1', taskId: task.id, surface: 'imessage', ref: 'message:m2' })
    expect(a.claim).toBe('yours')
    expect(b.claim).toBe('yours')
    expect(b.event.event_id).not.toBe(a.event.event_id)
    expect(db.events.filter((e) => e.type === 'sync_updated')).toHaveLength(2)
  })

  it('recordOutcome moves sync_state and is itself replay-safe', async () => {
    const { db, task } = await newTask()
    const claim = await claimDelivery(db.sql, { userId: 'user-1', taskId: task.id, surface: 'calendar', ref: 'event:uid-9' })
    const outcome = await recordOutcome(db.sql, {
      userId: 'user-1', taskId: task.id, surface: 'calendar', ref: 'event:uid-9',
      status: 'delivered', priorClaimEventId: claim.event.event_id,
    })
    expect(outcome.replayed).toBe(false)
    expect(outcome.event.causation_id).toBe(claim.event.event_id)
    const projection = await projectionOf(db, task.id)
    expect(projection.sync_state.calendar).toEqual({ status: 'delivered', ref: 'event:uid-9' })
    // Replaying the same outcome writes nothing new.
    const rowsBefore = db.events.length
    const retry = await recordOutcome(db.sql, {
      userId: 'user-1', taskId: task.id, surface: 'calendar', ref: 'event:uid-9', status: 'delivered',
    })
    expect(retry.replayed).toBe(true)
    expect(retry.event.event_id).toBe(outcome.event.event_id)
    expect(db.events).toHaveLength(rowsBefore)
  })

  it('wasAlreadyDelivered is true only after a delivered outcome for this exact ref', async () => {
    const { db, task } = await newTask()
    const args = { userId: 'user-1', taskId: task.id, surface: 'imessage' as const, ref: 'message:m1' }
    expect(wasAlreadyDelivered(await projectionOf(db, task.id), 'imessage', 'message:m1')).toBe(false)
    await claimDelivery(db.sql, args)
    expect(wasAlreadyDelivered(await projectionOf(db, task.id), 'imessage', 'message:m1')).toBe(false)
    await recordOutcome(db.sql, { ...args, status: 'delivered' })
    const delivered = await projectionOf(db, task.id)
    expect(wasAlreadyDelivered(delivered, 'imessage', 'message:m1')).toBe(true)
    expect(wasAlreadyDelivered(delivered, 'imessage', 'message:OTHER')).toBe(false)
    expect(wasAlreadyDelivered(delivered, 'calendar', 'message:m1')).toBe(false)
    // A failed outcome does not suppress a legitimate resend.
    await recordOutcome(db.sql, { userId: 'user-1', taskId: task.id, surface: 'email', ref: 'msg:e1', status: 'failed' })
    const afterFailure = await projectionOf(db, task.id)
    expect(wasAlreadyDelivered(afterFailure, 'email', 'msg:e1')).toBe(false)
  })

  it('pendingSyncLag reports pending/failed ages, skips delivered/suppressed, tolerates junk', () => {
    const projection = seedProjection('r', 'friend', null)
    projection.sync_state = {
      imessage: { status: 'pending', ref: 'message:m1' },
      calendar: { status: 'failed', ref: 'event:e9' },
      email: { status: 'delivered', ref: 'msg:sent' },
      miniapp: { status: 'suppressed', ref: 'card:c1' },
      carrier_pigeon: { status: 'pending', ref: 'p:1' }, // stale data must never crash the dashboard
    }
    projection.artifacts = [
      { kind: 'sync:imessage', ref: 'message:m1', at: '2026-09-14T10:00:00Z' },
      { kind: 'sync:imessage', ref: 'message:old', at: '2026-09-14T01:00:00Z' }, // superseded ref is ignored
      { kind: 'sync:calendar', ref: 'event:e9', at: '2026-09-14T11:59:00Z' },
      // email intentionally has no marker: delivered surfaces are never reported
    ]
    const now = new Date('2026-09-14T12:00:00Z')
    const lags = pendingSyncLag(projection, now, 3_600_000)
    expect(lags.map((l) => l.surface).sort()).toEqual(['calendar', 'imessage'])
    const imessage = lags.find((l) => l.surface === 'imessage')
    expect(imessage?.status).toBe('pending')
    expect(imessage?.ageMs).toBe(2 * 3_600_000)
    expect(imessage?.warn).toBe(true)
    const calendar = lags.find((l) => l.surface === 'calendar')
    expect(calendar?.status).toBe('failed')
    expect(calendar?.ageMs).toBe(60_000)
    expect(calendar?.warn).toBe(false)
    // A pending surface without a marker is reported with unknown age, never warned away.
    projection.artifacts = []
    const markerless = pendingSyncLag(projection, now, 1)
    expect(markerless.find((l) => l.surface === 'imessage')).toEqual({
      surface: 'imessage', status: 'pending', ref: 'message:m1', ageMs: null, warn: false,
    })
  })

  it('pendingSyncLag computes age from the marker a real claim writes', async () => {
    const { db, task } = await newTask()
    await claimDelivery(db.sql, { userId: 'user-1', taskId: task.id, surface: 'imessage', ref: 'message:m1' })
    const lags = pendingSyncLag(await projectionOf(db, task.id), new Date('2026-09-14T02:00:01Z'), 3_600_000)
    expect(lags).toHaveLength(1)
    expect(lags[0]).toEqual({ surface: 'imessage', status: 'pending', ref: 'message:m1', ageMs: 7_200_000, warn: true })
  })

  it('junk surfaces, statuses, and refs throw and touch nothing (fail closed)', async () => {
    const { db, task } = await newTask()
    const rowsBefore = db.events.length
    await expect(
      claimDelivery(db.sql, { userId: 'user-1', taskId: task.id, surface: 'telegram', ref: 'x:1' } as never),
    ).rejects.toBeInstanceOf(SyncGuardError)
    await expect(
      recordOutcome(db.sql, { userId: 'user-1', taskId: task.id, surface: 'calendar', ref: 'e:1', status: 'sent' } as never),
    ).rejects.toBeInstanceOf(SyncGuardError)
    await expect(
      claimDelivery(db.sql, { userId: 'user-1', taskId: task.id, surface: 'calendar', ref: { password: 'hunter2' } } as never),
    ).rejects.toBeInstanceOf(SyncGuardError)
    await expect(
      claimDelivery(db.sql, { userId: 'user-1', taskId: task.id, surface: 'calendar', ref: '   ' }),
    ).rejects.toBeInstanceOf(SyncGuardError)
    expect(() => wasAlreadyDelivered(seedProjection('r', 'friend', null), 'carrier_pigeon' as never, 'x')).toThrow(SyncGuardError)
    expect(() => pendingSyncLag(seedProjection('r', 'friend', null), new Date(), -5)).toThrow(SyncGuardError)
    expect(db.events).toHaveLength(rowsBefore)
    const projection = await projectionOf(db, task.id)
    expect(projection.sync_state).toEqual({})
  })

  it('every write is scoped by userId: another user cannot claim on my task', async () => {
    const { db, task } = await newTask()
    const rowsBefore = db.events.length
    await expect(
      claimDelivery(db.sql, { userId: 'user-2', taskId: task.id, surface: 'imessage', ref: 'message:m1' }),
    ).rejects.toBeInstanceOf(TaskNotFoundError)
    expect(db.events).toHaveLength(rowsBefore)
  })
})
