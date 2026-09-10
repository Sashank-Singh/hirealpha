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
import { randomBytes, randomUUID, createHmac, timingSafeEqual } from 'node:crypto'
import type { SQL } from 'bun'
import type { PortalStep, BrowserTaskKind } from './browserVault'
import { assertPublicHttpsUrl, type HostResolver } from './browserNetworkPolicy'

export type BrowserJobRow = {
  id: string
  user_id: string
  persona: string
  phone_e164: string | null
  kind: BrowserTaskKind
  url: string
  steps: PortalStep[] | null
  goal: string | null
  status: 'pending' | 'running' | 'waiting' | 'done' | 'failed'
  attempts: number
  result: string | null
  error: string | null
  approval_id: string | null
  vault_item_id: string | null
  credential_capability_id: string | null
  credential_capability_digest: string | null
  credential_task_id: string | null
  spend_request_id: string | null
  current_url: string | null
  activity: Array<{ action: string; at: string }>
  handoff_kind: 'password' | 'verification' | 'payment' | 'captcha' | 'confirmation' | null
  handoff_message: string | null
  handoff_at: Date | null
  handoff_resumed_at: Date | null
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
  await sql`ALTER TABLE hire_browser_jobs ADD COLUMN IF NOT EXISTS vault_item_id UUID`
  await sql`ALTER TABLE hire_browser_jobs ADD COLUMN IF NOT EXISTS credential_capability_id UUID`
  await sql`ALTER TABLE hire_browser_jobs ADD COLUMN IF NOT EXISTS credential_capability_digest TEXT`
  await sql`ALTER TABLE hire_browser_jobs ADD COLUMN IF NOT EXISTS credential_task_id TEXT`
  await sql`ALTER TABLE hire_browser_jobs ADD COLUMN IF NOT EXISTS spend_request_id UUID`
  await sql`ALTER TABLE hire_browser_jobs ADD COLUMN IF NOT EXISTS current_url TEXT`
  await sql`ALTER TABLE hire_browser_jobs ADD COLUMN IF NOT EXISTS activity JSONB NOT NULL DEFAULT '[]'::jsonb`
  await sql`ALTER TABLE hire_browser_jobs ADD COLUMN IF NOT EXISTS handoff_kind TEXT`
  await sql`ALTER TABLE hire_browser_jobs ADD COLUMN IF NOT EXISTS handoff_message TEXT`
  await sql`ALTER TABLE hire_browser_jobs ADD COLUMN IF NOT EXISTS handoff_at TIMESTAMPTZ`
  await sql`ALTER TABLE hire_browser_jobs ADD COLUMN IF NOT EXISTS handoff_resumed_at TIMESTAMPTZ`
  await sql`CREATE UNIQUE INDEX IF NOT EXISTS idx_hire_browser_jobs_approval ON hire_browser_jobs (approval_id) WHERE approval_id IS NOT NULL`
  await sql`CREATE UNIQUE INDEX IF NOT EXISTS idx_hire_browser_jobs_spend_request ON hire_browser_jobs (spend_request_id) WHERE spend_request_id IS NOT NULL`
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
    vaultItemId?: string | null
    credentialCapabilityId?: string | null
    credentialCapabilityDigest?: string | null
    credentialTaskId?: string | null
    spendRequestId?: string | null
    idempotencyId?: string
    resolveHost?: HostResolver
  },
): Promise<string> {
  const target = await assertPublicHttpsUrl(input.url, input.resolveHost)
  const id = input.idempotencyId || randomUUID()
  await sql`
    INSERT INTO hire_browser_jobs (
      id, user_id, persona, phone_e164, kind, url, steps, goal, status, approval_id,
      vault_item_id, credential_capability_id, credential_capability_digest, credential_task_id, spend_request_id
    )
    VALUES (${id}, ${input.userId}, ${input.persona}, ${input.phone}, ${input.kind}, ${target.href},
      ${input.steps ? JSON.stringify(input.steps) : null}::jsonb, ${input.goal ?? null}, 'pending', ${input.approvalId ?? null},
      ${input.vaultItemId ?? null}, ${input.credentialCapabilityId ?? null}, ${input.credentialCapabilityDigest ?? null},
      ${input.credentialTaskId ?? null}, ${input.spendRequestId ?? null})
    ON CONFLICT (id) DO NOTHING
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
  await sql`
    UPDATE hire_browser_jobs j SET status = 'failed', error = 'Capability denied or expired', finished_at = now()
    FROM capability_grants g
    WHERE j.credential_capability_id = g.id AND g.status IN ('denied', 'revoked', 'expired') AND j.status = 'pending'
  `
  const rows = (await sql`
    UPDATE hire_browser_jobs SET status = 'running', attempts = attempts + 1, claimed_at = now()
    WHERE id IN (
      SELECT j.id FROM hire_browser_jobs j
      LEFT JOIN hire_browser_approvals a ON a.id = j.approval_id AND a.user_id = j.user_id AND a.persona = j.persona
      LEFT JOIN capability_grants g ON g.id = j.credential_capability_id AND g.user_id = j.user_id
      WHERE j.status = 'pending' AND j.attempts < 3
        AND (
          (j.credential_capability_id IS NOT NULL
            AND g.status = 'approved' AND g.expires_at > now()
            AND g.task_id = j.credential_task_id
            AND encode(g.request_digest, 'hex') = j.credential_capability_digest
            AND g.resource_id = j.vault_item_id::text
            AND g.action = 'autofill'
            AND g.exact_origin = substring(j.url from '^https://[^/]+'))
          OR
          (j.credential_capability_id IS NULL
            AND a.status = 'approved' AND a.consumed_at IS NULL
            AND a.created_at > now() - interval '10 minutes'
            AND a.origin = substring(j.url from '^https://[^/]+'))
        )
      ORDER BY j.created_at ASC
      LIMIT ${limit}
      FOR UPDATE OF j SKIP LOCKED
    )
    RETURNING id, user_id, persona, phone_e164, kind, url, steps, goal, status, attempts, result, error, approval_id,
      vault_item_id, credential_capability_id, credential_capability_digest, credential_task_id, spend_request_id,
      current_url, activity, handoff_kind, handoff_message, handoff_at, handoff_resumed_at
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
    SELECT id, user_id, persona, phone_e164, kind, url, steps, goal, status, attempts, result, error, approval_id,
      vault_item_id, credential_capability_id, credential_capability_digest, credential_task_id, spend_request_id,
      current_url, activity, handoff_kind, handoff_message, handoff_at, handoff_resumed_at
    FROM hire_browser_jobs WHERE id = ${id} ${userId ? sql`AND user_id = ${userId}` : sql``} LIMIT 1
  `) as unknown as BrowserJobRow[]
  return rows[0] ?? null
}

export type BrowserHandoffKind = NonNullable<BrowserJobRow['handoff_kind']>

/** Only coarse actions enter the activity stream. Never persist field values or
 * page text: passwords and verification codes belong only in the live browser. */
export async function appendBrowserActivity(sql: SQL, id: string, action: string, currentUrl: string): Promise<void> {
  const event = JSON.stringify([{ action: action.slice(0, 40), at: new Date().toISOString() }])
  await sql`
    UPDATE hire_browser_jobs
    SET current_url = ${currentUrl.slice(0, 2000)}, activity = COALESCE(activity, '[]'::jsonb) || ${event}::jsonb
    WHERE id = ${id} AND status IN ('running', 'waiting')
  `
}

export async function beginBrowserHandoff(sql: SQL, id: string, kind: BrowserHandoffKind, message: string): Promise<void> {
  await sql`
    UPDATE hire_browser_jobs
    SET status = 'waiting', handoff_kind = ${kind}, handoff_message = ${message.slice(0, 400)},
      handoff_at = now(), handoff_resumed_at = NULL
    WHERE id = ${id} AND status = 'running'
  `
}

export async function resumeBrowserHandoff(sql: SQL, id: string): Promise<boolean> {
  const rows = (await sql`
    UPDATE hire_browser_jobs
    SET status = 'running', handoff_resumed_at = now(), claimed_at = now()
    WHERE id = ${id} AND status = 'waiting'
    RETURNING id
  `) as Array<{ id: string }>
  return rows.length > 0
}

/** Keep the streamed browser open while its owner handles a protected step. */
export async function waitForBrowserHandoff(sql: SQL, id: string, timeoutMs = 10 * 60_000): Promise<'resumed' | 'cancelled' | 'timeout'> {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    const rows = (await sql`
      SELECT status, handoff_resumed_at FROM hire_browser_jobs WHERE id = ${id} LIMIT 1
    `) as Array<{ status: string; handoff_resumed_at: Date | null }>
    const row = rows[0]
    if (!row || row.status === 'failed') return 'cancelled'
    if (row.status === 'running' && row.handoff_resumed_at) return 'resumed'
    await Bun.sleep(1_000)
  }
  return 'timeout'
}

const SESSION_VIEW_SECRET = (() => {
  const secret = process.env.HIREALPHA_SESSION_VIEW_SECRET?.trim()
  if (secret && secret.length >= 32) return secret
  if (process.env.NODE_ENV === 'production') throw new Error('HIREALPHA_SESSION_VIEW_SECRET must be at least 32 characters in production.')
  return randomBytes(32).toString('base64url')
})()

/**
 * Creates a cryptographically signed view token for a browser job session.
 * Used for 1-tap links in iMessage so the initiating user can view their computer
 * session immediately without a separate login barrier.
 */
export function generateSessionViewToken(jobId: string, userId: string, ttlSeconds = 600): string {
  const boundedTtl = Math.max(30, Math.min(600, Math.floor(ttlSeconds)))
  const expires = Math.floor(Date.now() / 1000) + boundedTtl
  const sig = createHmac('sha256', SESSION_VIEW_SECRET).update(`${jobId}:${userId}:${expires}`).digest('hex')
  return `${expires}.${sig}`
}

/**
 * Validates a signed view token against a job ID and its owner user ID.
 */
export function verifySessionViewToken(jobId: string, userId: string, token: string): boolean {
  if (!token) return false
  const [expStr, sig] = token.split('.')
  if (!expStr || !sig) return false
  const expires = Number(expStr)
  if (!Number.isFinite(expires) || Math.floor(Date.now() / 1000) > expires) return false
  const expected = createHmac('sha256', SESSION_VIEW_SECRET).update(`${jobId}:${userId}:${expires}`).digest('hex')
  const actualBytes = Buffer.from(sig)
  const expectedBytes = Buffer.from(expected)
  return actualBytes.length === expectedBytes.length && timingSafeEqual(actualBytes, expectedBytes)
}
