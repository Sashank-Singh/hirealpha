/**
 * Choice-turn orchestration (beat-instinct plan, Phase 1: research -> show
 * cards -> user chooses -> hand to executor). Pure functions over the
 * canonical task store; the bot's turn handler (runHireTurn) composes these
 * later — this module deliberately has no consumers yet.
 *
 * Doctrine enforced here:
 *   - Card validation is the event contract's job. Every write goes through
 *     taskStore.appendEvent, which already enforces provenance, optimistic
 *     concurrency, transition legality, and the secret-payload ban. Nothing
 *     here reimplements or bypasses that.
 *   - A reply the selection grammar cannot parse comes back as
 *     `needs-classifier`; free-form prose is the classifier's problem, never
 *     guessed from here (zero-regex rule).
 *   - A stale card is never selected: choicePricing.cardIsFresh gates
 *     option_selected so an old price can't become a checkout quote.
 *   - Handoff parks at WAITING_FOR_AUTHORITY: the executor/approval layer
 *     owns the authority door; a choice turn never forces EXECUTING.
 */
import type { SQL } from 'bun'
import { TaskTransitionError, type TaskOption, type TaskProjection } from './taskContract'
import {
  TaskNotFoundError,
  TaskVersionConflictError,
  appendEvent,
  loadProjection,
  type TaskRecord,
} from './taskStore'
import { renderOptionCards, selectionFromReply } from './choiceCards'
import { cardIsFresh } from './choicePricing'

/** Re-exported so the turn path can catch precisely without importing past this module. */
export { TaskTransitionError, TaskNotFoundError, TaskVersionConflictError }

type ScopedInput = { userId: string; taskId: string }

async function requireProjection(sql: SQL, input: ScopedInput): Promise<TaskProjection> {
  const projection = await loadProjection(sql, input)
  if (!projection) throw new TaskNotFoundError()
  return projection
}

/* ---------------------------------------------------------------- publish */

export type PublishOptionsInput = {
  userId: string
  taskId: string
  /** e.g. "dinner friday" — becomes the heading line of the card set. */
  heading: string
  /** Raw candidate cards; the options_published contract rejects bad provenance. */
  options: TaskOption[]
  actor?: string
  /** Injected clock for the cards' "checked Xm ago" lines. */
  now?: Date
  expectedVersion?: number
}

/**
 * Publish a researched option set as decision cards and park the task for the
 * user's pick. Renders first: if renderOptionCards refuses (no live cards, no
 * heading), nothing is published and null comes back. The rendered iMessage
 * text is returned verbatim — it IS the message the turn path sends.
 */
export async function publishOptions(sql: SQL, input: PublishOptionsInput): Promise<string | null> {
  const projection = await requireProjection(sql, input)
  if (projection.state !== 'RESEARCHING') {
    throw new TaskTransitionError(`Cannot publish options: task is ${projection.state}, not RESEARCHING.`)
  }
  const text = renderOptionCards(input.options, input.heading, { now: input.now })
  if (text === null) return null
  const actor = input.actor ?? 'alpha'
  await appendEvent(sql, {
    userId: input.userId,
    taskId: input.taskId,
    type: 'options_published',
    payload: { options: input.options },
    actor,
    idempotencyKey: `choice:${input.taskId}:published`,
    ...(input.expectedVersion !== undefined ? { expectedVersion: input.expectedVersion } : {}),
  })
  await appendEvent(sql, {
    userId: input.userId,
    taskId: input.taskId,
    type: 'state_changed',
    payload: { to: 'WAITING_FOR_SELECTION' },
    actor,
    idempotencyKey: `choice:${input.taskId}:published:state`,
  })
  return text
}

/* ---------------------------------------------------------------- reject */

export type RejectOptionInput = {
  userId: string
  taskId: string
  optionId: string
  reason?: string
  actor?: string
}

export type RejectOptionResult = {
  task: TaskRecord
  /** True when every card the user was shown is now rejected. */
  allRejected: boolean
}

/**
 * Strike one card. The reducer already clears selected_option_id when the
 * rejected card was the chosen one. When the last live card goes, the task
 * legally falls back WAITING_FOR_SELECTION -> RESEARCHING for another pass.
 */
export async function rejectOption(sql: SQL, input: RejectOptionInput): Promise<RejectOptionResult> {
  const projection = await requireProjection(sql, input)
  if (!projection.options.some((option) => option.id === input.optionId)) {
    throw new Error(`Cannot reject unknown option: ${input.optionId}`)
  }
  const actor = input.actor ?? 'user'
  const first = await appendEvent(sql, {
    userId: input.userId,
    taskId: input.taskId,
    type: 'option_rejected',
    payload: { option_id: input.optionId, ...(input.reason ? { reason: input.reason } : {}) },
    actor,
    idempotencyKey: `choice:${input.taskId}:rejected:${input.optionId}`,
  })
  const after = (await loadProjection(sql, input)) ?? projection
  const allRejected = after.options.length > 0 && after.options.every((option) => option.rejected === true)
  let task = first.task
  if (allRejected && after.state === 'WAITING_FOR_SELECTION') {
    const back = await appendEvent(sql, {
      userId: input.userId,
      taskId: input.taskId,
      type: 'state_changed',
      payload: { to: 'RESEARCHING' },
      actor,
      idempotencyKey: `choice:${input.taskId}:re-research`,
    })
    task = back.task
  }
  return { task, allRejected }
}

/* ---------------------------------------------------------------- select */

export type SelectOptionInput = {
  userId: string
  taskId: string
  /** The user's raw reply text; only the deterministic grammar touches it. */
  reply: string
  /** Injected clock for the staleness check — never a hidden now(). */
  now?: Date
  ttlMs?: number
  actor?: string
  expectedVersion?: number
}

export type SelectOptionResult =
  | { outcome: 'needs-classifier' }
  | { outcome: 'stale'; optionId: string }
  | { outcome: 'selected'; optionId: string; task: TaskRecord }

/**
 * Turn a reply into a choice. Unparseable prose hands off to the classifier
 * (nothing is written); a stale price is refused without publishing (the user
 * sees fresh cards on the next research pass); a fresh pick appends
 * option_selected and moves WAITING_FOR_SELECTION -> PLANNING_ACTION.
 */
export async function selectOption(sql: SQL, input: SelectOptionInput): Promise<SelectOptionResult> {
  const projection = await requireProjection(sql, input)
  if (projection.state !== 'WAITING_FOR_SELECTION') {
    throw new TaskTransitionError(`Cannot select an option: task is ${projection.state}, not WAITING_FOR_SELECTION.`)
  }
  const optionId = selectionFromReply(input.reply, projection.options)
  if (optionId === null) return { outcome: 'needs-classifier' }
  const chosen = projection.options.find((option) => option.id === optionId)
  if (!chosen) return { outcome: 'needs-classifier' }
  const now = input.now ?? new Date()
  if (!cardIsFresh(chosen, now, input.ttlMs)) return { outcome: 'stale', optionId }
  const actor = input.actor ?? 'user'
  await appendEvent(sql, {
    userId: input.userId,
    taskId: input.taskId,
    type: 'option_selected',
    payload: { option_id: optionId },
    actor,
    idempotencyKey: `choice:${input.taskId}:selected:${optionId}`,
    ...(input.expectedVersion !== undefined ? { expectedVersion: input.expectedVersion } : {}),
  })
  const moved = await appendEvent(sql, {
    userId: input.userId,
    taskId: input.taskId,
    type: 'state_changed',
    payload: { to: 'PLANNING_ACTION' },
    actor,
    idempotencyKey: `choice:${input.taskId}:planning`,
  })
  return { outcome: 'selected', optionId, task: moved.task }
}

/* --------------------------------------------------------------- handoff */

export type HandOffToExecutorInput = {
  userId: string
  taskId: string
  /** Queue submission for the chosen card; returns the executor reference. */
  enqueue: (option: TaskOption) => Promise<string>
  actor?: string
  now?: Date
}

export type HandOffToExecutorResult = {
  ref: string
  task: TaskRecord
}

/**
 * The executor seam. Only a PLANNING_ACTION task with a selected card may
 * hand off. Enqueue runs first (a failed submission leaves the task
 * untouched); on success the execution_started marker is recorded as an
 * `executor` artifact carrying the queue's own reference, and the task parks
 * in WAITING_FOR_AUTHORITY — the authority door belongs to the
 * executor/approval layer, never to this turn.
 */
export async function handOffToExecutor(
  sql: SQL,
  input: HandOffToExecutorInput,
): Promise<HandOffToExecutorResult> {
  const projection = await requireProjection(sql, input)
  if (projection.state !== 'PLANNING_ACTION') {
    throw new TaskTransitionError(`Cannot hand off to the executor: task is ${projection.state}, not PLANNING_ACTION.`)
  }
  const chosen = projection.options.find((option) => option.id === projection.selected_option_id)
  if (!chosen) {
    throw new TaskTransitionError('Cannot hand off without a selected option.')
  }
  const ref = await input.enqueue(chosen)
  if (typeof ref !== 'string' || ref.trim() === '') {
    throw new Error('handOffToExecutor: enqueue must return a non-empty executor reference (a queue or job id, never a secret).')
  }
  const actor = input.actor ?? 'alpha'
  const at = (input.now ?? new Date()).toISOString()
  await appendEvent(sql, {
    userId: input.userId,
    taskId: input.taskId,
    type: 'artifact_recorded',
    payload: { kind: 'executor', ref: ref.trim().slice(0, 2000), at },
    actor,
    idempotencyKey: `choice:${input.taskId}:executor-handoff`,
  })
  const moved = await appendEvent(sql, {
    userId: input.userId,
    taskId: input.taskId,
    type: 'state_changed',
    payload: { to: 'WAITING_FOR_AUTHORITY' },
    actor,
    idempotencyKey: `choice:${input.taskId}:awaiting-authority`,
  })
  return { ref: ref.trim(), task: moved.task }
}
