import { describe, expect, it } from 'bun:test'
import { assertPublicHttpsUrl, isPublicIpAddress } from './browserNetworkPolicy'

const publicResolver = async () => ['93.184.216.34']

describe('browser network policy', () => {
  it('allows public addresses', () => {
    expect(isPublicIpAddress('1.1.1.1')).toBe(true)
    expect(isPublicIpAddress('2606:4700:4700::1111')).toBe(true)
  })

  it('blocks loopback, private, carrier, link-local, documentation, and multicast ranges', () => {
    for (const address of [
      '0.0.0.1', '10.0.0.1', '100.64.0.1', '127.0.0.1', '169.254.169.254',
      '172.16.0.1', '192.168.1.1', '198.18.0.1', '192.0.2.1', '224.0.0.1',
      '::', '::1', '::ffff:127.0.0.1', 'fc00::1', 'fe80::1', '2001:db8::1', 'ff02::1',
    ]) expect(isPublicIpAddress(address)).toBe(false)
  })

  it('requires HTTPS without embedded credentials', async () => {
    await expect(assertPublicHttpsUrl('http://example.com', publicResolver)).rejects.toThrow('public HTTPS')
    await expect(assertPublicHttpsUrl('https://user:pass@example.com', publicResolver)).rejects.toThrow('public HTTPS')
  })

  it('blocks local names and private DNS answers', async () => {
    await expect(assertPublicHttpsUrl('https://localhost', publicResolver)).rejects.toThrow('local hostname')
    await expect(assertPublicHttpsUrl('https://admin.internal', publicResolver)).rejects.toThrow('local hostname')
    await expect(assertPublicHttpsUrl('https://rebind.example', async () => ['93.184.216.34', '127.0.0.1']))
      .rejects.toThrow('private')
  })

  it('returns a normalized public URL', async () => {
    expect((await assertPublicHttpsUrl('https://EXAMPLE.com/path?q=1', publicResolver)).href)
      .toBe('https://example.com/path?q=1')
  })
})
