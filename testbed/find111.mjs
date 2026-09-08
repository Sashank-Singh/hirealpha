import { chromium } from 'playwright'
const browser = await chromium.launch({ channel: 'chromium-headless-shell' })
const ctx = await browser.newContext({ viewport: { width: 430, height: 932 }, isMobile: true })
const page = await ctx.newPage()
const url = 'http://localhost:5173/app/mini/friend/nutrition'
await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {})
await page.evaluate(() => {
  localStorage.setItem('hirealpha-session', JSON.stringify({ email: 'singhsashank2004@gmail.com', phone: '', signedInAt: new Date().toISOString() }))
  localStorage.setItem('hirealpha-roster', JSON.stringify([{ agentId: 'friend', status: 'active', hiredAt: new Date().toISOString() }]))
}).catch(() => {})
await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {})
await page.waitForTimeout(2200)
const hits = await page.evaluate(() => {
  const out = []
  for (const el of document.querySelectorAll('body *')) {
    if (!(el instanceof HTMLElement)) continue
    const cs = getComputedStyle(el)
    const r = el.getBoundingClientRect()
    if (r.width === 0 && r.height === 0) continue
    const fg = cs.color
    if (fg === 'rgb(17, 17, 17)') {
      out.push({ tag: el.tagName, cls: el.className && String(el.className).slice(0, 60), text: (el.textContent || '').slice(0, 40), bg: cs.backgroundColor })
    }
  }
  return out
})
console.log(JSON.stringify(hits, null, 2))
await browser.close()
