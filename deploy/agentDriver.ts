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
  | { type: 'fill'; selector: string; value: string }
  | { type: 'press'; key: string }
  | { type: 'navigate'; url: string }
  | { type: 'scroll'; direction: 'down' | 'up' }
  | { type: 'wait'; ms: number }
  | { type: 'done'; answer: string }
  | { type: 'giveup'; reason: string }

export type AgentLimits = { maxSteps: number; wallMs: number }

export const DEFAULT_AGENT_LIMITS: AgentLimits = { maxSteps: 25, wallMs: 90_000 }

const AGENT_SYSTEM =
  'You are the action module of a web-browsing agent. You see a screenshot of a web page ' +
  'plus the user goal. Decide the single next action. Reply with ONLY a JSON object, no markdown fence:\n' +
  '{"action":"click","selector":"<css selector>"}\n' +
  '{"action":"fill","selector":"<css selector>","value":"<text to type>"}\n' +
  '{"action":"press","key":"Enter"}\n' +
  '{"action":"navigate","url":"<absolute https url>"}\n' +
  '{"action":"scroll","direction":"down"}\n' +
  '{"action":"wait","ms":1500}\n' +
  '{"action":"done","answer":"<the final answer to the goal, extracted from the page>"}\n' +
  '{"action":"giveup","reason":"<why the goal cannot be reached>"}\n' +
  'Rules: prefer stable selectors (id, name, aria-label, role). Never invent URLs outside the current site. ' +
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
    case 'fill': {
      const selector = str(obj.selector, 300)
      const value = str(obj.value, 500)
      return selector && obj.selector!.length <= 300 ? { type: 'fill', selector, value } : null
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
  const model = process.env.AGENT_VISION_MODEL || process.env.NUTRITION_VISION_MODEL || 'deepseek-v4-flash-exp'
  return makeVisionCaller({ apiKey, baseUrl, model })
}

export type AgentStepContext = {
  pageText: string
  url: string
  screenshotBase64: string
  goal: string
  stepNumber: number
  recentActions: string[]
}

export function buildVisionParts(ctx: AgentStepContext): unknown[] {
  return [
    {
      type: 'text',
      text:
        `GOAL: ${ctx.goal}\nURL: ${ctx.url}\nSTEP: ${ctx.stepNumber}\n` +
        (ctx.recentActions.length ? `RECENT ACTIONS (avoid repeating what did not work): ${ctx.recentActions.slice(-5).join(' | ')}\n` : '') +
        `PAGE TEXT (truncated):\n${ctx.pageText.slice(0, 3500)}`,
    },
    { type: 'image_url', image_url: { url: `data:image/png;base64,${ctx.screenshotBase64}` } },
  ]
}

/** Execute one parsed action on the page. Returns false when the action failed. */
export async function executeAgentAction(page: import('playwright').Page, action: AgentAction): Promise<boolean> {
  try {
    switch (action.type) {
      case 'click':
        await page.locator(action.selector).first().click({ timeout: 6000 })
        return true
      case 'fill':
        await page.locator(action.selector).first().fill(action.value, { timeout: 6000 })
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
