import { timedFetch, apiBase, authHeaders } from './liveContext'
import { parseBlocker, formatCompletionReply, formatBlocker, formatRetentionOffer, formatUnknownFollowUp, type CompletionKind } from './completion'
export type { CompletionKind };
import type { ClaimLedger } from './claimEvidence'

/**
 * Bot-side verified-completion flows (subscription cancellations, restaurant
 * reservations, flight check-ins).
 *
 * Every delegated job is ONE durable row in hire_completions (exactly-once
 * create keyed by user+kind+target). Execution goes through the existing
 * browser-job pipeline; verification parses the observed provider state and
 * only completion-grade evidence may produce the ✓. Unknown outcomes arm an
 * automatic re-check — the user never restarts the task.
 */

const CANCEL_RE =
  /\b(?:cancel|stop|end)\b[^.?!]{0,30}\b(?:my )?(spotify|audible|canva|netflix|hulu|disney\+?|adobe|gym membership|membership|subscription)?\b|\bdon'?t (?:let|have)\b[^.?!]{0,20}\b(?:this|it|them)?\s*(?:auto-?)?renew\b|\bstop (?:the )?(?:auto-?)?renew(?:al)?\b/i
const RESERVE_RE =
  /\b(?:book|reserve|get)\b[^.?!]{0,60}\b(?:a )?(?:table|reservation|dinner)\b/i
const CHECKIN_RE =
  /\bcheck(?:\s*me)?\s*in(?:to)?\b[^.?!]{0,30}\b(?:my )?flight\b/i

export interface CompletionIntent {
  kind: CompletionKind
  target: string
}

const KNOWN_BRANDS = /\b(spotify|audible|canva|netflix|hulu|disney\+?|adobe|amazon)\b/i

/** Gate: asks that should read the durable completion ledger. */
export function completionStatusGate(text: string): boolean {
  return /\bstill working on\b|\bdid (?:it|you|they) (?:actually )?(?:cancel|book|check in)\b|\bwhat (?:am|are) (?:i|we) waiting (?:on|for)\b/i.test(text)
}

export function detectCompletionIntent(text: string): CompletionIntent | null {
  const m = CANCEL_RE.exec(text)
  if (m) {
    /* Prefer the named brand when one appears anywhere in the ask — "cancel my
     * Canva subscription" targets Canva, not a generic 'subscription'. */
    const brand = KNOWN_BRANDS.exec(text)?.[1]?.toLowerCase()
    return { kind: 'subscription_cancel', target: brand || (m[1] || 'subscription').toLowerCase() }
  }
  if (RESERVE_RE.test(text)) return { kind: 'reservation', target: 'restaurant' }
  if (CHECKIN_RE.test(text)) return { kind: 'check_in', target: 'airline' }
  return null
}

/** Verification instructions injected into the browser job goal — the
 * executor must read back state, and must decline upsells/offers. */
export const VERIFY_GOAL: Record<CompletionKind, string> = {
  subscription_cancel: 'Cancel the subscription end-to-end. Do NOT accept pauses, discounts, or downgrades — decline offers and continue cancelling. When done, read back the exact account state: cancelled status, renewal/auto-renew off, access-until date, confirmation number if shown. If a CAPTCHA, logout, or phone/support-only requirement appears, STOP and report exactly what is on screen.',
  reservation: 'Reserve the table for the requested date, time, and party size. Do NOT modify the order or add extras. When done, read back the confirmation number, restaurant, date, and time exactly as shown. If no availability or a login wall appears, STOP and report exactly that.',
  check_in: 'Check the user into the flight. Do NOT purchase seat upgrades, baggage, or any paid extra; decline upsells. When done, read back the check-in confirmation and boarding-pass status exactly. If the window is not open, a passport check is required, or you are already checked in, STOP and report exactly that.',
}

export interface CompletionFlowResult {
  reply: string
  done: boolean
}

function defaultCall(path: string, body: Record<string, unknown>, method = 'POST'): Promise<Record<string, unknown>> {
  return (async () => {
    const base = apiBase()
    if (!base) throw new Error('not configured')
    const res = await timedFetch(`${base}${path}`, {
      method,
      headers: { ...(authHeaders() as Record<string, string>), 'content-type': 'application/json' },
      body: method === 'GET' ? undefined : JSON.stringify(body),
    }, 12000)
    return await res.json().catch(() => ({})) as Record<string, unknown>
  })()
}

/** Drive one completion flow from detection to verified receipt.
 * `verifyNow`: production re-checks observed provider state; fixtures supply
 * the observed text. */
export async function runCompletionFlow(input: {
  dataDir: string
  senderId: string
  persona: string
  intent: CompletionIntent
  userText: string
  evidence?: ClaimLedger
  /** Scripted observed provider state (tests/harness). Absent → verify via browser job goal. */
  observed?: string
  call?: (path: string, body: Record<string, unknown>, method?: string) => Promise<Record<string, unknown>>
}): Promise<CompletionFlowResult> {
  const call = input.call ?? defaultCall
  const { kind, target } = input.intent
  try {
    const created = await call('/api/internal/completions', {
      phone: input.senderId, persona: input.persona, kind, target,
      requested_terms: { ask: input.userText.slice(0, 200) },
    })
    const completion = created.completion as Record<string, unknown> | undefined
    if (!completion) return { reply: 'I could not open the operation record — nothing was executed.', done: false }
    const id = String(completion.id)
    /* Exactly-once: a duplicate create returns the SAME active row, and the
     * flow continues from its durable state instead of executing again. */

    await call('/api/internal/completions', { id, phone: input.senderId, state: 'executing', executor: 'browser', executor_id: `completion_${id}` })

    /* Verification: observe the provider state after execution. In production
     * this is the browser job's read-back; here it is the supplied observation
     * or the scripted verify endpoint. */
    const observed = input.observed ?? ''
    const verify = await call('/api/internal/completions', {
      id, phone: input.senderId, action: 'verify', observed,
    })

    const state = String(verify.state || '')
    const evidence = input.evidence
    /* Dark-pattern pre-checks (§7): upsells are declined, never accepted;
     * no-availability is reported as a clean miss, never an unknown. */
    if (kind === 'check_in' && /\b(?:upgrade|extra legroom|priority boarding|baggage fee)\b/i.test(observed) && !/checked in|boarding pass/i.test(observed)) {
      evidence?.record('work_write', 'verified_empty', { upsellDeclined: true })
      return { reply: `${pretty(target)} showed upgrade offers — I declined them and did NOT check you in. Say continue and I'll finish the standard check-in.`, done: false }
    }
    if (kind === 'reservation' && /\bno (?:availability|tables? available)|fully booked\b/i.test(observed)) {
      evidence?.record('work_write', 'verified_empty', { noAvailability: true })
      return { reply: `No availability at that time. Want me to try a different time or a nearby place?`, done: false }
    }

    if (verify.verified === true) {
      const receipt = verify.receipt as Record<string, unknown>
      const reply = formatCompletionReply({
        operation: kind, status: 'completed',
        provider: String(receipt.provider || target), evidence: receipt.evidence as never,
        result_summary: String(receipt.result_summary || ''), verified_at: String(receipt.verified_at || ''),
      })
      evidence?.record(kind === 'subscription_cancel' ? 'work_write' : 'work_write', 'verified_success', { completionId: id, receipt: true })
      return { reply, done: true }
    }

    if (typeof verify.retentionOffer === 'string' && verify.retentionOffer) {
      evidence?.record('work_write', 'verified_empty', { retentionOffer: verify.retentionOffer })
      return { reply: formatRetentionOffer(pretty(target), verify.retentionOffer), done: false }
    }

    const observedText = observed || ''
    const blocker = parseBlocker(kind, observedText)
    if (blocker) {
      evidence?.record('work_write', 'verified_empty', { blocker: blocker.type })
      return { reply: formatBlocker(blocker, pretty(target)), done: false }
    }

    if (state === 'outcome_unknown') {
      evidence?.record('work_write', 'verified_empty', { outcomeUnknown: true })
      return { reply: formatUnknownFollowUp(pretty(target), 1, 3, kind), done: false }
    }

    return { reply: `I started the ${pretty(target)} ${kind === 'reservation' ? 'reservation' : 'cancellation'} but could not confirm the result yet. I'll keep checking and tell you the moment it's verified.`, done: false }
  } catch (err) {
    return { reply: `I couldn't run the ${pretty(target)} ${kind === 'reservation' ? 'booking' : 'cancellation'} just now — nothing was executed twice and nothing was charged. Say retry and I'll pick it up. (${err instanceof Error ? err.message : 'error'})`, done: false }
  }
}

/** "Did it actually cancel?" — reads the DURABLE row, never chat memory. */
export async function completionStatusReply(input: {
  dataDir?: string
  senderId: string
  persona: string
  userText: string
  evidence?: ClaimLedger
  call?: (path: string, body: Record<string, unknown>, method?: string) => Promise<Record<string, unknown>>
}): Promise<string | null> {
  if (!/\b(?:did|is|was|are)\b[^.]{0,30}\b(?:it|that|we|still)\b|\bwhat are you still working on\b|\bstill working on\b/i.test(input.userText)) {
    if (!/still working on/i.test(input.userText)) return null
  }
  try {
    const data = await (input.call ?? defaultCall)(`/api/internal/completions?phone=${encodeURIComponent(input.senderId)}&persona=${encodeURIComponent(input.persona)}`, {}, 'GET')
    const list = (data.completions as Array<Record<string, unknown>> | undefined) || []
    if (!list.length) return null
    const active = list.filter((c) => !['completed', 'failed', 'cancelled'].includes(String(c.state)))
    const done = list.filter((c) => String(c.state) === 'completed').slice(0, 3)
    const lines: string[] = []
    for (const c of active.slice(0, 4)) {
      lines.push(`${pretty(String(c.target))} ${String(c.kind) === 'reservation' ? 'booking' : 'cancellation'} — ${statusPhrase(String(c.state), c.blocker)}`)
    }
    for (const c of done) {
      const receipt = c.receipt as Record<string, unknown> | null
      const summary = receipt ? String((receipt.evidence as Record<string, unknown>)?.summary || '').slice(0, 120) : String(c.result_summary || '').slice(0, 120)
      lines.push(`${pretty(String(c.target))}: verified ✓ — ${summary}`)
    }
    if (!lines.length) return null
    return lines.join('\n')
  } catch {
    return null
  }
}

function statusPhrase(state: string, blocker: unknown): string {
  if (state === 'pending') return 'queued, not started yet'
  if (state === 'needs_authorization') return 'waiting for your approval'
  if (state === 'executing') {
    const b = blocker as Record<string, unknown> | null
    if (b?.type === 'captcha') return 'waiting for you to solve the CAPTCHA'
    if (b?.type === 'reauth') return 'waiting for you to reconnect the login'
    if (b?.type === 'retention_offer') return 'waiting on the retention offer decision'
    return 'executing'
  }
  if (state === 'verification_pending') return 'submitted — waiting for verification'
  if (state === 'outcome_unknown') return 'submitted but unverified — I will re-check'
  if (state === 'cancellation_requested') return 'cancellation requested while it was running — checking'
  return state
}

function pretty(target: string): string {
  const key = target.toLowerCase()
  const map: Record<string, string> = { spotify: 'Spotify', audible: 'Audible', canva: 'Canva', netflix: 'Netflix', hulu: 'Hulu', adobe: 'Adobe', restaurant: 'the restaurant', airline: 'the airline' }
  return map[key] || target.charAt(0).toUpperCase() + target.slice(1)
}
