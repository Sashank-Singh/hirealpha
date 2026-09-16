import { describe, expect, it } from 'bun:test'
import { kernelBrowserCreatePayload } from './kernelPage'

describe('Kernel browser telemetry configuration', () => {
  it('enables only Kernel lightweight defaults unless explicitly disabled', () => {
    const payload = kernelBrowserCreatePayload({ apiKey: 'test' })
    expect(payload.telemetry).toEqual({ enabled: true })
    expect(JSON.stringify(payload.telemetry)).not.toContain('network')
    expect(JSON.stringify(payload.telemetry)).not.toContain('console')
  })

  it('allows operators to disable telemetry', () => {
    const payload = kernelBrowserCreatePayload({ apiKey: 'test', telemetry: false })
    expect(payload.telemetry).toEqual({ enabled: false })
  })
})
