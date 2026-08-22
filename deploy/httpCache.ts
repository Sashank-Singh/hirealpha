/**
 * The two decisions behind a revalidatable GET, kept out of `hire-api.ts` so
 * they can be tested without a database.
 */

/**
 * A weak validator over the response body. Weak is the honest strength here: the
 * bytes are equivalent for the client's purposes, not byte-identical forever.
 */
export function weakEtag(body: string) {
  return `W/"${Bun.hash(body).toString(36)}"`
}

/**
 * `stale-while-revalidate` lets the browser paint the copy it already has and
 * refresh it behind the paint. Zero seconds means don't: the answer is knowingly
 * incomplete and the client is about to ask again, so a stale hit would defeat it.
 */
export function revalidateCacheControl(swrSeconds: number) {
  if (!Number.isFinite(swrSeconds) || swrSeconds <= 0) return 'private, no-cache'
  return `private, max-age=0, stale-while-revalidate=${Math.floor(swrSeconds)}`
}

/**
 * Weak comparison against an `If-None-Match` header. Browsers echo back exactly
 * what we sent, but a proxy in between may send a list, and may have downgraded
 * a strong tag to weak — RFC 9110 says compare with the `W/` prefix ignored.
 */
export function notModified(ifNoneMatch: string | null | undefined, etag: string) {
  if (!ifNoneMatch || !etag) return false
  const strip = (t: string) => t.trim().replace(/^W\//, '')
  const want = strip(etag)
  if (!want) return false
  return ifNoneMatch
    .split(',')
    .map(strip)
    .some((t) => t === want || t === '*')
}
