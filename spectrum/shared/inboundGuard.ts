const SEEN_TTL_MS = 10 * 60 * 1000
const seen = new Map<string, number>()

/** Normalize an inbound text so the same question from the same sender is one turn. */
function turnKey(senderId: string, userText: string): string {
  return `${senderId}|${userText.replace(/[^\w]+/g, ' ').trim().toLowerCase()}`
}

/**
 * Claim an inbound turn once. Keyed on sender + normalized text so the same
 * message redelivered under a second message.id cannot produce two replies.
 * The raw message id is still tracked so distinct texts on one id also dedupe.
 */
export function claimInbound(senderId: string, userText: string, messageId?: string): boolean {
  const now = Date.now()
  for (const [id, timestamp] of seen) {
    if (now - timestamp > SEEN_TTL_MS) seen.delete(id)
  }

  const key = turnKey(senderId, userText)
  if (seen.has(key)) return false
  seen.set(key, now)
  if (messageId && messageId !== key) seen.set(messageId, now)
  return true
}