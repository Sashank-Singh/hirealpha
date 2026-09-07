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
  },
): Promise<string> {
  const id = randomUUID()
  await sql`
    INSERT INTO hire_browser_jobs (id, user_id, persona, phone_e164, kind, url, steps, goal, status)
    VALUES (${id}, ${input.userId}, ${input.persona}, ${input.phone}, ${input.kind}, ${input.url},
      ${input.steps ? JSON.stringify(input.steps) : null}::jsonb, ${input.goal ?? null}, 'pending')
  `
  return id
}

/** Worker claim: stale running rows (>5 min) go back to pending, then SKIP LOCKED. */
export async function claimBrowserJobs(sql: SQL, limit: number): Promise<BrowserJobRow[]> {
  await sql`
    UPDATE hire_browser_jobs SET status = 'pending', claimed_at = NULL
    WHERE status = 'running' AND claimed_at < now() - interval '5 minutes'
  `
  const rows = (await sql`
    UPDATE hire_browser_jobs SET status = 'running', attempts = attempts + 1, claimed_at = now()
    WHERE id IN (
      SELECT id FROM hire_browser_jobs
      WHERE status = 'pending' AND attempts < 3
      ORDER BY created_at ASC
      LIMIT ${limit}
      FOR UPDATE SKIP LOCKED
    )
    RETURNING id, user_id AS "userId", persona, phone_e164 AS phone, kind, url, steps, goal, status, attempts, result, error
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
