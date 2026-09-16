import {
  agentEnvCaller,
  buildVerificationParts,
  parseVerification,
  type AgentAction,
} from './agentDriver'
import { executeKernelAction, readVerifiedKernelPurchase, type KernelTask } from './kernelSession'
import type { KernelBrowser } from './kernelPage'

const EVENT_PREFIX = 'HIREALPHA_EVENT '

export type BrowserUseCredentialConfig = {
  state: 'complete' | 'partial' | 'missing'
  username: string
  password: string
  origin: string
}

/** Browser Use placeholders are not a credential-validity check: a missing
 * secret is only warned about by the library. Make completeness explicit so
 * the runner can hand off instead of attempting a login with a blank field. */
export function buildBrowserUseCredentialConfig(task: Pick<KernelTask, 'url' | 'username' | 'password'>): BrowserUseCredentialConfig {
  const username = task.username?.trim() || ''
  const password = task.password || ''
  let origin = ''
  try { origin = new URL(task.url).origin } catch { /* task URL is validated by the worker */ }
  const supplied = Number(Boolean(username)) + Number(Boolean(password))
  return {
    state: supplied === 2 ? 'complete' : supplied === 1 ? 'partial' : 'missing',
    username,
    password,
    origin,
  }
}

type BridgeEvent =
  | { type: 'progress'; step: number; url?: string; actions?: Array<Record<string, unknown>> }
  | { type: 'handoff'; request_id: string; kind: NonNullable<Parameters<NonNullable<KernelTask['onHandoff']>>[0]>['kind']; message: string; amount_cents?: number; merchant?: string; item?: string }
  | { type: 'submit_payment'; request_id: string; amount_cents: number }
  | { type: 'result'; ok: boolean; content?: string; error?: string; errors?: string[] }

async function* lines(stream: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  let pending = ''
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      pending += decoder.decode(value, { stream: true })
      let newline = pending.indexOf('\n')
      while (newline >= 0) {
        yield pending.slice(0, newline).trimEnd()
        pending = pending.slice(newline + 1)
        newline = pending.indexOf('\n')
      }
    }
    pending += decoder.decode()
    if (pending) yield pending.trimEnd()
  } finally {
    reader.releaseLock()
  }
}

function describeActions(actions?: Array<Record<string, unknown>>): string {
  if (!actions?.length) return 'browser_use_step'
  return actions.map((action) => Object.keys(action)[0] || 'action').join(',').slice(0, 120)
}

export async function runBrowserUseTask(
  task: KernelTask,
  browser: KernelBrowser,
): Promise<{ ok: true; content: string } | { ok: false; error: string }> {
  if (!browser.cdpUrl) return { ok: false, error: 'Kernel did not return a CDP URL for Browser Use.' }
  if (!task.goal?.trim()) return { ok: false, error: 'Browser Use requires an agent goal.' }

  const python = process.env.BROWSER_USE_PYTHON || 'python3'
  const runner = process.env.BROWSER_USE_RUNNER || `${import.meta.dir}/browserUseRunner.py`
  const proc = Bun.spawn([python, runner], {
    stdin: 'pipe', stdout: 'pipe', stderr: 'pipe', env: process.env,
  })
  const writer = proc.stdin
  const send = (value: unknown) => writer.write(`${JSON.stringify(value)}\n`)
  const credential = buildBrowserUseCredentialConfig(task)
  send({
    cdp_url: browser.cdpUrl,
    url: task.url,
    goal: task.goal,
    username: credential.username,
    password: credential.password,
    credential_state: credential.state,
    credential_origin: credential.origin,
    identity: task.identity || '',
    max_steps: Number(process.env.BROWSER_USE_MAX_STEPS || 40),
  })

  // Once card aliases are present, final purchase controls are permitted only
  // through the trusted one-shot submit event below. This turns "never retry"
  // into an enforced browser invariant instead of prompt advice.
  const installPaymentFence = () => browser.run(`
    window.__haPaymentSubmitAllowed = false;
    window.__haPaymentSubmitted = false;
    if (!window.__haPaymentFenceInstalled) {
      window.__haPaymentFenceInstalled = true;
      const purchase = (el) => /place order|pay now|complete purchase|confirm purchase|submit order|buy now/i.test(
        String(el?.innerText || el?.value || el?.getAttribute?.('aria-label') || '')
      );
      document.addEventListener('click', (event) => {
        const el = event.target?.closest?.('button,input[type="submit"],[role="button"]');
        if (!purchase(el)) return;
        if (!window.__haPaymentSubmitAllowed || window.__haPaymentSubmitted) {
          event.preventDefault(); event.stopImmediatePropagation();
        }
      }, true);
      document.addEventListener('submit', (event) => {
        const form = event.target;
        const isCheckout = form?.querySelector?.('input[autocomplete="cc-number"],input[name*="card" i]') || purchase(form?.querySelector?.('button[type="submit"],input[type="submit"]'));
        if (!isCheckout) return;
        if (!window.__haPaymentSubmitAllowed || window.__haPaymentSubmitted) {
          event.preventDefault(); event.stopImmediatePropagation(); return;
        }
        window.__haPaymentSubmitted = true;
        window.__haPaymentSubmitAllowed = false;
      }, true);
    }
    return true;
  `, 20_000).catch(() => undefined)
  await installPaymentFence()

  let result: Extract<BridgeEvent, { type: 'result' }> | undefined
  const stderrChunks: string[] = []
  const drainStderr = (async () => {
    for await (const line of lines(proc.stderr)) {
      if (process.env.BROWSER_AGENT_TRACE === '1') console.error(`[browser-use] ${line}`)
      if (stderrChunks.join('\n').length < 2_000) stderrChunks.push(line)
    }
  })()

  for await (const line of lines(proc.stdout)) {
    if (!line.startsWith(EVENT_PREFIX)) {
      if (process.env.BROWSER_AGENT_TRACE === '1') console.log(`[browser-use] ${line}`)
      continue
    }
    let event: BridgeEvent
    try { event = JSON.parse(line.slice(EVENT_PREFIX.length)) as BridgeEvent }
    catch { continue }

    if (event.type === 'progress') {
      const url = event.url || await browser.run<string>('return page.url();', 10_000).catch(() => '') || task.url
      await task.onProgress?.({ action: describeActions(event.actions), url })
      const shot = await browser.screenshot(55).catch(() => '')
      if (shot) await task.onScreenshot?.({ dataUrl: `data:image/jpeg;base64,${shot}`, caption: `Browser Use step ${event.step}` })
      continue
    }
    if (event.type === 'submit_payment') {
      if (!Number.isInteger(task.paymentAmountCents) || task.paymentAmountCents !== event.amount_cents) {
        send({ request_id: event.request_id, status: 'blocked', error: 'Approved total did not match the submit request.' })
        continue
      }
      const verified = await readVerifiedKernelPurchase(browser)
      if (!verified || verified.amountCents !== task.paymentAmountCents) {
        send({ request_id: event.request_id, status: 'blocked', error: 'Checkout total changed before submission.' })
        continue
      }
      const submitted = await browser.run<{ ok: boolean; error?: string }>(`
        if (window.__haPaymentSubmitted) return { ok: false, error: 'checkout was already submitted' };
        const nodes = [...document.querySelectorAll('button,input[type="submit"],[role="button"]')];
        const visible = nodes.filter((el) => {
          const r = el.getBoundingClientRect();
          const label = String(el.innerText || el.value || el.getAttribute('aria-label') || '');
          return r.width > 1 && r.height > 1 && /place order|pay now|complete purchase|confirm purchase|submit order|buy now/i.test(label);
        });
        if (visible.length !== 1) return { ok: false, error: 'could not identify exactly one visible purchase control' };
        window.__haPaymentSubmitAllowed = true;
        visible[0].click();
        return { ok: true };
      `, 30_000).catch((error) => ({ ok: false, error: error instanceof Error ? error.message : String(error) }))
      send({ request_id: event.request_id, status: submitted.ok ? 'submitted' : 'blocked', error: submitted.error })
      continue
    }
    if (event.type === 'handoff') {
      if (!task.onHandoff) {
        send({ request_id: event.request_id, status: 'cancelled' })
        continue
      }
      const liveUrl = await browser.run<string>('return page.url();', 10_000).catch(() => '') || task.url
      let verifiedPayment: Awaited<ReturnType<typeof readVerifiedKernelPurchase>> = null
      if (event.kind === 'payment') {
        verifiedPayment = await readVerifiedKernelPurchase(browser)
        const normalize = (value: string) => value.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
        const proposedItem = normalize(event.item || '')
        const verifiedItem = normalize(verifiedPayment?.item || '')
        const proposedMerchant = normalize(event.merchant || '')
        const itemMatches = Boolean(proposedItem && verifiedItem && (proposedItem.includes(verifiedItem) || verifiedItem.includes(proposedItem)))
        const merchantMatches = Boolean(verifiedPayment && (!proposedMerchant || normalize(verifiedPayment.merchant).includes(proposedMerchant)))
        if (!verifiedPayment || verifiedPayment.amountCents !== event.amount_cents || !itemMatches || !merchantMatches) {
          send({ request_id: event.request_id, status: 'cancelled', error: 'Checkout values could not be independently verified.' })
          continue
        }
      }
      const handoff = await task.onHandoff({
        kind: event.kind,
        message: event.message,
        url: liveUrl,
        amountCents: verifiedPayment?.amountCents ?? event.amount_cents,
        currency: verifiedPayment?.currency,
        merchant: verifiedPayment?.merchant ?? event.merchant,
        item: verifiedPayment?.item ?? event.item,
      })
      const status = typeof handoff === 'string' ? handoff : handoff.status
      if (event.kind === 'payment' && typeof handoff === 'object' && 'paymentCard' in handoff) {
        task.paymentCard = handoff.paymentCard
        task.paymentAmountCents = event.amount_cents
        const fill = await executeKernelAction(browser, { type: 'fill_payment' } as AgentAction, task)
        task.paymentCard = undefined
        if (fill.ok) await installPaymentFence()
        send({ request_id: event.request_id, status: fill.ok ? 'resumed' : 'cancelled', payment_filled: fill.ok, error: fill.error })
      } else {
        send({ request_id: event.request_id, status, answer: typeof handoff === 'object' && 'answer' in handoff ? handoff.answer : undefined })
      }
      continue
    }
    result = event
  }

  const exitCode = await proc.exited
  writer.end()
  await drainStderr
  if (!result?.ok || !result.content?.trim()) {
    const detail = result?.error || result?.errors?.filter(Boolean).join('; ') || stderrChunks.slice(-3).join(' ').slice(0, 500)
    return { ok: false, error: detail || `Browser Use exited with code ${exitCode}.` }
  }

  const pageText = await browser.text('body', 8_000).catch(() => '')
  const screenshot = await browser.screenshot(60).catch(() => '')
  const audit = agentEnvCaller('audit') || agentEnvCaller()
  if (!audit) return { ok: false, error: 'No model is configured to verify the Browser Use result.' }
  const raw = await audit(buildVerificationParts({ goal: task.goal, answer: result.content, pageText, screenshotBase64: screenshot })).catch(() => '')
  const verdict = parseVerification(raw, result.content)
  if (!verdict.supported) return { ok: false, error: `Browser Use result was not supported by the live page: ${verdict.unsupported.join('; ')}` }
  if (screenshot) await task.onScreenshot?.({ dataUrl: `data:image/jpeg;base64,${screenshot}`, caption: 'Final Browser Use result' })
  return { ok: true, content: result.content }
}
