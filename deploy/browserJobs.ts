/**
 * Browser job queue — moves Chromium work out of the web container.
 *
 * The web API owns the ask-first fence exactly as before (approval consume,
 * origin-scoped creds). With a worker configured it only ENQUEUES: the job
 * row is the contract, claimed by the browser-worker container with the same
 * SKIP LOCKED protocol as hire_task_loops. The worker runs the browser (or
 * the agent driver) and posts the outcome back to an internal endpoint,
 * which re-arms the thread-result loop. Web container: zero Chromium.
 */
import { randomUUID } from 'node:crypto'
import type { SQL } from 'bun'
import type { PortalStep, BrowserTaskKind } from './browserVault'

export type BrowserJobRow = {
  id: string
  user_id: string
  persona: string
  phone_e164: string | null
  kind: BrowserTaskKind
  url: string
  steps: PortalStep[] | null
  goal: string | null
  status: 'pending' | 'running' | 'done' | 'failed'
  attempts: number
  result: string | null
  error: string | null
  approval_id: string | null
}

export async function ensureBrowserJobsSchema(sql: SQL): Promise<void> {
  await sql`
    CREATE TABLE IF NOT EXISTS hire_browser_jobs (
      id UUID PRIMARY KEY,
      user_id UUID NOT NULL,
      persona TEXT NOT NULL,
      phone_e164 TEXT,
      kind TEXT NOT NULL,
      url TEXT NOT NULL,
      steps JSONB,
      goal TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      attempts INTEGER NOT NULL DEFAULT 0,
      result TEXT,
      error TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      claimed_at TIMESTAMPTZ,
      finished_at TIMESTAMPTZ
    )
  `
  await sql`ALTER TABLE hire_browser_jobs ADD COLUMN IF NOT EXISTS approval_id UUID`
  await sql`CREATE UNIQUE INDEX IF NOT EXISTS idx_hire_browser_jobs_approval ON hire_browser_jobs (approval_id) WHERE approval_id IS NOT NULL`
  await sql`CREATE INDEX IF NOT EXISTS idx_hire_browser_jobs_status ON hire_browser_jobs (status, created_at)`
}

export async function enqueueBrowserJob(
  sql: SQL,
  input: {
    userId: string
    persona: string
    phone: string | null
    kind: BrowserTaskKind
    url: string
    steps?: PortalStep[] | null
    goal?: string | null
    approvalId?: string | null
  },
): Promise<string> {
  const target = new URL(input.url)
  if (target.protocol !== 'https:' || target.username || target.password) throw new Error('Browser target must be a public HTTPS URL without embedded credentials.')
  const id = randomUUID()
  await sql`
    INSERT INTO hire_browser_jobs (id, user_id, persona, phone_e164, kind, url, steps, goal, status, approval_id)
    VALUES (${id}, ${input.userId}, ${input.persona}, ${input.phone}, ${input.kind}, ${target.href},
      ${input.steps ? JSON.stringify(input.steps) : null}::jsonb, ${input.goal ?? null}, 'pending', ${input.approvalId ?? null})
  `
  return id
}

/** Claim only fresh approvals scoped to this user and origin. Interrupted jobs
 * fail with an unknown outcome instead of automatically repeating side effects. */
export async function claimBrowserJobs(sql: SQL, limit: number): Promise<BrowserJobRow[]> {
  await sql`
    UPDATE hire_browser_jobs SET status = 'failed', error = 'Worker interrupted; outcome unknown. Review before retrying.', finished_at = now()
    WHERE status = 'running' AND claimed_at < now() - interval '5 minutes'
  `
  // Ask-first sweep: a denied approval kills its queued job; an unapproved one waits.
  await sql`
    UPDATE hire_browser_jobs j SET status = 'failed', error = 'Approval denied', finished_at = now()
    FROM hire_browser_approvals a
    WHERE j.approval_id = a.id AND a.status = 'denied' AND j.status = 'pending'
  `
  const rows = (await sql`
    UPDATE hire_browser_jobs SET status = 'running', attempts = attempts + 1, claimed_at = now()
    WHERE id IN (
      SELECT j.id FROM hire_browser_jobs j
      JOIN hire_browser_approvals a ON a.id = j.approval_id AND a.user_id = j.user_id AND a.persona = j.persona
      WHERE j.status = 'pending' AND j.attempts < 3
        AND a.status = 'approved' AND a.consumed_at IS NULL
        AND a.created_at > now() - interval '10 minutes'
        AND a.origin = substring(j.url from '^https://[^/]+')
      ORDER BY j.created_at ASC
      LIMIT ${limit}
      FOR UPDATE OF j SKIP LOCKED
    )
    RETURNING id, user_id, persona, phone_e164, kind, url, steps, goal, status, attempts, result, error, approval_id
  `) as unknown as BrowserJobRow[]
  return rows
}

export async function finishBrowserJob(
  sql: SQL,
  id: string,
  outcome: { ok: true; result: string } | { ok: false; error: string; retry?: boolean },
): Promise<void> {
  if (outcome.ok) {
    await sql`
      UPDATE hire_browser_jobs SET status = 'done', result = ${outcome.result}, finished_at = now()
      WHERE id = ${id}
    `
    return
  }
  if (outcome.retry) {
    // Back to pending; attempts guard on claim decides the final verdict.
    await sql`
      UPDATE hire_browser_jobs SET status = 'pending', error = ${outcome.error}
      WHERE id = ${id} AND attempts < 3
    `
    await sql`
      UPDATE hire_browser_jobs SET status = 'failed', error = ${outcome.error}, finished_at = now()
      WHERE id = ${id} AND attempts >= 3
    `
    return
  }
  await sql`
    UPDATE hire_browser_jobs SET status = 'failed', error = ${outcome.error}, finished_at = now()
    WHERE id = ${id}
  `
}

export async function getBrowserJob(sql: SQL, id: string, userId?: string): Promise<BrowserJobRow | null> {
  const rows = (await sql`
    SELECT id, user_id AS "userId", persona, phone_e164 AS phone, kind, url, steps, goal, status, attempts, result, error
    FROM hire_browser_jobs WHERE id = ${id} ${userId ? sql`AND user_id = ${userId}` : sql``} LIMIT 1
  `) as unknown as BrowserJobRow[]
  return rows[0] ?? null
}
