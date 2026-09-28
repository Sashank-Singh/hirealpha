import { describe, expect, test } from 'bun:test'

/**
 * Fail-closed execution backend regression.
 *
 * The audit found that an unconfigured HIREALPHA_API_URL silently launched
 * REAL local Playwright sessions against public websites. After the fix, an
 * unconfigured backend must:
 *   - not launch any browser,
 *   - not navigate anywhere,
 *   - return a typed execution_backend_unavailable error,
 *   - produce an honest "nothing was started" reply surface.
 * Local execution stays possible only behind ALLOW_LOCAL_BROWSER_EXECUTION=1
 * (default OFF; deliberately not exercised in tests so no suite ever drives a
 * real browser).
 */
describe('execution backend fail-closed', () => {
  test('unconfigured backend refuses browser work without any navigation', async () => {
    const prevUrl = process.env.HIREALPHA_API_URL
    const prevKey = process.env.HIREALPHA_INTERNAL_KEY
    const prevFlag = process.env.ALLOW_LOCAL_BROWSER_EXECUTION
    delete process.env.HIREALPHA_API_URL
    delete process.env.HIREALPHA_INTERNAL_KEY
    delete process.env.ALLOW_LOCAL_BROWSER_EXECUTION
    const navigations: string[] = []
    const realFetch = globalThis.fetch
    globalThis.fetch = (async (input: Parameters<typeof fetch>[0]) => {
      navigations.push(String(input instanceof Request ? input.url : input))
      return new Response('{}', { status: 503 })
    }) as typeof fetch
    try {
      const { proposeBrowserTask } = await import('./liveContext')
      const out = await proposeBrowserTask('+15550001111', 'friend', {
        portal: 'https://runnerreg.io',
        goal: 'Register Alex Rivera for the Founders Run Club',
      })
      expect(out.ok).toBe(false)
      expect(String(out.error)).toContain('execution_backend_unavailable')
      expect(String(out.error)).toMatch(/NOT started|was NOT started|not started/i)
      expect(out.sessionUrl).toBeUndefined()
      expect(out.id).toBeUndefined()
      // Not a single network navigation may leave the process.
      expect(navigations).toEqual([])
    } finally {
      globalThis.fetch = realFetch
      if (prevUrl !== undefined) process.env.HIREALPHA_API_URL = prevUrl
      if (prevKey !== undefined) process.env.HIREALPHA_INTERNAL_KEY = prevKey
      if (prevFlag !== undefined) process.env.ALLOW_LOCAL_BROWSER_EXECUTION = prevFlag
    }
  })

  test('the dev-only flag labels local sessions as local, never as server sessions', async () => {
    // Source-level pin: even with the flag ON, the session link scheme must
    // carry "local://" so no UI can mistake it for a real server session.
    const src = await Bun.file(new URL('./liveContext.ts', import.meta.url)).text()
    expect(src).toContain("ALLOW_LOCAL_BROWSER_EXECUTION === '1'")
    expect(src).toContain('local://browser/')
  })
})
