import { afterAll, describe, expect, it } from 'bun:test'
import { loadProjection } from './taskStore'
import {
  mirrorJobClaimed,
  mirrorJobEnqueued,
  mirrorJobFinished,
  mirrorJobHandoff,
  mirrorJobHandoffResumed,
  mirrorJobReconcile,
  taskRecordFailureIsFatal,
} from './taskLifecycle'

type Row = Record<string, unknown>

/** hire_tasks + hire_task_events (same shape as taskStore.test) plus one
 * hire_browser_jobs row for the link/lookup queries the mirror emits. */
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
        selected_option_id: selected, grants, external_ops: ops, artifacts, verification, sync_state: sync, failure,
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
        ? [{ user_id: job.user_id, task_id: job.task_id, last_screenshot: job.last_screenshot ?? null }]
        : [])
    }
    if (text.includes('SELECT task_id FROM hire_browser_jobs')) {
      return Promise.resolve([{ task_id: job.task_id ?? null }])
    }
    if (text.includes('SELECT status FROM hire_browser_jobs')) {
      return Promise.resolve([{ status: job.status }])
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

const saved = process.env.HIREALPHA_TASK_RECORD
afterAll(() => {
  if (saved === undefined) delete process.env.HIREALPHA_TASK_RECORD
  else process.env.HIREALPHA_TASK_RECORD = saved
})

function baseJob(overrides: Row = {}): Row {
  return {
    id: 'job-1', user_id: 'user-1', task_id: null, status: 'pending',
    ...overrides,
  }
}

const meta = {
  jobId: 'job-1', userId: 'user-1', persona: 'friend', kind: 'agent',
  url: 'https://shop.example.com/checkout', goal: 'buy socks',
  approval_id: 'approval-1', credential_capability_id: null, spend_request_id: null,
}

describe('browser-job task mirror', () => {
  it('makes canonical-record divergence fatal in production only', () => {
    expect(taskRecordFailureIsFatal({ NODE_ENV: 'production' })).toBe(true)
    expect(taskRecordFailureIsFatal({ NODE_ENV: 'production', HIREALPHA_TASK_RECORD: '0' })).toBe(false)
    expect(taskRecordFailureIsFatal({ NODE_ENV: 'test' })).toBe(false)
  })

  it('is completely inert while the flag is off', async () => {
    process.env.HIREALPHA_TASK_RECORD = '0'
    const job = baseJob()
    const world = fakeWorld(job)
    expect(await mirrorJobEnqueued(world.sql, meta)).toBe(null)
    await mirrorJobClaimed(world.sql, meta)
    await mirrorJobFinished(world.sql, 'job-1', { ok: true, result: 'done' })
    expect(world.events).toHaveLength(0)
    expect(world.tasks.size).toBe(0)
  })

  it('is enabled by default so production cannot silently omit the task record', async () => {
    delete process.env.HIREALPHA_TASK_RECORD
    const job = baseJob()
    const world = fakeWorld(job)
    expect(await mirrorJobEnqueued(world.sql, meta)).not.toBe(null)
    expect(world.tasks.size).toBe(1)
  })

  it('mirrors enqueue -> claim -> handoff -> resume -> finish as a fulfilled task', async () => {
    process.env.HIREALPHA_TASK_RECORD = '1'
    const job = baseJob()
    const world = fakeWorld(job)
    const taskId = await mirrorJobEnqueued(world.sql, meta)
    expect(taskId).not.toBe(null)
    expect(job.task_id).toBe(taskId)
    job.status = 'running'
    await mirrorJobClaimed(world.sql, meta)
    job.status = 'waiting'
    await mirrorJobHandoff(world.sql, 'job-1', 'password')
    let projection = await loadProjection(world.sql, { userId: 'user-1', taskId: taskId! })
    expect(projection?.state).toBe('PAUSED_BY_USER')
    expect(projection?.resumed_state).toBe('EXECUTING')
    job.status = 'running'
    await mirrorJobHandoffResumed(world.sql, 'job-1')
    projection = await loadProjection(world.sql, { userId: 'user-1', taskId: taskId! })
    expect(projection?.state).toBe('EXECUTING')
    expect(projection?.monitor_state).toBe('OFF')
    job.status = 'done'
    job.last_screenshot = 'data:image/png;base64,RECEIPT'
    await mirrorJobFinished(world.sql, 'job-1', { ok: true, result: 'socks ordered' })
    projection = await loadProjection(world.sql, { userId: 'user-1', taskId: taskId! })
    expect(projection?.state).toBe('FULFILLED')
    expect(projection?.verification?.passed).toBe(true)
    expect(projection?.artifacts.some((a) => a.kind === 'browser_job')).toBe(true)
    const types = world.events.map((e) => e.type)
    expect(types.filter((t) => t === 'state_changed')).toHaveLength(8)
  })

  it('routes a captcha to named human takeover and back', async () => {
    process.env.HIREALPHA_TASK_RECORD = '1'
    const job = baseJob({ status: 'running' })
    const world = fakeWorld(job)
    const taskId = await mirrorJobEnqueued(world.sql, meta)
    await mirrorJobClaimed(world.sql, meta)
    await mirrorJobHandoff(world.sql, 'job-1', 'captcha')
    let projection = await loadProjection(world.sql, { userId: 'user-1', taskId: taskId! })
    expect(projection?.state).toBe('HUMAN_TAKEOVER')
    await mirrorJobHandoffResumed(world.sql, 'job-1')
    projection = await loadProjection(world.sql, { userId: 'user-1', taskId: taskId! })
    expect(projection?.state).toBe('EXECUTING')
  })

  it('keeps the task retryable when the queue re-arms the job', async () => {
    process.env.HIREALPHA_TASK_RECORD = '1'
    const job = baseJob({ status: 'running' })
    const world = fakeWorld(job)
    const taskId = await mirrorJobEnqueued(world.sql, meta)
    await mirrorJobClaimed(world.sql, meta)
    job.status = 'pending' // the retry branch re-arms the row
    await mirrorJobFinished(world.sql, 'job-1', { ok: false, error: 'selector died', retry: true })
    let projection = await loadProjection(world.sql, { userId: 'user-1', taskId: taskId! })
    expect(projection?.state).toBe('FAILED_RETRYABLE')
    expect(projection?.failure?.reason_code).toBe('browser_replan_required')
    job.status = 'running'
    await mirrorJobClaimed(world.sql, meta)
    projection = await loadProjection(world.sql, { userId: 'user-1', taskId: taskId! })
    expect(projection?.state).toBe('EXECUTING')
    job.status = 'done'
    job.last_screenshot = 'data:image/png;base64,RECEIPT'
    await mirrorJobFinished(world.sql, 'job-1', { ok: true, result: 'ok' })
    projection = await loadProjection(world.sql, { userId: 'user-1', taskId: taskId! })
    expect(projection?.state).toBe('FULFILLED')
  })

  it('parks done-without-evidence in VERIFYING, never claims completion', async () => {
    process.env.HIREALPHA_TASK_RECORD = '1'
    const job = baseJob({ status: 'running' })
    const world = fakeWorld(job)
    const taskId = await mirrorJobEnqueued(world.sql, meta)
    await mirrorJobClaimed(world.sql, meta)
    job.status = 'done'
    await mirrorJobFinished(world.sql, 'job-1', { ok: true, result: 'trust me' })
    const projection = await loadProjection(world.sql, { userId: 'user-1', taskId: taskId! })
    expect(projection?.state).toBe('VERIFYING')
    expect(projection?.verification?.passed).toBe(false)
    expect(projection?.failure?.reason_code).toBe('verification_failed')
  })

  it('swept dead runs land in visible reconciliation, never silent orphans', async () => {
    process.env.HIREALPHA_TASK_RECORD = '1'
    const job = baseJob({ status: 'running' })
    const world = fakeWorld(job)
    const taskId = await mirrorJobEnqueued(world.sql, meta)
    await mirrorJobClaimed(world.sql, meta)
    await mirrorJobReconcile(world.sql, 'job-1', 'Worker interrupted; outcome unknown. Review before retrying.')
    const projection = await loadProjection(world.sql, { userId: 'user-1', taskId: taskId! })
    expect(projection?.state).toBe('NEEDS_RECONCILIATION')
    expect(projection?.failure?.reason_code).toBe('needs_reconciliation')
    // and the contract forbids an automatic retry out of that state.
    job.status = 'running'
    await mirrorJobClaimed(world.sql, meta)
    const after = await loadProjection(world.sql, { userId: 'user-1', taskId: taskId! })
    expect(after?.state).toBe('NEEDS_RECONCILIATION')
  })

  it('reuses the existing task link when a job is enqueued twice', async () => {
    process.env.HIREALPHA_TASK_RECORD = '1'
    const job = baseJob()
    const world = fakeWorld(job)
    const first = await mirrorJobEnqueued(world.sql, meta)
    const second = await mirrorJobEnqueued(world.sql, meta)
    expect(second).toBe(first)
    expect(world.tasks.size).toBe(1)
  })
})
