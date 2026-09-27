/** Batching is here to answer three texts with one reply, not to sit on a
 * message: every millisecond of quiet is a millisecond the user is staring at
 * a thread that has not answered, so the window is as short as it can be while
 * still catching a burst typed in one go. */
export const BURST_QUIET_MS = 500
/** After this long a still-arriving burst is answered anyway. */
export const BURST_MAX_WAIT_MS = 1_200

/** Coalesce rapid texts without blocking ingestion or other conversations.
 * Active work is never restarted: messages arriving during it form the next
 * turn, which starts only after the current turn finishes. State is in memory. */
export function createMessageBursts<T>(options: {
  run: (items: T[]) => Promise<void>
  onError: (error: unknown) => void
  quietMs?: number
  maxWaitMs?: number
  now?: () => number
  schedule?: (fn: () => void, ms: number) => unknown
  cancel?: (timer: unknown) => void
  isInterrupt?: (item: T) => boolean
  /** Runs synchronously at ingestion so cancellation does not wait behind work. */
  onInterrupt?: (key: string, item: T) => void
}) {
  const quietMs = options.quietMs ?? BURST_QUIET_MS
  const maxWaitMs = options.maxWaitMs ?? BURST_MAX_WAIT_MS
  const now = options.now ?? Date.now
  const schedule = options.schedule ?? ((fn, ms) => setTimeout(fn, ms))
  const cancel = options.cancel ?? ((timer) => clearTimeout(timer as ReturnType<typeof setTimeout>))
  type Entry = { item: T; at: number; batchable: boolean }
  type State = { pending: Entry[]; running: boolean; timer?: unknown }
  const states = new Map<string, State>()

  function pump(key: string, state: State) {
    if (state.running) return
    if (state.timer !== undefined) { cancel(state.timer); state.timer = undefined }
    const first = state.pending[0]
    if (!first) { states.delete(key); return }
    let count = 1
    if (first.batchable) {
      while (count < state.pending.length && state.pending[count]!.batchable) count++
    }
    // A media boundary closes the preceding text burst immediately.
    const due = first.batchable && count === state.pending.length
      ? Math.min(first.at + maxWaitMs, state.pending[count - 1]!.at + quietMs)
      : now()
    if (due > now()) {
      state.timer = schedule(() => { state.timer = undefined; pump(key, state) }, due - now())
      return
    }
    const batch = state.pending.splice(0, count).map(entry => entry.item)
    state.running = true
    void Promise.resolve().then(() => options.run(batch)).catch(options.onError).finally(() => {
      state.running = false
      pump(key, state)
    })
  }

  return {
    enqueue(key: string, item: T, batchable = true) {
      let state = states.get(key)
      if (!state) { state = { pending: [], running: false }; states.set(key, state) }
      if (state.running && options.isInterrupt?.(item)) options.onInterrupt?.(key, item)
      state.pending.push({ item, at: now(), batchable })
      pump(key, state)
    },
  }
}
