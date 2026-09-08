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
  document.querySelectorAll('*').forEach((el) => {
    const ff = getComputedStyle(el).fontFamily
    if (ff.includes('DM Sans')) out.push(`${el.tagName.toLowerCase()}.${(el.className||'').toString().slice(0,60)} :: "${(el.textContent||'').trim().slice(0,40)}" :: ${ff.slice(0,80)}`)
  })
  return out
})
console.log(hits.join('\n') || 'none')
console.log('--- body font:', await page.evaluate(() => getComputedStyle(document.body).fontFamily))
await browser.close()
