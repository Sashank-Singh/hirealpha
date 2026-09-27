import { isAffirmativeApprovalIntent, isNegativeCancellationIntent } from './conversationalApproval'
import { executeSpendApproval } from './liveContext'
import { setPendingSpend, type ThreadMemory } from './memory'

/** One pending payment decision, shared by both turn paths. Clear only on a receipt. */
export async function pendingSpendReply(input: {
  dataDir: string; senderId: string; userText: string; pending: NonNullable<ThreadMemory['pendingSpend']>
}): Promise<string> {
  const { pending } = input
  const deny = isNegativeCancellationIntent(input.userText)
  if (!deny && !isAffirmativeApprovalIntent(input.userText)) {
    return `No payment approved. The pending request is $${pending.amount.toFixed(2)} for ${pending.item}. Questions or conditions do not approve it; review the terms before saying yes or cancel.`
  }
  if (!deny && Date.now() - pending.createdAt > 10 * 60_000) {
    return 'This purchase approval is stale. Review a fresh checkout with the current price before approving; no payment is confirmed.'
  }
  const result = await executeSpendApproval(input.senderId, pending.id, deny ? 'deny' : 'approve', {
    amountCents: Math.round(pending.amount * 100), purpose: pending.item, url: pending.url,
  })
  if (result.ok && result.state === 'cancelled') {
    setPendingSpend(input.dataDir, input.senderId)
    return `Cancelled the pending approval for ${pending.item}. This does not cancel an order already placed with a merchant.`
  }
  if (result.ok && result.state === 'succeeded' && result.paymentIntentId) {
    setPendingSpend(input.dataDir, input.senderId)
    return `Payment received: $${pending.amount.toFixed(2)} for ${pending.item}. Merchant checkout is not yet confirmed; the order needs its own receipt.`
  }
  if (deny && result.state === 'succeeded') return 'The merchant order is already placed. I have not cancelled it; merchant cancellation must be checked separately.'
  if (result.state === 'executing') return 'The operation is already executing. Cancellation is not confirmed; I have kept the request so its outcome can be checked.'
  return `No ${deny ? 'cancellation' : 'payment'} is confirmed. ${result.error || 'The outcome is unknown.'} I have kept the pending request.`
}
