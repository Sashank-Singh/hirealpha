/**
 * One browser session, three modes: scripted steps, agent-driven goal, or the
 * classic login+scrape. Fresh context per call, closed in finally — the same
 * zero-persistence contract as browserRunner.
 */
import type { Browser, BrowserType } from 'playwright'
import { runPortalLogin, runSteps, extractPageText } from './browserRunner'
import { agentEnvCaller, buildVisionParts, executeAgentAction, isTerminal, parseAgentAction, DEFAULT_AGENT_LIMITS } from './agentDriver'
import type { PortalTask, PortalStep } from './browserVault'

export type SessionTask = {
  url: string
  username: string
  password: string
  kind: 'newsletter' | 'ticker' | 'task'
  steps?: PortalStep[]
  goal?: string
  paymentAuthorized?: boolean
  onProgress?: (event: { action: string; url: string }) => Promise<void>
  onHandoff?: (handoff: {
    kind: 'password' | 'verification' | 'payment' | 'captcha' | 'confirmation'
    message: string
    url: string
  }) => Promise<'resumed' | 'cancelled' | 'timeout'>
}

let remoteBrowser: Promise<Browser> | null = null

async function launchChromium(): Promise<{ browser: Browser; owned: boolean }> {
  const mod = (await eval('import("playwright")')) as { chromium: BrowserType }
  const cdpUrl = process.env.BROWSER_CDP_URL?.trim()
  if (cdpUrl) {
    remoteBrowser ??= mod.chromium.connectOverCDP(cdpUrl).catch((error) => {
      remoteBrowser = null
      throw error
    })
    return { browser: await remoteBrowser, owned: false }
  }
  return { browser: await mod.chromium.launch({
    headless: process.env.BROWSER_HEADFUL !== '1',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
  }), owned: true }
}

export async function runBrowserSession(task: SessionTask): Promise<{ ok: true; content: string } | { ok: false; error: string }> {
  let browser: Browser | null = null
  let ownedBrowser = false
  try {
    const launched = await launchChromium()
    browser = launched.browser
    ownedBrowser = launched.owned
    const context = await browser.newContext({
      userAgent:
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      viewport: { width: 1280, height: 800 },
    })
    try {
      const page = await context.newPage()
      if (task.goal) {
        return await agentLoop(page, task)
      }
      if (task.steps?.length) {
        await runSteps(page, task)
      } else {
        await openTaskPage(page, task)
      }
      const content = await extractPageText(page)
      if (!content) return { ok: false, error: 'The page came back empty.' }
      return { ok: true, content }
    } finally {
      await context.close().catch(() => {})
    }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  } finally {
    if (ownedBrowser) await browser?.close().catch(() => {})
  }
}

/** Public sites do not require a saved login. Credentials are used only when supplied. */
export async function openTaskPage(page: import('playwright').Page, task: SessionTask): Promise<void> {
  if (task.username || task.password) await runPortalLogin(page, task)
  else await page.goto(task.url, { waitUntil: 'domcontentloaded', timeout: 25000 })
}

/* ------------------------------ agent loop ------------------------------- */

/** Same-host guard for agent navigations: hostname must match or be a
 * subdomain of the task origin's host. No wandering to other sites. */
function sameSite(from: string, to: string): boolean {
  try {
    const a = new URL(from).hostname.split('.').slice(-2).join('.')
    const b = new URL(to).hostname.split('.').slice(-2).join('.')
    return a === b
  } catch {
    return false
  }
}

type IndexedTarget = { index: number; tag: string; label: string; x: number; y: number; width: number; height: number }

/** Build browser-use-style numbered targets from the live page. The overlay is
 * present only for the screenshot and is removed before any action executes. */
async function captureAgentPage(page: import('playwright').Page): Promise<{ pageText: string; screenshot: string }> {
  const targets = await page.locator('a, button, input, select, textarea, [role="button"], [role="link"], [contenteditable="true"], [tabindex]')
    .evaluateAll((nodes) => nodes.flatMap((node, position) => {
      const element = node as HTMLElement
      const rect = element.getBoundingClientRect()
      const style = window.getComputedStyle(element)
      if (rect.width < 3 || rect.height < 3 || rect.bottom < 0 || rect.right < 0 || rect.top > innerHeight || rect.left > innerWidth || style.visibility === 'hidden' || style.display === 'none') return []
      const label = element.getAttribute('aria-label')
        || element.getAttribute('placeholder')
        || element.getAttribute('name')
        || element.innerText
        || element.getAttribute('title')
        || ''
      return [{
        index: position + 1,
        tag: element.tagName.toLowerCase(),
        label: label.trim().replace(/\s+/g, ' ').slice(0, 100),
        x: Math.max(0, Math.round(rect.x)),
        y: Math.max(0, Math.round(rect.y)),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
      }]
    }).slice(0, 80)) as IndexedTarget[]

  const bodyText = (await page.evaluate(() => (document.body?.innerText || '').slice(0, 3500)).catch(() => '')) || ''
  const targetText = targets.map((target) =>
    `[${target.index}] ${target.tag}${target.label ? ` "${target.label}"` : ''} box=(${target.x},${target.y},${target.width},${target.height})`,
  ).join('\n')

  await page.evaluate((items) => {
    document.getElementById('__hirealpha_targets__')?.remove()
    const root = document.createElement('div')
    root.id = '__hirealpha_targets__'
    root.style.cssText = 'position:fixed;inset:0;z-index:2147483647;pointer-events:none;overflow:hidden'
    for (const item of items) {
      const box = document.createElement('div')
      box.style.cssText = `position:absolute;left:${item.x}px;top:${item.y}px;width:${item.width}px;height:${item.height}px;border:2px solid #e9bd24;box-sizing:border-box`
      const badge = document.createElement('span')
      badge.textContent = `[${item.index}]`
      badge.style.cssText = 'position:absolute;left:-2px;top:-16px;padding:1px 3px;background:#e9bd24;color:#171710;font:700 11px monospace;line-height:14px'
      box.appendChild(badge)
      root.appendChild(box)
    }
    document.documentElement.appendChild(root)
  }, targets).catch(() => undefined)

  let screenshot = ''
  try {
    screenshot = await page.screenshot({ type: 'jpeg', quality: 45, timeout: 8_000 }).then((buffer) => buffer.toString('base64'))
  } finally {
    await page.evaluate(() => document.getElementById('__hirealpha_targets__')?.remove()).catch(() => undefined)
  }
  return { pageText: `${bodyText}\n\nINTERACTIVE TARGETS:\n${targetText}`.slice(0, 9_000), screenshot }
}

async function agentLoop(
  page: import('playwright').Page,
  task: SessionTask,
): Promise<{ ok: true; content: string } | { ok: false; error: string }> {
  const call = agentEnvCaller()
  if (!call) return { ok: false, error: 'Agent mode not configured (GMI_API_KEY missing).' }

  // Log in first with the real credentials, then hand the session to the
  // agent: the model never sees the password, only the post-login screen.
  await openTaskPage(page, task)
  await task.onProgress?.({ action: 'goto', url: page.url() })
  const goal = task.goal!.slice(0, 500)
  const recentActions: string[] = []
  let deadline = Date.now() + DEFAULT_AGENT_LIMITS.wallMs

  for (let step = 1; step <= DEFAULT_AGENT_LIMITS.maxSteps; step++) {
    if (Date.now() > deadline) {
      return { ok: false, error: 'Agent ran out of time before finishing the goal.' }
    }
    let pageText = ''
    let screenshot = ''
    try {
      const captured = await captureAgentPage(page)
      pageText = captured.pageText
      screenshot = captured.screenshot
    } catch {
      pageText = (await page.evaluate(() => (document.body?.innerText || '').slice(0, 3500)).catch(() => '')) || ''
    }
    let raw = ''
    try {
      raw = await call(buildVisionParts({ pageText, url: page.url(), screenshotBase64: screenshot, goal, stepNumber: step, recentActions, paymentAuthorized: task.paymentAuthorized }))
    } catch (err) {
      return { ok: false, error: `Vision model failed: ${err instanceof Error ? err.message : String(err)}` }
    }
    const action = parseAgentAction(raw)
    if (!action) {
      recentActions.push('skipped malformed model reply')
      continue
    }
    if (action.type === 'navigate' && !sameSite(task.url, action.url)) {
      recentActions.push('blocked off-site navigation')
      continue
    }
    if (action.type === 'handoff') {
      if (!task.onHandoff) return { ok: false, error: `This step needs you: ${action.message}` }
      const handoffStarted = Date.now()
      const handoff = await task.onHandoff({ kind: action.kind, message: action.message, url: page.url() })
      deadline += Date.now() - handoffStarted
      if (handoff === 'cancelled') return { ok: false, error: 'The user stopped the browser task.' }
      if (handoff === 'timeout') return { ok: false, error: 'The browser handoff expired before the user returned.' }
      recentActions.push(`human completed ${action.kind} handoff`)
      await task.onProgress?.({ action: `handoff_${action.kind}`, url: page.url() })
      continue
    }
    if (isTerminal(action)) {
      if (action.type === 'done') return { ok: true, content: action.answer }
      return { ok: false, error: `Agent gave up: ${action.reason}` }
    }
    const ok = await executeAgentAction(page, action)
    await task.onProgress?.({ action: action.type, url: page.url() })
    recentActions.push(`${action.type}${'selector' in action ? ` ${action.selector.slice(0, 60)}` : ''}${ok ? '' : ' (failed)'}`)
  }
  return { ok: false, error: 'Agent hit the step cap before finishing the goal.' }
}

export type { PortalTask }
