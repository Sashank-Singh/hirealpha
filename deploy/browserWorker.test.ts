import { describe, expect, it } from 'bun:test'
import type { SQL } from 'bun'
import { runWithinCeiling, hasMerchantOrderConfirmation, runJob } from './browserWorker'
import { openTaskPage } from './browserSession'
import type { BrowserJobRow } from './browserJobs'

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
