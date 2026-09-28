/**
 * Claim provenance — the smallest mechanism that lets the response layer know
 * where outcome claims came from, so a model sentence can never silently
 * collapse evidence states.
 *
 * Core invariant: Alpha must not make a factual claim about external state,
 * execution, failure, cancellation, or capability unless the engine has
 * evidence supporting that claim. This applies to positive AND negative
 * claims:
 *   "Sent."                requires a provider send receipt.
 *   "Failed to send."      requires an actual send attempt that failed.
 *   "Cancelled."           requires a confirmed cancellation transition.
 *   "Sam has not replied." requires a successful thread read.
 *   "Calendar unavailable" requires an actual calendar read/auth attempt that failed.
 *   "Nothing is running."  requires checking durable active-work state.
 *   "I can't do that."     must reflect a real capability/policy limit, not an
 *                          unattempted action.
 *
 * The ledger is written by the engine wherever it touches the world (lookups,
 * capability executions, drafts, browser staging, spend decisions, cancels).
 * `enforceClaimEvidence` is the last outbound gate: it scans the reply,
 * downgrades any sentence whose claim lacks evidence, and rewrites negative
 * claims about sources that were never attempted. It is deliberately
 * mechanical — deterministic rewrite, no model call, no ontology beyond the
 * evidence kinds.
 */

export type ClaimKind =
  | 'verified_success'
  | 'verified_failure'
  | 'verified_empty'
  | 'not_attempted'
  | 'unsupported'
  | 'permission_denied'
  | 'auth_expired'
  | 'provider_unavailable'
  | 'timeout'
  | 'outcome_unknown'
  | 'cancelled'
  | 'cancellation_requested'
  | 'already_completed'

export type EvidenceDomain =
  | 'mail_send'
  | 'mail_read'
  | 'calendar_read'
  | 'calendar_write'
  | 'reminder'
  | 'browser'
  | 'purchase'
  | 'scheduled_text'
  | 'followup'
  | 'watch'
  | 'spend'
  | 'web'
  | 'maps'
  | 'drive'
  | 'file_send'
  | 'work_write'

export interface EvidenceEntry {
  domain: EvidenceDomain
  kind: ClaimKind
  at: number
  detail?: Record<string, unknown>
}

export class ClaimLedger {
  readonly entries: EvidenceEntry[] = []

  record(domain: EvidenceDomain, kind: ClaimKind, detail?: Record<string, unknown>): void {
    this.entries.push({ domain, kind, at: Date.now(), detail })
  }

  last(domain: EvidenceDomain): EvidenceEntry | undefined {
    for (let i = this.entries.length - 1; i >= 0; i--) {
      if (this.entries[i].domain === domain) return this.entries[i]
    }
    return undefined
  }

  hasAny(domain: EvidenceDomain): boolean {
    return this.entries.some((e) => e.domain === domain)
  }

  hasKind(domain: EvidenceDomain, kinds: ClaimKind[]): boolean {
    return this.entries.some((e) => e.domain === domain && kinds.includes(e.kind))
  }

  hasKindAny(domains: EvidenceDomain[], kinds: ClaimKind[]): boolean {
    return this.entries.some((e) => domains.includes(e.domain) && kinds.includes(e.kind))
  }

  /** A provider receipt (send id, payment intent, event id, order id) — not
   * merely a staged draft. Receipts are what separate "staged" from "done". */
  hasReceipt(domain: EvidenceDomain): boolean {
    return this.entries.some(
      (e) => e.domain === domain && e.kind === 'verified_success' && (e.detail?.receipt === true || typeof e.detail?.providerId === 'string'),
    )
  }

  /** Domains with work that is staged/armed and not known complete — the
   * "nothing is running" check. */
  activeWork(): EvidenceEntry[] {
    return this.entries.filter((e) => e.kind === 'verified_success' && e.detail?.active === true)
  }
}

/* ---- Sentence rewriting ---- */

const POLICY_LIMIT_RE =
  /\b(?:i will never|i'm not able to move|cannot move money|never initiate|i'm not allowed|against my rules|for (?:your )?security)\b/i

interface ClaimRule {
  /** Matches a claim sentence. */
  re: RegExp
  kind: 'positive' | 'negative'
  domain: EvidenceDomain
  /** Evidence kinds that make the claim allowed as-is. */
  allowed: ClaimKind[]
  /** Overrides the kind check when set (e.g. receipt-gated rules). */
  check?: (ledger: ClaimLedger) => boolean
  /** The grounded replacement when evidence is missing. */
  replacement: (ledger: ClaimLedger) => string
}

/** A sentence counts as checked-claim only when it is not a question and not a
 * hypothetical ("if I send it…", "should I…"). */
function isAssertive(sentence: string): boolean {
  const s = sentence.trim()
  if (!s) return false
  if (/[?？]\s*$/.test(s)) return false
  if (/^\s*(?:if|should i|whether i|maybe i|what if)\b/i.test(s)) return false
  if (/\b(?:if|whether|should i)\b[^,.;!?]*\b(?:then|, i(?:'ll| will))\b/i.test(s)) return false
  return true
}

const RULES: ClaimRule[] = [
  /* Positive execution claims */
  {
    kind: 'positive',
    re: /\b(sent|sending|emailed|fired off|went out|on its way (?:to|out)|is out)\b/i,
    domain: 'mail_send',
    allowed: ['verified_success'],
    check: (l) => l.hasReceipt('mail_send'),
    replacement: () => 'The email is drafted for your review — nothing has been sent yet.',
  },
  {
    kind: 'positive',
    re: /\b(?:booked|reserved|scheduled it|put (?:it|that) on (?:your|the) calendar|calendar invite (?:is )?(?:sent|out)|event created|moved it|rescheduled)\b/i,
    domain: 'calendar_write',
    allowed: ['verified_success'],
    check: (l) => l.hasReceipt('calendar_write'),
    replacement: () => 'That is staged as a draft for your confirmation — the calendar has not been changed yet.',
  },
  {
    kind: 'positive',
    re: /\b(?:reminder (?:is )?(?:set|saved|scheduled|locked in)|i(?:'ll| will)? remind you|will (?:ping|text|nudge) you (?:at|on))\b/i,
    domain: 'reminder',
    allowed: ['verified_success'],
    replacement: () => 'The reminder did not save on my end, so I cannot confirm it is set.',
  },
  {
    kind: 'positive',
    re: /\b(?:cancelled|canceled|called (?:it|that) off|stopped (?:it|that|the (?:run|job|watch|order)))\b/i,
    domain: 'browser',
    allowed: ['cancelled'],
    replacement: (l) =>
      l.hasKindAny(['browser', 'watch', 'followup', 'purchase', 'scheduled_text', 'reminder'], ['cancellation_requested', 'outcome_unknown'])
        ? 'Cancel was requested; I will confirm once it lands. Until then treat it as possibly still running.'
        : 'I have not cancelled anything — nothing was stopped.',
  },
  {
    kind: 'positive',
    re: /\b(?:purchased|ordered it|order(?:ed)? (?:is )?placed|payment (?:went through|received|confirmed)|charged)\b/i,
    domain: 'purchase',
    allowed: ['verified_success'],
    check: (l) => l.hasReceipt('purchase'),
    replacement: () => 'No payment is confirmed. The pending request is unchanged; review the approval card.',
  },
  {
    kind: 'positive',
    re: /\b(?:watch is (?:armed|set|running)|i(?:'ll| will)? (?:keep an eye|monitor)|tracking (?:it|that) (?:for you|now))\b/i,
    domain: 'watch',
    allowed: ['verified_success'],
    replacement: () => 'The watch did not arm — nothing is monitoring that yet.',
  },
  /* Completion claims about async browser runs — staging is not completion. */
  {
    kind: 'positive',
    re: /\b(?:registered|signed up|booked (?:you|us)|completed|finished|checkout (?:is )?(?:complete|done)|order (?:is )?placed)\b/i,
    domain: 'browser',
    allowed: [],
    check: (l) => l.entries.some((e) => e.domain === 'browser' && e.detail?.receipt === true),
    replacement: () => 'The browser run is queued and pauses before any sensitive step — nothing is completed yet, and I will report back with a verified result.',
  },
  /* Negative / incapability claims */
  {
    kind: 'negative',
    re: /\b(?:couldn'?t|can'?t|was unable to|failed to|did not|didn'?t) (?:reach|check|read|see|pull|load|access|connect to)\b/i,
    domain: 'calendar_read',
    allowed: ['verified_failure', 'auth_expired', 'provider_unavailable', 'timeout', 'permission_denied', 'outcome_unknown'],
    replacement: () => 'I have not actually checked your calendar yet, so I cannot say whether it is reachable.',
  },
  {
    kind: 'negative',
    re: /\b(?:couldn'?t|can'?t|was unable to|failed to|did not|didn'?t) (?:reach|check|read|search|load|access|connect to)\b[^.]*\b(?:inbox|email|gmail|mail)\b/i,
    domain: 'mail_read',
    allowed: ['verified_failure', 'auth_expired', 'provider_unavailable', 'timeout', 'permission_denied', 'outcome_unknown'],
    replacement: () => 'I have not actually checked your inbox yet, so I cannot say what is there.',
  },
  {
    kind: 'negative',
    re: /\b(?:calendar is|calendar(?:'s)?|your calendar)\b[^.]{0,40}\b(?:unavailable|not (?:working|responding|reachable)|down)\b/i,
    domain: 'calendar_read',
    allowed: ['verified_failure', 'auth_expired', 'provider_unavailable', 'timeout', 'permission_denied', 'outcome_unknown'],
    replacement: () => 'I have not actually checked your calendar yet, so I cannot say whether it is reachable.',
  },
  {
    kind: 'negative',
    re: /\b(?:the |your )?(?:email|mail|send|reminder|draft) (?:failed|did not go through|didn'?t go through|bounced|did not save|didn'?t save)\b/i,
    domain: 'mail_send',
    allowed: ['verified_failure', 'provider_unavailable', 'timeout', 'outcome_unknown'],
    replacement: () => 'I have not attempted that yet, so I cannot report a failure.',
  },
  {
    kind: 'negative',
    re: /\bnothing(?:'s)?\s+(?:is\s+)?(?:running|ticking|queued|active|pending|in flight|left)\b|\bno\s+(?:reminders?|watches?|jobs?|runs?|orders?|follow-?ups?)\s+(?:running|active|pending|left|ticking)\b/i,
    domain: 'browser',
    allowed: ['cancelled', 'verified_empty'],
    replacement: (l) => {
      const active = l.activeWork()
      const names = active.map((e) => String(e.detail?.label || e.domain)).join(', ')
      return names
        ? `Correction: ${names} is still active — I have not cancelled it.`
        : 'Nothing is active as far as this thread records, but I have not re-checked durable state this turn.'
    },
  },
]

export interface ClaimAudit {
  reply: string
  violations: string[]
}

/**
 * Enforce the claims-to-evidence invariant on a finished reply. Deterministic:
 * sentence split → rule scan → ledger check → rewrite. Policy-limit sentences
 * ("I will never initiate wires") pass untouched.
 */
export function enforceClaimEvidence(reply: string, ledger: ClaimLedger): ClaimAudit {
  if (!reply) return { reply, violations: [] }
  const violations: string[] = []
  /* Split on sentence ends but keep delimiters; handles newlines as breaks. */
  const parts = reply.split(/(?<=[.!?])\s+|\n+/)
  const out = parts.map((sentence) => {
    if (!isAssertive(sentence) || POLICY_LIMIT_RE.test(sentence)) return sentence
    for (const rule of RULES) {
      if (!rule.re.test(sentence)) continue
      const ok = rule.check ? rule.check(ledger) : ledger.hasKind(rule.domain, rule.allowed)
      /* A negative claim is also fine when the domain was genuinely attempted
       * and returned something (verified_empty counts as evidence). This
       * allowance must never rescue a POSITIVE claim: "it failed" with a
       * success receipt on record is still a contradiction the next rule
       * version should catch, so failure-vs-success mismatches stay flagged
       * for the positive rules only. */
      const evidenceOfAttempt = ledger.hasAny(rule.domain)
      if (ok || (rule.kind === 'negative' && evidenceOfAttempt)) return sentence
      violations.push(sentence.trim().slice(0, 160))
      return rule.replacement(ledger)
    }
    return sentence
  })
  return { reply: out.join(' ').replace(/ {2,}/g, ' ').trim(), violations }
}

/** Map a capability outcome status to an evidence kind. */
export function kindFromCapabilityStatus(status: string): ClaimKind {
  switch (status) {
    case 'done':
      return 'verified_success'
    case 'returned':
      return 'verified_empty'
    case 'failed':
      return 'verified_failure'
    default:
      return 'outcome_unknown'
  }
}
