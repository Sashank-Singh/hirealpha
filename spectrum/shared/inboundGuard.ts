const SEEN_TTL_MS = 10 * 60 * 1000
const TEXT_DEDUPE_MS = 3000
const seen = new Map<string, number>()

/**
 * Provider IDs identify deliveries, not their text: a user can intentionally
 * repeat "Apps" or "yes". Without an ID, only suppress exact immediate repeats.
 * Preserve Unicode and punctuation so unrelated messages never collide.
 */
export function claimInbound(senderId: string, userText: string, messageId?: string): boolean {
  const now = Date.now()
  for (const [id, timestamp] of seen) {
    if (now - timestamp > SEEN_TTL_MS) seen.delete(id)
  }

  const key = JSON.stringify([senderId, messageId ? 'id' : 'text', messageId || userText.trim()])
  const last = seen.get(key)
  if (last !== undefined && now - last < (messageId ? SEEN_TTL_MS : TEXT_DEDUPE_MS)) return false
  seen.set(key, now)
  return true
}
