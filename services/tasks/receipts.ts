/**
 * Receipt-based outcome verification (beat-instinct plan, "Verification
 * policy" table; Phase 1: "Implement receipt-based outcome verification").
 *
 * Doctrine: a model saying "done" is not evidence. Completion requires a
 * receipt — structured, task-class-specific evidence — evaluated here with
 * purely structural rules (never prose parsing). The evidence object itself
 * is validated and then discarded: only opaque references (a sha256 over the
 * canonical fields plus a short confirmation ref) are ever appended to the
 * event stream, so no raw merchant values land in hire_task_events payloads.
 *
 * Missing or ambiguous evidence records a failed verification and routes to
 * reconciliation; it never triggers an automatic retry (canAutoRetry).
 */
import type { SQL } from 'bun'
import { createHash } from 'node:crypto'
import { appendEvent, type TaskEventRecord } from './taskStore'
import type { TaskProjection } from './taskContract'

export const TASK_CLASSES = ['purchase', 'reservation', 'appointment', 'return', 'paperwork'] as const
export type TaskClass = (typeof TASK_CLASSES)[number]

/**
 * One row of the plan's verification table per class. Every field name is a
 * reference or an enum, never a secret-shaped value: `payment_status` carries
 * 'paid' | 'authorized' | ..., never a card number or token.
 */
export const REQUIRED_FIELDS: Record<TaskClass, string[]> = {
  // "Merchant order ID plus matching items, total, and payment status"
  purchase: ['confirmation_id', 'items', 'total_cents', 'payment_status'],
  // "Provider confirmation number plus dates, party, and terms"
  reservation: ['confirmation_number', 'dates', 'party', 'terms'],
  // "Provider confirmation or authoritative Calendar/portal record" — the id
  // plus which authoritative channel vouches for it.
  appointment: ['confirmation_id', 'record_source'],
  // "Carrier/merchant return ID and refund state"
  return: ['return_id', 'refund_status'],
  // "Submission receipt, case ID"
  paperwork: ['receipt_or_case_id'],
}

/** Enums are closed sets so junk values are caught structurally. */
const PAYMENT_STATUSES = new Set(['paid', 'authorized', 'pending', 'refunded', 'partially_refunded'])
const REFUND_STATUSES = new Set(['requested', 'in_transit', 'received', 'accepted', 'refunded', 'rejected', 'denied'])
const RECORD_SOURCES = new Set(['provider', 'calendar', 'portal'])

/**
 * Opaque references/values from a receipt scan. Values are primitives only;
 * nothing secret-shaped belongs here, and nothing raw is ever persisted
 * (taskContract.assertNoSecretKeys still scans every appended payload).
 */
export type EvidenceRecord = { [field: string]: string | number | boolean | null }

export type Verdict = 'verified' | 'incomplete' | 'contradictory'

export type ReceiptEvaluation = {
  verdict: Verdict
  /** Required fields absent or empty; non-empty exactly when verdict is 'incomplete'. */
  missing: string[]
  /** Stable structural reason codes; non-empty exactly when verdict is 'contradictory'. */
  reasons: string[]
}

function present(value: unknown): boolean {
  if (value === undefined || value === null) return false
  if (typeof value === 'string') return value.trim() !== ''
  return true
}

function numeric(value: unknown): number {
  if (typeof value === 'number') return value
  if (typeof value === 'string') return Number(value.trim())
  return Number.NaN
}

function unknownEnum(value: unknown, allowed: Set<string>): boolean {
  return typeof value !== 'string' || !allowed.has(value.trim().toLowerCase())
}

/**
 * Pure evaluator. 'incomplete' when any required field is absent/empty;
 * 'contradictory' when present values disagree with the receipt shape
 * (unknown payment/refund status enum, non-positive total, unparseable
 * dates); 'verified' only when every required field is present and none of
 * the structural rules fire. Rules are structural, never prose.
 */
export function evaluateReceipt(taskClass: TaskClass, evidence: EvidenceRecord): ReceiptEvaluation {
  const required = REQUIRED_FIELDS[taskClass]
  if (!required) throw new Error(`Unknown task class: ${String(taskClass)}`)
  const fields = evidence as Record<string, unknown>

  const missing = required.filter((field) => !present(fields[field]))
  if (missing.length > 0) return { verdict: 'incomplete', missing, reasons: [] }

  const reasons: string[] = []
  const payment = fields['payment_status']
  if (present(payment) && unknownEnum(payment, PAYMENT_STATUSES)) reasons.push('payment_status_unknown')
  const total = fields['total_cents']
  if (present(total)) {
    const cents = numeric(total)
    if (!Number.isFinite(cents) || cents <= 0) reasons.push('total_cents_not_positive')
  }
  const dates = fields['dates']
  if (present(dates) && (typeof dates !== 'string' || !Number.isFinite(Date.parse(dates)))) {
    reasons.push('dates_unparsable')
  }
  const refund = fields['refund_status']
  if (present(refund) && unknownEnum(refund, REFUND_STATUSES)) reasons.push('refund_status_unknown')
  const source = fields['record_source']
  if (present(source) && unknownEnum(source, RECORD_SOURCES)) reasons.push('record_source_unknown')

  if (reasons.length > 0) return { verdict: 'contradictory', missing: [], reasons }
  return { verdict: 'verified', missing: [], reasons: [] }
}

/** Canonical-JSON (sorted keys) sha256 reference for the evidence fields. */
export function hashEvidence(evidence: EvidenceRecord): string {
  const canonical = JSON.stringify(evidence, Object.keys(evidence).sort())
  return `sha256:${createHash('sha256').update(canonical).digest('hex')}`
}

export type RecordReceiptInput = {
  userId: string
  taskId: string
  taskClass: TaskClass
  evidence: EvidenceRecord
  /** Replaying the same key returns the stored event and writes nothing new. */
  idempotencyKey: string
  /** Injection clock for the verification timestamp (ISO string). */
  now?: string
}

export type RecordReceiptResult = {
  verdict: Verdict
  /** The verification_recorded event (newly appended or returned on replay). */
  event: TaskEventRecord
  replayed: boolean
}

/**
 * Evaluate a receipt, then record it. Only references are persisted — a
 * descriptive tag plus the sha256 — never the raw evidence values. On
 * 'verified' the task is allowed to leave VERIFYING for SYNCHRONIZING; on
 * anything else the verification is recorded as failed and the task stays
 * put for reconciliation.
 */
export async function recordReceipt(sql: SQL, input: RecordReceiptInput): Promise<RecordReceiptResult> {
  if (!input.userId) throw new Error('recordReceipt requires userId.')
  if (!input.taskId) throw new Error('recordReceipt requires taskId.')
  if (!input.idempotencyKey) throw new Error('recordReceipt requires an idempotencyKey.')

  const evaluation = evaluateReceipt(input.taskClass, input.evidence)
  const hash = hashEvidence(input.evidence)
  const evidenceRefs =
    evaluation.verdict === 'verified'
      ? [
          `receipt:${input.taskClass}:${hash}`,
          `confirmation_ref:${String((input.evidence as Record<string, unknown>)[REQUIRED_FIELDS[input.taskClass][0]]).trim().slice(0, 200)}`,
        ]
      : evaluation.verdict === 'incomplete'
        ? [`receipt_incomplete:${input.taskClass}:${evaluation.missing.join(',')}`, hash]
        : [`receipt_contradictory:${input.taskClass}:${evaluation.reasons.join(',')}`, hash]

  const recorded = await appendEvent(sql, {
    userId: input.userId,
    taskId: input.taskId,
    type: 'verification_recorded',
    payload: { passed: evaluation.verdict === 'verified', evidence: evidenceRefs, at: input.now ?? new Date().toISOString() },
    actor: 'receipt_engine',
    idempotencyKey: input.idempotencyKey,
  })
  if (recorded.replayed || evaluation.verdict !== 'verified') {
    return { verdict: evaluation.verdict, event: recorded.event, replayed: recorded.replayed }
  }

  // A verified receipt is the evidence gate the contract requires to leave
  // VERIFYING. Do not advance a task that already moved on.
  if (recorded.task.state === 'VERIFYING') {
    await appendEvent(sql, {
      userId: input.userId,
      taskId: input.taskId,
      type: 'state_changed',
      payload: { to: 'SYNCHRONIZING' },
      actor: 'receipt_engine',
      idempotencyKey: `${input.idempotencyKey}:advance`,
    })
  }
  return { verdict: evaluation.verdict, event: recorded.event, replayed: false }
}

/** Failed or parked verifications belong to a human/reconciler, not a retry loop. */
export function reconciliationNeeded(projection: TaskProjection): boolean {
  return projection.state === 'NEEDS_RECONCILIATION' || projection.verification?.passed === false
}

/**
 * The NEVER-RETRY rule made executable: if any external operation is not
 * confirmed 'done', its side effect is uncertain — reconciling with the
 * provider is the only safe move, so automatic retry is off the table.
 */
export function canAutoRetry(projection: TaskProjection): boolean {
  return !projection.external_ops.some((op) => op.status !== 'done')
}

export type UncertainOp = { idempotency_key: string; operation: string; status: string }

/** External ops awaiting human/reconcile attention (for reconciliation tooling). */
export function findUncertainOps(projection: TaskProjection): UncertainOp[] {
  return projection.external_ops
    .filter((op) => op.status !== 'done')
    .map((op) => ({ idempotency_key: op.idempotency_key, operation: op.operation, status: op.status }))
}
