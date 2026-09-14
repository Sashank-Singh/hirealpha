/**
 * Visual-choice rendering (beat-instinct plan, workstream 2 "Visual choice
 * engine", Phase 1 "visual option schema and iMessage rendering").
 *
 * iMessage cannot show a grid, so a choice card is a numbered text block that
 * still carries the whole decision surface: price with taxes/fees status, the
 * one-line reason tied to the user, material tradeoffs, cancellation terms,
 * source label + freshness, and the link. The mini-app shows the same fields
 * structured; the text here is the iMessage projection of one truth — never a
 * second source of it.
 *
 * Selection grammar is deliberately dumb: reply a number (or a small ordinal
 * word set). Anything else returns null so the conversational classifier —
 * not string matching — decides what a free-form reply means (no-regex rule).
 */
import type { TaskOption } from './taskContract'

const ORDINAL_WORDS: Record<string, number> = {
  first: 1, second: 2, third: 3, fourth: 4, fifth: 5, sixth: 6, seventh: 7, eighth: 8, ninth: 9, tenth: 10,
}

function formatPrice(option: TaskOption): string | null {
  if (option.price_cents == null) return null
  const dollars = (option.price_cents / 100).toLocaleString('en-US', {
    minimumFractionDigits: option.price_cents % 100 === 0 ? 0 : 2,
    maximumFractionDigits: 2,
  })
  const symbol = option.currency === 'USD' || !option.currency ? '$' : `${option.currency} `
  const taxNote = option.taxes_included === true ? ' incl. taxes' : option.taxes_included === false ? ' + taxes/fees' : ''
  return `${symbol}${dollars}${taxNote}`
}

function ageLabel(freshness: string, now: Date): string {
  const then = Date.parse(freshness)
  if (!Number.isFinite(then)) return 'time unknown'
  const minutes = Math.max(0, Math.round((now.getTime() - then) / 60_000))
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  return `${Math.round(hours / 24)}d ago`
}

/** One option -> one iMessage card. index is the 1-based number the user replies with. */
export function renderOptionCard(option: TaskOption, index: number, now: Date): string {
  const lines: string[] = []
  const head = [`${index}. ${option.title}`]
  const price = formatPrice(option)
  if (price) head.push(price)
  if (option.available === false) head.push('(sold out)')
  lines.push(head.join(' — '))
  if (option.reason) lines.push(`   ${option.reason}`)
  const notes: string[] = []
  if (option.cancellation) notes.push(option.cancellation)
  if (option.tradeoffs) notes.push(option.tradeoffs)
  if (option.sponsored) notes.push('sponsored')
  if (notes.length) lines.push(`   ${notes.join(' · ')}`)
  const source = option.source_label || new URL(option.source_url ?? 'https://unknown').host
  lines.push(`   ${source} · checked ${ageLabel(option.freshness ?? '', now)}`)
  if (option.source_url) lines.push(`   ${option.source_url}`)
  return lines.join('\n')
}

export type RenderOptions = { now?: Date }

/** The numbered card set with the reply grammar line. Empty options -> null. */
export function renderOptionCards(options: TaskOption[], heading: string, input: RenderOptions = {}): string | null {
  const live = options.filter((o) => !o.rejected)
  if (live.length === 0 || !heading.trim()) return null
  const now = input.now ?? new Date()
  const cards = live.map((option, i) => renderOptionCard(option, i + 1, now))
  return [`Here's what I found — ${heading}:`, ...cards, 'Reply a number to pick one, or ask me to compare.']
    .join('\n')
    .slice(0, 3500)
}

/**
 * Deterministic selection grammar: a bare number or one of ten ordinal words,
 * against the exact same live ordering the card showed. Anything else returns
 * null — the classifier, not this function, owns free-form replies.
 */
export function selectionFromReply(reply: string, options: TaskOption[]): string | null {
  const live = options.filter((o) => !o.rejected)
  if (live.length === 0) return null
  const trimmed = reply.trim().toLowerCase()
  if (!trimmed) return null
  const word = ORDINAL_WORDS[trimmed]
  if (word !== undefined) return live[word - 1]?.id ?? null
  // Bare digits only - no regex anywhere near user prose, even for structure.
  if (![...trimmed].every((character) => character >= '0' && character <= '9')) return null
  const index = Number(trimmed)
  if (!Number.isInteger(index) || index < 1 || index > live.length) return null
  return live[index - 1]?.id ?? null
}
