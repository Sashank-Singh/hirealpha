import { afterEach, describe, expect, it } from 'bun:test'
import { kernelPaymentsReady, resetKernelProjectCacheForTest } from './linkWallet'

const realFetch = globalThis.fetch
const realKey = process.env.KERNEL_API_KEY
const realProject = process.env.KERNEL_PROJECT_ID
afterEach(() => {
  resetKernelProjectCacheForTest()
  globalThis.fetch = realFetch
  if (realKey === undefined) delete process.env.KERNEL_API_KEY
  else process.env.KERNEL_API_KEY = realKey
  if (realProject === undefined) delete process.env.KERNEL_PROJECT_ID
  else process.env.KERNEL_PROJECT_ID = realProject
})

/* Live failure this covers: production answered the Settings "Connect Link"
 * button with "KERNEL_API_KEY and KERNEL_PROJECT_ID are required for browser
 * payments." — the key was set, the project id was not, and the whole Link
 * wallet path was dead behind a developer-shaped message. */
describe('payment readiness without a hand-filled project id', () => {
  it('is not ready when the API key itself is missing', async () => {
    delete process.env.KERNEL_API_KEY
    delete process.env.KERNEL_PROJECT_ID
    expect(await kernelPaymentsReady()).toBe(false)
  })

  it('resolves the project from the API when only the key is set', async () => {
    process.env.KERNEL_API_KEY = 'test-key'
    delete process.env.KERNEL_PROJECT_ID
    let called = ''
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      called = String(input)
      return new Response(JSON.stringify([{ id: 'proj-1', name: 'Default', status: 'active' }]), { status: 200 })
    }) as unknown as typeof fetch
    expect(await kernelPaymentsReady()).toBe(true)
    expect(called).toContain('onkernel.com/projects')
  })

  it('is not ready when the API refuses the lookup', async () => {
    resetKernelProjectCacheForTest()
    process.env.KERNEL_API_KEY = 'test-key'
    delete process.env.KERNEL_PROJECT_ID
    globalThis.fetch = (async () => new Response('nope', { status: 401 })) as unknown as typeof fetch
    expect(await kernelPaymentsReady()).toBe(false)
  })
})
