/**
 * The decisive anti-bot test: open the exact URL that walled our E2B Chromium
 * (Yelp's vegetarian search) in a Kernel stealth browser, and report what the
 * page actually is. Run from a cloud host — Kernel's proxy port is blocked by
 * some consumer networks, so a local failure is not evidence about Kernel.
 *
 *   KERNEL_API_KEY=... bun run scripts/kernel-yelp-probe.ts [url]
 */
import Kernel from '@onkernel/sdk'

const url = process.argv[2] || 'https://www.yelp.com/search?cflt=vegetarian&find_loc=Chicago%2C+IL'
const kernel = new Kernel({ apiKey: process.env.KERNEL_API_KEY!, timeout: 120_000, maxRetries: 0 })

const session = await kernel.browsers.create({
  headless: false,
  stealth: true,
  timeout_seconds: 240,
  viewport: { width: 1280, height: 900 },
})
console.log('session', session.session_id)
console.log('live   ', session.browser_live_view_url)

try {
  const t0 = Date.now()
  const res = await kernel.browsers.playwright.execute(session.session_id, {
    code: `
      await page.goto(${JSON.stringify(url)}, { waitUntil: 'domcontentloaded', timeout: 90000 });
      await page.waitForTimeout(5000);
      const title = await page.title();
      const body = (await page.innerText('body').catch(() => '')).replace(/\\s+/g, ' ').slice(0, 700);
      const shot = await page.screenshot({ type: 'jpeg', quality: 50 });
      return {
        title,
        blocked: /verify you are human|are you a robot|unusual traffic|device verification|just a moment|access denied|enable javascript and cookies/i.test(body),
        body,
        screenshot: shot.toString('base64'),
      };
    `,
  })
  console.log('execute', Date.now() - t0, 'ms success=', res.success, res.error ? `error=${res.error}` : '')
  const out = res.result as { title?: string; blocked?: boolean; body?: string; screenshot?: string } | undefined
  console.log('title  :', out?.title)
  console.log('blocked:', out?.blocked)
  console.log('body   :', out?.body?.slice(0, 400))
  if (out?.screenshot) {
    const { writeFileSync } = await import('node:fs')
    writeFileSync('/tmp/kernel-yelp.jpg', Buffer.from(out.screenshot, 'base64'))
    console.log('screenshot /tmp/kernel-yelp.jpg')
  }
} catch (err) {
  console.error('probe failed:', err instanceof Error ? err.message.slice(0, 200) : err)
} finally {
  await kernel.browsers.deleteByID(session.session_id).catch(() => undefined)
  console.log('session deleted')
}
