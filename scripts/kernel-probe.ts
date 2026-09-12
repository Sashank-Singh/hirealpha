/**
 * Probe a Kernel cloud browser against the sites that wall our E2B Chromium.
 * Answers one question per run: does the managed stealth browser reach the
 * content, and what does the live view serve while it does?
 *
 *   KERNEL_API_KEY=... bun run scripts/kernel-probe.ts "https://www.yelp.com/search?cflt=vegetarian&find_loc=Chicago%2C+IL"
 */
import { chromium } from 'playwright'
import Kernel from '@onkernel/sdk'

/** Kernel serves CDP over wss, which Bun's Playwright handshake drops before
 * 1.4.2 — the same reason the sandbox path carries a transport shim. */
async function connect(url: string) {
  if (!/^wss:\/\//i.test(url)) return chromium.connectOverCDP(url)
  const { bunWsTransport } = await import('../deploy/browserSession')
  return (chromium.connectOverCDP as unknown as (
    transport: unknown,
    options?: { timeout?: number },
  ) => Promise<Awaited<ReturnType<typeof chromium.connectOverCDP>>>)(bunWsTransport(url), { timeout: 60_000 })
}

const url = process.argv[2] || 'https://www.yelp.com/search?cflt=vegetarian&find_loc=Chicago%2C+IL'
const kernel = new Kernel({ apiKey: process.env.KERNEL_API_KEY! })

const session = await kernel.browsers.create({
  headless: false,
  stealth: true,
  timeout_seconds: 180,
  viewport: { width: 1280, height: 800 },
})
console.log('session', session.session_id)
console.log('live   ', session.browser_live_view_url)

try {
  // Live view is served only while the session is active — check here, not
  // after the browser has gone to standby.
  const live = await fetch(session.browser_live_view_url).catch((err) => ({ status: 0, err } as never))
  console.log('live view fetch status', (live as Response).status)

  const browser = await chromium.connectOverCDP(session.cdp_ws_url)
  const context = browser.contexts()[0] ?? (await browser.newContext())
  const page = context.pages()[0] ?? (await context.newPage())

  const t0 = Date.now()
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 })
  await page.waitForTimeout(4000)
  const title = await page.title()
  const text = (await page.innerText('body').catch(() => '')).slice(0, 600)
  console.log(`loaded in ${Date.now() - t0}ms`)
  console.log('title:', title)
  console.log('blocked?', /verify you are human|are you a robot|unusual traffic|device verification|just a moment|access denied/i.test(text))
  console.log('body:', text.replace(/\s+/g, ' ').slice(0, 400))
  const shot = await page.screenshot({ type: 'jpeg', quality: 45 })
  const { writeFileSync } = await import('node:fs')
  writeFileSync('/tmp/kernel-probe.jpg', shot)
  console.log('screenshot /tmp/kernel-probe.jpg', shot.byteLength, 'bytes')

  await browser.close().catch(() => undefined)
} finally {
  await kernel.browsers.deleteByID(session.session_id).catch((err) => console.error('cleanup failed', err.message))
  console.log('session deleted')
}
