import { describe, expect, it } from 'bun:test'
import {
  UNCONFIGURED_ERROR,
  resolveBrowserExecutorMode,
  withTaskSandbox,
} from './e2bExecutor'
import { DENIED_EGRESS, type TaskEnvironmentProvider } from '../services/trust/taskEnvironments'

type RecordedQuery = { text: string; values: unknown[] }

/** Fake SQL that answers the task_environments + audit_events statements and
 * records every query so tests can assert on the audit trail. */
function fakeSql(rowsFor: (text: string) => unknown[] = () => []) {
  const queries: RecordedQuery[] = []
  const runner = (strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.join('?')
    queries.push({ text, values })
    return Promise.resolve(rowsFor(text))
  }
  const sql = runner as never as {
    (strings: TemplateStringsArray, ...values: unknown[]): Promise<unknown[]>
    begin<T>(fn: (tx: unknown) => Promise<T>): Promise<T>
  }
  ;(sql as never as { begin: unknown }).begin = async (fn: (tx: unknown) => Promise<unknown>) => {
    const tx = (strings: TemplateStringsArray, ...values: unknown[]) => {
      queries.push({ text: '[tx] ' + strings.join('?'), values })
      return Promise.resolve(rowsFor('[tx] ' + strings.join('?')))
    }
    return fn(tx)
  }
  return { sql: sql as never, queries }
}

function fakeProvider(sandboxIds: string[] = ['sandbox-a', 'sandbox-b']) {
  const calls: Array<{ call: string; taskId?: string }> = []
  let created = 0
  const provider: TaskEnvironmentProvider = {
    create: async ({ taskId }) => {
      calls.push({ call: 'create', taskId })
      const id = sandboxIds[created] ?? `sandbox-${created}`
      created++
      return { id, cdpUrl: `https://${id}.e2b.app` }
    },
    destroy: async () => { calls.push({ call: 'destroy' }) },
    isDestroyed: async () => { calls.push({ call: 'verify' }); return true },
  }
  return { provider, calls }
}

function destroyRow() {
  return [{ id: 'environment-1', provider_environment_id: 'sandbox-a' }]
}

describe('browser executor mode resolution', () => {
  it('requires both an API key and a template for E2B', () => {
    expect(resolveBrowserExecutorMode({ E2B_API_KEY: 'k', E2B_BROWSER_TEMPLATE: 'hirealpha-browser' })).toBe('e2b')
    expect(resolveBrowserExecutorMode({ E2B_API_KEY: 'k' })).toBe('unconfigured')
    expect(resolveBrowserExecutorMode({ E2B_BROWSER_TEMPLATE: 'hirealpha-browser' })).toBe('unconfigured')
  })

  it('only allows local execution through the explicit gate', () => {
    expect(resolveBrowserExecutorMode({ HIREALPHA_ALLOW_LOCAL_BROWSER: '1' })).toBe('local')
    expect(resolveBrowserExecutorMode({ HIREALPHA_ALLOW_LOCAL_BROWSER: 'true' })).toBe('unconfigured')
    expect(resolveBrowserExecutorMode({})).toBe('unconfigured')
  })
})

describe('withTaskSandbox lifecycle', () => {
  it('provisions, runs against the sandbox CDP URL, destroys, and audits', async () => {
    const { sql, queries } = fakeSql((text) => (text.includes("status = 'destroying'") ? destroyRow() : []))
    const { provider, calls } = fakeProvider(['sandbox-a'])
    const result = await withTaskSandbox(sql, provider, { userId: 'u1', taskId: 'job-1' }, async (cdpUrl) => cdpUrl)
    expect(result).toBe('https://sandbox-a.e2b.app')
    expect(calls.map((c) => c.call)).toEqual(['create', 'destroy', 'verify'])
    expect(calls[0]!.taskId).toBe('job-1')
    const auditEvents = queries.filter((q) => q.text.includes('INSERT INTO audit_events'))
    expect(auditEvents).toHaveLength(2)
    const eventTypes = auditEvents.map((q) => JSON.stringify(q.values)).join(' ')
    expect(eventTypes).toContain('environment_created')
    expect(eventTypes).toContain('environment_destroyed')
  })

  it('destroys the sandbox and audits when the task fails', async () => {
    const { sql, queries } = fakeSql((text) => (text.includes("status = 'destroying'") ? destroyRow() : []))
    const { provider, calls } = fakeProvider(['sandbox-a'])
    await expect(withTaskSandbox(sql, provider, { userId: 'u1', taskId: 'job-1' }, async () => {
      throw new Error('page exploded')
    })).rejects.toThrow('page exploded')
    expect(calls.map((c) => c.call)).toEqual(['create', 'destroy', 'verify'])
    const eventTypes = queries.filter((q) => q.text.includes('INSERT INTO audit_events'))
      .map((q) => JSON.stringify(q.values)).join(' ')
    expect(eventTypes).toContain('environment_created')
    expect(eventTypes).toContain('environment_destroyed')
  })

  it('audits a destruction failure instead of claiming verified cleanup', async () => {
    const { sql, queries } = fakeSql((text) => (text.includes("status = 'destroying'") ? destroyRow() : []))
    const provider: TaskEnvironmentProvider = {
      create: async () => ({ id: 'sandbox-a', cdpUrl: 'https://sandbox-a.e2b.app' }),
      destroy: async () => { throw new Error('provider outage') },
      isDestroyed: async () => false,
    }
    await withTaskSandbox(sql, provider, { userId: 'u1', taskId: 'job-1' }, async () => 'done')
    const eventTypes = queries.filter((q) => q.text.includes('INSERT INTO audit_events'))
      .map((q) => JSON.stringify(q.values)).join(' ')
    expect(eventTypes).toContain('environment_destroy_failed')
  })

  it('never reuses a sandbox across tasks', async () => {
    const { sql } = fakeSql((text) => (text.includes("status = 'destroying'") ? destroyRow() : []))
    const { provider, calls } = fakeProvider(['sandbox-a', 'sandbox-b'])
    await withTaskSandbox(sql, provider, { userId: 'u1', taskId: 'job-1' }, async () => 'one')
    await withTaskSandbox(sql, provider, { userId: 'u1', taskId: 'job-2' }, async () => 'two')
    const creates = calls.filter((c) => c.call === 'create')
    const destroys = calls.filter((c) => c.call === 'destroy')
    expect(creates).toHaveLength(2)
    expect(creates[0]!.taskId).toBe('job-1')
    expect(creates[1]!.taskId).toBe('job-2')
    expect(destroys).toHaveLength(2)
  })
})

describe('sandbox egress policy', () => {
  it('denies cloud metadata and every private range', () => {
    for (const required of ['169.254.0.0/16', '10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16', '127.0.0.0/8', 'fe80::/10']) {
      expect(DENIED_EGRESS).toContain(required)
    }
  })
})

describe('fail-closed executor', () => {
  it('explains what is missing instead of silently running locally', () => {
    expect(UNCONFIGURED_ERROR).toContain('E2B_API_KEY')
    expect(UNCONFIGURED_ERROR).toContain('HIREALPHA_ALLOW_LOCAL_BROWSER=1')
  })
})
