/** Delivery retries must reuse the completed turn, not run its tools again. */
export function onceAsync<T>(run: () => Promise<T>): () => Promise<T> {
  let result: Promise<T> | undefined
  return () => result ??= Promise.resolve().then(run)
}
