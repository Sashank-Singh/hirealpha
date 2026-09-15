import { describe, expect, it } from 'bun:test'
import {
  MonitorPolicyError,
  MonitorStateError,
  beginCheck,
  endCheck,
  endMonitoring,
  nextCheckDue,
  recoverMonitoring,
  scheduleMonitoring,
  triggerOnce,
  validateMonitorPolicy,
} from './monitoring'
import { appendEvent, createTask, loadProjection, listEvents } from './taskStore'

type Row = Record<string, unknown>

/**
 * Stateful fake (copied from taskStore.test.ts, kept local to this file):
 * implements just the shapes taskStore emits.
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

const T0 = '2026-09-14T12:00:00.000Z'
const USER = 'user-1'

function at(iso: string, minutes: number): string {
  return new Date(Date.parse(iso) + minutes * 60_000).toISOString()
}

function pricePolicy(overrides: Record<string, unknown> = {}) {
  return {
    watch: {
      kind: 'price',
      target: 'https://shop.test/item/42',
      condition: { metric: 'price_cents', threshold_cents: 4200 },
    },
    cadenceMinutes: 30,
    ...overrides,
  }
}

async function armedTask(policy: unknown = pricePolicy(), now = T0) {
  const db = fakeTaskDb()
  const task = await createTask(db.sql, { userId: USER, request: 'watch the sneaker restock price', persona: 'friend' })
  const result = await scheduleMonitoring(db.sql, { userId: USER, taskId: task.id, policy, now })
  return { db, task: result.task }
}

async function projectionOf(db: ReturnType<typeof fakeTaskDb>, taskId: string) {
  return (await loadProjection(db.sql, { userId: USER, taskId }))!
}

async function monitorEvents(db: ReturnType<typeof fakeTaskDb>, taskId: string) {
  const all = await listEvents(db.sql, { userId: USER, taskId })
  return all.filter((e) => e.type === 'monitor_updated')
}

/* ----------------------------------------------------------- validation */

describe('validateMonitorPolicy', () => {
  it('rejects cadence below the 5-minute floor and junk cadence types', () => {
    expect(() => validateMonitorPolicy(pricePolicy({ cadenceMinutes: 4 }))).toThrow('at least 5')
    expect(() => validateMonitorPolicy(pricePolicy({ cadenceMinutes: 'thirty' }))).toThrow('cadenceMinutes')
    expect(() => validateMonitorPolicy(pricePolicy({ cadenceMinutes: NaN }))).toThrow('cadenceMinutes')
  })

  it('rejects junk watch kinds and metrics mismatched to the kind', () => {
    expect(() => validateMonitorPolicy(pricePolicy({ watch: { kind: 'sentiment', target: 'x', condition: { metric: 'in_stock' } } }))).toThrow('watch.kind')
    const wrongMetric = { watch: { kind: 'price', target: 'https://x.test', condition: { metric: 'slot_open' } }, cadenceMinutes: 30 }
    expect(() => validateMonitorPolicy(wrongMetric)).toThrow('not valid for watch kind')
  })

  it('rejects prose due_at and missing price thresholds', () => {
    const proseDeadline = { watch: { kind: 'deadline', target: 'invoice-77', condition: { metric: 'due_at', due_at: 'sometime next week' } }, cadenceMinutes: 60 }
    expect(() => validateMonitorPolicy(proseDeadline)).toThrow('due_at')
    const noDue = { watch: { kind: 'deadline', target: 'invoice-77', condition: { metric: 'due_at' } }, cadenceMinutes: 60 }
    expect(() => validateMonitorPolicy(noDue)).toThrow('due_at')
    expect(() => validateMonitorPolicy(pricePolicy({ watch: { kind: 'price', target: 'https://x.test', condition: { metric: 'price_cents' } } }))).toThrow('threshold_cents')
    expect(() => validateMonitorPolicy(pricePolicy({ watch: { kind: 'url', target: 'http://plain.test', condition: { metric: 'in_stock' } } }))).toThrow('https')
  })

  it('refuses to schedule auto-act without a scoped grant, and normalizes valid input', () => {
    expect(() => validateMonitorPolicy(pricePolicy({ autoAct: true }))).toThrow('authorityGrantId')
    const v = validateMonitorPolicy(pricePolicy({ autoAct: true, authorityGrantId: 'grant:price-cap', stopAt: '2026-09-21T12:00:00Z', cadenceMinutes: 30.4 }))
    expect(v.cadenceMinutes).toBe(30)
    expect(v.stopAt).toBe('2026-09-21T12:00:00.000Z')
    expect(v.authorityGrantId).toBe('grant:price-cap')
    expect(v.autoAct).toBe(true)
  })
})

/* --------------------------------------------------------- schedule + due */

describe('scheduleMonitoring and the due window', () => {
  it('arms the first check one cadence out and reports due exactly at the window', async () => {
    const { db, task } = await armedTask()
    expect(task.monitor_state).toBe('SCHEDULED')
    const projection = await projectionOf(db, task.id)
    expect(projection.monitor_next_check_at).toBe(at(T0, 30))
    expect(nextCheckDue(projection, at(T0, 29))).toEqual({ due: false, reason: 'not_due_yet' })
    expect(nextCheckDue(projection, at(T0, 30))).toEqual({ due: true, reason: 'due' })
    expect(nextCheckDue(projection, at(T0, 90))).toEqual({ due: true, reason: 'due' })
  })

  it('clamps the first check to stopAt when the cadence would overshoot the window', async () => {
    const { db, task } = await armedTask(pricePolicy({ stopAt: at(T0, 10) }))
    const projection = await projectionOf(db, task.id)
    expect(projection.monitor_next_check_at).toBe(at(T0, 10))
  })

  it('refuses a silent double-schedule but honors an explicit rearm', async () => {
    const { db, task } = await armedTask()
    await expect(
      scheduleMonitoring(db.sql, { userId: USER, taskId: task.id, policy: pricePolicy({ cadenceMinutes: 10 }), now: at(T0, 5) }),
    ).rejects.toBeInstanceOf(MonitorStateError)
    const rearmed = await scheduleMonitoring(db.sql, {
      userId: USER, taskId: task.id, policy: pricePolicy({ cadenceMinutes: 10 }), now: at(T0, 5), rearm: true,
    })
    expect(rearmed.task.monitor_state).toBe('SCHEDULED')
    const projection = await projectionOf(db, task.id)
    expect(projection.monitor_next_check_at).toBe(at(T0, 15)) // T0+5 + 10min
    const scheduled = (await monitorEvents(db, task.id)).filter((e) => e.payload.state === 'SCHEDULED')
    expect(scheduled).toHaveLength(2)
  })

  it('scopes monitoring to the owning user', async () => {
    const { db, task } = await armedTask()
    await expect(
      scheduleMonitoring(db.sql, { userId: 'user-2', taskId: task.id, policy: pricePolicy(), now: T0 }),
    ).rejects.toThrow('not found')
  })
})

/* --------------------------------------------------------- check lifecycle */

describe('beginCheck / endCheck / recoverMonitoring', () => {
  it('SCHEDULED -> CHECKING -> SCHEDULED re-arms exactly one cadence out', async () => {
    const { db, task } = await armedTask()
    const checking = await beginCheck(db.sql, { userId: USER, taskId: task.id })
    expect(checking.task.monitor_state).toBe('CHECKING')
    expect((await projectionOf(db, task.id)).monitor_next_check_at).toBe(null)
    expect(nextCheckDue(await projectionOf(db, task.id), at(T0, 999)).reason).toBe('not_scheduled')
    const done = await endCheck(db.sql, { userId: USER, taskId: task.id, now: at(T0, 40), outcome: { type: 'no_change' } })
    expect(done.task.monitor_state).toBe('SCHEDULED')
    expect((await projectionOf(db, task.id)).monitor_next_check_at).toBe(at(T0, 70))
    await expect(beginCheck(db.sql, { userId: USER, taskId: task.id })).resolves.toBeTruthy()
  })

  it('refuses checks from wrong states (double-begin, end-without-begin)', async () => {
    const { db, task } = await armedTask()
    await beginCheck(db.sql, { userId: USER, taskId: task.id })
    await expect(beginCheck(db.sql, { userId: USER, taskId: task.id })).rejects.toBeInstanceOf(MonitorStateError)
    await endCheck(db.sql, { userId: USER, taskId: task.id, now: at(T0, 1), outcome: { type: 'no_change' } })
    await expect(
      endCheck(db.sql, { userId: USER, taskId: task.id, now: at(T0, 2), outcome: { type: 'no_change' } }),
    ).rejects.toThrow('only CHECKING')
  })

  it('provider failures degrade CHECKING -> DEGRADED at 2x cadence and survive recovery', async () => {
    const { db, task } = await armedTask() // 30-minute cadence
    await beginCheck(db.sql, { userId: USER, taskId: task.id })
    const degraded = await endCheck(db.sql, {
      userId: USER, taskId: task.id, now: at(T0, 40), outcome: { type: 'provider_failure', consecutiveFailures: 3 },
    })
    expect(degraded.task.monitor_state).toBe('DEGRADED')
    const afterDegrade = await projectionOf(db, task.id)
    expect(afterDegrade.monitor_next_check_at).toBe(at(T0, 100)) // 40 + 30*2
    // Policy itself is untouched — the backoff lives in next_check_at, not in cadence.
    expect(validateMonitorPolicy(afterDegrade.monitor_policy).cadenceMinutes).toBe(30)
    const recovered = await recoverMonitoring(db.sql, { userId: USER, taskId: task.id, now: at(T0, 101) })
    expect(recovered.task.monitor_state).toBe('SCHEDULED')
    expect((await projectionOf(db, task.id)).monitor_next_check_at).toBe(at(T0, 131)) // normal 30 again
    await expect(recoverMonitoring(db.sql, { userId: USER, taskId: task.id, now: at(T0, 132) })).rejects.toThrow('only DEGRADED')
  })
})

/* --------------------------------------------------------------- triggering */

describe('triggerOnce', () => {
  it('returns act only with autoAct, a policy grant, AND a passing scoped grant check', async () => {
    const { db, task } = await armedTask(pricePolicy({ autoAct: true, authorityGrantId: 'grant:price-cap' }))
    const result = await triggerOnce(db.sql, {
      userId: USER, taskId: task.id, now: at(T0, 31),
      evidenceRefs: ['price:obs-1=3800c', 'url:snapshot-9'],
      autoAct: true,
      grantedCheck: () => true,
    })
    expect(result).toEqual({ act: 'act', evidence: ['price:obs-1=3800c', 'url:snapshot-9'] })
    const projection = await projectionOf(db, task.id)
    expect(projection.monitor_state).toBe('TRIGGERED')
    expect(projection.monitor_next_check_at).toBe(null)
  })

  it('falls back to ask-user when the grant check fails', async () => {
    const { db, task } = await armedTask(pricePolicy({ autoAct: true, authorityGrantId: 'grant:price-cap' }))
    const result = await triggerOnce(db.sql, {
      userId: USER, taskId: task.id, now: T0, evidenceRefs: ['price:obs-2=3700c'],
      autoAct: true, grantedCheck: () => false,
    })
    expect(result.act).toBe('ask-user')
  })

  it('never acts without a policy grant — and never even calls the grant check absent auto-act intent', async () => {
    const ungranted = await armedTask(pricePolicy()) // no grant, autoAct false
    let grantCalls = 0
    const result = await triggerOnce(ungranted.db.sql, {
      userId: USER, taskId: ungranted.task.id, now: T0, evidenceRefs: ['slot:open-1'],
      autoAct: true, grantedCheck: () => { grantCalls += 1; return true },
    })
    expect(result.act).toBe('ask-user') // a caller-asserted grant cannot substitute a policy grant
    expect(grantCalls).toBe(0)
    const unasked = await armedTask(pricePolicy({ autoAct: true, authorityGrantId: 'grant:x' }))
    let checks = 0
    const second = await triggerOnce(unasked.db.sql, {
      userId: USER, taskId: unasked.task.id, now: T0, evidenceRefs: ['slot:open-2'],
      autoAct: false, grantedCheck: () => { checks += 1; return true },
    })
    expect(second.act).toBe('ask-user')
    expect(checks).toBe(0)
  })

  it('triggers from CHECKING and DEGRADED, refuses OFF/ENDED and a double trigger', async () => {
    const { db, task } = await armedTask()
    await beginCheck(db.sql, { userId: USER, taskId: task.id })
    await triggerOnce(db.sql, { userId: USER, taskId: task.id, now: T0, evidenceRefs: ['in_stock:true'], autoAct: false, grantedCheck: () => false })
    await expect(
      triggerOnce(db.sql, { userId: USER, taskId: task.id, now: T0, evidenceRefs: ['x'], autoAct: false, grantedCheck: () => false }),
    ).rejects.toThrow('Cannot trigger from TRIGGERED')
    const fresh = fakeTaskDb()
    const off = await createTask(fresh.sql, { userId: USER, request: 'r', persona: 'friend' })
    await expect(
      triggerOnce(fresh.sql, { userId: USER, taskId: off.id, now: T0, evidenceRefs: ['x'], autoAct: false, grantedCheck: () => false }),
    ).rejects.toThrow('Cannot trigger from OFF')
  })
})

/* -------------------------------------------------------------- termination */

describe('endMonitoring', () => {
  it('ENDED is terminal for the monitor and requires a reason', async () => {
    const { db, task } = await armedTask()
    expect((await endMonitoring(db.sql, { userId: USER, taskId: task.id, reason: 'user said stop' })).task.monitor_state).toBe('ENDED')
    const projection = await projectionOf(db, task.id)
    expect(nextCheckDue(projection, at(T0, 9999))).toEqual({ due: false, reason: 'not_scheduled' })
    await expect(endMonitoring(db.sql, { userId: USER, taskId: task.id, reason: 'again' })).rejects.toThrow('already ENDED')
    await expect(beginCheck(db.sql, { userId: USER, taskId: task.id })).rejects.toBeInstanceOf(MonitorStateError)
    await expect(
      endMonitoring(db.sql, { userId: USER, taskId: task.id, reason: '   ' }),
    ).rejects.toBeInstanceOf(MonitorPolicyError)
  })
})

/* ------------------------------------------------------------ orthogonality */

describe('monitoring is orthogonal to execution state', () => {
  it('a full monitor lifecycle never moves projection.state', async () => {
    const { db, task } = await armedTask(pricePolicy({ autoAct: true, authorityGrantId: 'grant:x' }))
    await appendEvent(db.sql, { userId: USER, taskId: task.id, type: 'state_changed', payload: { to: 'RESEARCHING' }, actor: 'alpha' })
    await beginCheck(db.sql, { userId: USER, taskId: task.id })
    await endCheck(db.sql, { userId: USER, taskId: task.id, now: at(T0, 40), outcome: { type: 'provider_failure', consecutiveFailures: 2 } })
    await recoverMonitoring(db.sql, { userId: USER, taskId: task.id, now: at(T0, 101) })
    await triggerOnce(db.sql, { userId: USER, taskId: task.id, now: at(T0, 131), evidenceRefs: ['price:hit'], autoAct: true, grantedCheck: () => true })
    await endMonitoring(db.sql, { userId: USER, taskId: task.id, reason: 'bought elsewhere' })
    const projection = await projectionOf(db, task.id)
    expect(projection.state).toBe('RESEARCHING') // execution state untouched end-to-end
    expect(projection.monitor_state).toBe('ENDED')
    const monitors = await monitorEvents(db, task.id)
    expect(monitors.map((e) => e.payload.state)).toEqual(['SCHEDULED', 'CHECKING', 'DEGRADED', 'SCHEDULED', 'TRIGGERED', 'ENDED'])
    // One event per transition, each namespaced and seq-consistent.
    for (const event of monitors) {
      expect(event.idempotency_key).toBe(`monitor:${task.id}:${event.payload.state}:${event.task_seq}`)
    }
  })
})
