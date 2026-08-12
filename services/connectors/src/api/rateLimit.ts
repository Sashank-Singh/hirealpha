/** Simple in-memory sliding-window rate limiter (per user / IP). */
export class RateLimiter {
  private hits = new Map<string, number[]>()

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
  ) {}

  check(key: string, now = Date.now()): boolean {
    const cutoff = now - this.windowMs
    const prev = (this.hits.get(key) ?? []).filter((t) => t >= cutoff)
    if (prev.length >= this.limit) {
      this.hits.set(key, prev)
      return false
    }
    prev.push(now)
    this.hits.set(key, prev)
    return true
  }
}
