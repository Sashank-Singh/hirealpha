/**
 * Verified completion layer — the canonical contract for delegated external
 * operations (subscription cancellations, reservations, flight check-ins).
 *
 * Product rule: execution is NOT completion. "Clicked cancel", "submitted the
 * form", "API 200" are execution states. Completion requires EVIDENCE of the
 * intended external outcome (account state, confirmation number, confirmation
 * email, boarding pass…). Without evidence the operation is
 * `verification_pending` or `outcome_unknown` — never `completed`.
 *
 * This module is the pure core: state machine, evidence parsing, receipts and
 * user-visible formatting. Durable state lives in `hire_completions`
 * (deploy/routes/completions.ts); the browser worker remains the executor and
 * posts observed evidence here.
 *
 * Lifecycle:
 *   intent → resolve target → gather context → prepare → authorize (if the
 *   consequences are material) → execute → verify external state → persist
 *   receipt → report → monitor/follow up → recover if uncertain.
 */

export type CompletionState =
  | 'pending'
  | 'needs_authorization'
  | 'executing'
  | 'verification_pending'
  | 'completed'
  | 'failed'
  | 'outcome_unknown'
  | 'cancellation_requested'
  | 'cancelled'

export type CompletionKind = 'subscription_cancel' | 'reservation' | 'check_in'

/** Typed blockers: the operation cannot continue autonomously right now. */
export type CompletionBlocker =
  | { type: 'captcha'; message: string }
  | { type: 'reauth'; message: string }
  | { type: 'phone_required'; message: string; phone?: string }
  | { type: 'support_only'; message: string }
  | { type: 'retention_offer'; message: string; offer: string }
  | { type: 'window_not_open'; message: string; opensAt?: string }

const ALLOWED: Record<CompletionState, readonly CompletionState[]> = {
  pending: ['needs_authorization', 'executing', 'cancelled', 'failed'],
  needs_authorization: ['executing', 'cancelled', 'cancellation_requested', 'failed'],
  executing: ['verification_pending', 'failed', 'outcome_unknown', 'cancellation_requested', 'cancelled'],
  verification_pending: ['completed', 'failed', 'outcome_unknown', 'executing'],
  outcome_unknown: ['verification_pending', 'completed', 'failed', 'cancellation_requested'],
  completed: [],
  failed: ['pending', 'executing'],
  cancellation_requested: ['cancelled', 'outcome_unknown'],
  cancelled: [],
}

/** Guarded transition table. Unknown/illegal transitions return false so
 * callers never silently skip a verification step. */
export function canTransition(from: CompletionState, to: CompletionState): boolean {
  return (ALLOWED[from] || []).includes(to)
}

/* ---- Evidence ---- */

export type EvidenceType =
  | 'account_state'        // provider page now shows cancelled / renewal off
  | 'confirmation_number'  // merchant confirmation code
  | 'confirmation_email'   // confirmation email received
  | 'boarding_pass'        // airline issued boarding pass
  | 'reservation_state'    // account booking list shows the reservation
  | 'provider_api'         // provider API status field
  | 'retention_offer'      // merchant countered with pause/discount
  | 'none'

export interface CompletionEvidence {
  type: EvidenceType
  summary: string
  confirmationNumber?: string
  renewalOff?: boolean
  accessThrough?: string
  provider?: string
  /** Merchant countered with an alternative (pause/discount). Never accepted
   * autonomously — surfaced to the user for a decision. */
  retentionOffer?: string
  checkedIn?: boolean
}

export interface CompletionReceipt {
  operation: CompletionKind
  status: 'completed' | 'outcome_unknown' | 'failed' | 'cancelled'
  provider: string
  external_id?: string
  verified_at: string
  evidence: CompletionEvidence
  result_summary: string
}

/* ---- Evidence extraction from executor output ---- */

const CONFIRMATION_RE =
  /\b(?:confirmation|cancellation|booking|reservation)\s*(?:#|number|no\.?|code)\s*[:#]?\s*([A-Z0-9]{5,12})\b|#\s*([A-Z0-9]{5,12})\b/i

/** Parse observed provider/executor output into structured evidence.
 * `text` is the browser worker's result summary or the provider page text.
 * Returns null when nothing completion-grade was observed. */
export function parseCompletionEvidence(kind: CompletionKind, text: string, providerHint?: string): CompletionEvidence | null {
  const t = text || ''
  if (!t.trim()) return null
  const hint = providerHint?.trim()
  const withHint = hint && !new RegExp(`\\b${hint.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(t)
    ? `${t} (${hint})`
    : t

  if (kind === 'subscription_cancel') return parseCancelEvidence(withHint)
  if (kind === 'reservation') return parseReservationEvidence(withHint)
  return parseCheckInEvidence(withHint)
}

function parseCancelEvidence(t: string): CompletionEvidence | null {
  // Retention dark patterns first: an offer must never read as completion.
  const offer =
    /(?:50%|30%|20%)\s*off/i.exec(t)?.[0] ||
    /(?:pause|pause instead|keep (?:your )?(?:subscription|membership) (?:but )?paused)/i.exec(t)?.[0] ||
    /(?:switch|downgrade) to (?:the )?(?:free|basic|cheaper)/i.exec(t)?.[0] ||
    /free (?:month|trial) (?:to stay|if you stay)/i.exec(t)?.[0]
  if (offer && !/\b(?:cancel(?:l?ed|lation)\b|renewal (?:is )?off|ends? on)/i.test(t)) {
    return { type: 'retention_offer', summary: `Merchant offered: ${offer}`, retentionOffer: offer, provider: providerName(t) }
  }

  const m = CONFIRMATION_RE.exec(t)
  const confirm = m?.[1] || m?.[2]
  const cancelledState =
    /\b(?:cancel(?:l?ed|lation) (?:confirmed|complete|successful|processed)|subscription (?:has been |is now |was )?cancel(?:l?ed)|membership cancel(?:l?ed)|renewal (?:is now |has been )?(?:off|disabled|turned off)|auto-?renew (?:is )?off|will not renew|ends? on [A-Z][a-z]{2,8} \d{1,2}(?:,? \d{4})?|access (?:until|through) [A-Z][a-z]{2,8} \d{1,2})/i.test(t)
  const accessThrough = /access (?:until|through)\s+([A-Z][a-z]{2,8} \d{1,2}(?:,? \d{4})?)/i.exec(t)?.[1]
  const endsOn = /(?:ends? on|your (?:plan|subscription) ends)\s+([A-Z][a-z]{2,8} \d{1,2}(?:,? \d{4})?)/i.exec(t)?.[1]

  if (cancelledState || confirm || accessThrough || endsOn) {
    return {
      type: confirm ? 'confirmation_number' : 'account_state',
      summary: firstSentence(t),
      ...(confirm ? { confirmationNumber: confirm } : {}),
      renewalOff: /renewal (?:is )?off|auto-?renew (?:is )?off|will not renew/i.test(t) || undefined,
      ...(accessThrough || endsOn ? { accessThrough: accessThrough || endsOn } : {}),
      provider: providerName(t),
    }
  }

  // Already cancelled earlier?
  if (/\balready cancel(?:l?ed)|your (?:subscription|membership) is (?:already )?(?:cancelled|inactive)|no active subscription/i.test(t)) {
    return { type: 'account_state', summary: 'Account already shows the subscription as cancelled.', provider: providerName(t) }
  }

  // Blockers
  if (/\bcaptcha|verify you'?re human|security check\b/i.test(t)) {
    return { type: 'none', summary: 'blocked: captcha', provider: providerName(t) }
  }
  if (/\b(?:log(?:ged)? ?out|sign in (?:to|again)|session expired)\b/i.test(t)) {
    return { type: 'none', summary: 'blocked: logged out', provider: providerName(t) }
  }
  if (/\bcall (?:us|customer (?:service|support))|by phone only|speak (?:to|with) (?:an )?agent\b/i.test(t)) {
    return { type: 'none', summary: 'blocked: phone/support only', provider: providerName(t) }
  }
  if (/\bcontact support|email (?:us|support) to cancel\b/i.test(t)) {
    return { type: 'none', summary: 'blocked: support-only cancellation', provider: providerName(t) }
  }
  return null
}

function parseReservationEvidence(t: string): CompletionEvidence | null {
  const m = CONFIRMATION_RE.exec(t)
  const confirm = m?.[1] || m?.[2]
  const confirmed =
    /\b(?:reservation|booking|table) (?:is )?(?:confirmed|booked|complete)|booking confirmed|you'?re (?:all )?booked|reservation #/i.test(t)
  const noAvailability = /\bno (?:availability|tables? available)|fully (?:booked|committed)|sold out\b/i.test(t)
  if ((confirmed || confirm) && !noAvailability) {
    const time = /\b(\d{1,2}(?::\d{2})?\s*(?:AM|PM))\b/i.exec(t)?.[1]
    const party = /\bfor (\d+|two|three|four|five|six)\b/i.exec(t)?.[1]
    return {
      type: confirm ? 'confirmation_number' : 'reservation_state',
      summary: firstSentence(t),
      ...(confirm ? { confirmationNumber: confirm } : {}),
      provider: providerName(t),
      checkedIn: undefined,
      ...(time || party ? { accessThrough: [time, party ? `${party} people` : ''].filter(Boolean).join(' · ') } : {}),
    }
  }
  if (noAvailability) {
    return { type: 'none', summary: 'No availability at the requested time.', provider: providerName(t) }
  }
  if (/\blog ?in|sign in (?:to|required)|create an account\b/i.test(t)) {
    return { type: 'none', summary: 'blocked: login required', provider: providerName(t) }
  }
  return null
}

function parseCheckInEvidence(t: string): CompletionEvidence | null {
  const boardingPass = /\bboarding pass\b/i.test(t)
  const checkedIn =
    /\b(?:you'?re|you are|is) checked in\b|check-?in (?:confirmed|complete|successful)|successfully checked in\b/i.test(t)
  const notOpen = /\bcheck-?in (?:isn'?t open|not open|opens|is available)\b|\btoo early to check in\b/i.test(t)
  const already = /\balready checked in\b/i.test(t)
  const upgrade = /\b(?:upgrade|seat selection|priority|extra legroom|baggage fee|premium)\b/i.test(t)
  const passport = /\bpassport (?:verification|required)|verify your passport\b/i.test(t)

  if (already) {
    return { type: 'account_state', summary: 'Already checked in.', checkedIn: true, provider: providerName(t) }
  }
  if ((checkedIn || boardingPass) && !upgrade) {
    return { type: 'boarding_pass', summary: firstSentence(t), checkedIn: true, provider: providerName(t) }
  }
  if (passport) {
    return { type: 'none', summary: 'blocked: passport verification required', provider: providerName(t) }
  }
  if (notOpen) {
    const opens = /opens?(?:\s+(?:at|on))?\s+([A-Za-z0-9 ,:/]+?)(?:\.|$)/i.exec(t)?.[1]
    return { type: 'none', summary: 'Check-in window not open yet.', ...(opens ? { accessThrough: opens } : {}), provider: providerName(t) }
  }
  if (upgrade) {
    // An upsell appeared; completion requires non-upsell confirmation evidence.
    return { type: 'none', summary: 'blocked: upsell offer shown, no check-in confirmation', provider: providerName(t) }
  }
  return null
}

function firstSentence(t: string): string {
  const s = (t || '').replace(/\s+/g, ' ').trim()
  const m = s.match(/^[^.!?]{10,160}(?:[.!?]|$)/)
  return (m ? m[0] : s.slice(0, 160)).trim()
}

function providerName(t: string): string | undefined {
  return /\b(spotify|audible|canva|netflix|hulu|disney\+?|adobe|amazon)\b/i.exec(t)?.[1]
}

/* ---- Blockers ---- */

export type ParsedBlocker =
  | { type: 'captcha'; message: string }
  | { type: 'passport'; message: string }
  | { type: 'reauth'; message: string }
  | { type: 'phone_required'; message: string; phone?: string }
  | { type: 'support_only'; message: string }
  | { type: 'login_required'; message: string }
  | null

/** Extract a typed blocker from executor output. Phone-only and support-only
 * cancellations are detected, not failed — they become useful evidence. */
export function parseBlocker(kind: CompletionKind, text: string): ParsedBlocker {
  const t = text || ''
  if (/\bcaptcha|verify you'?re human|security check\b/i.test(t)) {
    return { type: 'captcha', message: `${providerName(t) || 'The site'} needs a CAPTCHA. Solve it and I'll continue from there.` }
  }
  if (/\bpassport (?:verification|required|check)|verify your passport\b/i.test(t)) {
    return { type: 'passport', message: 'The airline requires passport verification before check-in. Complete it and I\'ll continue.' }
  }
  if (kind === 'reservation' && /\b(?:sign in to complete|log ?in (?:to|is required)|create an account)\b/i.test(t)) {
    return { type: 'login_required', message: 'Booking requires a login on that site.' }
  }
  if (/\b(?:log(?:ged)? ?out|session expired)\b/i.test(t)) {
    return { type: 'reauth', message: `${providerName(t) || 'The site'} logged me out. Reconnect the login and I'll continue.` }
  }
  const phone = /\b(?:call|phone) (?:us|customer (?:service|support))[^.]{0,60}?(\+?\d[\d\-(). ]{7,}\d)/i.exec(t)?.[1]
    || /(\+?\d[\d\-(). ]{7,}\d)[^.]{0,40}to cancel/i.exec(t)?.[1]
  if (/\b(?:by )?phone only|must (?:be )?cancel(?:l?ed) by phone|call (?:us|customer (?:service|support)) to cancel\b/i.test(t)) {
    return { type: 'phone_required', message: `${providerName(t) || 'This provider'} only accepts cancellations by phone. I can't place calls yet — I found what they require.`, ...(phone ? { phone } : {}) }
  }
  if (/\bcontact support|email (?:us|support) to cancel|support[- ]only\b/i.test(t)) {
    return { type: 'support_only', message: `${providerName(t) || 'This provider'} only accepts cancellations via support. I found the requirements.` }
  }
  if (kind === 'reservation' && /\blog ?in|sign in (?:to|required)|create an account\b/i.test(t)) {
    return { type: 'login_required', message: 'Booking requires a login on that site.' }
  }
  return null
}

/* ---- Receipts + user-visible output ---- */

/** Build the canonical receipt from a verified completion. */
export function buildReceipt(input: {
  kind: CompletionKind
  status: 'completed' | 'outcome_unknown' | 'failed' | 'cancelled'
  provider?: string
  evidence: CompletionEvidence
  resultSummary: string
  externalId?: string
  verifiedAt?: string
}): CompletionReceipt {
  return {
    operation: input.kind,
    status: input.status,
    provider: input.evidence.provider || input.provider || 'unknown',
    ...(input.externalId ? { external_id: input.externalId } : {}),
    verified_at: input.verifiedAt || new Date().toISOString(),
    evidence: input.evidence,
    result_summary: input.resultSummary,
  }
}

const LABEL: Record<CompletionKind, string> = {
  subscription_cancel: 'Cancelled',
  reservation: 'Reserved',
  check_in: 'Checked in',
}

const PROVIDER_LABEL: Record<string, string> = {
  canva: 'Canva',
  'disney+': 'Disney+',
  'disney': 'Disney',
}

function prettyProvider(p?: string): string {
  if (!p || p === 'unknown' || p === 'restaurant' || p === 'airline') return ''
  const key = p.toLowerCase()
  return PROVIDER_LABEL[key] || p.charAt(0).toUpperCase() + p.slice(1)
}

/** Compact iMessage line with the Verified ✓ marker. The ✓ means the external
 * outcome was verified — never shown for a mere attempt. */
export function formatCompletionReply(receipt: CompletionReceipt): string {
  const label = LABEL[receipt.operation]
  const provider = prettyProvider(receipt.evidence.provider || receipt.provider)
  const lines: string[] = [`${label} ${provider} ✓`]
  const e = receipt.evidence
  if (receipt.operation === 'subscription_cancel') {
    if (e.renewalOff) lines.push('Renewal: off')
    if (e.accessThrough) lines.push(`Access through: ${e.accessThrough}`)
    if (e.confirmationNumber) lines.push(`Confirmation #${e.confirmationNumber}`)
  }
  if (receipt.operation === 'reservation') {
    if (e.accessThrough) lines.push(e.accessThrough)
    if (e.confirmationNumber) lines.push(`Confirmation #${e.confirmationNumber}`)
  }
  if (receipt.operation === 'check_in') {
    lines.push('Boarding pass ready')
  }
  if (receipt.status === 'outcome_unknown') {
    return `${provider}: submitted, but I can't verify the outcome yet. I won't claim it's done — I'll check again.`
  }
  return lines.join('\n')
}

/** Unknown-outcome follow-up message (§9). */
export function formatUnknownFollowUp(provider: string, attempt: number, maxAttempts: number, kind: CompletionKind = 'subscription_cancel'): string {
  const noun = kind === 'reservation' ? 'booking' : kind === 'check_in' ? 'check-in' : 'cancellation'
  const state = kind === 'reservation' ? 'booking' : kind === 'check_in' ? 'checked-in status' : 'subscription'
  if (attempt < maxAttempts) {
    return `I submitted the ${provider} ${noun}, but I can't verify it was accepted yet. I won't claim it's done — I'll check again in 10 minutes.`
  }
  return `I still can't verify the ${provider} ${noun} after several checks. Your ${state} may still be active — the next blocker is on their side. I'll keep the operation open and tell you what I find.`
}

/** Retention-offer message — the user's goal is never silently changed. */
export function formatRetentionOffer(provider: string, offer: string): string {
  return `${provider} offered ${offer} instead of cancelling. Want the offer, or should I continue cancelling?`
}

/** Blocker message (§13/§14) — typed, honest, resumable. */
export function formatBlocker(blocker: NonNullable<ParsedBlocker>, provider?: string): string {
  const p = prettyProvider(provider) || 'They'
  switch (blocker.type) {
    case 'captcha':
      return `${p} needs a CAPTCHA. Tap the session link, solve it, and I'll continue from there — you won't have to ask again.`
    case 'reauth':
      return `${p} logged me out. Reconnect the login and I'll pick up exactly where I left off.`
    case 'phone_required':
      return `${p} only accepts cancellations by phone. I can't place calls yet. ${blocker.phone ? `Their cancellation line: ${blocker.phone}. ` : 'I found their requirements. '}Say the word once it's done and I'll verify it.`
    case 'support_only':
      return `${p} only accepts cancellations via support. I found the requirements and the exact steps — want me to draft the support message?`
    case 'login_required':
      return `That booking site needs a login. Save it in the vault and I'll retry.`
    case 'passport':
      return 'The airline requires passport verification. Complete it and I\'ll take over from there.'
  }
}

/** Stable dedup key: same user asking twice for the same target must resolve
 * to ONE operation (exactly-once create). */
export function completionKey(userId: string, persona: string, kind: CompletionKind, target: string): string {
  return `${userId}|${persona}|${kind}|${target.trim().toLowerCase()}`
}
