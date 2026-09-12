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
import { agentEnvCaller, buildVisionParts, buildVerificationParts, executeAgentAction, isTerminal, pageShowsExactTotal, parseAgentAction, parseVerification, DEFAULT_AGENT_LIMITS, type PaymentCardSecrets } from './agentDriver'
import type { PortalTask, PortalStep } from './browserVault'
import { installBrowserNetworkPolicy } from './browserNetworkPolicy'
import { challengeFailureMessage, challengeHandoffMessage, detectChallenge, type ChallengeSignal } from './challengeDetection'

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
export function bunWsTransport(url: string): { send: (m: unknown) => void; close: () => void; onmessage?: (m: string) => void; onclose?: (r: string) => void } {
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
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-blink-features=AutomationControlled'],
    viewport: BROWSER_VIEWPORT,
    userAgent: USER_AGENT,
    locale: BROWSER_LOCALE,
    timezoneId: BROWSER_TIMEZONE,
    colorScheme: 'light',
    extraHTTPHeaders: { 'Accept-Language': `${BROWSER_LOCALE},en;q=0.9` },
  })
  await hardenContext(context)
  return { browser: context.browser() as Browser, context, owned: true, profileDir }
}

const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'

/** Fingerprint defaults: a desktop viewport and a US locale/timezone that
 * matches the sandbox's egress region. A page that sees HeadlessChrome, UTC,
 * and a 1x1 viewport is a bot before any behaviour is observed. */
const BROWSER_VIEWPORT = { width: 1280, height: 800 }
const BROWSER_LOCALE = process.env.BROWSER_LOCALE?.trim() || 'en-US'
const BROWSER_TIMEZONE = process.env.BROWSER_TIMEZONE?.trim() || 'America/New_York'

/** The UA must not contradict the engine: a Chrome/124 UA on a Chromium 152
 * build is itself a bot signal on sites like booking.com. Derive the major
 * version from the connected browser when one is available. */
function userAgentFor(browser: Browser): string {
  const major = browser.version().split('.')[0]
  if (!major || !/^\d+$/.test(major)) return USER_AGENT
  return `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36`
}

/** Remove the automation markers a page can read before its own scripts run.
 * `--disable-blink-features=AutomationControlled` covers headless Chromium;
 * this covers contexts created over CDP against the E2B template as well. */
async function hardenContext(context: BrowserContext): Promise<void> {
  await context.addInitScript(() => {
    try {
      Object.defineProperty(navigator, 'webdriver', { get: () => false })
    } catch { /* non-configurable on exotic engines */ }
  }).catch(() => undefined)
}

async function newContext(browser: Browser): Promise<BrowserContext> {
  const context = await browser.newContext({
    userAgent: userAgentFor(browser),
    viewport: BROWSER_VIEWPORT,
    locale: BROWSER_LOCALE,
    timezoneId: BROWSER_TIMEZONE,
    colorScheme: 'light',
    extraHTTPHeaders: { 'Accept-Language': `${BROWSER_LOCALE},en;q=0.9` },
  })
  await hardenContext(context)
  return context
}

/** Race a Playwright call that has no built-in timeout (evaluate, frame
 * scans) against a fallback value, so a busy page cannot hang a step. */
function withTimeout<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
  return new Promise<T>((resolve) => {
    const timer = setTimeout(() => resolve(fallback), ms)
    void promise.then(
      (value) => { clearTimeout(timer); resolve(value) },
      () => { clearTimeout(timer); resolve(fallback) },
    )
  })
}

/** URLs of frames that are actually visible. The invisible reCAPTCHA badge
 * loads a controller frame on healthy pages; counting it would pause every
 * run. Hidden challenge frames are not challenges. */
async function visibleFrameUrls(page: import('playwright').Page): Promise<string[]> {
  const visible = await withTimeout(page.evaluate(() => {
    return Array.from(document.querySelectorAll('iframe')).flatMap((frame) => {
      const rect = frame.getBoundingClientRect()
      const style = getComputedStyle(frame)
      if (rect.width < 3 || rect.height < 3 || style.visibility === 'hidden' || style.display === 'none') return []
      return frame.src ? [frame.src] : []
    })
  }).catch(() => [] as string[]), 3_000, [] as string[])
  if (visible.length) return visible
  return page.frames().map((frame) => frame.url()).filter((url) => /^https?:/i.test(url))
}

/* --------------------------- challenge handling --------------------------- */

/** Managed challenges (Cloudflare interstitials, Turnstile, reCAPTCHA
 * invisible v3) often clear themselves in a few seconds. Give them that
 * window before pausing the user; anything still present after it is a real
 * wall. */
const CHALLENGE_SELF_CLEAR_MS = 10_000
const CHALLENGE_POLL_MS = 2_500
/** More than this many human handoffs for the same wall means the page is not
 * progressing; fail explicitly instead of pausing forever. */
const CHALLENGE_MAX_HANDOFFS = 2

/** One bounded scan of the live page for anti-bot/login-wall evidence. */
export async function detectPageChallenge(page: import('playwright').Page): Promise<ChallengeSignal | null> {
  const snapshot = await withTimeout(page.evaluate(() => ({
    title: document.title || '',
    text: (document.body?.innerText || '').slice(0, 6_000),
    hasPasswordField: Boolean(document.querySelector('input[type="password"]')),
  })).catch(() => ({ title: '', text: '', hasPasswordField: false })), 5_000, { title: '', text: '', hasPasswordField: false })
  const frameUrls = await visibleFrameUrls(page)
  return detectChallenge({
    url: page.url(),
    title: snapshot.title,
    text: snapshot.text,
    frameUrls,
    hasPasswordField: snapshot.hasPasswordField,
  })
}

/** Detect, then let self-clearing managed challenges clear themselves. */
async function detectChallengeWithGrace(page: import('playwright').Page): Promise<ChallengeSignal | null> {
  const first = await detectPageChallenge(page)
  if (!first || first.kind === 'blocked' || first.kind === 'login') return first
  const deadline = Date.now() + CHALLENGE_SELF_CLEAR_MS
  while (Date.now() < deadline) {
    await page.waitForTimeout(CHALLENGE_POLL_MS).catch(() => undefined)
    const again = await detectPageChallenge(page)
    if (!again) return null
    if (again.kind === 'blocked') return again
  }
  return first
}

type ChallengeHandoffOutcome = 'resumed' | 'cancelled' | 'timeout' | 'unavailable'

/** Pause for the human with the challenge visible. The worker holds the
 * browser open and waits for the user's Resume (waitForBrowserHandoff); this
 * only resolves when they acted, cancelled, or the wait expired. */
async function runChallengeHandoff(
  page: import('playwright').Page,
  task: SessionTask,
  challenge: ChallengeSignal,
  screenshotBase64?: string,
): Promise<ChallengeHandoffOutcome> {
  if (!task.onHandoff) return 'unavailable'
  const message = challengeHandoffMessage(challenge, page.url())
  let screenshot = screenshotBase64
  if (!screenshot && task.onScreenshot) {
    screenshot = await withTimeout(
      page.screenshot({ type: 'jpeg', quality: 45, timeout: 12_000, animations: 'disabled', caret: 'hide' })
        .then((buffer) => (buffer.length ? buffer.toString('base64') : ''))
        .catch(() => ''),
      14_000,
      '',
    )
  }
  if (task.onScreenshot && screenshot) {
    await task.onScreenshot({ dataUrl: `data:image/jpeg;base64,${screenshot}`, caption: message.slice(0, 200) })
      .catch(() => undefined)
  }
  const kind = challenge.kind === 'login' ? 'password' : challenge.kind === 'verification' ? 'verification' : 'captcha'
  const handoff = await task.onHandoff({ kind, message, url: page.url() })
  if (handoff === 'cancelled' || handoff === 'timeout') return handoff
  return 'resumed'
}

/** Scripted/login runs: a wall after the steps is a handoff or an explicit
 * failure — never partial page text delivered as a successful result. */
async function settleScriptedChallenge(
  page: import('playwright').Page,
  task: SessionTask,
): Promise<{ ok: false; error: string } | null> {
  const challenge = await detectChallengeWithGrace(page)
  if (!challenge) return null
  if (challenge.kind === 'blocked') return { ok: false, error: challengeFailureMessage(challenge, page.url()) }
  const outcome = await runChallengeHandoff(page, task, challenge)
  if (outcome === 'cancelled') return { ok: false, error: 'The user stopped the browser task.' }
  if (outcome === 'timeout') return { ok: false, error: 'The browser handoff expired before the user returned.' }
  if (outcome === 'unavailable') {
    return { ok: false, error: `${challengeFailureMessage(challenge, page.url())} No interactive handoff is available for this job.` }
  }
  await page.waitForLoadState('domcontentloaded', { timeout: 20_000 }).catch(() => undefined)
  await page.waitForTimeout(2_000).catch(() => undefined)
  const again = await detectPageChallenge(page)
  if (again) {
    return { ok: false, error: `${challengeFailureMessage(again, page.url())} It was still present after the handoff.` }
  }
  return null
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
      const challengeFailure = await settleScriptedChallenge(page, task)
      if (challengeFailure) return challengeFailure
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
  // Heavy booking sites routinely take >25s to first paint; 45s with
  // domcontentloaded still returns before third-party assets finish.
  else await page.goto(task.url, { waitUntil: 'domcontentloaded', timeout: 45_000 })
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

type IndexedTarget = { index: number; tag: string; label: string; selector: string; sensitive: boolean; x: number; y: number; width: number; height: number }

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
 * present only for the screenshot and is removed before any action executes.
 * Every page call is bounded: on a slow commerce page one hung evaluate would
 * otherwise stall the step (and the wall clock) with no error. */
async function captureAgentPage(page: import('playwright').Page): Promise<{ pageText: string; screenshot: string; title: string; frameUrls: string[]; hasPasswordField: boolean }> {
  await withTimeout(maskPaymentFields(page), 4_000, undefined)
  const targets = await withTimeout(page.locator('a, button, input, select, textarea, [role="button"], [role="link"], [contenteditable="true"], [tabindex]')
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
      // Hand the model a ready-to-use stable selector when one exists: click
      // coordinates silently miss when a consent overlay covers the target,
      // while Playwright selectors wait for actionability and retry.
      const attr = (name: string): string => (element.getAttribute(name) || '').trim()
      const cssEscape = (value: string): string => value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
      const candidate = (() => {
        const id = attr('id')
        if (id && /^[\w-]+$/.test(id)) return `#${id}`
        if (attr('name')) return `${element.tagName.toLowerCase()}[name="${cssEscape(attr('name'))}"]`
        if (attr('aria-label')) return `[aria-label="${cssEscape(attr('aria-label'))}"]`
        if (attr('data-testid')) return `[data-testid="${cssEscape(attr('data-testid'))}"]`
        if (attr('data-test')) return `[data-test="${cssEscape(attr('data-test'))}"]`
        return ''
      })()
      return [{
        index: position + 1,
        tag: element.tagName.toLowerCase(),
        label: sensitive ? 'Protected field' : label.trim().replace(/\s+/g, ' ').slice(0, 100),
        selector: candidate.length <= 200 ? candidate : '',
        sensitive,
        x: Math.max(0, Math.round(rect.x)),
        y: Math.max(0, Math.round(rect.y)),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
      }]
    }).slice(0, 80)), 6_000, [] as IndexedTarget[])

  const body = await withTimeout(page.evaluate(() => ({
    text: (document.body?.innerText || '').slice(0, 3500),
    hasPasswordField: Boolean(document.querySelector('input[type="password"]')),
  })).catch(() => ({ text: '', hasPasswordField: false })), 5_000, { text: '', hasPasswordField: false })
  const bodyText = body.text || ''
  const targetText = targets.map((target) =>
    `[${target.index}] ${target.tag}${target.label ? ` "${target.label}"` : ''} box=(${target.x},${target.y},${target.width},${target.height})${target.selector ? ` selector=${target.selector}` : ''}`,
  ).join('\n')

  await withTimeout(page.evaluate((items) => {
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
  }, targets).catch(() => undefined), 3_000, undefined)

  // Secure payment widgets commonly live in cross-origin iframes. Redact
  // protected inputs inside every frame as well as the top document before
  // the pixels leave the browser process.
  await withTimeout(Promise.all(page.frames().map((frame) => frame.evaluate(() => {
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
  }).catch(() => undefined))), 4_000, undefined)

  // One transient CDP hiccup must not turn into an empty image (providers 400
  // on `data:image/jpeg;base64,`) or a text-only step on a visual page.
  let screenshot = ''
  await withTimeout((async () => {
    for (let attempt = 0; attempt < 2 && !screenshot; attempt++) {
      screenshot = await page.screenshot({ type: 'jpeg', quality: 45, timeout: 15_000, animations: 'disabled', caret: 'hide' })
        .then((buffer) => (buffer.length ? buffer.toString('base64') : ''))
        .catch(() => '')
    }
  })(), 32_000, undefined)
  await withTimeout(page.evaluate(() => document.getElementById('__hirealpha_targets__')?.remove()).catch(() => undefined), 3_000, undefined)
  await withTimeout(Promise.all(page.frames().map((frame) => frame.evaluate(() => {
    document.getElementById('__hirealpha_sensitive_redactions__')?.remove()
  }).catch(() => undefined))), 4_000, undefined)
  const [title, frameUrls] = await Promise.all([
    withTimeout(page.title().catch(() => ''), 3_000, ''),
    visibleFrameUrls(page),
  ])
  return { pageText: `${bodyText}\n\nINTERACTIVE TARGETS:\n${targetText}`.slice(0, 9_000), screenshot, title, frameUrls, hasPasswordField: body.hasPasswordField }
}

async function agentLoop(
  page: import('playwright').Page,
  task: SessionTask,
): Promise<{ ok: true; content: string } | { ok: false; error: string }> {
  const call = agentEnvCaller()
  if (!call) return { ok: false, error: 'Agent mode not configured (GMI_API_KEY missing).' }
  const auditCall = agentEnvCaller('audit') || call

  // Log in first with the real credentials, then hand the session to the
  // agent: the model never sees the password, only the post-login screen.
  await openTaskPage(page, task)
  let activePage = page
  if (activePage.url() === 'about:blank') {
    // runPortalLogin tolerates a missing domcontentloaded, which can leave a
    // blank page; the agent must not start there and burn the run.
    await activePage.goto(task.url, { waitUntil: 'commit', timeout: 30_000 }).catch(() => undefined)
  }
  if (activePage.url() === 'about:blank') {
    return { ok: false, error: `The page never loaded: ${task.url}` }
  }
  await task.onProgress?.({ action: 'goto', url: activePage.url() })
  const goal = task.goal!.slice(0, 500)
  const recentActions: string[] = []
  let answerChecked = false
  let challengeHandoffs = 0
  let deadline = Date.now() + DEFAULT_AGENT_LIMITS.wallMs

  for (let step = 1; step <= DEFAULT_AGENT_LIMITS.maxSteps; step++) {
    if (Date.now() > deadline) {
      return { ok: false, error: 'Agent ran out of time before finishing the goal.' }
    }
    if (activePage.isClosed()) {
      return { ok: false, error: 'The browser page was closed before the goal was reached (the sandbox may have timed out).' }
    }
    let pageText = ''
    let screenshot = ''
    try {
      const captured = await captureAgentPage(activePage)
      pageText = captured.pageText
      screenshot = captured.screenshot
    } catch {
      pageText = (await withTimeout(activePage.evaluate(() => (document.body?.innerText || '').slice(0, 3500)).catch(() => ''), 5_000, '')) || ''
    }

    // Deterministic wall check BEFORE the model sees the page: a challenge or
    // login page is never "done", and managed challenges get a short window
    // to clear themselves before the user is asked to step in.
    const challenge = await detectChallengeWithGrace(activePage)
    if (challenge) {
      if (challenge.kind === 'blocked') {
        await task.onProgress?.({ action: 'blocked', url: activePage.url() })
        return { ok: false, error: challengeFailureMessage(challenge, activePage.url()) }
      }
      if (challengeHandoffs >= CHALLENGE_MAX_HANDOFFS) {
        return {
          ok: false,
          error: `${challengeFailureMessage(challenge, activePage.url())} It was still present after ${CHALLENGE_MAX_HANDOFFS} handoffs.`,
        }
      }
      await task.onProgress?.({ action: `detected_${challenge.kind}`, url: activePage.url() })
      const handoffStarted = Date.now()
      const outcome = await runChallengeHandoff(activePage, task, challenge, screenshot)
      deadline += Date.now() - handoffStarted
      if (outcome === 'cancelled') return { ok: false, error: 'The user stopped the browser task.' }
      if (outcome === 'timeout') return { ok: false, error: 'The browser handoff expired before the user returned.' }
      if (outcome === 'unavailable') {
        return {
          ok: false,
          error: `${challengeFailureMessage(challenge, activePage.url())} No interactive handoff is available for this job.`,
        }
      }
      challengeHandoffs++
      recentActions.push(`human completed ${challenge.kind} handoff (${challenge.signal})`)
      await task.onProgress?.({ action: `handoff_${challenge.kind}`, url: activePage.url() })
      continue
    }

    if (screenshot && process.env.BROWSER_AGENT_TRACE === '1') {
      await task.onScreenshot?.({ dataUrl: `data:image/jpeg;base64,${screenshot}`, caption: `step ${step}` }).catch(() => undefined)
    }
    let raw = ''
    try {
      raw = await call(buildVisionParts({
        pageText,
        url: activePage.url(),
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
        url: activePage.url(),
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
      if (action.type === 'done') {
        if (!answerChecked) {
          answerChecked = true
          try {
            const verdictRaw = await auditCall(buildVerificationParts({
              goal, answer: action.answer, pageText, screenshotBase64: screenshot,
            }))
            if (process.env.BROWSER_AGENT_TRACE === '1') {
              console.log(`[agent] verification raw: ${verdictRaw.slice(0, 1500)}`)
            }
            const verdict = parseVerification(verdictRaw, action.answer)
            if (!verdict.supported) {
              recentActions.push(`answer check failed (${verdict.unsupported.join('; ').slice(0, 200)}); scroll until each value is visible or write "not shown"`)
              await task.onProgress?.({ action: 'answer_check_failed', url: activePage.url() })
              continue
            }
          } catch {
            // Verification is best-effort: a failed check must not discard a result.
          }
        }
        return { ok: true, content: action.answer }
      }
      return { ok: false, error: `Agent gave up: ${action.reason}` }
    }
    const pagesBefore = new Set(activePage.context().pages())
    const outcome = await executeAgentAction(activePage, action, task.paymentCard)
    const ok = outcome.ok
    if (action.type === 'fill_payment' && ok) task.paymentCard = undefined
    // A click on a real site often opens a same-site tab (hotel details,
    // sign-in). Keep driving the tab the action produced; otherwise the agent
    // stares at the page the user already left and repeats dead clicks.
    const opened = activePage.context().pages()
      .filter((candidate) => !candidate.isClosed() && !pagesBefore.has(candidate))
      .filter((candidate) => sameSite(task.url, candidate.url()))
    if (opened.length) {
      activePage = opened[opened.length - 1]
      await activePage.bringToFront().catch(() => undefined)
      recentActions.push('switched to the new tab that just opened')
    }
    // Failures keep their reason: the activity stream shows the failed step
    // and the model is told exactly what did not work instead of "(failed)".
    await task.onProgress?.({ action: ok ? action.type : `${action.type}_failed`, url: activePage.url() })
    recentActions.push(`${action.type}${'selector' in action ? ` ${action.selector.slice(0, 60)}` : ''}${ok ? '' : ` (failed: ${(outcome.error || 'no effect').slice(0, 100)})`}`)
  }
  return { ok: false, error: 'Agent hit the step cap before finishing the goal.' }
}

export type { PortalTask }
