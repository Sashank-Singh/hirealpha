/**
 * P2 flagship view model (beat-instinct plan, workstream 6 "the trip
 * mini-app"): turn validated trip legs + a task projection into the single
 * structured object the approved component system renders — option cards,
 * timeline, documents, approval blockers, change history, monitoring
 * controls — without ever scraping text back out of iMessage.
 *
 * Doctrine inherited from trip.ts and the task contract: pure functions, an
 * injected clock, no regex on prose, deterministic ordering, and NOTHING
 * invented. Every field is traceable to a leg or a projection field; where
 * the data is unknown the view says so with null / 0 / empty arrays, never
 * placeholders. `renderTripText` is the iMessage projection of this same
 * object — one truth, two surfaces. `diffTripViews` lets the mini-app apply
 * an event to its current screen without rebuilding from scratch.
 *
 * Conventions (documented, tested):
 *   - Legs must already be validated (parseTripLegs/validateTripLeg); a junk
 *     start_at throws inside sortItinerary, same as every other trip.ts
 *     consumer.
 *   - dayKey is the UTC calendar date of the leg's start instant
 *     (YYYY-MM-DD), so a timezone-crossing flight groups by UTC, never by
 *     local wall-clock.
 *   - Per-leg labels reuse renderItineraryLines for exactly that leg and are
 *     built WITHOUT a `now`, so labels are stable across rebuilds and the
 *     diff reports real changes, not a leg tipping over into "· past".
 *   - A leg is `confirmed` when it carries a non-blank confirmation_ref.
 */
import type { TaskProjection } from './taskContract'
import { nextCheckDue } from './monitoring'
import {
  findConflicts,
  renderItineraryLines,
  sortItinerary,
  type Conflict,
  type ConflictReason,
  type TripLeg,
} from './trip'

/* ------------------------------------------------------------------- types */

export type TripStatus = 'planning' | 'booked' | 'conflicts' | 'needs-attention'

export type TripTimelineLegView = {
  id: string
  /** UTC calendar date of the start instant, YYYY-MM-DD. */
  dayKey: string
  /** Exactly what renderItineraryLines shows for this leg alone. */
  label: string
  confirmed: boolean
  /** Legs without a price contribute 0 — unknown is not hidden, it is zero-summed. */
  price_cents: number
  /** The leg's own booking link when it carries one; never a fabricated source. */
  sourceUrl: string | null
  /** The leg's confirmation ref, or null when it has none. */
  ref: string | null
}

export type TripDayGroup = { dayKey: string; legs: TripTimelineLegView[] }

export type TripConflictView = {
  legIds: [string, string]
  reason: ConflictReason
  /** Human label for the severity chip; generated copy, never parsed back. */
  severityLabel: string
  /** trip.ts's deterministic explanation, carried through for the row body. */
  note: string
  gapMinutes: number
}

export type TripBudgetView = {
  /** Sum of priced legs; unpriced legs add 0. */
  totalCents: number
  /** Honest split: only legs whose own confirmation ref is present. */
  confirmedCents: number
  /** Single currency of the priced legs, 'mixed', or null when unknown. */
  currency: string | null
}

export type TripDocumentView = { label: string; value: string }

export type TripBlocker =
  | { kind: 'approval'; text: string }
  | { kind: 'credential'; label: string }
  | { kind: 'payment'; label: string }
  | { kind: 'human'; label: string }
  | { kind: 'proof'; text: string }

export type TripMonitoringView = {
  /** SCHEDULED | CHECKING | DEGRADED (monitoring.ts's live states). */
  active: boolean
  nextCheckAt: string | null
  /** Computed by real nextCheckDue(); junk (bad now, bad timestamp) is false. */
  due: boolean
}

export type TripView = {
  title: string
  status: TripStatus
  timeline: TripDayGroup[]
  conflicts: TripConflictView[]
  budget: TripBudgetView
  documents: TripDocumentView[]
  blockers: TripBlocker[]
  monitoring: TripMonitoringView
}

export type BuildTripViewOptions = {
  /** Injected clock: epoch-free ISO string or Date, used only for monitoring. */
  now: string | Date
}

export const TRIP_TEXT_CAP = 3200

const ACTIVE_MONITOR_STATES: readonly string[] = ['SCHEDULED', 'CHECKING', 'DEGRADED']

const SEVERITY_LABELS: Record<ConflictReason, string> = {
  teleport: 'Impossible — wrong city',
  overlap: 'Double-booked',
  'tight-connection': 'Tight connection',
}

/* ----------------------------------------------------------------- helpers */

function refOf(leg: TripLeg): string | null {
  const ref = typeof leg.confirmation_ref === 'string' ? leg.confirmation_ref.trim() : ''
  return ref === '' ? null : ref
}

function confirmedLeg(leg: TripLeg): boolean {
  return refOf(leg) !== null
}

/** UTC calendar day of the start instant; throws with sortItinerary on junk. */
function utcDayKey(leg: TripLeg): string {
  return new Date(Date.parse(leg.start_at)).toISOString().slice(0, 10)
}

function needsAttention(projection: TaskProjection): boolean {
  if (projection.state === 'NEEDS_RECONCILIATION' || projection.state === 'HUMAN_TAKEOVER') return true
  return projection.state === 'VERIFYING' && projection.verification?.passed === false
}

function decideStatus(legs: readonly TripLeg[], projection: TaskProjection, conflicts: readonly unknown[]): TripStatus {
  if (conflicts.length > 0) return 'conflicts'
  if (needsAttention(projection)) return 'needs-attention'
  if (legs.length > 0 && legs.every(confirmedLeg)) return 'booked'
  return 'planning'
}

function buildBudget(sorted: readonly TripLeg[]): TripBudgetView {
  let totalCents = 0
  let confirmedCents = 0
  const codes = new Set<string>()
  let pricedWithoutCurrency = false
  for (const leg of sorted) {
    const cents = leg.price_cents ?? 0
    totalCents += cents
    if (cents > 0 || leg.price_cents !== undefined) {
      if (typeof leg.currency === 'string' && leg.currency !== '') codes.add(leg.currency)
      else pricedWithoutCurrency = true
    }
    if (confirmedLeg(leg)) confirmedCents += cents
  }
  let currency: string | null = null
  if (codes.size > 1) currency = 'mixed'
  else if (codes.size === 1 && !pricedWithoutCurrency) currency = [...codes][0] ?? null
  return { totalCents, confirmedCents, currency }
}

/** Unique confirmation refs across the itinerary, one row per ref code. */
function buildDocuments(sorted: readonly TripLeg[]): TripDocumentView[] {
  const byValue = new Map<string, TripDocumentView>()
  for (const leg of sorted) {
    const ref = refOf(leg)
    if (ref === null) continue
    if (!byValue.has(ref)) byValue.set(ref, { label: `Confirmation ${ref}`, value: ref })
  }
  return [...byValue.values()].sort((a, b) => (a.value < b.value ? -1 : a.value > b.value ? 1 : 0))
}

function mapConflict(conflict: Conflict): TripConflictView {
  return {
    legIds: [conflict.leg_ids[0], conflict.leg_ids[1]],
    reason: conflict.reason,
    severityLabel: SEVERITY_LABELS[conflict.reason],
    note: conflict.note,
    gapMinutes: conflict.gap_minutes,
  }
}

/** Outstanding handoff artifacts = `handoff:<kind>` without a later `handoff_resumed:<kind>`. */
function handoffBlockers(projection: TaskProjection): TripBlocker[] {
  const resumed = new Set<string>()
  for (const artifact of projection.artifacts) {
    if (artifact.kind.startsWith('handoff_resumed:')) resumed.add(artifact.kind.slice('handoff_resumed:'.length))
  }
  const seen = new Set<string>()
  const blockers: TripBlocker[] = []
  for (const artifact of projection.artifacts) {
    if (!artifact.kind.startsWith('handoff:')) continue
    const sub = artifact.kind.slice('handoff:'.length)
    if (sub === '' || resumed.has(sub)) continue
    if (seen.has(sub)) continue
    seen.add(sub)
    const ref = typeof artifact.ref === 'string' && artifact.ref.trim() !== '' ? artifact.ref.trim() : null
    const label = ref === null ? sub : `${sub} (${ref})`
    if (sub === 'credential') blockers.push({ kind: 'credential', label })
    else if (sub === 'payment') blockers.push({ kind: 'payment', label })
    else blockers.push({ kind: 'human', label })
  }
  return blockers
}

function buildBlockers(projection: TaskProjection): TripBlocker[] {
  const blockers: TripBlocker[] = []
  if (projection.state === 'WAITING_FOR_AUTHORITY') {
    const pending = projection.grants.find((grant) => grant.status === 'requested')
    blockers.push({
      kind: 'approval',
      text: pending
        ? `Waiting on your approval to proceed (grant ${pending.grant_id}).`
        : 'Waiting on your approval to proceed.',
    })
  } else if (projection.state === 'PLANNING_ACTION' && projection.selected_option_id !== null) {
    // Selected-but-not-executed: the plan waits on the go-ahead, not on us.
    const chosen = projection.options.find((option) => option.id === projection.selected_option_id)
    const title = chosen ? chosen.title : projection.selected_option_id
    blockers.push({ kind: 'approval', text: `Selected "${title}" — needs the go-ahead to execute.` })
  }
  blockers.push(...handoffBlockers(projection))
  if (projection.state === 'VERIFYING' && projection.verification?.passed === false) {
    const reason = projection.failure?.reason_code ?? null
    blockers.push({
      kind: 'proof',
      text: reason === null ? 'Verification failed — independent proof still needed.' : `Verification failed (${reason}) — independent proof still needed.`,
    })
  }
  return blockers
}

function buildMonitoring(projection: TaskProjection, now: string | Date): TripMonitoringView {
  let due = false
  try {
    due = nextCheckDue(projection, now).due
  } catch {
    due = false // junk `now` or junk timestamps never crash the view.
  }
  return {
    active: ACTIVE_MONITOR_STATES.includes(projection.monitor_state),
    nextCheckAt: projection.monitor_next_check_at ?? null,
    due,
  }
}

/* -------------------------------------------------------------- build view */

export function buildTripView(
  legs: readonly TripLeg[],
  projection: TaskProjection,
  options: BuildTripViewOptions,
): TripView {
  const sorted = sortItinerary(legs)
  const conflicts = findConflicts(sorted).map(mapConflict)

  const timeline: TripDayGroup[] = []
  let currentGroup: TripDayGroup | null = null
  for (const leg of sorted) {
    const dayKey = utcDayKey(leg)
    const view: TripTimelineLegView = {
      id: leg.id,
      dayKey,
      label: renderItineraryLines([leg])[0],
      confirmed: confirmedLeg(leg),
      price_cents: leg.price_cents ?? 0,
      sourceUrl: typeof leg.booking_url === 'string' && leg.booking_url.trim() !== '' ? leg.booking_url.trim() : null,
      ref: refOf(leg),
    }
    if (currentGroup !== null && currentGroup.dayKey === dayKey) currentGroup.legs.push(view)
    else {
      currentGroup = { dayKey, legs: [view] }
      timeline.push(currentGroup)
    }
  }

  return {
    title: projection.request,
    status: decideStatus(sorted, projection, conflicts),
    timeline,
    conflicts,
    budget: buildBudget(sorted),
    documents: buildDocuments(sorted),
    blockers: buildBlockers(projection),
    monitoring: buildMonitoring(projection, options.now),
  }
}

/* ------------------------------------------------------------ text surface */

const DAY_HEADER_FORMAT = new Intl.DateTimeFormat('en-US', {
  weekday: 'short',
  month: 'short',
  day: 'numeric',
  timeZone: 'UTC',
})

function money(cents: number, currency: string | null): string {
  const dollars = (cents / 100).toLocaleString('en-US', {
    minimumFractionDigits: cents % 100 === 0 ? 0 : 2,
    maximumFractionDigits: 2,
  })
  if (currency === null || currency === 'USD' || currency === 'mixed') return `$${dollars}`
  return `${currency} ${dollars}`
}

/**
 * The iMessage fallback for the same view object: day headers, the timeline's
 * own leg labels, one budget line, one conflicts line, one blockers line.
 * Capped at TRIP_TEXT_CHAR_CAP, always cut at the last newline under the cap.
 */
export function renderTripText(view: TripView): string {
  const lines: string[] = [`${view.title} · ${view.status}`]
  for (const group of view.timeline) {
    const start = Date.parse(`${group.dayKey}T00:00:00Z`)
    lines.push(Number.isFinite(start) ? DAY_HEADER_FORMAT.format(new Date(start)) : group.dayKey)
    for (const leg of group.legs) lines.push(leg.label)
  }
  let budgetLine = `Total ${money(view.budget.totalCents, view.budget.currency)} · booked ${money(view.budget.confirmedCents, view.budget.currency)}`
  if (view.budget.currency === 'mixed') budgetLine += ' · mixed currencies'
  lines.push(budgetLine)
  if (view.conflicts.length > 0) {
    lines.push(`Conflicts: ${view.conflicts.length} — ${view.conflicts.map((conflict) => conflict.severityLabel).join(', ')}`)
  }
  if (view.blockers.length > 0) {
    lines.push(`Needs you: ${view.blockers.map((blocker) => ('text' in blocker ? blocker.text : blocker.label)).join('; ')}`)
  }
  const text = lines.join('\n')
  if (text.length <= TRIP_TEXT_CAP) return text
  const cut = text.slice(0, TRIP_TEXT_CAP)
  const newline = cut.lastIndexOf('\n')
  return newline > 0 ? cut.slice(0, newline) : cut
}

/* --------------------------------------------------------------- diff view */

export type TripViewDiff = {
  added: string[]
  removed: string[]
  /** Legs present in both whose label, confirmed flag, or price moved. */
  changed: string[]
  /** after.conflicts.length - before.conflicts.length. */
  conflictDelta: number
  statusChanged: { from: TripStatus; to: TripStatus } | null
}

function allLegs(view: TripView): TripTimelineLegView[] {
  return view.timeline.flatMap((group) => group.legs)
}

/**
 * Pure delta between two builds — the mini-app uses it to patch its screen
 * from an event stream instead of re-rendering the world from iMessage.
 */
export function diffTripViews(before: TripView, after: TripView): TripViewDiff {
  const beforeById = new Map(allLegs(before).map((leg) => [leg.id, leg]))
  const afterById = new Map(allLegs(after).map((leg) => [leg.id, leg]))
  const added = allLegs(after).filter((leg) => !beforeById.has(leg.id)).map((leg) => leg.id)
  const removed = allLegs(before).filter((leg) => !afterById.has(leg.id)).map((leg) => leg.id)
  const changed: string[] = []
  for (const leg of allLegs(after)) {
    const was = beforeById.get(leg.id)
    if (was === undefined) continue
    if (was.label !== leg.label || was.confirmed !== leg.confirmed || was.price_cents !== leg.price_cents) {
      changed.push(leg.id)
    }
  }
  return {
    added,
    removed,
    changed,
    conflictDelta: after.conflicts.length - before.conflicts.length,
    statusChanged: before.status === after.status ? null : { from: before.status, to: after.status },
  }
}
