import { classifyPendingReply } from './conversationalApproval'
import { executeSpendApproval, fetchSpendState } from './liveContext'
import { setPendingSpend, type ThreadMemory } from './memory'
import type { ClaimLedger } from './claimEvidence'

/** One pending payment decision, shared by both turn paths. Cleared only on a
 * durable receipt (charge, cancellation, expiry), never on prose.
 *
 * The reply router is typed (classifyPendingReply): approve, deny, cancel,
 * question, conditional, correction, status query. This is the fix for two
 * live failures: "did it go through?" used to get the non-approval boilerplate
 * (a status question must be answered from the server row), and "actually nvm
 * dont buy it" used to fall through to the non-approval message, leaving the
 * spend request armed after an explicit cancel. */
export async function pendingSpendReply(input: {
  dataDir: string
  senderId: string
  userText: string
  pending: NonNullable<ThreadMemory['pendingSpend']>
  evidence?: ClaimLedger
  /** Injectable for tests. Defaults to the real server calls. */
  deps?: {
    executeSpendApproval?: typeof executeSpendApproval
    fetchSpendState?: typeof fetchSpendState
  }
}): Promise<string> {
  const { pending } = input
  const decide = input.deps?.executeSpendApproval ?? executeSpendApproval
  const readState = input.deps?.fetchSpendState ?? fetchSpendState
  const kind = classifyPendingReply(input.userText)

  /* A status question reads the durable row. It never approves, never cancels,
   * and never claims an outcome it could not read. */
  if (kind === 'status_query') {
    const state = await readState(input.senderId, pending.id)
    if (!state.ok) {
      input.evidence?.record('purchase', 'outcome_unknown', { read: false })
      return `I could not read the payment state just now, so I won't guess: the pending request is $${pending.amount.toFixed(2)} for ${pending.item}. Nothing is confirmed either way.`
    }
    if (state.state === 'pending_approval') {
      input.evidence?.record('purchase', 'verified_empty', { state: 'pending' })
      return `Still pending: $${pending.amount.toFixed(2)} for ${pending.item}. Not charged. Say "approve" to go ahead or "cancel" to drop it.`
    }
    if (state.state === 'executing') {
      input.evidence?.record('purchase', 'outcome_unknown', { state: 'executing' })
      return `It is mid-execution right now, so I can't confirm the outcome yet. I have kept the request and will report back when it settles.`
    }
    if (state.state === 'succeeded') {
      input.evidence?.record('purchase', 'verified_success', { receipt: true, providerId: state.paymentIntentId || undefined })
      setPendingSpend(input.dataDir, input.senderId)
      return `Confirmed: $${pending.amount.toFixed(2)} was charged for ${pending.item}. Merchant checkout still needs its own receipt.`
    }
    if (state.state === 'cancelled') {
      input.evidence?.record('purchase', 'cancelled')
      setPendingSpend(input.dataDir, input.senderId)
      return `That request was already cancelled — nothing was charged.`
    }
    input.evidence?.record('purchase', 'outcome_unknown', { state: 'unknown' })
    return `The payment service reports the outcome as unknown. I can't tell you whether it went through — check before any retry.`
  }

  /* Cancellation: acts on the durable row when it still can, and reports the
   * typed transition (cancelled vs cancellation_requested vs already placed). */
  if (kind === 'cancel' || kind === 'correction') {
    const result = await decide(input.senderId, pending.id, 'deny', {
      amountCents: Math.round(pending.amount * 100), purpose: pending.item, url: pending.url,
    })
    if (result.ok && result.state === 'cancelled') {
      input.evidence?.record('purchase', 'cancelled', { requestId: pending.id })
      setPendingSpend(input.dataDir, input.senderId)
      const extra = kind === 'correction'
        ? ' Name the replacement and I\'ll stage that one for your approval.'
        : ''
      return `Cancelled the pending approval for ${pending.item} before execution — nothing was charged.${extra}`
    }
    if (result.state === 'executing') {
      input.evidence?.record('purchase', 'cancellation_requested', { requestId: pending.id })
      return 'The operation is already executing. Cancellation was requested but is not confirmed — I have kept the request so its outcome can be checked, and I will not claim it stopped.'
    }
    if (result.state === 'succeeded') {
      input.evidence?.record('purchase', 'already_completed', { requestId: pending.id })
      return 'The merchant order was already placed, so there is nothing left to cancel on my side. Merchant cancellation has to be checked separately; nothing new was charged by this reply.'
    }
    input.evidence?.record('purchase', 'outcome_unknown', { requestId: pending.id })
    return `No cancellation is confirmed. ${result.error || 'The outcome is unknown.'} I have kept the pending request so it can be checked rather than retried blind.`
  }

  /* Approval — only the closed affirmative grammar approves, and conditions
   * never do: the card's terms are immutable, so "yes but only if…" cannot
   * silently approve different terms. */
  if (kind === 'approve') {
    if (Date.now() - pending.createdAt > 10 * 60_000) {
      return 'This purchase approval is stale. Review a fresh checkout with the current price before approving; no payment is confirmed.'
    }
    const result = await decide(input.senderId, pending.id, 'approve', {
      amountCents: Math.round(pending.amount * 100), purpose: pending.item, url: pending.url,
    })
    if (result.ok && result.state === 'succeeded' && result.paymentIntentId) {
      input.evidence?.record('purchase', 'verified_success', { receipt: true, providerId: result.paymentIntentId })
      setPendingSpend(input.dataDir, input.senderId)
      return `Payment received: $${pending.amount.toFixed(2)} for ${pending.item}. Merchant checkout is not yet confirmed; the order needs its own receipt.`
    }
    input.evidence?.record('purchase', 'outcome_unknown', { requestId: pending.id })
    return `No payment is confirmed. ${result.error || 'The outcome could not be verified.'} I have kept the pending request.`
  }

  if (kind === 'conditional') {
    input.evidence?.record('purchase', 'verified_empty', { state: 'pending', conditional: true })
    return `That answer carries a condition, and conditions don't approve the card — the terms are fixed: $${pending.amount.toFixed(2)} for ${pending.item}. Say "cancel" and I'll re-stage it with your condition baked in, or approve the card as-is.`
  }

  if (kind === 'question') {
    input.evidence?.record('purchase', 'verified_empty', { state: 'pending', question: true })
    return `Quick status: $${pending.amount.toFixed(2)} for ${pending.item} is pending your tap on the card — nothing has been charged. Ask me anything about it, or say "approve" / "cancel".`
  }

  /* Deny, chit-chat, anything else: the request stays pending and unapproved. */
  input.evidence?.record('purchase', 'verified_empty', { state: 'pending', untouched: true })
  return `No payment approved. The pending request is $${pending.amount.toFixed(2)} for ${pending.item}. Questions or conditions do not approve it; review the terms before saying yes or cancel.`
}
