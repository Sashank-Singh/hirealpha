import { chromium } from 'playwright'
const browser = await chromium.launch({ channel: 'chromium-headless-shell' })
const ctx = await browser.newContext({ viewport: { width: 430, height: 932 }, isMobile: true, hasTouch: true })
const page = await ctx.newPage()
for (const kind of ['networking_crm', 'open_loops']) {
  const url = `http://localhost:5173/app/mini/friend/${kind}`
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {})
  await page.evaluate(() => {
    localStorage.setItem('hirealpha-session', JSON.stringify({ email: 'singhsashank2004@gmail.com', phone: '', signedInAt: new Date().toISOString() }))
    localStorage.setItem('hirealpha-roster', JSON.stringify([{ agentId: 'friend', status: 'active', hiredAt: new Date().toISOString() }]))
  }).catch(() => {})
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {})
  await page.waitForTimeout(2200)
  const out = await page.evaluate(() => {
    return [...document.querySelectorAll('.ma-callout-actions')].map((r) => {
      const cs = getComputedStyle(r)
      const kids = [...r.children].map((k) => { const b = k.getBoundingClientRect(); return { t: k.textContent.trim().slice(0, 16), top: Math.round(b.top), left: Math.round(b.left), w: Math.round(b.width) } })
      return { fit: r.classList.contains('ma-callout-actions--fit'), wrap: cs.flexWrap, kids }
    })
  })
  console.log(kind, JSON.stringify(out))
  await page.screenshot({ path: `/tmp/ma-shots/fit-${kind}.png`, fullPage: true })
}
await browser.close()
