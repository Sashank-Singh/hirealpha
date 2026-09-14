import { describe, expect, it } from 'bun:test'
import {
  TaskNotFoundError,
  TaskVersionConflictError,
  appendEvent,
  createTask,
  getTask,
  listEvents,
  listTasksForAdmin,
  loadProjection,
  rebuildProjection,
} from './taskStore'
import type { TaskProjection } from './taskContract'

type Row = Record<string, unknown>

/**
 * Stateful fake: implements just the shapes taskStore emits. Rows store JSONB as
 * strings, like the real driver after JSON.stringify(x)::jsonb.
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

async function newTask(overrides: { userId?: string } = {}) {
  const db = fakeTaskDb()
  const task = await createTask(db.sql, {
    userId: overrides.userId ?? 'user-1',
    request: 'book a table at the italian place friday',
    persona: 'friend',
    conversationId: '+15550001111',
  })
  return { db, task }
}

describe('canonical task store', () => {
  it('creates a task as event 1 with a DRAFT projection', async () => {
    const { db, task } = await newTask()
    expect(task.state).toBe('DRAFT')
    expect(task.version).toBe(1)
    expect(task.event_seq).toBe(1)
    expect(db.events).toHaveLength(1)
    expect(db.events[0]?.type).toBe('task_created')
  })

  it('appends events, bumps version, and merges payloads', async () => {
    const { db, task } = await newTask()
    const result = await appendEvent(db.sql, {
      userId: 'user-1', taskId: task.id, type: 'constraints_resolved',
      payload: { constraints: { date: 'friday', budget: 'medium' } }, actor: 'alpha',
    })
    expect(result.replayed).toBe(false)
    expect(result.task.version).toBe(2)
    const projection = await loadProjection(db.sql, { userId: 'user-1', taskId: task.id })
    expect(projection?.constraints).toEqual({ date: 'friday', budget: 'medium' })
  })

  it('returns the stored event on idempotent replay without double-inserting', async () => {
    const { db, task } = await newTask()
    const first = await appendEvent(db.sql, {
      userId: 'user-1', taskId: task.id, type: 'artifact_recorded',
      payload: { kind: 'receipt', ref: 'stripe:pi_1', url: null }, actor: 'alpha',
      idempotencyKey: 'receipt-pi_1',
    })
    const second = await appendEvent(db.sql, {
      userId: 'user-1', taskId: task.id, type: 'artifact_recorded',
      payload: { kind: 'receipt', ref: 'stripe:pi_1', url: null }, actor: 'alpha',
      idempotencyKey: 'receipt-pi_1',
    })
    expect(second.replayed).toBe(true)
    expect(second.event.event_id).toBe(first.event.event_id)
    expect(second.task.version).toBe(first.task.version)
    expect(db.events.filter((e) => e.type === 'artifact_recorded')).toHaveLength(1)
  })

  it('fails on a stale expectedVersion without writing', async () => {
    const { db, task } = await newTask()
    await appendEvent(db.sql, { userId: 'user-1', taskId: task.id, type: 'constraints_resolved', payload: { constraints: { a: 1 } }, actor: 'alpha' })
    await expect(
      appendEvent(db.sql, { userId: 'user-1', taskId: task.id, type: 'constraints_resolved', payload: { constraints: { b: 2 } }, actor: 'alpha', expectedVersion: 1 }),
    ).rejects.toBeInstanceOf(TaskVersionConflictError)
    expect(db.events).toHaveLength(2)
  })

  it('scopes every read and write to the authenticated user', async () => {
    const { db, task } = await newTask()
    await expect(
      appendEvent(db.sql, { userId: 'user-2', taskId: task.id, type: 'constraints_resolved', payload: { constraints: {} }, actor: 'alpha' }),
    ).rejects.toBeInstanceOf(TaskNotFoundError)
    expect(await getTask(db.sql, { userId: 'user-2', taskId: task.id })).toBe(null)
  })

  it('refuses secret-bearing payloads before the database is touched', async () => {
    const { db, task } = await newTask()
    const before = db.events.length
    await expect(
      appendEvent(db.sql, { userId: 'user-1', taskId: task.id, type: 'artifact_recorded', payload: { kind: 'login', ref: { password: 'hunter2' } }, actor: 'alpha' }),
    ).rejects.toThrow('references only')
    expect(db.events).toHaveLength(before)
  })

  it('enforces the transition guards at the store boundary', async () => {
    const { db, task } = await newTask()
    await appendEvent(db.sql, { userId: 'user-1', taskId: task.id, type: 'state_changed', payload: { to: 'RESEARCHING' }, actor: 'alpha' })
    await appendEvent(db.sql, { userId: 'user-1', taskId: task.id, type: 'state_changed', payload: { to: 'WAITING_FOR_SELECTION' }, actor: 'alpha' })
    await appendEvent(db.sql, { userId: 'user-1', taskId: task.id, type: 'options_published', payload: { options: [{ id: 'opt-1', title: 'Handlebar' }] }, actor: 'alpha' })
    await appendEvent(db.sql, { userId: 'user-1', taskId: task.id, type: 'option_selected', payload: { option_id: 'opt-1' }, actor: 'alpha' })
    // WAITING_FOR_SELECTION -> EXECUTING is forbidden outright.
    await expect(
      appendEvent(db.sql, { userId: 'user-1', taskId: task.id, type: 'state_changed', payload: { to: 'EXECUTING', authority: 'not_required' }, actor: 'alpha' }),
    ).rejects.toThrow('Forbidden transition')
    // And entering EXECUTING without an authority decision fails too.
    await appendEvent(db.sql, { userId: 'user-1', taskId: task.id, type: 'state_changed', payload: { to: 'PLANNING_ACTION' }, actor: 'alpha' })
    await expect(
      appendEvent(db.sql, { userId: 'user-1', taskId: task.id, type: 'state_changed', payload: { to: 'EXECUTING' }, actor: 'alpha' }),
    ).rejects.toThrow('authority decision')
    // Not_required authority passes once the option is selected.
    const ok = await appendEvent(db.sql, { userId: 'user-1', taskId: task.id, type: 'state_changed', payload: { to: 'EXECUTING', authority: 'not_required' }, actor: 'alpha' })
    expect(ok.task.state).toBe('EXECUTING')
  })

  it('rebuilds the projection identically from the event stream (chaos recovery)', async () => {
    const { db, task } = await newTask()
    const userId = 'user-1'
    await appendEvent(db.sql, { userId, taskId: task.id, type: 'constraints_resolved', payload: { constraints: { date: 'fri' } }, actor: 'alpha' })
    await appendEvent(db.sql, { userId, taskId: task.id, type: 'state_changed', payload: { to: 'RESEARCHING' }, actor: 'alpha' })
    await appendEvent(db.sql, { userId, taskId: task.id, type: 'state_changed', payload: { to: 'WAITING_FOR_SELECTION' }, actor: 'alpha' })
    await appendEvent(db.sql, { userId, taskId: task.id, type: 'options_published', payload: { options: [{ id: 'o', title: 'T', price_cents: 4200, currency: 'usd' }] }, actor: 'alpha' })
    await appendEvent(db.sql, { userId, taskId: task.id, type: 'monitor_updated', payload: { state: 'SCHEDULED', policy: { watch: 'availability' }, next_check_at: '2026-09-15T09:00:00Z' }, actor: 'alpha' })
    const stored = await loadProjection(db.sql, { userId, taskId: task.id })
    const rebuilt = await rebuildProjection(db.sql, { userId, taskId: task.id })
    expect(rebuilt).not.toBe(null)
    // The stored row is a snapshot of the same reducer over the same stream.
    expect((rebuilt as unknown as TaskProjection).options).toEqual((stored as unknown as TaskProjection).options)
    expect(rebuilt?.monitor_state).toBe('SCHEDULED')
    expect(rebuilt?.state).toBe('WAITING_FOR_SELECTION')
    expect(rebuilt?.constraints).toEqual({ date: 'fri' })
  })

  it('lists tasks for the internal debug surface, scoped by user when given', async () => {
    const a = fakeTaskDb()
    const mine = await createTask(a.sql, { userId: 'user-1', request: 'one', persona: 'friend' })
    await createTask(a.sql, { userId: 'user-2', request: 'two', persona: 'friend' })
    await createTask(a.sql, { userId: 'user-1', request: 'three', persona: 'friend' })
    const scoped = await listTasksForAdmin(a.sql, { userId: 'user-1' })
    expect(scoped.map((task) => task.request).sort()).toEqual(['one', 'three'])
    expect(mine.state).toBe('DRAFT')
    const all = await listTasksForAdmin(a.sql)
    expect(all).toHaveLength(3)
  })

  it('streams events after a checkpoint in order', async () => {
    const { db, task } = await newTask()
    await appendEvent(db.sql, { userId: 'user-1', taskId: task.id, type: 'checkpoint_recorded', payload: { step: { at: 'checkout' } }, actor: 'alpha' })
    const after = await listEvents(db.sql, { userId: 'user-1', taskId: task.id, afterSeq: 1 })
    expect(after.map((e) => e.task_seq)).toEqual([2])
    expect(after[0]?.payload).toEqual({ step: { at: 'checkout' } })
  })
})
