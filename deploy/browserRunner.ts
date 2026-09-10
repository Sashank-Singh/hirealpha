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
import type { Browser, BrowserType, Page } from 'playwright'
import type { PortalTask, PortalRun } from './browserVault'
import { installBrowserNetworkPolicy } from './browserNetworkPolicy'

const TIMEOUT_MS = 25_000

/** Body text of the current page, noise-stripped and capped. */
export async function extractPageText(page: Page): Promise<string> {
  return page.evaluate(() => {
    if (!document.body) return ''
    const clone = document.body.cloneNode(true) as HTMLElement
    clone.querySelectorAll('script, style, noscript, svg, nav, footer, header').forEach((el) => el.remove())
    return (clone.innerText || clone.textContent || '').slice(0, 8000).trim()
  })
}

/** Playwright is loaded at call time, not import time: the bundler cannot
 * resolve its full dependency graph statically, and the container installs
 * the real package at runtime. */
async function launchChromium(): Promise<Browser> {
  const mod = (await eval('import("playwright")')) as { chromium: BrowserType }
  return mod.chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
  })
}

export async function runSteps(page: Page, task: PortalTask): Promise<void> {
  const steps = task.steps || []
  const subst = (v: string): string =>
    v.replace(/\{\{username\}\}/g, task.username).replace(/\{\{password\}\}/g, task.password)
  for (const step of steps) {
    switch (step.action) {
      case 'goto': {
        const target = step.value ? subst(step.value) : task.url
        await page.goto(target, { waitUntil: 'domcontentloaded', timeout: TIMEOUT_MS }).catch(() => undefined)
        break
      }
      case 'fill': {
        const field = page.locator(step.selector!).first()
        await field.waitFor({ timeout: 8000 })
        await field.fill(subst(step.value || ''), { timeout: 8000 })
        break
      }
      case 'click': {
        await page.locator(step.selector!).first().click({ timeout: 8000 }).catch(() => undefined)
        break
      }
      case 'press': {
        await page.locator(step.selector!).first().press(step.value || 'Enter', { timeout: 8000 }).catch(() => undefined)
        break
      }
      case 'wait': {
        await page.waitForTimeout(step.ms || 1000)
        break
      }
      case 'extract': {
        await page.waitForLoadState('domcontentloaded', { timeout: TIMEOUT_MS }).catch(() => undefined)
        break
      }
    }
  }
}

export async function runPortalTask(task: PortalTask): Promise<PortalRun> {
  let browser: Browser | null = null
  try {
    browser = await launchChromium()
    // Fresh context = zero persistence. No storageState, no userDataDir.
    const context = await browser.newContext({
      userAgent:
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      viewport: { width: 1280, height: 800 },
    })
    try {
      const page = await context.newPage()
      try {
        await installBrowserNetworkPolicy(page)
        if (task.kind === 'task' && task.steps?.length) {
          await runSteps(page, task)
        } else {
          await runPortalLogin(page, task)
        }

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
    }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  } finally {
    await browser?.close().catch(() => {})
  }
}

/** The original login-then-scrape flow, extracted unchanged: fill the first
 * email/user field, the first password field, submit, settle, read. */
export async function runPortalLogin(page: Page, task: PortalTask): Promise<void> {
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
}
