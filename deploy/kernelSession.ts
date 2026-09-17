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
  updateAgentPlan,
  formatPlanForPrompt,
  type AgentAction,
  type AgentPlan,
  type PaymentCardSecrets,
} from './agentDriver'
import { KernelBrowser } from './kernelPage'
import { startSpan, traceHost } from './telemetry'
import { claimPendingText } from './browserJobs'
import {
  extractRootDomain,
  formatProcedureForPrompt,
  loadSiteProcedure,
  saveSiteProcedure,
  synthesizeProcedureFromTrajectory,
} from './siteMemory'
import type { SQL } from 'bun'

export type KernelTask = {
  url: string
  username?: string
  password?: string
  goal?: string
  jobId?: string
  sql?: SQL | null
  /** USER PROFILE prompt block (real name/email/phone/addresses) — the agent
   * fills forms from it or asks; placeholders like "John Smith" are banned. */
  identity?: string
  onProgress?: (event: { action: string; url: string }) => Promise<void>
  onScreenshot?: (event: { dataUrl: string; caption?: string }) => Promise<void>
  onHandoff?: (handoff: {
    kind: 'password' | 'verification' | 'payment' | 'captcha' | 'confirmation' | 'question'
    message: string
    url: string
    amountCents?: number
    currency?: string
    merchant?: string
    item?: string
    checkAutoResume?: () => Promise<{ resumed: boolean; reason?: string } | null>
  }) => Promise<
    | 'resumed'
    | 'cancelled'
    | 'timeout'
    | { status: 'resumed'; paymentCard: PaymentCardSecrets }
    | { status: 'resumed'; answer: string | null }
  >
  paymentAuthorized?: boolean
  paymentAmountCents?: number
  paymentCard?: PaymentCardSecrets
}

export type VerifiedPurchase = {
  amountCents: number
  currency: string
  merchant: string
  item: string
  url: string
}

/** Deterministic checkout extraction. Payment authorization must never be
 * built from model prose alone. Require structured commerce data and confirm
 * its exact amount is also rendered in the current page. */
export async function readVerifiedKernelPurchase(browser: KernelBrowser): Promise<VerifiedPurchase | null> {
  const extracted = await browser.run<VerifiedPurchase | null>(`
    return await page.evaluate(() => {
      const objects = [];
      for (const node of document.querySelectorAll('script[type="application/ld+json"]')) {
        try {
          const value = JSON.parse(node.textContent || 'null');
          if (Array.isArray(value)) objects.push(...value); else if (value) objects.push(value);
        } catch {}
      }
      const flat = [];
      const visit = (value) => {
        if (!value || typeof value !== 'object') return;
        flat.push(value);
        if (Array.isArray(value['@graph'])) value['@graph'].forEach(visit);
        if (Array.isArray(value.itemListElement)) value.itemListElement.forEach(visit);
      };
      objects.forEach(visit);
      const offerOwner = flat.find((value) => value.offers && (value.name || value['@type'] === 'Product'));
      const offer = Array.isArray(offerOwner?.offers) ? offerOwner.offers[0] : offerOwner?.offers
        || flat.find((value) => value.price != null && value.priceCurrency);
      const meta = (name) => document.querySelector('meta[property="' + name + '"],meta[name="' + name + '"]')?.content || '';
      const rawPrice = offer?.price ?? offer?.lowPrice ?? meta('product:price:amount');
      const currency = String(offer?.priceCurrency || meta('product:price:currency') || '').toUpperCase();
      const item = String(offerOwner?.name || offer?.name || meta('og:title') || '').replace(/\\s+/g, ' ').trim();
      const price = Number(String(rawPrice ?? '').replace(/[^0-9.,-]/g, '').replace(/,(?=\\d{1,2}$)/, '.').replace(/,/g, ''));
      if (!Number.isFinite(price) || price <= 0 || !/^[A-Z]{3}$/.test(currency) || !item) return null;
      return {
        amountCents: Math.round(price * 100), currency,
        merchant: location.hostname.toLowerCase().replace(/^www\\./, ''),
        item: item.slice(0, 200), url: location.href,
      };
    });
  `, 20_000).catch(() => null)
  if (!extracted) return null
  const visible = await browser.text('body', 12_000).catch(() => '')
  if (!pageShowsExactTotal(visible, extracted.amountCents)) return null
  if (!new RegExp(`\\b${extracted.currency.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(visible)
    && !/[$€£¥]/.test(visible)) return null
  return extracted
}

export async function attemptKernelLogin(
  browser: KernelBrowser,
  username?: string,
  password?: string,
): Promise<{ ok: boolean; filled: boolean }> {
  if (!password) return { ok: false, filled: false }
  try {
    const result = await browser.run<{ ok: boolean; filled: boolean }>(
      `const usernameVal = ${JSON.stringify(username || '')};
       const passwordVal = ${JSON.stringify(password || '')};
       const pwLoc = page.locator('input[type="password"]').first();
       const pwCount = await pwLoc.count().catch(() => 0);
       if (!pwCount) return { ok: true, filled: false };

        const userSelectors = [
          'input[placeholder*="csu" i]',
          'input[placeholder*="id" i]',
          'input[placeholder*="user" i]',
          'input[name*="user" i]',
          'input[name*="login" i]',
          'input[name*="id" i]',
          'input[id*="user" i]',
          'input[id*="login" i]',
          'input[id*="id" i]',
          'input[name*="student" i]',
          'input[id*="student" i]',
          'input[aria-label*="csu" i]',
          'input[aria-label*="user" i]',
          'input[aria-label*="id" i]',
          'input[autocomplete*="username" i]',
          'input[type="email"]',
          'input[type="text"]',
          'input[type="number"]',
          'input[type="tel"]'
        ];
        if (usernameVal) {
          for (const sel of userSelectors) {
            const loc = page.locator(sel).first();
            if (await loc.count().catch(() => 0)) {
              try {
                await loc.fill(usernameVal, { timeout: 4000 });
                break;
              } catch {}
            }
          }
        }
        await pwLoc.fill(passwordVal, { timeout: 6000 });
        await page.waitForTimeout(600).catch(() => undefined);

        const submitSelectors = [
          'button[type="submit"]',
          'input[type="submit"]',
          'button:has-text("Login")',
          'button:has-text("Log In")',
          'button:has-text("Sign In")',
          'button:has-text("Submit")',
          'input[value*="Login" i]',
          'input[value*="Log In" i]',
          'input[value*="Sign In" i]',
          'input[value*="Submit" i]'
        ];
        let clicked = false;
        for (const sel of submitSelectors) {
          const btn = page.locator(sel).first();
          if (await btn.count().catch(() => 0)) {
            try {
              await btn.click({ timeout: 4000 });
              clicked = true;
              break;
            } catch {}
          }
        }
        if (!clicked) {
          try { await pwLoc.press('Enter', { timeout: 4000 }); } catch {}
        }
        return { ok: true, filled: true };`,
      45_000,
    )
    if (result.filled) {
      await browser.settle(15_000).catch(() => undefined)
    }
    return result
  } catch (err) {
    return { ok: false, filled: false }
  }
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
    let plan: AgentPlan | null = null
    let requestedScreenshot = false
    let lastActionFailed = false
    const trajectory: Array<{ type: string; selector?: string; value?: unknown; key?: string; label?: string }> = []
    let currentRootDomain = extractRootDomain(task.url || browser.url())
    let siteProcedure = await loadSiteProcedure(task.sql, currentRootDomain).catch(() => null)
    let siteProcedureText = siteProcedure ? formatProcedureForPrompt(currentRootDomain, siteProcedure) : ''

    if (task.password) {
      const loginAttempt = await attemptKernelLogin(browser, task.username, task.password)
      if (loginAttempt.filled) {
        recent.push('Automated login submitted with saved credentials from Vault.')
        await task.onProgress?.({ action: 'login', url: browser.url() }).catch(() => undefined)
      }
    }

    for (let step = 0; step < limits.maxSteps; step++) {
      if (Date.now() > deadline) return { ok: false, error: 'The task ran out of time before it finished.' }

      const { pageText, screenshot, title, targets, hasPasswordField } = await captureWithRetry(browser)

      if (hasPasswordField && task.password && !recent.some((r) => r.includes('Automated login submitted'))) {
        const loginAttempt = await attemptKernelLogin(browser, task.username, task.password)
        if (loginAttempt.filled) {
          recent.push('Automated login submitted with saved credentials from Vault.')
          await task.onProgress?.({ action: 'login', url: browser.url() }).catch(() => undefined)
          continue
        }
      }

      // Check if domain changed across steps to load relevant site memory
      const newDomain = extractRootDomain(browser.url())
      if (newDomain && newDomain !== currentRootDomain) {
        currentRootDomain = newDomain
        siteProcedure = await loadSiteProcedure(task.sql, currentRootDomain).catch(() => null)
        siteProcedureText = siteProcedure ? formatProcedureForPrompt(currentRootDomain, siteProcedure) : ''
      }

      // DOM-first observation: attach screenshot only on demand, fallback, or empty DOM
      const needScreenshot =
        requestedScreenshot ||
        lastActionFailed ||
        (targets.length === 0 && pageText.length < 150)

      requestedScreenshot = false

      const promptText = renderPrompt(
        task,
        pageText,
        targets,
        title,
        browser.url(),
        recent,
        step,
        plan,
        siteProcedureText,
      )

      const parts: unknown[] = [{ type: 'text', text: promptText }]
      if (needScreenshot && screenshot) {
        parts.push({ type: 'image_url', image_url: { url: `data:image/jpeg;base64,${screenshot}` } })
      }

      // Keep the provider session alive across the model turn: a slow step must
      // not let the idle reaper take the browser out from under the loop.
      await browser.keepalive()
      // Takeover text relay: the user cannot raise a phone keyboard inside a
      // streamed browser, so text typed on the session page arrives here and
      // goes into whatever the page has focused before the next decision.
      if (task.sql && task.jobId) {
        const relay = await claimPendingText(task.sql, task.jobId).catch(() => null)
        if (relay) {
          await browser.run(
            `await page.keyboard.type(${JSON.stringify(relay)}, { delay: 18 }); return { ok: true };`,
            30_000,
          ).catch(() => undefined)
          recent.push(`user typed via takeover into the focused field: "${relay.slice(0, 120)}"`)
        }
      }
      if (screenshot && (task.onScreenshot || needScreenshot)) {
        await task.onScreenshot?.({ dataUrl: `data:image/jpeg;base64,${screenshot}`, caption: title?.trim() ? `Step ${step + 1}: ${title}` : `Step ${step + 1}` }).catch(() => undefined)
      }
      let raw = ''
      const decisionSpan = startSpan('browser.step.decide', {
        'browser.step.index': step,
        'browser.step.page_chars': pageText.length,
        'browser.step.targets': targets.length,
        'browser.step.screenshot_attached': Boolean(needScreenshot && screenshot),
      })
      const decisionStart = Date.now()
      try {
        raw = await call(parts)
      } catch (callErr) {
        console.warn(`[kernel] step ${step} call failed:`, callErr)
        try {
          raw = await call([{ type: 'text', text: promptText }])
        } catch (textErr) {
          decisionSpan.end({ 'browser.step.decide_ms': Date.now() - decisionStart }, textErr)
          recent.push(`model error: ${textErr instanceof Error ? textErr.message : String(textErr)}`)
          continue
        }
      }
      decisionSpan.end({ 'browser.step.decide_ms': Date.now() - decisionStart, 'browser.step.reply_chars': raw.length })
      const action = raw ? parseAgentAction(raw) : null
      if (process.env.KERNEL_TRACE === '1' || process.env.DEBUG) console.error(`[kernel] step ${step} reply: ${String(raw).slice(0, 300)}`)
      if (!action) {
        recent.push('model replied with no usable action')
        lastActionFailed = true
        continue
      }

      // Update hierarchical plan if model provided subgoals or active subgoal
      if (action.plan || action.current_subgoal) {
        plan = updateAgentPlan(plan, action.plan, action.current_subgoal)
      }

      // Handle on-demand screenshot request for the next step
      if (action.observe === 'screenshot') {
        requestedScreenshot = true
      }

      const key = JSON.stringify(action)
      if (key === lastAction) {
        failed.set(key, (failed.get(key) ?? 0) + 1)
        if ((failed.get(key) ?? 0) >= 2) {
          recent.push(`repeated failing action skipped: ${key.slice(0, 80)}`)
          lastActionFailed = true
          continue
        }
      }
      lastAction = key

      if (action.type === 'done' || action.type === 'giveup') {
        if (action.type === 'giveup') return { ok: false, error: action.reason || 'The goal could not be reached.' }
        const answer = String(action.answer || '').trim()
        if (!answer) return { ok: false, error: 'The agent produced an empty answer.' }
        const verdict = await auditCall(buildVerificationParts({ goal: task.goal || '', answer, pageText, screenshotBase64: screenshot })).catch(() => '')
        const checked = parseVerification(verdict || '', answer)
        if (!checked.supported) {
          recent.push(`answer was not supported by the page (${checked.unsupported}) — look again`)
          lastActionFailed = true
          continue
        }
        // Save distilled procedure to site memory on task success
        if (trajectory.length > 0) {
          try {
            const distilled = synthesizeProcedureFromTrajectory(task.goal || '', trajectory)
            await saveSiteProcedure(task.sql, browser.url(), distilled)
          } catch {}
        }
        // The receipt must match the claim: with DOM-first observation the
        // last on-demand capture can predate the final actions (seen live —
        // the delivered screenshot showed an untopped form while the result
        // text correctly reported the submitted one). Grab the page as it
        // stands now so the image proves what the answer asserts.
        try {
          const finalShot = await browser.screenshot(60)
          const finalTitle = await browser.title().catch(() => '')
          await task.onScreenshot?.({ dataUrl: `data:image/jpeg;base64,${finalShot}`, caption: finalTitle ? `Final: ${finalTitle}` : 'Final page' })
        } catch { /* receipt falls back to the last step image */ }
        return { ok: true, content: answer }
      }

      if (action.type === 'handoff') {
        const kind = action.kind || 'confirmation'
        let outcomeInfo: Awaited<ReturnType<typeof requireHandoff>>
        if (kind === 'payment' && !task.paymentAuthorized) {
          const cents = Number(action.amountCents || 0)
          if (cents > 0) {
            outcomeInfo = await requireHandoff(task, browser, {
              kind: 'payment',
              message: action.message || 'Approve the checkout to continue.',
              url: browser.url(),
              amountCents: cents,
              merchant: action.merchant,
              item: action.item,
            }, hasPasswordField)
            if (outcomeInfo.outcome === 'cancelled') return { ok: false, error: 'The user cancelled the purchase.' }
          } else {
            continue
          }
        } else {
          outcomeInfo = await requireHandoff(task, browser, {
            kind,
            message: action.message || 'Your input is needed.',
            url: browser.url(),
          }, hasPasswordField)
          if (outcomeInfo.outcome === 'cancelled') return { ok: false, error: 'The user cancelled this task.' }
        }

        const triggerSummary = outcomeInfo.triggers.length
          ? `Observed user actions: ${outcomeInfo.triggers.slice(-6).join(', ')}.`
          : 'User completed interaction directly in browser.'
        const navSummary = outcomeInfo.initialUrl !== outcomeInfo.finalUrl
          ? `Page navigated from "${outcomeInfo.initialUrl}" (${outcomeInfo.initialTitle}) to "${outcomeInfo.finalUrl}" (${outcomeInfo.finalTitle}).`
          : `Current page: "${outcomeInfo.finalUrl}" (${outcomeInfo.finalTitle}).`

        if (kind === 'password') {
          recent.push(`User took over and completed sign-in. ${triggerSummary} ${navSummary} Successfully authenticated. Now proceed with the task goal: "${task.goal || 'continue'}".`)
        } else if (outcomeInfo.answer) {
          recent.push(`user answered: "${outcomeInfo.answer.slice(0, 200)}" — type this into the field the question was about`)
        } else {
          recent.push(`User took over and completed handoff:${kind}. ${triggerSummary} ${navSummary} Now proceed with the task goal: "${task.goal || 'continue'}".`)
        }

        await task.onProgress?.({
          action: outcomeInfo.autoResumed ? 'user_auto_resumed' : 'user_resumed',
          url: outcomeInfo.finalUrl,
        }).catch(() => undefined)
        continue
      }

      const actionSpan = startSpan('browser.step.act', {
        'browser.step.index': step,
        'browser.action': action.type,
        'browser.target.host': traceHost(browser.url()),
      })
      const actionStart = Date.now()
      const outcome = await executeKernelAction(browser, action, task)
      actionSpan.end(
        {
          'browser.action_ms': Date.now() - actionStart,
          'browser.action.ok': outcome.ok,
          'browser.action.error': outcome.ok ? undefined : String(outcome.error || 'no effect').slice(0, 200),
          'browser.step.retry_count': failed.get(key) ?? 0,
        },
        outcome.ok ? undefined : new Error(String(outcome.error || `${action.type} had no effect`)),
      )
      lastActionFailed = !outcome.ok
      recent.push(outcome.ok ? `${action.type} ok` : `${action.type} failed: ${outcome.error || 'no effect'}`)
      if (!outcome.ok) {
        failed.set(key, (failed.get(key) ?? 0) + 1)
      } else {
        failed.delete(key)
        let matchedLabel: string | undefined
        if ('selector' in action && action.selector) {
          matchedLabel = targets.find((t) => t.selector === action.selector)?.label
        }
        trajectory.push({
          type: action.type,
          selector: 'selector' in action ? action.selector : undefined,
          value: 'value' in action ? action.value : undefined,
          key: 'key' in action ? action.key : undefined,
          label: matchedLabel,
        })
      }
      await task.onProgress?.({ action: action.type, url: browser.url() }).catch(() => undefined)
    }

    return { ok: false, error: 'The task did not finish within the step budget.' }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

export async function inspectTakeoverState(
  browser: KernelBrowser,
  initialUrl: string,
  initialHasPassword: boolean,
): Promise<{
  resumed: boolean
  reason?: string
  triggers: string[]
  currentUrl: string
  currentTitle: string
}> {
  try {
    return await browser.run<{
      resumed: boolean
      reason?: string
      triggers: string[]
      currentUrl: string
      currentTitle: string
    }>(`
      const initialUrl = ${JSON.stringify(initialUrl)};
      const initialHasPassword = ${JSON.stringify(initialHasPassword)};
      const currentUrl = page.url();
      const currentTitle = await page.title().catch(() => '');

      try {
        const readyState = await page.evaluate(() => document.readyState);
        if (readyState !== 'complete') {
          await page.waitForLoadState('domcontentloaded', { timeout: 3000 }).catch(() => undefined);
        }
      } catch {}

      const rawEvents = await page.evaluate(() => {
        window.__ha_events = window.__ha_events || [];
        const events = [...window.__ha_events];
        window.__ha_events = [];
        if (!window.__ha_listener_installed) {
          window.__ha_listener_installed = true;
          document.addEventListener('click', (e) => {
            try {
              const el = e.target.closest('button, a, input[type="submit"], input[type="button"], [role="button"], input[type="checkbox"], input[type="radio"]');
              if (el) {
                const text = (el.innerText || el.value || el.getAttribute('aria-label') || el.id || el.className || el.tagName).slice(0, 80).replace(/\\s+/g, ' ').trim();
                window.__ha_events.push({ action: 'click', label: text, tag: el.tagName.toLowerCase(), at: Date.now() });
              }
            } catch {}
          }, { capture: true, passive: true });
          document.addEventListener('submit', (e) => {
            try {
              const form = e.target;
              const id = form.id || form.name || form.className || 'form';
              window.__ha_events.push({ action: 'submit', form: String(id).slice(0, 50), at: Date.now() });
            } catch {}
          }, { capture: true, passive: true });
          document.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
              window.__ha_events.push({ action: 'press_enter', at: Date.now() });
            }
          }, { capture: true, passive: true });
        }
        return events;
      }).catch(() => []);

      const triggers = rawEvents.map((e) => {
        if (e.action === 'click') return 'clicked "' + e.label + '"';
        if (e.action === 'submit') return 'submitted form ' + (e.form || '');
        if (e.action === 'press_enter') return 'pressed Enter';
        return e.action;
      });

      const pageInfo = await page.evaluate(() => {
        const pwInput = document.querySelector('input[type="password"]');
        const hasPw = Boolean(pwInput && pwInput.offsetParent !== null);
        const bodyText = (document.body?.innerText || '').toLowerCase();
        const hasSignOut = Boolean(
          document.querySelector('a[href*="logout" i], a[href*="signout" i], button:has-text("Sign Out"), [aria-label*="sign out" i], [aria-label*="log out" i]') ||
          bodyText.includes('sign out') || bodyText.includes('log out') || bodyText.includes('signed in as') ||
          bodyText.includes('welcome,') || bodyText.includes('student center') || bodyText.includes('my account')
        );
        const isLoginError = bodyText.includes('invalid username') || bodyText.includes('invalid password') ||
          bodyText.includes('incorrect user') || bodyText.includes('incorrect password') || bodyText.includes('authentication failed');
        return { hasPw, hasSignOut, isLoginError };
      }).catch(() => ({ hasPw: false, hasSignOut: false, isLoginError: false }));

      const urlChanged = currentUrl !== initialUrl;
      const isLoginUrl = /[\\/](login|signin|auth|sso|authenticate|cas|saml)(\\.jsp|\\.html|\\.php|\\/|$)/i.test(currentUrl);
      const initialWasLoginUrl = /[\\/](login|signin|auth|sso|authenticate|cas|saml)(\\.jsp|\\.html|\\.php|\\/|$)/i.test(initialUrl);

      let resumed = false;
      let reason = '';

      if (initialHasPassword) {
        if (initialWasLoginUrl && !isLoginUrl && urlChanged && !pageInfo.isLoginError) {
          resumed = true;
          reason = 'User logged in: navigated to ' + currentUrl;
        } else if (pageInfo.hasSignOut && !pageInfo.hasPw) {
          resumed = true;
          reason = 'User logged in: detected authenticated session';
        } else if (!pageInfo.hasPw && urlChanged && !pageInfo.isLoginError) {
          resumed = true;
          reason = 'User completed login form';
        }
      } else if (urlChanged && !pageInfo.isLoginError) {
        resumed = true;
        reason = 'User completed interaction: navigated to ' + currentUrl;
      }

      return { resumed, reason, triggers, currentUrl, currentTitle };
    `, 20_000)
  } catch (err) {
    return {
      resumed: false,
      triggers: [],
      currentUrl: browser.url(),
      currentTitle: '',
    }
  }
}

async function requireHandoff(
  task: KernelTask,
  browser: KernelBrowser,
  handoff: {
    kind: 'password' | 'verification' | 'payment' | 'captcha' | 'confirmation' | 'question'
    message: string
    url: string
    amountCents?: number
    currency?: string
    merchant?: string
    item?: string
  },
  hasPasswordField = false,
): Promise<{
  outcome: 'resumed' | 'cancelled' | 'timeout'
  answer: string | null
  triggers: string[]
  initialUrl: string
  finalUrl: string
  initialTitle: string
  finalTitle: string
  autoResumed: boolean
  autoResumeReason?: string
}> {
  if (!task.onHandoff) {
    return {
      outcome: 'cancelled',
      answer: null,
      triggers: [],
      initialUrl: browser.url(),
      finalUrl: browser.url(),
      initialTitle: '',
      finalTitle: '',
      autoResumed: false,
    }
  }

  const initialUrl = browser.url()
  const initialTitle = await browser.title().catch(() => '')
  const initialHasPassword = hasPasswordField
  const allTriggers: string[] = []
  let autoResumed = false
  let autoResumeReason = ''

  // Arm listener on page immediately
  await browser.run(`
    window.__ha_events = window.__ha_events || [];
    if (!window.__ha_listener_installed) {
      window.__ha_listener_installed = true;
      document.addEventListener('click', (e) => {
        try {
          const el = e.target.closest('button, a, input[type="submit"], input[type="button"], [role="button"], input[type="checkbox"], input[type="radio"]');
          if (el) {
            const text = (el.innerText || el.value || el.getAttribute('aria-label') || el.id || el.className || el.tagName).slice(0, 80).replace(/\\s+/g, ' ').trim();
            window.__ha_events.push({ action: 'click', label: text, tag: el.tagName.toLowerCase(), at: Date.now() });
          }
        } catch {}
      }, { capture: true, passive: true });
      document.addEventListener('submit', (e) => {
        try {
          const form = e.target;
          const id = form.id || form.name || form.className || 'form';
          window.__ha_events.push({ action: 'submit', form: String(id).slice(0, 50), at: Date.now() });
        } catch {}
      }, { capture: true, passive: true });
      document.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          window.__ha_events.push({ action: 'press_enter', at: Date.now() });
        }
      }, { capture: true, passive: true });
    }
  `, 10_000).catch(() => undefined)

  const checkAutoResume = async (): Promise<{ resumed: boolean; reason?: string } | null> => {
    try {
      await browser.keepalive()
      // Text relay during takeover too: while the human drives the waiting
      // session, anything they type on the session page goes to the focused
      // field here — the streamed browser cannot raise a phone keyboard.
      if (task.sql && task.jobId) {
        const relay = await claimPendingText(task.sql, task.jobId).catch(() => null)
        if (relay) {
          await browser.run(
            `await page.keyboard.type(${JSON.stringify(relay)}, { delay: 18 }); return { ok: true };`,
            30_000,
          ).catch(() => undefined)
        }
      }
      const inspection = await inspectTakeoverState(browser, initialUrl, initialHasPassword)
      if (inspection.triggers && inspection.triggers.length) {
        allTriggers.push(...inspection.triggers)
      }
      if (inspection.resumed) {
        autoResumed = true
        autoResumeReason = inspection.reason || 'User completed interaction'
        return { resumed: true, reason: autoResumeReason }
      }
      return null
    } catch {
      return null
    }
  }

  let guardedHandoff = handoff
  if (handoff.kind === 'payment') {
    const verified = await readVerifiedKernelPurchase(browser)
    if (!verified || verified.amountCents !== handoff.amountCents) {
      return {
        outcome: 'cancelled', answer: null, triggers: allTriggers,
        initialUrl, finalUrl: browser.url(), initialTitle,
        finalTitle: await browser.title().catch(() => ''), autoResumed: false,
      }
    }
    guardedHandoff = {
      ...handoff, url: verified.url, amountCents: verified.amountCents,
      currency: verified.currency, merchant: verified.merchant, item: verified.item,
    }
  }
  const result = await task.onHandoff({
    ...guardedHandoff,
    checkAutoResume: handoff.kind !== 'question' ? checkAutoResume : undefined,
  })

  // When resumed, give the new page a moment to settle
  await browser.settle(10_000).catch(() => undefined)
  const finalUrl = browser.url()
  const finalTitle = await browser.title().catch(() => '')

  // Drain any remaining tracked events from the page
  try {
    const remainingEvents = await browser.run<Array<{ action: string; label?: string; form?: string }>>(`
      return (window.__ha_events || []).splice(0);
    `, 10_000).catch(() => [])
    for (const e of remainingEvents) {
      if (e.action === 'click' && e.label) allTriggers.push(`clicked "${e.label}"`)
      else if (e.action === 'submit') allTriggers.push(`submitted form ${e.form || ''}`)
      else if (e.action === 'press_enter') allTriggers.push('pressed Enter')
      else if (e.action) allTriggers.push(e.action)
    }
  } catch {}

  let outcome: 'resumed' | 'cancelled' | 'timeout' = 'cancelled'
  let answer: string | null = null

  if (typeof result === 'string') {
    outcome = result
  } else if ('paymentCard' in result) {
    if (result.paymentCard) task.paymentCard = result.paymentCard
    outcome = 'resumed'
  } else if ('answer' in result) {
    outcome = 'resumed'
    answer = result.answer ?? null
  }

  return {
    outcome,
    answer,
    triggers: allTriggers,
    initialUrl,
    finalUrl,
    initialTitle,
    finalTitle,
    autoResumed,
    autoResumeReason,
  }
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
    screenshot: string
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
    const shot = await page.screenshot({ type: 'jpeg', quality: 50 });
    await page.evaluate(() => document.getElementById('__hirealpha_targets__')?.remove());
    return { ...data, screenshot: shot.toString('base64') };
  `, 90_000)
  return {
    pageText: data.text || '',
    targets: data.targets || [],
    hasPasswordField: Boolean(data.hasPasswordField),
    title: data.title || '',
    screenshot: data.screenshot || '',
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
  plan?: AgentPlan | null,
  siteMemory?: string,
): string {
  const targetText = targets
    .map((t) => `[${t.index}] ${t.tag}${t.label ? ` "${t.label}"` : ''} box=(${t.x},${t.y},${t.width},${t.height})${t.selector ? ` selector=${t.selector}` : ''}${t.sensitive ? ' PROTECTED' : ''}`)
    .join('\n')
  const payment = task.paymentAuthorized
    ? `PAYMENT STATUS: an approved one-time card is available${task.paymentAmountCents ? ` for ${(task.paymentAmountCents / 100).toFixed(2)}` : ''}.`
    : 'PAYMENT STATUS: no card is authorized. Use payment handoff before any charge.'
  const authStatus = task.password
    ? 'VAULT STATUS: login credentials are saved in Vault.'
    : 'VAULT STATUS: no credentials in Vault.'
  const planBlock = formatPlanForPrompt(plan || null)
  const stepInstruction = step === 0 && (!plan || !plan.subgoals.length)
    ? 'PLANNING REQUIREMENT: Step 1 MUST include "plan": ["subgoal 1", "subgoal 2", ...] (2-5 subgoals) and "current_subgoal": "subgoal 1" in your JSON response.'
    : ''

  return [
    `GOAL: ${task.goal || 'complete the task on this page'}`,
    planBlock,
    stepInstruction,
    task.identity || '',
    siteMemory || '',
    `URL: ${url}`,
    `TITLE: ${title}`,
    `STEP: ${step + 1}`,
    authStatus,
    payment,
    recent.length ? `RECENT ACTIONS:\n${recent.slice(-6).join('\n')}` : '',
    `VISIBLE TEXT:\n${pageText}`,
    `TARGETS:\n${targetText}`,
  ].filter(Boolean).join('\n\n')
}

export async function executeKernelAction(
  browser: KernelBrowser,
  action: AgentAction,
  task: KernelTask,
): Promise<{ ok: boolean; error?: string }> {
  try {
    switch (action.type) {
      case 'click':
        if (!action.selector) return { ok: false, error: 'no selector' }
        if (task.paymentAuthorized) {
          const label = await browser.run<string>(
            `const el = page.locator(${JSON.stringify(action.selector)}).first(); return String(await el.innerText().catch(() => '') || await el.getAttribute('value').catch(() => '') || await el.getAttribute('aria-label').catch(() => ''));`,
            15_000,
          ).catch(() => '')
          if (/place order|pay now|complete purchase|confirm purchase|submit order|buy now/i.test(label)) {
            const current = await browser.text('body', 12_000).catch(() => '')
            if (!pageShowsExactTotal(current, task.paymentAmountCents || 0)) return { ok: false, error: 'checkout total changed before submission' }
            const claimed = await browser.run<boolean>(
              `if (window.__haPaymentSubmitted) return false; window.__haPaymentSubmitted = true; return true;`,
              10_000,
            ).catch(() => false)
            if (!claimed) return { ok: false, error: 'checkout was already submitted' }
          }
        }
        return await browser.run<{ ok: boolean; error?: string }>(
          `const loc = page.locator(${JSON.stringify(action.selector)}).first();
           await loc.click({ timeout: 15000 });
           return { ok: true };`,
          45_000,
        ).catch((err) => ({ ok: false, error: err instanceof Error ? err.message : String(err) }))
      case 'click_at':
        if (task.paymentAuthorized) return { ok: false, error: 'coordinate clicks are disabled after payment approval; use a named purchase control' }
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
        if (task.paymentAuthorized && String(action.key || '').toLowerCase() === 'enter') {
          return { ok: false, error: 'Enter submission is disabled after payment approval; use the named purchase control once' }
        }
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
        const livePageText = await browser.run<string>(
          `return document.body?.innerText || '';`,
          15_000,
        ).catch(() => '')
        const visibleTotal = pageShowsExactTotal(livePageText, task.paymentAmountCents || 0)
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
