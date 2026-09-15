/**
 * CHAOS TEST program (beat-instinct plan P0/P1 exit gate: "every task
 * recoverable after worker restart: 100% in chaos suite").
 *
 * Scenarios model: worker kill mid-append, duplicate webhook storms,
 * credential revoke mid-queue, lost network mid-external-action, replayed
 * callbacks, out-of-order delivery, and a seeded 20-task chaos sweep. Every
 * scenario asserts a HARD invariant (counts, deep equality, forced throws) —
 * never merely "does not crash".
 *
 * The fake lives in chaosSupport.ts (copied stateful pattern from
 * taskStore.test.ts, extended with fail injection, transactional rollback,
 * and a simulated hire_task_events_idempotency partial-unique index).
 */
import { describe, expect, it } from 'bun:test'
import {
  appendEvent,
  createTask,
  getTask,
  listEvents,
  loadProjection,
  rebuildProjection,
} from './taskStore'
import { TaskTransitionError, TERMINAL_STATES, type TaskProjection } from './taskContract'
import { claimDelivery, recordOutcome, wasAlreadyDelivered } from './syncGuard'
import { classifyStuck, closeReconciliation, sweepTasks } from './recovery'
import { canAutoRetry, findUncertainOps } from './receipts'
import {
  ChaosKilledError,
  WRITE_POINTS,
  assertContiguousSeqs,
  chaosDb,
  eventsWithKey,
  lcg,
  type ChaosDb,
} from './chaosSupport'

const NOW_OLD = '2026-09-14T00:00:00Z' // what the fake stamps every row
const NOW_LATER = '2026-09-14T00:05:00Z' // "worker presumed dead" wall clock

async function makeTask(db: ChaosDb, userId: string, request: string) {
  return createTask(db.sql, { userId, request, persona: 'friend' })
}

/** DRAFT -> ... -> EXECUTING on the single-action (no options) door. */
async function driveToExecuting(db: ChaosDb, userId: string, taskId: string) {
  for (const to of ['RESEARCHING', 'WAITING_FOR_SELECTION', 'PLANNING_ACTION'] as const) {
    await appendEvent(db.sql, { userId, taskId, type: 'state_changed', payload: { to }, actor: 'alpha' })
  }
  await appendEvent(db.sql, {
    userId, taskId, type: 'state_changed',
    payload: { to: 'EXECUTING', authority: 'not_required' }, actor: 'alpha',
  })
}

/** EXECUTING -> ... -> CLOSED using a passed receipt-style verification. */
async function driveToTerminal(db: ChaosDb, userId: string, taskId: string) {
  await appendEvent(db.sql, { userId, taskId, type: 'external_op_recorded', payload: { operation: 'reserve', idempotency_key: 'op-done', status: 'done', evidence_ref: 'merchant:ok' }, actor: 'alpha' })
  await appendEvent(db.sql, { userId, taskId, type: 'state_changed', payload: { to: 'VERIFYING' }, actor: 'alpha' })
  await appendEvent(db.sql, { userId, taskId, type: 'verification_recorded', payload: { passed: true, evidence: ['sha256:chaos-evidence'], at: NOW_OLD }, actor: 'alpha' })
  await appendEvent(db.sql, { userId, taskId, type: 'state_changed', payload: { to: 'SYNCHRONIZING' }, actor: 'alpha' })
  await appendEvent(db.sql, { userId, taskId, type: 'state_changed', payload: { to: 'FULFILLED' }, actor: 'alpha' })
  await appendEvent(db.sql, { userId, taskId, type: 'state_changed', payload: { to: 'CLOSED' }, actor: 'alpha' })
}

async function storedEqualsRebuild(db: ChaosDb, userId: string, taskId: string): Promise<TaskProjection> {
  const stored = await loadProjection(db.sql, { userId, taskId })
  const rebuilt = await rebuildProjection(db.sql, { userId, taskId })
  expect(rebuilt).not.toBe(null)
  expect(rebuilt).toEqual(stored)
  return stored as TaskProjection
}

describe('chaos suite', () => {
  it('1. KILL MID-APPEND at every write point: no half-written event, retry succeeds, rebuild == stored', async () => {
    // Kill points covering the full append lifecycle: createTask's three
    // writes (task row insert, task_created event insert, projection bump)
    // plus the state_changed append's two writes (event insert, projection
    // update). A transaction abort must leave NOTHING behind.
    const createKillPoints = [WRITE_POINTS.taskRowInsert, WRITE_POINTS.createdEventInsert, WRITE_POINTS.createProjectionBump]
    for (const point of createKillPoints) {
      const db = chaosDb()
      db.injection.failOn = point
      await expect(makeTask(db, 'user-1', 'book a table friday')).rejects.toBeInstanceOf(ChaosKilledError)
      expect(db.tasks.size).toBe(0) // rolled back: no orphan task row...
      expect(db.events).toHaveLength(0) // ...and no half-written event
      db.injection.failOn = undefined
      const task = await makeTask(db, 'user-1', 'book a table friday') // cold restart
      expect(task.version).toBe(1)
      expect(task.event_seq).toBe(1)
      expect(db.events).toHaveLength(1)
      await storedEqualsRebuild(db, 'user-1', task.id)
    }

    const appendKillPoints = [WRITE_POINTS.eventInsert, WRITE_POINTS.projectionUpdate]
    for (const point of appendKillPoints) {
      const db = chaosDb()
      const task = await makeTask(db, 'user-1', 'book a table friday')
      const streamBefore = JSON.stringify(db.events)
      const before = await getTask(db.sql, { userId: 'user-1', taskId: task.id })
      expect(before?.version).toBe(1)

      db.injection.failOn = point
      await expect(
        appendEvent(db.sql, { userId: 'user-1', taskId: task.id, type: 'state_changed', payload: { to: 'RESEARCHING' }, actor: 'alpha', expectedVersion: 1 }),
      ).rejects.toBeInstanceOf(ChaosKilledError)
      // The invariant: stream byte-identical, version untouched — even when the
      // kill lands AFTER the event INSERT (projection update point), the event
      // row itself was rolled back with the transaction.
      expect(JSON.stringify(db.events)).toBe(streamBefore)
      const after = await getTask(db.sql, { userId: 'user-1', taskId: task.id })
      expect(after?.version).toBe(1)
      expect(after?.event_seq).toBe(1)
      expect(after?.state).toBe('DRAFT')

      // Restart: the SAME append with a fresh expectedVersion succeeds.
      db.injection.failOn = undefined
      const retry = await appendEvent(db.sql, { userId: 'user-1', taskId: task.id, type: 'state_changed', payload: { to: 'RESEARCHING' }, actor: 'alpha', expectedVersion: 1 })
      expect(retry.replayed).toBe(false)
      expect(retry.task.version).toBe(2)
      expect(retry.task.state).toBe('RESEARCHING')
      await storedEqualsRebuild(db, 'user-1', task.id)
    }
  })

  it('2. DUPLICATE WEBHOOK STORM: 7 concurrent claims -> exactly 1 winner, exactly 1 fence event', async () => {
    const db = chaosDb()
    const task = await makeTask(db, 'user-1', 'confirm reservation msg-42')
    const claimKey = 'sync:imessage:msg-42:claim'

    const results = await Promise.allSettled(
      Array.from({ length: 7 }, () =>
        claimDelivery(db.sql, { userId: 'user-1', taskId: task.id, surface: 'imessage', ref: 'msg-42' }),
      ),
    )
    const yours = results.filter(
      (r) => r.status === 'fulfilled' && r.value.claim === 'yours',
    ).length
    const duplicates = results.filter(
      (r) => r.status === 'fulfilled' && r.value.claim === 'duplicate',
    ).length
    const conflicts = results.filter((r) => r.status === 'rejected').length

    // HARD invariants. The DB partial-unique (simulated in the fake, see
    // chaosSupport header) decides the winner: exactly one 'yours'; every
    // loser is either a clean idempotent 'duplicate' or a unique-violation
    // rejection — never a second fence row.
    expect(yours).toBe(1)
    expect(duplicates + conflicts).toBe(6)
    expect(eventsWithKey(db, claimKey)).toHaveLength(1)
    expect(eventsWithKey(db, `${claimKey}:lag`)).toHaveLength(1)
    // Losers' rolled-back transactions wrote nothing at all: version moved
    // exactly twice (claim event + lag marker) from the post-create version.
    const row = await getTask(db.sql, { userId: 'user-1', taskId: task.id })
    expect(row?.version).toBe(3)
    const proj = await storedEqualsRebuild(db, 'user-1', task.id)
    expect(proj.sync_state.imessage?.status).toBe('pending')
    expect(proj.sync_state.imessage?.ref).toBe('msg-42')
  })

  it('3. REPLAYED FINISH: one idempotency key, killed attempt + replays -> 1 event, replayed respected', async () => {
    const db = chaosDb()
    const task = await makeTask(db, 'user-1', 'finish checkout')
    const key = 'receipt:pi_chaos:finish'
    const finish = () =>
      appendEvent(db.sql, {
        userId: 'user-1', taskId: task.id, type: 'artifact_recorded',
        payload: { kind: 'receipt', ref: 'stripe:pi_chaos', url: null },
        actor: 'alpha', idempotencyKey: key,
      })

    // Interleaved failure: a kill mid-transaction must NOT reserve the key —
    // the aborted write left nothing, so the retry legitimately lands first.
    db.injection.failOn = WRITE_POINTS.projectionUpdate
    await expect(finish()).rejects.toBeInstanceOf(ChaosKilledError)
    expect(eventsWithKey(db, key)).toHaveLength(0)
    db.injection.failOn = undefined

    const first = await finish()
    expect(first.replayed).toBe(false)
    const versionAfterFirst = first.task.version
    const second = await finish()
    const third = await finish()
    expect(second.replayed).toBe(true)
    expect(third.replayed).toBe(true)
    expect(second.event.event_id).toBe(first.event.event_id)
    expect(third.event.event_id).toBe(first.event.event_id)
    // Replays write nothing: version frozen, exactly one row in the stream.
    expect(second.task.version).toBe(versionAfterFirst)
    expect(third.task.version).toBe(versionAfterFirst)
    expect(eventsWithKey(db, key)).toHaveLength(1)
    expect(db.events.filter((e) => e.type === 'artifact_recorded')).toHaveLength(1)
    await storedEqualsRebuild(db, 'user-1', task.id)
  })

  it('4. REVOKE MID-QUEUE: revoked grant gates WAITING_FOR_AUTHORITY -> EXECUTING; takeover path stays legal', async () => {
    const db = chaosDb()
    const task = await makeTask(db, 'user-1', 'book with stored card')
    const userId = 'user-1'
    await appendEvent(db.sql, { userId, taskId: task.id, type: 'state_changed', payload: { to: 'RESEARCHING' }, actor: 'alpha' })
    await appendEvent(db.sql, { userId, taskId: task.id, type: 'state_changed', payload: { to: 'WAITING_FOR_SELECTION' }, actor: 'alpha' })
    await appendEvent(db.sql, { userId, taskId: task.id, type: 'state_changed', payload: { to: 'PLANNING_ACTION' }, actor: 'alpha' })
    await appendEvent(db.sql, { userId, taskId: task.id, type: 'state_changed', payload: { to: 'WAITING_FOR_AUTHORITY' }, actor: 'alpha' })
    await appendEvent(db.sql, { userId, taskId: task.id, type: 'authority_requested', payload: { grant_id: 'g-1' }, actor: 'alpha' })
    await appendEvent(db.sql, { userId, taskId: task.id, type: 'authority_granted', payload: { grant_id: 'g-1' }, actor: 'alpha' })

    // Contract fact under test: `authority_revoked` has a reducer (grants are
    // upserted to 'revoked') but moves NO state — revoke is a projection-only
    // write. The gate then lives in assertTransition: EXECUTING from
    // WAITING_FOR_AUTHORITY requires a grant that isGranted() accepts.
    const revoked = await appendEvent(db.sql, { userId, taskId: task.id, type: 'authority_revoked', payload: { grant_id: 'g-1' }, actor: 'alpha' })
    expect(revoked.task.state).toBe('WAITING_FOR_AUTHORITY')
    const proj = await loadProjection(db.sql, { userId, taskId: task.id })
    expect(proj?.grants.find((g) => g.grant_id === 'g-1')?.status).toBe('revoked')

    // Revoke-then-execute MUST throw — this is the gate, asserted not commented.
    await expect(
      appendEvent(db.sql, { userId, taskId: task.id, type: 'state_changed', payload: { to: 'EXECUTING', grant_id: 'g-1' }, actor: 'alpha', expectedVersion: revoked.task.version }),
    ).rejects.toThrow(TaskTransitionError)
    // Stale version on the same move: the contract error must still win.
    await expect(
      appendEvent(db.sql, { userId, taskId: task.id, type: 'state_changed', payload: { to: 'EXECUTING', grant_id: 'g-1' }, actor: 'alpha' }),
    ).rejects.toThrow('not in granted state')

    // The legal escape: WAITING_FOR_AUTHORITY is an awaiting-user state the
    // sweeper deliberately leaves alone, so triage moves it via the exception
    // edge (any non-terminal -> NEEDS_RECONCILIATION), then takeover closes it.
    const swept = await sweepTasks(db.sql, { userIds: [userId], now: NOW_LATER, executingWallMs: 0, verifyStallMs: 0, actor: 'reconciler' })
    expect(swept.marked).toHaveLength(0) // sweeper never touches awaiting-user lanes
    const parked = await appendEvent(db.sql, {
      userId, taskId: task.id, type: 'state_changed',
      payload: { to: 'NEEDS_RECONCILIATION', reason_code: 'credential_required' }, actor: 'alpha',
    })
    expect(parked.task.state).toBe('NEEDS_RECONCILIATION')
    const closed = await closeReconciliation(db.sql, { userId, taskId: task.id, outcome: 'takeover', actor: 'human-ops', note: 'credential revoked mid-queue' })
    expect(closed.task.state).toBe('HUMAN_TAKEOVER')
    await storedEqualsRebuild(db, userId, task.id)
  })

  it('5. LOST NETWORK MID-EXTERNAL-ACTION: uncertain op -> reconcile sweep -> only VERIFYING/HUMAN_TAKEOVER exits', async () => {
    const db = chaosDb()
    const task = await makeTask(db, 'user-1', 'pay deposit')
    const userId = 'user-1'
    await driveToExecuting(db, userId, task.id)
    // Network died after "submitting" was recorded but before the outcome:
    await appendEvent(db.sql, {
      userId, taskId: task.id, type: 'external_op_recorded',
      payload: { operation: 'stripe.charge', idempotency_key: 'op-pay', status: 'submitting', evidence_ref: null },
      actor: 'alpha',
    })

    // Worker-restart triage on the pre-restart durable state:
    const stuck = await loadProjection(db.sql, { userId, taskId: task.id })
    expect(stuck).not.toBe(null)
    const verdict = classifyStuck({ ...(stuck as TaskProjection), updated_at: NOW_OLD }, NOW_LATER, { executingWallMs: 0, verifyStallMs: 0 })
    expect(verdict.kind).toBe('reconcile')
    expect(verdict.reason).toBe('executing_stalled')
    expect(canAutoRetry(stuck as TaskProjection)).toBe(false)
    expect(findUncertainOps(stuck as TaskProjection)).toEqual([
      { operation: 'stripe.charge', idempotency_key: 'op-pay', status: 'submitting' },
    ])

    const swept = await sweepTasks(db.sql, { userIds: [userId], now: NOW_LATER, executingWallMs: 0, verifyStallMs: 0, actor: 'reconciler' })
    expect(swept.marked).toHaveLength(1)
    const row = await getTask(db.sql, { userId, taskId: task.id })
    expect(row?.state).toBe('NEEDS_RECONCILIATION')
    // Replayed sweep is a no-op (idempotent reconcile keys).
    const reswept = await sweepTasks(db.sql, { userIds: [userId], now: NOW_LATER, executingWallMs: 0, verifyStallMs: 0, actor: 'reconciler' })
    expect(reswept.marked).toHaveLength(0)
    expect(reswept.alreadyReconciling).toBe(1)

    // The plan's exact forbidden row: NEEDS_RECONCILIATION -> EXECUTING (the
    // "auto retry after a maybe-happened side effect" door) MUST throw.
    await expect(
      appendEvent(db.sql, { userId, taskId: task.id, type: 'state_changed', payload: { to: 'EXECUTING', authority: 'not_required' }, actor: 'alpha' }),
    ).rejects.toThrow(TaskTransitionError)

    // Legal exit A: verified -> VERIFYING (evidence re-check, never a retry).
    const verified = await closeReconciliation(db.sql, { userId, taskId: task.id, outcome: 'verified', actor: 'reconciler' })
    expect(verified.task.state).toBe('VERIFYING')
    // closeReconciliation only applies from NEEDS_RECONCILIATION:
    await expect(
      closeReconciliation(db.sql, { userId, taskId: task.id, outcome: 'takeover', actor: 'reconciler' }),
    ).rejects.toThrow(TaskTransitionError)

    // Legal exit B on a second task: takeover.
    const task2 = await makeTask(db, 'user-2', 'pay deposit 2')
    await driveToExecuting(db, 'user-2', task2.id)
    await appendEvent(db.sql, { userId: 'user-2', taskId: task2.id, type: 'external_op_recorded', payload: { operation: 'stripe.charge', idempotency_key: 'op-pay2', status: 'submitting', evidence_ref: null }, actor: 'alpha' })
    const swept2 = await sweepTasks(db.sql, { userIds: ['user-2'], now: NOW_LATER, executingWallMs: 0, verifyStallMs: 0, actor: 'reconciler' })
    expect(swept2.marked).toHaveLength(1)
    const taken = await closeReconciliation(db.sql, { userId: 'user-2', taskId: task2.id, outcome: 'takeover', actor: 'reconciler' })
    expect(taken.task.state).toBe('HUMAN_TAKEOVER')
    await storedEqualsRebuild(db, userId, task.id)
    await storedEqualsRebuild(db, 'user-2', task2.id)
  })

  it('6. CHAOS-RECOVER-100: 20 seeded tasks through all five failure patterns -> every one accounted for, rebuild == stored', async () => {
    const TOTAL = 20
    const rand = lcg(20260914)
    const states = new Set<string>([...TERMINAL_STATES, 'FULFILLED', 'NEEDS_RECONCILIATION'])
    let recoverable = 0
    let lost = 0
    const patternCounts: number[] = [0, 0, 0, 0, 0]

    for (let i = 0; i < TOTAL; i += 1) {
      const pattern = Math.floor(rand() * 5) % 5
      patternCounts[pattern] = (patternCounts[pattern] ?? 0) + 1
      const db = chaosDb()
      const userId = `chaos-${i}`
      const task = await makeTask(db, userId, `chaos request ${i}`)
      await driveToExecuting(db, userId, task.id)
      let freshClaim = false

      if (pattern === 0) {
        // kill mid-append, then cold-restart the identical append
        db.injection.failOn = WRITE_POINTS.eventInsert
        await expect(
          appendEvent(db.sql, { userId, taskId: task.id, type: 'checkpoint_recorded', payload: { step: { at: 'payment' } }, actor: 'alpha' }),
        ).rejects.toBeInstanceOf(ChaosKilledError)
        db.injection.failOn = undefined
        const retried = await appendEvent(db.sql, { userId, taskId: task.id, type: 'checkpoint_recorded', payload: { step: { at: 'payment' } }, actor: 'alpha' })
        expect(retried.replayed).toBe(false)
        await driveToTerminal(db, userId, task.id)
      } else if (pattern === 1) {
        // webhook storm: 3 concurrent claims, exactly one winner
        const settled = await Promise.allSettled([
          claimDelivery(db.sql, { userId, taskId: task.id, surface: 'calendar', ref: `evt-${i}` }),
          claimDelivery(db.sql, { userId, taskId: task.id, surface: 'calendar', ref: `evt-${i}` }),
          claimDelivery(db.sql, { userId, taskId: task.id, surface: 'calendar', ref: `evt-${i}` }),
        ])
        const yours = settled.filter((r) => r.status === 'fulfilled' && r.value.claim === 'yours').length
        expect(yours).toBe(1)
        expect(eventsWithKey(db, `sync:calendar:evt-${i}:claim`)).toHaveLength(1)
        freshClaim = true
        await driveToTerminal(db, userId, task.id)
      } else if (pattern === 2) {
        // duplicate + replay, then leave EXECUTING holding a fresh claim fence
        const first = await claimDelivery(db.sql, { userId, taskId: task.id, surface: 'imessage', ref: `late-${i}` })
        expect(first.claim).toBe('yours')
        const dup = await claimDelivery(db.sql, { userId, taskId: task.id, surface: 'imessage', ref: `late-${i}` })
        expect(dup.claim).toBe('duplicate')
        expect(eventsWithKey(db, `sync:imessage:late-${i}:claim`)).toHaveLength(1)
        freshClaim = true
      } else if (pattern === 3) {
        // credential revoked mid-queue -> visible reconciliation, never silent
        await appendEvent(db.sql, { userId, taskId: task.id, type: 'authority_requested', payload: { grant_id: 'g' }, actor: 'alpha' })
        await appendEvent(db.sql, { userId, taskId: task.id, type: 'authority_granted', payload: { grant_id: 'g' }, actor: 'alpha' })
        await appendEvent(db.sql, { userId, taskId: task.id, type: 'authority_revoked', payload: { grant_id: 'g' }, actor: 'alpha' })
        const swept = await sweepTasks(db.sql, { userIds: [userId], now: NOW_LATER, executingWallMs: 0, verifyStallMs: 0, actor: 'reconciler' })
        expect(swept.marked).toHaveLength(1)
      } else {
        // lost network mid-external-action -> reconcile sweep
        await appendEvent(db.sql, { userId, taskId: task.id, type: 'external_op_recorded', payload: { operation: 'submit', idempotency_key: `op-${i}`, status: 'submitting', evidence_ref: null }, actor: 'alpha' })
        const swept = await sweepTasks(db.sql, { userIds: [userId], now: NOW_LATER, executingWallMs: 0, verifyStallMs: 0, actor: 'reconciler' })
        expect(swept.marked).toHaveLength(1)
        expect(canAutoRetry(await loadProjection(db.sql, { userId, taskId: task.id }) as TaskProjection)).toBe(false)
      }

      // ---- universal recovery invariants (the "100%" gate) ----
      const row = await getTask(db.sql, { userId, taskId: task.id })
      expect(row).not.toBe(null)
      const state = (row as { state: string }).state
      const accounted =
        states.has(state) ||
        (state === 'EXECUTING' && freshClaim) ||
        (state === 'HUMAN_TAKEOVER' && freshClaim)
      if (accounted) recoverable += 1
      else lost += 1
      expect(accounted).toBe(true)
      // Never silently lost: the stream is contiguous 1..event_seq, so no
      // killed write left a gap and no successful write went unrecorded.
      const events = await listEvents(db.sql, { userId, taskId: task.id, limit: 1000 })
      expect(events).toHaveLength((row as { event_seq: number }).event_seq)
      assertContiguousSeqs(db.events)
      await storedEqualsRebuild(db, userId, task.id)
    }

    console.log(
      `chaos-recover: ${recoverable}/${TOTAL} recoverable, ${lost} silently lost; ` +
        `pattern mix kill/webhook-storm/replay/revoke/uncertain-op = ${patternCounts.join('/')}`,
    )
    // The invariant, not a rate: nothing may be lost, all must be accounted.
    expect(recoverable).toBe(TOTAL)
    expect(lost).toBe(0)
  })

  it('7. OUT_OF_ORDER WEBHOOKS: outcome-before-claim accepted as an outcome row; fence stays exactly-one', async () => {
    const db = chaosDb()
    const task = await makeTask(db, 'user-1', 'out-of-order msg-7')
    const userId = 'user-1'
    const claimKey = 'sync:imessage:msg-7:claim'
    const deliveredKey = 'sync:imessage:msg-7:delivered'

    // Outcome arrives BEFORE any claim. Current behavior (asserted, not
    // blessed): recordOutcome fences on its OWN idempotency key, so it lands
    // as an outcome row with replayed=false.
    const early = await recordOutcome(db.sql, { userId, taskId: task.id, surface: 'imessage', ref: 'msg-7', status: 'delivered' })
    expect(early.replayed).toBe(false)
    expect(eventsWithKey(db, deliveredKey)).toHaveLength(1)

    // Late claim: a different key, so it also lands — and the later fence write
    // clobbers sync_state back to 'pending' (observable scramble artifact).
    const lateClaim = await claimDelivery(db.sql, { userId, taskId: task.id, surface: 'imessage', ref: 'msg-7' })
    expect(lateClaim.claim).toBe('yours')
    const afterClaim = await loadProjection(db.sql, { userId, taskId: task.id })
    expect(afterClaim?.sync_state.imessage?.status).toBe('pending')
    // Suppression ledger sees the clobbered state as NOT delivered:
    expect(wasAlreadyDelivered(afterClaim as TaskProjection, 'imessage', 'msg-7')).toBe(false)

    // Duplicate-claim storm AFTER the fence is committed: zero new winners.
    const dupes = await Promise.all([
      claimDelivery(db.sql, { userId, taskId: task.id, surface: 'imessage', ref: 'msg-7' }),
      claimDelivery(db.sql, { userId, taskId: task.id, surface: 'imessage', ref: 'msg-7' }),
      claimDelivery(db.sql, { userId, taskId: task.id, surface: 'imessage', ref: 'msg-7' }),
    ])
    expect(dupes.every((d) => d.claim === 'duplicate')).toBe(true)

    // The storm-bypass defense: the fence row exists exactly once, no matter
    // how many claims or scrambles arrived.
    expect(eventsWithKey(db, claimKey)).toHaveLength(1)
    expect(eventsWithKey(db, deliveredKey)).toHaveLength(1)

    // Re-delivered outcome on the same key replays (no double ledger row); a
    // fresh-key outcome restores the ledger to delivered.
    const redelivered = await recordOutcome(db.sql, { userId, taskId: task.id, surface: 'imessage', ref: 'msg-7', status: 'delivered' })
    expect(redelivered.replayed).toBe(true)
    expect(eventsWithKey(db, deliveredKey)).toHaveLength(1)
    await recordOutcome(db.sql, { userId, taskId: task.id, surface: 'imessage', ref: 'msg-7', status: 'delivered', idempotencyKey: 'redelivered-after-scramble' })
    const final = await storedEqualsRebuild(db, userId, task.id)
    expect(final.sync_state.imessage?.status).toBe('delivered')
    expect(wasAlreadyDelivered(final, 'imessage', 'msg-7')).toBe(true)
  })
})
