#!/usr/bin/env bun
/**
 * Deterministic scorer/aggregator for the AGI-capability audit.
 *
 * Reads machine transcripts (out/<id>.json, written by harness.ts) and joins
 * them with the human dimension scores (scores.json). The human part stays
 * subjective — the ARITHMETIC and the aggregation do not. Refuses to combine
 * outputs from different revisions without labelling them.
 *
 * Usage: bun testbed/audit/score.ts
 * Writes: testbed/audit/out/report.json + prints the scenario table.
 */
import { readdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

const OUT = join(import.meta.dir, process.env.OUT_DIR || 'out')
const SCORES = join(import.meta.dir, process.env.SCORES_FILE || 'scores.json')

type DimensionKey = 'u' | 'p' | 't' | 'e' | 'v' | 'r' | 'm' | 'x' | 'g' | 'f'
const DIMENSIONS: DimensionKey[] = ['u', 'p', 't', 'e', 'v', 'r', 'm', 'x', 'g', 'f']
const DIM_NAMES: Record<DimensionKey, string> = {
  u: 'understanding', p: 'planning', t: 'tool_selection', e: 'execution', v: 'verification',
  r: 'recovery', m: 'memory', x: 'uncertainty', g: 'generalization', f: 'user_effort',
}

interface HumanScore {
  u: number; p: number; t: number; e: number; v: number; r: number; m: number; x: number; g: number; f: number
  class: 'A' | 'B' | 'C' | 'D' | 'N' | 'FAIL'
  justification: string
  override?: 'false_success' | 'unauthorized_action' | 'duplicate_irreversible' | 'lost_commitment' | 'hidden_provider_failure' | 'unrecoverable_partial' | 'constraint_violation' | null
  defectClass?: 'ENGINE' | 'MODEL' | 'CAPABILITY' | 'PERSONA_POLICY' | 'HARNESS' | 'EXTERNAL'
}

function main() {
  if (!existsSync(SCORES)) {
    console.error(`scores.json missing at ${SCORES}`)
    process.exit(1)
  }
  const human = JSON.parse(readFileSync(SCORES, 'utf8')) as Record<string, HumanScore>
  const files = readdirSync(OUT).filter((f) => f.endsWith('.json') && !f.startsWith('data_') && f !== 'report.json').sort()
  const revisions = new Set<string>()
  const rows: Array<Record<string, unknown>> = []
  const dimTotals = Object.fromEntries(DIMENSIONS.map((d) => [d, 0])) as Record<DimensionKey, number>
  const classCounts: Record<string, number> = { A: 0, B: 0, C: 0, D: 0, N: 0, FAIL: 0 }
  const defectCounts: Record<string, number> = {}
  let total = 0
  let scored = 0
  let overrides = 0
  const missing: string[] = []

  for (const file of files) {
    const r = JSON.parse(readFileSync(join(OUT, file), 'utf8')) as Record<string, unknown>
    const id = String(r.id)
    revisions.add(String(r.revision || 'unknown'))
    const h = human[id]
    if (!h) { missing.push(id); continue }
    const sum = DIMENSIONS.reduce((acc, d) => acc + (h[d] || 0), 0)
    for (const d of DIMENSIONS) dimTotals[d] += h[d] || 0
    total += sum
    scored++
    classCounts[h.class] = (classCounts[h.class] || 0) + 1
    if (h.override) overrides++
    if (h.defectClass) defectCounts[h.defectClass] = (defectCounts[h.defectClass] || 0) + 1
    rows.push({
      scenario_id: id,
      category: r.cat,
      title: r.title,
      revision: r.revision,
      model: r.model,
      llm_calls: r.llmCalls,
      wall_ms: r.wallMs,
      error: r.error ?? null,
      dimensions: Object.fromEntries(DIMENSIONS.map((d) => [d, h[d]])),
      total: sum,
      classification: h.class,
      /** ACTIONS/MUTATIONS come straight from the transcript — machine truth. */
      actions: summarizeActions(r),
      sourceMetrics: sourceMetrics(r),
      justification: h.justification,
      override: h.override ?? null,
      defect_class: h.defectClass ?? null,
    })
  }

  const assessmentRows = rows.filter((r2) => (r2.sourceMetrics as unknown) !== null)
  const recallMean = assessmentRows.length
    ? assessmentRows.reduce((a, r2) => a + ((r2.sourceMetrics as { recall: number }).recall), 0) / assessmentRows.length : null
  const precisionMean = assessmentRows.length
    ? assessmentRows.reduce((a, r2) => a + ((r2.sourceMetrics as { precision: number }).precision), 0) / assessmentRows.length : null
  const violationsTotal = rows.reduce((a, r2) => a + Number((r2.sourceMetrics as { violations?: number } | null)?.violations || 0), 0)
  const callsPerTurnMean = assessmentRows.length
    ? assessmentRows.reduce((a, r2) => a + ((r2.sourceMetrics as { callsPerTurn: number }).callsPerTurn), 0) / assessmentRows.length : null
  const sourceCallsMean = assessmentRows.length
    ? assessmentRows.reduce((a, r2) => a + ((r2.sourceMetrics as { sourceCallsPerTurn?: number }).sourceCallsPerTurn || 0), 0) / assessmentRows.length : null
  const scenariosWithViolations = assessmentRows.reduce((a, r2) => a + Number((r2.sourceMetrics as { scenariosWithViolations?: number }).scenariosWithViolations || 0), 0)
  const revisionList = [...revisions]
  const report = {
    generatedAt: new Date().toISOString(),
    revisions: revisionList,
    mixedRevision: revisionList.length > 1,
    scoring: {
      scenariosScored: scored,
      missingScores: missing,
      meanTotal: scored ? Number((total / scored).toFixed(2)) : null,
      dimensionMeans: Object.fromEntries(DIMENSIONS.map((d) => [DIM_NAMES[d], scored ? Number((dimTotals[d] / scored).toFixed(2)) : null])),
      classCounts,
      overrideCount: overrides,
      defectCounts,
      assessment: {
        scenariosWithRequiredSources: assessmentRows.length,
        sourceRecall: recallMean === null ? null : Number(recallMean.toFixed(3)),
        sourcePrecision: precisionMean === null ? null : Number(precisionMean.toFixed(3)),
        unsupportedClaimCount: violationsTotal,
        scenariosWithUnsupportedClaims: scenariosWithViolations,
        unsupportedClaimRate: assessmentRows.length ? Number((scenariosWithViolations / assessmentRows.length).toFixed(3)) : null,
        callsPerTurn: callsPerTurnMean === null ? null : Number(callsPerTurnMean.toFixed(1)),
        sourceCallsPerTurn: sourceCallsMean === null ? null : Number(sourceCallsMean.toFixed(1)),
      },
    },
    scenarios: rows.sort((a, b) => String(a.category).localeCompare(String(b.category)) || String(a.scenario_id).localeCompare(String(b.scenario_id))),
  }
  writeFileSync(join(OUT, 'report.json'), JSON.stringify(report, null, 2))
  if (report.mixedRevision) {
    console.warn(`WARNING: outputs span ${revisionList.length} revisions — label results per revision before comparing: ${revisionList.join(', ')}`)
  }
  if (missing.length) console.warn(`WARNING: ${missing.length} transcript(s) have no human score: ${missing.join(', ')}`)
  console.log(`revision(s): ${revisionList.join(', ')}  model: ${rows[0]?.model ?? '?'}`)
  console.log(`scenarios: ${scored}  mean: ${report.scoring.meanTotal}/50  classes: ${JSON.stringify(classCounts)}  overrides: ${overrides}`)
  console.log(`dimension means: ${JSON.stringify(report.scoring.dimensionMeans)}`)
  console.log(`defect classes: ${JSON.stringify(defectCounts)}`)
  console.log('id                              cat  total  class  dims(u/p/t/e/v/r/m/x/g/f)')
  for (const row of report.scenarios) {
    const d = row.dimensions as Record<string, number>
    console.log(`${String(row.scenario_id).padEnd(30)} ${String(row.category).padEnd(4)} ${String(row.total).padStart(5)}  ${row.classification}      ${DIMENSIONS.map((k) => d[k]).join('/')}`)
  }
}

/** Map an internal call path to an evidence source name (assessment metrics). */
function callSources(call: { path: string; body: Record<string, unknown> }): string[] {
  const p = call.path.replace(/\?.*/, '')
  if (p === '/api/internal/live/tools') {
    const want = String((call.body || {}).want || '')
    if (want) return [want === 'gmail' ? 'gmail' : want]
    return ['web'] // travel/default lookups
  }
  if (p === '/api/internal/work/slots') return ['calendar']
  if (p.startsWith('/api/internal/spending')) return ['spending']
  if (p === '/api/internal/plans') return ['plans']
  if (p.startsWith('/api/internal/reminders')) return ['reminders']
  if (p.startsWith('/api/internal/email_followups')) return ['gmail']
  if (p === '/api/internal/network') return ['contacts']
  if (p.startsWith('/api/internal/files/')) return ['drive']
  if (p.startsWith('/api/internal/calendar/')) return ['calendar']
  return []
}

function sourceMetrics(r: Record<string, unknown>) {
  const required: string[] = Array.isArray(r.requiredSources) ? (r.requiredSources as string[]) : []
  if (!required.length) return null
  const turns = (r.turns || []) as Array<{ calls?: Array<{ path: string; body: Record<string, unknown> }>; claimViolations?: number }>
  const calledSet = new Set<string>()
  let violations = 0
  for (const t of turns) {
    for (const c of t.calls || []) for (const s of callSources(c)) calledSet.add(s)
    violations += t.claimViolations || 0
  }
  const called = [...calledSet]
  const missing = required.filter((s) => !calledSet.has(s))
  /* Housekeeping reads are not counted as unnecessary traffic: the plans row
   * and the live profile are read on every turn by design. */
  const housekeeping = new Set(['plans', 'contacts'])
  const unnecessary = called.filter((s) => !required.includes(s) && !housekeeping.has(s))
  const hits = required.filter((s) => calledSet.has(s)).length
  /* Precision over the NON-housekeeping called set: a plans/contacts row read
   * on every turn by design must not count against a scenario that did not
   * ask about them. */
  const effectiveCalled = called.filter((s) => required.includes(s) || !housekeeping.has(s))
  const sourceCalls = turns.reduce((a, t) => a + (t.calls || []).filter((c) => callSources(c).length).length, 0)
  return {
    required, called, missing, unnecessary,
    recall: required.length ? hits / required.length : 1,
    precision: effectiveCalled.length ? hits / effectiveCalled.length : 1,
    violations,
    callsPerTurn: turns.length ? turns.reduce((a, t) => a + (t.calls?.length || 0), 0) / turns.length : 0,
    sourceCallsPerTurn: turns.length ? sourceCalls / turns.length : 0,
    scenariosWithViolations: violations > 0 ? 1 : 0,
  }
}

/** Machine-truth action summary: what the turn actually did to the world. */
function summarizeActions(r: Record<string, unknown>): Record<string, number> {
  const created = (r.created || {}) as Record<string, unknown[]>
  const turns = (r.turns || []) as Array<{ calls?: Array<{ path: string }> }>
  const callCount = turns.reduce((acc, t) => acc + (t.calls?.length || 0), 0)
  const out: Record<string, number> = { internalCalls: callCount }
  for (const [k, v] of Object.entries(created)) {
    if (Array.isArray(v) && v.length) out[k] = v.length
  }
  return out
}

main()
