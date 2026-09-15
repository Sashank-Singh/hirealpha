/**
 * chaosSupport — shared primitives for services/tasks/chaos.test.ts ONLY.
 * This is not a test file (no bun-test imports) so `bun test` globs never run
 * it standalone; only chaos.test.ts consumes it.
 *
 * The stateful fake below is a COPY of the pattern in taskStore.test.ts
 * (deliberately not imported from there: test-file imports would double-run),
 * extended with exactly three chaos capabilities:
 *
 * 1. failInjection — `db.injection.failOn(queryText)` is consulted BEFORE any
 *    mutation of a matching query; returning true throws ChaosKilledError,
 *    modelling a worker SIGKILL / lost network at that precise write point.
 *
 * 2. Transactional rollback — `sql.begin(cb)` journals every write made inside
 *    the callback (event pushes, row field changes, row inserts) and undoes
 *    them in reverse order if cb throws. This mirrors Postgres ABORT: a killed
 *    append must leave NO half-written event, no orphaned row, and no bumped
 *    version. (taskStore relies on exactly this in production: the event
 *    INSERT and the projection UPDATE live in one sql.begin transaction.)
 *
 * 3. Simulated partial-unique index — the production fence for duplicate
 *    webhooks is the DB partial-unique index `hire_task_events_idempotency`
 *    (see syncGuard.ts: "The database — not reader code — decides the winner").
 *    In this fake it is simulated inside the event INSERT branch: before
 *    pushing, it scans the shared event list for an existing row with the same
 *    (task_id, idempotency_key); a collision throws FenceConflictError and the
 *    losing transaction rolls back. Consequence for concurrent webhook storms:
 *    a loser either sees the committed row via appendEvent's own idempotency
 *    SELECT and returns replayed=true ('duplicate'), or loses the race and
 *    rejects with FenceConflictError. Both mean "not mine; do not re-send".
 *    Exactly one caller can ever land the fence row.
 *
 * Zero deps, zero regex on prose: predicates are substring checks on SQL text
 * only (WRITE_POINTS), never on message/task content.
 */

type Row = Record<string, unknown>

export type FailInjection = { failOn?: (query: string) => boolean }

/** Thrown when db.injection.failOn matches a query: the simulated worker kill. */
export class ChaosKilledError extends Error {
  constructor(point: string) {
    super(`chaos: worker killed before query [${point}]`)
  }
}

/** Thrown by the fake's (task_id, idempotency_key) unique-check on insert. */
export class FenceConflictError extends Error {
  constructor(key: string) {
    super(`chaos fake: unique violation on hire_task_events_idempotency (${key})`)
  }
}

/** Named SQL write points, matched by SQL text only. */
export const WRITE_POINTS: Record<string, (query: string) => boolean> = {
  taskRowInsert: (q) => q.includes('INSERT INTO hire_tasks'),
  createdEventInsert: (q) => q.includes('INSERT INTO hire_task_events') && !q.includes('causation_id'),
  createProjectionBump: (q) => q.includes('UPDATE hire_tasks') && q.includes('SET version = 1'),
  eventInsert: (q) => q.includes('INSERT INTO hire_task_events') && q.includes('causation_id'),
  projectionUpdate: (q) => q.includes('UPDATE hire_tasks') && q.includes('SET state'),
}

function labelFor(query: string): string {
  for (const [name, pred] of Object.entries(WRITE_POINTS)) if (pred(query)) return name
  return 'query'
}

export type ChaosDb = {
  sql: any
  tasks: Map<string, Row>
  events: Row[]
  injection: FailInjection
}

export function chaosDb(injection: FailInjection = {}): ChaosDb {
  const tasks = new Map<string, Row>()
  const events: Row[] = []

  const run = (text: string, values: unknown[], undo: Array<() => void>): Row[] => {
    // --- the injected kill: consulted before ANY mutation of a matching query.
    if (injection.failOn && injection.failOn(text)) throw new ChaosKilledError(labelFor(text))

    const snapshotRow = (row: Row): (() => void) => {
      const snap = { ...row }
      return () => Object.assign(row, snap)
    }

    if (text.includes('INSERT INTO hire_task_events')) {
      if (text.includes('causation_id')) {
        const [eventId, taskId, userId, type, actor, causation, correlation, idemKey, payload, seq] = values
        // Simulated partial-unique hire_task_events_idempotency (see header):
        // a concurrent duplicate claim/replay loses HERE, not in reader code.
        if (idemKey !== null && idemKey !== undefined) {
          const clash = events.find((e) => e.task_id === taskId && e.idempotency_key === idemKey)
          if (clash) throw new FenceConflictError(String(idemKey))
        }
        const row: Row = {
          event_id: eventId, task_id: taskId, user_id: userId, schema_version: 1,
          type, actor, causation_id: causation, correlation_id: correlation,
          idempotency_key: idemKey ?? null, occurred_at: '2026-09-14T00:00:01Z',
          payload, task_seq: seq,
        }
        events.push(row)
        undo.push(() => {
          const i = events.indexOf(row)
          if (i >= 0) events.splice(i, 1)
        })
        return [row]
      }
      const [eventId, taskId, userId, type, actor, payload, seq] = values
      const row: Row = {
        event_id: eventId, task_id: taskId, user_id: userId, schema_version: 1,
        type, actor, causation_id: null, correlation_id: null, idempotency_key: null,
        occurred_at: '2026-09-14T00:00:00Z', payload, task_seq: seq,
      }
      events.push(row)
      undo.push(() => {
        const i = events.indexOf(row)
        if (i >= 0) events.splice(i, 1)
      })
      return [row]
    }
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
      undo.push(() => {
        tasks.delete(String(row.id))
      })
      return [row]
    }
    if (text.includes('UPDATE hire_tasks') && text.includes('SET version = 1')) {
      const row = tasks.get(String(values[0]))
      if (row) {
        undo.push(snapshotRow(row))
        Object.assign(row, { version: 1, event_seq: 1 })
      }
      return row ? [row] : []
    }
    if (text.includes('UPDATE hire_tasks') && text.includes('SET state')) {
      const [
        state, resumed, constraints, monitorState, monitorPolicy, monitorNext,
        planVersion, plan, currentStep, options, selected, grants, ops,
        artifacts, verification, sync, failure, seq, taskId, userId, expectedVersion,
      ] = values
      const row = tasks.get(String(taskId))
      if (!row || row.user_id !== userId || row.version !== expectedVersion) return []
      undo.push(snapshotRow(row))
      Object.assign(row, {
        state, resumed_state: resumed, constraints, monitor_state: monitorState,
        monitor_policy: monitorPolicy, monitor_next_check_at: monitorNext,
        plan_version: planVersion, plan, current_step: currentStep, options,
        selected_option_id: selected, grants, external_ops: ops, artifacts,
        verification, sync_state: sync, failure,
        version: Number(row.version) + 1, event_seq: seq,
      })
      return [row]
    }
    if (text.includes('FROM hire_task_events') && text.includes('idempotency_key =')) {
      const [taskId, idemKey] = values
      return events.filter((e) => e.task_id === taskId && e.idempotency_key === idemKey).slice(0, 1)
    }
    if (text.includes('FROM hire_task_events')) {
      const [taskId, userId, afterSeq] = values
      return events
        .filter((e) => e.task_id === taskId && e.user_id === userId && Number(e.task_seq) > Number(afterSeq))
        .sort((a, b) => Number(a.task_seq) - Number(b.task_seq))
    }
    if (text.includes('FROM hire_tasks') && text.includes('ORDER BY updated_at')) {
      const all = [...tasks.values()]
      if (text.includes('WHERE user_id')) return all.filter((row) => row.user_id === values[0])
      return all
    }
    if (text.includes('FROM hire_tasks')) {
      const [taskId, userId] = values
      const row = tasks.get(String(taskId))
      return row && row.user_id === userId ? [row] : []
    }
    throw new Error(`chaosDb: unmatched query: ${text.slice(0, 140)}`)
  }

  const template = (undoFor: (() => void)[] | null) =>
    (strings: TemplateStringsArray, ...values: unknown[]): Promise<Row[]> => {
      // Journal: begin() aborts by undoing in reverse; committed txs discard.
      const undo: Array<() => void> = undoFor ?? []
      try {
        return Promise.resolve(run(strings.join('?'), values, undo))
      } catch (err) {
        if (!undoFor) for (let i = undo.length - 1; i >= 0; i--) (undo[i] as () => void)()
        return Promise.reject(err)
      }
    }

  const sql = template(null) as any
  sql.begin = async (cb: (tx: any) => Promise<unknown>) => {
    const undo: Array<() => void> = []
    try {
      return await cb(template(undo))
    } catch (err) {
      for (let i = undo.length - 1; i >= 0; i--) (undo[i] as () => void)()
      throw err
    }
  }

  return { sql, tasks, events, injection }
}

/* --------------------------------------------------------------- utilities */

/** Deterministic tiny LCG (no deps, no Math.random): seed -> [0,1) generator. */
export function lcg(seed: number): () => number {
  let s = seed >>> 0
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0
    return s / 4294967296
  }
}

/** Count stored event rows carrying an exact idempotency key. */
export function eventsWithKey(db: ChaosDb, key: string): Row[] {
  return db.events.filter((e) => e.idempotency_key === key)
}

/** Event seqs for one task must be exactly 1..n — gaps/dupes mean lost work. */
export function assertContiguousSeqs(rows: Row[]): void {
  const seqs = rows.map((r) => Number(r.task_seq)).sort((a, b) => a - b)
  for (let i = 0; i < seqs.length; i += 1) {
    if (seqs[i] !== i + 1) throw new Error(`event seqs not contiguous: ${JSON.stringify(seqs)}`)
  }
}
