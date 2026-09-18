/* One place that asks the server whether the paid product is on.
 *
 * Payments are off while HireAlpha is free to use: no price should be drawn and
 * no checkout opened. The answer is cached for the page's lifetime because it
 * is the same for everyone, and a failed fetch assumes FREE — showing a price
 * we might not charge is worse than showing none. Flip it back by setting
 * HIREALPHA_PAYMENTS=1 on the Web app; nothing here changes. */

let cached: Promise<boolean> | null = null

export function paymentsEnabled(): Promise<boolean> {
  if (!cached) {
    cached = fetch('/api/config')
      .then((res) => (res.ok ? (res.json() as Promise<{ payments?: boolean }>) : { payments: false }))
      .then((data) => data.payments === true)
      .catch(() => false)
  }
  return cached
}

/** Test seam: forget the cached answer. */
export function resetPaymentsCache() {
  cached = null
}
