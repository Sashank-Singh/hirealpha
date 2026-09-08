/**
 * The browser-worker entry: a dedicated container that owns Chromium.
 *
 * Loop: claim pending hire_browser_jobs rows (SKIP LOCKED, same protocol as
 * task loops) → run the session (scripted steps, agent-driven goal, or the
 * classic login+scrape) → close the job and queue the thread text. Nothing
 * persists between jobs — fresh context per task, closed in a finally.
 *
 * Env: DATABASE_URL, GMI_API_KEY (agent mode), WORKER_CONCURRENCY (default 2),
 * HIREALPHA_VAULT_KEY / OP_* (via the vault functions).
 */
import { SQL } from 'bun'
import { consumeBrowserApproval, ensureBrowserVaultSchema, getVaultCredentialsForTask, pushBrowserResultLoop } from './browserVault'
import { vaultKey } from './vaultCrypto'
import { runBrowserSession } from './browserSession'
import { claimBrowserJobs, ensureBrowserJobsSchema, finishBrowserJob, type BrowserJobRow } from './browserJobs'

const DATABASE_URL = process.env.DATABASE_URL || ''
const CONCURRENCY = Math.max(Number(process.env.WORKER_CONCURRENCY) || 2, 1)
const POLL_MS = 3000

function hostOf(url: string): string {
  try {
    return new URL(url).host || url
  } catch {
    return url
  }
}

type JobRow = BrowserJobRow

type JobOutcome = { ok: true; result: string } | { ok: false; error: string }

export async function runJob(sql: SQL, job: JobRow, launch = runBrowserSession): Promise<JobOutcome> {
  const key = vaultKey()
  const origin = (() => {
    try {
      return new URL(job.url).origin
    } catch {
      return null
    }
  })()
  if (!origin || !job.url.startsWith('https:')) return { ok: false, error: 'Job URL must be https.' }

  if (!job.approval_id) return { ok: false, error: 'A one-time approval is required.' }
  const gate = await consumeBrowserApproval(sql, job.user_id, job.approval_id, origin)
  if (gate !== 'ok') return { ok: false, error: `Approval could not be consumed: ${gate}` }
  const creds = key ? await getVaultCredentialsForTask(sql, job.user_id, origin, key) : null

  const kind = job.kind as 'newsletter' | 'ticker' | 'task'
  const run = await launch({
    url: job.url,
    username: creds?.username || '',
    password: creds?.password || '',
    kind,
    steps: (job.steps as never) || undefined,
    goal: job.goal || undefined,
  })
  return run.ok ? { ok: true, result: run.content } : { ok: false, error: run.error }
}

async function report(sql: SQL, job: JobRow, outcome: JobOutcome): Promise<void> {
  if (outcome.ok) {
    await sql`UPDATE hire_browser_jobs SET status = 'done', result = ${outcome.result}, finished_at = now() WHERE id = ${job.id}`
    await pushBrowserResultLoop(sql, { userId: job.user_id, persona: job.persona, origin: job.url, insights: outcome.result })
    return
  }
  // Do not replay a task that may already have submitted a form or order.
  await finishBrowserJob(sql, job.id, { ok: false, error: outcome.error })
  await pushBrowserResultLoop(sql, {
    userId: job.user_id,
    persona: job.persona,
    origin: job.url,
    insights: `Couldn't check ${hostOf(job.url)}: ${outcome.error.slice(0, 200)}`,
  })
}

async function main() {
  if (!DATABASE_URL) {
    console.error('[browser-worker] fatal: DATABASE_URL missing')
    process.exit(1)
  }
  const sql = new SQL(DATABASE_URL, { max: 4, idleTimeout: 30, connectionTimeout: 10, connection: { options: '-c timezone=UTC' } })
  await ensureBrowserVaultSchema(sql)
  await ensureBrowserJobsSchema(sql)
  Bun.serve({
    port: Number(process.env.WORKER_HEALTH_PORT || 3000),
    async fetch(request) {
      if (new URL(request.url).pathname !== '/healthz') return new Response('Not found', { status: 404 })
      try { await sql`SELECT 1`; return new Response('ok') }
      catch { return new Response('Database unavailable', { status: 503 }) }
    },
  })
  console.log(`[browser-worker] up: concurrency=${CONCURRENCY}`)

  let busy = 0
  const tick = async () => {
    if (busy >= CONCURRENCY) return
    busy++
    try {
      const rows = await claimBrowserJobs(sql, 1)
      const job = rows[0]
      if (!job) return
      console.log(`[browser-worker] job ${job.id} (${job.kind}${job.goal ? ', agent' : ''}) for ${job.persona}:${job.user_id}`)
      const outcome = await runJob(sql, job).catch((err) => ({ ok: false as const, error: err instanceof Error ? err.message : String(err) }))
      await report(sql, job, outcome).catch((err) => console.warn('[browser-worker] report failed', err))
    } catch (err) {
      console.warn('[browser-worker] tick failed', err)
    } finally {
      busy--
    }
  }

  await tick()
  setInterval(() => void tick(), POLL_MS)
  // Worker runs forever; Bun keeps the interval alive.
  await new Promise(() => {})
}

if (import.meta.main) await main()
