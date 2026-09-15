/**
 * P0 "day-one dashboards" (beat-instinct plan). Pure aggregate over the raw
 * internal endpoints' data: the caller fetches rows via
 * /api/internal/tasks (listTasksForAdmin) + loadProjection and feeds them to
 * buildOpsSnapshot. No SQL, no deps, no clocks injected from the environment.
 *
 * Doctrine: never fake a metric. Anything the projection cannot honestly
 * observe is exposed as 'not-instrumented' or with explicit
 * numerator/denominator + a documented basis, not an invented number.
 */
import type { MonitorState, TaskProjection, TaskState } from './taskContract'
import { MONITOR_STATES, TASK_STATES, TERMINAL_STATES } from './taskContract'
import type { TaskRecord } from './taskStore' // type-only: erased, no runtime dep

export type OpsSnapshotInput = { task: TaskRecord; projection: TaskProjection }

export type OpsSnapshotOptions = {
  /** "Now": epoch ms or ISO string. */
  now: number | string
  /** Rolling window for outcomes/overdue. Default 24h. */
  windowMs?: number
}

export const DEFAULT_WINDOW_MS = 24 * 60 * 60_000 // day-one ops view: 24 hours

const OUTCOME_STATES: readonly TaskState[] = [...TERMINAL_STATES, 'FULFILLED']
const VERIFIED_STATES: readonly TaskState[] = ['FULFILLED', 'CLOSED']
const OVERDUE_CAP = 20
const ID_CAP = 20

/** Artifact kinds the reducer writes for credential/payment handoffs (taskContract.reduce). */
const HANDOFF_REQUEST_PREFIX = 'handoff:'
const HANDOFF_RESUME_PREFIX = 'handoff_resumed:'

export type OpsOverdueEntry = { id: string; state: TaskState; ageMinutes: number }
export type OpsFailureReason = { reason_code: string; count: number }
export type OpsUserLoad = { user_id: string; unfinished: number }
export type OpsHandoffKind = { kind: string; requested: number; resumed: number }
export type OpsCategoryOutcome = { finished: number; verified: number; verifiedRate: number | null }

export type OpsSnapshot = {
  schema: 'ops-snapshot.v1'
  generated_at: string
  window_ms: number
  window_start: string
  totals: { tasks: number }
  /** Zero-filled for every TASK_STATES key so charts cannot lie by omission. */
  byState: Record<TaskState, number>
  /** Zero-filled for every MONITOR_STATES key. */
  byMonitorState: Record<MonitorState, number>
  age: {
    nonTerminal: number
    under10m: number
    to10to60m: number
    over60m: number
    /** Non-terminal rows whose updated_at did not parse; excluded from buckets. */
    unparseableTimestamp: number
  }
  /** Non-terminal tasks stuck in their current state longer than windowMs, capped. */
  overdue: OpsOverdueEntry[]
  overdueTotal: number
  outcomes: {
    /** Terminal + FULFILLED tasks whose updated_at falls inside the window. */
    finished: number
    verified: number
    verifiedRate: number | null
    /** Headline trust number: CLOSED without verification.passed === true. */
    falseCompletions: number
    falseCompletionIds: string[]
    needsReconciliationBacklog: number
    awaitingUser: {
      total: number
      byState: {
        PAUSED_BY_USER: number
        HUMAN_TAKEOVER: number
        WAITING_FOR_AUTHORITY: number
        WAITING_FOR_SELECTION: number
      }
    }
    /** Verified-outcome rate by task persona (the plan's "category"). */
    byCategory: Array<OpsCategoryOutcome & { category: string }>
  }
  /**
   * Credential/payment handoff resume. Denominator: tasks with >=1
   * `handoff:<kind>` artifact. Numerator: a later `handoff_resumed:<kind>`
   * artifact OR the task currently sits in EXECUTING (the handoff was walked
   * back and work continued). Numerator/denominator are exposed, not just a
   * rate — the current-state clause is an approximation, see basis.
   */
  handoffResume: {
    tasksRequested: number
    tasksResumed: number
    rate: number | null
    byKind: OpsHandoffKind[]
    basis: string
  }
  /**
   * Intervention/takeover share of all fetched tasks. Basis is the visible
   * projection only: currently HUMAN_TAKEOVER or any handoff artifact ever
   * recorded. Historical takeovers that already resumed to EXECUTING are
   * counted via the handoff artifacts; pure state churn is invisible.
   */
  interventions: {
    tasks: number
    intervened: number
    rate: number | null
    basis: string
  }
  /**
   * Sync lag. sync_state entries carry no timestamps, so the last sync event
   * time per task is APPROXIMATED by the task's updated_at (a sync_updated
   * event bumps the projection and therefore updated_at in taskStore).
   */
  syncLag: {
    tasksWithSync: number
    surfaces: number
    maxLagMs: number | null
    avgLagMs: number | null
    basis: string
  }
  topFailureReasons: OpsFailureReason[]
  /** Top 20 users by number of non-terminal tasks. */
  perUser: OpsUserLoad[]
  /**
   * Grants live in the projection but the autoAct trigger that consumed them
   * is not visible from the task endpoints, so this cannot be counted without
   * inventing a number. NEVER fake a metric — report the gap honestly.
   */
  unapprovedActions: 'not-instrumented'
}

function toNowMs(now: number | string): number {
  const ms = typeof now === 'number' ? now : Date.parse(now)
  if (!Number.isFinite(ms)) throw new Error('buildOpsSnapshot: "now" must be a finite epoch ms or parseable ISO string.')
  return ms
}

function tsOf(value: string): number | null {
  const n = Date.parse(value)
  return Number.isFinite(n) ? n : null
}

/** Integer-safe ratio: 4-decimal rounded, null when the denominator is empty. */
function rateOf(numerator: number, denominator: number): number | null {
  if (denominator <= 0) return null
  return Math.round((numerator / denominator) * 10_000) / 10_000
}

function zeroFilledStateCounts(): Record<TaskState, number> {
  const counts = {} as Record<TaskState, number>
  for (const state of TASK_STATES) counts[state] = 0
  return counts
}

function zeroFilledMonitorCounts(): Record<MonitorState, number> {
  const counts = {} as Record<MonitorState, number>
  for (const state of MONITOR_STATES) counts[state] = 0
  return counts
}

function artifactKind(a: TaskProjection['artifacts'][number] | undefined): string {
  return a && typeof a.kind === 'string' ? a.kind : ''
}

export function buildOpsSnapshot(
  taskRecordsWithProjections: readonly OpsSnapshotInput[],
  options: OpsSnapshotOptions,
): OpsSnapshot {
  const nowMs = toNowMs(options.now)
  const windowMs = Number.isFinite(options.windowMs) ? Math.max(0, Math.trunc(options.windowMs as number)) : DEFAULT_WINDOW_MS
  const windowStartMs = nowMs - windowMs

  const byState = zeroFilledStateCounts()
  const byMonitorState = zeroFilledMonitorCounts()

  let nonTerminal = 0
  let unparseableTimestamp = 0
  let under10m = 0
  let to10to60m = 0
  let over60m = 0

  const overdueCandidates: Array<OpsOverdueEntry & { ageMs: number }> = []

  let finished = 0
  let verified = 0
  let falseCompletions = 0
  const falseCompletionIds: string[] = []
  const categoryTally = new Map<string, { finished: number; verified: number }>()

  let needsReconciliationBacklog = 0
  let pausedByUser = 0
  let humanTakeover = 0
  let waitingForAuthority = 0
  let waitingForSelection = 0

  let handoffTasksRequested = 0
  let handoffTasksResumed = 0
  const handoffKindTally = new Map<string, { requested: number; resumed: number }>()

  let intervened = 0

  let tasksWithSync = 0
  let syncSurfaces = 0
  let syncLagSumMs = 0
  let syncLagMaxMs: number | null = null

  const failureCounts = new Map<string, number>()
  const unfinishedByUser = new Map<string, number>()

  for (const record of taskRecordsWithProjections) {
    const { task, projection } = record
    const state = task.state
    byState[state] += 1
    byMonitorState[task.monitor_state] += 1

    const updatedMs = tsOf(task.updated_at)
    const ageMs = updatedMs === null ? null : Math.max(0, nowMs - updatedMs)
    const isTerminal = TERMINAL_STATES.includes(state)
    // "Finished for the day" = terminal plus FULFILLED (awaiting closure).
    // Age buckets/perUser cover what still needs work: everything else.
    const isOutcome = OUTCOME_STATES.includes(state)

    if (isOutcome && updatedMs !== null && updatedMs >= windowStartMs) {
      finished += 1
      const isVerified = VERIFIED_STATES.includes(state)
      if (isVerified) verified += 1
      if (state === 'CLOSED' && projection.verification?.passed !== true) {
        falseCompletions += 1
        falseCompletionIds.push(task.id)
      }
      const category = task.persona
      const tally = categoryTally.get(category) ?? { finished: 0, verified: 0 }
      tally.finished += 1
      if (isVerified) tally.verified += 1
      categoryTally.set(category, tally)
    }

    if (!isTerminal && !isOutcome) {
      nonTerminal += 1
      if (ageMs === null) {
        unparseableTimestamp += 1
      } else {
        if (ageMs < 600_000) under10m += 1
        else if (ageMs < 3_600_000) to10to60m += 1
        else over60m += 1
        if (ageMs > windowMs) {
          overdueCandidates.push({
            id: task.id,
            state,
            ageMinutes: Math.floor(ageMs / 60_000),
            ageMs,
          })
        }
      }
      unfinishedByUser.set(task.user_id, (unfinishedByUser.get(task.user_id) ?? 0) + 1)
    }

    if (state === 'NEEDS_RECONCILIATION') needsReconciliationBacklog += 1
    if (state === 'PAUSED_BY_USER') pausedByUser += 1
    if (state === 'HUMAN_TAKEOVER') humanTakeover += 1
    if (state === 'WAITING_FOR_AUTHORITY') waitingForAuthority += 1
    if (state === 'WAITING_FOR_SELECTION') waitingForSelection += 1

    // Artifacts are appended in event order by the reducer, so array position
    // stands in for time: a resume counts when it appears after the request.
    const artifacts = projection.artifacts
    let firstRequestIdx = -1
    for (let i = 0; i < artifacts.length; i += 1) {
      const kind = artifactKind(artifacts[i])
      if (kind.startsWith(HANDOFF_REQUEST_PREFIX)) {
        if (firstRequestIdx < 0) firstRequestIdx = i
        const handoffKind = kind.slice(HANDOFF_REQUEST_PREFIX.length)
        if (handoffKind !== '') {
          const tally = handoffKindTally.get(handoffKind) ?? { requested: 0, resumed: 0 }
          tally.requested += 1
          handoffKindTally.set(handoffKind, tally)
        }
      } else if (kind.startsWith(HANDOFF_RESUME_PREFIX)) {
        const handoffKind = kind.slice(HANDOFF_RESUME_PREFIX.length)
        if (handoffKind !== '') {
          const tally = handoffKindTally.get(handoffKind) ?? { requested: 0, resumed: 0 }
          tally.resumed += 1
          handoffKindTally.set(handoffKind, tally)
        }
      }
    }
    const hasHandoffRequest = firstRequestIdx >= 0
    if (hasHandoffRequest) {
      handoffTasksRequested += 1
      const resumedByArtifact = artifacts.some(
        (artifact, i) => i > firstRequestIdx && artifactKind(artifact).startsWith(HANDOFF_RESUME_PREFIX),
      )
      if (resumedByArtifact || task.state === 'EXECUTING') handoffTasksResumed += 1
    }
    if (hasHandoffRequest || task.state === 'HUMAN_TAKEOVER') intervened += 1

    const surfaces = Object.keys(projection.sync_state).length
    if (surfaces > 0 && ageMs !== null) {
      tasksWithSync += 1
      syncSurfaces += surfaces
      syncLagSumMs += ageMs
      syncLagMaxMs = syncLagMaxMs === null ? ageMs : Math.max(syncLagMaxMs, ageMs)
    }

    const reasonCode = projection.failure?.reason_code
    if (typeof reasonCode === 'string' && reasonCode !== '') {
      failureCounts.set(reasonCode, (failureCounts.get(reasonCode) ?? 0) + 1)
    }
  }

  // Deterministic ordering everywhere: primary metric desc, natural key asc.
  overdueCandidates.sort((a, b) => b.ageMs - a.ageMs || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  const overdue: OpsOverdueEntry[] = overdueCandidates.slice(0, OVERDUE_CAP).map((entry) => ({
    id: entry.id,
    state: entry.state,
    ageMinutes: entry.ageMinutes,
  }))

  falseCompletionIds.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
  const falseCompletionIdsCapped = falseCompletionIds.slice(0, ID_CAP)

  const byCategory = [...categoryTally.entries()]
    .map(([category, tally]) => ({
      category,
      finished: tally.finished,
      verified: tally.verified,
      verifiedRate: rateOf(tally.verified, tally.finished),
    }))
    .sort((a, b) => (a.category < b.category ? -1 : a.category > b.category ? 1 : 0))

  const byKind = [...handoffKindTally.entries()]
    .map(([kind, tally]) => ({ kind, requested: tally.requested, resumed: tally.resumed }))
    .sort((a, b) => (a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : 0))

  const topFailureReasons = [...failureCounts.entries()]
    .map(([reason_code, count]) => ({ reason_code, count }))
    .sort((a, b) => b.count - a.count || (a.reason_code < b.reason_code ? -1 : a.reason_code > b.reason_code ? 1 : 0))

  const perUser = [...unfinishedByUser.entries()]
    .map(([user_id, unfinished]) => ({ user_id, unfinished }))
    .sort((a, b) => b.unfinished - a.unfinished || (a.user_id < b.user_id ? -1 : a.user_id > b.user_id ? 1 : 0))
    .slice(0, 20)

  return {
    schema: 'ops-snapshot.v1',
    generated_at: new Date(nowMs).toISOString(),
    window_ms: windowMs,
    window_start: new Date(windowStartMs).toISOString(),
    totals: { tasks: taskRecordsWithProjections.length },
    byState,
    byMonitorState,
    age: { nonTerminal, under10m, to10to60m, over60m, unparseableTimestamp },
    overdue,
    overdueTotal: overdueCandidates.length,
    outcomes: {
      finished,
      verified,
      verifiedRate: rateOf(verified, finished),
      falseCompletions,
      falseCompletionIds: falseCompletionIdsCapped,
      needsReconciliationBacklog,
      awaitingUser: {
        total: pausedByUser + humanTakeover + waitingForAuthority + waitingForSelection,
        byState: {
          PAUSED_BY_USER: pausedByUser,
          HUMAN_TAKEOVER: humanTakeover,
          WAITING_FOR_AUTHORITY: waitingForAuthority,
          WAITING_FOR_SELECTION: waitingForSelection,
        },
      },
      byCategory,
    },
    handoffResume: {
      tasksRequested: handoffTasksRequested,
      tasksResumed: handoffTasksResumed,
      rate: rateOf(handoffTasksResumed, handoffTasksRequested),
      byKind,
      basis:
        'resumed = handoff_resumed artifact after the first handoff request, or current state EXECUTING (state history beyond the current value is not visible from the projection)',
    },
    interventions: {
      tasks: taskRecordsWithProjections.length,
      intervened,
      rate: rateOf(intervened, taskRecordsWithProjections.length),
      basis: 'intervened = currently HUMAN_TAKEOVER or carries a handoff artifact; resolved takeovers without handoff artifacts are invisible',
    },
    syncLag: {
      tasksWithSync,
      surfaces: syncSurfaces,
      maxLagMs: syncLagMaxMs,
      avgLagMs: tasksWithSync > 0 ? Math.round(syncLagSumMs / tasksWithSync) : null,
      basis: 'sync_state entries are untimestamped; lag uses now - task.updated_at, which approximates the last sync event because sync_updated bumps updated_at',
    },
    topFailureReasons,
    perUser,
    unapprovedActions: 'not-instrumented',
  }
}

/* ------------------------------------------------------------- text render */

function padEnd(value: string, width: number): string {
  return value.length >= width ? value : value + ' '.repeat(width - value.length)
}

function padStart(value: string, width: number): string {
  return value.length >= width ? ' '.repeat(width - value.length) + value : value
}

function pct(rate: number | null): string {
  return rate === null ? 'n/a' : `${Math.round(rate * 10_000) / 100}%`
}

function minutes(ms: number | null): string {
  return ms === null ? 'n/a' : `${Math.floor(ms / 60_000)}m`
}

/** ~30-line aligned plain-text dashboard for terminals and paging alerts. */
export function renderOpsText(snapshot: OpsSnapshot): string {
  const lines: string[] = []
  const windowHours = Math.round((snapshot.window_ms / 3_600_000) * 10) / 10
  lines.push(`OPS SNAPSHOT ${snapshot.schema}  generated ${snapshot.generated_at}`)
  lines.push(`window: last ${windowHours}h from ${snapshot.window_start}`)
  lines.push(`tasks total: ${snapshot.totals.tasks}`)
  lines.push('')
  lines.push('STATE               CNT  STATE               CNT')
  const stateNames = TASK_STATES as readonly string[]
  for (let i = 0; i < stateNames.length; i += 2) {
    const left = padEnd(stateNames[i], 18) + padStart(String(snapshot.byState[stateNames[i] as TaskState]), 4)
    const rightName = stateNames[i + 1]
    const right = rightName === undefined ? '' : padEnd(rightName, 18) + padStart(String(snapshot.byState[rightName as TaskState]), 4)
    lines.push(`${left}  ${right}`)
  }
  lines.push(`monitor: ${MONITOR_STATES.map((m) => `${m}:${snapshot.byMonitorState[m]}`).join(' ')}`)
  lines.push(
    `age (non-terminal): <10m ${snapshot.age.under10m}  10-60m ${snapshot.age.to10to60m}  >60m ${snapshot.age.over60m}` +
      (snapshot.age.unparseableTimestamp > 0 ? `  unparseable ${snapshot.age.unparseableTimestamp}` : ''),
  )
  lines.push(`overdue > window: ${snapshot.overdueTotal} (top ${snapshot.overdue.length} listed)`)
  for (const entry of snapshot.overdue.slice(0, 5)) {
    lines.push(`  ${padStart(String(entry.ageMinutes), 6)}m  ${padEnd(entry.state, 22)}${entry.id}`)
  }
  lines.push('')
  lines.push(`outcomes in window: finished ${snapshot.outcomes.finished}  verified ${snapshot.outcomes.verified}  verifiedRate ${pct(snapshot.outcomes.verifiedRate)}`)
  lines.push(`needs reconciliation: ${snapshot.outcomes.needsReconciliationBacklog}  awaiting user: ${snapshot.outcomes.awaitingUser.total}`)
  for (const row of snapshot.outcomes.byCategory.slice(0, 4)) {
    lines.push(`  category ${padEnd(row.category, 10)} finished ${padStart(String(row.finished), 4)}  verified ${padStart(String(row.verified), 4)}  ${pct(row.verifiedRate)}`)
  }
  lines.push(
    `handoff resume: ${snapshot.handoffResume.tasksResumed}/${snapshot.handoffResume.tasksRequested} (${pct(snapshot.handoffResume.rate)})` +
      (snapshot.handoffResume.byKind.length > 0
        ? `  by kind: ${snapshot.handoffResume.byKind.map((k) => `${k.kind} ${k.resumed}/${k.requested}`).join(' ')}`
        : ''),
  )
  lines.push(
    `interventions: ${snapshot.interventions.intervened}/${snapshot.interventions.tasks} (${pct(snapshot.interventions.rate)})`,
  )
  lines.push(
    `sync lag: tasks ${snapshot.syncLag.tasksWithSync}  surfaces ${snapshot.syncLag.surfaces}  max ${minutes(snapshot.syncLag.maxLagMs)}  avg ${minutes(snapshot.syncLag.avgLagMs)}`,
  )
  lines.push('top failure reasons:')
  if (snapshot.topFailureReasons.length === 0) lines.push('   (none)')
  for (const row of snapshot.topFailureReasons.slice(0, 5)) {
    lines.push(`  ${padStart(String(row.count), 4)}  ${row.reason_code}`)
  }
  lines.push('busiest users (unfinished):')
  if (snapshot.perUser.length === 0) lines.push('   (none)')
  for (const row of snapshot.perUser.slice(0, 5)) {
    lines.push(`  ${padStart(String(row.unfinished), 4)}  ${row.user_id}`)
  }
  lines.push('')
  lines.push('!! ZERO-TOLERANCE  false completions: ' + String(snapshot.outcomes.falseCompletions) + (snapshot.outcomes.falseCompletionIds.length > 0 ? `  ids ${snapshot.outcomes.falseCompletionIds.join(',')}` : ''))
  lines.push('!! ZERO-TOLERANCE  unapproved actions: ' + snapshot.unapprovedActions)
  return lines.join('\n')
}
