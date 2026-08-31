/**
 * The real headless-Chromium runner for the VPS web container.
 *
 * One session per task, nothing persistent between tasks: every call launches
 * a brand-new browser context with no storage state, no user data dir, and no
 * cookie jar, and closes both context and browser in a finally. A crash mid-
 * task leaves nothing on disk to resume from — by design.
 *
 * `username` is whatever identifier the portal needs (email or user id); the
 * password comes pre-decrypted from the vault and is gone when this returns.
 */
import { chromium, type Browser } from 'playwright'
import type { PortalTask, PortalRun } from './browserVault'

const TIMEOUT_MS = 25_000

export async function runPortalTask(task: PortalTask): Promise<PortalRun> {
  let browser: Browser | null = null
  try {
    browser = await chromium.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
    })
    // Fresh context = zero persistence. No storageState, no userDataDir.
    const context = await browser.newContext({
      userAgent:
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      viewport: { width: 1280, height: 800 },
    })
    try {
      const page = await context.newPage()
      try {
        await page.goto(task.url, { waitUntil: 'domcontentloaded', timeout: TIMEOUT_MS })
      } catch {
        // Heavy portals sometimes miss domcontentloaded inside the window;
        // the login selectors below are the real progress check.
      }

      const usernameField = page.locator('input[type=email], input[name*=user i], input[name*=email i], input[name*=login i], #userid, #login').first()
      const passwordField = page.locator('input[type=password]').first()
      await usernameField.waitFor({ timeout: 8000 }).catch(() => undefined)
      await usernameField.fill(task.username).catch(() => undefined)
      await passwordField.waitFor({ timeout: 8000 })
      await passwordField.fill(task.password)

      await Promise.race([
        passwordField.press('Enter'),
        page.locator('button[type=submit], input[type=submit]').first().click().catch(() => undefined),
      ])
      await page.waitForLoadState('domcontentloaded', { timeout: TIMEOUT_MS }).catch(() => undefined)
      // Post-login walls (OTP, dashboards) settle asynchronously; give the
      // network a beat before scraping.
      await page.waitForTimeout(2500)

      const content = await page.evaluate(() => {
        if (!document.body) return ''
        const clone = document.body.cloneNode(true) as HTMLElement
        clone.querySelectorAll('script, style, noscript, svg, nav, footer, header').forEach((el) => el.remove())
        return (clone.innerText || clone.textContent || '').slice(0, 8000).trim()
      })
      if (!content) return { ok: false, error: 'The page came back empty.' }
      return { ok: true, content }
    } finally {
      await context.close().catch(() => {})
    }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  } finally {
    await browser?.close().catch(() => {})
  }
}
