/**
 * Frozen-benchmark machinery (beat-instinct plan, "Evaluation operating plan"
 * + "Definition of victory"). Pure data layer: no I/O, no clocks, no regex,
 * no deps. Versioned manifest, strict run records, stratified scorecard,
 * deterministic markdown report — so every future run is reproducible and a
 * blocked task can never masquerade as a pass.
 *
 * Invariants enforced here:
 *   - validateManifest is fail-closed: duplicate ids, unknown enums, short
 *     prompts, unreasonably large sets, and empty evidence requirements on
 *     irreversible tasks all reject the whole manifest.
 *   - A blocked run must be provable: >=1 intervention or >=1 evidence ref.
 *   - false_completion and unapproved_action are ALWAYS reportable: they are
 *     counted in their own columns and surface as incident sections; they are
 *     never folded into "pass" or dropped.
 *   - verifiedOutcomeRate = pass / total attempted. Blocked runs stay in the
 *     denominator (blocked != pass) and every count is shown alongside the
 *     rate so nothing is hidden.
 *   - freezeManifest hashes canonical (sorted-key) JSON, so two authors
 *     agreeing on the same tasks agree on the checksum.
 */

/* --------------------------------------------------------------- manifest */

export const BENCH_CATEGORIES = [
  'research',
  'purchasing',
  'travel',
  'appointments',
  'vendor-comms',
  'returns',
  'monitoring',
  'context',
  'multi-person',
] as const
export type BenchCategory = (typeof BENCH_CATEGORIES)[number]

export const RISK_TIERS = ['none', 'reversible', 'irreversible'] as const
export type RiskTier = (typeof RISK_TIERS)[number]

/** Categories whose tasks routinely produce an external artifact; evidence required. */
export const EVIDENCE_HEAVY_CATEGORIES: readonly BenchCategory[] = [
  'purchasing',
  'travel',
  'appointments',
  'returns',
]

export const MAX_MANIFEST_TASKS = 5000
export const MIN_PROMPT_LENGTH = 21

export type BenchTask = {
  id: string
  category: BenchCategory
  prompt: string
  site: string
  auth_required: boolean
  risk_tier: RiskTier
  /** Reference types that must exist to count a pass, e.g. 'merchant_order_id'. */
  evidence_required: string[]
  timeout_s: number
}

export type BenchManifest = {
  version: 1
  frozen_at: string
  tasks: BenchTask[]
}

export class ManifestValidationError extends Error {}

function fail(message: string): never {
  throw new ManifestValidationError(message)
}

function requireTrimmedString(value: unknown, field: string, maxLen: number): string {
  if (typeof value !== 'string' || value.trim() === '') fail(`${field} must be a non-empty string.`)
  const text = (value as string).trim()
  if (text.length > maxLen) fail(`${field} exceeds ${maxLen} characters.`)
  return text
}

function requireIsoDate(value: unknown, field: string): string {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) {
    fail(`${field} must be a valid ISO-8601 timestamp.`)
  }
  return value as string
}

function requirePositiveInt(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
    fail(`${field} must be a positive integer.`)
  }
  return value
}

/** One task -> normalized BenchTask, or throws with the task id in the message. */
function normalizeBenchTask(raw: unknown, index: number): BenchTask {
  const t = (raw ?? {}) as Partial<BenchTask> & Record<string, unknown>
  const where = typeof t.id === 'string' && t.id.trim() !== '' ? `tasks[${t.id}]` : `tasks[${index}]`
  const id = requireTrimmedString(t.id, `${where}.id`, 200)
  const category = requireTrimmedString(t.category, `${where}.category`, 100)
  if (!BENCH_CATEGORIES.includes(category as BenchCategory)) {
    fail(`${where}.category must be one of: ${BENCH_CATEGORIES.join(', ')}.`)
  }
  const promptRaw = t.prompt
  if (typeof promptRaw !== 'string' || promptRaw.trim().length <= 20) {
    fail(`${where}.prompt must be verbatim task text longer than 20 characters.`)
  }
  const prompt = promptRaw.trim()
  const site = requireTrimmedString(t.site, `${where}.site`, 253)
  if (site.includes(' ') || site.includes('/')) {
    fail(`${where}.site must be a bare host, e.g. "amazon.com".`)
  }
  if (typeof t.auth_required !== 'boolean') fail(`${where}.auth_required must be a boolean.`)
  const risk = requireTrimmedString(t.risk_tier, `${where}.risk_tier`, 50)
  if (!RISK_TIERS.includes(risk as RiskTier)) {
    fail(`${where}.risk_tier must be one of: ${RISK_TIERS.join(', ')}.`)
  }
  if (!Array.isArray(t.evidence_required)) {
    fail(`${where}.evidence_required must be an array of evidence reference types.`)
  }
  const evidence = (t.evidence_required as unknown[]).map((e, i) =>
    requireTrimmedString(e, `${where}.evidence_required[${i}]`, 200),
  )
  if (new Set(evidence).size !== evidence.length) {
    fail(`${where}.evidence_required must not contain duplicates.`)
  }
  // Fail-closed proof bar: consequence-bearing tasks and anything irreversible
  // must name at least one evidence reference type, or they cannot be scored.
  const needsEvidence =
    risk === 'irreversible' || EVIDENCE_HEAVY_CATEGORIES.includes(category as BenchCategory)
  if (needsEvidence && evidence.length === 0) {
    fail(`${where}: category "${category}" with risk "${risk}" requires a non-empty evidence_required list.`)
  }
  const timeout = requirePositiveInt(t.timeout_s, `${where}.timeout_s`)
  return {
    id,
    category: category as BenchCategory,
    prompt,
    site,
    auth_required: t.auth_required,
    risk_tier: risk as RiskTier,
    evidence_required: evidence,
    timeout_s: timeout,
  }
}

/**
 * Validate + normalize a manifest. Throws ManifestValidationError on the first
 * problem (fail-closed: an unvalidated manifest must never reach a runner).
 */
export function validateManifest(raw: unknown): BenchManifest {
  const m = (raw ?? {}) as Partial<BenchManifest> & Record<string, unknown>
  if (m.version !== 1) fail('manifest.version must be exactly 1.')
  const frozenAt = requireIsoDate(m.frozen_at, 'manifest.frozen_at')
  if (!Array.isArray(m.tasks)) fail('manifest.tasks must be an array.')
  const tasks = (m.tasks as unknown[]).map(normalizeBenchTask)
  if (tasks.length === 0) fail('manifest.tasks must not be empty.')
  if (tasks.length > MAX_MANIFEST_TASKS) {
    fail(`manifest.tasks exceeds the ${MAX_MANIFEST_TASKS}-task ceiling.`)
  }
  const seen = new Set<string>()
  for (const t of tasks) {
    if (seen.has(t.id)) fail(`Duplicate task id: ${t.id}`)
    seen.add(t.id)
  }
  return { version: 1, frozen_at: frozenAt, tasks }
}

/**
 * A single-category scaffold for authors: a valid empty manifest shell. The
 * category argument is validated so an author cannot scaffold a manifest for
 * a category that does not exist in the frozen taxonomy.
 */
export function emptyManifestScaffold(category: BenchCategory): BenchManifest {
  if (!BENCH_CATEGORIES.includes(category)) {
    fail(`scaffold category must be one of: ${BENCH_CATEGORIES.join(', ')}.`)
  }
  return { version: 1, frozen_at: new Date(0).toISOString(), tasks: [] }
}

/* ------------------------------------------------------------ canonical hash */

/** Canonical JSON: object keys sorted recursively; arrays keep order. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortDeep(value))
}

function sortDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortDeep)
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = sortDeep((value as Record<string, unknown>)[key])
    }
    return out
  }
  return value
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

/**
 * Fingerprint a manifest over canonical JSON. Key order and whitespace of the
 * source document cannot change the checksum; task content (including
 * frozen_at) can. Validation is enforced first so garbage cannot be "frozen".
 */
export async function freezeManifest(manifest: BenchManifest): Promise<string> {
  const validated = validateManifest(manifest)
  return sha256Hex(canonicalJson(validated))
}

/** Structural check that a checksum is a frozen-set id (64 hex, lowercase). */
export function isFrozen(checksum: unknown): checksum is string {
  if (typeof checksum !== 'string' || checksum.length !== 64) return false
  for (const ch of checksum) {
    const isHex = (ch >= '0' && ch <= '9') || (ch >= 'a' && ch <= 'f')
    if (!isHex) return false
  }
  return true
}

/* ------------------------------------------------------------- run records */

export const BENCH_PRODUCTS = ['alpha', 'instinct'] as const
export type BenchProduct = (typeof BENCH_PRODUCTS)[number]

export const RUN_OUTCOMES = ['pass', 'blocked', 'fail', 'false_completion', 'unapproved_action'] as const
export type RunOutcome = (typeof RUN_OUTCOMES)[number]

/** Outcomes that are incidents no matter the score: always reportable, never hidden. */
export const INCIDENT_OUTCOMES: readonly RunOutcome[] = ['false_completion', 'unapproved_action']

export type RunRecord = {
  task_id: string
  product: BenchProduct
  ran_at: string
  outcome: RunOutcome
  /** Human touches (messages, approvals, takeovers). 0 = fully unassisted. */
  interventions: number
  first_useful_ms: number | null
  p95_eligible: boolean
  /** Evidence references proving the outcome (order ids, confirmation numbers...). */
  evidence: string[]
  note?: string
}

export class RunRecordValidationError extends Error {}

function runFail(message: string): never {
  throw new RunRecordValidationError(message)
}

/**
 * Validate + normalize one run record. The plan's proof rule for blocked
 * runs is enforced: "blocked" with no intervention and no evidence is
 * indistinguishable from a fabricated or silently-failed run, so it rejects.
 */
export function validateRunRecord(raw: unknown): RunRecord {
  const r = (raw ?? {}) as Partial<RunRecord> & Record<string, unknown>
  const taskId = requireTrimmedStringGeneric(r.task_id, 'task_id', 200, runFail)
  const product = requireTrimmedStringGeneric(r.product, 'product', 50, runFail)
  if (!BENCH_PRODUCTS.includes(product as BenchProduct)) {
    runFail(`product must be one of: ${BENCH_PRODUCTS.join(', ')}.`)
  }
  const ranAt = requireIsoDate(r.ran_at, 'ran_at')
  const outcome = requireTrimmedStringGeneric(r.outcome, 'outcome', 50, runFail)
  if (!RUN_OUTCOMES.includes(outcome as RunOutcome)) {
    runFail(`outcome must be one of: ${RUN_OUTCOMES.join(', ')}.`)
  }
  if (typeof r.interventions !== 'number' || !Number.isInteger(r.interventions) || r.interventions < 0) {
    runFail('interventions must be an integer >= 0.')
  }
  let firstUseful: number | null = null
  if (r.first_useful_ms !== null && r.first_useful_ms !== undefined) {
    if (typeof r.first_useful_ms !== 'number' || !Number.isFinite(r.first_useful_ms) || r.first_useful_ms < 0) {
      runFail('first_useful_ms must be null or a non-negative finite number.')
    }
    firstUseful = r.first_useful_ms as number
  }
  if (typeof r.p95_eligible !== 'boolean') runFail('p95_eligible must be a boolean.')
  if (!Array.isArray(r.evidence)) runFail('evidence must be an array of references.')
  const evidence = (r.evidence as unknown[]).map((e, i) =>
    requireTrimmedStringGeneric(e, `evidence[${i}]`, 2000, runFail),
  )
  if (outcome === 'blocked' && r.interventions < 1 && evidence.length === 0) {
    runFail(
      `blocked run for ${taskId} is not provable: it must record at least one intervention or one evidence reference.`,
    )
  }
  const record: RunRecord = {
    task_id: taskId,
    product: product as BenchProduct,
    ran_at: ranAt,
    outcome: outcome as RunOutcome,
    interventions: r.interventions as number,
    first_useful_ms: firstUseful,
    p95_eligible: r.p95_eligible,
    evidence,
  }
  if (typeof r.note === 'string' && r.note.trim() !== '') record.note = r.note.trim().slice(0, 2000)
  return record
}

function requireTrimmedStringGeneric(
  value: unknown,
  field: string,
  maxLen: number,
  thrower: (message: string) => never,
): string {
  if (typeof value !== 'string' || value.trim() === '') thrower(`${field} must be a non-empty string.`)
  const text = (value as string).trim()
  if (text.length > maxLen) thrower(`${field} exceeds ${maxLen} characters.`)
  return text
}

/* ---------------------------------------------------------------- scorecard */

/** Phase 5 victory rule (plan, "Definition of victory" #9). */
export const VICTORY_RULE = {
  /** Head-to-head win rate HireAlpha must reach overall. */
  overall_win_rate_min: 0.7,
  /** Head-to-head win rate required within every supported category. */
  category_win_rate_min: 0.6,
} as const

/** Excluded runs are reported with a reason, never silently dropped. */
export type ExcludedRun = { run: RunRecord; reason: string }

export type StratRow = {
  key: string
  total: number
  pass: number
  blocked: number
  fail: number
  false_completions: number
  unapproved_actions: number
  /** pass / total attempted. Blocked stays in the denominator: blocked != pass. */
  verified_outcome_rate: number
  median_interventions: number
}

export type ProductScorecard = {
  product: BenchProduct
  attempts: number
  /** Aggregate across all runs of this product. */
  overall: StratRow
  by_category: StratRow[]
  by_site: StratRow[]
  by_auth_required: StratRow[]
  by_risk_tier: StratRow[]
}

export type ScorecardReport = {
  manifest_version: number
  products: ProductScorecard[]
  exclusions: ExcludedRun[]
  /** Non-zero false_completions / unapproved_actions across any product/stratum. */
  incidents: {
    product: BenchProduct
    stratum: 'overall' | 'category'
    key: string
    kind: 'false_completion' | 'unapproved_action'
    count: number
  }[]
  /** Head-to-head per paired task + verdict vs the frozen victory rule. */
  head_to_head: HeadToHeadReport
}

export type HeadToHeadCell = {
  category: BenchCategory
  alpha_wins: number
  instinct_wins: number
  ties: number
  /** alpha_wins / paired; ties count toward neither product but stay in the denominator. */
  alpha_win_rate: number
}

export type HeadToHeadTally = {
  alpha_wins: number
  instinct_wins: number
  ties: number
  alpha_win_rate: number
}

export type HeadToHeadReport = {
  paired_prompts: number
  overall: HeadToHeadTally
  by_category: HeadToHeadCell[]
  /** alpha_win_rate >= overall 70% AND >= 60% in every category with pairs. */
  alpha_meets_victory_rule: boolean
}

type ScoredRun = { run: RunRecord; task: BenchTask }

/** Outcome severity for pairing: lower rank beats higher rank in head-to-head. */
const OUTCOME_RANK: Record<RunOutcome, number> = {
  pass: 0,
  blocked: 1,
  fail: 2,
  false_completion: 3,
  unapproved_action: 4,
}

function medianOf(values: number[]): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const mid = sorted.length >> 1
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
}

function stratRow(key: string, runs: ScoredRun[]): StratRow {
  let pass = 0, blocked = 0, failC = 0, fc = 0, ua = 0
  const interventions: number[] = []
  for (const { run } of runs) {
    interventions.push(run.interventions)
    if (run.outcome === 'pass') pass++
    else if (run.outcome === 'blocked') blocked++
    else if (run.outcome === 'fail') failC++
    else if (run.outcome === 'false_completion') fc++
    else ua++
  }
  const total = runs.length
  return {
    key,
    total,
    pass,
    blocked,
    fail: failC,
    false_completions: fc,
    unapproved_actions: ua,
    verified_outcome_rate: total === 0 ? 0 : pass / total,
    median_interventions: medianOf(interventions),
  }
}

function stratify(runs: ScoredRun[], project: (r: ScoredRun) => string): StratRow[] {
  const groups = new Map<string, ScoredRun[]>()
  for (const r of runs) {
    const key = project(r)
    const bucket = groups.get(key)
    if (bucket) bucket.push(r)
    else groups.set(key, [r])
  }
  return [...groups.entries()]
    .map(([key, bucket]) => stratRow(key, bucket))
    .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
}

/**
 * Stratified scorecard per product. Runs whose task_id is not in the manifest
 * or that carry `excluded` metadata are routed to the exclusions list — the
 * plan requires exclusions be published, not hidden.
 */
export function scorecard(runs: unknown[], manifest: BenchManifest, exclusions: ExcludedRun[] = []): ScorecardReport {
  const validatedManifest = validateManifest(manifest)
  const taskById = new Map(validatedManifest.tasks.map((t) => [t.id, t]))
  const scored: ScoredRun[] = []
  const localExclusions: ExcludedRun[] = [...exclusions]
  for (const raw of runs) {
    const run = validateRunRecord(raw)
    const task = taskById.get(run.task_id)
    if (!task) {
      localExclusions.push({ run, reason: 'unknown task_id: not present in the frozen manifest' })
      continue
    }
    scored.push({ run, task })
  }
  localExclusions.sort((a, b) =>
    a.run.task_id === b.run.task_id
      ? a.run.ran_at < b.run.ran_at
        ? -1
        : 1
      : a.run.task_id < b.run.task_id
        ? -1
        : 1,
  )

  const products: ProductScorecard[] = []
  for (const product of BENCH_PRODUCTS) {
    const productRuns = scored.filter((s) => s.run.product === product)
    products.push({
      product,
      attempts: productRuns.length,
      overall: stratRow('overall', productRuns),
      by_category: stratify(productRuns, (s) => s.task.category),
      by_site: stratify(productRuns, (s) => s.task.site),
      by_auth_required: stratify(productRuns, (s) => (s.task.auth_required ? 'auth_required' : 'no_auth')),
      by_risk_tier: stratify(productRuns, (s) => s.task.risk_tier),
    })
  }

  const incidents: ScorecardReport['incidents'] = []
  for (const pc of products) {
    for (const row of [pc.overall, ...pc.by_category]) {
      const stratum: 'overall' | 'category' = row.key === 'overall' ? 'overall' : 'category'
      if (row.false_completions > 0) {
        incidents.push({ product: pc.product, stratum, key: row.key, kind: 'false_completion', count: row.false_completions })
      }
      if (row.unapproved_actions > 0) {
        incidents.push({ product: pc.product, stratum, key: row.key, kind: 'unapproved_action', count: row.unapproved_actions })
      }
    }
  }

  const headToHead = buildHeadToHead(scored)
  return {
    manifest_version: validatedManifest.version,
    products,
    exclusions: localExclusions,
    incidents,
    head_to_head: headToHead,
  }
}

/**
 * Pair runs by prompt: two runs pair when they cover the same prompt text
 * across the two products. A paired cell is decided by outcome rank (pass
 * beats blocked beats fail beats false_completion beats unapproved_action);
 * equal rank is a tie. The plan demands ties be visible, so win rate is
 * wins / paired, not wins / (wins + losses).
 */
function buildHeadToHead(scored: ScoredRun[]): HeadToHeadReport {
  const byPrompt = new Map<string, { alpha?: ScoredRun; instinct?: ScoredRun }>()
  for (const s of scored) {
    const entry = byPrompt.get(s.task.prompt) ?? {}
    entry[s.run.product] = s
    byPrompt.set(s.task.prompt, entry)
  }
  let overall = { alpha: 0, instinct: 0, ties: 0, paired: 0 }
  const byCategory = new Map<BenchCategory, { alpha: number; instinct: number; ties: number }>()
  for (const category of BENCH_CATEGORIES) byCategory.set(category, { alpha: 0, instinct: 0, ties: 0 })

  const pairs = [...byPrompt.entries()]
    .filter(([, e]) => e.alpha && e.instinct)
    .map(([prompt, e]) => ({ prompt, alpha: e.alpha as ScoredRun, instinct: e.instinct as ScoredRun }))
    .sort((a, b) => (a.prompt < b.prompt ? -1 : a.prompt > b.prompt ? 1 : 0))

  for (const pair of pairs) {
    const aRank = OUTCOME_RANK[pair.alpha.run.outcome]
    const iRank = OUTCOME_RANK[pair.instinct.run.outcome]
    const cat = byCategory.get(pair.alpha.task.category) as { alpha: number; instinct: number; ties: number }
    if (aRank < iRank) {
      overall.alpha++
      cat.alpha++
    } else if (iRank < aRank) {
      overall.instinct++
      cat.instinct++
    } else {
      overall.ties++
      cat.ties++
    }
    overall.paired++
  }

  const mkCell = (category: BenchCategory, v: { alpha: number; instinct: number; ties: number }): HeadToHeadCell => ({
    category,
    alpha_wins: v.alpha,
    instinct_wins: v.instinct,
    ties: v.ties,
    alpha_win_rate: v.alpha + v.instinct + v.ties === 0 ? 0 : v.alpha / (v.alpha + v.instinct + v.ties),
  })

  const categoryCells = [...byCategory.entries()].map(([category, v]) => mkCell(category, v))

  const categoriesWithData = categoryCells.filter((c) => c.alpha_wins + c.instinct_wins + c.ties > 0)
  const overallRate = overall.paired === 0 ? 0 : overall.alpha / overall.paired
  const alphaMeetsRule =
    overall.paired > 0 &&
    overallRate >= VICTORY_RULE.overall_win_rate_min &&
    categoriesWithData.every((c) => c.alpha_wins / (c.alpha_wins + c.instinct_wins + c.ties) >= VICTORY_RULE.category_win_rate_min)

  return {
    paired_prompts: overall.paired,
    overall: {
      alpha_wins: overall.alpha,
      instinct_wins: overall.instinct,
      ties: overall.ties,
      alpha_win_rate: overallRate,
    },
    by_category: categoryCells,
    alpha_meets_victory_rule: alphaMeetsRule,
  }
}

/* ------------------------------------------------------------------ render */

function pct(rate: number): string {
  return `${Math.round(rate * 1000) / 10}%`
}

function stratTable(title: string, rows: StratRow[]): string {
  const lines = [
    `#### ${title}`,
    '',
    '| Stratum | Attempts | Pass | Blocked | Fail | False completions | Unapproved actions | Verified outcome rate | Median interventions |',
    '|---|---:|---:|---:|---:|---:|---:|---:|---:|',
  ]
  for (const r of rows) {
    lines.push(
      `| ${r.key} | ${r.total} | ${r.pass} | ${r.blocked} | ${r.fail} | ${r.false_completions} | ${r.unapproved_actions} | ${pct(r.verified_outcome_rate)} | ${r.median_interventions} |`,
    )
  }
  return lines.join('\n')
}

/**
 * Deterministic markdown report. Same input -> byte-identical output given the
 * same generatedAt/manifestVersion. Ordering: fixed section order, products in
 * manifest order (alpha, instinct), strata alphabetical, incidents sorted,
 * exclusions sorted by task_id then ran_at.
 */
export function renderMarkdownScorecard(
  report: ScorecardReport,
  meta: { generatedAt: string; manifestVersion: number },
): string {
  const out: string[] = []
  out.push('# Frozen benchmark scorecard')
  out.push('')
  out.push(`- Generated: ${meta.generatedAt}`)
  out.push(`- Manifest version: ${meta.manifestVersion}`)
  out.push('- Legend: **BLOCKED ≠ PASS** — blocked attempts stay in the denominator of the verified outcome rate; they are counted, never promoted to passes.')
  out.push('- Legend: false completions and unapproved actions are always reportable incidents; a run carrying either can never read as a pass.')
  out.push('')

  for (const pc of report.products) {
    out.push(`## Product: ${pc.product}`)
    out.push('')
    out.push(`Attempts: ${pc.attempts}`)
    out.push('')
    out.push(stratTable('Overall', [pc.overall]))
    out.push('')
    out.push(stratTable('By category', pc.by_category))
    out.push('')
    out.push(stratTable('By site', pc.by_site))
    out.push('')
    out.push(stratTable('By auth required', pc.by_auth_required))
    out.push('')
    out.push(stratTable('By risk tier', pc.by_risk_tier))
    out.push('')
  }

  const h2h = report.head_to_head
  out.push('## Head-to-head (paired prompts)')
  out.push('')
  out.push(`Paired prompts: ${h2h.paired_prompts}`)
  out.push('')
  out.push('| Category | Alpha wins | Instinct wins | Ties | Alpha win rate |')
  out.push('|---|---:|---:|---:|---:|')
  for (const cell of h2h.by_category) {
    if (cell.alpha_wins + cell.instinct_wins + cell.ties === 0) continue
    out.push(
      `| ${cell.category} | ${cell.alpha_wins} | ${cell.instinct_wins} | ${cell.ties} | ${pct(cell.alpha_win_rate)} |`,
    )
  }
  const o = h2h.overall
  out.push(
    `| **Overall** | ${o.alpha_wins} | ${o.instinct_wins} | ${o.ties} | ${pct(o.alpha_win_rate)} |`,
  )
  out.push('')
  out.push(
    `Victory rule (alpha win rate >= ${pct(VICTORY_RULE.overall_win_rate_min)} overall and >= ${pct(VICTORY_RULE.category_win_rate_min)} per category): ${h2h.alpha_meets_victory_rule ? 'MET' : 'NOT MET'}`,
  )
  out.push('')

  out.push('## Incidents')
  out.push('')
  if (report.incidents.length === 0) {
    out.push('No false completions or unapproved actions recorded.')
  } else {
    const sorted = [...report.incidents].sort((a, b) =>
      a.product !== b.product
        ? a.product < b.product
          ? -1
          : 1
        : a.kind !== b.kind
          ? a.kind < b.kind
            ? -1
            : 1
          : a.key !== b.key
            ? a.key < b.key
              ? -1
              : 1
            : 0,
    )
    out.push('| Product | Stratum | Key | Kind | Count |')
    out.push('|---|---|---|---|---:|')
    for (const inc of sorted) {
      out.push(`| ${inc.product} | ${inc.stratum} | ${inc.key} | ${inc.kind} | ${inc.count} |`)
    }
  }
  out.push('')

  out.push('## Exclusions')
  out.push('')
  if (report.exclusions.length === 0) {
    out.push('No runs excluded.')
  } else {
    out.push('| Task | Product | Ran at | Reason |')
    out.push('|---|---|---|---|')
    for (const ex of report.exclusions) {
      out.push(`| ${ex.run.task_id} | ${ex.run.product} | ${ex.run.ran_at} | ${ex.reason} |`)
    }
  }
  out.push('')
  return out.join('\n')
}
