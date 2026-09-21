/**
 * Pure change-response detection for provider-normalized work data.
 *
 * Connectors own fetching and normalization. This module owns the product
 * decision: whether a change deserves an interruption, why it matters now,
 * and which reversible next step to prepare. It deliberately performs no I/O
 * and never sends or mutates external data.
 */

export type CalendarChange = {
  id: string
  title: string
  startsAt: string
  status: 'confirmed' | 'cancelled'
  previousStatus?: 'confirmed' | 'cancelled'
  importance?: number
}

export type AwaitingEmail = {
  threadId: string
  subject: string
  sentAt: string
  lastInboundAt?: string | null
  expectsReply: boolean
  importance?: number
}

export type LinearIssueChange = {
  id: string
  title: string
  dueAt: string
  state: 'backlog' | 'started' | 'completed' | 'cancelled'
  previousDueAt?: string | null
  importance?: number
}

export type ChangeResponseInput = {
  now: string | number | Date
  calendars?: readonly CalendarChange[]
  emails?: readonly AwaitingEmail[]
  issues?: readonly LinearIssueChange[]
}

export type ChangeResponsePreferences = {
  /** Minimum time without an inbound reply before an email is stale. */
  unansweredAfterMs?: number
  /** Suppress items below this score. Defaults to 45. */
  minimumScore?: number
  /** 0..1 affinity learned from prior approvals/dismissals, by signal kind. */
  affinity?: Partial<Record<ChangeResponseKind, number>>
  /** Entity keys shown recently. They remain detectable, but cost more to interrupt. */
  recentlyNotified?: ReadonlySet<string>
}

export type ChangeResponseKind = 'calendar_cancelled' | 'email_unanswered' | 'issue_slipping'

export type ChangeResponseCandidate = {
  kind: ChangeResponseKind
  entityKey: string
  title: string
  reason: string
  evidence: string
  proposedAction: string
  score: number
  factors: {
    urgency: number
    confidence: number
    impact: number
    affinity: number
    interruptionCost: number
  }
}

const DAY = 24 * 60 * 60_000
const DEFAULT_UNANSWERED_AFTER = 3 * DAY

function nowMs(value: ChangeResponseInput['now']): number {
  const result = value instanceof Date ? value.getTime() : typeof value === 'number' ? value : Date.parse(value)
  if (!Number.isFinite(result)) throw new Error('detectChangeResponses: now must be a valid timestamp.')
  return result
}

function timestamp(value: string): number | null {
  const result = Date.parse(value)
  return Number.isFinite(result) ? result : null
}

function unit(value: number | undefined, fallback: number): number {
  if (!Number.isFinite(value)) return fallback
  return Math.max(0, Math.min(1, value as number))
}

function score(factors: ChangeResponseCandidate['factors']): number {
  // Confidence gates the upside: weak evidence should not become noisy merely
  // because an item is important. Cost is subtracted after positive value.
  const positive = factors.confidence * (
    factors.urgency * 0.35 + factors.impact * 0.35 + factors.affinity * 0.3
  )
  return Math.max(0, Math.min(100, Math.round((positive - factors.interruptionCost * 0.3) * 100)))
}

function candidate(
  value: Omit<ChangeResponseCandidate, 'score' | 'factors'>,
  rawFactors: Omit<ChangeResponseCandidate['factors'], 'interruptionCost'>,
  prefs: ChangeResponsePreferences,
): ChangeResponseCandidate {
  const factors = {
    ...rawFactors,
    affinity: unit(prefs.affinity?.[value.kind], rawFactors.affinity),
    interruptionCost: prefs.recentlyNotified?.has(value.entityKey) ? 0.8 : 0.1,
  }
  return { ...value, factors, score: score(factors) }
}

/**
 * Detect and rank actionable changes. Malformed provider rows are ignored so
 * one bad connector item cannot suppress the rest of a batch. Exact entity
 * keys dedupe retries, and output order is stable for equal scores.
 */
export function detectChangeResponses(
  input: ChangeResponseInput,
  prefs: ChangeResponsePreferences = {},
): ChangeResponseCandidate[] {
  const at = nowMs(input.now)
  const found: ChangeResponseCandidate[] = []

  for (const event of input.calendars ?? []) {
    const starts = timestamp(event.startsAt)
    if (starts === null || starts <= at || event.status !== 'cancelled' || event.previousStatus !== 'confirmed') continue
    const hours = (starts - at) / 3_600_000
    const entityKey = `calendar:${event.id}:cancelled`
    found.push(candidate({
      kind: 'calendar_cancelled', entityKey, title: event.title,
      reason: `${event.title} was cancelled ${hours <= 24 ? 'within the next day' : 'before it starts'}.`,
      evidence: `Calendar status changed from confirmed to cancelled; starts ${new Date(starts).toISOString()}.`,
      proposedAction: 'Review the freed time and prepare a revised day plan.',
    }, {
      urgency: hours <= 6 ? 1 : hours <= 24 ? 0.85 : hours <= 72 ? 0.6 : 0.35,
      confidence: 1, impact: unit(event.importance, 0.65), affinity: 0.65,
    }, prefs))
  }

  const unansweredAfter = Math.max(60_000, prefs.unansweredAfterMs ?? DEFAULT_UNANSWERED_AFTER)
  for (const email of input.emails ?? []) {
    const sent = timestamp(email.sentAt)
    const inbound = email.lastInboundAt ? timestamp(email.lastInboundAt) : null
    if (sent === null || sent > at || !email.expectsReply || (inbound !== null && inbound > sent)) continue
    const waiting = at - sent
    if (waiting < unansweredAfter) continue
    const days = Math.floor(waiting / DAY)
    const entityKey = `email:${email.threadId}:unanswered:${email.sentAt}`
    found.push(candidate({
      kind: 'email_unanswered', entityKey, title: email.subject,
      reason: `No reply to “${email.subject}” after ${days} day${days === 1 ? '' : 's'}.`,
      evidence: `Outbound message sent ${new Date(sent).toISOString()} with no newer inbound message.`,
      proposedAction: 'Draft a concise follow-up for review.',
    }, {
      urgency: Math.min(1, 0.45 + (waiting - unansweredAfter) / (7 * DAY)),
      confidence: 0.9, impact: unit(email.importance, 0.55), affinity: 0.7,
    }, prefs))
  }

  for (const issue of input.issues ?? []) {
    if (issue.state === 'completed' || issue.state === 'cancelled') continue
    const due = timestamp(issue.dueAt)
    const previousDue = issue.previousDueAt ? timestamp(issue.previousDueAt) : null
    if (due === null) continue
    const movedLater = previousDue !== null && due - previousDue >= DAY
    const overdue = due < at
    if (!movedLater && !overdue) continue
    const entityKey = `linear:${issue.id}:slipping:${issue.dueAt}`
    const daysLate = overdue ? Math.max(1, Math.ceil((at - due) / DAY)) : 0
    found.push(candidate({
      kind: 'issue_slipping', entityKey, title: issue.title,
      reason: overdue
        ? `${issue.title} is ${daysLate} day${daysLate === 1 ? '' : 's'} overdue.`
        : `${issue.title} moved back by ${Math.round((due - (previousDue as number)) / DAY)} days.`,
      evidence: overdue
        ? `Linear due date ${new Date(due).toISOString()} has passed while the issue is ${issue.state}.`
        : `Linear due date changed from ${new Date(previousDue as number).toISOString()} to ${new Date(due).toISOString()}.`,
      proposedAction: 'Prepare a scope, owner, and deadline check-in.',
    }, {
      urgency: overdue ? Math.min(1, 0.65 + daysLate * 0.07) : 0.55,
      confidence: 1, impact: unit(issue.importance, 0.7), affinity: 0.75,
    }, prefs))
  }

  const threshold = Math.max(0, Math.min(100, prefs.minimumScore ?? 45))
  const unique = new Map<string, ChangeResponseCandidate>()
  for (const item of found) {
    const prior = unique.get(item.entityKey)
    if (!prior || item.score > prior.score) unique.set(item.entityKey, item)
  }
  return [...unique.values()]
    .filter((item) => item.score >= threshold)
    .sort((a, b) => b.score - a.score || a.entityKey.localeCompare(b.entityKey))
}
