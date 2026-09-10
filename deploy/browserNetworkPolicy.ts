import { lookup } from 'node:dns/promises'
import { BlockList, isIP } from 'node:net'
import type { Page } from 'playwright'

export type HostResolver = (hostname: string) => Promise<string[]>

const blocked = new BlockList()
for (const [network, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
  ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24],
  ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24],
  ['224.0.0.0', 4], ['240.0.0.0', 4],
] as const) blocked.addSubnet(network, prefix, 'ipv4')

for (const [network, prefix] of [
  ['::', 128], ['::1', 128], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8], ['2001:db8::', 32],
] as const) blocked.addSubnet(network, prefix, 'ipv6')

export function isPublicIpAddress(address: string): boolean {
  const family = isIP(address)
  if (family === 4) return !blocked.check(address, 'ipv4')
  if (family !== 6) return false
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address)
  if (mapped) return isPublicIpAddress(mapped[1]!)
  return !blocked.check(address, 'ipv6')
}

async function systemResolver(hostname: string): Promise<string[]> {
  return (await lookup(hostname, { all: true, verbatim: true })).map((entry) => entry.address)
}

export async function assertPublicHttpsUrl(value: string, resolver: HostResolver = systemResolver): Promise<URL> {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new Error('Browser target must be a valid URL.')
  }
  if (url.protocol !== 'https:' || url.username || url.password) {
    throw new Error('Browser target must be a public HTTPS URL without embedded credentials.')
  }
  const hostname = url.hostname.toLowerCase().replace(/\.$/, '')
  if (!hostname || hostname === 'localhost' || hostname.endsWith('.localhost') || hostname.endsWith('.local') || hostname.endsWith('.internal')) {
    throw new Error('Browser target cannot use a local hostname.')
  }
  const addresses = isIP(hostname) ? [hostname] : await resolver(hostname)
  if (addresses.length === 0 || addresses.some((address) => !isPublicIpAddress(address))) {
    throw new Error('Browser target resolved to a private, reserved, or unavailable address.')
  }
  return url
}

/** Re-check every request after redirects. The network firewall remains the final
 * enforcement layer; this guard gives users a clear error before navigation. */
export async function installBrowserNetworkPolicy(page: Page): Promise<void> {
  await page.route('**/*', async (route) => {
    const requestUrl = route.request().url()
    if (/^(?:about|blob|data):/i.test(requestUrl)) {
      await route.continue()
      return
    }
    try {
      await assertPublicHttpsUrl(requestUrl)
      await route.continue()
    } catch {
      await route.abort('blockedbyclient')
    }
  })
}
