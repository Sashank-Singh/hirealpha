import { setPendingSpend, setPendingVaultTask, setPendingConnection, loadMemory } from './memory'
import type { ClaimLedger } from './claimEvidence'

/**
 * cancel_work — one typed surface for "stop / cancel that / nvm / don't do it".
 *
 * Resolution is durable-state-driven, never prose-reconstruction: pending
 * spend (thread), the latest browser job, watch loops, email follow-up
 * watches, and scheduled texts are read from the server and cancelled by ID.
 * Every result is a typed state so the reply can never collapse
 * "cancelled before execution" into "cancellation requested" into "nothing
 * was running":
 *
 *   cancelled_before_execution  authoritative: the row never dispatched.
 *   cancellation_requested      dispatched already; the worker may have
 *                               committed steps — never reported as a
 *                               confirmed cancel.
 *   already_completed           finished; nothing to cancel (reported, not
 *                               hidden).
 *   not_cancellable             nothing matching exists.
 *   outcome_unknown             the cancel write itself failed.
 */

export type CancelOutcome =
  | 'cancelled_before_execution'
  | 'cancellation_requested'
  | 'already_completed'
  | 'not_cancellable'
  | 'outcome_unknown'

export interface CancelTargetResult {
  target: string
  id: string | null
  outcome: CancelOutcome
  priorStatus?: string | null
}

export interface CancelWorkResult {
  reply: string
  results: CancelTargetResult[]
  /** True when at least one durable artifact is still active after this. */
  anythingStillActive: boolean
}

export type CancelCall = (path: string, body: Record<string, unknown>) => Promise<Record<string, unknown>>

const OUTCOME_PHRASE: Record<CancelOutcome, string> = {
  cancelled_before_execution: 'cancelled before it ran',
  cancellation_requested: 'cancel requested — it was already in flight, so I will confirm once it actually stops',
  already_completed: 'had already finished, so there was nothing left to cancel',
  not_cancellable: 'not found among active work',
  outcome_unknown: 'could not be confirmed — I will not claim it either way',
}

const LABEL: Record<string, string> = {
  work: 'the cancel itself',
  browser: 'the browser run',
  watch: 'the watch',
  followup: 'the reply watch',
  scheduled_text: 'the scheduled text',
  purchase: 'the pending purchase',
}

/** Domain hints in the ask narrow what "cancel that" means. No hint → cancel
 * everything active (the safe reading of a bare "nvm"). */
function requestedDomains(text: string): string[] | null {
  const t = text.toLowerCase()
  if (/\b(?:buy|order|purchase|pay|charge)\b/.test(t)) return ['purchase']
  if (/\bwatch|track|monitor|price drop|restock|back in stock\b/.test(t)) return ['watch']
  if (/\brepl(?:y|ies)|follow[- ]?up|nudge\b/.test(t)) return ['followup']
  if (/\b(?:book|register|checkout|sign ?up|submit|run|browser|computer|website|site|portal)\b/.test(t)) return ['browser']
  if (/\btext|message|send later|tomorrow morning\b/.test(t)) return ['scheduled_text']
  return null
}

export async function cancelWork(input: {
  dataDir: string
  senderId: string
  userText: string
  evidence?: ClaimLedger
  /** Injectable server caller for tests. Defaults to real internal API. */
  call?: CancelCall
}): Promise<CancelWorkResult> {
  const call: CancelCall = input.call ?? defaultCall(input.senderId)
  const results: CancelTargetResult[] = []
  const domains = requestedDomains(input.userText)
  const mem = loadMemory(input.dataDir, input.senderId)

  /* 1. Pending purchase — cancel through the spend gate's deny path. */
  if (mem.pendingSpend && (!domains || domains.includes('purchase'))) {
    const row = await call('/api/internal/spend/state', { requestId: mem.pendingSpend.id }).catch(() => ({ ok: false }))
    const priorState = String((row as { state?: string }).state || 'pending_approval')
    if (priorState === 'succeeded') {
      results.push({ target: 'purchase', id: mem.pendingSpend.id, outcome: 'already_completed', priorStatus: 'succeeded' })
      input.evidence?.record('purchase', 'already_completed', { requestId: mem.pendingSpend.id })
    } else if (priorState === 'outcome_unknown' || priorState === 'executing') {
      results.push({ target: 'purchase', id: mem.pendingSpend.id, outcome: 'cancellation_requested', priorStatus: priorState })
      input.evidence?.record('purchase', 'cancellation_requested', { requestId: mem.pendingSpend.id })
    } else {
      const decided = await call('/api/internal/spend/decide', {
        phone: input.senderId, requestId: mem.pendingSpend.id, decision: 'deny',
        terms: { amountCents: Math.round(mem.pendingSpend.amount * 100), purpose: mem.pendingSpend.item, url: mem.pendingSpend.url },
      }).catch((err: Error) => ({ ok: false, error: err.message }))
      if ((decided as { ok?: boolean }).ok) {
        results.push({ target: 'purchase', id: mem.pendingSpend.id, outcome: 'cancelled_before_execution', priorStatus: 'pending_approval' })
        input.evidence?.record('purchase', 'cancelled', { requestId: mem.pendingSpend.id })
      } else {
        results.push({ target: 'purchase', id: mem.pendingSpend.id, outcome: 'outcome_unknown' })
        input.evidence?.record('purchase', 'outcome_unknown', { requestId: mem.pendingSpend.id })
      }
    }
    const decidedOk = results.some((r) => r.target === 'purchase' && r.outcome !== 'outcome_unknown')
    if (decidedOk || priorState === 'succeeded') setPendingSpend(input.dataDir, input.senderId)
  }

  /* 2–5. Server-side durable work: ONE call carrying the target kinds; the
   * server answers with one typed row per target, so nothing is duplicated
   * and nothing is reconstructed here. */
  if (!domains || domains.some((d) => d !== 'purchase')) {
    const kinds = domains ? domains.filter((d) => d !== 'purchase') : (['browser', 'watch', 'followup', 'scheduled_text'] as const)
    if (kinds.length) {
      const res = await call('/api/internal/work/cancel', { phone: input.senderId, kinds }).catch((err: Error) => ({
        ok: false, error: err.message,
      }))
      const rows = (res as { results?: Array<{ target: string; id: string | null; state: string; priorStatus?: string | null }> }).results || []
      if (!rows.length && (res as { ok?: boolean }).ok === false) {
        /* The cancel call itself failed: record outcome_unknown so the reply
         * can never claim either success or failure. */
        for (const kind of kinds) {
          results.push({ target: kind, id: null, outcome: 'outcome_unknown' })
          input.evidence?.record(kind as 'browser', 'outcome_unknown', { kind })
        }
      }
      for (const row of rows) {
        const outcome = normalize(row.state)
        results.push({ target: row.target, id: row.id, outcome, priorStatus: row.priorStatus })
        input.evidence?.record(
          row.target as 'browser' | 'watch' | 'followup' | 'scheduled_text',
          outcome === 'cancelled_before_execution' ? 'cancelled'
            : outcome === 'cancellation_requested' ? 'cancellation_requested'
            : outcome === 'already_completed' ? 'already_completed'
            : outcome === 'outcome_unknown' ? 'outcome_unknown'
            : 'verified_empty',
          { id: row.id ?? undefined, priorStatus: row.priorStatus ?? undefined },
        )
      }
    }
  }

  /* 6. Local pending artifacts (vault tasks, connections) clear on cancel. */
  clearLocalPending(input.dataDir, input.senderId)

  const anythingStillActive = results.some((r) => r.outcome === 'cancellation_requested' || r.outcome === 'outcome_unknown')
  const reply = buildReply(results, domains)
  return { reply, results, anythingStillActive }
}

function normalize(state: string): CancelOutcome {
  if (state === 'cancelled_before_execution') return 'cancelled_before_execution'
  if (state === 'cancellation_requested') return 'cancellation_requested'
  if (state === 'already_completed') return 'already_completed'
  if (state === 'outcome_unknown') return 'outcome_unknown'
  return 'not_cancellable'
}

function buildReply(results: CancelTargetResult[], domains: string[] | null): string {
  if (!results.length) {
    return 'Nothing was running on my side to cancel — the durable work list shows no active jobs, watches, follow-ups, or pending purchases.'
  }
  const lines = results.map((r) => `${LABEL[r.target] || r.target}: ${OUTCOME_PHRASE[r.outcome]}.`)
  if (results.some((r) => r.outcome === 'cancellation_requested')) {
    lines.push('I will confirm each one as the cancel lands — until then treat them as possibly still running.')
  }
  return lines.join(' ')
}

function clearLocalPending(dataDir: string, senderId: string) {
  const mem = loadMemory(dataDir, senderId)
  if (mem.pendingVaultTask) setPendingVaultTask(dataDir, senderId, undefined)
  if (mem.pendingConnection) setPendingConnection(dataDir, senderId, undefined)
}

function defaultCall(senderId: string): CancelCall {
  return async (path, body) => {
    const { timedFetch, authHeaders, apiBase } = await import('./liveContext')
    const base = apiBase()
    if (!base) throw new Error('not configured')
    const res = await timedFetch(`${base}${path}`, {
      method: 'POST',
      headers: { ...(authHeaders() as Record<string, string>), 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }, 10000)
    return await res.json().catch(() => ({})) as Record<string, unknown>
  }
}
