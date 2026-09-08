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
}

async function launchChromium(): Promise<Browser> {
  const mod = (await eval('import("playwright")')) as { chromium: BrowserType }
  return mod.chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
  })
}

export async function runBrowserSession(task: SessionTask): Promise<{ ok: true; content: string } | { ok: false; error: string }> {
  let browser: Browser | null = null
  try {
    browser = await launchChromium()
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
    await browser?.close().catch(() => {})
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

async function agentLoop(
  page: import('playwright').Page,
  task: SessionTask,
): Promise<{ ok: true; content: string } | { ok: false; error: string }> {
  const call = agentEnvCaller()
  if (!call) return { ok: false, error: 'Agent mode not configured (GMI_API_KEY missing).' }

  // Log in first with the real credentials, then hand the session to the
  // agent: the model never sees the password, only the post-login screen.
  await openTaskPage(page, task)
  const goal = task.goal!.slice(0, 500)
  const recentActions: string[] = []
  const started = Date.now()

  for (let step = 1; step <= DEFAULT_AGENT_LIMITS.maxSteps; step++) {
    if (Date.now() - started > DEFAULT_AGENT_LIMITS.wallMs) {
      return { ok: false, error: 'Agent ran out of time before finishing the goal.' }
    }
    const pageText = (await page.evaluate(() => (document.body?.innerText || '').slice(0, 3500)).catch(() => '')) || ''
    let screenshot: string
    try {
      screenshot = await page.screenshot({ type: 'jpeg', quality: 55, timeout: 8000 }).then((b) => b.toString('base64'))
    } catch {
      screenshot = ''
    }
    let raw = ''
    try {
      raw = await call(buildVisionParts({ pageText, url: page.url(), screenshotBase64: screenshot, goal, stepNumber: step, recentActions }))
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
    if (isTerminal(action)) {
      if (action.type === 'done') return { ok: true, content: action.answer }
      return { ok: false, error: `Agent gave up: ${action.reason}` }
    }
    const ok = await executeAgentAction(page, action)
    recentActions.push(`${action.type}${'selector' in action ? ` ${action.selector.slice(0, 60)}` : ''}${ok ? '' : ' (failed)'}`)
  }
  return { ok: false, error: 'Agent hit the step cap before finishing the goal.' }
}

export type { PortalTask }
