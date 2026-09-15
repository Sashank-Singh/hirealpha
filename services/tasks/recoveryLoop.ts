/**
 * Recovery loop mount (beat-instinct plan Phase 0 exit: reconciliation
 * tooling must be a RUNNING loop, not just a library).
 *
 * This module turns recovery.ts into something a host can mount anywhere —
 * web boot or worker tick — with zero new infrastructure:
 *
 *   - runRecoverySweep       thin, idempotent wrapper around sweepTasks;
 *                            safe to call on every tick.
 *   - buildReconcileDigest   PURE honest text for a human's backlog; null
 *                            when nothing needs eyes. Never claims completion.
 *   - nextDigestDue          pure cadence math (no external cron — the host
 *                            already runs setInterval loops).
 *   - digestClaimKey         syncGuard-style idempotency key per digest day.
 *   - runRecoveryPassOnce    one full sweep + per-user digest pass; exported
 *                            so tests drive it manually instead of fake timers.
 *   - mountRecoveryLoop      setInterval wrapper; returns stop(); owns no
 *                            process globals; a throwing notify warns and the
 *                            loop stays alive.
 *
 * Intended delivery composition (A2 owns syncGuard; this module deliberately
 * does NOT import it):
 *
 *   const key = digestClaimKey(now)                     // reconcile-digest:YYYY-MM-DD
 *   if (nextDigestDue(lastRunAt, now) && await claimGuardKey(sql, key)) {
 *     const text = buildReconcileDigest(projections, { now })
 *     if (text) await notify(userId, persona, text)     // then markSent(key)
 *   }
 *
 * mountRecoveryLoop uses the in-memory equivalent of that lastRunAt marker so
 * it is self-contained; a host with syncGuard should prefer the composition
 * above so two processes never both text the same person the same day.
 *
 * Doctrine carried over from recovery.ts: nothing here retries an external
 * side effect; the digest only reports verdicts the pure classifier already
 * grounds in state facts. Text building is slice-only on stored request
 * strings — zero regex, zero prose scanning.
 */
import type { SQL } from 'bun'
import {
  classifyStuck,
  sweepTasks,
  type ReportedProjection,
  type StuckThresholds,
} from './recovery'
import { listTasksForAdmin, loadProjection, type TaskRecord } from './taskStore'

/* ---------------------------------------------------------------- defaults */

/** Worker-lease ceilings: an EXECUTING task older than this is a dead worker. */
export const DEFAULT_EXECUTING_WALL_MS = 11 * 60_000
/** A VERIFYING task without any verification older than this is stalled. */
export const DEFAULT_VERIFY_STALL_MS = 15 * 60_000
/** How often the mounted loop ticks by default. */
export const DEFAULT_TICK_MS = 5 * 60_000
/** A per-user backlog this large triggers an immediate (non-daily) digest. */
export const DEFAULT_BACKLOG_THRESHOLD = 3

const DAY_MS = 24 * 60 * 60_000

function epochMs(value: string | number | Date): number {
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value.getTime() : 0
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : 0
}

/* --------------------------------------------------------- sweep wrapper */

export type RecoverySweepSummary = {
  scanned: number
  marked: number
  /** Tasks in the reconcile lane as read this pass (new marks + waiting). */
  backlogSize: number
  markedTasks: Awaited<ReturnType<typeof sweepTasks>>['marked']
}

/**
 * Thin wrapper over recovery.sweepTasks with the loop's default thresholds.
 * The sweep is idempotent (replay-safe idempotency keys), so calling this
 * every tick is free of side-effect risk.
 */
export async function runRecoverySweep(
  sql: SQL,
  input: {
    now: string | number | Date
    executingWallMs?: number
    verifyStallMs?: number
    actor?: string
    limit?: number
  },
): Promise<RecoverySweepSummary> {
  const result = await sweepTasks(sql, {
    now: epochMs(input.now),
    executingWallMs: input.executingWallMs ?? DEFAULT_EXECUTING_WALL_MS,
    verifyStallMs: input.verifyStallMs ?? DEFAULT_VERIFY_STALL_MS,
    actor: input.actor ?? 'recovery',
    limit: input.limit ?? 100,
  })
  return {
    scanned: result.scanned,
    marked: result.marked.length,
    backlogSize: result.byVerdict.reconcile,
    markedTasks: result.marked,
  }
}

/* ---------------------------------------------------------- digest text */

const VERDICT_EYES = ['reconcile', 'unverified', 'awaiting-user'] as const
type EyesVerdict = (typeof VERDICT_EYES)[number]

const REQUEST_MAX_CHARS = 70
const DIGEST_LINE_CAP = 5

/** Verdict kinds a human must look at, and the honest phrase for each. */
const EYES_PHRASES: Record<EyesVerdict, (n: number) => string> = {
  reconcile: (n) => `${n} interrupted (I could not confirm what they did)`,
  unverified: (n) => `${n} finished without proof`,
  'awaiting-user': (n) => `${n} waiting on you`,
}

/**
 * PURE honest digest for ONE user's projections. Null when nothing needs
 * eyes. Shape:
 *
 *   <n> of your tasks need a look: <phrases>. Reply check on <id> to review.
 *   <id>: <request sliced at 70 chars>        (max 5 lines)
 *
 * The reply target is the first listed task id; every listed line carries its
 * own id so the human can pick any. Counts come straight from classifyStuck
 * verdicts — this function never infers completion from anything.
 */
export function buildReconcileDigest(
  projections: ReportedProjection[],
  options: { now: string | number | Date; thresholds?: StuckThresholds },
): string | null {
  const now = options.now
  const thresholds: StuckThresholds = options.thresholds ?? {
    executingWallMs: DEFAULT_EXECUTING_WALL_MS,
    verifyStallMs: DEFAULT_VERIFY_STALL_MS,
  }
  const needsEyes: Array<{ projection: ReportedProjection; verdict: EyesVerdict }> = []
  // Callers may hand us a Date; classifyStuck accepts string|number. Normalize once.
  const clock: string | number = now instanceof Date ? now.getTime() : now
  for (const projection of projections) {
    const kind = classifyStuck(projection, clock, thresholds).kind
    if ((VERDICT_EYES as readonly string[]).includes(kind)) {
      needsEyes.push({ projection, verdict: kind as EyesVerdict })
    }
  }
  if (needsEyes.length === 0) return null

  const counts: Record<EyesVerdict, number> = { reconcile: 0, unverified: 0, 'awaiting-user': 0 }
  for (const entry of needsEyes) counts[entry.verdict] += 1
  const phrases = VERDICT_EYES.filter((kind) => counts[kind] > 0).map((kind) => EYES_PHRASES[kind](counts[kind]))

  const lines = needsEyes.slice(0, DIGEST_LINE_CAP).map(
    (entry) => `${entry.projection.task_id}: ${entry.projection.request.slice(0, REQUEST_MAX_CHARS)}`,
  )
  const firstId = needsEyes[0]!.projection.task_id
  const header =
    `${needsEyes.length} of your tasks need a look: ${phrases.join(', ')}. ` +
    `Reply check on ${firstId} to review.`
  return [header, ...lines].join('\n')
}

/* ------------------------------------------------------ cadence + claim */

/**
 * Pure cadence: true when a digest may fire at `now` given the last send.
 * - No previous run (null/undefined/NaN) -> due.
 * - Exactly `cadenceHours` elapsed -> due (>=, so a 24h tick lands on schedule).
 * - Clock back-jump (now before lastRunAt) -> NOT due; a rewound clock must
 *   not manufacture a second text, and the next real crossing still fires.
 */
export function nextDigestDue(
  lastRunAt: string | number | Date | null | undefined,
  now: string | number | Date,
  cadenceHours = 24,
): boolean {
  if (lastRunAt === null || lastRunAt === undefined) return true
  const lastMs = epochMs(lastRunAt)
  if (lastMs === 0) return true
  const nowMs = epochMs(now)
  if (nowMs === 0) return false
  const cadenceMs = Math.max(1, cadenceHours) * 60 * 60_000
  return nowMs - lastMs >= cadenceMs
}

/** `reconcile-digest:YYYY-MM-DD` from the injected now (ISO slice, no regex). */
export function digestClaimKey(now: string | number | Date): string {
  const ms = epochMs(now)
  const iso = ms === 0 ? new Date(0).toISOString() : new Date(ms).toISOString()
  return `reconcile-digest:${iso.slice(0, 10)}`
}

/* ---------------------------------------------------- one-pass machinery */

export type NotifyUser = (userId: string, persona: string, text: string) => void | Promise<void>

/** Per-user loop memory (in-process equivalent of a syncGuard last-sent marker). */
export type RecoveryLoopState = {
  users: Map<string, { lastDigestAt: number | null; wasAboveThreshold: boolean }>
}

export function createRecoveryLoopState(): RecoveryLoopState {
  return { users: new Map() }
}

export type RecoveryPassSummary = {
  scanned: number
  marked: number
  digestsSent: string[]
}

const PER_USER_PROJECTION_CAP = 50

/**
 * One full loop pass: sweep, then per-user digest decision + notify.
 * A user gets the digest when it is due (first run or >= 24h since the last
 * send) OR on the rising edge of the backlog threshold, so a pile-up is
 * surfaced immediately while quiet days stay quiet. notify() throwing is
 * warned and swallowed: one bad recipient never kills the loop or blocks the
 * remaining users.
 */
export async function runRecoveryPassOnce(
  sql: SQL,
  options: {
    now: string | number | Date
    notify: NotifyUser
    state?: RecoveryLoopState
    actor?: string
    limit?: number
    executingWallMs?: number
    verifyStallMs?: number
    backlogThreshold?: number
    warn?: (message: string, error?: unknown) => void
  },
): Promise<RecoveryPassSummary> {
  const nowMs = epochMs(options.now)
  const warn = options.warn ?? ((message: string, error?: unknown) => console.warn(message, error))
  const sweep = await runRecoverySweep(sql, {
    now: options.now,
    actor: options.actor,
    limit: options.limit,
    executingWallMs: options.executingWallMs,
    verifyStallMs: options.verifyStallMs,
  })

  const rows = await listTasksForAdmin(sql, { userId: null, limit: options.limit ?? 100 })
  const byUser = new Map<string, TaskRecord[]>()
  for (const record of rows) {
    const list = byUser.get(record.user_id)
    if (!list) byUser.set(record.user_id, [record])
    else if (list.length < PER_USER_PROJECTION_CAP) list.push(record)
  }

  const state = options.state ?? createRecoveryLoopState()
  const threshold = options.backlogThreshold ?? DEFAULT_BACKLOG_THRESHOLD
  const thresholds: StuckThresholds = {
    executingWallMs: options.executingWallMs ?? DEFAULT_EXECUTING_WALL_MS,
    verifyStallMs: options.verifyStallMs ?? DEFAULT_VERIFY_STALL_MS,
  }
  const digestsSent: string[] = []

  for (const [userId, userRows] of byUser) {
    const projections: ReportedProjection[] = []
    for (const record of userRows) {
      const projection = await loadProjection(sql, { userId: record.user_id, taskId: record.id })
      if (!projection) continue
      projections.push({ ...projection, updated_at: record.updated_at, task_id: record.id })
    }
    const digest = buildReconcileDigest(projections, { now: options.now, thresholds })
    const backlog = projections.reduce(
      (total, projection) =>
        (VERDICT_EYES as readonly string[]).includes(classifyStuck(projection, nowMs, thresholds).kind)
          ? total + 1
          : total,
      0,
    )

    let entry = state.users.get(userId)
    if (!entry) {
      entry = { lastDigestAt: null, wasAboveThreshold: false }
      state.users.set(userId, entry)
    }
    const above = backlog >= threshold
    const crossed = above && !entry.wasAboveThreshold
    entry.wasAboveThreshold = above
    if (!digest || !(crossed || nextDigestDue(entry.lastDigestAt, options.now))) continue

    try {
      await options.notify(userId, userRows[0]?.persona ?? 'friend', digest)
      if (nowMs > 0) entry.lastDigestAt = nowMs
      digestsSent.push(userId)
    } catch (error) {
      warn(`recoveryLoop: notify failed for user ${userId}; loop continues`, error)
    }
  }

  return { scanned: sweep.scanned, marked: sweep.marked, digestsSent }
}

/* --------------------------------------------------------------- mount */

export type MountRecoveryLoopOptions = {
  /** Tick spacing; a getter is allowed so the host can retune without remount. */
  getIntervalMs?: number | (() => number)
  now?: () => Date
  notify: NotifyUser
  actor?: string
  limit?: number
  executingWallMs?: number
  verifyStallMs?: number
  backlogThreshold?: number
  warn?: (message: string, error?: unknown) => void
}

/**
 * Mount the loop: setInterval -> runRecoveryPassOnce, with a re-entrancy
 * guard so a slow DB never overlaps sweeps. Returns stop(); owns no process
 * globals (no env reads, no signal handlers, timer unref'd so it never holds
 * the process open by itself).
 */
export function mountRecoveryLoop(sql: SQL, options: MountRecoveryLoopOptions): () => void {
  const warn = options.warn ?? ((message: string, error?: unknown) => console.warn(message, error))
  const now = options.now ?? ((): Date => new Date())
  const state = createRecoveryLoopState()
  let running = false

  const tick = (): void => {
    if (running) return
    running = true
    runRecoveryPassOnce(sql, {
      now: now(),
      notify: options.notify,
      state,
      actor: options.actor,
      limit: options.limit,
      executingWallMs: options.executingWallMs,
      verifyStallMs: options.verifyStallMs,
      backlogThreshold: options.backlogThreshold,
      warn,
    })
      .catch((error) => warn('recoveryLoop: pass failed; loop stays alive', error))
      .finally(() => {
        running = false
      })
  }

  const resolveInterval = (): number => {
    const raw = typeof options.getIntervalMs === 'function' ? options.getIntervalMs() : options.getIntervalMs
    return Number.isFinite(raw) && (raw as number) > 0 ? (raw as number) : DEFAULT_TICK_MS
  }

  let timer: ReturnType<typeof setInterval> | null = setInterval(tick, resolveInterval())
  ;(timer as { unref?: () => void }).unref?.()
  tick()

  return () => {
    if (timer) {
      clearInterval(timer)
      timer = null
    }
  }
}

/** Re-exported so tests/hosts can assert against the same constants. */
export const DIGEST_CADENCE_MS = DAY_MS
