/* The step shape is duplicated here (not imported from the server route) so the
 * bot image never has to copy server code — the image-copy invariant test
 * enforces that boundary. */
export type PlanStep = { text: string; state: 'pending' | 'done' | 'failed' | 'blocked' }

/**
 * Client for durable plans. The turn reads the plan at start (rehydration),
 * injects its state into the prompt, and lets the `plan` capability update
 * step states as verified receipts land. Restart survival comes free: the row
 * is the record, the transcript is not consulted.
 */

export type Plan = {
  id: string
  goal: string
  status: string
  blocker: string | null
  nextAction: string | null
  steps: PlanStep[]
  operationIds: Record<string, string>
}

async function callPlans(phone: string, persona: string, method: 'GET' | 'POST' | 'PATCH', body?: Record<string, unknown>): Promise<Plan | null> {
  const { timedFetch, authHeaders, apiBase } = await import('./liveContext')
  const base = apiBase()
  if (!base) return null
  try {
    const res = await timedFetch(`${base}/api/internal/plans`, {
      method,
      headers: { ...(authHeaders() as Record<string, string>), 'content-type': 'application/json' },
      body: JSON.stringify({ phone, persona, ...(body || {}) }),
    }, 8000)
    const data = await res.json().catch(() => ({})) as { ok?: boolean; plan?: Plan | null }
    if (!res.ok || data.ok !== true) return null
    return data.plan ?? null
  } catch {
    return null
  }
}

export function fetchActivePlan(phone: string, persona: string): Promise<Plan | null> {
  return callPlans(phone, persona, 'GET')
}

export async function upsertPlan(phone: string, persona: string, goal: string, steps: PlanStep[], opts?: { nextAction?: string; operationIds?: Record<string, string> }): Promise<Plan | null> {
  return callPlans(phone, persona, 'POST', { goal, steps, nextAction: opts?.nextAction, operationIds: opts?.operationIds })
}

export async function patchPlan(phone: string, persona: string, planId: string, patch: Partial<Pick<Plan, 'steps' | 'blocker' | 'nextAction' | 'status' | 'operationIds'>>): Promise<Plan | null> {
  return callPlans(phone, persona, 'PATCH', { id: planId, ...patch })
}

/** Deterministic multi-step detection: a single message carrying three or more
 * imperative steps (comma/then/and-chained verbs) becomes a durable plan so
 * progress survives restarts. Deliberately conservative — one clear verb plus
 * two clauses is conversation, not a plan. */
export function detectMultiStepPlan(text: string): { goal: string; steps: PlanStep[] } | null {
  const t = text.trim()
  if (t.length < 40) return null
  const stepSplit = t
    .split(/\s*(?:,\s*|\s+then\s+|\s+and then\s+|\s+;\s*)/i)
    .map((part) => part.replace(/^(?:also\s+|and\s+|then\s+)/i, '').trim())
    .filter(Boolean)
  const imperative = /\b(?:find|book|invite|remind|draft|buy|schedule|set up|order|reserve|send|check|search|price out|compare)\b/i
  const steps = stepSplit.filter((part) => imperative.test(part) && part.length > 3).map((part) => ({ text: part, state: 'pending' as const }))
  if (steps.length < 3) return null
  return { goal: t, steps }
}

/** Prompt block: the plan's durable state, in the engine's words, not the
 * transcript's. */
export function planPromptBlock(plan: Plan | null): string | null {
  if (!plan || plan.status !== 'active' || !plan.steps.length) return null
  const lines = plan.steps.map((s, i) => `${i + 1}. [${s.state}] ${s.text}`)
  return [
    `## Active durable plan (server state, survives restarts — do NOT rebuild it from chat history)`,
    `Goal: ${plan.goal}`,
    ...lines,
    plan.blocker ? `Blocker: ${plan.blocker}` : '',
    plan.nextAction ? `Next action: ${plan.nextAction}` : '',
    `Update it with the plan capability: {"action":"use","name":"plan","input":{"action":"progress","stepIndex":<0-based>}} (also "block" with reason, or "done" when every step has a verified receipt). Report progress from THIS state.`,
  ].filter(Boolean).join('\n')
}
