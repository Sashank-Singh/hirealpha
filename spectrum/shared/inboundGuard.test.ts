import { describe, expect, it } from 'bun:test'
import { claimInbound } from './inboundGuard'

describe('inbound message identity', () => {
  it('accepts repeated intentional requests with distinct provider IDs', () => {
    expect(claimInbound('repeat-user', 'Apps', 'a')).toBe(true)
    expect(claimInbound('repeat-user', 'Apps', 'b')).toBe(true)
  })
  it('rejects redelivery of the same ID even if its text changed', () => {
    expect(claimInbound('retry-user', 'Hello', 'same')).toBe(true)
    expect(claimInbound('retry-user', 'Hello again', 'same')).toBe(false)
  })
  it('scopes provider IDs to the sender', () => {
    expect(claimInbound('person-a', 'Apps', 'shared-id')).toBe(true)
    expect(claimInbound('person-b', 'Apps', 'shared-id')).toBe(true)
  })
  it('does not collapse distinct emoji or non-Latin text without IDs', () => {
    for (const text of ['👍', '👎', '你好', '再见']) {
      expect(claimInbound('unicode-user', text)).toBe(true)
    }
    expect(claimInbound('unicode-user', '👍')).toBe(false)
  })
})
