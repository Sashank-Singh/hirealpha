// Computed-style theme audit: measures what actually renders on each mini app
// page and flags deviations from the default dark theme reference values.
import { chromium } from 'playwright'
import { writeFileSync } from 'node:fs'

const BASE = process.env.BASE || 'http://localhost:5173'
const EMAIL = process.env.HA_EMAIL || 'singhsashank2004@gmail.com'

const PAGES = (process.env.PAGES ||
  'apps,home,body,later,digest,networking_crm,drop_zone,open_loops,nutrition,habit_streak,mood_tracker,workout_log,sleep_tracker,spending_snapshot,gratitude_journal,learning_queue,weekly_review,pipeline_board,builds,pick_night,tonight,meeting_mode,approve_send,pick_slot,linear_triage,standup_paste,decision_ledger,hire_decision,approve_investor_note'
).split(',').map((s) => s.trim()).filter(Boolean)
// Reference (default dark theme): surface #141414, text #f4f4f4
const REF = { surface: 'rgb(20, 20, 20)', text: 'rgb(244, 244, 244)' }

const browser = await chromium.launch({ channel: 'chromium-headless-shell' })
const ctx = await browser.newContext({
  viewport: { width: 430, height: 932 },
  deviceScaleFactor: 1,
  isMobile: true,
  hasTouch: true,
})
const page = await ctx.newPage()

const lines = []
const log = (s) => { lines.push(s); console.log(s) }

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

    const stats = await page.evaluate(() => {
      const bgCounts = new Map()
      const fgCounts = new Map()
      const fonts = new Map()
      const seen = new Set()
      const els = document.querySelectorAll('body *')
      for (const el of els) {
        if (!(el instanceof HTMLElement)) continue
        const cs = getComputedStyle(el)
        const r = el.getBoundingClientRect()
        const visible = r.width > 8 && r.height > 6 && cs.visibility !== 'hidden' && cs.display !== 'none'
        if (!visible) continue
        const bg = cs.backgroundColor
        // Only opaque backgrounds matter for surface audit
        if (bg && bg !== 'rgba(0, 0, 0, 0)') {
          const key = bg
          bgCounts.set(key, (bgCounts.get(key) || 0) + 1)
          if (!seen.has('bg:' + key) && bgCounts.get(key) <= 999) {
            seen.add('bg:' + key)
          }
        }
        const fg = cs.color
        fgCounts.set(fg, (fgCounts.get(fg) || 0) + 1)
        const fam = cs.fontFamily.split(',')[0].replace(/["']/g, '')
        fonts.set(fam, (fonts.get(fam) || 0) + 1)
      }
      const bodyBg = getComputedStyle(document.body).backgroundColor
      const htmlTheme = document.documentElement.dataset.miniTheme || 'dark'
      // sample first heading text color + font
      const h = document.querySelector('h1,h2,.mini__title')
      return {
        bodyBg,
        htmlTheme,
        heading: h ? { color: getComputedStyle(h).color, font: getComputedStyle(h).fontFamily.split(',')[0].replace(/["']/g, ''), text: (h.textContent || '').slice(0, 40) } : null,
        bgCounts: [...bgCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12),
        fgCounts: [...fgCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8),
        fonts: [...fonts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6),
      }
    })

    // Deviation checks
    const issues = []
    const top = stats.bgCounts[0]
    if (top && top[0] !== REF.surface) issues.push(`surface=${top[0]} (want ${REF.surface})`)
    const hfg = stats.heading?.color
    if (hfg && hfg !== REF.text) issues.push(`heading-color=${hfg} (want ${REF.text})`)
    const oddFonts = stats.fonts.filter(([f]) => !/Inter/i.test(f))
    if (oddFonts.length) issues.push(`fonts=${oddFonts.map(([f, n]) => `${f}x${n}`).join(',')}`)

    log(`${issues.length ? 'OFF' : 'OK '} ${kind} :: body=${stats.bodyBg} theme=${stats.htmlTheme}`)
    if (stats.heading) log(`      heading "${stats.heading.text}" color=${stats.heading.color} font=${stats.heading.font}`)
    log(`      bg: ${stats.bgCounts.map(([c, n]) => `${c}x${n}`).join(' | ')}`)
    log(`      fg: ${stats.fgCounts.map(([c, n]) => `${c}x${n}`).join(' | ')}`)
    if (issues.length) log(`      >>> ISSUES: ${issues.join(' ; ')}`)
  } catch (err) {
    log(`!! ${kind} failed: ${err?.message || err}`)
  }
}

await browser.close()
if (process.env.APPEND) writeFileSync('/tmp/theme-report.txt', lines.join('\n') + '\n', { flag: 'a' })
else writeFileSync('/tmp/theme-report.txt', lines.join('\n') + '\n')
console.log('DONE chunk -> /tmp/theme-report.txt')