/**
 * The browser-worker entry: a dedicated container that owns Chromium.
 *
 * Loop: claim pending hire_browser_jobs rows (SKIP LOCKED, same protocol as
 * task loops) → run the session (scripted steps, agent-driven goal, or the
 * classic login+scrape) → close the job and queue the thread text. Nothing
 * persists between jobs — fresh context per task, closed in a finally.
 *
 * Env: DATABASE_URL, GMI_API_KEY (agent mode),
 * HIREALPHA_VAULT_KEY / OP_* (via the vault functions).
 */
import { SQL } from 'bun'
import { consumeBrowserApproval, ensureBrowserVaultSchema, getVaultCredentialsForTask, pushBrowserResultLoop } from './browserVault'
import { vaultKey } from './vaultCrypto'
import { runBrowserSession, type SessionTask } from './browserSession'
import { DISABLED_ERROR, resolveBrowserExecutorMode, withTaskSandbox } from './e2bExecutor'
import { E2BTaskEnvironmentProvider } from '../services/trust/taskEnvironments'
import { reportLinkOutcome, retrieveLinkCard, retrieveLinkSpend, type LinkCardCredential } from './linkWallet'
import { createLinkBackedSpendRequest, ensureUserPaymentsSchema, promoteApprovedLinkPurchases } from './userPayments'
import {
  appendBrowserActivity,
  beginBrowserHandoff,
  claimBrowserJobs,
  ensureBrowserJobsSchema,
  finishBrowserJob,
  generateSessionViewToken,
  waitForBrowserHandoff,
  type BrowserJobRow,
} from './browserJobs'
import {
  beginCapabilityConsumption,
  decideCapabilityGrant,
  finalizeCapabilityConsumption,
} from '../services/trust/capabilityGrants'
import { consumeVaultCredential } from '../services/trust/vaultV2'
import { openBaoBrokerFromEnv } from '../services/trust/userKeyBroker'

const DATABASE_URL = process.env.DATABASE_URL || ''
// One noVNC display must never multiplex multiple customer browsers. Scale
// with isolated worker replicas instead of increasing in-container concurrency.
const CONCURRENCY = 1
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

async function retrieveCapabilityBoundLinkCard(
  sql: SQL,
  input: { userId: string; requestId: string; linkSpendId: string },
): Promise<{ card: LinkCardCredential; amountCents: number }> {
  const rows = (await sql`
    SELECT a.amount_cents, a.merchant_url, a.capability_grant_id,
      g.task_id, encode(g.request_digest, 'hex') AS digest
    FROM hire_spend_approvals a
    JOIN capability_grants g ON g.id = a.capability_grant_id
    WHERE a.id = ${input.requestId} AND a.user_id = ${input.userId}
      AND a.link_spend_request_id = ${input.linkSpendId} LIMIT 1
  `) as Array<{ amount_cents: number; merchant_url: string; capability_grant_id: string; task_id: string; digest: string }>
  const row = rows[0]
  if (!row) throw new Error('Payment capability could not be found.')
  await decideCapabilityGrant(sql, {
    id: row.capability_grant_id, userId: input.userId, taskId: row.task_id,
    digest: row.digest, decision: 'approved',
  })
  const grant = await beginCapabilityConsumption(sql, {
    id: row.capability_grant_id, userId: input.userId, taskId: row.task_id, digest: row.digest,
  })
  let merchantOrigin: string
  try { merchantOrigin = new URL(row.merchant_url).origin } catch { merchantOrigin = '' }
  if (!grant || grant.resource_type !== 'payment' || grant.resource_id !== input.requestId
    || grant.action !== 'issue_one_time_payment_credential' || grant.exact_origin !== merchantOrigin
    || grant.amount_cents !== row.amount_cents || grant.provider_reference !== input.linkSpendId) {
    if (grant) await finalizeCapabilityConsumption(sql, {
      id: row.capability_grant_id, userId: input.userId, taskId: row.task_id,
      outcome: 'cancelled_before_side_effect',
    })
    throw new Error('Payment capability scope did not match the approved Link request.')
  }
  try {
    const card = await retrieveLinkCard(sql, input.userId, input.linkSpendId)
    await finalizeCapabilityConsumption(sql, {
      id: row.capability_grant_id, userId: input.userId, taskId: row.task_id,
      outcome: 'completed', providerReference: input.linkSpendId,
    })
    return { card, amountCents: row.amount_cents }
  } catch (error) {
    await finalizeCapabilityConsumption(sql, {
      id: row.capability_grant_id, userId: input.userId, taskId: row.task_id,
      outcome: 'unknown', providerReference: input.linkSpendId,
    })
    throw error
  }
}

/** Purchase jobs only count as successful when the merchant response carries
 * an explicit order/confirmation reference. This prevents a model's generic
 * "done" from becoming a false order-confirmation message. */
export function hasMerchantOrderConfirmation(text: string): boolean {
  return /(?:order|confirmation)\s*(?:number|no\.?|id|#)\s*[:#-]?\s*[a-z0-9-]{4,}/i.test(text)
    || /thank you for your order/i.test(text)
}

async function stageLinkPaymentHandoff(
  sql: SQL,
  job: JobRow,
  input: { url: string; amountCents?: number; merchant?: string; item?: string },
): Promise<{ requestId: string; paymentUrl: string; linkSpendId: string }> {
  if (job.spend_request_id) {
    const rows = (await sql`
      SELECT link_spend_request_id FROM hire_spend_approvals
      WHERE id = ${job.spend_request_id} AND user_id = ${job.user_id} LIMIT 1
    `) as Array<{ link_spend_request_id: string | null }>
    if (!rows[0]?.link_spend_request_id) throw new Error('The Link approval for this checkout could not be found.')
    const appBase = (process.env.HIREALPHA_APP_URL || 'https://hirealpha.chat').replace(/\/$/, '')
    return {
      requestId: job.spend_request_id,
      paymentUrl: `${appBase}/api/payments/spend/approve?id=${encodeURIComponent(job.spend_request_id)}`,
      linkSpendId: rows[0].link_spend_request_id,
    }
  }
  if (!input.amountCents || !input.item) throw new Error('The checkout total or item could not be verified, so no payment request was created.')
  // Bind consent to the user-approved merchant origin, not a payment
  // processor hostname that may temporarily host the checkout page.
  const merchant = hostOf(job.url).toLowerCase().replace(/^www\./, '')
  const checkoutHost = hostOf(input.url).toLowerCase().replace(/^www\./, '')
  const declaredMerchant = (input.merchant || '').toLowerCase().replace(/^www\./, '')
  if (declaredMerchant && declaredMerchant !== merchant && declaredMerchant !== checkoutHost) {
    throw new Error('The visible merchant did not match the active checkout, so no payment request was created.')
  }
  const spend = await createLinkBackedSpendRequest(sql, job.user_id, {
    amountCents: input.amountCents,
    merchant,
    merchantUrl: job.url,
    purpose: input.item,
  })
  if ('error' in spend) throw new Error(spend.error)
  const requestId = spend.requestId
  const amount = (input.amountCents / 100).toFixed(2)
  await sql`
    UPDATE hire_browser_jobs SET spend_request_id = ${requestId}
    WHERE id = ${job.id} AND user_id = ${job.user_id} AND status = 'running' AND spend_request_id IS NULL
  `
  await sql`
    UPDATE hire_spend_approvals
    SET finalization_status = 'waiting_in_browser', finalization_job_id = ${job.id}, last_error = NULL
    WHERE id = ${requestId} AND user_id = ${job.user_id}
  `
  await sql`
    INSERT INTO hire_drafts (id, user_id, persona, kind, to_addr, subject, body, status)
    VALUES (${crypto.randomUUID()}, ${job.user_id}, ${job.persona}, 'purchase', ${input.url}, ${input.item},
      ${JSON.stringify({ amount: Number(amount), requestId, stagedJobId: job.id })}, 'pending')
  `
  job.spend_request_id = requestId
  const rows = (await sql`
    SELECT link_spend_request_id FROM hire_spend_approvals
    WHERE id = ${requestId} AND user_id = ${job.user_id} LIMIT 1
  `) as Array<{ link_spend_request_id: string | null }>
  const linkSpendId = rows[0]?.link_spend_request_id
  if (!linkSpendId) throw new Error('Link did not attach an approval to this checkout.')
  const appBase = (process.env.HIREALPHA_APP_URL || 'https://hirealpha.chat').replace(/\/$/, '')
  return {
    requestId,
    paymentUrl: `${appBase}/api/payments/spend/approve?id=${encodeURIComponent(requestId)}`,
    linkSpendId,
  }
}

/** Keep the merchant checkout open while Link handles consent. Card details
 * exist only in this worker's memory and are claimed once at the DB boundary. */
async function waitForLinkCredential(
  sql: SQL,
  job: JobRow,
  payment: { requestId: string; linkSpendId: string },
  timeoutMs = 10 * 60_000,
): Promise<'cancelled' | 'timeout' | { status: 'resumed'; paymentCard: LinkCardCredential }> {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    const state = (await sql`
      SELECT j.status AS job_status
      FROM hire_browser_jobs j
      WHERE j.id = ${job.id} AND j.user_id = ${job.user_id} LIMIT 1
    `) as Array<{ job_status: string }>
    if (!state[0] || state[0].job_status === 'failed') return 'cancelled'

    let remote
    try { remote = await retrieveLinkSpend(sql, job.user_id, payment.linkSpendId) }
    catch {
      await Bun.sleep(1_000)
      continue
    }
    const status = remote.status.toLowerCase()
    if (['denied', 'expired', 'failed', 'canceled', 'cancelled'].includes(status)) {
      await sql`
        UPDATE hire_spend_approvals
        SET status = ${status}, decided_at = now(), finalization_status = 'cancelled'
        WHERE id = ${payment.requestId} AND user_id = ${job.user_id} AND status = 'pending'
      `
      return 'cancelled'
    }
    if (!['approved', 'succeeded', 'authorized', 'complete', 'completed'].includes(status)) {
      await Bun.sleep(1_000)
      continue
    }

    const claimed = (await sql`
      UPDATE hire_spend_approvals
      SET status = 'approved', decided_at = now(), consumed_at = now(),
        finalization_status = 'retrieving_credential', last_error = NULL
      WHERE id = ${payment.requestId} AND user_id = ${job.user_id}
        AND link_spend_request_id = ${payment.linkSpendId}
        AND status = 'pending' AND consumed_at IS NULL
      RETURNING id
    `) as Array<{ id: string }>
    if (!claimed.length) return 'cancelled'

    let paymentCard: LinkCardCredential
    try {
      paymentCard = (await retrieveCapabilityBoundLinkCard(sql, {
        userId: job.user_id, requestId: payment.requestId, linkSpendId: payment.linkSpendId,
      })).card
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Approved Link credential was unavailable.'
      await sql`
        UPDATE hire_spend_approvals SET finalization_status = 'needs_attention', last_error = ${message.slice(0, 300)}
        WHERE id = ${payment.requestId} AND user_id = ${job.user_id}
      `
      throw new Error(message)
    }
    await sql`
      UPDATE hire_spend_approvals SET finalization_status = 'running', last_error = NULL
      WHERE id = ${payment.requestId} AND user_id = ${job.user_id}
    `
    await sql`
      UPDATE hire_browser_jobs
      SET status = 'running', handoff_resumed_at = now(), claimed_at = now()
      WHERE id = ${job.id} AND user_id = ${job.user_id} AND status = 'waiting' AND handoff_kind = 'payment'
    `
    return { status: 'resumed', paymentCard }
  }
  return 'timeout'
}

/** Latest screenshot per in-flight job, read by report(). */
const lastScreenshots = new Map<string, { dataUrl: string; caption?: string } | undefined>()

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

  // Task launch strategy. Local mode (default) gives each task its own Chromium
  // process and profile in this container — no account, no per-task cost. E2B
  // adds machine-level isolation when a key is configured. An injected launch
  // (tests) bypasses the executor.
  const executorMode = resolveBrowserExecutorMode()
  if (executorMode === 'disabled' && launch === runBrowserSession) {
    return { ok: false, error: DISABLED_ERROR }
  }
  const launchTask = (task: SessionTask) => {
    if (executorMode === 'e2b') {
      const provider = new E2BTaskEnvironmentProvider(process.env.E2B_API_KEY || '')
      return withTaskSandbox(sql, provider, { userId: job.user_id, taskId: job.id }, (cdpUrl) =>
        runBrowserSession({ ...task, cdpUrl }))
    }
    return launch(task)
  }

  let creds: { username: string; password: string } | null = null
  if (job.credential_capability_id || job.vault_item_id || job.credential_capability_digest || job.credential_task_id) {
    if (!job.credential_capability_id || !job.vault_item_id || !job.credential_capability_digest || !job.credential_task_id) {
      return { ok: false, error: 'Credential capability metadata is incomplete.' }
    }
    const broker = openBaoBrokerFromEnv()
    if (!broker) return { ok: false, error: 'OpenBao per-user keys are not configured.' }
    creds = await consumeVaultCredential(sql, broker, {
      userId: job.user_id,
      taskId: job.credential_task_id,
      itemId: job.vault_item_id,
      capabilityId: job.credential_capability_id,
      digest: job.credential_capability_digest,
      origin,
    })
    if (!creds) return { ok: false, error: 'Vault capability could not be consumed.' }
  } else {
    if (!job.approval_id) return { ok: false, error: 'A one-time approval is required.' }
    const gate = await consumeBrowserApproval(sql, job.user_id, job.approval_id, origin)
    if (gate !== 'ok') return { ok: false, error: `Approval could not be consumed: ${gate}` }
    creds = key ? await getVaultCredentialsForTask(sql, job.user_id, origin, key) : null
  }
  let paymentCard: LinkCardCredential | undefined
  let paymentAmountCents: number | undefined
  if (job.spend_request_id) {
    const rows = (await sql`
      SELECT link_spend_request_id FROM hire_spend_approvals
      WHERE id = ${job.spend_request_id} AND user_id = ${job.user_id} LIMIT 1
    `) as Array<{ link_spend_request_id: string | null }>
    const linkSpendId = rows[0]?.link_spend_request_id
    if (linkSpendId) {
      try {
        const retrieved = await retrieveCapabilityBoundLinkCard(sql, {
          userId: job.user_id, requestId: job.spend_request_id, linkSpendId,
        })
        paymentCard = retrieved.card
        paymentAmountCents = retrieved.amountCents
      }
      catch (error) { return { ok: false, error: error instanceof Error ? error.message : 'Approved Link credential was unavailable.' } }
    }
  }

  const kind = job.kind as 'newsletter' | 'ticker' | 'task'
  // The latest page image the session produced. A run that ends without one
  // still reports its text; a run that has one sends it, because "here is what
  // I saw" is what makes the result checkable. Kept module-scoped so report()
  // (a separate function) can read it — as a local it was out of scope and
  // every successful report crashed with ReferenceError.
  lastScreenshots.set(job.id, undefined)
  // Heartbeat: the claim sweeper fails any 'running' row whose claimed_at is
  // older than ten minutes; real booking sites exceed that. Touching the row
  // every minute keeps a healthy long run from being reaped as a dead worker.
  const heartbeat = setInterval(() => {
    void sql`UPDATE hire_browser_jobs SET claimed_at = now() WHERE id = ${job.id} AND status = 'running'`.catch(() => undefined)
  }, 60_000)
  let run: Awaited<ReturnType<typeof launchTask>>
  try {
    run = await launchTask({
    url: job.url,
    username: creds?.username || '',
    password: creds?.password || '',
    kind,
    steps: (job.steps as never) || undefined,
    goal: job.goal || undefined,
    paymentAuthorized: Boolean(paymentCard),
    paymentAmountCents,
    paymentCard,
    onProgress: ({ action, url }) => appendBrowserActivity(sql, job.id, action, url),
    onScreenshot: async (shot) => { lastScreenshots.set(job.id, shot) },
    onHandoff: async ({ kind: handoffKind, message, url, amountCents, merchant, item }) => {
      if (handoffKind === 'payment' && paymentCard) return { status: 'resumed' as const, paymentCard }
      const payment = handoffKind === 'payment'
        ? await stageLinkPaymentHandoff(sql, job, { url, amountCents, merchant, item })
        : null
      await appendBrowserActivity(sql, job.id, `needs_${handoffKind}`, url)
      const handoffMessage = payment
        ? `Approve the verified $${((amountCents || 0) / 100).toFixed(2)} total in Link. Alpha will continue with a one-time credential.`
        : message
      await beginBrowserHandoff(sql, job.id, handoffKind, handoffMessage)
      const appBase = (process.env.HIREALPHA_APP_URL || 'https://hirealpha.chat').replace(/\/$/, '')
      const viewToken = generateSessionViewToken(job.id, job.user_id)
      const sessionUrl = `${appBase}/computer/${job.id}?token=${encodeURIComponent(viewToken)}`
      await pushBrowserResultLoop(sql, {
        userId: job.user_id,
        persona: job.persona,
        origin: url,
        insights: payment
          ? `Checkout is staged at a verified total of $${((amountCents || 0) / 100).toFixed(2)}. Approve the one-time payment in Link: ${payment.paymentUrl} — watch the live checkout here: ${sessionUrl}`
          : `Alpha paused and needs you to ${message.replace(/[.!]+$/, '').toLowerCase()}. Open the live computer: ${sessionUrl}`,
      })
      return payment
        ? waitForLinkCredential(sql, job, payment)
        : waitForBrowserHandoff(sql, job.id)
    },
  })
  } catch (err) {
    clearInterval(heartbeat)
    throw err
  }
  clearInterval(heartbeat)
  if (!run.ok) return { ok: false, error: run.error }
  if (job.spend_request_id && !hasMerchantOrderConfirmation(run.content)) {
    return { ok: false, error: 'Merchant did not return an order confirmation number.' }
  }
  return { ok: true, result: run.content }
}

async function report(sql: SQL, job: JobRow, outcome: JobOutcome): Promise<void> {
  if (outcome.ok) {
    await sql`UPDATE hire_browser_jobs SET status = 'done', result = ${outcome.result}, finished_at = now() WHERE id = ${job.id}`
    if (job.spend_request_id) {
      await sql`
        UPDATE hire_spend_approvals
        SET status = 'consumed', paid_at = COALESCE(paid_at, now()),
          finalization_status = 'completed', order_confirmation = ${outcome.result}, last_error = NULL
        WHERE id = ${job.spend_request_id} AND finalization_job_id = ${job.id}
      `
      const link = (await sql`
        SELECT link_spend_request_id FROM hire_spend_approvals
        WHERE id = ${job.spend_request_id} AND user_id = ${job.user_id} LIMIT 1
      `) as Array<{ link_spend_request_id: string | null }>
      if (link[0]?.link_spend_request_id) {
        await reportLinkOutcome(sql, job.user_id, {
          spendId: link[0].link_spend_request_id,
          domain: hostOf(job.url),
          outcome: 'success',
          step: 'merchant_confirmation',
          context: 'Merchant returned an order confirmation.',
        }).catch(() => undefined)
      }
    }
    const insights = job.spend_request_id
      ? `Order submitted after payment. Merchant confirmation: ${outcome.result}`
      : outcome.result
    const shot = lastScreenshots.get(job.id)
    lastScreenshots.delete(job.id)
    await pushBrowserResultLoop(sql, {
      userId: job.user_id, persona: job.persona, origin: job.url, insights,
      screenshotDataUrl: shot?.dataUrl, screenshotCaption: shot?.caption,
    })
    return
  }
  // Do not replay a task that may already have submitted a form or order.
  await finishBrowserJob(sql, job.id, { ok: false, error: outcome.error })
  let paymentWasApproved = false
  if (job.spend_request_id) {
    const spend = (await sql`
      SELECT status, consumed_at, link_spend_request_id FROM hire_spend_approvals
      WHERE id = ${job.spend_request_id} AND user_id = ${job.user_id} LIMIT 1
    `) as Array<{ status: string; consumed_at: Date | null; link_spend_request_id: string | null }>
    paymentWasApproved = Boolean(spend[0]?.consumed_at) || ['approved', 'consumed'].includes(spend[0]?.status || '')
    await sql`
      UPDATE hire_spend_approvals
      SET finalization_status = CASE WHEN finalization_status = 'cancelled' THEN finalization_status ELSE 'needs_attention' END,
        last_error = ${outcome.error.slice(0, 500)}
      WHERE id = ${job.spend_request_id} AND finalization_job_id = ${job.id}
    `
    if (spend[0]?.link_spend_request_id) {
      await reportLinkOutcome(sql, job.user_id, {
        spendId: spend[0].link_spend_request_id,
        domain: hostOf(job.url),
        outcome: paymentWasApproved ? 'blocked' : 'abandoned',
        step: paymentWasApproved ? 'merchant_confirmation' : 'approval',
        context: outcome.error,
      }).catch(() => undefined)
    }
  }
  await pushBrowserResultLoop(sql, {
    userId: job.user_id,
    persona: job.persona,
    origin: job.url,
    insights: job.spend_request_id
      ? paymentWasApproved
        ? `Payment was approved, but the merchant order was not confirmed: ${outcome.error.slice(0, 200)}. No retry was attempted because the submission outcome may be uncertain.`
        : `The checkout stopped before payment was approved: ${outcome.error.slice(0, 200)}.`
      : `Couldn't check ${hostOf(job.url)}: ${outcome.error.slice(0, 200)}`,
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
  await ensureUserPaymentsSchema(sql)
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
      await promoteApprovedLinkPurchases(sql).catch((err) => console.warn('[browser-worker] Link approval poll failed', err instanceof Error ? err.message : err))
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
