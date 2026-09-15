import { describe, expect, it } from 'bun:test'
import {
  REQUIRED_FIELDS,
  canAutoRetry,
  evaluateReceipt,
  findUncertainOps,
  hashEvidence,
  reconciliationNeeded,
  recordReceipt,
  type EvidenceRecord,
} from './receipts'
import { appendEvent, createTask, loadProjection } from './taskStore'
import { seedProjection, type ExternalOp, type TaskProjection } from './taskContract'

type Row = Record<string, unknown>

/**
 * Stateful fake (same pattern as taskStore.test.ts): implements just the
 * query shapes taskStore emits, stores JSONB as strings, and records every
 * serialized query so tests can prove no raw evidence values reach SQL.
 */
function fakeTaskDb() {
  const tasks = new Map<string, Row>()
  const events: Row[] = []
  const queries: string[] = []

  const sql = ((strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.join('?')
    queries.push(`${text} ||| ${JSON.stringify(values)}`)
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

  return { sql: sql as never, tasks, events, queries }
}

/** DRAFT -> PLANNING_ACTION -> EXECUTING (no options, authority not required) -> VERIFYING. */
async function taskInVerifying() {
  const db = fakeTaskDb()
  const task = await createTask(db.sql, { userId: 'user-1', request: 'buy the espresso machine', persona: 'friend' })
  const move = async (payload: Record<string, unknown>) => {
    await appendEvent(db.sql, { userId: 'user-1', taskId: task.id, type: 'state_changed', payload, actor: 'alpha' })
  }
  await move({ to: 'PLANNING_ACTION' })
  await move({ to: 'EXECUTING', authority: 'not_required' })
  await move({ to: 'VERIFYING' })
  db.queries.length = 0
  return { db, task }
}

const FULL_PURCHASE: EvidenceRecord = {
  confirmation_id: 'ORD-77XQZ',
  items: 'two-portafilters-latteart-CBX99',
  total_cents: 99004711,
  payment_status: 'paid',
}

function projectionWith(overrides: Partial<TaskProjection>): TaskProjection {
  return { ...seedProjection('buy a table', 'friend', null), ...overrides }
}

describe('receipt evaluation (verification policy table)', () => {
  it('purchase missing the total is incomplete, naming exactly what is absent', () => {
    const result = evaluateReceipt('purchase', { confirmation_id: 'ORD-1', items: 'one', payment_status: 'paid' })
    expect(result.verdict).toBe('incomplete')
    expect(result.missing).toEqual(['total_cents'])
  })

  it('complete, consistent purchase evidence is verified', () => {
    expect(evaluateReceipt('purchase', FULL_PURCHASE)).toEqual({ verdict: 'verified', missing: [], reasons: [] })
  })

  it('junk payment_status is contradictory, never a retry', () => {
    const result = evaluateReceipt('purchase', { ...FULL_PURCHASE, payment_status: 'wire_pending_bank' })
    expect(result.verdict).toBe('contradictory')
    expect(result.reasons).toEqual(['payment_status_unknown'])
  })

  it('non-positive or unparseable totals are contradictory', () => {
    expect(evaluateReceipt('purchase', { ...FULL_PURCHASE, total_cents: 0 }).reasons).toEqual(['total_cents_not_positive'])
    expect(evaluateReceipt('purchase', { ...FULL_PURCHASE, total_cents: 'nine hundred' }).reasons).toEqual(['total_cents_not_positive'])
  })

  it('reservation rules follow the provider-confirmation row of the table', () => {
    expect(evaluateReceipt('reservation', { confirmation_number: 'R-9', dates: '2026-09-20T19:00:00Z', terms: 'cancel 24h' }).missing).toEqual(['party'])
    const junkDates = evaluateReceipt('reservation', { confirmation_number: 'R-9', dates: 'the day after tuesday', party: 4, terms: 'cancel 24h' })
    expect(junkDates.verdict).toBe('contradictory')
    expect(junkDates.reasons).toEqual(['dates_unparsable'])
  })

  it('appointment, return, and paperwork rules are structural enums and ids', () => {
    expect(evaluateReceipt('appointment', { confirmation_id: 'CAL-3', record_source: 'calendar' }).verdict).toBe('verified')
    expect(evaluateReceipt('appointment', { confirmation_id: 'CAL-3', record_source: 'vibes' }).reasons).toEqual(['record_source_unknown'])
    expect(evaluateReceipt('return', { return_id: 'FDX-1', refund_status: 'accepted' }).verdict).toBe('verified')
    expect(evaluateReceipt('return', { return_id: 'FDX-1', refund_status: 'maybe' }).reasons).toEqual(['refund_status_unknown'])
    expect(evaluateReceipt('paperwork', { receipt_or_case_id: '  ' }).verdict).toBe('incomplete')
    expect(evaluateReceipt('paperwork', { receipt_or_case_id: 'USCIS-IOE-4471' }).verdict).toBe('verified')
  })

  it('required fields themselves are never secret-shaped', () => {
    const names = new Set(Object.values(REQUIRED_FIELDS).flat())
    for (const secret of ['card_number', 'cvv', 'password', 'token', 'pin', 'otp']) {
      expect(names.has(secret)).toBe(false)
    }
  })

  it('hashEvidence is stable over key order and sensitive to values', () => {
    expect(hashEvidence({ a: 1, b: 'x' })).toBe(hashEvidence({ b: 'x', a: 1 }))
    expect(hashEvidence({ a: 1, b: 'x' })).not.toBe(hashEvidence({ a: 2, b: 'x' }))
  })
})

describe('recordReceipt store integration', () => {
  it('records an incomplete receipt as failed verification and leaves the task parked', async () => {
    const { db, task } = await taskInVerifying()
    const result = await recordReceipt(db.sql, {
      userId: 'user-1', taskId: task.id, taskClass: 'purchase',
      evidence: { confirmation_id: 'ORD-77XQZ', items: 'one' },
      idempotencyKey: 'receipt-purchase-1', now: '2026-09-14T12:00:00Z',
    })
    expect(result.verdict).toBe('incomplete')
    expect(result.event.payload.passed).toBe(false)
    expect(result.event.payload.evidence[0]).toBe('receipt_incomplete:purchase:total_cents,payment_status')
    const projection = await loadProjection(db.sql, { userId: 'user-1', taskId: task.id })
    expect(projection?.state).toBe('VERIFYING')
    expect(projection?.verification?.passed).toBe(false)
  })

  it('a verified receipt gates VERIFYING -> SYNCHRONIZING', async () => {
    const { db, task } = await taskInVerifying()
    const result = await recordReceipt(db.sql, {
      userId: 'user-1', taskId: task.id, taskClass: 'purchase', evidence: FULL_PURCHASE,
      idempotencyKey: 'receipt-purchase-2', now: '2026-09-14T12:00:00Z',
    })
    expect(result.verdict).toBe('verified')
    expect(result.event.payload.passed).toBe(true)
    const projection = await loadProjection(db.sql, { userId: 'user-1', taskId: task.id })
    expect(projection?.state).toBe('SYNCHRONIZING')
    expect(projection?.verification?.passed).toBe(true)
  })

  it('persists only references: the sha256 hash and the short confirmation ref', async () => {
    const { db, task } = await taskInVerifying()
    const result = await recordReceipt(db.sql, {
      userId: 'user-1', taskId: task.id, taskClass: 'purchase', evidence: FULL_PURCHASE,
      idempotencyKey: 'receipt-purchase-3', now: '2026-09-14T12:00:00Z',
    })
    const hash = hashEvidence(FULL_PURCHASE)
    const serialized = db.queries.join('\n')
    // Raw merchant values never travel to SQL.
    expect(serialized).not.toContain('latteart-CBX99')
    expect(serialized).not.toContain('99004711')
    expect(serialized).not.toContain('paid')
    // The hash proves the discarded evidence; the confirmation id is a ref.
    expect(serialized).toContain(hash)
    expect(serialized).toContain('ORD-77XQZ')
    const refs = (result.event.payload.evidence as string[]) ?? []
    expect(refs).toEqual([`receipt:purchase:${hash}`, 'confirmation_ref:ORD-77XQZ'])
  })

  it('contradictory payment status records a failed verification without advancing', async () => {
    const { db, task } = await taskInVerifying()
    const result = await recordReceipt(db.sql, {
      userId: 'user-1', taskId: task.id, taskClass: 'purchase',
      evidence: { ...FULL_PURCHASE, payment_status: 'wire_pending_bank' },
      idempotencyKey: 'receipt-purchase-4', now: '2026-09-14T12:00:00Z',
    })
    expect(result.verdict).toBe('contradictory')
    expect(result.event.payload.evidence[0]).toBe('receipt_contradictory:purchase:payment_status_unknown')
    const projection = await loadProjection(db.sql, { userId: 'user-1', taskId: task.id })
    expect(projection?.state).toBe('VERIFYING')
    expect(reconciliationNeeded(projection as TaskProjection)).toBe(true)
  })

  it('replays the same idempotency key to the stored event with a single row', async () => {
    const { db, task } = await taskInVerifying()
    const call = () =>
      recordReceipt(db.sql, {
        userId: 'user-1', taskId: task.id, taskClass: 'purchase', evidence: FULL_PURCHASE,
        idempotencyKey: 'receipt-purchase-5', now: '2026-09-14T12:00:00Z',
      })
    const first = await call()
    const second = await call()
    expect(second.replayed).toBe(true)
    expect(second.event.event_id).toBe(first.event.event_id)
    expect(db.events.filter((e) => e.type === 'verification_recorded')).toHaveLength(1)
    expect(db.events.filter((e) => e.type === 'state_changed' && e.payload.to === 'SYNCHRONIZING')).toHaveLength(1)
    const projection = await loadProjection(db.sql, { userId: 'user-1', taskId: task.id })
    expect(projection?.state).toBe('SYNCHRONIZING')
  })
})

describe('never-retry reconciliation guards', () => {
  const op = (status: string): ExternalOp => ({ operation: 'purchase.submit', idempotency_key: 'k-1', status })

  it('reconciliationNeeded fires on the parked state or a failed verification', () => {
    expect(reconciliationNeeded(projectionWith({ state: 'NEEDS_RECONCILIATION' }))).toBe(true)
    expect(reconciliationNeeded(projectionWith({ verification: { passed: false, evidence: ['x'] } }))).toBe(true)
    expect(reconciliationNeeded(projectionWith({ state: 'VERIFYING' }))).toBe(false)
    expect(reconciliationNeeded(projectionWith({ verification: { passed: true, evidence: ['x'] } }))).toBe(false)
  })

  it('canAutoRetry is false whenever an external op has uncertain side effects', () => {
    expect(canAutoRetry(projectionWith({ external_ops: [op('submitting')] }))).toBe(false)
    expect(canAutoRetry(projectionWith({ external_ops: [op('done'), op('pending')] }))).toBe(false)
    expect(canAutoRetry(projectionWith({ external_ops: [op('done')] }))).toBe(true)
    expect(canAutoRetry(projectionWith({ external_ops: [] }))).toBe(true)
  })

  it('findUncertainOps returns the rows reconcile tooling must work, trimmed to refs', () => {
    const ops: ExternalOp[] = [
      { operation: 'purchase.submit', idempotency_key: 'k-1', status: 'submitting', evidence_ref: 'stripe:pi_1' },
      { operation: 'email.notify', idempotency_key: 'k-2', status: 'done' },
      { operation: 'refund.start', idempotency_key: 'k-3', status: 'unknown' },
    ]
    expect(findUncertainOps(projectionWith({ external_ops: ops }))).toEqual([
      { idempotency_key: 'k-1', operation: 'purchase.submit', status: 'submitting' },
      { idempotency_key: 'k-3', operation: 'refund.start', status: 'unknown' },
    ])
  })
})
