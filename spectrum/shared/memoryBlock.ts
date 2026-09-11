import { isDurableFactKey, type MemoryFact } from './memory'

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
  return ALWAYS_INCLUDE.has(fact.key.trim().toLowerCase()) || isDurableFactKey(fact.key)
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
 * deterministic across turns), then everything else newest-first, then stop at
 * whichever of the token budget or the count cap binds first.
 */
export function selectMemoryFacts(
  facts: MemoryFactInput[],
  options: { budget?: number; maxFacts?: number } = {},
): MemoryFactInput[] {
  const budget = options.budget ?? MEMORY_BLOCK_TOKEN_BUDGET
  const maxFacts = options.maxFacts ?? MEMORY_BLOCK_MAX_FACTS

  const pinned = facts
    .filter(isAlwaysIncluded)
    .sort((a, b) => priorityOf(a.key) - priorityOf(b.key) || byRecency(a, b))
  const rest = facts.filter((fact) => !isAlwaysIncluded(fact)).sort(byRecency)

  const selected: MemoryFactInput[] = []
  let tokens = 0
  for (const fact of [...pinned, ...rest]) {
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
