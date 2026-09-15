import { describe, expect, test } from 'bun:test'
import {
  applyRetention,
  consentTier,
  isValidSlug,
  memoryAuditLine,
  parseMemoryCommand,
  parsePrefFacts,
  preferenceWhy,
  PRIVATE_PREFERENCE_CITATION,
  sensitiveCategoryOf,
  type PrefFact,
} from './memoryHints'

function fact(overrides: Partial<PrefFact> & { key: string }): PrefFact {
  return parsePrefFacts([
    {
      kind: 'explicit',
      value_ref: 'vault://ref-1',
      confidence: 0.9,
      source: 'said',
      ...overrides,
    },
  ])[0]
}

/* ------------------------------------------------------- slug validation */

describe('slug validation', () => {
  test('accepts lowercase slug charset', () => {
    expect(isValidSlug('budget_max')).toBe(true)
    expect(isValidSlug('health.diagnosis')).toBe(true)
    expect(isValidSlug('precise-location.home')).toBe(true)
    expect(isValidSlug('a-1_2.x')).toBe(true)
  })
  test('rejects uppercase, space, unicode, empty', () => {
    expect(isValidSlug('Budget_max')).toBe(false)
    expect(isValidSlug('my key')).toBe(false)
    expect(isValidSlug('café_pref')).toBe(false)
    expect(isValidSlug('価格')).toBe(false)
    expect(isValidSlug('')).toBe(false)
  })
  test('parsePrefFacts rejects invalid keys', () => {
    expect(() => parsePrefFacts([{ key: 'Bad Key', kind: 'explicit', value_ref: 'r', confidence: 0.5, source: 'said' }])).toThrow()
    expect(() => parsePrefFacts([{ key: 'ünïcode', kind: 'explicit', value_ref: 'r', confidence: 0.5, source: 'said' }])).toThrow()
  })
})

/* --------------------------------------------------------- parsing (fail-closed) */

describe('parsePrefFacts', () => {
  test('accepts a well-formed batch from JSON text', () => {
    const facts = parsePrefFacts(
      JSON.stringify([
        { key: 'budget_max', kind: 'explicit', value_ref: 'vault://1', confidence: 1, source: 'said' },
        { key: 'work.history', kind: 'task-history', value_ref: 'vault://2', confidence: 0, source: 'imported' },
      ]),
    )
    expect(facts).toHaveLength(2)
    expect(facts[0].sensitive).toBe(false)
    expect(facts[1].sensitive).toBe(false)
  })
  test('rejects unknown kind, unknown source, missing/empty value_ref', () => {
    expect(() => parsePrefFacts([{ key: 'a', kind: 'guessed', value_ref: 'r', confidence: 0.5, source: 'said' }])).toThrow()
    expect(() => parsePrefFacts([{ key: 'a', kind: 'explicit', value_ref: 'r', confidence: 0.5, source: 'copied' }])).toThrow()
    expect(() => parsePrefFacts([{ key: 'a', kind: 'explicit', confidence: 0.5, source: 'said' }])).toThrow()
    expect(() => parsePrefFacts([{ key: 'a', kind: 'explicit', value_ref: '   ', confidence: 0.5, source: 'said' }])).toThrow()
  })
  test('confidence bounds: 0 and 1 ok, outside or non-number rejected', () => {
    const ok = { key: 'a', kind: 'explicit', value_ref: 'r', source: 'said' }
    expect(parsePrefFacts([{ ...ok, confidence: 0 }])[0].confidence).toBe(0)
    expect(parsePrefFacts([{ ...ok, confidence: 1 }])[0].confidence).toBe(1)
    expect(() => parsePrefFacts([{ ...ok, confidence: 1.2 }])).toThrow()
    expect(() => parsePrefFacts([{ ...ok, confidence: -0.1 }])).toThrow()
    expect(() => parsePrefFacts([{ ...ok, confidence: '0.5' }])).toThrow()
    expect(() => parsePrefFacts([{ ...ok, confidence: NaN }])).toThrow()
  })
  test('rejects garbage input and duplicate keys', () => {
    expect(() => parsePrefFacts('not json{')).toThrow()
    expect(() => parsePrefFacts({ key: 'a' })).toThrow()
    expect(() => parsePrefFacts([{ key: 'dup', kind: 'explicit', value_ref: 'r', confidence: 0.5, source: 'said' }, { key: 'dup', kind: 'explicit', value_ref: 'r2', confidence: 0.5, source: 'said' }])).toThrow()
  })
})

/* ------------------------------------------------- sensitive auto-flag + category */

describe('sensitive categories', () => {
  test('category default auto-flags even when sensitive:false is explicit', () => {
    expect(sensitiveCategoryOf('health.hiv_status')).toBe('health')
    expect(sensitiveCategoryOf('food.spicy')).toBe(null)
    const health = fact({ key: 'health.hiv_status', sensitive: false })
    expect(health.sensitive).toBe(true)
    const inferred = fact({ key: 'relationship.partners', kind: 'inferred', source: 'inferred' })
    expect(inferred.sensitive).toBe(true)
    const plain = fact({ key: 'food.spicy' })
    expect(plain.sensitive).toBe(false)
    const flagged = fact({ key: 'food.spicy', sensitive: true })
    expect(flagged.sensitive).toBe(true)
  })
})

/* ------------------------------------------------ preferenceWhy + de-leak */

describe('preferenceWhy', () => {
  test('keeps first sentence and cites up to 2 facts by key and kind', () => {
    const facts = [
      fact({ key: 'budget_max', confidence: 0.9 }),
      fact({ key: 'food.spicy', kind: 'inferred', confidence: 0.8 }),
      fact({ key: 'work.history', kind: 'task-history', confidence: 0.3 }),
    ]
    const line = preferenceWhy('This one fits your budget and cancel policy. Trust me, the reviews are great.', facts)
    expect(line).toBe(
      'This one fits your budget and cancel policy. (from: budget_max · explicit) (from: food.spicy · inferred)',
    )
  })
  test('reason with no terminator uses the whole string; no facts -> just the sentence', () => {
    expect(preferenceWhy('cheapest with free cancel', [])).toBe('cheapest with free cancel')
  })
  test('de-leak: sensitive citation never contains the key text', () => {
    const secretish = fact({ key: 'health.hiv_status', confidence: 1 })
    const money = fact({ key: 'financial.bank_balance', kind: 'inferred', confidence: 0.95 })
    const line = preferenceWhy('Close to work as you asked.', [secretish, money])
    expect(line).toContain(PRIVATE_PREFERENCE_CITATION)
    expect(line).not.toContain('hiv_status')
    expect(line).not.toContain('health')
    expect(line).not.toContain('bank_balance')
    expect(line).not.toContain('financial')
    // Two private facts collapse to one scrubbed citation, max two citations.
    expect(line).toBe(`Close to work as you asked. (from: ${PRIVATE_PREFERENCE_CITATION})`)
  })
})

/* ------------------------------------------------- correction grammar */

describe('parseMemoryCommand', () => {
  test('exact tokens accepted (case-insensitive, trimmed)', () => {
    expect(parseMemoryCommand('forget budget_max')).toEqual({ action: 'forget', key: 'budget_max' })
    expect(parseMemoryCommand('  SHOW WHAT YOU REMEMBER ABOUT health.hiv_status ')).toEqual({
      action: 'show',
      key: 'health.hiv_status',
    })
    expect(parseMemoryCommand('what did you use my precise-location.home for')).toEqual({
      action: 'usage',
      key: 'precise-location.home',
    })
  })
  test('anything else is null — prose and near-misses go to the classifier', () => {
    expect(parseMemoryCommand('forget')).toBeNull()
    expect(parseMemoryCommand('forget about that')).toBeNull() // space in key position
    expect(parseMemoryCommand('forget my doctor\'s number')).toBeNull()
    expect(parseMemoryCommand('i forgot what you remember about budget_max')).toBeNull()
    expect(parseMemoryCommand('what did you use my budget for extra context')).toBeNull()
    expect(parseMemoryCommand('show what you remember')).toBeNull()
    expect(parseMemoryCommand('please forget budget_max')).toBeNull()
    expect(parseMemoryCommand('')).toBeNull()
  })
})

/* ------------------------------------------------- consent + retention */

describe('consentTier and applyRetention', () => {
  test('tier from category/sensitive flag', () => {
    expect(consentTier(fact({ key: 'health.diagnosis' }))).toBe('strict')
    expect(consentTier(fact({ key: 'financial.income' }))).toBe('strict')
    expect(consentTier(fact({ key: 'relationship.partners' }))).toBe('strict')
    expect(consentTier(fact({ key: 'precise-location.home' }))).toBe('strict')
    expect(consentTier(fact({ key: 'food.spicy', sensitive: true }))).toBe('strict')
    expect(consentTier(fact({ key: 'food.spicy' }))).toBe('normal')
  })
  test('clamps to tier ceilings and floors at 1', () => {
    expect(applyRetention('normal', 1000)).toEqual({ days: 365, clamped: true })
    expect(applyRetention('normal', 100)).toEqual({ days: 100, clamped: false })
    expect(applyRetention('strict', 100)).toEqual({ days: 30, clamped: true })
    expect(applyRetention('strict', 10)).toEqual({ days: 10, clamped: false })
    expect(applyRetention('normal', -5)).toEqual({ days: 1, clamped: true })
    expect(applyRetention('strict', 0)).toEqual({ days: 1, clamped: true })
    expect(applyRetention('normal', NaN)).toEqual({ days: 1, clamped: true })
    expect(applyRetention('normal', 90.5)).toEqual({ days: 90, clamped: true })
  })
  test('custom ceilings', () => {
    expect(applyRetention('normal', 40, 30, 7)).toEqual({ days: 30, clamped: true })
    expect(applyRetention('strict', 40, 30, 7)).toEqual({ days: 7, clamped: true })
  })
})

/* ------------------------------------------------------------- audit */

describe('memoryAuditLine', () => {
  test('normal fact: key + kind + action; value and value_ref never appear', () => {
    const f = fact({ key: 'budget_max', value_ref: 'vault://secret-pointer-9' })
    const line = memoryAuditLine(f, 'used')
    expect(line).toBe('used: budget_max (explicit)')
    expect(line).not.toContain('vault://secret-pointer-9')
  })
  test('sensitive fact: key scrubbed from the audit line too', () => {
    const f = fact({ key: 'health.hiv_status', value_ref: 'vault://x' })
    const line = memoryAuditLine(f, 'deleted')
    expect(line).toContain(PRIVATE_PREFERENCE_CITATION)
    expect(line).not.toContain('hiv_status')
    expect(line).not.toContain('vault://')
    expect(line).toContain('(explicit)')
  })
  test('shared requires an explicit purpose', () => {
    const f = fact({ key: 'work.history', kind: 'task-history' })
    expect(memoryAuditLine(f, 'shared', 'annual expense report')).toBe(
      'shared: work.history (task-history) · purpose: annual expense report',
    )
    expect(() => memoryAuditLine(f, 'shared')).toThrow()
    expect(() => memoryAuditLine(f, 'shared', '   ')).toThrow()
  })
  test('unknown action rejected', () => {
    expect(() => memoryAuditLine(fact({ key: 'a' }), 'exfiltrated' as 'used')).toThrow()
  })
})
