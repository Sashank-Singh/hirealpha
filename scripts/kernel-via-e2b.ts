/**
 * Exercise a Kernel cloud browser from a cloud host.
 *
 * Two facts make this the right shape:
 *  - Kernel's browser endpoint (and its live view) answer on an https host, and
 *    the in-VM Playwright executor runs our code inside the browser's own VM —
 *    so nothing here depends on the CDP websocket being reachable.
 *  - Some networks block Kernel's proxy port outright. That is a property of
 *    the network, not of Kernel, so the probe runs from a sandbox that has open
 *    egress; production workers must be checked the same way.
 *
 *   KERNEL_API_KEY=... E2B_API_KEY=... bun run scripts/kernel-via-e2b.ts [url]
 */
import { Sandbox } from 'e2b'
import { writeFileSync } from 'node:fs'

const KEY = process.env.KERNEL_API_KEY
const E2B = process.env.E2B_API_KEY
if (!KEY || !E2B) throw new Error('KERNEL_API_KEY and E2B_API_KEY are required')

const url = process.argv[2] || 'https://www.yelp.com/search?cflt=vegetarian&find_loc=Chicago%2C+IL'

const session = (await (
  await fetch('https://api.onkernel.com/browsers', {
    method: 'POST',
    headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ headless: false, stealth: true, timeout_seconds: 300, viewport: { width: 1280, height: 900 } }),
  })
).json()) as { session_id: string; browser_live_view_url: string }
console.log('session', session.session_id)
console.log('live   ', session.browser_live_view_url)

const sandbox = await Sandbox.create('base', { apiKey: E2B, timeoutMs: 300_000 })
try {
  const code = `
    await page.goto(${JSON.stringify(url)}, { waitUntil: 'domcontentloaded', timeout: 90000 });
    await page.waitForTimeout(9000);
    const title = await page.title();
    const body = (await page.innerText('body').catch(() => '')).replace(/\\s+/g, ' ').slice(0, 1200);
    const shot = await page.screenshot({ type: 'jpeg', quality: 45 });
    return {
      title,
      blocked: /verify you are human|device verification|are you a robot|unusual traffic/i.test(body),
      body,
      screenshotBase64: shot.toString('base64'),
    };
  `
  await sandbox.files.write('/tmp/body.json', JSON.stringify({ code }))
  const started = Date.now()
  const run = await sandbox.commands.run(
    `curl -s -m 240 -X POST https://api.onkernel.com/browsers/${session.session_id}/playwright/execute ` +
      `-H "Authorization: Bearer ${KEY}" -H "Content-Type: application/json" -d @/tmp/body.json -o /tmp/out.json -w "%{http_code}"`,
    { timeoutMs: 260_000 },
  )
  console.log('execute http', run.stdout.trim(), `in ${Date.now() - started}ms`)
  const raw = await sandbox.files.read('/tmp/out.json')
  const parsed = JSON.parse(String(raw)) as {
    success: boolean
    error?: string
    result?: { title?: string; blocked?: boolean; body?: string; screenshotBase64?: string }
  }
  console.log('success', parsed.success, parsed.error ? `error=${parsed.error}` : '')
  console.log('title  ', parsed.result?.title)
  console.log('blocked', parsed.result?.blocked)
  console.log('body   ', String(parsed.result?.body || '').slice(0, 600))
  if (parsed.result?.screenshotBase64) {
    writeFileSync('/tmp/kernel-live.jpg', Buffer.from(parsed.result.screenshotBase64, 'base64'))
    console.log('screenshot /tmp/kernel-live.jpg')
  }
} finally {
  await sandbox.kill().catch(() => undefined)
  await fetch(`https://api.onkernel.com/browsers/${session.session_id}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${KEY}` },
  }).catch(() => undefined)
  console.log('cleaned up')
}
