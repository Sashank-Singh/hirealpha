/** Cold-route bundle and browser smoke check. No live accounts or APIs. */
import { chromium } from 'playwright'
import { join, resolve } from 'node:path'
import { mkdirSync, writeFileSync } from 'node:fs'
import { gzipSync } from 'node:zlib'
const root = resolve(process.argv[2] || 'dist')
const out = resolve(process.argv[3] || 'testbed/load-results/app-speed')
mkdirSync(out, { recursive: true })
const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(req) {
  const url = new URL(req.url)
  if (url.pathname === '/api/auth/session') { await new Promise(resolve => setTimeout(resolve, 800)); return Response.json({ ok: true }) }
  if (url.pathname.startsWith('/api/')) return Response.json({ error: 'Simulated offline service' }, { status: 503 })
  const file = Bun.file(join(root, url.pathname))
  return new Response(url.pathname !== '/' && await file.exists() ? file : Bun.file(join(root, 'index.html')))
} })
const browser = await chromium.launch({ headless: true, channel: 'chrome' })
const reports: unknown[] = []
try {
  for (const [name, route, budget] of [
    ['login', '/app/login', 330_000],
    ['settings', '/app', 400_000],
    ['home', '/app/mini/friend/home?t=perf', 430_000],
    ['later', '/app/mini/friend/later?t=perf', 410_000],
    ['nutrition', '/app/mini/friend/nutrition?t=perf', 460_000],
  ] as const) {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } })
    const errors: string[] = []
    const files = new Set<string>()
    page.on('pageerror', error => errors.push(error.message))
    page.on('request', request => { const url = new URL(request.url()); if (url.hostname === '127.0.0.1' && url.pathname.endsWith('.js')) files.add(url.pathname) })
    await page.route('**/*', async route => new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort())
    await page.addInitScript((signedIn) => {
      localStorage.setItem('ha_setup_done', 'friend')
      if (signedIn) localStorage.setItem('hirealpha-session', JSON.stringify({ email: 'perf@example.invalid', phone: '+15550000000', signedInAt: new Date().toISOString() }))
    }, name === 'settings')
    await page.goto(`http://127.0.0.1:${server.port}${route}`)
    await page.waitForTimeout(1800)
    let jsBytes = 0, gzipBytes = 0
    for (const path of files) { const bytes = new Uint8Array(await Bun.file(join(root, path)).arrayBuffer()); jsBytes += bytes.byteLength; gzipBytes += gzipSync(bytes).byteLength }
    const text = await page.locator('body').innerText()
    if (!text.trim() || text.includes('Something went wrong loading this view') || text.includes('Loading your app…') || (name !== 'login' && text.includes('Sign in to use this'))) errors.push('Screen did not finish rendering')
    const unexpected = [...files].filter(path => /Landing-|SkinBApp-|SkinCApp-|WorkMiniApps-/.test(path))
    if (unexpected.length) errors.push(`Unrelated route code downloaded: ${unexpected.join(', ')}`)
    if (jsBytes > budget) errors.push(`JavaScript budget exceeded: ${jsBytes} > ${budget}`)
    const report = { route, jsBytes, gzipBytes, budget, chunks: files.size, errors, files: [...files], visibleText: text.slice(0, 700) }
    reports.push(report)
    console.log(JSON.stringify(report))
    await page.screenshot({ path: join(out, `${name}.png`), fullPage: true })
    if (errors.length) process.exitCode = 1
    await page.close()
  }
} finally {
  await browser.close(); server.stop()
  writeFileSync(join(out, 'report.json'), JSON.stringify(reports, null, 2))
}
