// Probe form controls + canvas fallback: fonts/colors that textContent probes miss.
import { chromium } from 'playwright'

const BASE = process.env.BASE || 'http://localhost:5173'
const EMAIL = process.env.HA_EMAIL || 'singhsashank2004@gmail.com'
const PAGES = (process.env.PAGES || 'weekly_review,approve_investor_note,tonight').split(',').map((s) => s.trim()).filter(Boolean)

const browser = await chromium.launch({ channel: 'chromium-headless-shell' })
const ctx = await browser.newContext({ viewport: { width: 430, height: 932 }, isMobile: true, hasTouch: true })
const page = await ctx.newPage()

for (const kind of PAGES) {
  const url = `${BASE}/app/mini/friend/${kind}`
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => {})
  await page.evaluate((email) => {
    localStorage.setItem('hirealpha-session', JSON.stringify({ email, phone: '', signedInAt: new Date().toISOString() }))
    localStorage.setItem('hirealpha-roster', JSON.stringify([{ agentId: 'friend', status: 'active', hiredAt: new Date().toISOString() }]))
  }, EMAIL).catch(() => {})
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => {})
  await page.waitForTimeout(1800)
  const res = await page.evaluate(() => {
    const out = []
    for (const el of document.querySelectorAll('input, textarea, select, button')) {
      const cs = getComputedStyle(el)
      const fam = cs.fontFamily.split(',')[0].replace(/["']/g, '')
      const r = el.getBoundingClientRect()
      out.push(`${el.tagName.toLowerCase()}[${el.type || ''}] font=${fam} color=${cs.color} bg=${cs.backgroundColor} size=${Math.round(r.width)}x${Math.round(r.height)} cls=${String(el.className).slice(0, 60)} ph=${el.placeholder || ''}`)
    }
    return out
  })
  console.log(`\n===== ${kind} =====`)
  res.forEach((l) => console.log('  ' + l))
}
await browser.close()