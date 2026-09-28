/**
 * Assessment routing — evidence-first answers to state-evaluation asks.
 *
 * The audit found assessment asks ("Can I afford this?", "What am I
 * forgetting?", "Where did my week go?", "Am I on track?") answering from
 * prose while the sources that could settle them sat unused. The gap was
 * ROUTING, not tooling.
 *
 * Design (deliberately small):
 *
 *   user request
 *     → assessmentCandidates()      cheap syntactic gate (question-shaped,
 *                                   state predicate, not an action ask)
 *     → inferAssessmentDomains()    which evidence domains this ask needs
 *     → evidencePlanNote()          the plan handed to the tool loop
 *     → the model executes only the needed sources
 *     → minimumEvidenceCheck()      what still has to be true before a
 *                                   confident conclusion is allowed
 *
 * There is no per-phrase handler table: domain inference is keyed on the
 * ask's SEMANTIC domain words (money, time, obligations, schedule…), and the
 * evidence note makes the model enumerate sources itself. Deterministic on
 * purpose: this is the path that must work when the classifier model is
 * unreachable, so every decision here is unit-testable offline.
 */

export type AssessmentDomain = 'calendar' | 'mail' | 'money' | 'plans' | 'commitments' | 'contacts' | 'drive'

export interface AssessmentPlan {
  assessment: boolean
  domains: AssessmentDomain[]
  /** Short machine reason for the transcript metrics. */
  reason: string
}

/** Actions that look state-ish but are really commands — never assessment. */
/* Strong imperative verbs only. Ambiguous nouns are excluded on purpose:
 * "schedule"/"move"/"call" appear in assessment asks ("is my schedule
 * realistic?", "my call later") — an action ask is already kept out by the
 * question/predicate requirement below, so the verb list stays unambiguous. */
const ACTION_ASK_RE =
  /\b(?:book|reserve|order|buy|send|draft|remind|cancel|reschedule|log|create|add|set up|register|sign ?up|unsubscribe|archive|forward|pay|email (?:him|her|them|the)|text (?:him|her|them|mom|dad))\b/i

/** A question (or ask-for-judgment) about the user's own state. */
const STATE_PREDICATE_RE =
  /\b(?:am i|are we|do i|should i|did i|is anything|is there anything|anything (?:i|going|else)|what (?:am i|should i|do i|did i|have i|needs|changed|else)|where (?:did|does|is|are)|how (?:much|busy|far along|am i doing)|ready|on track|forgetting|forgot|missed|missing|collide|conflict|owe|waiting on|waiting for|worry|worried|realistic|prepared|set for|covered|what'?s left|what remains|what'?s blocking|blocking me|my week|my day|my month)\b/i

const CASUAL_RE = /^\s*(?:thanks?|ty|thx|cool|nice|great|ok(?:ay)?|haha|lol|gm|good morning|night|gn)\b[\s!.]*$/i

/** Cheap syntactic gate: could this be an assessment ask? Runs every turn;
 * the model confirmation (when available) still has the final say, but the
 * fall-through this gates is correct even offline. */
export function assessmentCandidates(text: string): boolean {
  const t = text.trim()
  if (!t || t.length < 4) return false
  if (CASUAL_RE.test(t)) return false
  if (ACTION_ASK_RE.test(t)) return false
  const questionish = /[?？]/.test(t) || /^\s*(?:am i|are we|do i|should i|did i|is |are |can i|could i|will i|what|where|how)\b/i.test(t)
  const predicates = STATE_PREDICATE_RE.test(t)
  if (!questionish && !predicates) return false
  /* A predicate hit alone (e.g. "big week ahead") is not enough; require the
   * ask to be a question OR one of the strong state forms. */
  return predicates || /\b(?:am i|are we|do i|can i|should i|did i)\b/i.test(t)
}

/** Domain inference from the ask's semantics — the source set an answer needs,
 * before any availability filtering. */
export function inferAssessmentDomains(text: string): AssessmentDomain[] {
  const t = text.toLowerCase()
  const domains = new Set<AssessmentDomain>()

  const money = /\b(?:afford|cost|costs|expensive|budget|spend(?:ing)?|money|cash|price|prices|\$\d|cheaper|too much|room (?:this|left)|runway|set aside|savings|enough (?:for|to spend|left)|left over|overdraw|stretch(?:ing)? (?:to|for))\b/
  const schedule = /\b(?:ready|readiness|collide|conflict|double.?book|realistic|busy|week|day|schedule|calendar|tomorrow|tonight|today|morning|afternoon|free|timing|prepared|set for)\b/
  const obligations = /\b(?:forget(?:ting)?|forgot|missed|missing|miss anything|owe|owed|waiting on|waiting for|follow.?up|follow up|reply|replied|unanswered|behind on|owe anyone|dropped|slip(?:ping)?|forgotten|left)\b/
  const planState = /\b(?:on track|track|launch|project|milestone|deadline|blocking|blocked|behind|progress|accomplish(?:ed)?|done this|finish(?:ed)?|remaining|left to do|still need|next up|what'?s left)\b/
  const worry = /\b(?:worry|worried|concern(?:ed)?|risk(?:s)?|problem(?:s)?|wrong|attention)\b/

  if (money.test(t)) domains.add('money')
  if (schedule.test(t)) domains.add('calendar')
  if (obligations.test(t)) {
    domains.add('mail')
    domains.add('commitments')
  }
  if (planState.test(t)) {
    domains.add('plans')
    if (!domains.has('calendar')) domains.add('calendar')
  }
  if (worry.test(t)) {
    domains.add('calendar')
    domains.add('mail')
  }

  /* Readiness/forgetting/collision asks are cross-domain by nature: the
   * evidence that settles them is spread across schedule, correspondence, and
   * obligations. Add the missing legs rather than answering from one source. */
  const readiness = /\b(?:ready|prepared|set for|all set)\b/.test(t)
  if (readiness || /\bforget(?:ting)?\b|\bmiss(?:ed)?\b/.test(t)) {
    domains.add('calendar')
    domains.add('mail')
    domains.add('commitments')
  }
  if (/\b(?:week|launch|project|accomplish(?:ed)?|on track)\b/.test(t)) domains.add('plans')

  return [...domains]
}

/** Offline-safe assessment decision. The model classifier may refine this when
 * reachable; this is the floor the routing must never fall below. */
export function assessOffline(text: string): AssessmentPlan {
  if (!assessmentCandidates(text)) return { assessment: false, domains: [], reason: 'not_candidate' }
  const domains = inferAssessmentDomains(text)
  if (!domains.length) domains.push('calendar', 'mail')
  return { assessment: true, domains, reason: 'state_evaluation' }
}

/** Tool names a domain maps to, intersected with what is actually available. */
const DOMAIN_SOURCES: Record<AssessmentDomain, string[]> = {
  calendar: ['calendar', 'maps'],
  mail: ['gmail'],
  money: ['spending_overview', 'logging'],
  plans: ['plan'],
  commitments: ['plan', 'reminders', 'gmail'],
  contacts: ['contacts'],
  drive: ['drive'],
}

export interface EvidenceContext {
  available: string[]
  /** Standing rules from typed memory (constraint values + caps). */
  constraints?: Array<{ value: string; capDollars: number | null }>
  /** Rendered active-plan state, when one exists. */
  planBlock?: string | null
}

/** The evidence plan handed to the tool loop as one system note. It names the
 * MINIMUM source set for the ask's domains and the cost discipline. */
export function evidencePlanNote(plan: AssessmentPlan, ctx: EvidenceContext): string | null {
  if (!plan.assessment) return null
  const CAPABILITY_SOURCES = new Set(['plan', 'spending_overview', 'contacts', 'reminders'])
  const sources: string[] = []
  for (const d of plan.domains) {
    for (const s of DOMAIN_SOURCES[d]) {
      if (s === 'logging') continue
      const usableHere = CAPABILITY_SOURCES.has(s) || ctx.available.includes(s)
      if (usableHere && !sources.includes(s)) sources.push(s)
    }
  }
  const usable = sources
  const lines = [
    'ASSESSMENT TURN — evidence before verdict. The user is asking you to evaluate a state, not to do one action.',
    `Minimum evidence for this ask: ${plan.domains.join(', ')}. Sources to read first (only these): ${usable.join(', ') || 'none available'}.`,
    'Call the minimum sources, then stop. Do NOT call drive, web, or maps unless the ask names them or the read sources expose a concrete need.',
    'Answer with: what you checked and what it shows; then what remains unchecked or unknown, named as such. Never imply a source was read when it was not; a partial read is stated as partial.',
  ]
  if (plan.domains.includes('money')) {
    const caps = (ctx.constraints || []).filter((c) => c.capDollars !== null)
    lines.push(
      `Money: spending_overview carries ONLY what the user logged or approved with Alpha — never bank data. ` +
      (caps.length ? `Standing constraints in force: ${caps.map((c) => `${c.value} (cap $${c.capDollars})`).join('; ')}. ` : '') +
      'Any affordability statement must be phrased against logged spend and the standing budget ("based on what you\'ve logged…"), and must name what is missing (income, bank balances, upcoming bills) when that data is not available.',
    )
  }
  if (plan.domains.includes('plans') || plan.domains.includes('commitments')) {
    lines.push(ctx.planBlock ? `Plan state (server, authoritative): ${ctx.planBlock.split('\n').join(' | ')}` : 'No active durable plan exists; obligations then come from mail and reminders.')
  }
  return lines.join('\n')
}

/** Minimum-evidence check before a confident conclusion. `ran` is which
 * source domains the turn actually read (from the evidence ledger). */
export function minimumEvidenceCheck(plan: AssessmentPlan, ran: AssessmentDomain[]): { ok: boolean; missing: AssessmentDomain[] } {
  if (!plan.assessment) return { ok: true, missing: [] }
  const missing = plan.domains.filter((d) => !ran.includes(d))
  /* Money and plans are the two domains where a confident conclusion without
   * evidence is a fabrication, not a caveat: thresholds are deliberate. */
  const critical: AssessmentDomain[] = ['money', 'plans']
  const missingCritical = missing.filter((d) => critical.includes(d))
  return { ok: missingCritical.length === 0, missing }
}

/** Deterministic hedge for an assessment that ran without its critical
 * evidence: appended when the reply does not already admit the gap. */
export function assessmentHedge(plan: AssessmentPlan, missing: AssessmentDomain[]): string | null {
  if (!plan.assessment || !missing.length) return null
  const names = missing.map((d) => d === 'mail' ? 'your inbox' : d === 'money' ? 'your logged spending' : d === 'plans' ? 'your plan state' : d).join(', ')
  return `What I have not checked: ${names} — so treat the above as partial until that is read.`
}

/** True when the reply already admits an unchecked source, so the hedge would
 * be redundant. */
export function replyAdmitsGap(reply: string): boolean {
  return /\b(?:haven'?t checked|have not checked|not checked|didn'?t check|did not check|based on what you'?ve logged|only what you logged|couldn'?t read|could not read|no visibility|can'?t see your|unverified|not verified)\b/i.test(reply)
}
