/**
 * Idempotent sync guard (beat-instinct plan Phase 1: "Implement idempotent
 * iMessage and Calendar synchronization"; exit gate: "repeated webhook,
 * email, and polling events never create duplicate calendar entries or
 * messages").
 *
 * Delivery transports (iMessage sender, calendar writer, email relay, miniapp
 * bridge) are retry-prone: webhooks replay, workers restart, queues redeliver.
 * Every transport must pass through this module before touching an external
 * system:
 *
 *   claimDelivery      — atomic "may I send this?" gate. The fence is a
 *                        dedicated hire_task_events row of type 'sync_updated'
 *                        carrying an idempotency_key, protected by the
 *                        partial-unique index hire_task_events_idempotency.
 *                        The database — not reader code — decides the winner,
 *                        so concurrent replays cannot both claim.
 *   recordOutcome      — ledger the delivered/failed/suppressed result as a
 *                        second sync_updated row (own idempotency key).
 *   wasAlreadyDelivered — suppression-ledger read callers check BEFORE
 *                        composing a repeated confirmation (plan workstream 5).
 *   pendingSyncLag     — pure dashboard read: surfaces stuck in pending or
 *                        failed, with their age.
 *
 * Payloads carry opaque provider references (message GUID, event UID, URL)
 * and state labels only — never prose, never secret values; taskStore
 * .appendEvent rejects secret-bearing payloads and scopes every row by userId.
 * Lag timestamps live in artifact_recorded markers (kind `sync:<surface>`)
 * because the sync_state projection stores status + ref only.
 */
import type { SQL } from 'bun'
import type { SyncEntry, TaskProjection } from './taskContract'
import { appendEvent, type TaskEventRecord, type TaskRecord } from './taskStore'

export const SYNC_SURFACES = ['imessage', 'calendar', 'email', 'miniapp'] as const
export type SyncSurface = (typeof SYNC_SURFACES)[number]

export const SYNC_STATUSES = ['pending', 'delivered', 'failed', 'suppressed', 'needs_reconciliation'] as const
export type SyncStatus = (typeof SYNC_STATUSES)[number]

/** Fail closed: junk surfaces/statuses never reach the database. */
export class SyncGuardError extends Error {}

/** Artifact kind carrying the timestamp for the latest sync state move. */
export function syncMarkerKind(surface: SyncSurface): string {
  return `sync:${surface}`
}

function requireText(value: unknown, field: string): string {
  const text = typeof value === 'string' ? value.trim() : ''
  if (!text) throw new SyncGuardError(`syncGuard requires a non-empty ${field}.`)
  return text
}

function assertSurface(surface: unknown): SyncSurface {
  if (!SYNC_SURFACES.includes(surface as SyncSurface)) {
    throw new SyncGuardError(`Unknown sync surface: ${String(surface)}.`)
  }
  return surface as SyncSurface
}

function assertStatus(status: unknown): SyncStatus {
  if (!SYNC_STATUSES.includes(status as SyncStatus)) {
    throw new SyncGuardError(`Unknown sync status: ${String(status)}.`)
  }
  return status as SyncStatus
}

export type ClaimDeliveryInput = {
  userId: string
  taskId: string
  surface: SyncSurface
  /** Opaque provider id or URL (message GUID, calendar event UID, ...). */
  ref: string
  /** Defaults to `sync:<surface>:<ref>:claim`; pass the webhook delivery id to dedupe upstream. */
  idempotencyKey?: string
}

export type ClaimDeliveryResult = {
  /** 'yours' = the caller must send exactly once; 'duplicate' = do NOT re-send or re-create. */
  claim: 'yours' | 'duplicate'
  event: TaskEventRecord
  task: TaskRecord
}

/**
 * THE anti-duplication gate. Appends a 'sync_updated' row with
 * status='pending' under an idempotency key; the DB partial-unique index
 * settles races. A replayed append returns {claim:'duplicate'} with zero new
 * rows — the caller must treat it as "someone already sent this".
 */
export async function claimDelivery(sql: SQL, input: ClaimDeliveryInput): Promise<ClaimDeliveryResult> {
  const surface = assertSurface(input.surface)
  const userId = requireText(input.userId, 'userId')
  const taskId = requireText(input.taskId, 'taskId')
  const ref = requireText(input.ref, 'ref').slice(0, 2000)
  const key = requireText(input.idempotencyKey ?? `sync:${surface}:${ref}:claim`, 'idempotencyKey')

  const appended = await appendEvent(sql, {
    userId,
    taskId,
    type: 'sync_updated',
    payload: { surface, status: 'pending', ref },
    actor: 'sync_guard',
    idempotencyKey: key,
  })
  if (appended.replayed) {
    return { claim: 'duplicate', event: appended.event, task: appended.task }
  }
  // Timestamp marker for pendingSyncLag; its own idempotency key keeps a
  // crash-retry of this function from double-inserting if the claim wins.
  await appendEvent(sql, {
    userId,
    taskId,
    type: 'artifact_recorded',
    payload: { kind: syncMarkerKind(surface), ref, url: null, at: appended.event.occurred_at || new Date().toISOString() },
    actor: 'sync_guard',
    idempotencyKey: `${key}:lag`,
  })
  return { claim: 'yours', event: appended.event, task: appended.task }
}

export type RecordOutcomeInput = {
  userId: string
  taskId: string
  surface: SyncSurface
  ref: string
  status: SyncStatus
  /** Defaults to `sync:<surface>:<ref>:<status>` — retrying the same outcome is a no-op. */
  idempotencyKey?: string
  /** Event id returned by claimDelivery; recorded as causation. */
  priorClaimEventId?: string | null
}

export type RecordOutcomeResult = {
  event: TaskEventRecord
  task: TaskRecord
  /** True when this outcome was already recorded; nothing new was written. */
  replayed: boolean
}

/** Ledger the transport's result. Updates sync_state via the same reducer path. */
export async function recordOutcome(sql: SQL, input: RecordOutcomeInput): Promise<RecordOutcomeResult> {
  const surface = assertSurface(input.surface)
  const status = assertStatus(input.status)
  const userId = requireText(input.userId, 'userId')
  const taskId = requireText(input.taskId, 'taskId')
  const ref = requireText(input.ref, 'ref').slice(0, 2000)
  const key = requireText(input.idempotencyKey ?? `sync:${surface}:${ref}:${status}`, 'idempotencyKey')

  const appended = await appendEvent(sql, {
    userId,
    taskId,
    type: 'sync_updated',
    payload: { surface, status, ref },
    actor: 'sync_guard',
    idempotencyKey: key,
    causationId: input.priorClaimEventId ?? null,
  })
  if (!appended.replayed && (status === 'pending' || status === 'failed')) {
    // Only lag-relevant statuses need a fresh timestamp marker.
    await appendEvent(sql, {
      userId,
      taskId,
      type: 'artifact_recorded',
      payload: { kind: syncMarkerKind(surface), ref, url: null, at: appended.event.occurred_at || new Date().toISOString() },
      actor: 'sync_guard',
      idempotencyKey: `${key}:lag`,
    })
  }
  return { event: appended.event, task: appended.task, replayed: appended.replayed }
}

/**
 * Suppression ledger: was THIS ref already delivered on THIS surface?
 * Callers must check this BEFORE composing a message so repeated
 * confirmations are never sent. Strict ref match: a later claim of a
 * different ref replaces the surface's state, so only the current ref counts.
 */
export function wasAlreadyDelivered(projection: TaskProjection, surface: SyncSurface, ref: string): boolean {
  const s = assertSurface(surface)
  const entry: SyncEntry | undefined = projection.sync_state?.[s]
  return entry?.status === 'delivered' && typeof entry.ref === 'string' && entry.ref === ref
}

export type SyncLagEntry = {
  surface: SyncSurface
  status: 'pending' | 'failed'
  ref: string | null
  /** Milliseconds since the state move; null when no timestamp marker exists. */
  ageMs: number | null
  warn: boolean
}

/**
 * Pure dashboard read (no SQL): surfaces whose latest sync status is pending
 * or failed, with age derived from the artifact timestamp markers that
 * claimDelivery/recordOutcome write. Delivered/suppressed surfaces are never
 * reported. Unknown status labels are skipped, never crashed on.
 */
export function pendingSyncLag(projection: TaskProjection, now: Date, warnAfterMs: number): SyncLagEntry[] {
  const threshold = Number(warnAfterMs)
  if (!Number.isFinite(threshold) || threshold < 0) {
    throw new SyncGuardError('pendingSyncLag requires a non-negative finite warnAfterMs.')
  }
  const nowMs = now.getTime()
  if (!Number.isFinite(nowMs)) throw new SyncGuardError('pendingSyncLag requires a valid Date.')
  const lags: SyncLagEntry[] = []
  const syncState: Record<string, SyncEntry> = projection.sync_state ?? {}
  for (const rawSurface of Object.keys(syncState)) {
    if (!SYNC_SURFACES.includes(rawSurface as SyncSurface)) continue // stale data must never crash a dashboard
    const surface = rawSurface as SyncSurface
    const entry = syncState[rawSurface]
    if (!entry || (entry.status !== 'pending' && entry.status !== 'failed')) continue
    const markerAt = latestMarkerAt(projection, surface, typeof entry.ref === 'string' ? entry.ref : null)
    const ageMs = markerAt === null ? null : Math.max(0, nowMs - markerAt)
    lags.push({
      surface,
      status: entry.status as 'pending' | 'failed',
      ref: typeof entry.ref === 'string' ? entry.ref : null,
      ageMs,
      warn: ageMs !== null && ageMs > threshold,
    })
  }
  return lags
}

function latestMarkerAt(projection: TaskProjection, surface: SyncSurface, ref: string | null): number | null {
  let best: number | null = null
  for (const artifact of projection.artifacts ?? []) {
    if (!artifact || artifact.kind !== syncMarkerKind(surface)) continue
    if (ref !== null && typeof artifact.ref === 'string' && artifact.ref !== ref) continue
    if (typeof artifact.at !== 'string') continue
    const at = Date.parse(artifact.at)
    if (!Number.isFinite(at)) continue
    if (best === null || at > best) best = at
  }
  return best
}
