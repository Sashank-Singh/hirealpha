/**
 * Canonical monitoring policy engine (beat-instinct plan, workstream 5
 * "Calendar, reminders, and monitoring" + Phase 1 backlog "monitoring policies
 * and change propagation"): persist for days, act within policy, report
 * changes.
 *
 * Design constraints honored here:
 *   - Monitoring is ORTHOGONAL to execution state: every transition in this
 *     file is a single `monitor_updated` event; `projection.state` is never
 *     touched (taskContract keeps them on separate fields).
 *   - No timers. A scheduler (built later) calls nextCheckDue()/beginCheck();
 *     this module only persists policy and moves monitor_state.
 *   - No SQL beyond taskStore.appendEvent/getTask/loadProjection.
 *   - "Act within policy": triggerOnce() can return 'act' only when the caller
 *     asserts autoAct, the scheduled policy carries a non-null authorityGrantId,
 *     AND the caller's grantedCheck() (scoped-grant verification) returns true.
 *     Anything less reports 'ask-user' — the codebase's ask-first default.
 *   - Every event carries a namespaced idempotency key
 *     `monitor:<taskId>:<state>:<nextSeq>` derived from the task's current
 *     event_seq, so a retried caller cannot silently re-arm or double-trigger.
 *   - Degrade backoff: a CHECKING -> DEGRADED transition schedules the next
 *     probe at 2x the policy cadence; recovery restores 1x. The stored policy
 *     is never mutated to encode backoff — the doubling lives in
 *     monitor_next_check_at, so the last checked position survives.
 */
import type { SQL } from 'bun'
import {
  TaskNotFoundError,
  appendEvent,
  getTask,
  loadProjection,
  type AppendResult,
} from './taskStore'
import type { TaskProjection } from './taskContract'

export class MonitorPolicyError extends Error {}
export class MonitorStateError extends Error {}

/* ------------------------------------------------------------------ policy */

export type MonitorWatchKind = 'url' | 'price' | 'availability' | 'deadline'
export type MonitorMetric = 'price_cents' | 'in_stock' | 'slot_open' | 'due_at'

export const MIN_CADENCE_MINUTES = 5

export type MonitorCondition = {
  metric: MonitorMetric
  threshold_cents?: number
  due_at?: string
}

export type MonitorPolicy = {
  watch: { kind: MonitorWatchKind; target: string; condition: MonitorCondition }
  cadenceMinutes: number
  stopAt?: string
  authorityGrantId?: string | null
  autoAct: boolean
}

const WATCH_KINDS: readonly MonitorWatchKind[] = ['url', 'price', 'availability', 'deadline']

/** Which metrics each watch kind is allowed to evaluate (junk rejection table). */
const WATCH_METRICS: Record<MonitorWatchKind, readonly MonitorMetric[]> = {
  url: ['price_cents', 'in_stock', 'slot_open', 'due_at'],
  price: ['price_cents'],
  availability: ['in_stock', 'slot_open'],
  deadline: ['due_at'],
}

function asRecord(value: unknown, field: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new MonitorPolicyError(`${field} must be an object.`)
  }
  return value as Record<string, unknown>
}

function asNonEmptyString(value: unknown, field: string, maxLength = 2000): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new MonitorPolicyError(`${field} must be a non-empty string.`)
  }
  return value.trim().slice(0, maxLength)
}

/** ISO timestamps only; prose like "sometime next week" is rejected, never parsed. */
function asIsoTimestamp(value: unknown, field: string): string {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) {
    throw new MonitorPolicyError(`${field} must be a valid ISO-8601 timestamp.`)
  }
  return new Date(value).toISOString()
}

/** Validate + normalize a monitor policy. Throws MonitorPolicyError on junk. */
export function validateMonitorPolicy(input: unknown): MonitorPolicy {
  const p = asRecord(input, 'policy')

  const watch = asRecord(p.watch, 'policy.watch')
  const kind = String(watch.kind ?? '') as MonitorWatchKind
  if (!WATCH_KINDS.includes(kind)) {
    throw new MonitorPolicyError(`policy.watch.kind must be one of: ${WATCH_KINDS.join(', ')}.`)
  }
  const target = asNonEmptyString(watch.target, 'policy.watch.target')
  if (kind === 'url' && !target.startsWith('https://')) {
    throw new MonitorPolicyError('policy.watch.target must be https for url watches.')
  }

  const condition = asRecord(watch.condition, 'policy.watch.condition')
  const metric = String(condition.metric ?? '') as MonitorMetric
  if (!WATCH_METRICS[kind].includes(metric)) {
    throw new MonitorPolicyError(`policy.watch.condition.metric "${String(condition.metric)}" is not valid for watch kind "${kind}".`)
  }
  const normalizedCondition: MonitorCondition = { metric }
  if (metric === 'price_cents') {
    const threshold = condition.threshold_cents
    if (typeof threshold !== 'number' || !Number.isInteger(threshold) || threshold < 0) {
      throw new MonitorPolicyError('policy.watch.condition.threshold_cents must be a non-negative integer for price_cents.')
    }
    normalizedCondition.threshold_cents = threshold
  } else if (condition.threshold_cents !== undefined) {
    const threshold = condition.threshold_cents
    if (typeof threshold !== 'number' || !Number.isInteger(threshold) || threshold < 0) {
      throw new MonitorPolicyError('policy.watch.condition.threshold_cents must be a non-negative integer.')
    }
    normalizedCondition.threshold_cents = threshold
  }
  if (metric === 'due_at') {
    normalizedCondition.due_at = asIsoTimestamp(condition.due_at, 'policy.watch.condition.due_at')
  } else if (condition.due_at !== undefined) {
    normalizedCondition.due_at = asIsoTimestamp(condition.due_at, 'policy.watch.condition.due_at')
  }

  if (typeof p.cadenceMinutes !== 'number' || !Number.isFinite(p.cadenceMinutes)) {
    throw new MonitorPolicyError('policy.cadenceMinutes must be a number.')
  }
  if (p.cadenceMinutes < MIN_CADENCE_MINUTES) {
    throw new MonitorPolicyError(`policy.cadenceMinutes must be at least ${MIN_CADENCE_MINUTES} minutes.`)
  }

  // autoAct defaults to the ask-first posture; when present it must be a true
  // boolean, and true is only schedulable with a scoped grant (checked below).
  const autoAct = p.autoAct === undefined || p.autoAct === null ? false : p.autoAct
  if (autoAct !== false && autoAct !== true) {
    throw new MonitorPolicyError('policy.autoAct must be a boolean.')
  }
  let authorityGrantId: string | null = null
  if (typeof p.authorityGrantId === 'string' && p.authorityGrantId.trim() !== '') {
    authorityGrantId = p.authorityGrantId.trim()
  } else if (p.authorityGrantId !== undefined && p.authorityGrantId !== null) {
    throw new MonitorPolicyError('policy.authorityGrantId must be a non-empty string or null.')
  }
  if (autoAct === true && authorityGrantId === null) {
    throw new MonitorPolicyError('policy.autoAct requires a scoped authorityGrantId; acting without a grant is not schedulable.')
  }

  const policy: MonitorPolicy = {
    watch: { kind, target, condition: normalizedCondition },
    cadenceMinutes: Math.round(p.cadenceMinutes),
    autoAct,
  }
  if (p.stopAt !== undefined && p.stopAt !== null) {
    policy.stopAt = asIsoTimestamp(p.stopAt, 'policy.stopAt')
  }
  if (authorityGrantId !== null) policy.authorityGrantId = authorityGrantId
  return policy
}

/* ------------------------------------------------------------------- clock */

function requireNow(now: unknown): number {
  const ms = now instanceof Date ? now.getTime() : typeof now === 'string' ? Date.parse(now) : NaN
  if (!Number.isFinite(ms)) throw new MonitorStateError('now must be a Date or a valid ISO-8601 timestamp.')
  return ms
}

function isoPlus(nowMs: number, minutes: number): string {
  return new Date(nowMs + Math.round(minutes) * 60_000).toISOString()
}

/** next check = now + cadence, clamped so a final check still lands before stopAt. */
function nextCheckAt(nowMs: number, cadenceMinutes: number, stopAt?: string): string {
  const next = nowMs + cadenceMinutes * 60_000
  if (stopAt) {
    const stopMs = Date.parse(stopAt)
    if (Number.isFinite(stopMs) && stopMs > nowMs && stopMs < next) return new Date(stopMs).toISOString()
  }
  return new Date(next).toISOString()
}

function policyOf(projection: TaskProjection): MonitorPolicy {
  try {
    return validateMonitorPolicy(projection.monitor_policy)
  } catch {
    throw new MonitorStateError('monitor_policy on the task row is not a valid policy; reschedule before checking.')
  }
}

/* ------------------------------------------------------------------- writes */

async function requireProjection(sql: SQL, input: { userId: string; taskId: string }): Promise<TaskProjection> {
  const projection = await loadProjection(sql, { userId: input.userId, taskId: input.taskId })
  if (!projection) throw new TaskNotFoundError()
  return projection
}

/**
 * Append exactly one monitor_updated transition. The idempotency key embeds
 * the state and the seq the event will land on (task.event_seq + 1 read just
 * before the append), i.e. the key names the same seq reported by the append
 * result on a contention-free write.
 */
async function appendMonitor(
  sql: SQL,
  input: {
    userId: string
    taskId: string
    state: 'SCHEDULED' | 'CHECKING' | 'DEGRADED' | 'TRIGGERED' | 'ENDED'
    policy?: MonitorPolicy
    nextCheckAt: string | null
  },
): Promise<AppendResult> {
  const task = await getTask(sql, { userId: input.userId, taskId: input.taskId })
  if (!task) throw new TaskNotFoundError()
  const payload: Record<string, unknown> = { state: input.state, next_check_at: input.nextCheckAt }
  if (input.policy !== undefined) payload.policy = input.policy
  return appendEvent(sql, {
    userId: input.userId,
    taskId: input.taskId,
    type: 'monitor_updated',
    payload,
    actor: 'monitor',
    idempotencyKey: `monitor:${input.taskId}:${input.state}:${task.event_seq + 1}`,
  })
}

/**
 * Persist a policy and arm the first check. Re-arm is refused while a monitor
 * is live (SCHEDULED/CHECKING) unless the caller explicitly passes rearm:true,
 * which appends a fresh SCHEDULED (new policy, new cadence window). DEGRADED,
 * TRIGGERED, ENDED and OFF may all be scheduled over.
 */
export async function scheduleMonitoring(
  sql: SQL,
  input: { userId: string; taskId: string; policy: unknown; now: string | Date; rearm?: boolean },
): Promise<AppendResult> {
  const policy = validateMonitorPolicy(input.policy)
  const nowMs = requireNow(input.now)
  const projection = await requireProjection(sql, input)
  if (!input.rearm && (projection.monitor_state === 'SCHEDULED' || projection.monitor_state === 'CHECKING')) {
    throw new MonitorStateError(
      `Monitoring already ${projection.monitor_state}; refusing to re-arm silently. Pass rearm:true to replace the policy.`,
    )
  }
  return appendMonitor(sql, {
    userId: input.userId,
    taskId: input.taskId,
    state: 'SCHEDULED',
    policy,
    nextCheckAt: nextCheckAt(nowMs, policy.cadenceMinutes, policy.stopAt),
  })
}

/* --------------------------------------------------------------------- due */

export type MonitorDueReason = 'due' | 'not_scheduled' | 'no_next_check' | 'not_due_yet'

/** Why is (or isn't) the monitor due for its next probe at `now`? */
export function nextCheckDue(
  projection: TaskProjection,
  now: string | Date,
): { due: boolean; reason: MonitorDueReason } {
  if (projection.monitor_state !== 'SCHEDULED') return { due: false, reason: 'not_scheduled' }
  if (!projection.monitor_next_check_at) return { due: false, reason: 'no_next_check' }
  const dueMs = Date.parse(projection.monitor_next_check_at)
  const nowMs = requireNow(now)
  if (!Number.isFinite(dueMs)) return { due: false, reason: 'no_next_check' }
  return dueMs <= nowMs ? { due: true, reason: 'due' } : { due: false, reason: 'not_due_yet' }
}

export function isCheckDue(projection: TaskProjection, now: string | Date): boolean {
  return nextCheckDue(projection, now).due
}

/* ------------------------------------------------------------- check cycle */

/** SCHEDULED -> CHECKING (one event). Only an armed monitor may begin. */
export async function beginCheck(sql: SQL, input: { userId: string; taskId: string }): Promise<AppendResult> {
  const projection = await requireProjection(sql, input)
  if (projection.monitor_state !== 'SCHEDULED') {
    throw new MonitorStateError(`Cannot begin a check from ${projection.monitor_state}; only SCHEDULED may check.`)
  }
  return appendMonitor(sql, { userId: input.userId, taskId: input.taskId, state: 'CHECKING', nextCheckAt: null })
}

export type CheckOutcome =
  /** Provider answered, watched value unchanged -> re-arm at normal cadence. */
  | { type: 'no_change' }
  /** Provider failed (consecutive failures reported by the scheduler) -> back off 2x. */
  | { type: 'provider_failure'; consecutiveFailures?: number }

/**
 * CHECKING -> SCHEDULED on no-change (next = now + cadence) or
 * CHECKING -> DEGRADED on reported provider failures (next = now + 2x
 * cadence; the policy's cadenceMinutes survive untouched, so the backoff is
 * per-degrade and recovery restores the normal window).
 */
export async function endCheck(
  sql: SQL,
  input: { userId: string; taskId: string; now: string | Date; outcome: CheckOutcome },
): Promise<AppendResult> {
  const nowMs = requireNow(input.now)
  if (input.outcome === null || typeof input.outcome !== 'object' || !('type' in input.outcome)) {
    throw new MonitorStateError('endCheck requires an outcome of { type: "no_change" } or { type: "provider_failure" }.')
  }
  const projection = await requireProjection(sql, input)
  if (projection.monitor_state !== 'CHECKING') {
    throw new MonitorStateError(`Cannot end a check from ${projection.monitor_state}; only CHECKING may end.`)
  }
  const policy = policyOf(projection)
  if (input.outcome.type === 'provider_failure') {
    return appendMonitor(sql, {
      userId: input.userId,
      taskId: input.taskId,
      state: 'DEGRADED',
      nextCheckAt: isoPlus(nowMs, policy.cadenceMinutes * 2),
    })
  }
  if (input.outcome.type !== 'no_change') {
    throw new MonitorStateError(`Unknown check outcome: ${String((input.outcome as { type: string }).type)}`)
  }
  return appendMonitor(sql, {
    userId: input.userId,
    taskId: input.taskId,
    state: 'SCHEDULED',
    nextCheckAt: nextCheckAt(nowMs, policy.cadenceMinutes, policy.stopAt),
  })
}

/** DEGRADED -> SCHEDULED on recovered provider health, at the normal cadence. */
export async function recoverMonitoring(
  sql: SQL,
  input: { userId: string; taskId: string; now: string | Date },
): Promise<AppendResult> {
  const nowMs = requireNow(input.now)
  const projection = await requireProjection(sql, input)
  if (projection.monitor_state !== 'DEGRADED') {
    throw new MonitorStateError(`Cannot recover from ${projection.monitor_state}; only DEGRADED recovers.`)
  }
  const policy = policyOf(projection)
  return appendMonitor(sql, {
    userId: input.userId,
    taskId: input.taskId,
    state: 'SCHEDULED',
    nextCheckAt: nextCheckAt(nowMs, policy.cadenceMinutes, policy.stopAt),
  })
}

/* ----------------------------------------------------------------- trigger */

export type TriggerResult = { act: 'act' | 'ask-user'; evidence: string[] }

/**
 * A change was observed: move SCHEDULED/CHECKING/DEGRADED -> TRIGGERED (one
 * event) and decide, purely, whether the engine may act or must ask the user.
 * 'act' requires ALL of: caller asserts autoAct, the scheduled policy carries an
 * authorityGrantId, and grantedCheck() — the caller's scoped-grant verification
 * — returns true. Any doubt reports 'ask-user'; the evidence references ride
 * along for the message the scheduler sends.
 */
export async function triggerOnce(
  sql: SQL,
  input: {
    userId: string
    taskId: string
    now: string | Date
    evidenceRefs: string[]
    autoAct: boolean
    grantedCheck: () => boolean
  },
): Promise<TriggerResult> {
  requireNow(input.now)
  if (!Array.isArray(input.evidenceRefs) || input.evidenceRefs.some((e) => typeof e !== 'string' || e.trim() === '')) {
    throw new MonitorStateError('triggerOnce requires evidenceRefs: an array of non-empty references.')
  }
  if (typeof input.grantedCheck !== 'function') {
    throw new MonitorStateError('triggerOnce requires a grantedCheck callback.')
  }
  const projection = await requireProjection(sql, input)
  if (projection.monitor_state !== 'SCHEDULED' && projection.monitor_state !== 'CHECKING' && projection.monitor_state !== 'DEGRADED') {
    throw new MonitorStateError(`Cannot trigger from ${projection.monitor_state}; only SCHEDULED, CHECKING or DEGRADED may trigger.`)
  }
  let grantAnchored = false
  try {
    grantAnchored = policyOf(projection).authorityGrantId != null
  } catch {
    grantAnchored = false
  }
  // Short-circuit: never invoke the grant check when the caller has no
  // auto-act intent or the policy was never granted one.
  const act = input.autoAct === true && grantAnchored && input.grantedCheck() === true
  await appendMonitor(sql, {
    userId: input.userId,
    taskId: input.taskId,
    state: 'TRIGGERED',
    nextCheckAt: null,
  })
  return { act: act ? 'act' : 'ask-user', evidence: [...input.evidenceRefs] }
}

/**
 * ENDED is terminal for monitoring (execution state untouched). A new
 * scheduleMonitoring() afterwards is a fresh, explicit monitoring lifecycle,
 * but no check/trigger/recover transition may follow an end.
 */
export async function endMonitoring(
  sql: SQL,
  input: { userId: string; taskId: string; reason: string },
): Promise<AppendResult> {
  const reason = asNonEmptyString(input.reason, 'endMonitoring reason')
  const projection = await requireProjection(sql, input)
  if (projection.monitor_state === 'ENDED') {
    throw new MonitorStateError(`Monitoring already ENDED (${reason} cannot end an ended monitor).`)
  }
  return appendMonitor(sql, { userId: input.userId, taskId: input.taskId, state: 'ENDED', nextCheckAt: null })
}
