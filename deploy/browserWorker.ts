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
import { KernelBrowser } from './kernelPage'
import { runKernelTask } from './kernelSession'
import { runBrowserUseTask } from './browserUseSession'
import { formatIdentityForPrompt, loadIdentityProfile } from './userIdentity'
import { getKernelVaultId, reportLinkOutcome, retrieveLinkCard, retrieveLinkSpend, type LinkCardCredential } from './linkWallet'
import { createLinkBackedSpendRequest, ensureUserPaymentsSchema, promoteApprovedLinkPurchases } from './userPayments'
import {
  appendBrowserActivity,
  beginBrowserHandoff,
  claimBrowserJobs,
  ensureBrowserJobsSchema,
  finishBrowserJob,
  generateSessionViewToken,
  setBrowserLiveView,
  sweepStaleRunningJobs,
  setBrowserScreenshot,
  waitForBrowserHandoff,
  waitForBrowserHandoffAnswer,
  type BrowserJobRow,
} from './browserJobs'
import {
  beginCapabilityConsumption,
  decideCapabilityGrant,
  finalizeCapabilityConsumption,
} from '../services/trust/capabilityGrants'
import { consumeVaultCredential } from '../services/trust/vaultV2'
import { mirrorJobReconcile } from '../services/tasks/taskLifecycle'
import { openBaoBrokerFromEnv } from '../services/trust/userKeyBroker'
import { validateProductionBrowserWorker } from './certification/envContract'

const DATABASE_URL = process.env.DATABASE_URL || ''
// One noVNC display must never multiplex multiple customer browsers. Scale
// with isolated worker replicas instead of increasing in-container concurrency.
const CONCURRENCY = 1
const POLL_MS = 3000
/** Sandbox lifetime must outlive the agent wall (8 min) plus a full handoff
 * wait (10 min) plus CDP startup, or the browser is killed while the user is
 * mid-CAPTCHA. E2B allows up to 30 minutes; the sandbox is still destroyed in
 * withTaskSandbox's finally, so an idle sandbox never lingers. */
const TASK_SANDBOX_TIMEOUT_MS = 20 * 60_000

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
  input: { url: string; amountCents?: number; currency?: string; merchant?: string; item?: string },
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
  if (!input.amountCents || !input.item || !input.currency) throw new Error('The checkout amount, currency, or item could not be independently verified, so no payment request was created.')
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
    currency: input.currency,
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
      ${JSON.stringify({ amount: Number(amount), currency: input.currency, requestId, stagedJobId: job.id })}, 'pending')
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
    if (['denied', 'declined', 'expired', 'failed', 'canceled', 'cancelled', 'recovery_required'].includes(status)) {
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
    // An injected launch (tests) bypasses the executor: a local .env that
    // happens to set KERNEL_API_KEY must not make a unit test open a real
    // cloud browser.
    if (launch !== runBrowserSession) return launch(task)
    if (executorMode === 'kernel') {
      const apiKey = process.env.KERNEL_API_KEY?.trim() || ''
      if (!apiKey) return Promise.resolve({ ok: false as const, error: 'KERNEL_API_KEY is not configured.' })
      return (async () => {
        // Vault attachment is fixed at browser creation. Attach the user's
        // project-scoped payment vault before any checkout card item exists;
        // Kernel will substitute aliases at egress after authorization.
        const paymentVaultId = await getKernelVaultId(sql, job.user_id, false)
        const browser = await KernelBrowser.launch({
          apiKey,
          telemetry: process.env.KERNEL_TELEMETRY !== '0' && process.env.KERNEL_TELEMETRY !== 'false',
          vaultIds: paymentVaultId ? [paymentVaultId] : undefined,
          timeoutSeconds: Number(process.env.KERNEL_SESSION_SECONDS || 3600),
          profile: process.env.KERNEL_PROFILE_NAME?.trim() || undefined,
        })
        // The live view is the page a person opens to take over a login,
        // CAPTCHA or payment step — record it before the first model turn.
        if (browser.liveViewUrl) await setBrowserLiveView(sql, job.id, browser.liveViewUrl).catch(() => undefined)
        try {
          const useBrowserUse = (process.env.KERNEL_AGENT_DRIVER || 'browser-use').trim().toLowerCase() === 'browser-use'
          return await (useBrowserUse ? runBrowserUseTask : runKernelTask)(
            {
          url: task.url,
          username: task.username,
          password: task.password,
          goal: task.goal,
          jobId: job.id,
          identity: task.identity,
          paymentAuthorized: task.paymentAuthorized,
              paymentAmountCents: task.paymentAmountCents,
              paymentCard: task.paymentCard,
              sql,
              onProgress: task.onProgress,
              onScreenshot: task.onScreenshot,
              onHandoff: task.onHandoff,
            },
            browser,
          )
        } finally {
          // Keep the container accessible via liveViewUrl for a grace period (default 120s)
          // so that the user can inspect the session without encountering
          // "proxy.*.onkernel.com took too long to respond".
          const graceMs = Number(process.env.KERNEL_CLOSE_GRACE_MS || 120_000)
          if (graceMs > 0 && browser.liveViewUrl) {
            setTimeout(() => browser.close().catch(() => undefined), graceMs).unref?.()
          } else {
            await browser.close().catch(() => undefined)
          }
        }
      })()
    }
    if (executorMode === 'e2b') {
      const provider = new E2BTaskEnvironmentProvider(process.env.E2B_API_KEY || '')
      return withTaskSandbox(sql, provider, { userId: job.user_id, taskId: job.id, timeoutMs: TASK_SANDBOX_TIMEOUT_MS }, (cdpUrl) =>
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
  // Real identity for form filling: the loop fills from these or asks the
  // user; inventing "John Smith" is banned by the agent rules. A read failure
  // degrades to an empty profile — which forces asking, never guessing.
  const identityText = formatIdentityForPrompt(await loadIdentityProfile(sql, job.user_id, job.persona))
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
    // Named so the handoff closure can write back fresh credentials: the
    // session loop re-reads username/password every step, so a password
    // handoff completed with "Saved" feeds the run without a restart.
    const sessionTask: SessionTask = {
    url: job.url,
    username: creds?.username || '',
    password: creds?.password || '',
    kind,
    steps: (job.steps as never) || undefined,
    goal: job.goal || undefined,
    identity: identityText || undefined,
    paymentAuthorized: Boolean(paymentCard),
    paymentAmountCents,
    paymentCard,
    // Activity rows are diagnostics: one must never kill a running browser
    // during a Postgres recovery window (a real job died exactly that way
    // mid-CAPTCHA handoff).
    onProgress: async ({ action, url }) => {
      await appendBrowserActivity(sql, job.id, action, url).catch(() => undefined)
    },
    onScreenshot: async (shot) => {
      lastScreenshots.set(job.id, shot)
      if (shot?.dataUrl) {
        await setBrowserScreenshot(sql, job.id, shot.dataUrl).catch(() => undefined)
      }
    },
    onHandoff: async ({ kind: handoffKind, message, url, amountCents, currency, merchant, item, checkAutoResume }) => {
      if (handoffKind === 'payment' && paymentCard) return { status: 'resumed' as const, paymentCard }
      // Route A: the agent asked a question. The answer channel is the chat
      // thread itself — no link, no live view, no takeover. The user's next
      // text (routed by the bot, or the answer box on the session page) lands
      // in handoff_answer and resumes the run; the loop injects it as
      // `user answered: "..."` so the agent types it into the field.
      if (handoffKind === 'question') {
        await appendBrowserActivity(sql, job.id, `needs_${handoffKind}`, url)
        await beginBrowserHandoff(sql, job.id, 'question', message)
        await pushBrowserResultLoop(sql, {
          userId: job.user_id,
          persona: job.persona,
          origin: url,
          insights: `Alpha paused: ${message.replace(/[.!?]+$/, '')}? Reply here with your answer and I'll type it in.`,
          screenshotDataUrl: lastScreenshots.get(job.id)?.dataUrl,
          screenshotCaption: message.slice(0, 200),
        })
        const wait = await waitForBrowserHandoffAnswer(sql, job.id)
        if (wait.outcome === 'resumed' && wait.answer) return { status: 'resumed' as const, answer: wait.answer }
        return wait.outcome
      }
      const payment = handoffKind === 'payment'
        ? await stageLinkPaymentHandoff(sql, job, { url, amountCents, currency, merchant, item })
        : null
      await appendBrowserActivity(sql, job.id, `needs_${handoffKind}`, url)
      const handoffMessage = payment
        ? `Approve the verified $${((amountCents || 0) / 100).toFixed(2)} total in Link. Alpha will continue with a one-time credential.`
        : message
      await beginBrowserHandoff(sql, job.id, handoffKind, handoffMessage)
      const appBase = (process.env.HIREALPHA_APP_URL || 'https://hirealpha.chat').replace(/\/$/, '')
      const viewToken = generateSessionViewToken(job.id, job.user_id)
      const sessionUrl = `${appBase}/computer/${job.id}?token=${encodeURIComponent(viewToken)}`
      const vaultUrl = `${appBase}/app/vault-login?portal=${encodeURIComponent(origin)}&persona=${encodeURIComponent(job.persona || 'friend')}`
      // The challenge screenshot the session just took travels with the
      // handoff message: the user sees the wall in the thread, not a claim
      // that one exists.
      const handoffShot = lastScreenshots.get(job.id)
      await pushBrowserResultLoop(sql, {
        userId: job.user_id,
        persona: job.persona,
        origin: url,
        insights: payment
          ? `Checkout is staged at a verified total of $${((amountCents || 0) / 100).toFixed(2)}. Approve the one-time payment in Link: ${payment.paymentUrl} — watch the live checkout here: ${sessionUrl}`
          : handoffKind === 'password'
            ? (creds?.password
                ? `Alpha paused at the sign-in screen on ${origin ? new URL(origin).hostname.replace(/^www\./, '') : 'the portal'}. If two-factor or security verification is needed, take over here: ${sessionUrl}`
                : `Your login password or username is not in Vault yet. Connect it securely here: ${vaultUrl} — or take over the live computer: ${sessionUrl}`)
            : `Alpha paused and needs you to ${message.replace(/[.!]+$/, '').toLowerCase()}. Open the live computer: ${sessionUrl}`,
        screenshotDataUrl: handoffShot?.dataUrl,
        screenshotCaption: handoffShot?.caption || handoffMessage,
      })
      const handoffOutcome = await (payment
        ? waitForLinkCredential(sql, job, payment)
        : waitForBrowserHandoff(sql, job.id, undefined, checkAutoResume))

      if (handoffOutcome === 'resumed' && key && (handoffKind === 'password' || !creds)) {
        const freshCreds = await getVaultCredentialsForTask(sql, job.user_id, origin, key).catch(() => null)
        if (freshCreds) {
          creds = freshCreds
          sessionTask.username = freshCreds.username
          sessionTask.password = freshCreds.password
        }
      }

      return handoffOutcome
    },
  }
    run = await launchTask(sessionTask)
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

/** Race a whole run against a hard ceiling; the heartbeat cannot mask it.
 * Exported for tests (the worker loop only reaches the ceiling after 25m). */
export function runWithinCeiling<T>(work: Promise<T>, ceilingMs: number): Promise<{ ran: true; value: T } | { ran: false }> {
  let timer: ReturnType<typeof setTimeout>
  return Promise.race([
    work.then((value) => ({ ran: true as const, value })),
    new Promise<{ ran: false }>((resolve) => { timer = setTimeout(() => resolve({ ran: false }), ceilingMs) }),
  ]).finally(() => clearTimeout(timer))
}

async function report(sql: SQL, job: JobRow, outcome: JobOutcome): Promise<void> {
  // A result whose loop insert died in a DB recovery window is still sitting
  // in its job row with no browser_result loop row behind it. The insert is
  // idempotent, so flushing here (before this run's own push) means the next
  // completed job always heals whatever a previous report() could not queue.
  // Only the newest completed job per (user, persona) matters: the thread has
  // exactly one browser_result row per pair, so a newer result supersedes an
  // older one, and a row updated after the job finished means its delivery
  // already landed (or a newer result did).
  async function flushUndeliveredResults(): Promise<void> {
    const pending = (await sql`
      SELECT latest.id, latest."userId", latest.persona, latest.url, latest.result,
        latest.error, latest.status, latest."spendRequestId"
      FROM (
        SELECT DISTINCT ON (j.user_id, j.persona)
          j.id, j.user_id AS "userId", j.persona, j.url, j.result, j.error, j.status,
          j.spend_request_id AS "spendRequestId", j.finished_at
        FROM hire_browser_jobs j
        JOIN hire_users u ON u.id = j.user_id::text
        WHERE j.status IN ('done', 'failed')
          AND u.phone_e164 IS NOT NULL
          AND j.finished_at IS NOT NULL
          AND j.finished_at > now() - interval '48 hours'
        ORDER BY j.user_id, j.persona, j.finished_at DESC
      ) latest
      WHERE NOT EXISTS (
        SELECT 1 FROM hire_task_loops l
        WHERE l.kind = 'browser_result' AND l.user_id = latest."userId"::text
          AND l.updated_at > latest.finished_at
      )
      ORDER BY latest.finished_at ASC
      LIMIT 3
    `) as Array<{
      id: string
      userId: string
      persona: string
      url: string
      result: string | null
      error: string | null
      status: string
      spendRequestId: string | null
    }>
    for (const row of pending) {
      let paymentWasApproved = false
      if (row.spendRequestId) {
        const spend = (await sql`
          SELECT status, consumed_at FROM hire_spend_approvals
          WHERE id = ${row.spendRequestId} LIMIT 1
        `) as Array<{ status: string; consumed_at: Date | null }>
        paymentWasApproved = Boolean(spend[0]?.consumed_at) || ['approved', 'consumed'].includes(spend[0]?.status || '')
      }
      const failed = row.status !== 'done'
      const insights = !failed
        ? row.spendRequestId
          ? `Order submitted after payment. Merchant confirmation: ${row.result ?? ''}`
          : (row.result || 'The task completed.')
        : row.spendRequestId
          ? paymentWasApproved
            ? `Payment was approved, but the merchant order was not confirmed: ${(row.error || 'unknown error').slice(0, 200)}. No retry was attempted because the submission outcome may be uncertain.`
            : `The checkout stopped before payment was approved: ${(row.error || 'unknown error').slice(0, 200)}.`
          : `Couldn't check ${hostOf(row.url)}: ${(row.error || 'unknown error').slice(0, 200)}`
      try {
        await pushBrowserResultLoop(sql, {
          userId: row.userId,
          persona: row.persona,
          origin: row.url,
          insights,
          jobId: row.id,
        }, { retryDelaysMs: [0, 1_000, 4_000] })
        console.log(`[browser-worker] recovered undelivered result for job ${row.id}`)
      } catch (err) {
        console.warn(`[browser-worker] undelivered result still blocked for job ${row.id}`, err)
      }
    }
  }
  await flushUndeliveredResults().catch((err) => console.warn('[browser-worker] undelivered result sweep failed', err))
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
    try {
      await pushBrowserResultLoop(sql, {
        userId: job.user_id, persona: job.persona, origin: job.url, insights,
        screenshotDataUrl: shot?.dataUrl, screenshotCaption: shot?.caption,
        jobId: job.id,
      }, { retryDelaysMs: [0, 2_000, 8_000, 20_000] })
    } catch (err) {
      // The result is safe in the job row; the next report() pass picks it up
      // through the undelivered sweep instead of losing it to a DB flap.
      console.error(`[browser-worker] result delivery failed for job ${job.id}; recovery sweep will retry`, err)
    }
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
  try {
    await pushBrowserResultLoop(sql, {
      userId: job.user_id,
      persona: job.persona,
      origin: job.url,
      insights: job.spend_request_id
        ? paymentWasApproved
          ? `Payment was approved, but the merchant order was not confirmed: ${outcome.error.slice(0, 200)}. No retry was attempted because the submission outcome may be uncertain.`
          : `The checkout stopped before payment was approved: ${outcome.error.slice(0, 200)}.`
        : `Couldn't check ${hostOf(job.url)}: ${outcome.error.slice(0, 200)}`,
      jobId: job.id,
    }, { retryDelaysMs: [0, 2_000, 8_000, 20_000] })
  } catch (err) {
    console.error(`[browser-worker] failure notice delivery failed for job ${job.id}; recovery sweep will retry`, err)
  }
}

async function main() {
  if (!DATABASE_URL) {
    console.error('[browser-worker] fatal: DATABASE_URL missing')
    process.exit(1)
  }
  if (process.env.NODE_ENV === 'production') {
    const readiness = validateProductionBrowserWorker(process.env)
    if (!readiness.ok) {
      console.error(`[browser-worker] fatal: production readiness failed (${readiness.problems.join(', ')})`)
      process.exit(1)
    }
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
  // Hard ceiling that races the ENTIRE run. The per-minute heartbeat keeps a
  // wedged run's claim fresh, so the stale sweep (its only other backstop)
  // never fires - a single stuck kernel await then pins the concurrency=1 slot
  // forever until a redeploy. Seen live 09-15: an httpbin goal with no form
  // looped and froze the queue for hours. This ceiling is the heartbeat-proof
  // release: a run that cannot finish itself within it is declared outcome-
  // unknown, lands in NEEDS_RECONCILIATION (never auto-retried - a side effect
  // may have happened), frees the slot, and tells the user. Set well above any
  // legitimate run (8m agent wall + bounded handoff waits); env overrides for
  // tests only.
  const HARD_RUN_CEILING_MS = Number(process.env.HIREALPHA_RUN_CEILING_MS || 25 * 60_000)
  const tick = async () => {
    if (busy >= CONCURRENCY) return
    busy++
    try {
      await promoteApprovedLinkPurchases(sql).catch((err) => console.warn('[browser-worker] Link approval poll failed', err instanceof Error ? err.message : err))
      // No silent death: a run whose worker died mid-flight (redeploy, OOM) is
      // swept AND announced here — the user gets an honest "interrupted,
      // nothing confirmed" instead of waiting on a ghost (seen live 19:36,
      // a deploy killed the founder's form-fill and nobody said anything).
      const swept = await sweepStaleRunningJobs(sql).catch((err) => {
        console.warn('[browser-worker] stale sweep failed', err instanceof Error ? err.message : String(err))
        return []
      })
      for (const row of swept) {
        console.log(`[browser-worker] swept dead run ${row.id} — notifying user`)
        await pushBrowserResultLoop(sql, {
          userId: row.user_id, persona: row.persona, origin: row.url,
          insights: 'The browser run was interrupted before it finished, so I could not verify any outcome and nothing is confirmed done. Ask me to try again and I will start fresh.',
          jobId: row.id,
        }, { retryDelaysMs: [0, 2_000, 8_000] }).catch((err) => console.warn('[browser-worker] sweep notify failed', err))
      }
      const rows = await claimBrowserJobs(sql, 1)
      const job = rows[0]
      if (!job) return
      console.log(`[browser-worker] job ${job.id} (${job.kind}${job.goal ? ', agent' : ''}) for ${job.persona}:${job.user_id}`)
      const settled = await runWithinCeiling(
        runJob(sql, job).catch((err) => ({ ok: false as const, error: err instanceof Error ? err.message : String(err) })),
        HARD_RUN_CEILING_MS,
      )
      if (!settled.ran) {
        console.warn(`[browser-worker] run ${job.id} exceeded the ${HARD_RUN_CEILING_MS}ms ceiling — releasing slot`)
        // Declare outcome unknown directly; do NOT route through report()/
        // finishBrowserJob, which would mirror a definitive FAILED_FINAL when
        // the real state is "may or may not have acted" -> reconcile.
        await sql`
          UPDATE hire_browser_jobs SET status = 'failed', error = 'Run exceeded the hard time ceiling; outcome unknown. Review before retrying.', finished_at = now()
          WHERE id = ${job.id} AND status = 'running'
        `.catch(() => undefined)
        await mirrorJobReconcile(sql, job.id, 'Run exceeded the hard time ceiling; outcome unknown.')
        await pushBrowserResultLoop(sql, {
          userId: job.user_id, persona: job.persona, origin: job.url,
          insights: 'That run hit my hard time limit before it could finish, so I cannot confirm what it did. Nothing is marked done — ask me to try again.',
          jobId: job.id,
        }, { retryDelaysMs: [0, 2_000, 8_000] }).catch((err) => console.warn('[browser-worker] ceiling notify failed', err))
        return
      }
      await report(sql, job, settled.value)
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
