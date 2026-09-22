/** Delivery retries must reuse the completed turn, not run its tools again. */
export function onceAsync<T>(run: () => Promise<T>): () => Promise<T> {
  let result: Promise<T> | undefined
  return () => result ??= Promise.resolve().then(run)
}

/**
 * How often a bot looks for something to deliver.
 *
 * A proactive text is only as timely as this number: at 60s every alert was
 * up to a minute stale on top of the armer's own cadence, which is the
 * difference between telling someone about a mail while it still matters and
 * telling them about it. Ten seconds is the floor worth paying for; the
 * per-poll cost is one indexed claim query, and every send path is guarded by
 * a server-side atomic claim, so a faster poll cannot double-fire anything.
 */
export const PROACTIVE_POLL_MS = 10_000

/**
 * The wall clock a plain conversational reply is allowed, from the moment the
 * turn starts. A text has no loading state: past this the user has already
 * decided the assistant is slow, whatever the eventual answer says. Anything
 * that leaves the conversation for the real world (a lookup, a browser run)
 * is exempt — that work is visible and expected to take longer.
 *
 * Sized against the stated bar of ten seconds end to end, which has to include
 * the burst window the turn waits out before it starts (1.2s).
 */
export const FAST_REPLY_WALL_MS = 8_500

/**
 * The attempt budget and the wall for one fast conversational reply.
 *
 * The default attempt (6s) against the default wall (8.5s) leaves ~2.5s — under
 * the retry threshold, so on a slow model the retry never runs and the turn goes
 * straight to the canned local line. Live, 2026-09-21, that is exactly what
 * happened to a brand-new user's first message: "Hey, Alpha!" timed out, the log
 * read `fast GMI failed with 2497ms left, going local`, and the first thing that
 * person ever received from their new assistant was "I hit a quick snag thinking
 * through that. Can you say that once more?".
 *
 * A FIRST message is the coldest call the system makes — fresh provider
 * connection, no warm cache — and the one reply that must not be canned, so it
 * gets a budget that can absorb a timeout and still retry. Everyone else keeps the
 * fast path: past ten seconds a reply reads as slow, and an established thread can
 * afford to wait for the next one.
 */
export function fastReplyBudget(opts: { firstContact: boolean; configuredMs?: number }): { attemptMs: number; wallMs: number } {
  const configured = Math.min(15_000, Math.max(2_500, Number(opts.configuredMs) || 6_000))
  if (!opts.firstContact) return { attemptMs: configured, wallMs: FAST_REPLY_WALL_MS }
  return {
    attemptMs: Math.max(configured, 12_000),
    // Enough wall left for one retry at the attempt budget above.
    wallMs: Math.max(FAST_REPLY_WALL_MS, 12_000 + 4_000),
  }
}

/**
 * After a send fails for a reason that is not a blocked recipient, wait this
 * long before trying that same item again. Without it a fast poll turns one
 * broken RPC into an attempt every cycle — the 09-15 all-night SetTyping
 * storm, at whatever the poll interval happens to be.
 */
export const SEND_FAILURE_BACKOFF_MS = 10 * 60_000

/** Retry only reply generation, never a turn that may have executed tools.
 * A fast-path deadline is a latency target, not permission to drop the ask.
 * Keep the same context and give one recovery attempt a useful budget. */
export async function recoverChatReply(
  ask: (timeoutMs: number) => Promise<string>,
  attemptMs: number,
): Promise<string> {
  const attempt = async (timeoutMs: number) => {
    const reply = (await ask(timeoutMs)).trim()
    if (!reply) throw new Error('Empty conversational reply')
    return reply
  }
  try {
    return await attempt(attemptMs)
  } catch {
    return await attempt(20_000)
  }
}

export const CHAT_UNAVAILABLE_REPLY = "I'm unable to answer right now because my response service is unavailable. Your question is still in this conversation."
