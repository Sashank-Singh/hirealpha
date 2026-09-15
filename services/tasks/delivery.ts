/**
 * Delivery seam (beat-instinct plan Phase 1: "attach fences to real sends").
 *
 * syncGuard decides WHETHER an external write may happen; calendarSync owns the
 * calendar-specific decision+record. This module is the transport-agnostic
 * orchestrator in between: the human wires the actual Photon/iMessage SMTP
 * caller, the Google Calendar client, or any other provider in as a callback,
 * and every real send passes through ONE fence shape:
 *
 *   claim (syncGuard, DB partial-unique index settles races)
 *     -> provider callback invoked AT MOST once per idempotency key
 *     -> recordOutcome (delivered | suppressed | needs_reconciliation)
 *
 * Guarantees:
 *   - deliverText: a replayed webhook/queue redelivery gets {claim:'duplicate'}
 *     and send() is NEVER called — idempotency by construction, not by reader
 *     discipline.
 *   - A send()/write() throw never fakes success: the surface moves to
 *     needs_reconciliation and the caller is told ({reason:'reconcile'}).
 *     Nothing is swallowed: every path returns an explicit discriminated union.
 *   - syncTaskSurface is generic over the calendarSync provider shape
 *     (write(payload, idempotencyKey) -> 'written' | 'existed'), so calendar
 *     writes and message sends share one fence without calendarSync changing.
 *   - flushPending uses pendingSyncLag to find surfaces stuck pending/failed
 *     and attempts EXACTLY ONE resend per surface, itself fenced under a
 *     flush-scoped idempotency key — a double flush cannot double-send.
 *
 * Doctrine inherited from syncGuard: payloads carry opaque refs and state
 * labels only. Prose (message bodies, drafts) is passed through to the
 * transport untouched and is never stored, scanned, or pattern-matched here.
 */
import type { SQL } from 'bun'
import type { TaskProjection } from './taskContract'
import type { SyncLagEntry, SyncSurface } from './syncGuard'
import { SYNC_SURFACES, claimDelivery, pendingSyncLag, recordOutcome } from './syncGuard'
import { loadProjection } from './taskStore'

/** Text transports are the two surfaces a human confirms over. */
export const TEXT_CHANNELS = ['imessage', 'email'] as const
export type TextChannel = (typeof TEXT_CHANNELS)[number]

/** Fail closed: bad wiring throws; a provider failure never masquerades as success. */
export class DeliveryError extends Error {}

function requireText(value: unknown, field: string): string {
  const text = typeof value === 'string' ? value.trim() : ''
  if (!text) throw new DeliveryError(`delivery requires a non-empty ${field}.`)
  return text
}

function assertSurface(surface: unknown): SyncSurface {
  if (!SYNC_SURFACES.includes(surface as SyncSurface)) {
    throw new DeliveryError(`Unknown sync surface: ${String(surface)}.`)
  }
  return surface as SyncSurface
}

function assertChannel(channel: unknown): TextChannel {
  if (!TEXT_CHANNELS.includes(channel as TextChannel)) {
    throw new DeliveryError(`Unknown text channel: ${String(channel)}.`)
  }
  return channel as TextChannel
}

/* ------------------------------------------------------- generic surface    */

/**
 * The provider contract, structurally identical to calendarSync's
 * CalendarProvider — a calendar provider object satisfies it for free.
 * 'existed' means the provider itself deduplicated upstream.
 */
export type SurfaceProvider<Payload> = {
  write(payload: Payload, idempotencyKey: string): Promise<'written' | 'existed'>
}

export type SyncTaskSurfaceInput<Payload> = {
  userId: string
  taskId: string
  surface: SyncSurface
  /** Opaque provider id or URL (message GUID, calendar event UID, ...). */
  ref: string
  payload: Payload
  provider: SurfaceProvider<Payload>
  /** Defaults to `sync:<surface>:<ref>:claim` — pass a webhook delivery id to dedupe upstream. */
  idempotencyKey?: string
}

export type SyncTaskSurfaceResult =
  | { action: 'delivered' } // claimed, provider wrote, outcome ledgered delivered
  | { action: 'deduped' } // claim lost the race: provider was NEVER invoked
  | { action: 'already-there' } // provider self-deduped: ledgered suppressed
  | { action: 'reconcile' } // provider threw: ledgered needs_reconciliation

/**
 * THE shared fence for any external write. Claim first (the database decides
 * the winner), invoke the provider at most once per idempotency key, then
 * ledger the outcome. Mirrors calendarSync.claimAndDeliver without touching
 * that module; calendarSync stays the calendar-specific authority (drafts,
 * diffs, failure markers) and may adopt this shape as transports unify.
 */
export async function syncTaskSurface<Payload>(
  sql: SQL,
  input: SyncTaskSurfaceInput<Payload>,
): Promise<SyncTaskSurfaceResult> {
  const userId = requireText(input.userId, 'userId')
  const taskId = requireText(input.taskId, 'taskId')
  const surface = assertSurface(input.surface)
  const ref = requireText(input.ref, 'ref').slice(0, 2000)
  if (!input.provider || typeof input.provider.write !== 'function') {
    throw new DeliveryError('syncTaskSurface requires a provider with a write() callback.')
  }
  const key = requireText(input.idempotencyKey ?? `sync:${surface}:${ref}:claim`, 'idempotencyKey')

  const claim = await claimDelivery(sql, { userId, taskId, surface, ref, idempotencyKey: key })
  if (claim.claim === 'duplicate') {
    // Replayed webhook/queue delivery: someone already sent this. The provider
    // is never invoked, so double delivery is impossible by construction.
    return { action: 'deduped' }
  }

  let receipt: 'written' | 'existed'
  try {
    receipt = await input.provider.write(input.payload, key)
  } catch {
    // The claim was real and the transport failed: the surface is visibly
    // pending reconciliation, the task state machine is untouched.
    await recordOutcome(sql, {
      userId,
      taskId,
      surface,
      ref,
      status: 'needs_reconciliation',
      idempotencyKey: `${key}:needs_reconciliation`,
      priorClaimEventId: claim.event.event_id,
    })
    return { action: 'reconcile' }
  }

  if (receipt === 'existed') {
    await recordOutcome(sql, {
      userId,
      taskId,
      surface,
      ref,
      status: 'suppressed',
      idempotencyKey: `${key}:suppressed`,
      priorClaimEventId: claim.event.event_id,
    })
    return { action: 'already-there' }
  }

  await recordOutcome(sql, {
    userId,
    taskId,
    surface,
    ref,
    status: 'delivered',
    idempotencyKey: `${key}:delivered`,
    priorClaimEventId: claim.event.event_id,
  })
  return { action: 'delivered' }
}

/* ------------------------------------------------------------- deliverText  */

export type DeliverTextInput = {
  userId: string
  taskId: string
  channel: TextChannel
  /** Opaque id of THIS message (transport GUID / RFC-822 Message-ID / row id). */
  ref: string
  /** Prose. Passed to send() verbatim; never stored, scanned, or trimmed. */
  body: string
  send: (body: string) => Promise<void>
  /** Defaults to `sync:<channel>:<ref>:claim`; pass the webhook delivery id. */
  idempotencyKey?: string
}

export type DeliverTextResult =
  | { sent: true; channel: TextChannel; ref: string }
  | { sent: false; reason: 'dedupe'; channel: TextChannel; ref: string }
  | { sent: false; reason: 'reconcile'; channel: TextChannel; ref: string }

/**
 * Fence around a real text send. On 'duplicate' the caller's send() is never
 * invoked — a replayed webhook provably cannot re-text (check the event
 * stream: one claim, one delivered outcome, zero extra provider calls).
 * A send() throw moves the surface to needs_reconciliation and reports
 * {sent:false, reason:'reconcile'}; success ledgeres delivered.
 */
export async function deliverText(sql: SQL, input: DeliverTextInput): Promise<DeliverTextResult> {
  const channel = assertChannel(input.channel)
  const ref = requireText(input.ref, 'ref').slice(0, 2000)
  if (typeof input.body !== 'string' || input.body.trim() === '') {
    throw new DeliveryError('deliverText requires a non-empty body.')
  }
  if (typeof input.send !== 'function') {
    throw new DeliveryError('deliverText requires a send() callback.')
  }

  const result = await syncTaskSurface(sql, {
    userId: input.userId,
    taskId: input.taskId,
    surface: channel,
    ref,
    payload: input.body,
    provider: {
      write: async (body: string) => {
        await input.send(body)
        return 'written' as const
      },
    },
    idempotencyKey: input.idempotencyKey,
  })

  switch (result.action) {
    case 'delivered':
      return { sent: true, channel, ref }
    case 'deduped':
    case 'already-there':
      return { sent: false, reason: 'dedupe', channel, ref }
    case 'reconcile':
      return { sent: false, reason: 'reconcile', channel, ref }
  }
}

/* ------------------------------------------------------------ flushPending  */

export type FlushPendingInput = {
  userId: string
  taskId: string
  /** Clock injected so lag selection is deterministic under test. */
  now: Date
  /**
   * Transport retry. Receives the pre-flush projection snapshot plus the
   * surface/ref being retried; throwing routes the surface to
   * needs_reconciliation instead of faking success.
   */
  resend: (projection: TaskProjection, surface: SyncSurface, ref: string) => Promise<void>
}

export type FlushedSurface = {
  surface: SyncSurface
  ref: string
  outcome: 'resent' | 'deduped' | 'reconcile'
}

export type FlushPendingResult = {
  /** Surfaces this flush attempted, with what the fence allowed. */
  flushed: FlushedSurface[]
  /** Lag still present after the flush (empty when every attempt succeeded). */
  remaining: SyncLagEntry[]
}

/**
 * Drain stuck syncs: pendingSyncLag picks surfaces whose latest state is
 * pending/failed, and each gets EXACTLY ONE resend attempt per (surface, ref) —
 * the attempt itself rides claimDelivery under a flush-scoped key, so a
 * concurrent or repeated flush dedupes at the fence and the transport is
 * invoked at most once for a given ref across all flushes.
 */
export async function flushPending(sql: SQL, input: FlushPendingInput): Promise<FlushPendingResult> {
  const userId = requireText(input.userId, 'userId')
  const taskId = requireText(input.taskId, 'taskId')
  if (typeof input.resend !== 'function') {
    throw new DeliveryError('flushPending requires a resend() callback.')
  }
  if (!(input.now instanceof Date) || !Number.isFinite(input.now.getTime())) {
    throw new DeliveryError('flushPending requires a valid Date.')
  }

  const projection = await loadProjection(sql, { userId, taskId })
  if (!projection) throw new DeliveryError('flushPending: task not found for this user.')

  // warnAfterMs 0: selection is by status, not age — warn flags are ignored here.
  const lags = pendingSyncLag(projection, input.now, 0)
  const flushed: FlushedSurface[] = []
  for (const lag of lags) {
    const ref = lag.ref
    if (ref === null) continue // no ref means no fence means no safe resend
    const result = await syncTaskSurface(sql, {
      userId,
      taskId,
      surface: lag.surface,
      ref,
      payload: null,
      provider: {
        write: async () => {
          await input.resend(projection, lag.surface, ref)
          return 'written' as const
        },
      },
      idempotencyKey: `flush:${lag.surface}:${ref}`,
    })
    const outcome =
      result.action === 'delivered' ? 'resent'
        : result.action === 'reconcile' ? 'reconcile'
          : 'deduped' // deduped/already-there: the fence refused a second send
    flushed.push({ surface: lag.surface, ref, outcome })
  }

  let remaining = lags
  if (flushed.length > 0) {
    const latest = await loadProjection(sql, { userId, taskId })
    remaining = latest ? pendingSyncLag(latest, input.now, 0) : []
  }
  return { flushed, remaining }
}
