/**
 * Browser-job -> canonical-task mirror (beat-instinct plan, Phase 1:
 * "Connect the existing browser queue, approvals, Vault, and payments to the
 * task state machine").
 *
 * The browser job stays the execution engine; hire_tasks becomes the canonical
 * record. Every browser lifecycle point appends task events. This mirror is:
 *   - OFF unless HIREALPHA_TASK_RECORD=1 (the feature flag),
 *   - best-effort: it can never change a job outcome — every call swallows
 *     its own errors and logs them. A broken mirror is an observability
 *     problem, not a production incident.
 *
 * Mapping (one delegated browser execution = one task):
 *   enqueue  (approval/capability pending) -> PLANNING_ACTION -> WAITING_FOR_AUTHORITY
 *   claim    (approval/capability verified) -> authority_granted -> EXECUTING
 *   handoff  password/verification/captcha -> PAUSED_BY_USER | HUMAN_TAKEOVER
 *   resume                                 -> EXECUTING
 *   finish ok   -> VERIFYING, then SYNCHRONIZING -> FULFILLED only with
 *                  captured page evidence; without it the task parks in
 *                  VERIFYING under verification_failed (never claim done from
 *                  model text alone). Under the second gate
 *                  HIREALPHA_RECEIPT_GATE=1, a PURCHASE-shaped finish
 *                  (spend_request_id on the job row) instead records a real
 *                  receipt via receipts.recordReceipt and only reaches
 *                  FULFILLED when the plan's evidence table verifies it.
 *   finish fail -> FAILED_RETRYABLE | FAILED_FINAL
 */
import type { SQL } from 'bun'
import { appendEvent, createTask, getTask } from './taskStore'
import { recordReceipt, type EvidenceRecord, type TaskClass } from './receipts'

export function taskRecordEnabled(): boolean {
  return process.env.HIREALPHA_TASK_RECORD === '1'
}

/** Second, additive gate: turn-path receipt verification for purchase-shaped
 * job finishes. Default off -> the screenshot behavior is untouched. */
export function receiptGateEnabled(): boolean {
  return process.env.HIREALPHA_RECEIPT_GATE === '1'
}

async function mirror(label: string, fn: () => Promise<void>): Promise<void> {
  if (!taskRecordEnabled()) return
  try {
    await fn()
  } catch (error) {
    // Never let the mirror touch the caller's outcome.
    console.warn(`[task-record] ${label} failed:`, error instanceof Error ? error.message : String(error))
  }
}

function grantIdFor(job: {
  approval_id?: string | null
  credential_capability_id?: string | null
  spend_request_id?: string | null
}): string {
  if (job.credential_capability_id) return `capability:${job.credential_capability_id}`
  if (job.spend_request_id) return `spend:${job.spend_request_id}`
  if (job.approval_id) return `approval:${job.approval_id}`
  return 'auto:ask-first-off'
}

export type BrowserJobMirrorMeta = {
  jobId: string
  userId: string
  persona: string
  kind: string
  url: string
  goal: string | null
  approval_id?: string | null
  credential_capability_id?: string | null
  spend_request_id?: string | null
}

/** Enqueue point: create the task, stamp the link, park in WAITING_FOR_AUTHORITY. */
export async function mirrorJobEnqueued(
  sql: SQL,
  input: BrowserJobMirrorMeta,
): Promise<string | null> {
  let taskId: string | null = null
  await mirror('enqueue', async () => {
    // Re-enqueue with an idempotency job id must reuse the existing link, not
    // mint a second task for the same work.
    const linked = (await sql`SELECT task_id FROM hire_browser_jobs WHERE id = ${input.jobId} LIMIT 1`) as Array<{ task_id: string | null }>
    if (linked[0]?.task_id) {
      taskId = String(linked[0].task_id)
      return
    }
    const grantId = grantIdFor(input)
    const task = await createTask(sql, {
      userId: input.userId,
      persona: input.persona,
      request: input.goal || `browser ${input.kind}: ${input.url}`,
    })
    taskId = task.id
    await sql`UPDATE hire_browser_jobs SET task_id = ${task.id} WHERE id = ${input.jobId}`
    await appendEvent(sql, {
      userId: input.userId, taskId: task.id, type: 'constraints_resolved',
      payload: { constraints: { origin: 'browser', kind: input.kind, url: input.url, job: input.jobId } },
      actor: 'alpha', idempotencyKey: `${input.jobId}:constraints`,
    })
    await appendEvent(sql, { userId: input.userId, taskId: task.id, type: 'artifact_recorded', payload: { kind: 'browser_job', ref: input.jobId }, actor: 'alpha', idempotencyKey: `${input.jobId}:artifact` })
    await appendEvent(sql, { userId: input.userId, taskId: task.id, type: 'state_changed', payload: { to: 'PLANNING_ACTION' }, actor: 'alpha', idempotencyKey: `${input.jobId}:planning` })
    await appendEvent(sql, { userId: input.userId, taskId: task.id, type: 'authority_requested', payload: { grant_id: grantId }, actor: 'alpha', idempotencyKey: `${input.jobId}:authority-requested` })
    await appendEvent(sql, { userId: input.userId, taskId: task.id, type: 'state_changed', payload: { to: 'WAITING_FOR_AUTHORITY' }, actor: 'alpha', idempotencyKey: `${input.jobId}:waiting-authority` })
  })
  return taskId
}

/** Claim point: the queue's approval/capability gate IS the authority door. */
export async function mirrorJobClaimed(sql: SQL, input: BrowserJobMirrorMeta): Promise<void> {
  await mirror('claim', async () => {
    const link = await taskLink(sql, input.jobId)
    if (!link) return
    const { userId, taskId, seq } = link
    const grantId = grantIdFor(input)
    await appendEvent(sql, { userId, taskId, type: 'authority_granted', payload: { grant_id: grantId }, actor: 'alpha', idempotencyKey: `${input.jobId}:authority-granted` })
    await appendEvent(sql, { userId, taskId, type: 'state_changed', payload: { to: 'EXECUTING', grant_id: grantId }, actor: 'alpha', idempotencyKey: `${input.jobId}:executing:${seq}` })
  })
}

/** Handoff point: credential/payment waits pause for the user; unsolvable
 * challenges (captcha, confirmation) go to named human takeover. */
export async function mirrorJobHandoff(sql: SQL, jobId: string, kind: string): Promise<void> {
  await mirror('handoff', async () => {
    const link = await taskLink(sql, jobId)
    if (!link) return
    const { userId, taskId, seq } = link
    const state = kind === 'captcha' || kind === 'confirmation' ? 'HUMAN_TAKEOVER' : 'PAUSED_BY_USER'
    await appendEvent(sql, { userId, taskId, type: 'handoff_requested', payload: { kind, ref: `browser_job:${jobId}` }, actor: 'alpha', idempotencyKey: `${jobId}:handoff:${seq}` })
    await appendEvent(sql, { userId, taskId, type: 'state_changed', payload: { to: state as never }, actor: 'alpha', idempotencyKey: `${jobId}:handoff-state:${seq}` })
  })
}

export async function mirrorJobHandoffResumed(sql: SQL, jobId: string): Promise<void> {
  await mirror('handoff-resume', async () => {
    const link = await taskLink(sql, jobId)
    if (!link) return
    const { userId, taskId, seq } = link
    await appendEvent(sql, { userId, taskId, type: 'handoff_resumed', payload: { kind: 'browser_job' }, actor: 'alpha', idempotencyKey: `${jobId}:handoff-resumed:${seq}` })
    await appendEvent(sql, { userId, taskId, type: 'state_changed', payload: { to: 'EXECUTING' }, actor: 'alpha', idempotencyKey: `${jobId}:resumed-executing:${seq}` })
  })
}

/** Finish point. ok=true records the worker's audited completion as the
 * evidence reference (not a merchant receipt — Phase 1 receipt verification
 * replaces this once the visual choice path ships real orders). */
export async function mirrorJobFinished(
  sql: SQL,
  jobId: string,
  outcome: { ok: true; result: string } | { ok: false; error: string; retry?: boolean },
): Promise<void> {
  await mirror('finish', async () => {
    const link = await taskLink(sql, jobId)
    if (!link) return
    const { userId, taskId } = link
    if (outcome.ok) {
      await appendEvent(sql, { userId, taskId, type: 'artifact_recorded', payload: { kind: 'result', ref: outcome.result.slice(0, 2000) }, actor: 'alpha', idempotencyKey: `${jobId}:result` })
      await appendEvent(sql, { userId, taskId, type: 'external_op_recorded', payload: { operation: `browser_job:${jobId}`, idempotency_key: `${jobId}:done`, status: 'done', evidence_ref: `hire_browser_jobs:${jobId}` }, actor: 'alpha', idempotencyKey: `${jobId}:op-done` })
      await appendEvent(sql, { userId, taskId, type: 'state_changed', payload: { to: 'VERIFYING' }, actor: 'alpha', idempotencyKey: `${jobId}:verifying` })
      // P1 turn-path receipts: a purchase-shaped finish (the job row carries a
      // spend_request_id — the same signal the worker uses to demand a
      // merchant order confirmation) is judged by the plan's evidence table
      // through receipts.recordReceipt, not by a screenshot alone.
      const taskClass = receiptGateEnabled()
        ? classifyTaskClass({ spend_request_id: link.spendRequestId })
        : null
      if (taskClass === 'purchase') {
        await recordPurchaseReceipt(sql, { userId, taskId, jobId, spendRequestId: link.spendRequestId, result: outcome.result })
        return
      }
      // Never claim completion from model text alone (plan: EXECUTING ->
      // FULFILLED forbidden without independent verification). The strongest
      // evidence a finished job row carries is the captured page screenshot;
      // without one the task parks in VERIFYING with the rescue registry's
      // own code - "checking before claiming", never a silent pass.
      const evidence = link.hasScreenshot
        ? [`hire_browser_jobs:${jobId}`, `screenshot:${jobId}`]
        : []
      await appendEvent(sql, {
        userId, taskId, type: 'verification_recorded',
        payload: { passed: evidence.length > 0, evidence },
        actor: 'alpha', idempotencyKey: `${jobId}:verified`,
      })
      if (!link.hasScreenshot) {
        await appendEvent(sql, {
          userId, taskId, type: 'failure_recorded',
          payload: { reason_code: 'verification_failed', detail: 'worker reported done with no captured page evidence' },
          actor: 'alpha', idempotencyKey: `${jobId}:unverified`,
        })
        return
      }
      await appendEvent(sql, { userId, taskId, type: 'state_changed', payload: { to: 'SYNCHRONIZING' }, actor: 'alpha', idempotencyKey: `${jobId}:synchronizing` })
      await appendEvent(sql, { userId, taskId, type: 'state_changed', payload: { to: 'FULFILLED' }, actor: 'alpha', idempotencyKey: `${jobId}:fulfilled` })
      return
    }
    const retryable = await isJobRetryQueued(sql, jobId)
    await appendEvent(sql, {
      userId, taskId, type: 'failure_recorded',
      payload: { reason_code: retryable ? 'browser_replan_required' : 'verification_failed', detail: outcome.error.slice(0, 500) },
      actor: 'alpha', idempotencyKey: `${jobId}:failure:${link.seq}`,
    })
    await appendEvent(sql, { userId, taskId, type: 'state_changed', payload: { to: retryable ? 'FAILED_RETRYABLE' : 'FAILED_FINAL' }, actor: 'alpha', idempotencyKey: `${jobId}:failed:${link.seq}` })
  })
}

/** A swept dead run: outcome unknown, side effect possible -> visible
 * reconciliation, never an automatic retry (plan: forbidden transition). */
export async function mirrorJobReconcile(sql: SQL, jobId: string, detail: string): Promise<void> {
  await mirror('reconcile', async () => {
    const link = await taskLink(sql, jobId)
    if (!link) return
    const { userId, taskId } = link
    await appendEvent(sql, {
      userId, taskId, type: 'failure_recorded',
      payload: { reason_code: 'needs_reconciliation', detail: detail.slice(0, 500) },
      actor: 'alpha', idempotencyKey: `${jobId}:reconcile:${link.seq}`,
    })
    await appendEvent(sql, { userId, taskId, type: 'state_changed', payload: { to: 'NEEDS_RECONCILIATION' }, actor: 'alpha', idempotencyKey: `${jobId}:reconcile-state:${link.seq}` })
  })
}

/** The queue's own verdict after finishBrowserJob ran: pending = another attempt. */
async function isJobRetryQueued(sql: SQL, jobId: string): Promise<boolean> {
  const rows = (await sql`SELECT status FROM hire_browser_jobs WHERE id = ${jobId} LIMIT 1`) as Array<{ status: string }>
  return rows[0]?.status === 'pending'
}

/** The current task link for a job, plus the evidence the row already holds. */
async function taskLink(sql: SQL, jobId: string): Promise<{
  userId: string
  taskId: string
  seq: number
  hasScreenshot: boolean
  kind: string | null
  spendRequestId: string | null
  goal: string | null
} | null> {
  if (!taskRecordEnabled()) return null
  const rows = (await sql`
    SELECT user_id, task_id, last_screenshot, kind, spend_request_id, goal FROM hire_browser_jobs WHERE id = ${jobId} AND task_id IS NOT NULL LIMIT 1
  `) as Array<{ user_id: string; task_id: string; last_screenshot: string | null; kind?: string | null; spend_request_id?: string | null; goal?: string | null }>
  const row = rows[0]
  if (!row?.task_id) return null
  const task = await getTask(sql, { userId: String(row.user_id), taskId: String(row.task_id) })
  if (!task) return null
  return {
    userId: task.user_id,
    taskId: task.id,
    seq: task.event_seq,
    hasScreenshot: typeof row.last_screenshot === 'string' && row.last_screenshot.length > 0,
    kind: typeof row.kind === 'string' ? row.kind : null,
    spendRequestId: row.spend_request_id ? String(row.spend_request_id) : null,
    goal: typeof row.goal === 'string' ? row.goal : null,
  }
}

/**
 * Structural task-class classifier for the receipt gate. The ONLY truthful
 * signal a browser job row carries is its spend_request_id: a job that spent
 * under a spend approval is a purchase. Everything else returns null and
 * keeps the legacy screenshot behavior — the class is never guessed from
 * prose (goal/kind text), per the receipts doctrine.
 */
function classifyTaskClass(_input: { spend_request_id?: string | null; goal?: string | null }): TaskClass | null {
  return _input.spend_request_id ? 'purchase' : null
}

const CONFIRMATION_MARKERS = new Set(['confirmation', 'order'])
const CONFIRMATION_SUBMARKERS = new Set(['number', 'no', 'id'])

function isTokenChar(c: string): boolean {
  return (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c === '-'
}

/**
 * Non-regex structural scan for a confirmation reference, mirroring the
 * worker's hasMerchantOrderConfirmation intent (deploy/browserWorker.ts):
 * tokenize on non-[A-Za-z0-9-] boundaries with a per-char loop (no regex on
 * prose), then take the token following an 'order'/'confirmation' marker
 * (optionally past a 'number'/'no'/'id' sub-marker). Tokens are compared in
 * lowercase. Returns the token or null; '#' is a boundary and drops out.
 */
function extractConfirmationToken(text: string): string | null {
  const tokens: string[] = []
  let current = ''
  for (const c of Array.from(text)) {
    const low = c.toLowerCase()
    if (isTokenChar(low)) current += low
    else {
      if (current) tokens.push(current)
      current = ''
    }
  }
  if (current) tokens.push(current)
  for (let i = 0; i < tokens.length; i += 1) {
    if (!CONFIRMATION_MARKERS.has(tokens[i])) continue
    let j = i + 1
    // Step over sub-markers and repeated marker words ('order confirmation
    // number: X'), then take the first real reference token.
    while (j < tokens.length && (CONFIRMATION_SUBMARKERS.has(tokens[j]) || CONFIRMATION_MARKERS.has(tokens[j]))) j += 1
    const candidate = tokens[j]
    // The worker only trusts a reference of at least 4 characters.
    if (candidate && candidate.length >= 4) return candidate
  }
  return null
}

/**
 * Purchase finish under the receipt gate: build an EvidenceRecord from data
 * the job row already links to and let receipts.recordReceipt (the plan's
 * evidence table) decide. verified -> recordReceipt already advanced
 * VERIFYING -> SYNCHRONIZING, and this adds SYNCHRONIZING -> FULFILLED.
 * incomplete/contradictory -> recordReceipt wrote passed:false and the task
 * stays parked in VERIFYING; no further transition, no retry.
 */
async function recordPurchaseReceipt(
  sql: SQL,
  input: { userId: string; taskId: string; jobId: string; spendRequestId: string | null; result: string },
): Promise<void> {
  const approvalRows = input.spendRequestId
    ? (await sql`
        SELECT amount_cents, status, finalization_status FROM hire_spend_approvals
        WHERE id = ${input.spendRequestId} AND user_id = ${input.userId} LIMIT 1
      `) as Array<{ amount_cents: number | string | null; status: string | null; finalization_status: string | null }>
    : []
  const approval = approvalRows[0]
  const finalization = String(approval?.finalization_status ?? '').toLowerCase()
  const status = String(approval?.status ?? '').toLowerCase()
  const settled = finalization === 'completed' || finalization === 'finalized' || finalization === 'paid' || status === 'paid'
  // payment_status is only ever the closed enum value 'paid' or an
  // approval-namespaced raw enum (never the merchant-side words 'pending'/'
  // authorized', which the receipt enum would silently accept); anything the
  // approval row does not positively confirm is structurally contradictory
  // to a paid claim and parks the task.
  const evidence: EvidenceRecord = {
    confirmation_id: extractConfirmationToken(input.result),
    items: `job:${input.jobId}`,
    total_cents: approval ? Number(approval.amount_cents) : null,
    payment_status: approval ? (settled ? 'paid' : `approval_${finalization || status || 'unknown'}`) : 'approval_missing',
  }
  const recorded = await recordReceipt(sql, {
    userId: input.userId,
    taskId: input.taskId,
    taskClass: 'purchase',
    evidence,
    idempotencyKey: `${input.jobId}:receipt`,
  })
  if (recorded.verdict !== 'verified') return
  await appendEvent(sql, {
    userId: input.userId, taskId: input.taskId, type: 'state_changed',
    payload: { to: 'FULFILLED' }, actor: 'alpha', idempotencyKey: `${input.jobId}:fulfilled`,
  })
}
