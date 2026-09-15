import { describe, expect, it } from 'bun:test'
import {
  CalendarSyncError,
  applyChangePropagation,
  buildCalendarDraft,
  diffCalendarEvents,
  syncVerifiedReservation,
  type CalendarDraft,
  type CalendarProvider,
} from './calendarSync'
import { appendEvent, createTask, getTask, loadProjection } from './taskStore'

type Row = Record<string, unknown>

/**
 * Stateful fake (same pattern as taskStore.test.ts): implements just the query
 * shapes taskStore emits, so the whole delivery ledger runs in-memory.
 */
function fakeCalendarDb() {
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
    throw new Error(`fakeCalendarDb: unmatched query: ${text.slice(0, 120)}`)
  }) as { begin: (cb: (tx: never) => Promise<unknown>) => Promise<unknown> }
  sql.begin = (cb) => cb(sql as never)

  return { sql: sql as never, tasks, events }
}

function spyProvider(result: 'written' | 'existed' | 'throw') {
  const calls: { event: CalendarDraft; key: string }[] = []
  const provider: CalendarProvider = {
    async write(event, key) {
      calls.push({ event, key })
      if (result === 'throw') throw new Error('google api unreachable')
      return result
    },
  }
  return { provider, calls }
}

function reservationDraft(overrides: Partial<Parameters<typeof buildCalendarDraft>[0]> = {}): CalendarDraft {
  return buildCalendarDraft({
    kind: 'reservation',
    title: 'Dinner at Ostriket',
    providerConfirmation: 'CONF-111',
    start_at: '2026-09-18T18:00:00Z',
    end_at: '2026-09-18T19:30:00Z',
    location: 'Refshalevej 163, Copenhagen',
    cancellationTerms: 'free until 24h before',
    taskId: 'task-1',
    ...overrides,
  })
}

async function freshTask(userId = 'user-1') {
  const db = fakeCalendarDb()
  const task = await createTask(db.sql, { userId, request: 'book dinner friday', persona: 'friend' })
  return { db, taskId: String(task.id), userId }
}

/** Walk a task to SYNCHRONIZING (the verified-booking point calendar sync joins). */
async function driveToSynchronizing(db: ReturnType<typeof fakeCalendarDb>, userId: string, taskId: string) {
  await appendEvent(db.sql, { userId, taskId, type: 'state_changed', payload: { to: 'RESEARCHING' }, actor: 'test' })
  await appendEvent(db.sql, { userId, taskId, type: 'state_changed', payload: { to: 'WAITING_FOR_SELECTION' }, actor: 'test' })
  await appendEvent(db.sql, { userId, taskId, type: 'state_changed', payload: { to: 'PLANNING_ACTION' }, actor: 'test' })
  await appendEvent(db.sql, { userId, taskId, type: 'state_changed', payload: { to: 'EXECUTING', authority: 'not_required' }, actor: 'test' })
  await appendEvent(db.sql, { userId, taskId, type: 'state_changed', payload: { to: 'VERIFYING' }, actor: 'test' })
  await appendEvent(db.sql, { userId, taskId, type: 'verification_recorded', payload: { passed: true, evidence: ['receipt:reservation:sha256:test'] }, actor: 'test' })
  await appendEvent(db.sql, { userId, taskId, type: 'state_changed', payload: { to: 'SYNCHRONIZING' }, actor: 'test' })
}

function eventsOfType(db: ReturnType<typeof fakeCalendarDb>, type: string) {
  return db.events.filter((e) => e.type === type)
}

function syncRows(db: ReturnType<typeof fakeCalendarDb>, status: string) {
  return db.events.filter((e) => e.type === 'sync_updated' && (e.payload as Row).status === status)
}

function calendarArtifacts(db: ReturnType<typeof fakeCalendarDb>) {
  return db.events.filter((e) => e.type === 'artifact_recorded' && (e.payload as Row).kind === 'calendar_event')
}

describe('buildCalendarDraft', () => {
  it('produces a stable dedup key and a traceable description', () => {
    const a = reservationDraft()
    const b = reservationDraft()
    expect(a).toEqual(b)
    expect(a.dedup_key).toBe('reservation:CONF-111:2026-09-18')
    expect(a.description).toContain('CONF-111')
    expect(a.description).toContain('free until 24h before')
    expect(a.description).toContain('task:task-1')
    expect(a.summary).toBe('Dinner at Ostriket')
    expect(a.end_at).toBe('2026-09-18T19:30:00Z')
  })

  it('same-day re-confirmation of the same confirmation dedupes; new times do not change the key', () => {
    const first = reservationDraft({ end_at: '2026-09-18T19:00:00Z' })
    const again = reservationDraft({ end_at: '2026-09-18T21:00:00Z', title: 'Dinner (re-confirmed)' })
    expect(first.dedup_key).toBe(again.dedup_key)
    const other = reservationDraft({ providerConfirmation: 'CONF-222' })
    expect(other.dedup_key).toBe('reservation:CONF-222:2026-09-18')
  })

  it('confirmation-less events key by task + date', () => {
    const deadline = buildCalendarDraft({
      kind: 'deadline', title: 'Visa application due', start_at: '2026-10-01T23:59:00Z', taskId: 'task-9',
    })
    expect(deadline.dedup_key).toBe('deadline:task:task-9:2026-10-01')
    expect(deadline.end_at).toBe(null)
    const otherTask = buildCalendarDraft({ kind: 'deadline', title: 'due', start_at: '2026-10-01T12:00:00Z', taskId: 'task-10' })
    expect(otherTask.dedup_key).not.toBe(deadline.dedup_key)
  })

  it('rejects invalid timestamps and unknown kinds', () => {
    expect(() => reservationDraft({ start_at: 'not a date' })).toThrow(CalendarSyncError)
    expect(() => reservationDraft({ end_at: '2026-09-18T17:00:00Z' })).toThrow('after start_at')
    expect(() => reservationDraft({ end_at: '2026-09-18T18:00:00Z' })).toThrow('after start_at')
    expect(() => reservationDraft({ title: '  ' })).toThrow('non-empty title')
    expect(() =>
      buildCalendarDraft({ kind: 'party' as 'reservation', title: 'x', start_at: '2026-09-18T18:00:00Z', taskId: 't' }),
    ).toThrow('Unknown calendar event kind')
  })

  it('caps prose so no free-text blob exceeds the payload budget', () => {
    const long = reservationDraft({
      title: 'x'.repeat(500),
      location: 'y'.repeat(900),
      cancellationTerms: 'z'.repeat(900),
    })
    expect(long.summary.length).toBeLessThanOrEqual(300)
    expect(long.location.length).toBeLessThanOrEqual(500)
    expect(long.description.length).toBeLessThanOrEqual(2000)
  })
})

describe('diffCalendarEvents', () => {
  it('noop when every field is equal', () => {
    expect(diffCalendarEvents(reservationDraft(), reservationDraft())).toEqual({ action: 'noop', changed: [] })
  })

  it('move when only the times changed', () => {
    // Same-day time shift keeps the dedup key: a pure move.
    const sameDay = reservationDraft({ start_at: '2026-09-18T19:00:00Z', end_at: '2026-09-18T20:30:00Z' })
    const pureMove = diffCalendarEvents(reservationDraft(), sameDay)
    expect(pureMove.action).toBe('move')
    expect(pureMove.changed.sort()).toEqual(['end_at', 'start_at'])
    // A date change also changes the entry identity (dedup_key) -> update.
    const nextDay = reservationDraft({ start_at: '2026-09-19T18:00:00Z', end_at: '2026-09-19T19:30:00Z' })
    expect(diffCalendarEvents(reservationDraft(), nextDay).action).toBe('update')
  })

  it('update when any non-time field changes', () => {
    const next = reservationDraft({ title: 'moved on' })
    const diff = diffCalendarEvents(reservationDraft(), next)
    expect(diff).toEqual({ action: 'update', changed: ['summary'] })
    const dropped = reservationDraft({ end_at: null })
    expect(diffCalendarEvents(reservationDraft(), dropped).changed).toContain('end_at')
  })
})

describe('syncVerifiedReservation', () => {
  it('suppresses a duplicate webhook BEFORE the provider is called', async () => {
    const { db, userId, taskId } = await freshTask()
    const draft = reservationDraft({ taskId })
    const first = spyProvider('written')
    expect((await syncVerifiedReservation(db.sql, { userId, taskId, draft, provider: first.provider })).action).toBe('created')
    const second = spyProvider('written')
    const before = db.events.length
    const result = await syncVerifiedReservation(db.sql, { userId, taskId, draft, provider: second.provider })
    expect(result.action).toBe('suppressed')
    expect(second.calls).toHaveLength(0)
    expect(db.events).toHaveLength(before)
    expect(first.calls).toHaveLength(1)
  })

  it('the created path records artifact + sync delivery, user-scoped', async () => {
    const { db, userId, taskId } = await freshTask()
    const { provider, calls } = spyProvider('written')
    const result = await syncVerifiedReservation(db.sql, { userId, taskId, draft: reservationDraft({ taskId }), provider })
    expect(result.action).toBe('created')
    expect(calls[0]?.key).toBe('sync:calendar:cal:reservation:CONF-111:2026-09-18:claim')
    expect(calendarArtifacts(db)).toHaveLength(1)
    expect((calendarArtifacts(db)[0]?.payload as Row).ref).toBe('cal:reservation:CONF-111:2026-09-18')
    expect(syncRows(db, 'delivered')).toHaveLength(1)
    const projection = await loadProjection(db.sql, { userId, taskId })
    expect(projection?.sync_state.calendar?.status).toBe('delivered')
    expect(projection?.sync_state.calendar?.ref).toBe('cal:reservation:CONF-111:2026-09-18')
  })

  it("provider says 'existed' -> suppressed ledger, already-there result", async () => {
    const { db, userId, taskId } = await freshTask()
    const { provider } = spyProvider('existed')
    const result = await syncVerifiedReservation(db.sql, { userId, taskId, draft: reservationDraft({ taskId }), provider })
    expect(result.action).toBe('already-there')
    expect(syncRows(db, 'suppressed')).toHaveLength(1)
    expect(calendarArtifacts(db)).toHaveLength(0)
    const projection = await loadProjection(db.sql, { userId, taskId })
    expect(projection?.sync_state.calendar?.status).toBe('suppressed')
  })

  it('provider failure reconciles the calendar surface but never unwinds the booking', async () => {
    const { db, userId, taskId } = await freshTask()
    await driveToSynchronizing(db, userId, taskId)
    const eventsBeforeFailure = db.events.length
    const stateChangedBefore = eventsOfType(db, 'state_changed').length
    const { provider } = spyProvider('throw')
    const result = await syncVerifiedReservation(db.sql, { userId, taskId, draft: reservationDraft({ taskId }), provider })
    expect(result.action).toBe('reconcile')
    const projection = await loadProjection(db.sql, { userId, taskId })
    expect(projection?.sync_state.calendar?.status).toBe('needs_reconciliation')
    const failures = eventsOfType(db, 'failure_recorded')
    expect(failures).toHaveLength(1)
    expect((failures[0]?.payload as Row).reason_code).toBe('sync_retryable')
    // Booking is done and stays done: no new state moves, calendar never claims otherwise.
    expect(eventsOfType(db, 'state_changed')).toHaveLength(stateChangedBefore)
    const task = await getTask(db.sql, { userId, taskId })
    expect(task?.state).toBe('SYNCHRONIZING')
    void eventsBeforeFailure
  })

  it('scopes delivery to the owning user', async () => {
    const { db, taskId } = await freshTask('user-1')
    const { provider, calls } = spyProvider('written')
    await expect(
      syncVerifiedReservation(db.sql, { userId: 'user-2', taskId, draft: reservationDraft({ taskId }), provider }),
    ).rejects.toThrow('Task not found')
    expect(calls).toHaveLength(0)
    expect(db.events).toHaveLength(1) // only task_created
  })
})

describe('applyChangePropagation', () => {
  it('noop diff writes zero events and never calls the provider', async () => {
    const { db, userId, taskId } = await freshTask()
    const { provider, calls } = spyProvider('written')
    const draft = reservationDraft({ taskId })
    const before = db.events.length
    const result = await applyChangePropagation(draft, reservationDraft({ taskId }), db.sql, { userId, taskId }, provider)
    expect(result).toEqual({ action: 'noop', changed: [] })
    expect(calls).toHaveLength(0)
    expect(db.events).toHaveLength(before)
  })

  it('a move propagates the new times only', async () => {
    const { db, userId, taskId } = await freshTask()
    const oldDraft = reservationDraft({ taskId })
    const next = reservationDraft({ taskId, start_at: '2026-09-18T19:00:00Z', end_at: '2026-09-18T20:30:00Z' })
    const { provider, calls } = spyProvider('written')
    const result = await applyChangePropagation(oldDraft, next, db.sql, { userId, taskId }, provider)
    expect(result.action).toBe('moved')
    expect(result.changed.sort()).toEqual(['end_at', 'start_at'])
    expect(calls).toHaveLength(1)
    expect(calls[0]?.event.start_at).toBe('2026-09-18T19:00:00Z')
    expect(calls[0]?.key).toContain(':change:sha256:')
    expect(calendarArtifacts(db)).toHaveLength(1)
    expect(syncRows(db, 'delivered')).toHaveLength(1)
    // Untouched fields carry over unchanged:
    expect(calls[0]?.event.summary).toBe(oldDraft.summary)
    expect(calls[0]?.event.location).toBe(oldDraft.location)
  })

  it('an update propagates non-time changes', async () => {
    const { db, userId, taskId } = await freshTask()
    const next = reservationDraft({ taskId, location: 'Kongens Nytorv 1' })
    const { provider, calls } = spyProvider('written')
    const result = await applyChangePropagation(reservationDraft({ taskId }), next, db.sql, { userId, taskId }, provider)
    expect(result.action).toBe('updated')
    expect(result.changed).toEqual(['location'])
    expect(calls[0]?.event.location).toBe('Kongens Nytorv 1')
  })

  it('re-delivering the SAME change is suppressed; a DIFFERENT change passes', async () => {
    const { db, userId, taskId } = await freshTask()
    const oldDraft = reservationDraft({ taskId })
    const next = reservationDraft({ taskId, title: 'Dinner at Ostriket (moved on)' })
    const p1 = spyProvider('written')
    expect((await applyChangePropagation(oldDraft, next, db.sql, { userId, taskId }, p1.provider)).action).toBe('updated')
    const p2 = spyProvider('written')
    const before = db.events.length
    expect((await applyChangePropagation(oldDraft, next, db.sql, { userId, taskId }, p2.provider)).action).toBe('suppressed')
    expect(p2.calls).toHaveLength(0)
    expect(db.events).toHaveLength(before)
    const p3 = spyProvider('written')
    const later = reservationDraft({ taskId, title: 'Dinner at Ostriket (moved on again)' })
    expect((await applyChangePropagation(next, later, db.sql, { userId, taskId }, p3.provider)).action).toBe('updated')
    expect(p3.calls).toHaveLength(1)
  })

  it('failure during propagation reconciles the sync without state damage', async () => {
    const { db, userId, taskId } = await freshTask()
    await driveToSynchronizing(db, userId, taskId)
    const stateEventsBefore = eventsOfType(db, 'state_changed').length
    const next = reservationDraft({ taskId, location: 'new address' })
    const { provider } = spyProvider('throw')
    const result = await applyChangePropagation(reservationDraft({ taskId }), next, db.sql, { userId, taskId }, provider)
    expect(result.action).toBe('reconcile')
    expect(eventsOfType(db, 'state_changed')).toHaveLength(stateEventsBefore)
    const projection = await loadProjection(db.sql, { userId, taskId })
    expect(projection?.sync_state.calendar?.status).toBe('needs_reconciliation')
    expect((await getTask(db.sql, { userId, taskId }))?.state).toBe('SYNCHRONIZING')
  })
})
