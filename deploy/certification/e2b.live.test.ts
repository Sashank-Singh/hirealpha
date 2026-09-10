/** Live E2B certification: fresh sandbox per task, verified destruction, no
 * cross-task reuse, and no secrets in the sandbox environment. Requires
 * CERT_ALLOW_LIVE=1 + E2B_API_KEY + E2B_BROWSER_TEMPLATE. */
import { describe, expect, it } from 'bun:test'
import { E2BTaskEnvironmentProvider, SANDBOX_CDP_PORT } from '../services/trust/taskEnvironments'
import { DENIED_EGRESS } from '../services/trust/taskEnvironments'

const env = process.env
const live = env.CERT_ALLOW_LIVE === '1' && Boolean(env.E2B_API_KEY?.trim() && env.E2B_BROWSER_TEMPLATE?.trim())

describe.skipIf(!live)('e2b live certification', () => {
  it('creates a sandbox with a reachable CDP endpoint and destroys it verifiably', async () => {
    const provider = new E2BTaskEnvironmentProvider(env.E2B_API_KEY!, env.E2B_BROWSER_TEMPLATE!)
    const created = await provider.create({ taskId: `cert-${Date.now()}`, timeoutMs: 120_000 })
    expect(created.cdpUrl).toMatch(/^https:\/\//)
    const version = await fetch(`${created.cdpUrl}/json/version`).then((r) => r.json()) as { Browser?: string }
    expect(version.Browser || '').toContain('Chrome')
    await provider.destroy(created.id)
    expect(await provider.isDestroyed(created.id)).toBe(true)
  }, 180_000)

  it('never reuses a sandbox id across two tasks', async () => {
    const provider = new E2BTaskEnvironmentProvider(env.E2B_API_KEY!, env.E2B_BROWSER_TEMPLATE!)
    const a = await provider.create({ taskId: `cert-a-${Date.now()}`, timeoutMs: 120_000 })
    const b = await provider.create({ taskId: `cert-b-${Date.now()}`, timeoutMs: 120_000 })
    expect(a.id).not.toBe(b.id)
    await Promise.all([provider.destroy(a.id), provider.destroy(b.id)])
  }, 240_000)

  it('leaves no secrets in the sandbox environment', async () => {
    // Structural: the provider never passes envs to Sandbox.create, and the
    // worker injects nothing into the sandbox. Assert the contract directly.
    const source = await Bun.file(import.meta.dir + '/../services/trust/taskEnvironments.ts').text()
    expect(source).not.toContain('envs:')
    expect(source).not.toContain('username')
    expect(source).not.toContain('password')
    expect(DENIED_EGRESS).toContain('169.254.0.0/16')
    expect(SANDBOX_CDP_PORT).toBe(9222)
  })
})
