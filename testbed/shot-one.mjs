import { chromium } from 'playwright'
const kind = process.argv[2] || 'tonight'
const theme = process.argv[3] || 'dark'
const browser = await chromium.launch({ channel: 'chromium-headless-shell' })
const ctx = await browser.newContext({ viewport: { width: 430, height: 932 }, isMobile: true, hasTouch: true })
const page = await ctx.newPage()
const url = `http://localhost:5173/app/mini/friend/${kind}`
await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {})
await page.evaluate((t) => {
  localStorage.setItem('hirealpha-session', JSON.stringify({ email: 'singhsashank2004@gmail.com', phone: '', signedInAt: new Date().toISOString() }))
  localStorage.setItem('hirealpha-roster', JSON.stringify([{ agentId: 'friend', status: 'active', hiredAt: new Date().toISOString() }]))
  localStorage.setItem('mini-theme', t)
}, theme).catch(() => {})
await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {})
await page.waitForTimeout(2500)
await page.screenshot({ path: `/tmp/ma-shots/check-${theme}-${kind}.png`, fullPage: true })
console.log('shot saved', theme, kind)
await browser.close()

