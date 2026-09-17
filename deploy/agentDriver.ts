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
 * Model: zai-org/GLM-5.3-Flash on GMI (AGENT_VISION_MODEL to override).
 * Pennies per task.
 */

export type AgentMeta = {
  observe?: 'screenshot' | 'dom'
  plan?: string[]
  current_subgoal?: string
}

export type AgentActionBase =
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
      kind: 'password' | 'verification' | 'payment' | 'captcha' | 'confirmation' | 'question'
      message: string
      amountCents?: number
      merchant?: string
      item?: string
    }
  | { type: 'done'; answer: string }
  | { type: 'giveup'; reason: string }

export type AgentAction = AgentActionBase & AgentMeta

export type AgentPlan = {
  subgoals: string[]
  currentSubgoal: string
  completedSubgoals: string[]
}

export function updateAgentPlan(
  existingPlan: AgentPlan | null,
  actionPlan?: string[],
  actionCurrentSubgoal?: string,
): AgentPlan | null {
  if (!existingPlan && (!actionPlan || !actionPlan.length)) return null

  let subgoals = existingPlan?.subgoals ? [...existingPlan.subgoals] : []
  const completed = existingPlan?.completedSubgoals ? [...existingPlan.completedSubgoals] : []
  let current = existingPlan?.currentSubgoal || ''

  if (actionPlan && actionPlan.length > 0) {
    subgoals = actionPlan.map((s) => String(s).trim()).filter(Boolean)
  }

  if (actionCurrentSubgoal) {
    const newSubgoal = actionCurrentSubgoal.trim()
    if (newSubgoal && newSubgoal !== current && current && !completed.includes(current)) {
      completed.push(current)
    }
    if (newSubgoal) {
      current = newSubgoal
    }
  } else if (!current && subgoals.length > 0) {
    current = subgoals[0]
  }

  return {
    subgoals,
    currentSubgoal: current,
    completedSubgoals: completed,
  }
}

export function formatPlanForPrompt(plan: AgentPlan | null): string {
  if (!plan || !plan.subgoals.length) return ''
  const remaining = plan.subgoals.filter(
    (s) => s !== plan.currentSubgoal && !plan.completedSubgoals.includes(s),
  )
  const lines: string[] = ['CURRENT PLAN & SUBGOALS:']
  if (plan.completedSubgoals.length) {
    lines.push(`  Completed: ${plan.completedSubgoals.join(' -> ')}`)
  }
  lines.push(`  ACTIVE SUBGOAL: ${plan.currentSubgoal || plan.subgoals[0]}`)
  if (remaining.length) {
    lines.push(`  Remaining: ${remaining.join(' -> ')}`)
  }
  return lines.join('\n')
}

export type AgentLimits = { maxSteps: number; wallMs: number }

/** Real booking sites: one vision step costs ~8-20s (capture + model), a
 * search-to-results-to-extract flow needs 10-25 steps, and slow commerce pages
 * routinely take 20-30s to settle (measured live runs: 76-293s just for the
 * happy path, before retries). 90s/25 cut runs off mid-flow; 360s/30 still
 * left almost no headroom over a 293s measured run, so the wall is 8 minutes
 * with 36 steps. The worker heartbeats the claim every minute and the sandbox
 * is provisioned to outlive wall + handoff (see browserWorker's
 * TASK_SANDBOX_TIMEOUT_MS). Per-step time is bounded independently: captures
 * are raced against deadlines and a vision call cannot exceed
 * VISION_CALL_BUDGET_MS, so one slow page or model retry never eats the run. */
export const DEFAULT_AGENT_LIMITS: AgentLimits = { maxSteps: 36, wallMs: 480_000 }

/** Wall for a single agent step's model interaction (all rounds, all models).
 * Without this a hot model tier x backoff rounds could burn 6 minutes of an
 * 8-minute run on one step. */
export const VISION_CALL_BUDGET_MS = 50_000

/** Per HTTP attempt inside a vision call. */
export const VISION_ATTEMPT_TIMEOUT_MS = 20_000

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
  'You are the autonomous planning and action engine of a web-browsing agent. ' +
  'You receive structured page context (URL, active plan, visible text, and numbered interactive targets) ' +
  'and optionally a screenshot. Decide the single next action towards the user goal.\n\n' +
  'HIERARCHICAL PLANNING (MANDATORY):\n' +
  '- On STEP 1: You MUST include "plan": ["subgoal 1", "subgoal 2", ...] (2-5 sequential subgoals) and "current_subgoal": "subgoal 1" in your JSON.\n' +
  '- On subsequent steps: Track your progress. When a subgoal is reached, advance "current_subgoal".\n' +
  '- DRIFT DETECTION: If you notice you are off-track (e.g. searching for hotels but landed on restaurant results or promo banners), revise your "plan" and "current_subgoal" immediately to recover.\n\n' +
  'OBSERVATION:\n' +
  '- Observation is DOM/AX-tree-first to maximize speed and minimize token cost. You see exact visible text and numbered targets with CSS selectors.\n' +
  '- If you need visual inspection for non-DOM elements (interactive map, canvas chart, visual captcha, or verifying complex visual layout), include "observe": "screenshot" in your JSON to receive an image on the next step.\n\n' +
  'RESPONSE FORMAT: Reply with ONLY a single valid JSON object, no markdown fence:\n' +
  '{"plan":["search hotel","filter free cancellation","extract top 3"],"current_subgoal":"search hotel","action":"click","selector":"<css selector>"}\n' +
  '{"current_subgoal":"<active subgoal>","action":"click_at","x":640,"y":400}\n' +
  '{"current_subgoal":"<active subgoal>","action":"fill","selector":"<css selector>","value":"<text to type>"}\n' +
  '{"current_subgoal":"<active subgoal>","action":"type_text","value":"<text to type into focused control>"}\n' +
  '{"current_subgoal":"<active subgoal>","action":"press","key":"Enter"}\n' +
  '{"current_subgoal":"<active subgoal>","action":"navigate","url":"<absolute https url>"}\n' +
  '{"current_subgoal":"<active subgoal>","action":"scroll","direction":"down"}\n' +
  '{"current_subgoal":"<active subgoal>","action":"wait","ms":1500}\n' +
  '{"current_subgoal":"<active subgoal>","action":"fill_payment"}\n' +
  '{"current_subgoal":"<active subgoal>","action":"handoff","kind":"password|verification|captcha|confirmation","message":"<what the user must do>"}\n' +
  '{"current_subgoal":"<active subgoal>","action":"handoff","kind":"question","message":"<one short question the user can answer in a text message>"}\n' +
  '{"current_subgoal":"<active subgoal>","action":"handoff","kind":"payment","message":"Approve the verified checkout total","amount_cents":18990,"merchant":"store.example","item":"exact item and quantity"}\n' +
  '{"current_subgoal":"<active subgoal>","action":"done","answer":"<the final answer to the goal, extracted from the page>"}\n' +
  '{"action":"giveup","reason":"<why the goal cannot be reached>"}\n\n' +
  'RULES:\n' +
  '1. Selectors: Prefer stable selectors (id, name, aria-label, role); when a target lists selector=, use that exact selector.\n' +
  '2. Typing: To enter text into a field, click or fill it first. Clicking does not type text; send type_text on the next step.\n' +
  '3. Repeated actions: Never repeat an action that just failed or click the exact same coordinates twice in a row. If page did not change, scroll, wait, or use a different selector.\n' +
  '4. Page settling: Real pages can take 10-20 seconds to settle. Use wait (up to 10000ms) or scroll; do not hammer disabled buttons.\n' +
  '5. Walls & CAPTCHAs: CAPTCHA, "verify you are human", or sign-in wall is NEVER done. Use handoff (captcha/verification/password).\n' +
  '6. Coordinates: In 1280x800 space. Never invent URLs outside the current site.\n' +
  '7. Vault credentials: When VAULT STATUS says credentials saved, never use password handoff; login is automated.\n' +
  '8. Missing information: If the page needs user info (name, email, phone, address, zip, dates, party size), use the USER PROFILE values first; if the profile does not cover the field, handoff kind="question" and ask. NEVER invent a value and never use a placeholder ("John Smith", "test@example.com") — the person expects their real details or a question.\n' +
  '8b. Identity precedence: USER PROFILE is who the user is; SITE MEMORY is only how a site works. A name/email/address appearing in SITE MEMORY belongs to a PAST session and must never be typed as the user\'s own — when the two disagree, the profile wins, and anything the profile lacks gets asked.\n' +
  '9. Payment: Hand off before placing order unless verified.\n' +
  '10. Accurate extraction: In "done", report only verified values seen on the page. Never hallucinate or copy prices between items.'

/** Parse one model reply. Unknown shapes are skipped by the caller — never executed. */
export function parseAgentAction(raw: string): AgentAction | null {
  if (!raw) return null
  const jsonText = raw.replace(/```(?:json)?/g, '').trim()
  let obj: Record<string, unknown> | null = null

  // 1. Try parsing full or sliced string first
  const start = jsonText.indexOf('{')
  const end = jsonText.lastIndexOf('}')
  if (start !== -1 && end > start) {
    try {
      obj = JSON.parse(jsonText.slice(start, end + 1)) as Record<string, unknown>
    } catch {}
  }

  // 2. If full slice failed (e.g. reasoning had curly braces), look for isolated action JSON object
  if (!obj || typeof obj !== 'object' || !obj.action) {
    const matches = jsonText.match(/\{[^{}]*?"action"\s*:\s*[^{}]*?\}/g)
      || jsonText.match(/\{[\s\S]*?"action"\s*:\s*[\s\S]*?\}/g)
    if (matches) {
      for (let i = matches.length - 1; i >= 0; i--) {
        try {
          const cand = JSON.parse(matches[i])
          if (cand && typeof cand === 'object' && 'action' in cand) {
            obj = cand as Record<string, unknown>
            break
          }
        } catch {}
      }
    }
  }

  if (!obj || typeof obj !== 'object') return null
  const str = (v: unknown, max: number): string => (typeof v === 'string' ? v.slice(0, max) : '')

  const observe = (obj.observe === 'screenshot' || obj.observe === 'dom') ? (obj.observe as 'screenshot' | 'dom') : undefined
  const plan = Array.isArray(obj.plan)
    ? obj.plan.map((s) => str(s, 200)).filter(Boolean)
    : undefined
  const current_subgoal = typeof obj.current_subgoal === 'string'
    ? str(obj.current_subgoal, 200)
    : (typeof (obj as Record<string, unknown>).subgoal === 'string' ? str((obj as Record<string, unknown>).subgoal, 200) : undefined)

  const meta: AgentMeta = {
    ...(observe ? { observe } : {}),
    ...(plan && plan.length ? { plan } : {}),
    ...(current_subgoal ? { current_subgoal } : {}),
  }

  const withMeta = (base: AgentActionBase): AgentAction => ({ ...base, ...meta })

  switch (obj.action) {
    case 'click': {
      const selector = str(obj.selector, 300)
      // Reject an over-long selector rather than acting on a truncated one:
      // the slice in str() would otherwise click a different (or invalid) node.
      return selector && typeof obj.selector === 'string' && obj.selector.length <= 300 ? withMeta({ type: 'click', selector }) : null
    }
    case 'click_at': {
      const x = Math.round(Number(obj.x))
      const y = Math.round(Number(obj.y))
      if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || x > 1280 || y < 0 || y > 800) return null
      return withMeta({ type: 'click_at', x, y })
    }
    case 'fill': {
      const selector = str(obj.selector, 300)
      const value = str(obj.value, 500)
      return selector && typeof obj.selector === 'string' && obj.selector.length <= 300 ? withMeta({ type: 'fill', selector, value }) : null
    }
    case 'type_text': {
      const value = str(obj.value, 500)
      return value ? withMeta({ type: 'type_text', value }) : null
    }
    case 'press': {
      const key = str(obj.key, 20)
      return key ? withMeta({ type: 'press', key }) : null
    }
    case 'navigate': {
      const url = str(obj.url, 2000)
      try {
        const u = new URL(url)
        if (u.protocol !== 'https:') return null
        return withMeta({ type: 'navigate', url: u.toString() })
      } catch {
        return null
      }
    }
    case 'scroll': {
      const dir = obj.direction === 'up' ? 'up' : 'down'
      return withMeta({ type: 'scroll', direction: dir })
    }
    case 'wait': {
      const ms = Math.min(Math.max(Number(obj.ms) || 1000, 200), 10_000)
      return withMeta({ type: 'wait', ms })
    }
    case 'fill_payment':
      return withMeta({ type: 'fill_payment' })
    case 'handoff': {
      const kinds = new Set(['password', 'verification', 'payment', 'captcha', 'confirmation', 'question'])
      const kind = str(obj.kind, 20)
      const message = str(obj.message, 400)
      if (!kinds.has(kind) || !message) return null
      if (kind === 'payment') {
        const amountCents = Number(obj.amount_cents)
        const merchant = str(obj.merchant, 120).toLowerCase()
        const item = str(obj.item, 300)
        if (!Number.isInteger(amountCents) || amountCents < 50 || !merchant || !item) return null
        return withMeta({ type: 'handoff', kind, message, amountCents, merchant, item })
      }
      return withMeta({ type: 'handoff', kind: kind as 'password' | 'verification' | 'captcha' | 'confirmation' | 'question', message })
    }
    case 'done': {
      const answer = str(obj.answer, 2000)
      return answer ? withMeta({ type: 'done', answer }) : null
    }
    case 'giveup': {
      const reason = str(obj.reason, 300)
      return withMeta({ type: 'giveup', reason: reason || 'no reason given' })
    }
    default:
      return null
  }
}

type VisionCall = (parts: unknown[]) => Promise<string>

/** One vision call: screenshot + page text + goal → next action JSON.
 *
 * 429s are part of normal operation on the shared flash tier (measured: 2 of
 * every 3 requests can be throttled in a burst, while an 8s-spaced stream
 * passes 6/6). A mid-run rate limit must not kill the whole session, so retry
 * with backoff AND rotate to a fallback model when the primary stays hot —
 * the call shape is identical across models. Non-429 4xx/5xx are payload or
 * provider errors and are surfaced immediately. */
export function makeVisionCaller(cfg: {
  apiKey: string
  baseUrl: string
  model: string
  fallbackModels?: string[]
  systemPrompt?: string
  maxTokens?: number
  /** Per HTTP attempt; defaults to VISION_ATTEMPT_TIMEOUT_MS. */
  timeoutMs?: number
  /** Whole call, including backoff sleeps and model rotation; defaults to VISION_CALL_BUDGET_MS. */
  totalBudgetMs?: number
}): VisionCall {
  const systemPrompt = cfg.systemPrompt || AGENT_SYSTEM
  // The action reply is tiny; an audit transcription of several items is not.
  // Reasoning models (e.g. DeepSeek) emit reasoning tokens first, so provide enough headroom.
  const maxTokens = cfg.maxTokens ?? 1200
  const attemptTimeoutMs = cfg.timeoutMs ?? VISION_ATTEMPT_TIMEOUT_MS
  const budgetMs = cfg.totalBudgetMs ?? VISION_CALL_BUDGET_MS
  const BACKOFF_MS = [3_000, 8_000, 20_000]
  // Measured on this gateway: the same model throttles after ~2 rapid calls,
  // but alternating models passes 12/12 at 2s spacing. So rotate on every
  // call (a model sees a call roughly every N steps) and skip straight to the
  // next model on a 429 instead of sleeping through the hot window.
  const models = [...new Set([cfg.model, ...(cfg.fallbackModels ?? [])])]
  let cursor = 0
  return async (parts: unknown[]) => {
    const started = Date.now()
    const remaining = () => budgetMs - (Date.now() - started)
    let lastError = 'unknown error'
    let budgetExhausted = false
    for (let round = 0; round <= BACKOFF_MS.length; round++) {
      if (round > 0) {
        const left = remaining()
        if (left <= 0) { budgetExhausted = true; break }
        // Never sleep past the step budget: a backoff that outlives the wall
        // would kill the run without ever reporting why.
        await new Promise((resolve) => setTimeout(resolve, Math.min(BACKOFF_MS[round - 1]!, left)))
      }
      for (let i = 0; i < models.length; i++) {
        const left = remaining()
        if (left <= 250) { budgetExhausted = true; break }
        const model = models[(cursor + i) % models.length]
        const payload = JSON.stringify({
          model,
          temperature: 0.1,
          max_tokens: maxTokens,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: parts },
          ],
        })
        let res: Response
        try {
          res = await fetch(`${cfg.baseUrl}/chat/completions`, {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              authorization: `Bearer ${cfg.apiKey}`,
              'User-Agent': 'HireAlpha/0.1 (browser-agent)',
            },
            body: payload,
            signal: AbortSignal.timeout(Math.max(250, Math.min(attemptTimeoutMs, left))),
          })
        } catch (err) {
          lastError = err instanceof Error ? err.message : String(err)
          continue
        }
        if (res.ok) {
          cursor = (cursor + i + 1) % models.length
          const data = (await res.json()) as { choices?: Array<{ message?: { content?: string; reasoning_content?: string } }> }
          const msg = data.choices?.[0]?.message
          return msg?.content?.trim() || msg?.reasoning_content?.trim() || ''
        }
        // The provider's error body names the offending field; without it a
        // misconfigured model or oversized image is an opaque "vision model 400".
        const detail = await res.text().catch(() => '')
        // If the vision endpoint rejects an image payload (e.g. 400 Failed to decode image data),
        // gracefully fall back to text-only with the DOM targets rather than crashing the browser run!
        if (res.status === 400 && Array.isArray(parts) && parts.some((p: any) => p && typeof p === 'object' && p.type === 'image_url')) {
          const textOnlyParts = parts.filter((p: any) => p?.type !== 'image_url')
          try {
            const fallbackRes = await fetch(`${cfg.baseUrl}/chat/completions`, {
              method: 'POST',
              headers: {
                'content-type': 'application/json',
                authorization: `Bearer ${cfg.apiKey}`,
                'User-Agent': 'HireAlpha/0.1 (browser-agent)',
              },
              body: JSON.stringify({
                model,
                temperature: 0.1,
                max_tokens: maxTokens,
                messages: [
                  { role: 'system', content: systemPrompt },
                  { role: 'user', content: textOnlyParts },
                ],
              }),
              signal: AbortSignal.timeout(Math.max(250, Math.min(attemptTimeoutMs, remaining()))),
            })
            if (fallbackRes.ok) {
              cursor = (cursor + i + 1) % models.length
              const data = (await fallbackRes.json()) as { choices?: Array<{ message?: { content?: string; reasoning_content?: string } }> }
              const msg = data.choices?.[0]?.message
              return msg?.content?.trim() || msg?.reasoning_content?.trim() || ''
            }
          } catch {}
        }
        lastError = `${res.status}${detail ? `: ${detail.slice(0, 300)}` : ''}`
        if (res.status !== 429) throw new Error(`vision model ${lastError}`)
      }
      if (budgetExhausted) break
      cursor = (cursor + 1) % models.length
    }
    throw new Error(`vision model ${lastError}${budgetExhausted ? ` (step budget ${Math.round(budgetMs / 1000)}s exhausted)` : ''}`)
  }
}

/** The audit caller must NOT inherit the action system prompt: under it the
 * model answers with an `{"action":...}` object and the audit JSON never
 * appears, which silently passed every verification. */
const AUDIT_SYSTEM =
  'You are a meticulous page auditor. Follow the user\'s requested JSON schema exactly. ' +
  'Quote text exactly as it appears; never fill in a value you cannot see — use null instead.'

export function agentEnvCaller(kind: 'action' | 'audit' = 'action'): VisionCall | null {
  const apiKey = process.env.GMI_API_KEY?.trim() || process.env.OPENAI_API_KEY?.trim()
  if (!apiKey) return null
  const baseUrl = (process.env.GMI_BASE_URL || 'https://api.gmi-serving.com/v1').replace(/\/$/, '')
  const model = process.env.AGENT_VISION_MODEL || process.env.NUTRITION_VISION_MODEL || 'zai-org/GLM-5.3-Flash'
  const fallbackModels = (process.env.AGENT_FALLBACK_VISION_MODEL || 'zai-org/GLM-5.3-Flash')
    .split(',').map((m) => m.trim()).filter(Boolean)
  return makeVisionCaller({
    apiKey, baseUrl, model, fallbackModels,
    systemPrompt: kind === 'audit' ? AUDIT_SYSTEM : AGENT_SYSTEM,
    maxTokens: 1200,
  })
}

export type AgentStepContext = {
  pageText: string
  url: string
  screenshotBase64?: string
  goal: string
  stepNumber: number
  recentActions: string[]
  plan?: AgentPlan | null
  siteMemory?: string
  identityText?: string
  paymentAuthorized?: boolean
  paymentAmountCents?: number
}

export function buildVisionParts(ctx: AgentStepContext): unknown[] {
  const planSection = formatPlanForPrompt(ctx.plan || null)
  const parts: unknown[] = [
    {
      type: 'text',
      text: [
        `GOAL: ${ctx.goal}`,
        planSection,
        ctx.identityText || '',
        ctx.siteMemory || '',
        `URL: ${ctx.url}`,
        `STEP: ${ctx.stepNumber}`,
        `PAYMENT STATUS: ${ctx.paymentAuthorized ? `verified Link authorization for exactly $${((ctx.paymentAmountCents || 0) / 100).toFixed(2)} with an approved one-time credential; use fill_payment and submit only if the visible total is still exactly this amount` : 'not authorized; hand off before any charge or order submission'}`,
        ctx.recentActions.length ? `RECENT ACTIONS (avoid repeating what did not work): ${ctx.recentActions.slice(-5).join(' | ')}` : '',
        `PAGE TEXT (truncated):\n${ctx.pageText.slice(0, 3500)}`,
      ].filter(Boolean).join('\n\n'),
    },
  ]
  // A failed screenshot must not become an empty data: URL — providers reject
  // that with a 400 and the whole run dies. Text-only still lets the agent act.
  if (ctx.screenshotBase64) {
    parts.push({ type: 'image_url', image_url: { url: `data:image/jpeg;base64,${ctx.screenshotBase64}` } })
  }
  return parts
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

/** Why an action failed, never just "false": the loop feeds this back to the
 * model and the activity stream, and a run that dies reports it verbatim. */
export type ActionOutcome = { ok: boolean; error?: string }

export async function executeAgentAction(
  page: import('playwright').Page,
  action: AgentAction,
  paymentCard?: PaymentCardSecrets,
  paymentAmountCents?: number,
): Promise<ActionOutcome> {
  try {
    switch (action.type) {
      case 'click':
        await page.locator(action.selector).first().click({ timeout: 8000 })
        return { ok: true }
      case 'click_at':
        await page.mouse.click(action.x, action.y)
        return { ok: true }
      case 'fill':
        await page.locator(action.selector).first().fill(action.value, { timeout: 8000 })
        return { ok: true }
      case 'type_text':
        await page.keyboard.type(action.value, { delay: 18 })
        return { ok: true }
      case 'press':
        await page.keyboard.press(action.key)
        return { ok: true }
      case 'navigate':
        try {
          await page.goto(action.url, { waitUntil: 'domcontentloaded', timeout: 45_000 })
          return { ok: true }
        } catch (err) {
          return { ok: false, error: `navigation failed: ${err instanceof Error ? err.message : String(err)}` }
        }
      case 'scroll':
        await page.mouse.wheel(0, action.direction === 'down' ? 900 : -900)
        return { ok: true }
      case 'wait':
        await page.waitForTimeout(action.ms)
        return { ok: true }
      case 'fill_payment':
        if (!paymentCard) return { ok: false, error: 'no approved one-time payment credential is available' }
        // Consent is bound to the total the user approved. Read the live DOM
        // again immediately before exposing the one-time card to the checkout;
        // shipping, tax, quantity, or merchant state may have changed while the
        // approval handoff was open.
        if (!Number.isInteger(paymentAmountCents) || !pageShowsExactTotal(
          await page.evaluate(() => document.body?.innerText || '').catch(() => ''),
          paymentAmountCents || 0,
        )) {
          return { ok: false, error: 'the live checkout total no longer matches the approved amount' }
        }
        return (await fillApprovedPayment(page, paymentCard))
          ? { ok: true }
          : { ok: false, error: 'the card form fields were not found on the page' }
      default:
        return { ok: true } // done/giveup are terminal, handled by the loop
    }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

export function isTerminal(action: AgentAction): action is Extract<AgentAction, { type: 'done' | 'giveup' }> {
  return action.type === 'done' || action.type === 'giveup'
}

/** A "done" answer is checked once against the same page evidence the model
 * had (text + screenshot). Asking "is this answer supported?" lets a lenient
 * verifier approve a price copied from a neighbouring item, so the verifier
 * instead TRANSCRIBES name → visible price/status per item and the code
 * matches those transcriptions against the claimed values. A run that reports
 * a value it never saw is worse than one that says "not shown": unsupported
 * claims send the loop back to look again; a second identical failure is
 * accepted rather than losing the whole result to a finicky verifier. */
export function buildVerificationParts(
  ctx: { goal: string; answer: string; pageText?: string; screenshotBase64?: string },
  opts?: { strict?: boolean },
): unknown[] {
  const parts: unknown[] = [{
    type: 'text',
    text:
      `GOAL: ${ctx.goal}\nPROPOSED ANSWER (claims to audit):\n${ctx.answer}\n\n` +
      `PAGE TEXT (truncated):\n${(ctx.pageText || '').slice(0, 3500)}\n\n` +
      'For EACH item mentioned in the proposed answer, locate that same item on the page and copy the EXACT price text and cancellation/prepayment text shown for that item, exactly as printed. ' +
      'Use null for a field that is not visible for that item. Never carry a value over from a different item. ' +
      'Reply with ONLY JSON: {"items":[{"name":"<item name>","price_text":"<exact visible price text or null>","cancellation_text":"<exact visible cancellation text or null>"}]}' +
      // Second attempt after an unusable reply: models that preface JSON with
      // prose or a reasoning trace get one short, unambiguous instruction.
      (opts?.strict ? ' No prose, no explanation, no markdown fences — the JSON object only, starting with {"items".' : ''),
  }]
  if (ctx.screenshotBase64) {
    parts.push({ type: 'image_url', image_url: { url: `data:image/jpeg;base64,${ctx.screenshotBase64}` } })
  }
  return parts
}

type VerifiedItem = { name?: unknown; price_text?: unknown; cancellation_text?: unknown }

export type VerificationVerdict = {
  supported: boolean
  unsupported: string[]
  /** The auditor never produced usable JSON (provider refusal, truncation,
   * prose-only reply). Distinct from "the page contradicts the answer": an
   * unusable audit is a tooling gap, not evidence against the claim. */
  verifierUnavailable?: boolean
}

/** The claims this check can actually refute: a line naming an item with a
 * $amount, or a free-cancellation/prepayment claim. An answer with none of
 * those (a post, a form submit, a login) cannot be contradicted by the
 * auditor, so its JSON being unusable must not fail the run. */
export function hasCheckableClaims(answer: string): boolean {
  for (const rawLine of answer.split(/\n+/)) {
    const line = rawLine.trim()
    if (!line) continue
    const amounts = /\$\s?[\d,]+(?:\.\d{1,2})?/.test(line)
    const claimsCancellation = /free\s+cancellation|no\s+prepayment/i.test(line)
    if (!amounts && !claimsCancellation) continue
    const claimedName = line.replace(/^\s*(?:[-*•]|\d+[.)])\s*/, '').split(/[:\-–—]/)[0].trim()
    if (claimedName.length >= 3) return true
  }
  return false
}

/** Compare the claimed answer against the verifier's per-item transcription.
 * Only confidently mappable claims (a line with a name and a $amount, or a
 * free-cancellation claim) can fail the check; prose without amounts passes.
 * An unusable audit response passes a claim-free answer (nothing to refute)
 * and fails a claim-bearing one, flagged `verifierUnavailable` so the caller
 * reports "could not verify" instead of "the page refutes it". */
export function parseVerification(raw: string, answer: string): VerificationVerdict {
  const checkable = hasCheckableClaims(answer)
  const unusable = (reason: string): VerificationVerdict => checkable
    ? { supported: false, unsupported: [reason], verifierUnavailable: true }
    : { supported: true, unsupported: [], verifierUnavailable: true }
  const jsonText = raw.replace(/```(?:json)?/g, '').trim()
  const start = jsonText.indexOf('{')
  const end = jsonText.lastIndexOf('}')
  if (start === -1 || end <= start) {
    return unusable('the page auditor returned no usable JSON, so the claimed values could not be checked')
  }
  let items: VerifiedItem[]
  try {
    const obj = JSON.parse(jsonText.slice(start, end + 1)) as { items?: unknown }
    if (!Array.isArray(obj.items)) {
      return unusable('the page auditor returned no usable JSON, so the claimed values could not be checked')
    }
    items = obj.items as VerifiedItem[]
  } catch {
    return unusable('the page auditor returned no usable JSON, so the claimed values could not be checked')
  }
  const unsupported: string[] = []
  for (const rawLine of answer.split(/\n+/)) {
    const line = rawLine.trim()
    if (!line) continue
    const amounts = [...line.matchAll(/\$\s?([\d,]+(?:\.\d{1,2})?)/g)].map((match) => match[1].replace(/,/g, ''))
    const claimsCancellation = /free\s+cancellation|no\s+prepayment/i.test(line)
    if (!amounts.length && !claimsCancellation) continue
    const claimedName = line.replace(/^\s*(?:[-*•]|\d+[.)])\s*/, '').split(/[:\-–—]/)[0].trim().toLowerCase()
    if (claimedName.length < 3) continue
    const item = items.find((candidate) => {
      const name = typeof candidate.name === 'string' ? candidate.name.trim().toLowerCase() : ''
      return name.length >= 3 && (name.includes(claimedName) || claimedName.includes(name))
    })
    if (!item) {
      unsupported.push(`${line.slice(0, 90)} (no matching visible item)`)
      continue
    }
    const priceText = typeof item.price_text === 'string' ? item.price_text.replace(/,/g, '') : ''
    const cancellationText = typeof item.cancellation_text === 'string' ? item.cancellation_text.toLowerCase() : ''
    for (const amount of amounts) {
      if (!priceText || !priceText.includes(amount)) {
        unsupported.push(`${amount} claimed for "${String(item.name).slice(0, 60)}" but visible price is ${item.price_text ? `"${item.price_text}"` : 'not shown'}`)
        break
      }
    }
    if (claimsCancellation && !/free\s+cancellation|no\s+prepayment/.test(cancellationText)) {
      unsupported.push(`free cancellation claimed for "${String(item.name).slice(0, 60)}" but not visible for that item`)
    }
  }
  return { supported: unsupported.length === 0, unsupported: unsupported.slice(0, 5) }
}

/** Audit a "done" answer against the live page, with one stricter retry when
 * the auditor's reply arrives unusable (empty, prose-only, truncated). The
 * retry is cheap next to a run that reports success on nothing; the second
 * unusable reply stands as the verdict so the caller can say "could not
 * verify" rather than looping forever on a flapping provider. */
export async function verifyAnswerAgainstPage(
  call: (parts: unknown[]) => Promise<string>,
  ctx: { goal: string; answer: string; pageText?: string; screenshotBase64?: string },
): Promise<VerificationVerdict> {
  const first = await call(buildVerificationParts(ctx)).catch(() => '')
  let verdict = parseVerification(first, ctx.answer)
  if (verdict.verifierUnavailable) {
    const retry = await call(buildVerificationParts(ctx, { strict: true })).catch(() => '')
    verdict = parseVerification(retry, ctx.answer)
  }
  return verdict
}
