import { isBitFactKey, isDurableFactKey, isToneFactKey, constraintDollarCap, kindOfFact, type MemoryFact, type MemoryFactKind } from './memory'

/**
 * Identity facts that must survive every cutoff. These are the facts a
 * conversational turn is broken without — being asked your name after telling
 * it, or being offered pork after saying you don't eat it.
 *
 * The old selector (`buildMemoryBlock`) built a Map and took `.slice(0, 12)`.
 * Map iteration is insertion order, so once more than 12 facts existed the
 * *oldest* twelve were kept and every newly learned fact was silently dropped:
 * the more someone told the hire, the less it remembered of what it just said.
 */
export const ALWAYS_INCLUDE_KEYS = [
  'preferred_name',
  'name',
  'timezone',
  'city',
  'people',
  'hard_nos',
  'diet',
  'seat_preference',
  'flight_preference',
  'partner',
  'family',
  'sister',
  'company',
  'company_name',
  'role_title',
] as const

const ALWAYS_INCLUDE = new Set<string>(ALWAYS_INCLUDE_KEYS)

export type MemoryFactInput = {
  key: string
  value: string
  durable?: boolean
  /** epoch ms the fact was last written or confirmed. Missing = unknown age. */
  at?: number
}

/**
 * Approximation, deliberately not a real tokenizer: the block is a list of
 * short "key: value" lines, and a tokenizer dependency for a size guard is not
 * worth it. 4 chars/token is the standard English estimate and errs high on
 * the short words these values are made of, which fails safe (trims sooner).
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4)
}

/** Default ceiling for the facts block. Bounds prompt growth without being the
 * binding constraint — the count cap below is usually what applies. */
export const MEMORY_BLOCK_TOKEN_BUDGET = 1200
/** Hard cap on lines, mirroring MAX_FACTS so the block cannot outgrow the store. */
export const MEMORY_BLOCK_MAX_FACTS = 60

/**
 * Bits are durable by design, so without their own cap they accumulate forever
 * and crowd out the facts a turn is actually broken without. Three is roughly
 * what a reply can use before callbacks turn into a comedy routine.
 */
export const MEMORY_BLOCK_MAX_BITS = 3

/**
 * Merge the local thread facts with the server's facts, keyed and deduped.
 * The server wins on value (it is the shared record across restarts; the local
 * file is process-local and dies with the container), but the newest timestamp
 * wins so a freshly re-confirmed fact still sorts as recent.
 */
export function mergeMemoryFacts(
  local: MemoryFactInput[],
  live: MemoryFactInput[],
): MemoryFactInput[] {
  const byKey = new Map<string, MemoryFactInput>()
  for (const fact of local) {
    const key = fact.key?.trim()
    if (!key || !fact.value) continue
    byKey.set(key, { ...fact, key })
  }
  for (const fact of live) {
    const key = fact.key?.trim()
    if (!key || !fact.value) continue
    const prior = byKey.get(key)
    byKey.set(key, {
      ...fact,
      key,
      at: newest(prior?.at, fact.at),
      durable: fact.durable ?? prior?.durable ?? isDurableFactKey(key),
    })
  }
  return [...byKey.values()]
}

function newest(a?: number, b?: number): number | undefined {
  if (a === undefined) return b
  if (b === undefined) return a
  return Math.max(a, b)
}

function isAlwaysIncluded(fact: MemoryFactInput): boolean {
  const key = fact.key.trim().toLowerCase()
  // Bits are durable but capped, so they are selected separately below rather
  // than pinned with the identity facts.
  if (isBitFactKey(key)) return false
  // The tone dial is a standing instruction about every reply, so it is never
  // the fact that gets dropped for budget.
  return isToneFactKey(key) || ALWAYS_INCLUDE.has(key) || isDurableFactKey(key)
}

function priorityOf(key: string): number {
  const index = ALWAYS_INCLUDE_KEYS.indexOf(key.trim().toLowerCase() as (typeof ALWAYS_INCLUDE_KEYS)[number])
  return index === -1 ? ALWAYS_INCLUDE_KEYS.length : index
}

function byRecency(a: MemoryFactInput, b: MemoryFactInput): number {
  const left = a.at ?? 0
  const right = b.at ?? 0
  if (left !== right) return right - left
  return a.key.localeCompare(b.key)
}

/**
 * Select the facts to inject, newest-first, with identity facts pinned.
 *
 * Order of business: identity facts in a stable declared order (so the block is
 * deterministic across turns), then the newest bits, then everything else
 * newest-first, then stop at whichever of the token budget or the count cap
 * binds first.
 */
export function selectMemoryFacts(
  facts: MemoryFactInput[],
  options: { budget?: number; maxFacts?: number; maxBits?: number } = {},
): MemoryFactInput[] {
  const budget = options.budget ?? MEMORY_BLOCK_TOKEN_BUDGET
  const maxFacts = options.maxFacts ?? MEMORY_BLOCK_MAX_FACTS
  const maxBits = options.maxBits ?? MEMORY_BLOCK_MAX_BITS

  const pinned = facts
    .filter(isAlwaysIncluded)
    .sort((a, b) => priorityOf(a.key) - priorityOf(b.key) || byRecency(a, b))
  const bits = facts.filter((fact) => isBitFactKey(fact.key)).sort(byRecency).slice(0, maxBits)
  const bitKeys = new Set(bits.map((f) => f.key))
  const rest = facts
    .filter((fact) => !isAlwaysIncluded(fact) && !bitKeys.has(fact.key) && !isBitFactKey(fact.key))
    .sort(byRecency)

  const selected: MemoryFactInput[] = []
  let tokens = 0
  for (const fact of [...pinned, ...bits, ...rest]) {
    if (selected.length >= maxFacts) break
    const cost = estimateTokens(`${fact.key}: ${fact.value}`) + 1
    // One oversized fact must not empty the block: take it when it is all we
    // have, otherwise stop rather than pushing the prompt past the budget.
    if (tokens + cost > budget && selected.length > 0) break
    selected.push(fact)
    tokens += cost
  }
  return selected
}

/** The `## Known facts about this person` section, or '' when there is nothing. */
export function formatMemoryFacts(facts: MemoryFactInput[]): string {
  const selected = selectMemoryFacts(mergeMemoryFacts(facts, []))
  if (!selected.length) return ''
  return `## Known facts about this person\n${selected.map((f) => `${f.key}: ${f.value}`).join('\n')}`
}

/** Local thread facts, which carry their own confirmation clock. */
export function localFactsToInput(facts: MemoryFact[]): MemoryFactInput[] {
  return facts.map((fact) => ({
    key: fact.key,
    value: fact.value,
    durable: isDurableFactKey(fact.key),
    at: fact.lastSeen ?? fact.ts,
  }))
}

/** Server facts: `updatedAt` is an ISO string on the wire. */
export function liveFactsToInput(
  facts: Array<{ key: string; value: string; durable?: boolean; updatedAt?: string }>,
): MemoryFactInput[] {
  return facts.map((fact) => ({
    key: fact.key,
    value: fact.value,
    durable: fact.durable,
    at: fact.updatedAt ? Date.parse(fact.updatedAt) || undefined : undefined,
  }))
}

/* ---- Typed memory: standing rules with precedence ----
 *
 * Constraints, goals, and commitments are not ordinary facts: they out-rank
 * stylistic preferences, and a standing spend cap must reach the purchase
 * gate, not just the prompt. */

export function standingConstraints(facts: MemoryFactInput[]): Array<{ key: string; value: string; capDollars: number | null }> {
  return facts
    .filter((f) => kindOfFact(String(f.key || ''), (f as { kind?: MemoryFactKind }).kind) === 'constraint')
    .map((f) => ({ key: String(f.key), value: String(f.value || ''), capDollars: constraintDollarCap(String(f.value || '')) }))
}

export function standingGoals(facts: MemoryFactInput[]): Array<{ key: string; value: string }> {
  return facts
    .filter((f) => ['goal', 'commitment'].includes(kindOfFact(String(f.key || ''), (f as { kind?: MemoryFactKind }).kind)))
    .map((f) => ({ key: String(f.key), value: String(f.value || '') }))
}

/** One line for the system prompt when today's ask intersects a standing
 * constraint domain (money, timing, contact). Precedence: a direct current
 * instruction generally wins over a PREFERENCE; a CONSTRAINT (authorization /
 * safety) is surfaced, never silently overridden — if the ask conflicts, the
 * engine says both and asks. */
export function constraintConflictNote(ask: string, facts: MemoryFactInput[]): string | null {
  const constraints = standingConstraints(facts)
  if (!constraints.length) return null
  const money = /\b(?:buy|order|purchase|price|pay|cost|spend|budget|\$)/i.test(ask)
  const timing = /\b(?:book|schedule|reschedule|meeting|flight|call)\b/i.test(ask)
  if (!money && !timing) return null
  const named = constraints.map((c) => `"${c.value}"`).join('; ')
  return `STANDING RULES (user set these earlier): ${named}. Precedence: these constraints are NOT silently overridden by today's instruction — if the current ask conflicts with one, name the conflict in one line and ask which wins. A preference (not a constraint) may be set aside when the user explicitly says so.`
}
