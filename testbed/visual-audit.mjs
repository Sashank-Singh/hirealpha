// Visual audit helper: screenshots + per-page class/CSS dump for the mini apps.
import { chromium } from 'playwright'
import { mkdirSync } from 'node:fs'

const OUT = '/tmp/ma-shots'
mkdirSync(OUT, { recursive: true })

const BASE = process.env.BASE || 'http://localhost:5173'
const EMAIL = process.env.HA_EMAIL || 'singhsashank2004@gmail.com'

const PAGES = (process.env.PAGES || 'apps,body,later,home,digest,networking_crm,drop_zone,open_loops,nutrition,habit_streak,mood_tracker,workout_log,sleep_tracker,spending_snapshot,gratitude_journal,learning_queue,weekly_review,pipeline_board,builds')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean)

const browser = await chromium.launch({ channel: 'chromium-headless-shell' })
const ctx = await browser.newContext({
  viewport: { width: 430, height: 932 },
  deviceScaleFactor: 2,
  isMobile: true,
  hasTouch: true,
})
const page = await ctx.newPage()

for (const kind of PAGES) {
  try {
    const url = `${BASE}/app/mini/friend/${kind}`
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => {})
    // Seed the local session before app code reads it, then reload once so the
    // screen renders authed (a cold visit without a session shows a sign-in wall).
    await page.evaluate((email) => {
      localStorage.setItem('hirealpha-session', JSON.stringify({ email, phone: '', signedInAt: new Date().toISOString() }))
      localStorage.setItem('hirealpha-roster', JSON.stringify([{ agentId: 'friend', status: 'active', hiredAt: new Date().toISOString() }]))
    }, EMAIL).catch(() => {})
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => {})
    await page.waitForTimeout(2500)
    const name = kind.replace(/[^a-z0-9_]/gi, '_')
    await page.screenshot({ path: `${OUT}/${name}.png`, fullPage: true })
    // Which classes actually render here (top 400 chars of body for sanity)
    const info = await page.evaluate(() => {
      const cls = new Set()
      document.querySelectorAll('[class]').forEach((el) => String(el.className).split(/\s+/).forEach((c) => c && cls.add(c)))
      return {
        title: document.title,
        classes: [...cls].sort(),
        body: document.body.innerText.slice(0, 300),
      }
    })
    console.log(`== ${kind}: ${info.title}\n   ${info.classes.join(' ')}\n   ${info.body.replace(/\n+/g, ' | ').slice(0, 220)}`)
  } catch (err) {
    console.log(`!! ${kind} failed: ${err?.message || err}`)
  }
}

await browser.close()
