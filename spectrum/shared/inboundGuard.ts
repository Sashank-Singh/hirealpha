const SEEN_TTL_MS = 10 * 60 * 1000
const seen = new Map<string, number>()

/** Claim an inbound event once so provider retries cannot send duplicate replies. */
export function claimInbound(messageId: string): boolean {
  const now = Date.now()
  for (const [id, timestamp] of seen) {
    if (now - timestamp > SEEN_TTL_MS) seen.delete(id)
  }

  if (seen.has(messageId)) return false
  seen.set(messageId, now)
  return true
}
