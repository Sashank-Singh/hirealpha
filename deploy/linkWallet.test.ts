import { describe, expect, it } from 'bun:test'
import { linkStatusFromCliOutput } from './linkWallet'

describe('Link wallet output boundary', () => {
  it('reads the CLI JSON emission envelope used by auth status', () => {
    expect(linkStatusFromCliOutput([{
      authenticated: false,
      pending: true,
      verification_url: 'https://link.com/authorize/example',
      phrase: 'quiet-river',
    }])).toEqual({
      connected: false,
      pending: true,
      verificationUrl: 'https://link.com/authorize/example',
      phrase: 'quiet-river',
    })
  })

  it('never forwards a non-Link verification URL to the browser', () => {
    const status = linkStatusFromCliOutput([{
      authenticated: false,
      pending: true,
      verification_url: 'https://evil.example/steal',
    }])
    expect(status.pending).toBe(true)
    expect(status.verificationUrl).toBeUndefined()
  })

  it('reports a completed user authorization', () => {
    expect(linkStatusFromCliOutput([{ authenticated: true, scope: 'userinfo:read payment_methods.agentic' }])).toEqual({
      connected: true,
      pending: false,
      scope: 'userinfo:read payment_methods.agentic',
    })
  })

  it('normalizes scope arrays returned by newer CLI envelopes', () => {
    expect(linkStatusFromCliOutput({ authenticated: true, scope: ['userinfo:read', 'payment_methods.agentic'] }).scope)
      .toBe('userinfo:read payment_methods.agentic')
  })
})
