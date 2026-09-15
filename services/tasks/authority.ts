/**
 * Authority-policy engine (beat-instinct plan, Phase 4 groundwork).
 *
 * The plan defers broad auto-spend until transaction-level approvals show
 * zero severe incidents, so this engine is deliberately conservative:
 * every gate defaults to `ask`, an `auto` verdict requires ALL checks green,
 * and every failure contributes an explicit reason string (a card can show
 * the user exactly why the agent stopped and asked).
 *
 * Doctrine inherited from the codebase: exact-match only — merchant hosts
 * are compared as whole lowercased hosts (the vault fences `evil.example.com`
 * out of `example.com`; the same law applies here), categories are exact ids,
 * and nothing in this module parses prose or uses regex. `simulatePolicy`
 * answers "what WOULD this policy have done to my last N requests" before a
 * user ever enables it, and `bindGrant` freezes a decision into the same
 * scope shape the taskContract EXECUTING door later re-checks against
 * GrantRef — values only (numbers, hosts, ISO dates), never secrets.
 * Pure logic: no SQL, no I/O, no clocks.
 */

/* ------------------------------------------------------------------ types */

export type AuthorityPolicy = {
  id: string
  scope: {
    /** Exact hosts, lowercased at parse time. No globs, no suffix matching. */
    merchantHosts: string[]
    /** Exact category ids. */
    categories: string[]
    /** Ceiling for any single request, in cents. */
    maxCents: number
  }
  window: {
    perDayLimitCents: number
    perMerchantMaxCents: number
  }
  enabled: boolean
  /**
   * Optional tighter ask threshold: even a fully-green request above this
   * amount asks. Grace above it is a human decision, never a silent auto-spend.
   */
  graceAskAboveCents?: number
}

/**
 * The action under authority. Fields are optional-typed on purpose: a missing
 * or malformed value is a reason to ask (or to refuse a bind), never a crash
 * inside the hot decision path.
 */
export type SpendRequest = {
  merchantHost?: string | null
  category?: string | null
  priceCents?: number | null
  currency?: string | null
  /** ISO timestamp after which this spend opportunity is no longer valid. */
  expires_at?: string | null
}

export type SpendContext = {
  /** Already-spent cents today across all merchants (from the ledger). */
  spentTodayCents?: number
  /** Already-spent cents today for this specific merchant. */
  spentTodayForMerchant?: number
}

export type AuthorityDecision = {
  verdict: 'auto' | 'ask'
  /** Stable reason codes; empty exactly when verdict is 'auto'. */
  reasons: string[]
}

export const AUTHORITY_ASK_REASONS = [
  'disabled',
  'merchant-not-allowed',
  'category-not-allowed',
  'price-unknown',
  'over-policy-cap',
  'over-grace-threshold',
  'over-daily-budget',
  'over-merchant-budget',
  'currency-uncovered',
] as const
export type AuthorityAskReason = (typeof AUTHORITY_ASK_REASONS)[number]

/* -------------------------------------------------------------- validation */

function fail(message: string): never {
  throw new Error(`Authority policy: ${message}`)
}

function asRecord(value: unknown, where: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail(`${where} must be an object.`)
  }
  return value as Record<string, unknown>
}

/** Fail closed on unknown keys at every level — a typo'd policy must not half-load. */
function assertOnlyKeys(obj: Record<string, unknown>, allowed: readonly string[], where: string): void {
  for (const key of Object.keys(obj)) {
    if (!allowed.includes(key)) fail(`${where}: unknown key "${key}".`)
  }
}

function requireStringArray(value: unknown, where: string, allowEmpty: boolean): string[] {
  if (!Array.isArray(value)) fail(`${where} must be an array of strings.`)
  const items = value.map((item, i) => {
    if (typeof item !== 'string' || item.trim() === '') fail(`${where}[${i}] must be a non-empty string.`)
    return item.trim()
  })
  if (!allowEmpty && items.length === 0) fail(`${where} must be non-empty.`)
  return items
}

function requireCents(value: unknown, where: string, min: number): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min) {
    fail(`${where} must be an integer >= ${min}.`)
  }
  return value
}

/**
 * Structural host check by includes only (no regex): a bare host has no
 * scheme, no path, no userinfo, no port, no whitespace.
 */
function hostLikeError(value: string): string | null {
  if (value.includes('://')) return 'must not include a scheme'
  if (value.includes('/')) return 'must not include a path'
  if (value.includes('\\')) return 'must not include a path'
  if (value.includes('@')) return 'must not include credentials'
  if (value.includes(':')) return 'must not include a port'
  if (value.includes(' ') || value.includes('\t')) return 'must not include whitespace'
  return null
}

function normalizeHost(value: unknown): string {
  return typeof value === 'string' ? value.trim().toLowerCase() : ''
}

/**
 * Strict parse of a policy (object or JSON string). Throws on anything invalid
 * or unknown — callers surface the error text on the policy card.
 */
export function parsePolicy(json: unknown): AuthorityPolicy {
  let raw = json
  if (typeof raw === 'string') {
    try {
      raw = JSON.parse(raw)
    } catch {
      fail('input is not valid JSON.')
    }
  }
  const top = asRecord(raw, 'policy')
  assertOnlyKeys(top, ['id', 'scope', 'window', 'enabled', 'graceAskAboveCents'], 'policy')

  if (typeof top.id !== 'string' || top.id.trim() === '') fail('id must be a non-empty string.')
  if (typeof top.enabled !== 'boolean') fail('enabled must be a boolean (defaults never flip silently).')

  const scope = asRecord(top.scope, 'scope')
  assertOnlyKeys(scope, ['merchantHosts', 'categories', 'maxCents'], 'scope')
  const hosts = requireStringArray(scope.merchantHosts, 'scope.merchantHosts', false)
  for (const host of hosts) {
    const problem = hostLikeError(host)
    if (problem) fail(`scope.merchantHosts entry "${host}" ${problem}.`)
  }
  const categories = requireStringArray(scope.categories, 'scope.categories', true)
  const maxCents = requireCents(scope.maxCents, 'scope.maxCents', 1)

  const window = asRecord(top.window, 'window')
  assertOnlyKeys(window, ['perDayLimitCents', 'perMerchantMaxCents'], 'window')
  const perDayLimitCents = requireCents(window.perDayLimitCents, 'window.perDayLimitCents', 0)
  const perMerchantMaxCents = requireCents(window.perMerchantMaxCents, 'window.perMerchantMaxCents', 0)

  const policy: AuthorityPolicy = {
    id: top.id.trim(),
    // Hosts are stored lowercased: the decision path is case-insensitive on
    // host, exact on everything else (same law as the vault's origin binding).
    scope: { merchantHosts: [...new Set(hosts.map((h) => h.toLowerCase()))], categories, maxCents },
    window: { perDayLimitCents, perMerchantMaxCents },
    enabled: top.enabled,
  }
  if (top.graceAskAboveCents !== undefined) {
    policy.graceAskAboveCents = requireCents(top.graceAskAboveCents, 'graceAskAboveCents', 0)
  }
  return policy
}

export type PolicyAuditSummary = {
  policy_id: string
  enabled: boolean
  always_ask: boolean
  merchant_hosts: string[]
  categories: string[]
  max_cents: number
  per_day_limit_cents: number
  per_merchant_max_cents: number
  grace_ask_above_cents: number | null
}

/**
 * Non-secret description for cards and audit logs: hosts, category ids, and
 * cent amounts are policy facts, not user secrets; nothing user-specific
 * (spend history, tokens, payment refs) belongs here.
 */
export function policyAuditSummary(policy: AuthorityPolicy): PolicyAuditSummary {
  return {
    policy_id: policy.id,
    enabled: policy.enabled,
    always_ask: isAlwaysAsk(policy),
    merchant_hosts: [...policy.scope.merchantHosts],
    categories: [...policy.scope.categories],
    max_cents: policy.scope.maxCents,
    per_day_limit_cents: policy.window.perDayLimitCents,
    per_merchant_max_cents: policy.window.perMerchantMaxCents,
    grace_ask_above_cents: policy.graceAskAboveCents ?? null,
  }
}

/* ---------------------------------------------------------------- decision */

/**
 * The core question. 'auto' only when EVERY gate is green; each failed gate
 * contributes its reason, so an ask verdict always explains itself. Unknown
 * price is always ask (ties to the receipts doctrine: no evidence, no pass).
 * Currency is restricted to USD until multi-currency exposure is proven safe.
 */
export function decide(
  policy: AuthorityPolicy,
  request: SpendRequest,
  context: SpendContext = {},
): AuthorityDecision {
  const reasons: string[] = []

  if (!policy.enabled) reasons.push('disabled')

  const host = normalizeHost(request.merchantHost)
  if (host === '' || !policy.scope.merchantHosts.includes(host)) {
    reasons.push('merchant-not-allowed')
  }

  const category = typeof request.category === 'string' ? request.category.trim() : ''
  if (category === '' || !policy.scope.categories.includes(category)) {
    reasons.push('category-not-allowed')
  }

  const price =
    typeof request.priceCents === 'number' && Number.isFinite(request.priceCents)
      ? Math.trunc(request.priceCents)
      : null
  if (price === null) {
    // Never compare against an unknown price: budget gates are skipped and
    // the single 'price-unknown' reason carries the ask.
    reasons.push('price-unknown')
  } else {
    if (price > policy.scope.maxCents) reasons.push('over-policy-cap')
    if (policy.graceAskAboveCents !== undefined && price > policy.graceAskAboveCents) {
      reasons.push('over-grace-threshold')
    }
    const spentToday = typeof context.spentTodayCents === 'number' && Number.isFinite(context.spentTodayCents)
      ? Math.trunc(context.spentTodayCents)
      : 0
    const spentMerchant = typeof context.spentTodayForMerchant === 'number' && Number.isFinite(context.spentTodayForMerchant)
      ? Math.trunc(context.spentTodayForMerchant)
      : 0
    if (spentToday + price > policy.window.perDayLimitCents) reasons.push('over-daily-budget')
    if (spentMerchant + price > policy.window.perMerchantMaxCents) reasons.push('over-merchant-budget')
  }

  const currency = typeof request.currency === 'string' ? request.currency.trim().toUpperCase() : ''
  if (currency !== 'USD') reasons.push('currency-uncovered')

  return { verdict: reasons.length === 0 ? 'auto' : 'ask', reasons }
}

/* -------------------------------------------------------------- simulation */

export type SimulationResult = {
  auto: number
  ask: number
  /** Count per reason code (a request can contribute several reasons). */
  askBreakdown: Record<string, number>
}

/**
 * "Policies with simulation": replay sample requests against a policy with a
 * zero spend history and report what WOULD have happened, so the user grants
 * authority from evidence instead of trust. Pure — nothing is recorded.
 */
export function simulatePolicy(policy: AuthorityPolicy, sampleRequests: SpendRequest[]): SimulationResult {
  const result: SimulationResult = { auto: 0, ask: 0, askBreakdown: {} }
  for (const request of sampleRequests) {
    const decision = decide(policy, request, { spentTodayCents: 0, spentTodayForMerchant: 0 })
    if (decision.verdict === 'auto') {
      result.auto += 1
      continue
    }
    result.ask += 1
    for (const reason of decision.reasons) {
      result.askBreakdown[reason] = (result.askBreakdown[reason] ?? 0) + 1
    }
  }
  return result
}

/* ------------------------------------------------------------------- bind */

export type GrantBinding = {
  policy_id: string
  merchant_host: string
  total_cents: number
  currency: string
  expires_at: string
}

/**
 * Freeze an approved decision into the grant scope the EXECUTING door will
 * re-enforce (taskContract grants model): one host, one exact total, one
 * currency, one expiry. Numbers and hosts only — never secrets. Throws on
 * any missing or malformed field: a half-bound grant is no grant.
 */
export function bindGrant(policy: AuthorityPolicy, request: SpendRequest): GrantBinding {
  const host = normalizeHost(request.merchantHost)
  if (host === '' || hostLikeError(host) !== null) fail('bindGrant requires a bare merchant host.')
  if (!policy.scope.merchantHosts.includes(host)) {
    fail(`bindGrant: host "${host}" is outside policy ${policy.id}.`)
  }

  const price = request.priceCents
  if (typeof price !== 'number' || !Number.isFinite(price) || !Number.isInteger(price) || price < 0) {
    fail('bindGrant requires an exact integer total_cents (unknown price cannot be bound).')
  }
  if (price > policy.scope.maxCents) fail('bindGrant: total exceeds the policy cap.')

  if (typeof request.currency !== 'string' || request.currency.trim() === '') {
    fail('bindGrant requires a currency.')
  }
  const currency = request.currency.trim().toUpperCase()
  if (currency.length !== 3) fail('bindGrant: currency must be a three-letter code.')

  if (typeof request.expires_at !== 'string' || request.expires_at.trim() === '') {
    fail('bindGrant requires an expiry (expires_at).')
  }
  if (!Number.isFinite(Date.parse(request.expires_at))) fail('bindGrant: expires_at is not a valid timestamp.')

  return {
    policy_id: policy.id,
    merchant_host: host,
    total_cents: price,
    currency,
    expires_at: request.expires_at.trim(),
  }
}

/* ---------------------------------------------------------- ask-first default */

/**
 * The revertAll() default and the state every policy starts in: enabled=false
 * means every request is an ask. An empty host list is belt-and-braces — even
 * if enabled were flipped on by a bug, nothing can match.
 */
export const ASK_FIRST: AuthorityPolicy = {
  id: 'ask-first',
  scope: { merchantHosts: [], categories: [], maxCents: 0 },
  window: { perDayLimitCents: 0, perMerchantMaxCents: 0 },
  enabled: false,
}

/** True when no possible request could ever auto through this policy. */
export function isAlwaysAsk(policy: AuthorityPolicy): boolean {
  return (
    !policy.enabled ||
    policy.scope.merchantHosts.length === 0 ||
    policy.scope.categories.length === 0 ||
    policy.scope.maxCents <= 0 ||
    policy.window.perDayLimitCents <= 0 ||
    policy.window.perMerchantMaxCents <= 0
  )
}
