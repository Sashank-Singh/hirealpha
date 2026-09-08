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
}) {
  const quietMs = options.quietMs ?? 1800
  const maxWaitMs = options.maxWaitMs ?? 6000
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
      state.pending.push({ item, at: now(), batchable })
      pump(key, state)
    },
  }
}
