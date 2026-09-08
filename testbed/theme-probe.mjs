// Probe: for suspect pages, find elements whose bg/text/font deviate from the
// theme and print their tag+class+html so we can fix them precisely.
import { chromium } from 'playwright'

const BASE = process.env.BASE || 'http://localhost:5173'
const EMAIL = process.env.HA_EMAIL || 'singhsashank2004@gmail.com'
const PAGES = (process.env.PAGES || 'spending_snapshot,pipeline_board,weekly_review,approve_investor_note,tonight')
  .split(',').map((s) => s.trim()).filter(Boolean)

const REF = { surface: 'rgb(20, 20, 20)', text: 'rgb(244, 244, 244)' }
// Colors seen on the reference pages (shell/theme chrome) - not violations
const KNOWN_FG = new Set([
  'rgb(244, 244, 244)', 'rgb(224, 224, 224)', 'rgb(42, 111, 122)', 'rgb(17, 17, 17)',
  'rgb(244, 244, 245)', 'rgb(185, 242, 221)', 'rgb(127, 227, 196)', 'rgb(154, 160, 166)', 'rgb(242, 244, 240)',
])
const KNOWN_BG = new Set([
  'rgb(20, 20, 20)', 'rgba(255, 255, 255, 0.035)', 'rgba(255, 255, 255, 0.043)',
  'rgba(255, 255, 255, 0.03)', 'rgba(255, 255, 255, 0.04)', 'rgba(127, 227, 196, 0.08)',
  'color(srgb 0.956863 0.956863 0.956863 / 0.08)',
])

const browser = await chromium.launch({ channel: 'chromium-headless-shell' })
const ctx = await browser.newContext({ viewport: { width: 430, height: 932 }, isMobile: true, hasTouch: true })
const page = await ctx.newPage()

for (const kind of PAGES) {
  try {
    const url = `${BASE}/app/mini/friend/${kind}`
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => {})
    await page.evaluate((email) => {
      localStorage.setItem('hirealpha-session', JSON.stringify({ email, phone: '', signedInAt: new Date().toISOString() }))
      localStorage.setItem('hirealpha-roster', JSON.stringify([{ agentId: 'friend', status: 'active', hiredAt: new Date().toISOString() }]))
    }, EMAIL).catch(() => {})
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => {})
    await page.waitForTimeout(2200)

    const odd = await page.evaluate(([refText, refSurface, knownFg, knownBg]) => {
      const kf = new Set(JSON.parse(knownFg))
      const kb = new Set(JSON.parse(knownBg))
      const out = []
      const seen = new Set()
      for (const el of document.querySelectorAll('body *')) {
        if (!(el instanceof HTMLElement) && !(el instanceof SVGElement)) continue
        const r = el.getBoundingClientRect()
        if (r.width < 4 || r.height < 4) continue
        const cs = getComputedStyle(el)
        const tag = el.tagName.toLowerCase()
        const cls = String(el.className && el.className.baseVal !== undefined ? el.className.baseVal : el.className)
        const desc = `${tag}.${cls.split(/\s+/).filter(Boolean).join('.')}`
        if (cs.color && cs.color !== refText && !kf.has(cs.color) && cs.color !== 'rgba(0, 0, 0, 0)' && el.textContent?.trim()) {
          const key = 'fg:' + desc + ':' + cs.color
          if (!seen.has(key) && out.length < 14) {
            seen.add(key)
            out.push(`FG  ${key}\n    text="${(el.textContent || '').trim().slice(0, 50)}" font=${cs.fontFamily.split(',')[0]}`)
          }
        }
        const bg = cs.backgroundColor
        if (bg && bg !== 'rgba(0, 0, 0, 0)' && bg !== refSurface && !kb.has(bg)) {
          const key = 'BG ' + desc + ':' + bg
          if (!seen.has(key) && out.length < 14) {
            seen.add(key)
            const ff = el.children.length === 0 ? ` text="${(el.textContent || '').trim().slice(0, 40)}"` : ''
            out.push(key + ff)
          }
        }
        const fam = cs.fontFamily.split(',')[0].replace(/["']/g, '')
        if (!/Inter/i.test(fam) && !/DM Sans/i.test(fam) && el.textContent?.trim()) {
          const key = 'FONT ' + desc + ':' + fam
          if (!seen.has(key) && out.length < 14) {
            seen.add(key)
            out.push(`${key}\n    text="${(el.textContent || '').trim().slice(0, 50)}"`)
          }
        }
      }
      return out
    }, [REF.text, REF.surface, JSON.stringify([...KNOWN_FG]), JSON.stringify([...KNOWN_BG])])

    console.log(`\n===== ${kind} =====`)
    if (!odd.length) console.log('  (all clean)')
    for (const line of odd) console.log('  ' + line)
  } catch (err) {
    console.log(`!! ${kind}: ${err?.message || err}`)
  }
}
await browser.close()