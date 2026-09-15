/**
 * Memory, made provable and correctable (beat-instinct plan, workstream 7
 * "Memory and personal judgment" — the card-facing half).
 *
 * services/trust stores the memories; this module never touches storage. It
 * only classifies and renders: which facts may be cited on a card, how they
 * are cited without leaking private context, how the user corrects them with
 * an exact-token grammar, how long each consent tier may keep them, and what
 * the audit trail may say.
 *
 * Rules encoded here:
 *   - A card cites a preference by KEY and KIND, never by value — PrefFact
 *     carries an opaque value_ref; the value itself does not exist in here.
 *   - De-leak rule: a sensitive fact is cited as "a private preference you
 *     set". The key text (e.g. "health.hiv_status") must never reach the
 *     rendered card, because the card may travel to shared surfaces.
 *   - No regex on prose anywhere: validation is character loops over slugs,
 *     first-sentence split is a character loop, the correction grammar is
 *     exact tokens only — everything fuzzy belongs to the classifier.
 *   - Fail-closed parsing: unknown kind/source, out-of-range confidence, or a
 *     missing value_ref rejects the whole batch rather than storing a
 *     half-understood memory.
 *   - Sensitive data keeps shorter max retention than normal data, and
 *     sharing a memory to a third party requires an explicit purpose.
 */

/* ---------------------------------------------------------------- types */

export const PREF_FACT_KINDS = ['explicit', 'inferred', 'task-history'] as const
export type PrefFactKind = (typeof PREF_FACT_KINDS)[number]

export const PREF_FACT_SOURCES = ['said', 'observed', 'inferred', 'imported'] as const
export type PrefFactSource = (typeof PREF_FACT_SOURCES)[number]

export type PrefFact = {
  /** Lowercase slug from [a-z0-9_.-]; may double as `category.rest`. */
  key: string
  kind: PrefFactKind
  /** Opaque pointer into services/trust storage — NEVER the stored value. */
  value_ref: string
  /** 0..1 inclusive. */
  confidence: number
  sensitive: boolean
  source: PrefFactSource
}

/** The plan's sensitive categories; a key whose leading slug segment names one is sensitive. */
export const SENSITIVE_CATEGORIES = ['health', 'financial', 'relationship', 'precise-location'] as const
export type SensitiveCategory = (typeof SENSITIVE_CATEGORIES)[number]

/**
 * Defaults applied when a stored fact omits the explicit `sensitive` flag:
 * a fact in a sensitive category is ALWAYS sensitive (fail-safe — the map
 * only ever turns the flag on, never off), everything else defaults to false.
 */
const CATEGORY_SENSITIVE_DEFAULT: Record<string, boolean> = {}
for (const category of SENSITIVE_CATEGORIES) CATEGORY_SENSITIVE_DEFAULT[category] = true

/** The scrubbed citation an audience sees instead of a sensitive key. */
export const PRIVATE_PREFERENCE_CITATION = 'a private preference you set'

/* ------------------------------------------------------ slug validation */

function isSlugChar(character: string): boolean {
  return (
    (character >= 'a' && character <= 'z') ||
    (character >= '0' && character <= '9') ||
    character === '_' ||
    character === '.' ||
    character === '-'
  )
}

/** Character loop over code points — no regex. Rejects '', uppercase, spaces, unicode. */
export function isValidSlug(key: string): boolean {
  if (typeof key !== 'string' || key === '') return false
  for (const character of [...key]) {
    if (!isSlugChar(character)) return false
  }
  return true
}

/** Leading slug segment (`health.diagnosis` -> `health`), or null when there is none. */
export function sensitiveCategoryOf(key: string): SensitiveCategory | null {
  let head = ''
  for (const character of [...key]) {
    if (character === '.') break
    head += character
  }
  return (SENSITIVE_CATEGORIES as readonly string[]).includes(head)
    ? (head as SensitiveCategory)
    : null
}

/* ----------------------------------------------------------- parsing */

function inRange01(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1
}

/** Validate one raw fact. Throws on anything malformed (fail-closed). */
function parseOnePrefFact(raw: unknown, index: number): PrefFact {
  const path = `facts[${index}]`
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error(`${path}: must be an object.`)
  }
  const o = raw as Record<string, unknown>

  const key = o.key
  if (typeof key !== 'string' || !isValidSlug(key)) {
    throw new Error(`${path}.key: must be a non-empty lowercase slug of [a-z0-9_.-].`)
  }
  const kind = o.kind
  if (typeof kind !== 'string' || !(PREF_FACT_KINDS as readonly string[]).includes(kind)) {
    throw new Error(`${path}.kind: unknown kind "${String(kind)}".`)
  }
  const source = o.source
  if (typeof source !== 'string' || !(PREF_FACT_SOURCES as readonly string[]).includes(source)) {
    throw new Error(`${path}.source: unknown source "${String(source)}".`)
  }
  const valueRef = o.value_ref
  if (typeof valueRef !== 'string' || valueRef.trim() === '') {
    throw new Error(`${path}.value_ref: a stored fact must carry a value reference, never a value.`)
  }
  if (!inRange01(o.confidence)) {
    throw new Error(`${path}.confidence: must be a finite number in [0, 1].`)
  }
  if (o.sensitive !== undefined && typeof o.sensitive !== 'boolean') {
    throw new Error(`${path}.sensitive: must be a boolean when present.`)
  }
  // Category default can only raise the flag; an explicit true is kept, an
  // explicit false on a sensitive-category key is overridden to true.
  const sensitive =
    o.sensitive === true || CATEGORY_SENSITIVE_DEFAULT[sensitiveCategoryOf(key) ?? ''] === true

  return {
    key,
    kind: kind as PrefFactKind,
    value_ref: valueRef,
    confidence: o.confidence as number,
    sensitive,
    source: source as PrefFactSource,
  }
}

/**
 * Parse a batch of stored facts from JSON text or an already-parsed array.
 * Rejects the whole batch on any invalid member (fail-closed), and rejects
 * duplicate keys so two memories cannot disagree about one preference.
 */
export function parsePrefFacts(json: unknown): PrefFact[] {
  let value = json
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value)
    } catch {
      throw new Error('pref facts: input string is not valid JSON.')
    }
  }
  if (!Array.isArray(value)) throw new Error('pref facts: expected an array of facts.')
  const facts = value.map((raw, index) => parseOnePrefFact(raw, index))
  const seen = new Set<string>()
  for (const fact of facts) {
    if (seen.has(fact.key)) throw new Error(`pref facts: duplicate key "${fact.key}".`)
    seen.add(fact.key)
  }
  return facts
}

/* ------------------------------------------------------ card rendering */

/**
 * First sentence by character walk (no regex): the sentence ends after the
 * first ., ! or ? plus any trailing quote/paren. No terminator -> whole string.
 */
function firstSentence(reason: string): string {
  const characters = [...reason]
  for (let i = 0; i < characters.length; i += 1) {
    const character = characters[i]
    if (character === '.' || character === '!' || character === '?') {
      let end = i + 1
      while (end < characters.length && (characters[end] === '"' || characters[end] === "'" || characters[end] === ')')) {
        end += 1
      }
      return characters.slice(0, end).join('').trim()
    }
  }
  return reason.trim()
}

function citationFor(fact: PrefFact): string {
  // De-leak rule: a sensitive fact's key never appears in a card citation.
  if (fact.sensitive) return `(from: ${PRIVATE_PREFERENCE_CITATION})`
  return `(from: ${fact.key} · ${fact.kind})`
}

/**
 * The "why did a preference affect this recommendation" line shown on a card:
 * the option's own first-sentence reason, then up to the two strongest facts
 * cited as `(from: <key> · <kind>)`. Sensitive facts are cited without their
 * key text. Duplicate scrubbed citations collapse so the line stays honest
 * without repeating itself.
 */
export function preferenceWhy(optionReason: string, facts: PrefFact[]): string {
  const sentence = firstSentence(optionReason ?? '')
  const ranked = [...facts].sort((a, b) => b.confidence - a.confidence)
  const citations: string[] = []
  for (const fact of ranked) {
    if (citations.length >= 2) break
    const citation = citationFor(fact)
    if (!citations.includes(citation)) citations.push(citation)
  }
  return [sentence, ...citations].filter((part) => part !== '').join(' ')
}

/* ------------------------------------------------ correction grammar */

/**
 * Exact-token correction commands only — anything fuzzy is the classifier's
 * job (same doctrine as selectionFromReply). The key must be a valid slug;
 * spaces or stray prose inside the key position make the command null.
 */
export type MemoryCommand =
  | { action: 'forget'; key: string }
  | { action: 'show'; key: string }
  | { action: 'usage'; key: string }

const FORGET_PREFIX = 'forget '
const SHOW_PREFIX = 'show what you remember about '
const USAGE_PREFIX = 'what did you use my '
const USAGE_SUFFIX = ' for'

function commandWithKey(key: string, action: MemoryCommand['action']): MemoryCommand | null {
  if (!isValidSlug(key)) return null
  return { action, key } as MemoryCommand
}

export function parseMemoryCommand(text: string): MemoryCommand | null {
  if (typeof text !== 'string') return null
  const trimmed = text.trim().toLowerCase()
  if (trimmed === '') return null
  if (trimmed.startsWith(FORGET_PREFIX)) {
    return commandWithKey(trimmed.slice(FORGET_PREFIX.length), 'forget')
  }
  if (trimmed.startsWith(SHOW_PREFIX)) {
    return commandWithKey(trimmed.slice(SHOW_PREFIX.length), 'show')
  }
  if (trimmed.startsWith(USAGE_PREFIX) && trimmed.endsWith(USAGE_SUFFIX)) {
    const key = trimmed.slice(USAGE_PREFIX.length, trimmed.length - USAGE_SUFFIX.length)
    return commandWithKey(key, 'usage')
  }
  return null
}

/* ------------------------------------------------- consent and retention */

export type ConsentTier = 'normal' | 'strict'

/** Sensitive (or sensitive-category) facts sit in the strict tier. */
export function consentTier(fact: PrefFact): ConsentTier {
  if (fact.sensitive || sensitiveCategoryOf(fact.key) !== null) return 'strict'
  return 'normal'
}

export type Retention = { days: number; clamped: boolean }

/**
 * Clamp a requested retention to the tier's ceiling (plan: sensitive data
 * lives shorter). Floors at 1 day; non-integers floor and count as clamped;
 * non-finite input falls back to the minimum rather than to "forever".
 */
export function applyRetention(
  tier: ConsentTier,
  requestedDays: number,
  maxNormal = 365,
  maxStrict = 30,
): Retention {
  const max = tier === 'strict' ? maxStrict : maxNormal
  let clamped = false
  let days: number
  if (typeof requestedDays !== 'number' || !Number.isFinite(requestedDays)) {
    days = 1
    clamped = true
  } else {
    days = Math.floor(requestedDays)
    if (days !== requestedDays) clamped = true
  }
  if (days < 1) {
    days = 1
    clamped = true
  }
  if (days > max) {
    days = max
    clamped = true
  }
  return { days, clamped }
}

/* ------------------------------------------------------------- audit */

export const MEMORY_AUDIT_ACTIONS = ['used', 'corrected', 'deleted', 'shared'] as const
export type MemoryAuditAction = (typeof MEMORY_AUDIT_ACTIONS)[number]

/**
 * One non-secret audit-trail line: action + key + kind. The value_ref is a
 * pointer into storage and is still not written into the line — and for
 * sensitive facts even the key is replaced by the private citation. Sharing
 * requires an explicit purpose (no private context to third parties without
 * necessity).
 */
export function memoryAuditLine(fact: PrefFact, action: MemoryAuditAction, purpose?: string): string {
  if (!(MEMORY_AUDIT_ACTIONS as readonly string[]).includes(action)) {
    throw new Error(`audit action "${String(action)}" is not one of ${MEMORY_AUDIT_ACTIONS.join(', ')}.`)
  }
  const subject = fact.sensitive ? PRIVATE_PREFERENCE_CITATION : fact.key
  const line = `${action}: ${subject} (${fact.kind})`
  if (action !== 'shared') return line
  if (typeof purpose !== 'string' || purpose.trim() === '') {
    throw new Error('Sharing a memory requires an explicit purpose — no private context leaves without necessity.')
  }
  return `${line} · purpose: ${purpose.trim().slice(0, 200)}`
}
