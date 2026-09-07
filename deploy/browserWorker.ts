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
import { getVaultCredentialsForTask, pushBrowserResultLoop } from './browserVault'
import { vaultKey } from './vaultCrypto'
import { runBrowserSession } from './browserSession'

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

type JobRow = {
  id: string
  user_id: string
  persona: string
  phone_e164: string | null
  kind: string
  url: string
  steps: unknown
  goal: string | null
}

type JobOutcome = { ok: true; result: string } | { ok: false; error: string }

async function runJob(sql: SQL, job: JobRow): Promise<JobOutcome> {
  const key = vaultKey()
  if (!key) return { ok: false, error: 'Vault key not configured.' }
  const origin = (() => {
    try {
      return new URL(job.url).origin
    } catch {
      return null
    }
  })()
  if (!origin || !job.url.startsWith('https:')) return { ok: false, error: 'Job URL must be https.' }

  const creds = await getVaultCredentialsForTask(sql, job.user_id, origin, key)
  if (!creds) return { ok: false, error: 'No saved login for that portal.' }

  const kind = job.kind as 'newsletter' | 'ticker' | 'task'
  const run = await runBrowserSession({
    url: job.url,
    username: creds.username,
    password: creds.password,
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
  // Retryable failures (network, page flake) go back to pending while the
  // attempts guard still allows it; terminal failures close the row.
  if (job.kind === 'task') {
    await sql`
      UPDATE hire_browser_jobs SET status = 'pending', error = ${outcome.error}
      WHERE id = ${job.id} AND attempts < 3
    `
    const still = (await sql`
      UPDATE hire_browser_jobs SET status = 'failed', error = ${outcome.error}, finished_at = now()
      WHERE id = ${job.id} AND attempts >= 3 RETURNING id
    `) as Array<{ id: string }>
    if (!still.length) return
  } else {
    await sql`UPDATE hire_browser_jobs SET status = 'failed', error = ${outcome.error}, finished_at = now() WHERE id = ${job.id}`
  }
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
  console.log(`[browser-worker] up: concurrency=${CONCURRENCY}`)

  let busy = 0
  const tick = async () => {
    if (busy >= CONCURRENCY) return
    busy++
    try {
      const rows = (await sql`
        UPDATE hire_browser_jobs SET status = 'running', attempts = attempts + 1, claimed_at = now()
        WHERE id = (
          SELECT id FROM hire_browser_jobs
          WHERE status = 'pending' AND attempts < 3
          ORDER BY created_at ASC LIMIT 1 FOR UPDATE SKIP LOCKED
        )
        RETURNING id, user_id, persona, phone_e164, kind, url, steps, goal
      `) as unknown as JobRow[]
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
  setInterval(() => void tick(), POLL_MS).unref?.()
  // Worker runs forever; Bun keeps the interval alive.
  await new Promise(() => {})
}

await main()
