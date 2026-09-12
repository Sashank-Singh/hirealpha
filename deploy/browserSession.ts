/**
 * One browser session, three modes: scripted steps, agent-driven goal, or the
 * classic login+scrape. Fresh context per call, closed in finally — the same
 * zero-persistence contract as browserRunner.
 */
import type { Browser, BrowserContext, BrowserType } from 'playwright'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runPortalLogin, runSteps, extractPageText } from './browserRunner'
import { agentEnvCaller, buildVisionParts, executeAgentAction, isTerminal, pageShowsExactTotal, parseAgentAction, DEFAULT_AGENT_LIMITS, type PaymentCardSecrets } from './agentDriver'
import type { PortalTask, PortalStep } from './browserVault'
import { installBrowserNetworkPolicy } from './browserNetworkPolicy'

export type SessionTask = {
  url: string
  username: string
  password: string
  kind: 'newsletter' | 'ticker' | 'task'
  steps?: PortalStep[]
  goal?: string
  /** CDP endpoint of this task's fresh sandbox. Each task connects to its own
   * browser and closes the connection afterwards — never shared across tasks. */
  cdpUrl?: string
  paymentAuthorized?: boolean
  paymentAmountCents?: number
  paymentCard?: PaymentCardSecrets
  onProgress?: (event: { action: string; url: string }) => Promise<void>
  /** Fired on a handoff and at the end of a run with the page as the user would
   * see it. The worker forwards these so the person can see what was found
   * instead of trusting a text summary. Data URL, JPEG. */
  onScreenshot?: (event: { dataUrl: string; caption?: string }) => Promise<void>
  onHandoff?: (handoff: {
    kind: 'password' | 'verification' | 'payment' | 'captcha' | 'confirmation'
    message: string
    url: string
    amountCents?: number
    merchant?: string
    item?: string
  }) => Promise<'resumed' | 'cancelled' | 'timeout' | { status: 'resumed'; paymentCard: PaymentCardSecrets }>
}

let remoteBrowser: Promise<Browser> | null = null

type Launched = {
  browser: Browser
  /** The context to use. A persistent launch already has one; a CDP connect does not. */
  context: BrowserContext
  owned: boolean
  /** Set only for a locally-launched persistent profile; deleted with the task. */
  profileDir?: string
}

/**
 * Bun's node:http client emits 'response' (not 'upgrade') for a 101 on
 * versions before 1.4.2, and Playwright's ws transport then aborts the
 * handshake — remote CDP over wss fails with a bare timeout. Wrap Bun's
 * native WebSocket (which handles 101 correctly everywhere) in Playwright's
 * ConnectionTransport so sandbox CDP works regardless of the container's
 * Bun version. Plain ws:// URLs keep the stock path.
 */
function bunWsTransport(url: string): { send: (m: unknown) => void; close: () => void; onmessage?: (m: string) => void; onclose?: (r: string) => void } {
  const sock = new WebSocket(url)
  const queue: string[] = []
  let open = false
  const transport: { send: (m: unknown) => void; close: () => void; onmessage?: (m: string) => void; onclose?: (r: string) => void } = {
    send(m: unknown) {
      const data = typeof m === 'string' ? m : JSON.stringify(m)
      if (open) sock.send(data)
      else queue.push(data)
    },
    close() {
      try {
        sock.close()
      } catch {
        /* already closed */
      }
    },
  }
  sock.addEventListener('open', () => {
    open = true
    for (const d of queue.splice(0)) sock.send(d)
  })
  sock.addEventListener('message', (e: MessageEvent) => {
    try {
      transport.onmessage?.(String(e.data))
    } catch {
      /* transport consumer gone */
    }
  })
  sock.addEventListener('close', () => transport.onclose?.('closed'))
  sock.addEventListener('error', () => transport.onclose?.('error'))
  return transport
}

function connectCdp(
  mod: { chromium: BrowserType },
  url: string,
): Promise<Browser> {
  // Bun >= 1.4.2 handles the 101 upgrade for the endpoint form; older
  // runtimes need the Bun-native-websocket transport for wss:// URLs.
  if (/^wss:\/\//i.test(url)) {
    const wsUrl = url
    return new Promise<Browser>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('CDP connect timed out')), 45_000)
      void (mod.chromium.connectOverCDP as unknown as (
        transport: unknown,
        options?: { timeout?: number },
      ) => Promise<Browser>)(bunWsTransport(wsUrl), { timeout: 60_000 })
        .then((b) => {
          clearTimeout(timer)
          resolve(b)
        })
        .catch((err) => {
          clearTimeout(timer)
          reject(err)
        })
    })
  }
  return mod.chromium.connectOverCDP(url)
}

async function launchChromium(task: Pick<SessionTask, 'cdpUrl'>): Promise<Launched> {
  const mod = (await eval('import("playwright")')) as { chromium: BrowserType }
  // A task-bound sandbox CDP endpoint always connects fresh and is closed
  // with the task — two tasks never share a browser, profile, or connection.
  if (task.cdpUrl) {
    const browser = await connectCdp(mod, task.cdpUrl)
    return { browser, context: await newContext(browser), owned: true }
  }
  const cdpUrl = process.env.BROWSER_CDP_URL?.trim()
  if (cdpUrl) {
    remoteBrowser ??= connectCdp(mod, cdpUrl).catch((error) => {
      remoteBrowser = null
      throw error
    })
    const browser = await remoteBrowser
    return { browser, context: await newContext(browser), owned: false }
  }
  // Local mode: its own user-data directory per task. Playwright only honors
  // that through launchPersistentContext (passing --user-data-dir as an
  // argument is rejected), which also returns the context to drive.
  const profileDir = await mkdtemp(join(tmpdir(), 'hirealpha-chrome-'))
  const context = await mod.chromium.launchPersistentContext(profileDir, {
    headless: process.env.BROWSER_HEADFUL !== '1',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
    viewport: { width: 1280, height: 800 },
    userAgent: USER_AGENT,
  })
  return { browser: context.browser() as Browser, context, owned: true, profileDir }
}

const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'

async function newContext(browser: Browser): Promise<BrowserContext> {
  return browser.newContext({ userAgent: USER_AGENT, viewport: { width: 1280, height: 800 } })
}

export async function runBrowserSession(task: SessionTask): Promise<{ ok: true; content: string } | { ok: false; error: string }> {
  let browser: Browser | null = null
  let ownedBrowser = false
  let profileDir: string | undefined
  try {
    const launched = await launchChromium(task)
    browser = launched.browser
    ownedBrowser = launched.owned
    profileDir = launched.profileDir
    const context = launched.context
    try {
      const page = await context.newPage()
      await installBrowserNetworkPolicy(page)
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
    // Nothing survives a task: the profile holds cookies, storage, and cache
    // from whatever site was just visited, so it is deleted with the browser.
    if (profileDir) await rm(profileDir, { recursive: true, force: true }).catch(() => {})
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

type IndexedTarget = { index: number; tag: string; label: string; sensitive: boolean; x: number; y: number; width: number; height: number }

/** Payment values are filled outside the model. Mask them before every vision
 * capture, including cross-origin payment frames, so screenshots cannot turn
 * a one-time credential into model input. */
async function maskPaymentFields(page: import('playwright').Page): Promise<void> {
  const selector = [
    'input[autocomplete^="cc-"]', 'input[name*="cardnumber" i]', 'input[name*="card-number" i]',
    'input[name*="cardNumber" i]', 'input[name*="cvc" i]', 'input[name*="cvv" i]',
    'input[name*="securityCode" i]', 'input[name*="expiry" i]', 'input[name*="expiration" i]',
    'input[data-elements-stable-field-name^="card"]',
  ].join(',')
  for (const frame of page.frames()) {
    await frame.locator(selector).evaluateAll((nodes) => {
      for (const node of nodes as HTMLInputElement[]) {
        node.style.setProperty('-webkit-text-security', 'disc', 'important')
        node.style.setProperty('color', 'transparent', 'important')
        node.style.setProperty('text-shadow', '0 0 0 #666', 'important')
      }
    }).catch(() => undefined)
  }
}

/** Build browser-use-style numbered targets from the live page. The overlay is
 * present only for the screenshot and is removed before any action executes. */
async function captureAgentPage(page: import('playwright').Page): Promise<{ pageText: string; screenshot: string }> {
  await maskPaymentFields(page)
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
      const fieldSignals = [
        element.getAttribute('type'), element.getAttribute('autocomplete'), element.getAttribute('name'),
        element.getAttribute('id'), element.getAttribute('aria-label'), element.getAttribute('placeholder'),
      ].filter(Boolean).join(' ').toLowerCase()
      const sensitive = element instanceof HTMLInputElement && (
        element.type === 'password'
        || /(?:one-time-code|\botp\b|verification.?code|security.?code|passcode|cc-|card.?number|card.?expiry|cardholder|billing.?(?:postal|zip)|\bexp(?:iry|iration)?[-_ ]?date\b|\bcvc\b|\bcvv\b)/i.test(fieldSignals)
      )
      return [{
        index: position + 1,
        tag: element.tagName.toLowerCase(),
        label: sensitive ? 'Protected field' : label.trim().replace(/\s+/g, ' ').slice(0, 100),
        sensitive,
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
      box.style.cssText = `position:absolute;left:${item.x}px;top:${item.y}px;width:${item.width}px;height:${item.height}px;border:2px solid #e9bd24;box-sizing:border-box;${item.sensitive ? 'background:#191914;' : ''}`
      const badge = document.createElement('span')
      badge.textContent = `[${item.index}]`
      badge.style.cssText = 'position:absolute;left:-2px;top:-16px;padding:1px 3px;background:#e9bd24;color:#171710;font:700 11px monospace;line-height:14px'
      box.appendChild(badge)
      root.appendChild(box)
    }
    document.documentElement.appendChild(root)
  }, targets).catch(() => undefined)

  // Secure payment widgets commonly live in cross-origin iframes. Redact
  // protected inputs inside every frame as well as the top document before
  // the pixels leave the browser process.
  await Promise.all(page.frames().map((frame) => frame.evaluate(() => {
    document.getElementById('__hirealpha_sensitive_redactions__')?.remove()
    const root = document.createElement('div')
    root.id = '__hirealpha_sensitive_redactions__'
    root.style.cssText = 'position:fixed;inset:0;z-index:2147483647;pointer-events:none;overflow:hidden'
    for (const input of document.querySelectorAll('input')) {
      const element = input as HTMLInputElement
      const signals = [element.type, element.autocomplete, element.name, element.id, element.getAttribute('aria-label'), element.placeholder]
        .filter(Boolean).join(' ').toLowerCase()
      if (element.type !== 'password' && !/(?:one-time-code|\botp\b|verification.?code|security.?code|passcode|cc-|card.?number|card.?expiry|cardholder|billing.?(?:postal|zip)|\bexp(?:iry|iration)?[-_ ]?date\b|\bcvc\b|\bcvv\b)/i.test(signals)) continue
      const rect = element.getBoundingClientRect()
      if (rect.width < 2 || rect.height < 2) continue
      const cover = document.createElement('div')
      cover.style.cssText = `position:absolute;left:${rect.x}px;top:${rect.y}px;width:${rect.width}px;height:${rect.height}px;background:#191914;border:2px solid #e9bd24;box-sizing:border-box`
      root.appendChild(cover)
    }
    document.documentElement.appendChild(root)
  }).catch(() => undefined)))

  let screenshot = ''
  try {
    screenshot = await page.screenshot({ type: 'jpeg', quality: 45, timeout: 8_000 }).then((buffer) => buffer.toString('base64'))
  } finally {
    await page.evaluate(() => document.getElementById('__hirealpha_targets__')?.remove()).catch(() => undefined)
    await Promise.all(page.frames().map((frame) => frame.evaluate(() => {
      document.getElementById('__hirealpha_sensitive_redactions__')?.remove()
    }).catch(() => undefined)))
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
      raw = await call(buildVisionParts({
        pageText,
        url: page.url(),
        screenshotBase64: screenshot,
        goal,
        stepNumber: step,
        recentActions,
        paymentAuthorized: task.paymentAuthorized,
        paymentAmountCents: task.paymentAmountCents,
      }))
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
      if (action.kind === 'payment' && !pageShowsExactTotal(pageText, action.amountCents || 0)) {
        recentActions.push('blocked payment handoff because the exact total was not visible beside a total label')
        continue
      }
      if (!task.onHandoff) return { ok: false, error: `This step needs you: ${action.message}` }
      // Show the page before asking for a decision: approving blind is the
      // worst version of this product.
      if (task.onScreenshot && screenshot) {
        await task.onScreenshot({ dataUrl: `data:image/jpeg;base64,${screenshot}`, caption: action.message.slice(0, 200) })
          .catch(() => undefined)
      }
      const handoffStarted = Date.now()
      const handoff = await task.onHandoff({
        kind: action.kind,
        message: action.message,
        url: page.url(),
        amountCents: action.amountCents,
        merchant: action.merchant,
        item: action.item,
      })
      deadline += Date.now() - handoffStarted
      if (handoff === 'cancelled') return { ok: false, error: 'The user stopped the browser task.' }
      if (handoff === 'timeout') return { ok: false, error: 'The browser handoff expired before the user returned.' }
      if (action.kind === 'payment') {
        if (typeof handoff === 'object') task.paymentCard = handoff.paymentCard
        if (!task.paymentCard) return { ok: false, error: 'Payment was approved, but a one-time checkout credential was not available.' }
        task.paymentAuthorized = true
        task.paymentAmountCents = action.amountCents
      }
      recentActions.push(`human completed ${action.kind} handoff`)
      await task.onProgress?.({ action: `handoff_${action.kind}`, url: page.url() })
      continue
    }
    if (isTerminal(action)) {
      if (action.type === 'done') return { ok: true, content: action.answer }
      return { ok: false, error: `Agent gave up: ${action.reason}` }
    }
    const ok = await executeAgentAction(page, action, task.paymentCard)
    if (action.type === 'fill_payment' && ok) task.paymentCard = undefined
    await task.onProgress?.({ action: action.type, url: page.url() })
    recentActions.push(`${action.type}${'selector' in action ? ` ${action.selector.slice(0, 60)}` : ''}${ok ? '' : ' (failed)'}`)
  }
  return { ok: false, error: 'Agent hit the step cap before finishing the goal.' }
}

export type { PortalTask }
