/**
 * Wiring test for the P1 turn-path receipts gate (HIREALPHA_RECEIPT_GATE=1)
 * inside services/tasks/taskLifecycle.ts mirrorJobFinished: a purchase-shaped
 * finish (job row carries spend_request_id) must be judged by the plan's
 * evidence table through receipts.recordReceipt, never by a screenshot alone.
 * Reuses the stateful fake SQL from taskLifecycle.test.ts.
 */
import { afterAll, describe, expect, it } from 'bun:test'
import { loadProjection } from './taskStore'
import { mirrorJobClaimed, mirrorJobEnqueued, mirrorJobFinished } from './taskLifecycle'

type Row = Record<string, unknown>

/** hire_tasks + hire_task_events + one hire_browser_jobs row + optional
 * hire_spend_approvals row (same fake-world pattern as taskLifecycle.test). */
function fakeWorld(job: Row) {
  const tasks = new Map<string, Row>()
  const events: Row[] = []

  const sql = ((strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.join('?')
    if (text.includes('INSERT INTO hire_tasks')) {
      const row: Row = {
        id: `task-${tasks.size + 1}`, user_id: values[0], persona: values[1], conversation_id: values[2] ?? null,
        request: values[3], state: 'DRAFT', resumed_state: null, monitor_state: 'OFF',
        monitor_policy: null, monitor_next_check_at: null, plan_version: 0, plan: null, current_step: null,
        constraints: '{}', options: '[]', selected_option_id: null, grants: '[]', external_ops: '[]',
        artifacts: '[]', verification: null, sync_state: '{}', failure: null,
        version: 0, event_seq: 0, created_at: 'x', updated_at: 'x',
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
        state, resumed_state: resumed, constraints, monitor_state: monitorState, monitor_policy: monitorPolicy,
        monitor_next_check_at: monitorNext, plan_version: planVersion, plan, current_step: currentStep, options,
        selected_option_id: selected, external_ops: ops, artifacts, verification, sync_state: sync, failure,
        grants,
        version: Number(row.version) + 1, event_seq: seq,
      })
      return Promise.resolve([row])
    }
    if (text.includes('INSERT INTO hire_task_events')) {
      const row = text.includes('causation_id')
        ? { event_id: values[0], task_id: values[1], user_id: values[2], schema_version: 1, type: values[3], actor: values[4], causation_id: values[5], correlation_id: values[6], idempotency_key: values[7], occurred_at: 'x', payload: values[8], task_seq: values[9] }
        : { event_id: values[0], task_id: values[1], user_id: values[2], schema_version: 1, type: values[3], actor: values[4], causation_id: null, correlation_id: null, idempotency_key: null, occurred_at: 'x', payload: values[5], task_seq: values[6] }
      events.push(row)
      return Promise.resolve([row])
    }
    if (text.includes('FROM hire_task_events') && text.includes('idempotency_key =')) {
      const [taskId, idemKey] = values
      return Promise.resolve(events.filter((e) => e.task_id === taskId && e.idempotency_key === idemKey).slice(0, 1))
    }
    if (text.includes('FROM hire_task_events')) {
      const [taskId, userId, afterSeq] = values
      return Promise.resolve(
        events
          .filter((e) => e.task_id === taskId && e.user_id === userId && Number(e.task_seq) > Number(afterSeq ?? 0))
          .sort((a, b) => Number(a.task_seq) - Number(b.task_seq)),
      )
    }
    if (text.includes('UPDATE hire_browser_jobs SET task_id')) {
      job.task_id = values[0]
      return Promise.resolve([])
    }
    if (text.includes('SELECT user_id, task_id') && text.includes('hire_browser_jobs')) {
      return Promise.resolve(job.task_id
        ? [{
            user_id: job.user_id, task_id: job.task_id, last_screenshot: job.last_screenshot ?? null,
            kind: job.kind ?? null, spend_request_id: job.spend_request_id ?? null, goal: job.goal ?? null,
          }]
        : [])
    }
    if (text.includes('SELECT task_id FROM hire_browser_jobs')) {
      return Promise.resolve([{ task_id: job.task_id ?? null }])
    }
    if (text.includes('SELECT status FROM hire_browser_jobs')) {
      return Promise.resolve([{ status: job.status }])
    }
    if (text.includes('FROM hire_spend_approvals')) {
      const approval = job.approval as Row | undefined
      return Promise.resolve(approval ? [{ amount_cents: approval.amount_cents, status: approval.status, finalization_status: approval.finalization_status }] : [])
    }
    if (text.includes('FROM hire_tasks')) {
      const row = tasks.get(String(values[0]))
      return Promise.resolve(row && row.user_id === values[1] ? [row] : [])
    }
    throw new Error(`fakeWorld: unmatched query: ${text.slice(0, 120)}`)
  }) as { begin: (cb: (tx: unknown) => Promise<unknown>) => Promise<unknown> }
  sql.begin = (cb) => cb(sql)

  return { sql: sql as never, events, tasks }
}

const savedRecord = process.env.HIREALPHA_TASK_RECORD
const savedGate = process.env.HIREALPHA_RECEIPT_GATE
afterAll(() => {
  if (savedRecord === undefined) delete process.env.HIREALPHA_TASK_RECORD
  else process.env.HIREALPHA_TASK_RECORD = savedRecord
  if (savedGate === undefined) delete process.env.HIREALPHA_RECEIPT_GATE
  else process.env.HIREALPHA_RECEIPT_GATE = savedGate
})

function purchaseJob(overrides: Row = {}): Row {
  return {
    id: 'job-1', user_id: 'user-1', task_id: null, status: 'done',
    kind: 'checkout', goal: 'buy the annual plan', spend_request_id: 'spend-1',
    approval: { amount_cents: 3200, status: 'consumed', finalization_status: 'completed' },
    ...overrides,
  }
}

const meta = {
  jobId: 'job-1', userId: 'user-1', persona: 'friend', kind: 'checkout',
  url: 'https://shop.example.com/checkout', goal: 'buy the annual plan',
  approval_id: null, credential_capability_id: null, spend_request_id: 'spend-1',
}

async function runToFinish(job: Row) {
  const world = fakeWorld(job)
  const taskId = await mirrorJobEnqueued(world.sql, meta)
  expect(taskId).not.toBe(null)
  job.status = 'running'
  await mirrorJobClaimed(world.sql, meta)
  job.status = 'done'
  return { world, taskId: taskId! }
}

function evidenceRefs(world: ReturnType<typeof fakeWorld>): string[] {
  const ev = world.events.filter((e) => e.type === 'verification_recorded').at(-1)
  const payload = ev?.payload as { evidence?: string[] } | undefined
  return payload?.evidence ?? []
}

describe('turn-path receipts wiring (HIREALPHA_RECEIPT_GATE)', () => {
  it('gate off: a purchase finish keeps the legacy screenshot behavior exactly', async () => {
    process.env.HIREALPHA_TASK_RECORD = '1'
    delete process.env.HIREALPHA_RECEIPT_GATE
    const job = purchaseJob({ last_screenshot: 'data:image/png;base64,RECEIPT' })
    const { world, taskId } = await runToFinish(job)
    await mirrorJobFinished(world.sql, 'job-1', { ok: true, result: 'Confirmation: ORD-4471' })
    const projection = await loadProjection(world.sql, { userId: 'user-1', taskId })
    expect(projection?.state).toBe('FULFILLED')
    expect(projection?.verification?.passed).toBe(true)
    // Legacy evidence: screenshot refs, no receipt verdict, no approval lookup.
    expect(evidenceRefs(world)).toEqual(['hire_browser_jobs:job-1', 'screenshot:job-1'])
    expect(world.events.some((e) => e.idempotency_key === 'job-1:verified')).toBe(true)
    expect(world.events.some((e) => String(e.idempotency_key ?? '').startsWith('job-1:receipt'))).toBe(false)
  })

  it('gate on: confirmation token + paid approval row -> receipt verdict FULFILLS the task', async () => {
    process.env.HIREALPHA_TASK_RECORD = '1'
    process.env.HIREALPHA_RECEIPT_GATE = '1'
    const job = purchaseJob({ last_screenshot: null })
    const { world, taskId } = await runToFinish(job)
    await mirrorJobFinished(world.sql, 'job-1', { ok: true, result: 'Thank you. Confirmation: ORD-4471' })
    const projection = await loadProjection(world.sql, { userId: 'user-1', taskId })
    expect(projection?.state).toBe('FULFILLED')
    expect(projection?.verification?.passed).toBe(true)
    const refs = evidenceRefs(world)
    expect(refs.some((r) => r.startsWith('receipt:purchase:sha256:'))).toBe(true)
    expect(refs.some((r) => r === 'confirmation_ref:ord-4471')).toBe(true)
    // recordReceipt wrote the verification; the legacy screenshot block did not run.
    expect(world.events.some((e) => e.idempotency_key === 'job-1:verified')).toBe(false)
    const types = world.events.map((e) => `${e.type}:${(e.payload as Row).to ?? ''}`)
    expect(types).toContain('state_changed:SYNCHRONIZING')
    expect(types).toContain('state_changed:FULFILLED')
  })

  it('gate on: no confirmation token in the result -> incomplete receipt parks in VERIFYING', async () => {
    process.env.HIREALPHA_TASK_RECORD = '1'
    process.env.HIREALPHA_RECEIPT_GATE = '1'
    const job = purchaseJob({ last_screenshot: 'data:image/png;base64,RECEIPT' })
    const { world, taskId } = await runToFinish(job)
    await mirrorJobFinished(world.sql, 'job-1', { ok: true, result: 'checkout started' })
    const projection = await loadProjection(world.sql, { userId: 'user-1', taskId })
    expect(projection?.state).toBe('VERIFYING') // screenshot alone no longer fulfills a purchase
    expect(projection?.verification?.passed).toBe(false)
    expect(evidenceRefs(world).some((r) => r.startsWith('receipt_incomplete:purchase:confirmation_id'))).toBe(true)
    expect(world.events.some((e) => (e.payload as Row).to === 'FULFILLED')).toBe(false)
    expect(world.events.some((e) => (e.payload as Row).to === 'SYNCHRONIZING')).toBe(false)
  })

  it('gate on: approval row not settled -> contradictory payment_status parks in VERIFYING', async () => {
    process.env.HIREALPHA_TASK_RECORD = '1'
    process.env.HIREALPHA_RECEIPT_GATE = '1'
    const job = purchaseJob({
      last_screenshot: 'data:image/png;base64,RECEIPT',
      approval: { amount_cents: 3200, status: 'pending', finalization_status: 'pending' },
    })
    const { world, taskId } = await runToFinish(job)
    await mirrorJobFinished(world.sql, 'job-1', { ok: true, result: 'Order confirmation number: ORD-4471' })
    const projection = await loadProjection(world.sql, { userId: 'user-1', taskId })
    expect(projection?.state).toBe('VERIFYING')
    expect(projection?.verification?.passed).toBe(false)
    // 'pending' would be a legal merchant payment_status; namespaced it is
    // structurally unknown, so the evidence table refuses to call it paid.
    expect(evidenceRefs(world).some((r) => r.startsWith('receipt_contradictory:purchase:payment_status_unknown'))).toBe(true)
    expect(world.events.some((e) => (e.payload as Row).to === 'FULFILLED')).toBe(false)
  })
})
