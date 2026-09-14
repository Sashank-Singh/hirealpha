/**
 * Price freshness + reapproval math (beat-instinct plan, workstream 2 exit
 * gate: "price at selection matches checkout within a defined tolerance or
 * triggers reapproval", and the tolerance definition: ZERO undisclosed
 * increase). Pure functions over the validated TaskOption card; no clocks,
 * no I/O — the caller passes `now` and the quoted checkout total.
 */
import type { TaskOption } from './taskContract'

/** A card older than this is an old price pretending to be live. */
export const DEFAULT_CARD_TTL_MS = 15 * 60_000

export function cardIsFresh(option: TaskOption, now: Date, ttlMs: number = DEFAULT_CARD_TTL_MS): boolean {
  if (!option.freshness) return false
  const then = Date.parse(option.freshness)
  if (!Number.isFinite(then)) return false
  const age = now.getTime() - then
  return age >= 0 ? age <= ttlMs : true // clock skew ahead of `now`: treat as fresh, the caller's clock is the problem, not the card
}

export function priceDriftCents(option: TaskOption, quotedCents: number): number | null {
  if (option.price_cents == null || !Number.isFinite(quotedCents)) return null
  return Math.round(quotedCents - option.price_cents)
}

export type ReapprovalVerdict =
  | { reapproval: false }
  | { reapproval: true; reason: 'price-increase' | 'currency-change' | 'price-unknown'; driftCents?: number }

/**
 * Compare the chosen card against the real checkout total. A drop passes
 * (user never needs reapproval to pay less); any undisclosed increase or a
 * currency change stops the run until the user re-chooses. A card without a
 * price can never vouch for the total, so it always needs explicit authority.
 */
export function requiresReapproval(
  option: TaskOption,
  quoted: { totalCents: number; currency?: string | null },
): ReapprovalVerdict {
  if (option.price_cents == null) return { reapproval: true, reason: 'price-unknown' }
  const cardCurrency = (option.currency ?? 'USD').toUpperCase()
  const quotedCurrency = (quoted.currency ?? cardCurrency).toUpperCase()
  if (quotedCurrency !== cardCurrency) return { reapproval: true, reason: 'currency-change' }
  const drift = priceDriftCents(option, quoted.totalCents)
  if (drift == null) return { reapproval: true, reason: 'price-unknown' }
  if (drift > 0) return { reapproval: true, reason: 'price-increase', driftCents: drift }
  return { reapproval: false }
}
