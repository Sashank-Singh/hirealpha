/** A page that is mid-navigation tears down the JS context under an evaluate.
 * That is a timing fact about real sites, not a failure of the step, so the
 * capture retries instead of spending the step's budget on a race. */
async function captureWithRetry(browser: KernelBrowser, attempts = 3) {
  let lastError: unknown
  for (let i = 0; i < attempts; i++) {
    try {
      return await capture(browser)
    } catch (err) {
      lastError = err
      const message = err instanceof Error ? err.message : String(err)
      if (!/Execution context was destroyed|Target closed|navigating/i.test(message)) throw err
      await browser.settle(15_000).catch(() => undefined)
      await new Promise((resolve) => setTimeout(resolve, 1200))
    }
  }
  throw lastError
}

/**
 * Run a browser task on a Kernel cloud browser.
 *
 * Why this exists next to `browserSession.ts`: that module drives a Playwright
 * page from the worker process over a CDP websocket. Kernel runs our Playwright
 * code inside the browser's own VM and serves the human-facing live view on an
 * https host, so a task survives networks that cannot open the CDP port — and
 * its managed stealth clears the bot walls (a real Yelp search that answered
 * our own Chromium with a device-verification interstitial returns listings
 * here).
 *
 * The agent contract is unchanged: the same numbered-target capture, the same
 * action JSON, the same handoff kinds. Only the transport differs.
 */
import {
  agentEnvCaller,
  buildVerificationParts,
  DEFAULT_AGENT_LIMITS,
  parseAgentAction,
  parseVerification,
  pageShowsExactTotal,
  type AgentAction,
  type PaymentCardSecrets,
} from './agentDriver'
import { KernelBrowser } from './kernelPage'

export type KernelTask = {
  url: string
  goal?: string
  onProgress?: (event: { action: string; url: string }) => Promise<void>
  onScreenshot?: (event: { dataUrl: string; caption?: string }) => Promise<void>
  onHandoff?: (handoff: {
    kind: 'password' | 'verification' | 'payment' | 'captcha' | 'confirmation'
    message: string
    url: string
    amountCents?: number
    merchant?: string
    item?: string
  }) => Promise<'resumed' | 'cancelled' | 'timeout' | { status: 'resumed'; paymentCard: PaymentCardSecrets }>
  paymentAuthorized?: boolean
  paymentAmountCents?: number
  paymentCard?: PaymentCardSecrets
}

/** Elements the driver offers the model, captured in one round trip. */
const TARGET_SCRIPT = `
  const nodes = document.querySelectorAll('a, button, input, select, textarea, [role="button"], [role="link"], [contenteditable="true"], [tabindex]');
  const out = [];
  let position = 0;
  for (const node of nodes) {
    position += 1;
    const el = node;
    const rect = el.getBoundingClientRect();
    const style = window.getComputedStyle(el);
    if (rect.width < 3 || rect.height < 3 || rect.bottom < 0 || rect.right < 0 || rect.top > innerHeight || rect.left > innerWidth) continue;
    if (style.visibility === 'hidden' || style.display === 'none') continue;
    const signals = [el.getAttribute('type'), el.getAttribute('autocomplete'), el.getAttribute('name'), el.getAttribute('id'), el.getAttribute('aria-label'), el.getAttribute('placeholder')].filter(Boolean).join(' ').toLowerCase();
    const sensitive = el.tagName === 'INPUT' && (el.type === 'password' || /(one-time-code|\\botp\\b|verification.?code|security.?code|passcode|cc-|card.?number|card.?expiry|cardholder|\\bcvc\\b|\\bcvv\\b)/.test(signals));
    const raw = el.getAttribute('aria-label') || el.getAttribute('placeholder') || el.getAttribute('name') || el.innerText || el.getAttribute('title') || '';
    const attr = (name) => (el.getAttribute(name) || '').trim();
    const esc = (v) => v.replace(/\\\\/g, '\\\\\\\\').replace(/"/g, '\\\\"');
    let selector = '';
    if (attr('id') && /^[\\w-]+$/.test(attr('id'))) selector = '#' + attr('id');
    else if (attr('name')) selector = el.tagName.toLowerCase() + '[name="' + esc(attr('name')) + '"]';
    else if (attr('aria-label')) selector = '[aria-label="' + esc(attr('aria-label')) + '"]';
    else if (attr('data-testid')) selector = '[data-testid="' + esc(attr('data-testid')) + '"]';
    out.push({
      index: position,
      tag: el.tagName.toLowerCase(),
      label: sensitive ? 'Protected field' : raw.trim().replace(/\\s+/g, ' ').slice(0, 100),
      selector: selector.length <= 200 ? selector : '',
      sensitive,
      x: Math.max(0, Math.round(rect.x)),
      y: Math.max(0, Math.round(rect.y)),
      width: Math.round(rect.width),
      height: Math.round(rect.height),
    });
    if (out.length >= 80) break;
  }
  return out;
`

type Target = {
  index: number
  tag: string
  label: string
  selector: string
  sensitive: boolean
  x: number
  y: number
  width: number
  height: number
}

export async function runKernelTask(
  task: KernelTask,
  browser: KernelBrowser,
): Promise<{ ok: true; content: string } | { ok: false; error: string }> {
  const call = agentEnvCaller()
  if (!call) return { ok: false, error: 'Agent mode not configured (GMI_API_KEY missing).' }
  const auditCall = agentEnvCaller('audit') || call
  const limits = DEFAULT_AGENT_LIMITS
  const deadline = Date.now() + limits.wallMs

  try {
    await browser.goto(task.url, { waitUntil: 'domcontentloaded', timeout: 60_000 })
    // Booking and commerce sites keep navigating after first paint (consent
    // redirects, currency and locale settle). Capturing during that window
    // destroys the execution context and costs a step for nothing.
    await browser.settle()
    await task.onProgress?.({ action: 'goto', url: task.url }).catch(() => undefined)

    const recent: string[] = []
    const failed = new Map<string, number>()
    let lastAction = ''

    for (let step = 0; step < limits.maxSteps; step++) {
      if (Date.now() > deadline) return { ok: false, error: 'The task ran out of time before it finished.' }

      const { pageText, screenshot, title, targets, hasPasswordField } = await captureWithRetry(browser)
      const parts = [
        { type: 'text', text: renderPrompt(task, pageText, targets, title, browser.url(), recent, step) },
        { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${screenshot}` } },
      ]
      // Keep the provider session alive across the model turn: a slow step must
      // not let the idle reaper take the browser out from under the loop.
      await browser.keepalive()
      const raw = await call(parts)
      const action = raw ? parseAgentAction(raw) : null
      if (process.env.KERNEL_TRACE === '1') console.error(`[kernel] step ${step} reply: ${String(raw).slice(0, 300)}`)
      if (!action) {
        recent.push('model replied with no usable action')
        continue
      }

      const key = JSON.stringify(action)
      if (key === lastAction) {
        failed.set(key, (failed.get(key) ?? 0) + 1)
        if ((failed.get(key) ?? 0) >= 2) {
          recent.push(`repeated failing action skipped: ${key.slice(0, 80)}`)
          continue
        }
      }
      lastAction = key

      if (action.type === 'done' || action.type === 'giveup') {
        if (action.type === 'giveup') return { ok: false, error: action.reason || 'The goal could not be reached.' }
        const answer = String(action.answer || '').trim()
        if (!answer) return { ok: false, error: 'The agent produced an empty answer.' }
        const verdict = await auditCall(buildVerificationParts({ goal: task.goal || '', answer, pageText, screenshotBase64: screenshot }))
        const checked = parseVerification(verdict || '', answer)
        if (!checked.supported) {
          recent.push(`answer was not supported by the page (${checked.unsupported}) — look again`)
          continue
        }
        return { ok: true, content: answer }
      }

      if (action.type === 'handoff') {
        const kind = action.kind || 'confirmation'
        if (kind === 'payment' && !task.paymentAuthorized) {
          const cents = Number(action.amount_cents || 0)
          if (cents > 0) {
            const outcome = await requireHandoff(task, {
              kind: 'payment',
              message: action.message || 'Approve the checkout to continue.',
              url: browser.url(),
              amountCents: cents,
              merchant: action.merchant,
              item: action.item,
            })
            if (outcome === 'cancelled') return { ok: false, error: 'The user cancelled the purchase.' }
          }
        } else {
          const outcome = await requireHandoff(task, { kind, message: action.message || 'Your input is needed.', url: browser.url() })
          if (outcome === 'cancelled') return { ok: false, error: 'The user cancelled this task.' }
        }
        recent.push(`handoff:${kind} completed by the user`)
        continue
      }

      const outcome = await execute(browser, action, task)
      recent.push(outcome.ok ? `${action.type} ok` : `${action.type} failed: ${outcome.error || 'no effect'}`)
      if (!outcome.ok) failed.set(key, (failed.get(key) ?? 0) + 1)
      else failed.delete(key)
      await task.onProgress?.({ action: action.type, url: browser.url() }).catch(() => undefined)
    }

    return { ok: false, error: 'The task did not finish within the step budget.' }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

async function requireHandoff(
  task: KernelTask,
  handoff: Parameters<NonNullable<KernelTask['onHandoff']>>[0],
): Promise<'resumed' | 'cancelled' | 'timeout'> {
  if (!task.onHandoff) return 'cancelled'
  const result = await task.onHandoff(handoff)
  if (typeof result === 'string') return result
  if (result?.paymentCard) task.paymentCard = result.paymentCard
  return 'resumed'
}

async function capture(browser: KernelBrowser): Promise<{
  pageText: string
  screenshot: string
  title: string
  targets: Target[]
  hasPasswordField: boolean
}> {
  // Everything DOM-facing lives inside page.evaluate: the snippet runs in the
  // browser VM where only `page`, `context` and `browser` are in scope.
  const data = await browser.run<{
    text: string
    targets: Target[]
    hasPasswordField: boolean
    title: string
  }>(`
    const data = await page.evaluate(() => {
      // Redact protected fields before the pixels leave the browser: a payment
      // value must never become model input.
      const protectedSelector = 'input[type=password],input[autocomplete^="cc-"],input[name*="cvc" i],input[name*="cvv" i],input[name*="cardnumber" i]';
      for (const node of document.querySelectorAll(protectedSelector)) {
        node.style.setProperty('-webkit-text-security', 'disc', 'important');
        node.style.setProperty('color', 'transparent', 'important');
      }
      const out = (() => { ${TARGET_SCRIPT} })() || [];
      const visible = out.filter((t) => t.width > 0 && t.height < 1200);
      const overlayId = '__hirealpha_targets__';
      document.getElementById(overlayId)?.remove();
      const root = document.createElement('div');
      root.id = overlayId;
      root.style.cssText = 'position:fixed;inset:0;z-index:2147483647;pointer-events:none;overflow:hidden';
      for (const item of visible) {
        const box = document.createElement('div');
        box.style.cssText = 'position:absolute;left:' + item.x + 'px;top:' + item.y + 'px;width:' + item.width + 'px;height:' + item.height + 'px;border:2px solid #e9bd24;box-sizing:border-box;' + (item.sensitive ? 'background:#191914;' : '');
        const badge = document.createElement('span');
        badge.textContent = '[' + item.index + ']';
        badge.style.cssText = 'position:absolute;left:-2px;top:-16px;padding:1px 3px;background:#e9bd24;color:#171710;font:700 11px monospace;line-height:14px';
        box.appendChild(badge);
        root.appendChild(box);
      }
      document.documentElement.appendChild(root);
      return {
        text: (document.body?.innerText || '').slice(0, 3500),
        targets: visible,
        hasPasswordField: Boolean(document.querySelector('input[type="password"]')),
        title: document.title,
      };
    });
    await page.screenshot({ type: 'jpeg', quality: 50 });
    await page.evaluate(() => document.getElementById('__hirealpha_targets__')?.remove());
    return data;
  `, 90_000)
  return {
    pageText: data.text || '',
    targets: data.targets || [],
    hasPasswordField: Boolean(data.hasPasswordField),
    title: data.title || '',
    screenshot: await browser.screenshot(50),
  }
}

function renderPrompt(
  task: KernelTask,
  pageText: string,
  targets: Target[],
  title: string,
  url: string,
  recent: string[],
  step: number,
): string {
  const targetText = targets
    .map((t) => `[${t.index}] ${t.tag}${t.label ? ` "${t.label}"` : ''} box=(${t.x},${t.y},${t.width},${t.height})${t.selector ? ` selector=${t.selector}` : ''}${t.sensitive ? ' PROTECTED' : ''}`)
    .join('\n')
  const payment = task.paymentAuthorized
    ? `PAYMENT STATUS: an approved one-time card is available${task.paymentAmountCents ? ` for ${(task.paymentAmountCents / 100).toFixed(2)}` : ''}.`
    : 'PAYMENT STATUS: no card is authorized. Use payment handoff before any charge.'
  return [
    `GOAL: ${task.goal || 'complete the task on this page'}`,
    `URL: ${url}`,
    `TITLE: ${title}`,
    `STEP: ${step + 1}`,
    payment,
    recent.length ? `RECENT ACTIONS:\n${recent.slice(-6).join('\n')}` : '',
    `VISIBLE TEXT:\n${pageText}`,
    `TARGETS:\n${targetText}`,
  ].filter(Boolean).join('\n\n')
}

async function execute(
  browser: KernelBrowser,
  action: AgentAction,
  task: KernelTask,
): Promise<{ ok: boolean; error?: string }> {
  try {
    switch (action.type) {
      case 'click':
        if (!action.selector) return { ok: false, error: 'no selector' }
        return await browser.run<{ ok: boolean; error?: string }>(
          `const loc = page.locator(${JSON.stringify(action.selector)}).first();
           await loc.click({ timeout: 15000 });
           return { ok: true };`,
          45_000,
        ).catch((err) => ({ ok: false, error: err instanceof Error ? err.message : String(err) }))
      case 'click_at':
        return await browser.run<{ ok: boolean }>(
          `await page.mouse.click(${Number(action.x) || 0}, ${Number(action.y) || 0}); return { ok: true };`,
          45_000,
        ).catch((err) => ({ ok: false, error: err instanceof Error ? err.message : String(err) }))
      case 'fill':
        if (!action.selector) return { ok: false, error: 'no selector' }
        return await browser.run<{ ok: boolean }>(
          `await page.locator(${JSON.stringify(action.selector)}).first().fill(${JSON.stringify(String(action.value ?? ''))}, { timeout: 15000 });
           return { ok: true };`,
          45_000,
        ).catch((err) => ({ ok: false, error: err instanceof Error ? err.message : String(err) }))
      case 'type_text':
        return await browser.run<{ ok: boolean }>(
          `await page.keyboard.type(${JSON.stringify(String(action.value ?? ''))}, { delay: 18 }); return { ok: true };`,
          60_000,
        ).catch((err) => ({ ok: false, error: err instanceof Error ? err.message : String(err) }))
      case 'press':
        return await browser.run<{ ok: boolean }>(
          `await page.keyboard.press(${JSON.stringify(String(action.key || 'Enter'))}); return { ok: true };`,
          30_000,
        ).catch((err) => ({ ok: false, error: err instanceof Error ? err.message : String(err) }))
      case 'navigate': {
        const target = String(action.url || '')
        if (!/^https:\/\//i.test(target)) return { ok: false, error: 'navigation must be https' }
        const current = browser.url()
        const sameHost = (() => {
          try {
            const a = new URL(current).hostname.split('.').slice(-2).join('.')
            const b = new URL(target).hostname.split('.').slice(-2).join('.')
            return a === b
          } catch {
            return false
          }
        })()
        if (!sameHost) return { ok: false, error: 'navigation outside the task site is not allowed' }
        await browser.goto(target, { waitUntil: 'domcontentloaded', timeout: 45_000 })
        return { ok: true }
      }
      case 'scroll':
        return await browser.run<{ ok: boolean }>(
          `await page.mouse.wheel(0, ${action.direction === 'up' ? -900 : 900}); return { ok: true };`,
          30_000,
        ).catch((err) => ({ ok: false, error: err instanceof Error ? err.message : String(err) }))
      case 'wait':
        await new Promise((r) => setTimeout(r, Math.min(10_000, Math.max(0, Number(action.ms) || 1500))))
        return { ok: true }
      case 'fill_payment': {
        const card = task.paymentCard
        if (!card) return { ok: false, error: 'no authorized card' }
        const visibleTotal = pageShowsExactTotal('', task.paymentAmountCents || 0)
        if (!visibleTotal) return { ok: false, error: 'total not verified on the page' }
        return await browser.run<{ ok: boolean; error?: string }>(
          `const values = ${JSON.stringify(card)};
           const set = async (selector, value) => {
             const loc = page.locator(selector).first();
             if (await loc.count().catch(() => 0)) await loc.fill(value, { timeout: 8000 });
           };
           await set('input[autocomplete="cc-number"],input[name*="cardnumber" i]', values.number);
           await set('input[autocomplete="cc-exp"],input[name*="expiry" i],input[name*="expiration" i]', values.expiry);
           await set('input[autocomplete="cc-csc"],input[name*="cvc" i],input[name*="cvv" i]', values.cvc);
           return { ok: true };`,
          45_000,
        ).catch((err) => ({ ok: false, error: err instanceof Error ? err.message : String(err) }))
      }
      default:
        return { ok: false, error: `unsupported action ${action.type}` }
    }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}
