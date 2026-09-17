import { describe, expect, it } from 'bun:test'
import type { SQL } from 'bun'
import { runWithinCeiling, hasMerchantOrderConfirmation, runJob, workerCredentialBrokerFromEnv, flushUndeliveredResults } from './browserWorker'
import { openTaskPage } from './browserSession'
import type { BrowserJobRow } from './browserJobs'
import { LocalUserKeyBroker, OpenBaoTransitClient } from '../services/trust/userKeyBroker'

const job: BrowserJobRow = { id: 'test-job', user_id: 'test-user', persona: 'friend', phone_e164: null, kind: 'task', url: 'https://example.com/', steps: null, goal: 'Read the page heading', status: 'running', attempts: 1, result: null, error: null, approval_id: 'test-approval', spend_request_id: null }

it('requires explicit merchant confirmation evidence for purchase completion', () => {
  expect(hasMerchantOrderConfirmation('Order number: 113-1234567-1234567')).toBe(true)
  expect(hasMerchantOrderConfirmation('Confirmation # AB12-CD34')).toBe(true)
  expect(hasMerchantOrderConfirmation('Checkout finished')).toBe(false)
})

it('opens a public website without invoking the login form', async () => {
  const visited: string[] = []
  await openTaskPage({ goto: async (url: string) => { visited.push(url) }, locator: () => { throw new Error('Login form should not be queried') } } as never, { url: job.url, username: '', password: '', kind: 'task' })
  expect(visited).toEqual([job.url])
})

it('runs a public goal once after consuming its approval', async () => {
  let consumed = false, launches = 0
  const sql = (async (strings: TemplateStringsArray) => {
    const query = strings.join('?')
    if (query.includes('SELECT id, status, origin')) return [{ id: 'test-approval', status: 'approved', origin: 'https://example.com', created_at: new Date(), consumed_at: consumed ? new Date() : null }]
    if (query.includes('UPDATE hire_browser_approvals')) { consumed = true; return [{ id: 'test-approval' }] }
    return []
  }) as unknown as SQL
  const launch = async (task: Parameters<typeof openTaskPage>[1]) => { launches++; expect(task.password).toBe(''); return { ok: true as const, content: 'Example Domain' } }
  expect(await runJob(sql, job, launch)).toEqual({ ok: true, result: 'Example Domain' })
  expect((await runJob(sql, job, launch)).ok).toBe(false)
  expect(launches).toBe(1)
})

it('does not launch a browser without a valid approval', async () => {
  const launch = async () => { throw new Error('Must not launch') }
  const sql = (async () => []) as unknown as SQL
  expect((await runJob(sql, { ...job, approval_id: null }, launch)).ok).toBe(false)
  expect((await runJob(sql, job, launch)).ok).toBe(false)
})

describe('worker credential broker selection', () => {
  it('uses the encrypted local broker when OpenBao is not configured', () => {
    const broker = workerCredentialBrokerFromEnv({ HIREALPHA_VAULT_KEY: 'test-only-vault-key' } as NodeJS.ProcessEnv)
    expect(broker).toBeInstanceOf(LocalUserKeyBroker)
  })

  it('prefers OpenBao when both backends are configured', () => {
    const broker = workerCredentialBrokerFromEnv({
      HIREALPHA_VAULT_KEY: 'test-only-vault-key',
      OPENBAO_ADDR: 'https://vault.example.com',
      OPENBAO_TOKEN: 'test-token',
    } as NodeJS.ProcessEnv)
    expect(broker).toBeInstanceOf(OpenBaoTransitClient)
  })

  it('fails closed when no Vault backend is configured', () => {
    expect(workerCredentialBrokerFromEnv({} as NodeJS.ProcessEnv)).toBeNull()
  })
})

describe('undelivered result recovery', () => {
  it('re-queues a finished run whose delivery never landed, named by its own task', async () => {
    const pushes: Array<Record<string, unknown>> = []
    const sql = (async (strings: TemplateStringsArray) => {
      const query = strings.join('?')
      if (query.includes('FROM hire_browser_jobs')) {
        return [{
          id: 'job-7', userId: 'u1', persona: 'friend', url: 'https://httpbin.org/forms/post',
          goal: 'Fill the form with my name, email and phone number',
          result: 'Task completed successfully.', error: null, status: 'done', spendRequestId: null,
        }]
      }
      return []
    }) as unknown as SQL
    await flushUndeliveredResults(sql, (async (_sql: unknown, input: Record<string, unknown>) => {
      pushes.push(input)
      return true
    }) as never)
    expect(pushes).toHaveLength(1)
    expect(pushes[0].jobId).toBe('job-7')
    // The text names the task, so a report that lands during a newer request is
    // never read as the answer to that request.
    expect(pushes[0].label).toBe('Fill the form with my name, email and phone number')
    expect(String(pushes[0].insights)).toContain('Task completed successfully.')
  })

  it('keys recovery to the delivery row, not to a timestamp a newer push can fake', async () => {
    const seen: string[] = []
    const sql = (async (strings: TemplateStringsArray) => {
      seen.push(strings.join('?'))
      return []
    }) as unknown as SQL
    await flushUndeliveredResults(sql, (async () => true) as never)
    const sweep = seen.find((q) => q.includes('FROM hire_browser_jobs'))!
    expect(sweep).toContain('NOT EXISTS')
    expect(sweep).toContain('FROM hire_browser_result_deliveries d WHERE d.id = latest.id')
    // The old shape suppressed recovery by comparing the shared loop row's
    // updated_at to finished_at, which both hid unsent results and re-sent sent
    // ones. Nothing in the sweep may look at that row again.
    expect(sweep).not.toContain('hire_task_loops')
    expect(sweep).not.toContain('updated_at >')
  })
})

describe('runWithinCeiling', () => {
  it('lets a completing run through untouched', async () => {
    const settled = await runWithinCeiling(Promise.resolve({ ok: true as const, result: 'done' }), 5_000)
    expect(settled.ran).toBe(true)
    if (settled.ran) expect(settled.value.result).toBe('done')
  })
  it('a wedged run cannot hold the slot past the ceiling', async () => {
    const never = new Promise<never>(() => undefined)
    const settled = await runWithinCeiling(never, 20)
    expect(settled).toEqual({ ran: false })
  })
  it('rejections inside the run are values, not ceilings', async () => {
    const failed = runJob(null as never, null as never).catch((err: unknown) => ({ ok: false as const, error: String(err) }))
    const settled = await runWithinCeiling(failed, 5_000)
    expect(settled.ran).toBe(true)
  })
})
