import { describe, expect, it } from 'bun:test'
import {
  EXCEPTION_STATES,
  FAILURE_REASON_CODES,
  MONITOR_STATES,
  TASK_EVENT_TYPES,
  TASK_STATES,
  assertNoSecretKeys,
  assertTransition,
  parseEventInput,
  reduce,
  seedProjection,
  type TaskProjection,
  type TaskState,
} from './taskContract'

function card(id: string, title: string) {
  return {
    id, title,
    reason: 'closest to your office',
    source_url: 'https://example.com/listing',
    freshness: '2026-09-14T18:00:00.000Z',
    price_cents: 4200,
    currency: 'USD',
  }
}

function at(state: TaskState, extra: Partial<TaskProjection> = {}): TaskProjection {
  return { ...seedProjection('book a table', 'friend', null), state, ...extra }
}

function move(from: TaskState, to: TaskState, projection?: TaskProjection) {
  return assertTransition(from, to, projection ?? at(from), { to })
}

describe('task state machine', () => {
  it('walks the full happy path', () => {
    let projection = at('DRAFT')
    const steps: Array<[TaskState, TaskState, Record<string, unknown>]> = [
      ['DRAFT', 'RESEARCHING', {}],
      ['RESEARCHING', 'WAITING_FOR_SELECTION', {}],
      ['WAITING_FOR_SELECTION', 'PLANNING_ACTION', {}],
      ['PLANNING_ACTION', 'WAITING_FOR_AUTHORITY', {}],
    ]
    for (const [from, to, payload] of steps) {
      assertTransition(from, to, projection, { to, ...payload } as never)
      projection = reduce(projection, { type: 'state_changed', payload: { to, ...payload } })
    }
    // Select + grant authority, then execute with the grant id.
    projection = reduce(projection, { type: 'options_published', payload: { options: [card('opt-1', 'River Hotel')] } })
    projection = reduce(projection, { type: 'option_selected', payload: { option_id: 'opt-1' } })
    projection = reduce(projection, { type: 'authority_requested', payload: { grant_id: 'g-1' } })
    projection = reduce(projection, { type: 'authority_granted', payload: { grant_id: 'g-1' } })
    assertTransition('WAITING_FOR_AUTHORITY', 'EXECUTING', projection, { to: 'EXECUTING', grant_id: 'g-1' })
    projection = reduce(projection, { type: 'state_changed', payload: { to: 'EXECUTING', grant_id: 'g-1' } })
    projection = reduce(projection, { type: 'state_changed', payload: { to: 'VERIFYING' } })
    // Verify -> synchronize -> fulfill -> close.
    projection = reduce(projection, { type: 'verification_recorded', payload: { passed: true, evidence: ['order-123'] } })
    assertTransition('VERIFYING', 'SYNCHRONIZING', projection, { to: 'SYNCHRONIZING' })
    projection = reduce(projection, { type: 'state_changed', payload: { to: 'SYNCHRONIZING' } })
    assertTransition('SYNCHRONIZING', 'FULFILLED', projection, { to: 'FULFILLED' })
    projection = reduce(projection, { type: 'state_changed', payload: { to: 'FULFILLED' } })
    assertTransition('FULFILLED', 'CLOSED', projection, { to: 'CLOSED' })
  })

  it('forbids executing without a selected option when options were offered', () => {
    expect(() => move('WAITING_FOR_SELECTION', 'EXECUTING')).toThrow('Forbidden')
    expect(() =>
      assertTransition('PLANNING_ACTION', 'EXECUTING', at('PLANNING_ACTION', {
        selected_option_id: null,
        options: [{ id: 'opt-1', title: 'A' }],
      }), { to: 'EXECUTING', authority: 'not_required' }),
    ).toThrow('selected option')
  })

  it('forbids WAITING_FOR_AUTHORITY -> EXECUTING without a valid scoped grant', () => {
    const projection = at('WAITING_FOR_AUTHORITY', { selected_option_id: 'opt-1', options: [card('opt-1', 'x')] })
    expect(() => assertTransition('WAITING_FOR_AUTHORITY', 'EXECUTING', projection, { to: 'EXECUTING' })).toThrow('grant id')
    expect(() =>
      assertTransition('WAITING_FOR_AUTHORITY', 'EXECUTING', projection, { to: 'EXECUTING', grant_id: 'g-1' }),
    ).toThrow('not in granted state')
    const revoked = reduce(projection, { type: 'authority_requested', payload: { grant_id: 'g-1' } })
    expect(() => assertTransition('WAITING_FOR_AUTHORITY', 'EXECUTING', revoked, { to: 'EXECUTING', grant_id: 'g-1' })).toThrow(
      'not in granted state',
    )
  })

  it('forbids fulfillment without independent verification', () => {
    expect(() => move('VERIFYING', 'FULFILLED', at('VERIFYING', { selected_option_id: 'opt-1' }))).toThrow('Forbidden')
    expect(() => move('SYNCHRONIZING', 'FULFILLED')).toThrow('verification evidence')
    expect(() => move('VERIFYING', 'SYNCHRONIZING')).toThrow('verification evidence')
  })

  it('forbids automatic retry out of reconciliation but allows verification and takeover', () => {
    const projection = at('NEEDS_RECONCILIATION', { selected_option_id: 'opt-1', options: [card('opt-1', 'x')] })
    expect(() => assertTransition('NEEDS_RECONCILIATION', 'EXECUTING', projection, { to: 'EXECUTING', authority: 'not_required' })).toThrow('Forbidden')
    assertTransition('NEEDS_RECONCILIATION', 'VERIFYING', projection, { to: 'VERIFYING' })
    assertTransition('NEEDS_RECONCILIATION', 'HUMAN_TAKEOVER', projection, { to: 'HUMAN_TAKEOVER' })
  })

  it('allows named exception states from any non-terminal state and none from terminal ones', () => {
    for (const target of EXCEPTION_STATES) {
      move('EXECUTING', target)
    }
    for (const terminal of ['CLOSED', 'CANCELLED', 'FAILED_FINAL'] as TaskState[]) {
      expect(() => move(terminal, 'EXECUTING')).toThrow(terminal)
      expect(() => move(terminal, 'CANCELLED')).toThrow(terminal)
    }
  })

  it('pauses and resumes only to the state the task fell out of', () => {
    const executing = at('EXECUTING', { selected_option_id: 'opt-1' })
    const paused = reduce(executing, { type: 'state_changed', payload: { to: 'PAUSED_BY_USER' } })
    expect(paused.resumed_state).toBe('EXECUTING')
    assertTransition('PAUSED_BY_USER', 'EXECUTING', paused, { to: 'EXECUTING' })
    expect(() => move('PAUSED_BY_USER', 'VERIFYING', paused)).toThrow('Forbidden')
    expect(() => move('PAUSED_BY_USER', 'RESEARCHING', paused)).toThrow('Forbidden')
    const resumed = reduce(paused, { type: 'state_changed', payload: { to: 'EXECUTING' } })
    expect(resumed.resumed_state).toBe(null)
  })

  it('rejects no-op transitions', () => {
    expect(() => move('RESEARCHING', 'RESEARCHING')).toThrow('No-op')
  })
})

describe('event contract', () => {
  it('rejects unknown event types and malformed payloads', () => {
    expect(() => parseEventInput({ type: 'hack_the_planet', payload: {} })).toThrow('Unknown task event type')
    expect(() => parseEventInput({ type: 'option_selected', payload: {} })).toThrow('option_id')
    expect(() => parseEventInput({ type: 'monitor_updated', payload: { state: 'PAUSED' } })).toThrow('monitor state')
    expect(() => parseEventInput({ type: 'failure_recorded', payload: { reason_code: 'yolo' } })).toThrow('reason code')
    expect(() => parseEventInput({ type: 'state_changed', payload: { to: 'EXPLODING' } })).toThrow('Unknown task state')
    for (const code of FAILURE_REASON_CODES) {
      expect(() => parseEventInput({ type: 'failure_recorded', payload: { reason_code: code } })).not.toThrow()
    }
  })

  it('replays dedupe, selection consistency, and grant fencing in the reducer', () => {
    let projection = at('RESEARCHING', { options: [{ id: 'a', title: 'A' }, { id: 'b', title: 'B' }], selected_option_id: 'a' })
    projection = reduce(projection, { type: 'option_rejected', payload: { option_id: 'a' } })
    expect(projection.selected_option_id).toBe(null)
    expect(() => reduce(projection, { type: 'option_selected', payload: { option_id: 'missing' } })).toThrow('unknown option')
    // external op dedupe by operation + idempotency key.
    const before = projection.external_ops.length
    const op = { operation: 'checkout.submit', idempotency_key: 'k-1', status: 'done', evidence_ref: null }
    projection = reduce(projection, { type: 'external_op_recorded', payload: op })
    projection = reduce(projection, { type: 'external_op_recorded', payload: op })
    expect(projection.external_ops.length).toBe(before + 1)
    expect(() => reduce(at('DRAFT'), { type: 'authority_granted', payload: { grant_id: 'ghost' } })).toThrow('unknown capability')
  })

  it('rejects secret values in payloads at any depth', () => {
    expect(() => assertNoSecretKeys({ ref: 'vault:item-1', grant_id: 'g-1' })).not.toThrow()
    expect(() => assertNoSecretKeys({ steps: [{ fill: { password: 'hunter2' } }] })).toThrow('password')
    expect(() => assertNoSecretKeys({ card: { number: { cvv: '123' } } })).toThrow('cvv')
  })

  it('exposes every event type the store accepts', () => {
    expect(TASK_EVENT_TYPES).toContain('state_changed')
    expect(TASK_EVENT_TYPES).toContain('verification_recorded')
  })

  it('rejects cards without a decision surface at publish time', () => {
    const full = card('ok', 'Full')
    expect(() => parseEventInput({ type: 'options_published', payload: { options: [] } })).toThrow('non-empty')
    expect(() => parseEventInput({ type: 'options_published', payload: { options: [{ id: 'a', title: 'no source' }] } })).toThrow('source_url')
    expect(() => parseEventInput({ type: 'options_published', payload: { options: [{ ...full, source_url: 'http://insecure.test' }] } })).toThrow('https')
    expect(() => parseEventInput({ type: 'options_published', payload: { options: [{ ...full, freshness: 'yesterday' }] } })).toThrow('timestamp')
    expect(() => parseEventInput({ type: 'options_published', payload: { options: [{ ...full, price_cents: -1 }] } })).toThrow('price_cents')
    expect(() => parseEventInput({ type: 'options_published', payload: { options: [full, { ...full }] } })).toThrow('unique')
    const parsed = parseEventInput({
      type: 'options_published',
      payload: { options: [{ ...full, currency: 'usd', taxes_included: true, cancellation: 'free until 24h', sponsored: true }] },
    })
    expect(parsed.type).toBe('options_published')
    if (parsed.type === 'options_published') {
      expect(parsed.payload.options[0]?.currency).toBe('USD')
      expect(parsed.payload.options[0]?.taxes_included).toBe(true)
      expect(parsed.payload.options[0]?.sponsored).toBe(true)
    }
  })

  it('refuses selecting a rejected or sold-out card', () => {
    let projection = at('WAITING_FOR_SELECTION', { options: [card('a', 'A'), { ...card('b', 'B'), available: false }] })
    expect(() => reduce(projection, { type: 'option_selected', payload: { option_id: 'b' } })).toThrow('unavailable')
    projection = reduce(projection, { type: 'option_rejected', payload: { option_id: 'a' } })
    expect(() => reduce(projection, { type: 'option_selected', payload: { option_id: 'a' } })).toThrow('rejected')
  })
})

describe('migration drift guard', () => {
  it('the CHECK constraints list exactly the contract states', async () => {
    const sql = await Bun.file(`${import.meta.dir}/../../deploy/migrations/202609140003_canonical_tasks.sql`).text()
    for (const state of TASK_STATES) expect(sql).toContain(`'${state}'`)
    for (const monitor of MONITOR_STATES) expect(sql).toContain(`'${monitor}'`)
    // No stray state names in the file's state CHECK block.
    const block = sql.slice(sql.indexOf('hire_tasks_state_check'), sql.indexOf('hire_tasks_monitor_state_check'))
    for (const state of TASK_STATES) expect(block).toContain(`'${state}'`)
    expect(block).toContain("'DRAFT', 'CLARIFYING'")
  })
})
