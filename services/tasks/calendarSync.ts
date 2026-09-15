/**
 * Calendar synchronization (beat-instinct plan Phase 2/5: verified booking ->
 * calendar event, with change propagation).
 *
 * Doctrine:
 *   - The transport (Composio/Google) is an injected callback; this module owns
 *     the DECISION (may I write?) and the RECORD (what happened?).
 *   - Duplication is impossible by construction: every write path first passes
 *     syncGuard.claimDelivery on the 'calendar' surface, fenced on a ref built
 *     from the draft's dedup_key. A replayed webhook/email/poll gets
 *     {claim:'duplicate'} and the provider is never called — one create,
 *     provable from the event stream.
 *   - A calendar failure NEVER claims the booking is incomplete. The booking is
 *     done; the sync is visibly pending: sync_state.calendar moves to
 *     'needs_reconciliation' and a failure_recorded('sync_retryable') lands.
 *     No state_changed is ever emitted here — exception routing belongs to
 *     reconcilers, not this module.
 *   - Change propagation diffs drafts purely first; a noop writes zero rows,
 *     and only a real change claims a NEW idempotency key that embeds a hash
 *     of exactly the changed fields, so retried deliveries of the same change
 *     also dedupe.
 *   - Payloads are references and short labels only (taskStore rejects secret
 *     keys; description prose is capped at 2000 chars).
 */
import type { SQL } from 'bun'
import { appendEvent } from './taskStore'
import { claimDelivery, recordOutcome } from './syncGuard'
import { hashEvidence, type EvidenceRecord } from './receipts'

export const CALENDAR_KINDS = ['reservation', 'appointment', 'travel', 'deadline'] as const
export type CalendarKind = (typeof CALENDAR_KINDS)[number]

export type CalendarDraft = {
  summary: string
  start_at: string
  end_at: string | null
  location: string
  description: string
  /** Stable identity of the calendar entry this draft maps to. */
  dedup_key: string
}

/** Injected transport. 'existed' means the provider itself deduplicated. */
export type CalendarProvider = {
  write(event: CalendarDraft, idempotencyKey: string): Promise<'written' | 'existed'>
}

export class CalendarSyncError extends Error {}

/* ------------------------------------------------------------- draft build */

export type BuildDraftOptions = {
  kind: CalendarKind
  title: string
  providerConfirmation?: string | null
  start_at: string
  end_at?: string | null
  location?: string | null
  cancellationTerms?: string | null
  taskId: string
}

function trimmed(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function requiredText(value: unknown, field: string, maxLen: number): string {
  const text = trimmed(value)
  if (!text) throw new CalendarSyncError(`calendar draft requires a non-empty ${field}.`)
  return text.slice(0, maxLen)
}

/**
 * Validate and compose. start_at must be an ISO-parseable timestamp; end_at is
 * optional but, when present, must parse and be strictly after start. The
 * description ALWAYS carries the confirmation, the cancellation terms, and the
 * `task:<taskId>` back-link so a calendar entry can be traced to its task.
 *
 * dedup_key = kind:confirmation:yyyy-mm-dd-of-start. Same-day re-confirmations
 * of the SAME confirmation collapse to one entry; confirmation-less events
 * (deadlines, no-show reminders) key by task + date instead, so distinct
 * bookings for one task never collide.
 */
export function buildCalendarDraft(opts: BuildDraftOptions): CalendarDraft {
  if (!CALENDAR_KINDS.includes(opts.kind)) {
    throw new CalendarSyncError(`Unknown calendar event kind: ${String(opts.kind)}.`)
  }
  const taskId = requiredText(opts.taskId, 'taskId', 200)
  const summary = requiredText(opts.title, 'title', 300)
  const startAt = requiredText(opts.start_at, 'start_at', 40)
  const startMs = Date.parse(startAt)
  if (!Number.isFinite(startMs)) throw new CalendarSyncError('start_at must be a valid ISO timestamp.')
  let endAt: string | null = null
  const rawEnd = trimmed(opts.end_at)
  if (rawEnd !== '') {
    endAt = requiredText(opts.end_at, 'end_at', 40)
    const endMs = Date.parse(endAt)
    if (!Number.isFinite(endMs) || !(endMs > startMs)) {
      throw new CalendarSyncError('end_at must be a valid ISO timestamp strictly after start_at.')
    }
  }
  const confirmation = trimmed(opts.providerConfirmation).slice(0, 200)
  const cancellation = trimmed(opts.cancellationTerms).slice(0, 400)
  const location = trimmed(opts.location).slice(0, 500)
  const description = [
    `Confirmation: ${confirmation === '' ? 'none' : confirmation}`,
    `Cancellation: ${cancellation === '' ? 'not provided' : cancellation}`,
    `task:${taskId}`,
  ].join('\n').slice(0, 2000)
  const dedupKey = `${opts.kind}:${confirmation === '' ? `task:${taskId}` : confirmation}:${startAt.slice(0, 10)}`.slice(0, 200)
  return { summary, start_at: startAt, end_at: endAt, location, description, dedup_key: dedupKey }
}

/** Structural gate for drafts that arrive from callers or stored refs. */
function assertDraftShape(draft: CalendarDraft, field: string): void {
  if (!draft || typeof draft !== 'object') throw new CalendarSyncError(`${field} must be a CalendarDraft.`)
  requiredText(draft.summary, `${field}.summary`, 300)
  requiredText(draft.start_at, `${field}.start_at`, 40)
  requiredText(draft.dedup_key, `${field}.dedup_key`, 200)
  if (draft.end_at !== null && typeof draft.end_at !== 'string') {
    throw new CalendarSyncError(`${field}.end_at must be an ISO string or null.`)
  }
  if (typeof draft.location !== 'string' || typeof draft.description !== 'string') {
    throw new CalendarSyncError(`${field}.location and ${field}.description must be strings.`)
  }
}

/* --------------------------------------------------------------- pure diff */

export type CalendarDiff = {
  action: 'noop' | 'update' | 'move'
  changed: string[]
}

const DRAFT_FIELDS: readonly (keyof CalendarDraft)[] = [
  'summary', 'start_at', 'end_at', 'location', 'description', 'dedup_key',
]

/**
 * Pure diff of two drafts. 'noop' when every field is equal; 'move' when ONLY
 * the times changed; 'update' otherwise. A changed dedup_key is always an
 * 'update' — it points at a different entry identity, not just a new time.
 */
export function diffCalendarEvents(oldDraft: CalendarDraft, nextDraft: CalendarDraft): CalendarDiff {
  assertDraftShape(oldDraft, 'oldDraft')
  assertDraftShape(nextDraft, 'nextDraft')
  const changed = DRAFT_FIELDS
    .filter((field) => (oldDraft[field] ?? '') !== (nextDraft[field] ?? ''))
    .map((field) => field as string)
  if (changed.length === 0) return { action: 'noop', changed: [] }
  const timesOnly = changed.every((field) => field === 'start_at' || field === 'end_at')
  return { action: timesOnly ? 'move' : 'update', changed }
}

/* --------------------------------------------------------------- delivery */

export type SyncVerifiedReservationInput = {
  userId: string
  taskId: string
  draft: CalendarDraft
  provider: CalendarProvider
}

export type SyncResult = { action: 'created' | 'suppressed' | 'already-there' | 'reconcile' }

export type PropagationResult = {
  action: 'noop' | 'suppressed' | 'updated' | 'moved' | 'already-there' | 'reconcile'
  changed: string[]
}

function requireIds(userId: unknown, taskId: unknown): { userId: string; taskId: string } {
  return {
    userId: requiredText(userId, 'userId', 200),
    taskId: requiredText(taskId, 'taskId', 200),
  }
}

/**
 * THE flow, shared by first sync and change propagation: claim first (DB fence
 * decides the winner), write once, then ledger the outcome. Provider errors
 * reconcile the sync surface WITHOUT touching the task state machine.
 */
async function claimAndDeliver(
  sql: SQL,
  args: {
    userId: string
    taskId: string
    draft: CalendarDraft
    provider: CalendarProvider
    idempotencyKey: string
  },
): Promise<SyncResult> {
  const { userId, taskId, draft, provider, idempotencyKey } = args
  if (!provider || typeof provider.write !== 'function') {
    throw new CalendarSyncError('a provider with a write() callback is required.')
  }
  const ref = `cal:${draft.dedup_key}`

  const claim = await claimDelivery(sql, { userId, taskId, surface: 'calendar', ref, idempotencyKey })
  if (claim.claim === 'duplicate') {
    // A replayed webhook/email/poll: someone already sent this. The provider is
    // never invoked, so double delivery cannot create a duplicate entry.
    return { action: 'suppressed' }
  }

  let outcome: 'written' | 'existed'
  try {
    outcome = await provider.write(draft, idempotencyKey)
  } catch {
    // The booking is done; only the sync is pending. Ledger that distinction.
    await recordOutcome(sql, {
      userId, taskId, surface: 'calendar', ref, status: 'needs_reconciliation',
      idempotencyKey: `${idempotencyKey}:needs_reconciliation`,
      priorClaimEventId: claim.event.event_id,
    })
    await appendEvent(sql, {
      userId, taskId,
      type: 'failure_recorded',
      payload: { reason_code: 'sync_retryable', detail: `calendar provider write failed for ${ref}` },
      actor: 'calendar_sync',
      idempotencyKey: `${idempotencyKey}:failure`,
    })
    return { action: 'reconcile' }
  }

  if (outcome === 'existed') {
    await recordOutcome(sql, {
      userId, taskId, surface: 'calendar', ref, status: 'suppressed',
      idempotencyKey: `${idempotencyKey}:suppressed`,
      priorClaimEventId: claim.event.event_id,
    })
    return { action: 'already-there' }
  }

  await recordOutcome(sql, {
    userId, taskId, surface: 'calendar', ref, status: 'delivered',
    idempotencyKey: `${idempotencyKey}:delivered`,
    priorClaimEventId: claim.event.event_id,
  })
  await appendEvent(sql, {
    userId, taskId,
    type: 'artifact_recorded',
    payload: { kind: 'calendar_event', ref },
    actor: 'calendar_sync',
    idempotencyKey: `${idempotencyKey}:artifact`,
  })
  return { action: 'created' }
}

/**
 * Verified booking -> calendar event. Idempotent by dedup_key: repeated
 * deliveries of the same booking return {action:'suppressed'} with zero new
 * rows and zero provider calls.
 */
export async function syncVerifiedReservation(
  sql: SQL,
  input: SyncVerifiedReservationInput,
): Promise<SyncResult> {
  const { userId, taskId } = requireIds(input.userId, input.taskId)
  assertDraftShape(input.draft, 'draft')
  return claimAndDeliver(sql, {
    userId,
    taskId,
    draft: input.draft,
    provider: input.provider,
    idempotencyKey: `sync:calendar:cal:${input.draft.dedup_key}:claim`,
  })
}

/**
 * Change propagation. Diff first: identical drafts short-circuit with zero
 * writes. A real move/update claims a fresh key embedding a hash over exactly
 * the changed fields (old -> new), so the same change delivered twice dedupes,
 * while a different change to the same entry passes the fence.
 */
export async function applyChangePropagation(
  oldDraft: CalendarDraft,
  nextDraft: CalendarDraft,
  sql: SQL,
  ids: { userId: string; taskId: string },
  provider: CalendarProvider,
): Promise<PropagationResult> {
  assertDraftShape(oldDraft, 'oldDraft')
  assertDraftShape(nextDraft, 'nextDraft')
  const { userId, taskId } = requireIds(ids.userId, ids.taskId)

  const diff = diffCalendarEvents(oldDraft, nextDraft)
  if (diff.action === 'noop') return { action: 'noop', changed: [] }

  const evidence: EvidenceRecord = {}
  for (const field of diff.changed) {
    evidence[`old.${field}`] = String(oldDraft[field as keyof CalendarDraft] ?? '')
    evidence[`next.${field}`] = String(nextDraft[field as keyof CalendarDraft] ?? '')
  }
  const hash = hashEvidence(evidence)
  const result = await claimAndDeliver(sql, {
    userId,
    taskId,
    draft: nextDraft,
    provider,
    idempotencyKey: `sync:calendar:cal:${nextDraft.dedup_key}:change:${hash}`,
  })
  const action = result.action === 'created' ? (diff.action === 'move' ? 'moved' : 'updated') : result.action
  return { action, changed: diff.changed }
}
