/**
 * Provider certification harness.
 *
 * Run:  bun run scripts/certify.ts
 *
 * Each suite is either executed for real (`bun test <file>`) or recorded as
 * BLOCKED with the exact missing configuration. A suite blocked on missing
 * credentials is never counted as a pass — the summary makes that impossible
 * to miss. Evidence lands in marketing/evidence/certification/<date>/ and is
 * committed (results only — never environment values).
 */
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { validateEnvironment, type Surface } from '../deploy/certification/envContract'

type Suite = {
  name: string
  kind: 'bun-test' | 'manual'
  file?: string
  surface?: Surface
  required?: string[]
  manualSteps?: string[]
}

const suites: Suite[] = [
  { name: 'unit-regression', kind: 'bun-test', file: 'deploy/browserWorker.test.ts deploy/browserJobs.test.ts services/trust/' },
  { name: 'postgres-migrations-and-isolation', kind: 'bun-test', file: 'deploy/certification/postgres.live.test.ts', surface: 'certification', required: ['CERT_DATABASE_URL', 'CERT_ALLOW_LIVE'] },
  { name: 'openbao-isolation-and-rotation', kind: 'bun-test', file: 'deploy/certification/openbao.live.test.ts', surface: 'openbao', required: ['OPENBAO_ADDR', 'OPENBAO_TOKEN'] },
  { name: 'e2b-fresh-sandbox-and-destruction', kind: 'bun-test', file: 'deploy/certification/e2b.live.test.ts', surface: 'e2b', required: ['E2B_API_KEY', 'E2B_BROWSER_TEMPLATE'] },
  {
    name: 'stripe-link-test-mode-lifecycle', kind: 'manual', surface: 'stripe',
    required: ['STRIPE_SECRET_KEY (restricted)', 'STRIPE_WEBHOOK_SECRET', 'a Link-connected test user'],
    manualSteps: [
      'Connect a Link wallet for the staging test user (Settings → Payments).',
      'Ask Alpha to stage a purchase; confirm merchant + exact total appear on the approval page before any approval.',
      'Approve in Link; verify exactly one browser job is queued and one capability grant is approved.',
      'Complete the checkout on the staging merchant; verify one order confirmation, capability consumed, spend row consumed.',
      'Second run against the same grant must fail (one-time credential).',
      'Deny, expire, and cancel paths: each must close the capability grant and produce no charge.',
      'Replay the payment_intent.succeeded webhook; finalization must stay idempotent (already_queued, no second job).',
      'No real charge — use Stripe test mode throughout.',
    ],
  },
  {
    name: 'vault-end-to-end-autofill', kind: 'manual', surface: 'openbao',
    required: ['OPENBAO_ADDR', 'OPENBAO_TOKEN', 'staging site with a login form', 'E2B_API_KEY + E2B_BROWSER_TEMPLATE'],
    manualSteps: [
      'Save a credential for the staging site (Trust → Vault).',
      'Ask Alpha to sign in to the staging site; approve the exact-site request in Trust & Audit.',
      'Verify the login succeeds, the grant shows consumed, and a second task for the same site is refused.',
      'Revoke the item; a queued task must fail closed.',
      'Grep worker + sandbox logs for the plaintext password: zero hits required.',
    ],
  },
  {
    name: 'load-and-queue-latency', kind: 'manual', surface: 'certification',
    required: ['staging deployment'],
    manualSteps: [
      'Enqueue 20 browser jobs for 5 synthetic users at 1 job/s.',
      'Record queue wait, E2B startup, and end-to-end latency percentiles (p50/p95).',
      'Verify no two jobs shared a sandbox id and all sandboxes were destroyed.',
      'Record cost per task from the E2B dashboard.',
    ],
  },
]

function evidenceDir(): string {
  const date = new Date().toISOString().slice(0, 10)
  const base = join(import.meta.dir, '..', 'marketing', 'evidence', 'certification', date)
  let dir = base
  let n = 2
  while (Bun.file(join(dir, 'results.json')).size > 0) {
    dir = `${base}-${n++}`
  }
  return dir
}

const results: Array<Record<string, unknown>> = []
let failures = 0
let blocked = 0

for (const suite of suites) {
  const stamp = new Date().toISOString()
  if (suite.kind === 'manual' || suite.surface) {
    const missing = suite.surface ? validateEnvironment(suite.surface as Surface).missing : []
    const manualMissing = suite.required && suite.kind === 'manual' ? suite.required : []
    const allMissing = [...new Set([...manualMissing, ...missing])]
    if (allMissing.length) {
      blocked++
      results.push({
        suite: suite.name, status: 'BLOCKED', at: stamp,
        missingConfiguration: allMissing,
        howToUnblock: 'See deploy/env-contract.md',
        ...(suite.manualSteps ? { requiredSteps: suite.manualSteps } : {}),
      })
      console.log(`BLOCKED  ${suite.name} — missing: ${allMissing.join(', ')}`)
      continue
    }
  }
  if (suite.kind === 'manual') {
    // Configured but not yet executed by an operator.
    blocked++
    results.push({ suite: suite.name, status: 'BLOCKED', at: stamp, reason: 'manual suite not yet executed', requiredSteps: suite.manualSteps })
    console.log(`BLOCKED  ${suite.name} — manual suite not yet executed`)
    continue
  }
  const proc = Bun.spawnSync(['bun', 'test', ...suite.file!.split(' ')], {
    env: { ...process.env, CERT_ALLOW_LIVE: process.env.CERT_ALLOW_LIVE || '' },
    stdout: 'pipe', stderr: 'pipe',
  })
  const output = `${proc.stdout.toString()}${proc.stderr.toString()}`.slice(-20_000)
  const status = proc.exitCode === 0 ? 'PASS' : 'FAIL'
  if (status === 'FAIL') failures++
  results.push({ suite: suite.name, status, at: stamp, exitCode: proc.exitCode, tail: output })
  console.log(`${status}  ${suite.name}`)
}

const dir = evidenceDir()
await mkdir(dir, { recursive: true })
await Bun.write(join(dir, 'results.json'), JSON.stringify({ generatedAt: new Date().toISOString(), failures, blocked, results }, null, 2))
const lines = [
  `# Certification run — ${new Date().toISOString()}`,
  '',
  `PASS: ${results.filter((r) => r.status === 'PASS').length} · FAIL: ${failures} · BLOCKED: ${blocked}`,
  '',
  'A BLOCKED suite is missing configuration or operator execution — it is not a pass. Unblocking instructions: deploy/env-contract.md.',
  '',
  ...results.map((r) => `- **${r.suite}** — ${r.status}${r.missingConfiguration ? ` (missing: ${(r.missingConfiguration as string[]).join(', ')})` : ''}`),
  '',
  'Full machine results: results.json (includes captured test output tails; no environment values).',
]
await Bun.write(join(dir, 'summary.md'), lines.join('\n'))
console.log(`\nevidence: ${dir}`)
if (failures > 0) process.exit(1)
