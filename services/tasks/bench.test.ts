/**
 * Frozen-benchmark module tests. Covers every fail-closed manifest rule,
 * the blocked-must-be-provable run rule, scorecard math on a fixed 12-run
 * fixture (including false-completion surfacing), head-to-head 70/60 verdict
 * math in both directions, deterministic markdown rendering, and freeze
 * checksum stability.
 */
import { describe, expect, it } from 'bun:test'
import {
  BENCH_CATEGORIES,
  ManifestValidationError,
  RunRecordValidationError,
  VICTORY_RULE,
  canonicalJson,
  emptyManifestScaffold,
  freezeManifest,
  isFrozen,
  renderMarkdownScorecard,
  scorecard,
  validateManifest,
  validateRunRecord,
  type BenchManifest,
  type BenchTask,
  type RunRecord,
} from './bench'

type Row = Record<string, unknown>

function taskFixture(overrides: Row = {}): Row {
  return {
    id: 't-1',
    category: 'research',
    prompt: 'Find three verified vendors for standing desks under 500 USD.',
    site: 'example.com',
    auth_required: false,
    risk_tier: 'none',
    evidence_required: [],
    timeout_s: 300,
    ...overrides,
  }
}

function manifestFixture(tasks: Row[]): Row {
  return { version: 1, frozen_at: '2026-09-01T00:00:00.000Z', tasks }
}

function expectManifestFail(raw: Row | unknown): void {
  expect(() => validateManifest(raw)).toThrow(ManifestValidationError)
}

/* ------------------------------------------------------------ manifest */

describe('validateManifest', () => {
  it('accepts a minimal valid manifest', () => {
    const m = validateManifest(manifestFixture([taskFixture()]))
    expect(m.version).toBe(1)
    expect(m.tasks).toHaveLength(1)
    expect(m.tasks[0]!.id).toBe('t-1')
  })

  it('rejects wrong version', () => {
    expectManifestFail({ ...manifestFixture([taskFixture()]), version: 2 })
    expectManifestFail({ ...manifestFixture([taskFixture()]), version: '1' })
  })

  it('rejects bad frozen_at', () => {
    expectManifestFail({ ...manifestFixture([taskFixture()]), frozen_at: 'last tuesday' })
    expectManifestFail({ ...manifestFixture([taskFixture()]), frozen_at: 42 })
  })

  it('rejects non-array and empty tasks', () => {
    expectManifestFail({ version: 1, frozen_at: '2026-09-01T00:00:00.000Z', tasks: 'nope' })
    expectManifestFail(manifestFixture([]))
  })

  it('rejects duplicate ids', () => {
    expectManifestFail(manifestFixture([taskFixture({ id: 'dup' }), taskFixture({ id: 'dup' })]))
  })

  it('rejects unknown category', () => {
    try {
      validateManifest(manifestFixture([taskFixture({ category: 'gaming' })]))
      expect.unreachable()
    } catch (err) {
      expect(String((err as Error).message)).toContain('category')
    }
  })

  it('rejects unknown risk tier', () => {
    expectManifestFail(manifestFixture([taskFixture({ risk_tier: 'maybe' })]))
  })

  it('rejects empty evidence for evidence-heavy categories', () => {
    for (const category of ['purchasing', 'travel', 'appointments', 'returns']) {
      expectManifestFail(manifestFixture([taskFixture({ category, evidence_required: [] })]))
    }
  })

  it('rejects empty evidence for ANY irreversible task, even light categories', () => {
    expectManifestFail(
      manifestFixture([taskFixture({ category: 'context', risk_tier: 'irreversible', evidence_required: [] })]),
    )
    // and accepts it once evidence is named
    const m = validateManifest(
      manifestFixture([
        taskFixture({ category: 'context', risk_tier: 'irreversible', evidence_required: ['confirmation_number'] }),
      ]),
    )
    expect(m.tasks[0]!.evidence_required).toEqual(['confirmation_number'])
  })

  it('allows empty evidence for light categories at low risk', () => {
    const m = validateManifest(manifestFixture([taskFixture({ category: 'research', evidence_required: [] })]))
    expect(m.tasks[0]!.evidence_required).toEqual([])
  })

  it('rejects prompts of 20 characters or fewer (verbatim-task bar)', () => {
    expectManifestFail(manifestFixture([taskFixture({ prompt: 'x'.repeat(20) })]))
    const ok = validateManifest(manifestFixture([taskFixture({ prompt: 'x'.repeat(21) })]))
    expect(ok.tasks[0]!.prompt).toHaveLength(21)
  })

  it('rejects task sets above the 5000 ceiling', () => {
    const many = Array.from({ length: 5001 }, (_, i) => taskFixture({ id: `t-${i}` }))
    expectManifestFail(manifestFixture(many))
    const atLimit = validateManifest(manifestFixture(many.slice(0, 5000)))
    expect(atLimit.tasks).toHaveLength(5000)
  })

  it('rejects non-host sites, bad auth flag, and bad timeout', () => {
    expectManifestFail(manifestFixture([taskFixture({ site: 'https://example.com/path' })]))
    expectManifestFail(manifestFixture([taskFixture({ site: 'not a host' })]))
    expectManifestFail(manifestFixture([taskFixture({ auth_required: 'yes' })]))
    expectManifestFail(manifestFixture([taskFixture({ timeout_s: 0 })]))
    expectManifestFail(manifestFixture([taskFixture({ timeout_s: 1.5 })]))
  })

  it('rejects duplicate evidence entries', () => {
    expectManifestFail(
      manifestFixture([taskFixture({ category: 'purchasing', evidence_required: ['order_id', 'order_id'] })]),
    )
  })
})

describe('emptyManifestScaffold', () => {
  it('produces a valid version-1 shell for a known category', () => {
    const m = emptyManifestScaffold('monitoring')
    expect(m.version).toBe(1)
    expect(m.tasks).toEqual([])
  })
  it('rejects a category outside the frozen taxonomy', () => {
    expect(() => emptyManifestScaffold('gaming' as never)).toThrow(ManifestValidationError)
  })
})

/* -------------------------------------------------------- run records */

function runFixture(overrides: Row = {}): Row {
  return {
    task_id: 't-1',
    product: 'alpha',
    ran_at: '2026-09-02T10:00:00.000Z',
    outcome: 'pass',
    interventions: 0,
    first_useful_ms: 1200,
    p95_eligible: true,
    evidence: ['merchant_order_id=987'],
    ...overrides,
  }
}

describe('validateRunRecord', () => {
  it('accepts a clean pass record', () => {
    const r = validateRunRecord(runFixture())
    expect(r.product).toBe('alpha')
    expect(r.first_useful_ms).toBe(1200)
  })

  it('accepts null first_useful_ms and optional note', () => {
    const r = validateRunRecord(runFixture({ first_useful_ms: null, note: 'captcha wall' }))
    expect(r.first_useful_ms).toBeNull()
    expect(r.note).toBe('captcha wall')
  })

  it('rejects blocked runs with no proof (no interventions, no evidence)', () => {
    try {
      validateRunRecord(runFixture({ outcome: 'blocked', interventions: 0, evidence: [] }))
      expect.unreachable()
    } catch (err) {
      expect(err).toBeInstanceOf(RunRecordValidationError)
      expect(String((err as Error).message)).toContain('provable')
    }
  })

  it('accepts blocked runs that record an intervention or evidence', () => {
    expect(validateRunRecord(runFixture({ outcome: 'blocked', interventions: 1 })).outcome).toBe('blocked')
    expect(validateRunRecord(runFixture({ outcome: 'blocked', evidence: ['support_ticket=42'] })).outcome).toBe(
      'blocked',
    )
  })

  it('does not require proof for pass/fail, but rejects junk enums and counts', () => {
    expect(validateRunRecord(runFixture({ outcome: 'fail', evidence: [] })).outcome).toBe('fail')
    expect(() => validateRunRecord(runFixture({ outcome: 'mostly_fine' }))).toThrow(RunRecordValidationError)
    expect(() => validateRunRecord(runFixture({ product: 'copilot' }))).toThrow(RunRecordValidationError)
    expect(() => validateRunRecord(runFixture({ interventions: -1 }))).toThrow(RunRecordValidationError)
    expect(() => validateRunRecord(runFixture({ interventions: 2.5 }))).toThrow(RunRecordValidationError)
    expect(() => validateRunRecord(runFixture({ evidence: 'not-an-array' }))).toThrow(RunRecordValidationError)
  })
})

/* ---------------------------------------------------------- fixture */

const FIXTURE_MANIFEST: BenchManifest = {
  version: 1,
  frozen_at: '2026-09-01T00:00:00.000Z',
  tasks: [
    { id: 'b-purch', category: 'purchasing', prompt: 'Buy the cheapest verified office chair under 200 and keep the receipt.', site: 'amazon.com', auth_required: true, risk_tier: 'irreversible', evidence_required: ['merchant_order_id'], timeout_s: 600 },
    { id: 'b-research', category: 'research', prompt: 'Compare three monitor arms under 80 dollars with current prices.', site: 'example.com', auth_required: false, risk_tier: 'none', evidence_required: [], timeout_s: 300 },
    { id: 'b-travel', category: 'travel', prompt: 'Book a refundable one-night hotel in Austin for the first weekend of October.', site: 'booking.com', auth_required: true, risk_tier: 'irreversible', evidence_required: ['confirmation_number'], timeout_s: 900 },
    { id: 'b-appt', category: 'appointments', prompt: 'Schedule a dentist cleaning appointment next week, mornings only.', site: 'zocdoc.com', auth_required: true, risk_tier: 'reversible', evidence_required: ['booking_ref'], timeout_s: 600 },
    { id: 'b-monitor', category: 'monitoring', prompt: 'Track price drops on the saved item list and alert when any unit price falls 10 percent.', site: 'example.com', auth_required: false, risk_tier: 'none', evidence_required: [], timeout_s: 120 },
    { id: 'b-returns', category: 'returns', prompt: 'Start a return for the delivered desk lamp and print the prepaid label.', site: 'target.com', auth_required: true, risk_tier: 'reversible', evidence_required: ['return_label_ref'], timeout_s: 600 },
  ],
}

/**
 * 12-run fixture: 6 manifest tasks x 2 products. Alpha overall:
 * 3 pass, 1 blocked, 1 false_completion, 1 unapproved_action.
 */
const FIXTURE_RUNS: RunRecord[] = (
  [
    runFixture({ task_id: 'b-purch', product: 'alpha', outcome: 'pass', interventions: 0, evidence: ['order_1'] }),
    runFixture({ task_id: 'b-purch', product: 'instinct', outcome: 'pass', interventions: 2, evidence: ['order_2'] }),
    runFixture({ task_id: 'b-research', product: 'alpha', outcome: 'pass', interventions: 1, evidence: [] }),
    runFixture({ task_id: 'b-research', product: 'instinct', outcome: 'fail', interventions: 0, evidence: [] }),
    runFixture({ task_id: 'b-travel', product: 'alpha', outcome: 'blocked', interventions: 3, evidence: [] }),
    runFixture({ task_id: 'b-travel', product: 'instinct', outcome: 'pass', interventions: 0, evidence: ['conf_9'] }),
    runFixture({ task_id: 'b-appt', product: 'alpha', outcome: 'false_completion', interventions: 0, evidence: [] }),
    runFixture({ task_id: 'b-appt', product: 'instinct', outcome: 'fail', interventions: 1, evidence: [] }),
    runFixture({ task_id: 'b-monitor', product: 'alpha', outcome: 'pass', interventions: 0, evidence: [] }),
    runFixture({ task_id: 'b-monitor', product: 'instinct', outcome: 'blocked', interventions: 1, evidence: ['log_1'] }),
    runFixture({ task_id: 'b-returns', product: 'alpha', outcome: 'unapproved_action', interventions: 4, evidence: [] }),
    runFixture({ task_id: 'b-returns', product: 'instinct', outcome: 'fail', interventions: 0, evidence: [] }),
  ] as RunRecord[]
).map(validateRunRecord)

function productCard(report: ReturnType<typeof scorecard>, product: 'alpha' | 'instinct') {
  const pc = report.products.find((p) => p.product === product)
  if (!pc) throw new Error(`missing product ${product}`)
  return pc
}

/* --------------------------------------------------------- scorecard */

describe('scorecard', () => {
  const report = scorecard(FIXTURE_RUNS, FIXTURE_MANIFEST)

  it('computes the 12-run overall math per product', () => {
    const alpha = productCard(report, 'alpha').overall
    expect(alpha.total).toBe(6)
    expect(alpha.pass).toBe(3)
    expect(alpha.blocked).toBe(1)
    expect(alpha.fail).toBe(0)
    expect(alpha.false_completions).toBe(1)
    expect(alpha.unapproved_actions).toBe(1)
    // blocked stays in the denominator: 3/6, never 3/5 or promoted
    expect(alpha.verified_outcome_rate).toBeCloseTo(3 / 6, 10)
    // interventions [0,1,3,0,0,4] -> sorted [0,0,0,1,3,4] -> median 0.5
    expect(alpha.median_interventions).toBe(0.5)
    const instinct = productCard(report, 'instinct').overall
    expect(instinct.pass).toBe(2)
    expect(instinct.fail).toBe(3)
    expect(instinct.blocked).toBe(1)
    expect(instinct.false_completions).toBe(0)
    expect(instinct.verified_outcome_rate).toBeCloseTo(2 / 6, 10)
  })

  it('stratifies by category, site, auth, and risk tier', () => {
    const alpha = productCard(report, 'alpha')
    expect(alpha.by_category.map((r) => r.key)).toEqual(
      ['appointments', 'monitoring', 'purchasing', 'research', 'returns', 'travel'].sort(),
    )
    const travel = alpha.by_category.find((r) => r.key === 'travel')
    expect(travel!.blocked).toBe(1)
    expect(travel!.verified_outcome_rate).toBe(0)
    expect(alpha.by_site.find((r) => r.key === 'amazon.com')!.total).toBe(1)
    expect(alpha.by_auth_required.find((r) => r.key === 'auth_required')!.total).toBe(4)
    expect(alpha.by_auth_required.find((r) => r.key === 'no_auth')!.total).toBe(2)
    expect(alpha.by_risk_tier.find((r) => r.key === 'irreversible')!.total).toBe(2)
  })

  it('surfaces false completions and unapproved actions as incidents, never hidden', () => {
    const alphaIncidents = report.incidents.filter((i) => i.product === 'alpha')
    expect(alphaIncidents.some((i) => i.kind === 'false_completion' && i.count === 1)).toBe(true)
    expect(alphaIncidents.some((i) => i.kind === 'unapproved_action' && i.count === 1)).toBe(true)
    // both at overall and category strata
    expect(alphaIncidents.some((i) => i.stratum === 'overall' && i.kind === 'false_completion')).toBe(true)
    expect(alphaIncidents.some((i) => i.stratum === 'category' && i.key === 'appointments')).toBe(true)
    expect(report.incidents.filter((i) => i.product === 'instinct')).toEqual([])
  })

  it('routes unknown task_ids into published exclusions', () => {
    const withStray = scorecard(
      [...FIXTURE_RUNS, validateRunRecord(runFixture({ task_id: 'ghost-task' }))],
      FIXTURE_MANIFEST,
    )
    expect(withStray.exclusions).toHaveLength(1)
    expect(withStray.exclusions[0]!.run.task_id).toBe('ghost-task')
    expect(withStray.exclusions[0]!.reason).toContain('frozen manifest')
    // exclusion did not silently join the scored attempts
    expect(productCard(withStray, 'alpha').attempts).toBe(6)
  })
})

/* ------------------------------------------------------ head-to-head */

type H2HPair = {
  category: BenchManifest['tasks'][number]['category']
  alpha: RunRecord['outcome']
  instinct: RunRecord['outcome']
  productInterventions?: number
}

/** Builds paired (alpha, instinct) runs over generated none-risk tasks. */
function headToHeadFixture(pairs: H2HPair[]) {
  const tasks: BenchTask[] = pairs.map((p, i) => ({
    id: `h2h-${i}`,
    category: p.category,
    prompt: `Head to head prompt number ${i} with enough characters to pass validation.`,
    site: 'pair.example.com',
    auth_required: false,
    risk_tier: 'none' as const,
    evidence_required: [],
    timeout_s: 300,
  }))
  const manifest = manifestFixture(tasks)
  const runs = pairs.flatMap((p, i) => {
    const intervention = p.productInterventions ?? 1 // keeps blocked rows provable
    return [
      validateRunRecord(runFixture({ task_id: `h2h-${i}`, product: 'alpha', outcome: p.alpha, interventions: p.alpha === 'blocked' ? intervention : 0, evidence: p.alpha === 'blocked' ? ['proof'] : [] })),
      validateRunRecord(runFixture({ task_id: `h2h-${i}`, product: 'instinct', outcome: p.instinct, interventions: p.instinct === 'blocked' ? intervention : 0, evidence: p.instinct === 'blocked' ? ['proof'] : [] })),
    ]
  })
  return scorecard(runs, manifest as BenchManifest).head_to_head
}

describe('headToHead verdict math', () => {
  it('exports the plan victory constants', () => {
    expect(VICTORY_RULE.overall_win_rate_min).toBe(0.7)
    expect(VICTORY_RULE.category_win_rate_min).toBe(0.6)
  })

  it('MET: 8/10 category wins (80% overall, 80% category)', () => {
    const pairs = Array.from({ length: 10 }, (_, i) =>
      i < 8
        ? { category: 'monitoring' as const, alpha: 'pass' as const, instinct: 'fail' as const }
        : { category: 'monitoring' as const, alpha: 'pass' as const, instinct: 'pass' as const },
    )
    const h2h = headToHeadFixture(pairs)
    expect(h2h.paired_prompts).toBe(10)
    expect(h2h.overall.alpha_win_rate).toBeCloseTo(0.8, 10)
    expect(h2h.overall.ties).toBe(2)
    expect(h2h.alpha_meets_victory_rule).toBe(true)
  })

  it('NOT MET on overall: 6 wins / 2 ties / 2 losses = 60% < 70%', () => {
    const pairs: H2HPair[] = [
      ...Array.from({ length: 6 }, () => ({ category: 'monitoring' as const, alpha: 'pass' as const, instinct: 'fail' as const })),
      ...Array.from({ length: 2 }, () => ({ category: 'monitoring' as const, alpha: 'pass' as const, instinct: 'pass' as const })),
      ...Array.from({ length: 2 }, () => ({ category: 'monitoring' as const, alpha: 'fail' as const, instinct: 'pass' as const })),
    ]
    const h2h = headToHeadFixture(pairs)
    expect(h2h.overall.alpha_win_rate).toBeCloseTo(0.6, 10)
    expect(h2h.alpha_meets_victory_rule).toBe(false)
  })

  it('NOT MET on category floor despite 70% overall: monitoring 90%, research 50%', () => {
    const pairs = [
      ...Array.from({ length: 10 }, (_, i) =>
        i < 9
          ? { category: 'monitoring' as const, alpha: 'pass' as const, instinct: 'fail' as const }
          : { category: 'monitoring' as const, alpha: 'fail' as const, instinct: 'pass' as const },
      ),
      ...Array.from({ length: 10 }, (_, i) =>
        i < 5
          ? { category: 'research' as const, alpha: 'pass' as const, instinct: 'fail' as const }
          : { category: 'research' as const, alpha: 'blocked' as const, instinct: 'blocked' as const },
      ),
    ]
    const h2h = headToHeadFixture(pairs)
    // overall 14/20 = 70% >= 70% but research category 5/10 = 50% < 60%
    expect(h2h.overall.alpha_win_rate).toBeCloseTo(0.7, 10)
    const research = h2h.by_category.find((c) => c.category === 'research')
    expect(research!.alpha_win_rate).toBeCloseTo(0.5, 10)
    expect(h2h.alpha_meets_victory_rule).toBe(false)
  })

  it('ties count toward neither product but stay in the denominator (fixture: 2 wins, 3 losses, 1 tie)', () => {
    const h2h = scorecard(FIXTURE_RUNS, FIXTURE_MANIFEST).head_to_head
    expect(h2h.paired_prompts).toBe(6)
    expect(h2h.overall.alpha_wins).toBe(2)
    expect(h2h.overall.instinct_wins).toBe(3)
    expect(h2h.overall.ties).toBe(1)
    expect(h2h.overall.alpha_win_rate).toBeCloseTo(2 / 6, 10)
    expect(h2h.alpha_meets_victory_rule).toBe(false)
  })

  it('a false_completion loses the pairing even when the other product merely failed', () => {
    const h2h = headToHeadFixture([
      { category: 'research' as const, alpha: 'false_completion' as const, instinct: 'fail' as const },
    ])
    expect(h2h.overall.instinct_wins).toBe(1)
  })
})

/* ------------------------------------------------------------ freeze */

describe('freezeManifest / isFrozen', () => {
  it('is stable across key order and object identity', async () => {
    const shuffledTasks = FIXTURE_MANIFEST.tasks.map((t) => ({
      timeout_s: t.timeout_s,
      evidence_required: [...t.evidence_required],
      risk_tier: t.risk_tier,
      auth_required: t.auth_required,
      site: t.site,
      prompt: t.prompt,
      category: t.category,
      id: t.id,
    })) as BenchTask[]
    const a = await freezeManifest(FIXTURE_MANIFEST)
    const b = await freezeManifest({ tasks: shuffledTasks, version: 1, frozen_at: FIXTURE_MANIFEST.frozen_at } as BenchManifest)
    expect(a).toBe(b)
    expect(isFrozen(a)).toBe(true)
  })

  it('changes when any task content changes', async () => {
    const base = await freezeManifest(FIXTURE_MANIFEST)
    const tampered: BenchManifest = {
      ...FIXTURE_MANIFEST,
      tasks: FIXTURE_MANIFEST.tasks.map((t) => (t.id === 'b-purch' ? { ...t, prompt: t.prompt + ' PLEASE.' } : t)),
    }
    const other = await freezeManifest(tampered)
    expect(other).not.toBe(base)
  })

  it('refuses to freeze an invalid manifest', async () => {
    const broken = { ...FIXTURE_MANIFEST, tasks: [...FIXTURE_MANIFEST.tasks, { ...FIXTURE_MANIFEST.tasks[0]! }] }
    expect(freezeManifest(broken as BenchManifest)).rejects.toThrow(ManifestValidationError)
  })

  it('canonicalJson sorts keys but preserves array order', () => {
    expect(canonicalJson({ b: 1, a: [{ d: 2, c: 3 }] })).toBe('{"a":[{"c":3,"d":2}],"b":1}')
  })

  it('isFrozen rejects lookalikes', () => {
    expect(isFrozen('deadbeef')).toBe(false)
    expect(isFrozen('Z'.repeat(64))).toBe(false)
    expect(isFrozen(null)).toBe(false)
    expect(isFrozen('0'.repeat(64))).toBe(true)
  })
})

/* ---------------------------------------------------------- render */

describe('renderMarkdownScorecard', () => {
  const report = scorecard(FIXTURE_RUNS, FIXTURE_MANIFEST)
  const meta = { generatedAt: '2026-09-03T00:00:00.000Z', manifestVersion: 1 }

  it('renders a non-empty report containing category rows and the legend', () => {
    const md = renderMarkdownScorecard(report, meta)
    expect(md.length).toBeGreaterThan(400)
    expect(md).toContain('BLOCKED ≠ PASS')
    expect(md).toContain('# Frozen benchmark scorecard')
    for (const category of ['purchasing', 'travel', 'appointments', 'monitoring']) {
      expect(md).toContain(`| ${category} |`)
    }
    expect(md).toContain('## Incidents')
    expect(md).toContain('false_completion')
    expect(md).toContain('unapproved_action')
    expect(md).toContain('## Exclusions')
    expect(md).toContain('## Head-to-head')
    expect(md).toContain('70%')
    expect(md).toContain('60%')
  })

  it('lists exclusions with their reasons when present', () => {
    const withStray = scorecard(
      [...FIXTURE_RUNS, validateRunRecord(runFixture({ task_id: 'ghost-task' }))],
      FIXTURE_MANIFEST,
    )
    const md = renderMarkdownScorecard(withStray, meta)
    expect(md).toContain('| ghost-task |')
    expect(md).toContain('frozen manifest')
  })

  it('is deterministic: same input renders byte-identical output', () => {
    const r1 = renderMarkdownScorecard(scorecard(FIXTURE_RUNS, FIXTURE_MANIFEST), meta)
    const r2 = renderMarkdownScorecard(scorecard(FIXTURE_RUNS, FIXTURE_MANIFEST), meta)
    expect(r1).toBe(r2)
  })

  it('covers all nine frozen categories in the taxonomy', () => {
    expect(BENCH_CATEGORIES).toHaveLength(9)
    expect(new Set(BENCH_CATEGORIES).size).toBe(9)
  })
})
