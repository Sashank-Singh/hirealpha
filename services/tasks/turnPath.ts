/**
 * P1 turn path — "selection → executor" glue (beat-instinct plan, workstream 2
 * "Visual choice engine", Phase 1). The live turn engine
 * (spectrum/shared/runHireTurn.ts, wired later by the human) composes these;
 * this module never reimplements the store, the cards, the pricing math, or
 * the choice turns — it sequences them.
 *
 * Doctrine enforced here:
 *   - options_published is write-time law (taskContract.normalizeOptionCard).
 *     Rather than let a bad research hit throw mid-write, offerChoices drops
 *     any candidate that cannot form a legal card (no https source_url, no
 *     reason, unparseable freshness, malformed price/currency) and reports
 *     why. Provenance is never fabricated.
 *   - Cross-vendor duplicates are collapsed by normalized host+path using
 *     plain string operations — zero regex anywhere near user/research prose.
 *     The cheaper card wins.
 *   - interpretChoice is pure: it delegates to the deterministic selection
 *     grammar (choiceCards.selectionFromReply) and the freshness gate
 *     (choicePricing.cardIsFresh). Any free-form prose comes back as
 *     'ask-classifier' — this path never guesses at meaning.
 *   - selectionNextStep decides by an explicit `requiredAuthority` flag, not
 *     by sniffing card text for "purchase-shaped" wording.
 */
import type { SQL } from 'bun'
import type { TaskOption, TaskProjection } from './taskContract'
import { publishOptions } from './choiceTurns'
import { selectionFromReply } from './choiceCards'
import { cardIsFresh } from './choicePricing'

/* ------------------------------------------------------------- offerChoices */

/** A raw research hit: typed loosely on purpose — research output is untrusted input. */
export type ResearchCandidate = {
  title?: string | null
  reason?: string | null
  source_url?: string | null
  freshness?: string | number | null
  price_cents?: number | null
  currency?: string | null
  image_ref?: string | null
  cancellation?: string | null
  tradeoffs?: string | null
  available?: boolean | null
  sponsored?: boolean | null
}

export type DroppedCandidate = { title: string; why: string }

export type OfferChoicesInput = {
  userId: string
  taskId: string
  heading: string
  candidates: ResearchCandidate[]
  now?: Date
}

export type OfferChoicesResult = {
  /** The iMessage card text, or null when nothing legal could be published. */
  rendered: string | null
  published: boolean
  dropped: DroppedCandidate[]
}

function cleanText(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed === '' ? null : trimmed
}

/** Structural only: ISO strings, or a finite epoch-ms number. No string sniffing. */
function normalizeFreshness(value: unknown): string | null {
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return null
    const date = new Date(value)
    return Number.isFinite(date.getTime()) ? date.toISOString() : null
  }
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  if (trimmed === '') return null
  return Number.isFinite(Date.parse(trimmed)) ? trimmed : null
}

/**
 * Host + path identity without regex: lowercase host, strip a leading "www.",
 * strip trailing slashes from the path. Query and hash are ignored — the same
 * page reached through two affiliate query strings is one offer, not two.
 */
function sourceIdentity(url: URL): string | null {
  let host = url.hostname.toLowerCase()
  if (host.startsWith('www.')) host = host.slice(4)
  if (host === '') return null
  let path = url.pathname
  while (path.length > 1 && path.endsWith('/')) path = path.slice(0, -1)
  return `${host}${path}`
}

type SanitizedCandidate = {
  core: Omit<TaskOption, 'id'>
  identity: string
  priceForDedup: number
}

/** Drop, never throw: any field the write-time contract would reject on. */
function sanitizeCandidate(candidate: ResearchCandidate): { ok: SanitizedCandidate } | { why: string } {
  const title = cleanText(candidate.title)
  if (title === null) return { why: 'missing-title' }
  const reason = cleanText(candidate.reason)
  if (reason === null) return { why: 'missing-reason' }
  const sourceUrl = cleanText(candidate.source_url)
  if (sourceUrl === null) return { why: 'missing-source-url' }
  if (!sourceUrl.startsWith('https://')) return { why: 'source-url-not-https' }
  let url: URL
  try {
    url = new URL(sourceUrl)
  } catch {
    return { why: 'source-url-unparseable' }
  }
  if (url.protocol !== 'https:') return { why: 'source-url-not-https' }
  const identity = sourceIdentity(url)
  if (identity === null) return { why: 'source-url-unparseable' }
  const freshness = normalizeFreshness(candidate.freshness)
  if (freshness === null) return { why: 'missing-or-unparseable-freshness' }

  const core: Omit<TaskOption, 'id'> = {
    title,
    reason,
    source_url: sourceUrl,
    freshness,
    available: candidate.available !== false,
  }
  let priceForDedup = Number.POSITIVE_INFINITY
  if (candidate.price_cents !== undefined && candidate.price_cents !== null) {
    if (!Number.isInteger(candidate.price_cents) || candidate.price_cents < 0) {
      return { why: 'invalid-price-cents' }
    }
    core.price_cents = candidate.price_cents
    priceForDedup = candidate.price_cents
  }
  if (candidate.currency !== undefined && candidate.currency !== null) {
    const currency = typeof candidate.currency === 'string' ? candidate.currency.trim().toUpperCase() : ''
    if (currency.length !== 3) return { why: 'invalid-currency' }
    core.currency = currency
  }
  const imageRef = cleanText(candidate.image_ref)
  if (imageRef !== null) core.image_ref = imageRef
  const cancellation = cleanText(candidate.cancellation)
  if (cancellation !== null) core.cancellation = cancellation
  const tradeoffs = cleanText(candidate.tradeoffs)
  if (tradeoffs !== null) core.tradeoffs = tradeoffs
  if (candidate.sponsored === true) core.sponsored = true
  return { ok: { core, identity, priceForDedup } }
}

/**
 * Research results -> numbered cards, in one call. Invalid candidates are
 * dropped (with reasons), duplicates across vendors collapse to the cheapest,
 * and only a fully contract-legal set reaches choiceTurns.publishOptions.
 * When nothing legal survives, the turn degrades to {rendered:null,
 * published:false} instead of crashing; state-machine errors from
 * publishOptions (wrong state, not found) still propagate so the caller can
 * catch them precisely — choiceTurns re-exports those classes.
 */
export async function offerChoices(sql: SQL, input: OfferChoicesInput): Promise<OfferChoicesResult> {
  const dropped: DroppedCandidate[] = []
  const kept: SanitizedCandidate[] = []
  const byIdentity = new Map<string, number>()

  for (const candidate of Array.isArray(input.candidates) ? input.candidates : []) {
    const title = typeof candidate?.title === 'string' && candidate.title.trim() !== '' ? candidate.title : '(untitled)'
    const result = sanitizeCandidate(candidate)
    if ('why' in result) {
      dropped.push({ title, why: result.why })
      continue
    }
    const existingIndex = byIdentity.get(result.ok.identity)
    if (existingIndex === undefined) {
      byIdentity.set(result.ok.identity, kept.length)
      kept.push(result.ok)
      continue
    }
    const incumbent = kept[existingIndex]
    if (result.ok.priceForDedup < incumbent.priceForDedup) {
      // Cheaper reprint wins; the pricier vendor copy is dropped as a duplicate.
      dropped.push({ title: incumbent.core.title, why: 'duplicate-source-url' })
      kept[existingIndex] = result.ok
    } else {
      dropped.push({ title: result.ok.core.title, why: 'duplicate-source-url' })
    }
  }

  if (kept.length === 0) {
    return { rendered: null, published: false, dropped }
  }

  const options: TaskOption[] = kept.map((candidate, i) => ({ id: `opt-${i + 1}`, ...candidate.core }))
  const rendered = await publishOptions(sql, {
    userId: input.userId,
    taskId: input.taskId,
    heading: input.heading,
    options,
    ...(input.now !== undefined ? { now: input.now } : {}),
  })
  return { rendered, published: rendered !== null, dropped }
}

/* ---------------------------------------------------------- interpretChoice */

export type ChoiceInterpretation =
  | { kind: 'choose'; optionId: string }
  | { kind: 'stale'; optionId: string }
  | { kind: 'ask-classifier' }

/**
 * Pure reply interpretation over an already-loaded projection: the
 * deterministic grammar decides numbers/ordinals, the freshness gate decides
 * whether the chosen price is still live. Every other reply — comparison
 * requests, objections, changes of mind — returns 'ask-classifier' so the
 * conversational classifier owns prose. No SQL, no clocks of its own.
 */
export function interpretChoice(
  projection: TaskProjection,
  reply: string,
  opts: { now?: Date; ttlMs?: number } = {},
): ChoiceInterpretation {
  const optionId = selectionFromReply(reply, projection.options)
  if (optionId === null) return { kind: 'ask-classifier' }
  const chosen = projection.options.find((option) => option.id === optionId)
  if (!chosen) return { kind: 'ask-classifier' }
  const now = opts.now ?? new Date()
  if (!cardIsFresh(chosen, now, opts.ttlMs)) return { kind: 'stale', optionId }
  return { kind: 'choose', optionId }
}

/* -------------------------------------------------------- selectionNextStep */

export type NextStepReason = 'unknown-option' | 'sold-out' | 'need-authority'

export type NextStepVerdict = { ready: boolean; reason?: NextStepReason }

/**
 * The executor door, decided without a network or a guess: the card must be
 * live and available, and a purchase-shaped card (a price plus the caller's
 * explicit `requiredAuthority` flag — this function never infers "looks like
 * a payment" from prose) needs a granted authority in the projection.
 */
export function selectionNextStep(
  projection: TaskProjection,
  option: TaskOption,
  opts: { requiredAuthority?: boolean } = {},
): NextStepVerdict {
  const listed = projection.options.find((candidate) => candidate.id === option.id)
  if (!listed || listed.rejected) return { ready: false, reason: 'unknown-option' }
  if (option.available === false) return { ready: false, reason: 'sold-out' }
  const purchaseShaped = opts.requiredAuthority === true && option.price_cents != null
  if (purchaseShaped && !projection.grants.some((grant) => grant.status === 'granted')) {
    return { ready: false, reason: 'need-authority' }
  }
  return { ready: true }
}
