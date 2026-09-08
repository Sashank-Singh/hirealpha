export const REACTIONS = ['❤️', '😂', '🎉', '👀', '👍'] as const
export type Reaction = typeof REACTIONS[number]
export type DeliveryHooks = {
  onProgress?: (text: string) => Promise<void>
  onReaction?: (reaction: Reaction) => Promise<void>
}

/** No extra model calls. At most two intermediate texts, with a quiet period
 * for fast replies. Failed/ambiguous sends consume their slot and aren't retried. */
export function createProgressiveDelivery(hooks: DeliveryHooks, options: { quietMs?: number; now?: () => number } = {}) {
  const now = options.now ?? Date.now
  const quietMs = options.quietMs ?? 2500
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
    if (!REACTIONS.includes(reaction) || last.has(key)) return
    last.set(key, time)
    try { await send(reaction) } catch { /* An optional reaction must not fail the task. */ }
  }
}
