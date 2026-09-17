export const REACTIONS = ['❤️', '😂', '🎉', '👀', '👍', '✈️', '🍽️', '⏲️', '🔍', '✅'] as const
export type Reaction = string
export type DeliveryHooks = {
  onProgress?: (text: string) => Promise<void>
  onReaction?: (reaction: Reaction) => Promise<void>
}

/** No extra model calls. At most two intermediate texts, with a quiet period
 * for fast replies. Failed/ambiguous sends consume their slot and aren't retried. */
export function createProgressiveDelivery(hooks: DeliveryHooks, options: { quietMs?: number; now?: () => number } = {}) {
  const now = options.now ?? Date.now
  // A stage acknowledgement ("checking your email...") exists to answer the
  // silence while real work runs, so it has to land while the user is still
  // waiting. At 2500ms it arrived after most fast replies already had.
  const quietMs = options.quietMs ?? 1_200
  const began = now()
  let attempts = 0, lastAt = -Infinity
  const seen = new Set<string>()
  const delivered: string[] = []
  let chain = Promise.resolve()
  const publish = (text: string) => {
    let success = false
    const next = chain.then(async () => {
      const clean = text.trim()
      if (!hooks.onProgress || now() - began < quietMs || now() - lastAt < 1500 || attempts >= 2 || !clean || clean.length > 650 || seen.has(clean)) return
      attempts++; lastAt = now(); seen.add(clean)
      try { await hooks.onProgress(clean); delivered.push(clean); success = true } catch { /* Delivery is uncertain; do not resend. */ }
    })
    chain = next
    return next.then(() => success)
  }
  return {
    delivered,
    publish,
    async stage<T>(label: string, work: () => Promise<T>): Promise<T> {
      let pending: Promise<boolean> | undefined
      const timer = hooks.onProgress && attempts === 0 ? setTimeout(() => { pending = publish(label) }, Math.max(quietMs - (now() - began), 0)) : undefined
      try { return await work() }
      finally { clearTimeout(timer); await pending }
    },
  }
}

/** A conversation may react occasionally; never react to every text in a burst. */
export function createReactionGate(now: () => number = Date.now, cooldownMs = 180_000) {
  const last = new Map<string, number>()
  return async (key: string, reaction: Reaction, send: (reaction: Reaction) => Promise<unknown>) => {
    const time = now()
    for (const [user, at] of last) if (time - at >= cooldownMs) last.delete(user)
    if (!reaction || last.has(key)) return
    last.set(key, time)
    try { await send(reaction) } catch { /* An optional reaction must not fail the task. */ }
  }
}

/** A person texting a thought in parts pauses between them; the cadence is most
 * of what makes a burst read as typing rather than as a delivered message. */
export const BUBBLE_GAP_MIN_MS = 400
export const BUBBLE_GAP_MAX_MS = 900

/**
 * Gap before bubble `index` (0-based, where 0 already went out as the reply).
 * Deterministic per index so a retry reproduces the same cadence. Later
 * bubbles get the longer end of the range — a three-part reply that lands every
 * bubble at the same offset sounds like a queue draining.
 */
export function bubbleGapMs(index: number, jitter = 0): number {
  const span = BUBBLE_GAP_MAX_MS - BUBBLE_GAP_MIN_MS
  const base = BUBBLE_GAP_MIN_MS + (span * Math.min(Math.max(index - 1, 0), 2)) / 2
  const offset = Math.abs(Math.round(jitter)) % (span + 1)
  return Math.min(BUBBLE_GAP_MAX_MS, Math.max(BUBBLE_GAP_MIN_MS, Math.round(base) + (offset - span / 2)))
}

