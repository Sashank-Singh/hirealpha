/**
 * Delivery seam tests. The stateful fake below is a local copy of the
 * taskStore.test.ts pattern (test files must not import each other); it
 * implements exactly the query shapes taskStore emits.
 */
import { describe, expect, it } from 'bun:test'
import {
  DeliveryError,
  deliverText,
  flushPending,
  syncTaskSurface,
  type SurfaceProvider,
} from './delivery'
import {
  buildCalendarDraft,
  type CalendarDraft,
  type CalendarProvider,
} from './calendarSync'
import { claimDelivery, recordOutcome } from './syncGuard'
import { createTask, loadProjection } from './taskStore'
import type { TaskProjection } from './taskContract'

type Row = Record<string, unknown>

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
    request: 'confirm the reservation and text me the details',
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

const PROSE = 'Table for 4 at 7pm  —  confirmed! Ref ACT-42.\nSee you there.'

describe('deliverText — fence around a real send', () => {
  it('first delivery sends once; a replayed call is deduped WITHOUT invoking send', async () => {
    const { db, task } = await newTask()
    const sent: string[] = []
    const args = {
      userId: 'user-1', taskId: task.id, channel: 'imessage' as const,
      ref: 'message:msg-123', body: PROSE,
      send: async (body: string) => { sent.push(body) },
    }

    const first = await deliverText(db.sql, args)
    expect(first).toEqual({ sent: true, channel: 'imessage', ref: 'message:msg-123' })
    // Prose goes to the transport verbatim — never trimmed, never rewritten.
    expect(sent).toEqual([PROSE])

    const rowsBefore = db.events.length
    const second = await deliverText(db.sql, args) // replayed webhook, same ref
    expect(second).toEqual({ sent: false, reason: 'dedupe', channel: 'imessage', ref: 'message:msg-123' })
    expect(sent).toHaveLength(1) // send was NOT called again
    expect(db.events).toHaveLength(rowsBefore) // zero new rows on the replay
    expect(db.events.filter((e) => e.type === 'sync_updated')).toHaveLength(2) // 1 claim + 1 delivered

    const projection = await projectionOf(db, task.id)
    expect(projection.sync_state.imessage).toEqual({ status: 'delivered', ref: 'message:msg-123' })
  })

  it('a send() throw reconciles the surface and never fakes success', async () => {
    const { db, task } = await newTask()
    let attempts = 0
    const args = {
      userId: 'user-1', taskId: task.id, channel: 'email' as const,
      ref: 'email:e-500', body: PROSE,
      send: async () => { attempts += 1; throw new Error('smtp down') },
    }

    const result = await deliverText(db.sql, args)
    expect(result).toEqual({ sent: false, reason: 'reconcile', channel: 'email', ref: 'email:e-500' })
    expect(attempts).toBe(1)

    const projection = await projectionOf(db, task.id)
    expect(projection.sync_state.email).toEqual({ status: 'needs_reconciliation', ref: 'email:e-500' })
    // The task state machine was never touched — only the sync surface moved.
    expect(projection.state).toBe('DRAFT')

    // A replay of the failed delivery dedupes at the fence: no second SMTP call.
    const replay = await deliverText(db.sql, args)
    expect(replay).toEqual({ sent: false, reason: 'dedupe', channel: 'email', ref: 'email:e-500' })
    expect(attempts).toBe(1)
  })

  it('junk channels, blank refs, and missing callbacks throw and write nothing', async () => {
    const { db, task } = await newTask()
    const rowsBefore = db.events.length
    await expect(deliverText(db.sql, {
      userId: 'user-1', taskId: task.id, channel: 'telegram' as never,
      ref: 'x:1', body: PROSE, send: async () => {},
    })).rejects.toBeInstanceOf(DeliveryError)
    await expect(deliverText(db.sql, {
      userId: 'user-1', taskId: task.id, channel: 'imessage',
      ref: '  ', body: PROSE, send: async () => {},
    })).rejects.toBeInstanceOf(DeliveryError)
    await expect(deliverText(db.sql, {
      userId: 'user-1', taskId: task.id, channel: 'imessage',
      ref: 'message:m1', body: '   ', send: async () => {},
    })).rejects.toBeInstanceOf(DeliveryError)
    expect(db.events).toHaveLength(rowsBefore)
    const projection = await projectionOf(db, task.id)
    expect(projection.sync_state).toEqual({})
  })
})

describe('syncTaskSurface — one generic fence over the provider shape', () => {
  it('a real CalendarProvider drives the fence: claim once, replay dedupes, existed suppresses', async () => {
    const { db, task } = await newTask()
    const draft = buildCalendarDraft({
      kind: 'reservation', title: 'Dinner — ACT-42', providerConfirmation: 'ACT-42',
      start_at: '2026-09-20T19:00:00Z', taskId: task.id,
    })
    const calls: Array<{ event: CalendarDraft; key: string }> = []
    // Typed as calendarSync's own provider contract: structural compatibility
    // is part of the assertion (no edits to calendarSync).
    const provider: CalendarProvider = {
      write: async (event, idempotencyKey) => {
        calls.push({ event, key: idempotencyKey })
        return 'written'
      },
    }
    const args = {
      userId: 'user-1', taskId: task.id, surface: 'calendar' as const,
      ref: `cal:${draft.dedup_key}`, payload: draft, provider,
    }

    const first = await syncTaskSurface(db.sql, args)
    expect(first).toEqual({ action: 'delivered' })
    expect(calls).toHaveLength(1)
    expect(calls[0]?.event).toBe(draft) // payload delivered untouched
    expect(calls[0]?.key).toBe(`sync:calendar:cal:${draft.dedup_key}:claim`)

    const rowsBefore = db.events.length
    const replay = await syncTaskSurface(db.sql, args)
    expect(replay).toEqual({ action: 'deduped' })
    expect(calls).toHaveLength(1) // provider never re-invoked on replay
    expect(db.events).toHaveLength(rowsBefore)

    // A provider that self-dedupes lands 'suppressed', not 'delivered'.
    const existedProvider: SurfaceProvider<CalendarDraft> = {
      write: async () => 'existed',
    }
    const already = await syncTaskSurface(db.sql, {
      userId: 'user-1', taskId: task.id, surface: 'calendar',
      ref: 'cal:other:key', payload: draft, provider: existedProvider,
    })
    expect(already).toEqual({ action: 'already-there' })
    const projection = await projectionOf(db, task.id)
    expect(projection.sync_state.calendar).toEqual({ status: 'suppressed', ref: 'cal:other:key' })
  })
})

describe('flushPending — one fenced resend per stuck surface', () => {
  it('resends a pending surface exactly once, skips delivered, and a second flush stays quiet', async () => {
    const { db, task } = await newTask()
    // imessage: claimed then transport died before the outcome -> stuck 'pending'.
    await claimDelivery(db.sql, { userId: 'user-1', taskId: task.id, surface: 'imessage', ref: 'message:m1' })
    // email: delivered cleanly -> must never be resent.
    await deliverText(db.sql, {
      userId: 'user-1', taskId: task.id, channel: 'email', ref: 'email:ok',
      body: PROSE, send: async () => {},
    })

    const attempts: Array<{ surface: string; ref: string; hasProjection: boolean }> = []
    const resend = async (projection: TaskProjection, surface: string, ref: string) => {
      attempts.push({ surface, ref, hasProjection: Boolean(projection.request) })
    }
    const now = new Date('2026-09-14T05:00:00Z')

    const first = await flushPending(db.sql, { userId: 'user-1', taskId: task.id, now, resend })
    expect(first.flushed).toEqual([{ surface: 'imessage', ref: 'message:m1', outcome: 'resent' }])
    expect(first.remaining).toEqual([])
    expect(attempts).toEqual([{ surface: 'imessage', ref: 'message:m1', hasProjection: true }])
    const projection = await projectionOf(db, task.id)
    expect(projection.sync_state.imessage).toEqual({ status: 'delivered', ref: 'message:m1' })

    const second = await flushPending(db.sql, { userId: 'user-1', taskId: task.id, now, resend })
    expect(second.flushed).toEqual([])
    expect(attempts).toHaveLength(1) // delivered surfaces are never touched again
  })

  it('a flush whose resend throws reconciles; re-failing the same ref cannot double-send', async () => {
    const { db, task } = await newTask()
    await claimDelivery(db.sql, { userId: 'user-1', taskId: task.id, surface: 'imessage', ref: 'message:m2' })
    const now = new Date('2026-09-14T05:00:00Z')

    let calls = 0
    const failingResend = async () => { calls += 1; throw new Error('carrier unreachable') }
    const first = await flushPending(db.sql, { userId: 'user-1', taskId: task.id, now, resend: failingResend })
    expect(first.flushed).toEqual([{ surface: 'imessage', ref: 'message:m2', outcome: 'reconcile' }])
    expect(calls).toBe(1)
    let projection = await projectionOf(db, task.id)
    expect(projection.sync_state.imessage?.status).toBe('needs_reconciliation')

    // Later evidence says the transport actually failed: surface re-enters lag.
    await recordOutcome(db.sql, {
      userId: 'user-1', taskId: task.id, surface: 'imessage', ref: 'message:m2', status: 'failed',
    })
    projection = await projectionOf(db, task.id)
    expect(projection.sync_state.imessage?.status).toBe('failed')

    // A working resend on a second flush is refused by the flush-scoped fence:
    // across all flushes the transport is invoked AT MOST ONCE for this ref.
    const happyResend = async () => { calls += 1 }
    const second = await flushPending(db.sql, { userId: 'user-1', taskId: task.id, now, resend: happyResend })
    expect(second.flushed).toEqual([{ surface: 'imessage', ref: 'message:m2', outcome: 'deduped' }])
    expect(calls).toBe(1)
    // The refused attempt wrote nothing, so the surface stays visible in lag.
    expect(second.remaining).toHaveLength(1)
    expect(second.remaining[0]).toMatchObject({ surface: 'imessage', status: 'failed', ref: 'message:m2' })
  })

  it('unknown task and missing callbacks throw', async () => {
    const { db } = await newTask()
    const now = new Date()
    await expect(flushPending(db.sql, {
      userId: 'user-1', taskId: 'nope', now, resend: async () => {},
    })).rejects.toBeInstanceOf(DeliveryError)
    await expect(flushPending(db.sql, {
      userId: 'user-1', taskId: 'whatever', now, resend: undefined as never,
    })).rejects.toBeInstanceOf(DeliveryError)
  })
})
