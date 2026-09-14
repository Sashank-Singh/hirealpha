/**
 * Canonical task store (beat-instinct plan: append-only task_events stream +
 * versioned tasks projection). Writers use optimistic concurrency against the
 * task version; duplicate callbacks reuse idempotency keys; projections can be
 * rebuilt deterministically from the stream. Every lookup is scoped by user.
 *
 * No production consumer wires this in yet: the task engine adopts it behind a
 * flag in Phase 1, so shipping the table + library is inert.
 */
import type { SQL } from 'bun'
import { randomUUID } from 'node:crypto'
import {
  assertNoSecretKeys,
  assertTransition,
  parseEventInput,
  reduce,
  seedProjection,
  type MonitorState,
  type TaskEventInput,
  type TaskEventType,
  type TaskProjection,
  type TaskState,
} from '../tasks/taskContract'

export class TaskNotFoundError extends Error {
  constructor() {
    super('Task not found.')
  }
}

export class TaskVersionConflictError extends Error {
  constructor(taskId: string) {
    super(`Task ${taskId} changed concurrently; re-read and retry the append.`)
  }
}

export type TaskRecord = {
  id: string
  user_id: string
  persona: string
  conversation_id: string | null
  request: string
  state: TaskState
  resumed_state: TaskState | null
  monitor_state: MonitorState
  plan_version: number
  version: number
  event_seq: number
  created_at: string
  updated_at: string
}

export type TaskEventRecord = {
  event_id: string
  task_id: string
  user_id: string
  schema_version: number
  type: TaskEventType
  actor: string
  causation_id: string | null
  correlation_id: string | null
  idempotency_key: string | null
  occurred_at: string
  task_seq: number
  payload: Record<string, unknown>
}

type Row = Record<string, unknown>

function text(value: unknown): string {
  return typeof value === 'string' ? value : String(value ?? '')
}

function nullableText(value: unknown): string | null {
  return value === null || value === undefined ? null : text(value)
}

function int(value: unknown): number {
  const n = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(n) ? Math.trunc(n) : 0
}

/** Bun parses jsonb; hand-written fakes may store strings. Accept both. */
function json<T>(value: unknown, fallback: T): T {
  if (value === null || value === undefined) return fallback
  if (typeof value === 'string') {
    try {
      return JSON.parse(value) as T
    } catch {
      return fallback
    }
  }
  return value as T
}

function taskFromRow(row: Row): TaskRecord {
  return {
    id: text(row.id),
    user_id: text(row.user_id),
    persona: text(row.persona),
    conversation_id: nullableText(row.conversation_id),
    request: text(row.request),
    state: text(row.state) as TaskState,
    resumed_state: row.resumed_state == null ? null : (text(row.resumed_state) as TaskState),
    monitor_state: text(row.monitor_state) as MonitorState,
    plan_version: int(row.plan_version),
    version: int(row.version),
    event_seq: int(row.event_seq),
    created_at: text(row.created_at),
    updated_at: text(row.updated_at),
  }
}

function eventFromRow(row: Row): TaskEventRecord {
  return {
    event_id: text(row.event_id),
    task_id: text(row.task_id),
    user_id: text(row.user_id),
    schema_version: int(row.schema_version),
    type: text(row.type) as TaskEventType,
    actor: text(row.actor),
    causation_id: nullableText(row.causation_id),
    correlation_id: nullableText(row.correlation_id),
    idempotency_key: nullableText(row.idempotency_key),
    occurred_at: text(row.occurred_at),
    task_seq: int(row.task_seq),
    payload: json<Record<string, unknown>>(row.payload, {}),
  }
}

/** Full queryable projection of a hire_tasks row (the readable task truth). */
function projectionFromRow(row: Row): TaskProjection {
  return {
    request: text(row.request),
    persona: text(row.persona),
    conversation_id: nullableText(row.conversation_id),
    constraints: json(row.constraints, {}),
    state: text(row.state) as TaskState,
    resumed_state: row.resumed_state == null ? null : (text(row.resumed_state) as TaskState),
    monitor_state: text(row.monitor_state) as MonitorState,
    monitor_policy: json<unknown>(row.monitor_policy, null),
    monitor_next_check_at: nullableText(row.monitor_next_check_at),
    plan_version: int(row.plan_version),
    plan: json<unknown>(row.plan, null),
    current_step: json<unknown>(row.current_step, null),
    options: json(row.options, []),
    selected_option_id: nullableText(row.selected_option_id),
    grants: json(row.grants, []),
    external_ops: json(row.external_ops, []),
    artifacts: json(row.artifacts, []),
    verification: json<TaskProjection['verification']>(row.verification, null),
    sync_state: json(row.sync_state, {}),
    failure: json<TaskProjection['failure']>(row.failure, null),
  }
}

export type CreateTaskInput = {
  userId: string
  request: string
  persona?: string
  conversationId?: string | null
}

export async function createTask(sql: SQL, input: CreateTaskInput): Promise<TaskRecord> {
  const request = input.request?.trim()
  if (!request) throw new Error('Task request must be a non-empty string.')
  return sql.begin(async (tx) => {
    const rows = (await tx`
      INSERT INTO hire_tasks (user_id, persona, conversation_id, request)
      VALUES (${input.userId}, ${input.persona ?? 'friend'}, ${input.conversationId ?? null}, ${request})
      RETURNING *
    `) as Row[]
    const row = rows[0]
    if (!row) throw new TaskNotFoundError()
    const created = parseEventInput({
      type: 'task_created',
      payload: { request, persona: input.persona ?? 'friend', conversation_id: input.conversationId ?? null },
    })
    await tx`
      INSERT INTO hire_task_events (event_id, task_id, user_id, type, actor, payload, task_seq)
      VALUES (${randomUUID()}, ${row.id}, ${input.userId}, ${created.type}, ${'system'},
              ${created.payload as never}::jsonb, ${1})
    `
    const updated = (await tx`
      UPDATE hire_tasks
      SET version = 1, event_seq = 1, updated_at = now()
      WHERE id = ${row.id} AND version = 0
      RETURNING *
    `) as Row[]
    return taskFromRow(updated[0] ?? row)
  })
}

export type AppendEventInput = {
  userId: string
  taskId: string
  type: TaskEventType
  payload: unknown
  actor: string
  /** Optional writer's view of the current version; append fails if stale. */
  expectedVersion?: number
  idempotencyKey?: string | null
  causationId?: string | null
  correlationId?: string | null
}

export type AppendResult = {
  task: TaskRecord
  event: TaskEventRecord
  /** True when an existing event with the same idempotency key was returned. */
  replayed: boolean
}

export async function appendEvent(sql: SQL, input: AppendEventInput): Promise<AppendResult> {
  if (!input.userId) throw new Error('appendEvent requires userId.')
  if (!input.taskId) throw new Error('appendEvent requires taskId.')
  if (!input.actor?.trim()) throw new Error('appendEvent requires an actor.')
  // Scan the RAW payload for secret values before normalization can drop keys,
  // then validate the contract — bad writes never touch the database.
  assertNoSecretKeys(input.payload)
  const event = parseEventInput({ type: input.type, payload: input.payload })

  return sql.begin(async (tx) => {
    const rows = (await tx`
      SELECT * FROM hire_tasks WHERE id = ${input.taskId} AND user_id = ${input.userId} FOR UPDATE
    `) as Row[]
    const row = rows[0]
    if (!row) throw new TaskNotFoundError()

    if (input.idempotencyKey) {
      const prior = (await tx`
        SELECT * FROM hire_task_events
        WHERE task_id = ${input.taskId} AND idempotency_key = ${input.idempotencyKey}
        LIMIT 1
      `) as Row[]
      if (prior[0]) return { task: taskFromRow(row), event: eventFromRow(prior[0]), replayed: true }
    }

    if (input.expectedVersion !== undefined && int(row.version) !== input.expectedVersion) {
      throw new TaskVersionConflictError(input.taskId)
    }

    const projection = projectionFromRow(row)
    if (event.type === 'state_changed') {
      assertTransition(projection.state, event.payload.to, projection, event.payload)
    }
    const next = reduce(projection, event)

    const seq = int(row.event_seq) + 1
    const eventId = randomUUID()
    const inserted = (await tx`
      INSERT INTO hire_task_events (
        event_id, task_id, user_id, type, actor,
        causation_id, correlation_id, idempotency_key, payload, task_seq
      ) VALUES (
        ${eventId}, ${input.taskId}, ${input.userId}, ${event.type}, ${input.actor},
        ${input.causationId ?? null}, ${input.correlationId ?? null}, ${input.idempotencyKey ?? null},
        ${event.payload as never}, ${seq}
      )
      RETURNING *
    `) as Row[]

    const updated = (await tx`
      UPDATE hire_tasks
      SET state = ${next.state},
          resumed_state = ${next.resumed_state},
          constraints = ${next.constraints as never}::jsonb,
          monitor_state = ${next.monitor_state},
          monitor_policy = ${next.monitor_policy as never}::jsonb,
          monitor_next_check_at = ${next.monitor_next_check_at},
          plan_version = ${next.plan_version},
          plan = ${next.plan as never}::jsonb,
          current_step = ${next.current_step as never}::jsonb,
          options = ${next.options as never}::jsonb,
          selected_option_id = ${next.selected_option_id},
          grants = ${next.grants as never}::jsonb,
          external_ops = ${next.external_ops as never}::jsonb,
          artifacts = ${next.artifacts as never}::jsonb,
          verification = ${next.verification as never}::jsonb,
          sync_state = ${next.sync_state as never}::jsonb,
          failure = ${next.failure as never}::jsonb,
          version = version + 1,
          event_seq = ${seq},
          updated_at = now()
      WHERE id = ${input.taskId} AND user_id = ${input.userId} AND version = ${int(row.version)}
      RETURNING *
    `) as Row[]
    if (!updated[0]) throw new TaskVersionConflictError(input.taskId)

    return { task: taskFromRow(updated[0]), event: eventFromRow(inserted[0] ?? { ...inserted0Fallback(eventId, input, event, seq) }), replayed: false }
  })
}

function inserted0Fallback(
  eventId: string,
  input: AppendEventInput,
  event: TaskEventInput,
  seq: number,
): Record<string, unknown> {
  // Only reached by SQL drivers/fakes that do not support RETURNING on INSERT.
  return {
    event_id: eventId,
    task_id: input.taskId,
    user_id: input.userId,
    schema_version: 1,
    type: event.type,
    actor: input.actor,
    causation_id: input.causationId ?? null,
    correlation_id: input.correlationId ?? null,
    idempotency_key: input.idempotencyKey ?? null,
    task_seq: seq,
    payload: event.payload,
  }
}

export async function getTask(sql: SQL, input: { userId: string; taskId: string }): Promise<TaskRecord | null> {
  const rows = (await sql`
    SELECT * FROM hire_tasks WHERE id = ${input.taskId} AND user_id = ${input.userId} LIMIT 1
  `) as Row[]
  return rows[0] ? taskFromRow(rows[0]) : null
}

/** The current queryable state (projection row) for one user's task. */
export async function loadProjection(sql: SQL, input: { userId: string; taskId: string }): Promise<TaskProjection | null> {
  const rows = (await sql`
    SELECT * FROM hire_tasks WHERE id = ${input.taskId} AND user_id = ${input.userId} LIMIT 1
  `) as Row[]
  return rows[0] ? projectionFromRow(rows[0]) : null
}

export async function listEvents(
  sql: SQL,
  input: { userId: string; taskId: string; afterSeq?: number; limit?: number },
): Promise<TaskEventRecord[]> {
  const rows = (await sql`
    SELECT * FROM hire_task_events
    WHERE task_id = ${input.taskId} AND user_id = ${input.userId} AND task_seq > ${input.afterSeq ?? 0}
    ORDER BY task_seq ASC
    LIMIT ${Math.min(Math.max(input.limit ?? 200, 1), 1000)}
  `) as Row[]
  return rows.map(eventFromRow)
}

/**
 * Rebuild the queryable state by replaying the event stream. Used by chaos
 * tests, checkpoint consumers, and reconciliation tooling.
 */
export async function rebuildProjection(
  sql: SQL,
  input: { userId: string; taskId: string },
): Promise<TaskProjection | null> {
  const events = await listEvents(sql, { ...input, limit: 1000 })
  const created = events[0]
  if (!created || created.type !== 'task_created') return null
  const seed = seedProjection(
    String(created.payload.request ?? ''),
    String(created.payload.persona ?? 'friend'),
    created.payload.conversation_id == null ? null : String(created.payload.conversation_id),
  )
  return events
    .slice(1)
    .reduce<TaskProjection>(
      (projection, event) =>
        reduce(projection, parseEventInput({ type: event.type, payload: event.payload })),
      seed,
    )
}
