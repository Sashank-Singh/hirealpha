/**
 * Single-flight mutex keyed by string.
 * TODO(multi-instance): replace with a distributed lock (e.g. Redis SET NX + TTL)
 * once this service runs on more than one process.
 */
export class KeyedMutex {
  private locks = new Map<string, Promise<void>>()

  async runExclusive<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.locks.get(key) ?? Promise.resolve()
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const chain = prev.then(() => gate)
    this.locks.set(key, chain)

    await prev
    try {
      return await fn()
    } finally {
      release()
      if (this.locks.get(key) === chain) this.locks.delete(key)
    }
  }
}
