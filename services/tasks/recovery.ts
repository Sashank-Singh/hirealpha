/**
 * Dead-worker recovery and reconciliation triage (beat-instinct plan Phase 0
 * exit: "100% of forced worker terminations recover or enter visible
 * reconciliation"; observability: "reconciliation backlog").
 *
 * A pure scanner + event-emitting triager over the canonical task store. No
 * timers, no SQL beyond what taskStore already exposes, no invented fields:
 * staleness is measured from the task row's `updated_at` only.
 *
 *   - classifyStuck      deterministic verdict from legal state facts.
 *   - sweepTasks         moves stalled EXECUTING/VERIFYING tasks into
 *                        NEEDS_RECONCILIATION with one replay-safe event.
 *   - reconciliationReport  pure backlog rollup for the debug dashboard.
 *   - closeReconciliation   the only exit door out of NEEDS_RECONCILIATION.
 *
 * Doctrine: nothing here ever auto-retries an external side effect. The
 * contract already forbids NEEDS_RECONCILIATION -> EXECUTING; this module adds
 * no path that could be read as "resume work" — the close outcomes route to
 * VERIFYING (evidence re-check, receipts own the rest), HUMAN_TAKEOVER, or
 * CANCELLED, and the report flags any task that violates the rule.
 */
import type { SQL } from 'bun'
import {
  TaskTransitionError,
  type MonitorState,
  type TaskProjection,
  type TaskState,
} from './taskContract'
import {
  TaskNotFoundError,
  appendEvent,
  getTask,
  listTasksForAdmin,
  loadProjection,
  type AppendResult,
  type TaskEventRecord,
  type TaskRecord,
} from './taskStore'
import {
  canAutoRetry,
  findUncertainOps,
  reconciliationNeeded,
  type UncertainOp,
} from './receipts'

/* ------------------------------------------------------------------ verdicts */

export const VERDICT_KINDS = [
  'in-flight',
  'reconcile',
  'unverified',
  'awaiting-user',
  'terminal',
  'idle-monitor',
] as const
export type VerdictKind = (typeof VERDICT_KINDS)[number]

/** A projection plus the row's staleness clock (the only age fact we own). */
export type TimedProjection = TaskProjection & { updated_at: string }

export type StuckThresholds = {
  /** Wall time an EXECUTING task may run before its worker is presumed dead. */
  executingWallMs: number
  /** Wall time a VERIFYING task may wait for any verification before it is presumed dead. */
  verifyStallMs: number
}

export type StuckVerdict = {
  kind: VerdictKind
  /** Stable label for per-reason rollups (never invented state, only facts). */
  reason: string
  age_ms: number
}

/**
 * States the plan treats as done-enough to stop execution. FULFILLED counts:
 * its only forward edge is CLOSED, so no worker is expected to touch it.
 */
const TERMINAL_VERDICT_STATES: readonly TaskState[] = ['FAILED_FINAL', 'CLOSED', 'CANCELLED', 'FULFILLED']
const LIVE_MONITOR_STATES: readonly MonitorState[] = ['SCHEDULED', 'CHECKING', 'DEGRADED']
const AWAITING_USER_STATES: readonly TaskState[] = ['WAITING_FOR_AUTHORITY', 'PAUSED_BY_USER', 'HUMAN_TAKEOVER']

function epochMs(value: string | number): number {
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : 0
}

/** Age from `updated_at` only. A corrupt timestamp reads as 0 and can never stall. */
function ageFromUpdatedAt(now: string | number, updatedAt: string): number {
  const then = Date.parse(updatedAt)
  if (!Number.isFinite(then)) return 0
  return Math.max(0, epochMs(now) - then)
}

/**
 * Pure verdict. Order matters only where facts are mutually exclusive; every
 * state lands in exactly one lane, and an unparseable `updated_at` reads as
 * age 0 so a corrupt timestamp can never manufacture a reconcile verdict.
 */
export function classifyStuck(
  projection: TimedProjection,
  now: string | number,
  thresholds: StuckThresholds,
): StuckVerdict {
  const ageMs = ageFromUpdatedAt(now, projection.updated_at)
  const verdict = (kind: VerdictKind, reason: string): StuckVerdict => ({ kind, reason, age_ms: ageMs })

  if (TERMINAL_VERDICT_STATES.includes(projection.state)) {
    // Done, but a live monitor means the task still wakes up periodically.
    return LIVE_MONITOR_STATES.includes(projection.monitor_state)
      ? verdict('idle-monitor', 'monitor_live')
      : verdict('terminal', 'terminal')
  }
  if (projection.state === 'NEEDS_RECONCILIATION') {
    return verdict('reconcile', 'already_reconciling')
  }
  if (projection.state === 'EXECUTING') {
    return ageMs > thresholds.executingWallMs
      ? verdict('reconcile', 'executing_stalled')
      : verdict('in-flight', 'in_flight')
  }
  if (projection.state === 'VERIFYING') {
    if (projection.verification?.passed === false) return verdict('unverified', 'verification_failed')
    if (projection.verification === null && ageMs > thresholds.verifyStallMs) {
      return verdict('reconcile', 'verifying_stalled')
    }
    return verdict('in-flight', 'in_flight')
  }
  if (AWAITING_USER_STATES.includes(projection.state)) return verdict('awaiting-user', 'awaiting_user')
  return verdict('in-flight', 'in_flight')
}

/* --------------------------------------------------------------------- sweep */

export type SweepInput = {
  /** Restrict to these users; null/omitted sweeps the whole admin listing. */
  userIds?: string[] | null
  now: string | number
  executingWallMs: number
  verifyStallMs: number
  actor: string
  limit?: number
}

export type MarkedTask = {
  taskId: string
  userId: string
  eventId: string
  idempotencyKey: string
}

export type SweepResult = {
  scanned: number
  marked: MarkedTask[]
  alreadyReconciling: number
  byVerdict: Record<VerdictKind, number>
}

/**
 * One pass of the reconciliation sweeper. Each stalled task gets exactly ONE
 * state_changed -> NEEDS_RECONCILIATION with reason_code 'needs_reconciliation'
 * and idempotency key `reconcile:${taskId}:${seq}` (seq = event_seq at read
 * time), so a crashed-and-restarted sweep replays safely and never
 * double-marks. A concurrent move that makes the transition illegal surfaces
 * the store's TaskTransitionError honestly instead of being swallowed.
 */
export async function sweepTasks(sql: SQL, input: SweepInput): Promise<SweepResult> {
  if (!input.actor?.trim()) throw new Error('sweepTasks requires an actor.')
  const userIds: Array<string | null> =
    input.userIds && input.userIds.length > 0 ? [...input.userIds] : [null]

  const rows: TaskRecord[] = []
  for (const userId of userIds) {
    rows.push(...(await listTasksForAdmin(sql, { userId, limit: input.limit })))
  }

  const byVerdict: Record<VerdictKind, number> = {
    'in-flight': 0,
    reconcile: 0,
    unverified: 0,
    'awaiting-user': 0,
    terminal: 0,
    'idle-monitor': 0,
  }
  const marked: MarkedTask[] = []
  let scanned = 0
  let alreadyReconciling = 0

  for (const record of rows) {
    const projection = await loadProjection(sql, { userId: record.user_id, taskId: record.id })
    if (!projection) continue
    scanned += 1
    const verdict = classifyStuck(
      { ...projection, updated_at: record.updated_at },
      input.now,
      { executingWallMs: input.executingWallMs, verifyStallMs: input.verifyStallMs },
    )
    byVerdict[verdict.kind] += 1
    if (verdict.kind !== 'reconcile') continue
    if (record.state === 'NEEDS_RECONCILIATION') {
      alreadyReconciling += 1
      continue
    }
    const idempotencyKey = `reconcile:${record.id}:${record.event_seq}`
    const result = await appendEvent(sql, {
      userId: record.user_id,
      taskId: record.id,
      type: 'state_changed',
      payload: { to: 'NEEDS_RECONCILIATION', reason_code: 'needs_reconciliation' },
      actor: input.actor,
      idempotencyKey,
    })
    if (result.replayed) {
      alreadyReconciling += 1
    } else {
      marked.push({ taskId: record.id, userId: record.user_id, eventId: result.event.event_id, idempotencyKey })
    }
  }
  return { scanned, marked, alreadyReconciling, byVerdict }
}

/* -------------------------------------------------------------------- report */

export type ReportedProjection = TimedProjection & { task_id: string }

export type UncertainEntry = { task_id: string; ops: UncertainOp[] }

export type ReconciliationReport = {
  now_ms: number
  /** Tasks receipts already routed to reconciliation (failed or parked). */
  backlog_size: number
  oldest_age_ms: number | null
  per_reason: Record<string, number>
  /** The plan's "outcome unknown, checking before retrying" set. */
  uncertain_ops_in_reconciliation: UncertainEntry[]
  /**
   * Should be zero. A task whose external side effects are unconfirmed
   * (canAutoRetry false) must never sit in the retry lane — FAILED_RETRYABLE
   * is a state a retry loop is allowed to pick up again, which is exactly the
   * forbidden automatic retry after an uncertain side effect. Anything found
   * here is a doctrine break and must be reconciled, not retried.
   */
  retry_lane_violations: UncertainEntry[]
}

const RETRY_LANE_STATES: readonly TaskState[] = ['FAILED_RETRYABLE']

/** Pure rollup of the reconciliation backlog for the observability metric. */
export function reconciliationReport(
  projections: ReportedProjection[],
  options: { now: string | number },
): ReconciliationReport {
  const nowMs = epochMs(options.now)
  const per_reason: Record<string, number> = {}
  const uncertain_ops_in_reconciliation: UncertainEntry[] = []
  const retry_lane_violations: UncertainEntry[] = []
  let backlogSize = 0
  let oldestAgeMs: number | null = null

  for (const projection of projections) {
    const ageMs = ageFromUpdatedAt(options.now, projection.updated_at)
    if (reconciliationNeeded(projection)) {
      backlogSize += 1
      oldestAgeMs = oldestAgeMs === null ? ageMs : Math.max(oldestAgeMs, ageMs)
      const reason =
        projection.state === 'NEEDS_RECONCILIATION'
          ? projection.failure?.reason_code?.trim() || 'needs_reconciliation'
          : 'verification_failed'
      per_reason[reason] = (per_reason[reason] ?? 0) + 1
    }
    const ops = findUncertainOps(projection)
    if (ops.length === 0) continue
    if (projection.state === 'NEEDS_RECONCILIATION') {
      uncertain_ops_in_reconciliation.push({ task_id: projection.task_id, ops })
    }
    if (!canAutoRetry(projection) && RETRY_LANE_STATES.includes(projection.state)) {
      retry_lane_violations.push({ task_id: projection.task_id, ops })
    }
  }

  return {
    now_ms: nowMs,
    backlog_size: backlogSize,
    oldest_age_ms: oldestAgeMs,
    per_reason,
    uncertain_ops_in_reconciliation,
    retry_lane_violations,
  }
}

/* --------------------------------------------------------------------- close */

export const RECONCILIATION_OUTCOMES = ['verified', 'cancelled', 'takeover'] as const
export type ReconciliationOutcome = (typeof RECONCILIATION_OUTCOMES)[number]

export type CloseReconciliationInput = {
  userId: string
  taskId: string
  outcome: ReconciliationOutcome
  actor: string
  note?: string | null
}

export type CloseReconciliationResult = {
  task: TaskRecord
  /** Every event appended, in order (trail first, state move last). */
  events: TaskEventRecord[]
}

/**
 * The only exit from NEEDS_RECONCILIATION that this module offers:
 *   verified  -> VERIFYING (re-check evidence; receipts/finish own the rest)
 *   takeover  -> HUMAN_TAKEOVER
 *   cancelled -> CANCELLED
 * The contract enforces these edges; a task in any other state is rejected
 * with TaskTransitionError before anything is written. Trail + move share one
 * deterministic idempotency prefix derived from event_seq, so a replayed
 * close cannot double-append — and the second close fails the state check
 * anyway, because the first already moved the task out.
 */
export async function closeReconciliation(
  sql: SQL,
  input: CloseReconciliationInput,
): Promise<CloseReconciliationResult> {
  if (!input.userId) throw new Error('closeReconciliation requires userId.')
  if (!input.taskId) throw new Error('closeReconciliation requires taskId.')
  if (!input.actor?.trim()) throw new Error('closeReconciliation requires an actor.')
  if (!RECONCILIATION_OUTCOMES.includes(input.outcome)) {
    throw new Error(`Unknown reconciliation outcome: ${String(input.outcome)}`)
  }
  const record = await getTask(sql, { userId: input.userId, taskId: input.taskId })
  if (!record) throw new TaskNotFoundError()
  if (record.state !== 'NEEDS_RECONCILIATION') {
    throw new TaskTransitionError(
      `closeReconciliation only applies to NEEDS_RECONCILIATION tasks; task ${record.id} is ${record.state}.`,
    )
  }

  const base = `reconcile-close:${record.id}:${record.event_seq}`
  const note = input.note?.trim() || null
  const events: TaskEventRecord[] = []
  const append = async (
    type: 'artifact_recorded' | 'failure_recorded' | 'state_changed',
    payload: Record<string, unknown>,
    suffix: string,
  ): Promise<AppendResult> => {
    const result = await appendEvent(sql, {
      userId: input.userId,
      taskId: input.taskId,
      type,
      payload,
      actor: input.actor,
      idempotencyKey: `${base}:${suffix}`,
    })
    events.push(result.event)
    return result
  }

  if (input.outcome === 'verified') {
    await append('artifact_recorded', { kind: 'reconciliation_outcome', ref: 'verified' }, 'trail')
    if (note) await append('artifact_recorded', { kind: 'reconciliation_note', ref: note.slice(0, 2000) }, 'note')
    const moved = await append('state_changed', { to: 'VERIFYING' }, 'state')
    return { task: moved.task, events }
  }
  if (input.outcome === 'takeover') {
    await append(
      'failure_recorded',
      { reason_code: 'human_takeover_required', detail: note ?? 'Reconciliation closed with human takeover.' },
      'trail',
    )
    const moved = await append('state_changed', { to: 'HUMAN_TAKEOVER', reason_code: 'human_takeover_required' }, 'state')
    return { task: moved.task, events }
  }
  await append(
    'failure_recorded',
    { reason_code: 'needs_reconciliation', detail: note ?? 'Reconciliation closed by cancellation.' },
    'trail',
  )
  const moved = await append('state_changed', { to: 'CANCELLED', reason_code: 'needs_reconciliation' }, 'state')
  return { task: moved.task, events }
}
