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
 * After a send fails for a reason that is not a blocked recipient, wait this
 * long before trying that same item again. Without it a fast poll turns one
 * broken RPC into an attempt every cycle — the 09-15 all-night SetTyping
 * storm, at whatever the poll interval happens to be.
 */
export const SEND_FAILURE_BACKOFF_MS = 10 * 60_000
