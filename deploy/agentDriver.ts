/**
 * Agent-driven browsing — the Stage 2 vision loop.
 *
 * The browser runner executes a deterministic script; this driver lets the
 * model SEE the page and decide the next action until the goal is met. The
 * trust fence does not move: the driver only ever acts inside the session
 * the approval opened, on the origin it was scoped to, with the same hard
 * caps (max steps, wall clock). A malformed model answer is skipped, not
 * obeyed — the parser is the only path from JSON to the browser.
 *
 * Model: the vision flash model already used for nutrition photos
 * (NUTRITION_VISION_MODEL / deepseek-v4-flash-exp). Pennies per task.
 */

export type AgentAction =
  | { type: 'click'; selector: string }
  | { type: 'click_at'; x: number; y: number }
  | { type: 'fill'; selector: string; value: string }
  | { type: 'type_text'; value: string }
  | { type: 'press'; key: string }
  | { type: 'navigate'; url: string }
  | { type: 'scroll'; direction: 'down' | 'up' }
  | { type: 'wait'; ms: number }
  | { type: 'fill_payment' }
  | {
      type: 'handoff'
      kind: 'password' | 'verification' | 'payment' | 'captcha' | 'confirmation'
      message: string
      amountCents?: number
      merchant?: string
      item?: string
    }
  | { type: 'done'; answer: string }
  | { type: 'giveup'; reason: string }

export type AgentLimits = { maxSteps: number; wallMs: number }

export const DEFAULT_AGENT_LIMITS: AgentLimits = { maxSteps: 25, wallMs: 90_000 }

/** Payment consent is accepted only when the same exact amount appears next
 * to a total label in the live page text—not merely in the model response. */
export function pageShowsExactTotal(pageText: string, amountCents: number): boolean {
  if (!Number.isInteger(amountCents) || amountCents < 0) return false
  const amount = (amountCents / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
    .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const money = `(?:US\\$|USD\\s*)?\\$?\\s*${amount}`
  const total = '(?:order\\s+total|grand\\s+total|total\\s+due|amount\\s+due|\\btotal\\b)'
  const text = pageText.replace(/\s+/g, ' ')
  return new RegExp(`${total}.{0,100}${money}`, 'i').test(text)
}

const AGENT_SYSTEM =
  'You are the action module of a web-browsing agent. You see a screenshot of a web page ' +
  'plus the user goal. Decide the single next action. Reply with ONLY a JSON object, no markdown fence:\n' +
  '{"action":"click","selector":"<css selector>"}\n' +
  '{"action":"click_at","x":640,"y":400}\n' +
  '{"action":"fill","selector":"<css selector>","value":"<text to type>"}\n' +
  '{"action":"type_text","value":"<text to type into the focused control>"}\n' +
  '{"action":"press","key":"Enter"}\n' +
  '{"action":"navigate","url":"<absolute https url>"}\n' +
  '{"action":"scroll","direction":"down"}\n' +
  '{"action":"wait","ms":1500}\n' +
  '{"action":"fill_payment"}\n' +
  '{"action":"handoff","kind":"password|verification|captcha|confirmation","message":"<what the user must do>"}\n' +
  '{"action":"handoff","kind":"payment","message":"Approve the verified checkout total","amount_cents":18990,"merchant":"store.example","item":"exact item and quantity"}\n' +
  '{"action":"done","answer":"<the final answer to the goal, extracted from the page>"}\n' +
  '{"action":"giveup","reason":"<why the goal cannot be reached>"}\n' +
  'Rules: prefer stable selectors (id, name, aria-label, role). When a numbered target has no stable selector, use click_at with the center of its box, then type_text. ' +
  'Coordinates are CSS pixels in the 1280x800 screenshot. Never invent URLs outside the current site. ' +
  'Use handoff whenever the site needs a password that was not already filled, a one-time code, CAPTCHA, identity check, or human confirmation. ' +
  'When PAYMENT STATUS says an approved Link credential is available, use fill_payment when the card form is visible; never request, infer, or type card values. ' +
  'Use payment handoff BEFORE clicking any final button that places an order, starts a paid subscription, or creates a charge, unless PAYMENT STATUS explicitly says authorization is verified. ' +
  'A payment handoff must include the exact visible total in integer cents, the current merchant hostname, and the exact item/quantity. Never estimate tax, shipping, or total. ' +
  'When payment is verified, submit at most once and only when the displayed total exactly matches the goal. ' +
  'After a handoff appears in RECENT ACTIONS, assume the user completed it and inspect the new page before requesting another handoff. ' +
  'When the goal is answered by something on the page, use "done". If after several tries nothing progresses, "giveup".'

/** Parse one model reply. Unknown shapes are skipped by the caller — never executed. */
export function parseAgentAction(raw: string): AgentAction | null {
  const jsonText = raw.replace(/```(?:json)?/g, '').trim()
  const start = jsonText.indexOf('{')
  const end = jsonText.lastIndexOf('}')
  if (start === -1 || end <= start) return null
  let obj: Record<string, unknown>
  try {
    obj = JSON.parse(jsonText.slice(start, end + 1)) as Record<string, unknown>
  } catch {
    return null
  }
  const str = (v: unknown, max: number): string => (typeof v === 'string' ? v.slice(0, max) : '')
  switch (obj.action) {
    case 'click': {
      const selector = str(obj.selector, 300)
      return selector && obj.selector!.length <= 300 ? { type: 'click', selector } : null
    }
    case 'click_at': {
      const x = Math.round(Number(obj.x))
      const y = Math.round(Number(obj.y))
      if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || x > 1280 || y < 0 || y > 800) return null
      return { type: 'click_at', x, y }
    }
    case 'fill': {
      const selector = str(obj.selector, 300)
      const value = str(obj.value, 500)
      return selector && obj.selector!.length <= 300 ? { type: 'fill', selector, value } : null
    }
    case 'type_text': {
      const value = str(obj.value, 500)
      return value ? { type: 'type_text', value } : null
    }
    case 'press': {
      const key = str(obj.key, 20)
      return key ? { type: 'press', key } : null
    }
    case 'navigate': {
      const url = str(obj.url, 2000)
      try {
        const u = new URL(url)
        if (u.protocol !== 'https:') return null
        return { type: 'navigate', url: u.toString() }
      } catch {
        return null
      }
    }
    case 'scroll': {
      const dir = obj.direction === 'up' ? 'up' : 'down'
      return { type: 'scroll', direction: dir }
    }
    case 'wait': {
      const ms = Math.min(Math.max(Number(obj.ms) || 1000, 200), 10_000)
      return { type: 'wait', ms }
    }
    case 'fill_payment':
      return { type: 'fill_payment' }
    case 'handoff': {
      const kinds = new Set(['password', 'verification', 'payment', 'captcha', 'confirmation'])
      const kind = str(obj.kind, 20)
      const message = str(obj.message, 400)
      if (!kinds.has(kind) || !message) return null
      if (kind === 'payment') {
        const amountCents = Number(obj.amount_cents)
        const merchant = str(obj.merchant, 120).toLowerCase()
        const item = str(obj.item, 300)
        if (!Number.isInteger(amountCents) || amountCents < 50 || !merchant || !item) return null
        return { type: 'handoff', kind, message, amountCents, merchant, item }
      }
      return { type: 'handoff', kind: kind as 'password' | 'verification' | 'captcha' | 'confirmation', message }
    }
    case 'done': {
      const answer = str(obj.answer, 2000)
      return answer ? { type: 'done', answer } : null
    }
    case 'giveup': {
      const reason = str(obj.reason, 300)
      return { type: 'giveup', reason: reason || 'no reason given' }
    }
    default:
      return null
  }
}

type VisionCall = (parts: unknown[]) => Promise<string>

/** One vision call: screenshot + page text + goal → next action JSON. */
export function makeVisionCaller(cfg: { apiKey: string; baseUrl: string; model: string }): VisionCall {
  return async (parts: unknown[]) => {
    const res = await fetch(`${cfg.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${cfg.apiKey}`,
        'User-Agent': 'HireAlpha/0.1 (browser-agent)',
      },
      body: JSON.stringify({
        model: cfg.model,
        temperature: 0.1,
        max_tokens: 300,
        messages: [
          { role: 'system', content: AGENT_SYSTEM },
          { role: 'user', content: parts },
        ],
      }),
      signal: AbortSignal.timeout(30_000),
    })
    if (!res.ok) throw new Error(`vision model ${res.status}`)
    const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> }
    return data.choices?.[0]?.message?.content ?? ''
  }
}

export function agentEnvCaller(): VisionCall | null {
  const apiKey = process.env.GMI_API_KEY?.trim()
  if (!apiKey) return null
  const baseUrl = (process.env.GMI_BASE_URL || 'https://api.gmi-serving.com/v1').replace(/\/$/, '')
  const model = process.env.AGENT_VISION_MODEL || process.env.NUTRITION_VISION_MODEL || 'moonshotai/Kimi-K2.5'
  return makeVisionCaller({ apiKey, baseUrl, model })
}

export type AgentStepContext = {
  pageText: string
  url: string
  screenshotBase64: string
  goal: string
  stepNumber: number
  recentActions: string[]
  paymentAuthorized?: boolean
  paymentAmountCents?: number
}

export function buildVisionParts(ctx: AgentStepContext): unknown[] {
  return [
    {
      type: 'text',
      text:
        `GOAL: ${ctx.goal}\nURL: ${ctx.url}\nSTEP: ${ctx.stepNumber}\n` +
        `PAYMENT STATUS: ${ctx.paymentAuthorized ? `verified Link authorization for exactly $${((ctx.paymentAmountCents || 0) / 100).toFixed(2)} with an approved one-time credential; use fill_payment and submit only if the visible total is still exactly this amount` : 'not authorized; hand off before any charge or order submission'}\n` +
        (ctx.recentActions.length ? `RECENT ACTIONS (avoid repeating what did not work): ${ctx.recentActions.slice(-5).join(' | ')}\n` : '') +
        `PAGE TEXT (truncated):\n${ctx.pageText.slice(0, 3500)}`,
    },
    { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${ctx.screenshotBase64}` } },
  ]
}

/** Execute one parsed action on the page. Returns false when the action failed. */
export type PaymentCardSecrets = {
  number: string
  cvc: string
  expMonth: string
  expYear: string
  name?: string
  postalCode?: string
}

async function fillAcrossFrames(page: import('playwright').Page, selectors: string[], value: string): Promise<boolean> {
  for (const frame of page.frames()) {
    for (const selector of selectors) {
      const locator = frame.locator(selector).first()
      if (await locator.count().catch(() => 0)) {
        try { await locator.fill(value, { timeout: 2500 }); return true } catch {}
      }
    }
  }
  return false
}

async function fillApprovedPayment(page: import('playwright').Page, card: PaymentCardSecrets): Promise<boolean> {
  const number = await fillAcrossFrames(page, [
    'input[autocomplete="cc-number"]', 'input[name="cardnumber"]', 'input[name*="cardNumber" i]',
    'input[name*="card-number" i]', 'input[id*="cardNumber" i]', 'input[data-elements-stable-field-name="cardNumber"]',
    'input[aria-label*="card number" i]', 'input[placeholder*="card number" i]',
  ], card.number)
  let expiry = await fillAcrossFrames(page, [
    'input[autocomplete="cc-exp"]', 'input[name="exp-date"]', 'input[name*="expiry" i]',
    'input[name*="expiration" i]', 'input[data-elements-stable-field-name="cardExpiry"]',
    'input[aria-label*="expiration" i]', 'input[placeholder*="MM / YY" i]', 'input[placeholder*="MM/YY" i]',
  ], `${card.expMonth.padStart(2, '0')}/${card.expYear.slice(-2)}`)
  if (!expiry) {
    const month = await fillAcrossFrames(page, ['input[autocomplete="cc-exp-month"]', 'input[name*="expMonth" i]'], card.expMonth.padStart(2, '0'))
    const year = await fillAcrossFrames(page, ['input[autocomplete="cc-exp-year"]', 'input[name*="expYear" i]'], card.expYear)
    expiry = month && year
  }
  const cvc = await fillAcrossFrames(page, [
    'input[autocomplete="cc-csc"]', 'input[name="cvc"]', 'input[name*="securityCode" i]',
    'input[name*="cardCvc" i]', 'input[data-elements-stable-field-name="cardCvc"]',
    'input[aria-label*="security code" i]', 'input[aria-label*="CVC" i]', 'input[placeholder*="CVC" i]', 'input[placeholder*="CVV" i]',
  ], card.cvc)
  if (card.name) await fillAcrossFrames(page, ['input[autocomplete="cc-name"]', 'input[name*="cardholder" i]'], card.name)
  if (card.postalCode) await fillAcrossFrames(page, ['input[autocomplete="billing postal-code"]', 'input[name*="postal" i]', 'input[name*="zip" i]'], card.postalCode)
  return number && expiry && cvc
}

export async function executeAgentAction(page: import('playwright').Page, action: AgentAction, paymentCard?: PaymentCardSecrets): Promise<boolean> {
  try {
    switch (action.type) {
      case 'click':
        await page.locator(action.selector).first().click({ timeout: 6000 })
        return true
      case 'click_at':
        await page.mouse.click(action.x, action.y)
        return true
      case 'fill':
        await page.locator(action.selector).first().fill(action.value, { timeout: 6000 })
        return true
      case 'type_text':
        await page.keyboard.type(action.value, { delay: 18 })
        return true
      case 'press':
        await page.keyboard.press(action.key)
        return true
      case 'navigate':
        await page.goto(action.url, { waitUntil: 'domcontentloaded', timeout: 20_000 }).catch(() => undefined)
        return true
      case 'scroll':
        await page.mouse.wheel(0, action.direction === 'down' ? 900 : -900)
        return true
      case 'wait':
        await page.waitForTimeout(action.ms)
        return true
      case 'fill_payment':
        return paymentCard ? fillApprovedPayment(page, paymentCard) : false
      default:
        return true // done/giveup are terminal, handled by the loop
    }
  } catch {
    return false
  }
}

export function isTerminal(action: AgentAction): boolean {
  return action.type === 'done' || action.type === 'giveup'
}
