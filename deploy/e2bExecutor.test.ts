import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  DISABLED_ERROR,
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
    // A bare key must not silently switch a free deployment onto a paid path.
    expect(resolveBrowserExecutorMode({ E2B_API_KEY: 'k' })).toBe('local')
    expect(resolveBrowserExecutorMode({ E2B_BROWSER_TEMPLATE: 'hirealpha-browser' })).toBe('local')
  })

  it('defaults to free local execution with no configuration at all', () => {
    expect(resolveBrowserExecutorMode({})).toBe('local')
  })

  it('lets an operator force a mode, including leaving a paid key unused', () => {
    const paidEnv = { E2B_API_KEY: 'k', E2B_BROWSER_TEMPLATE: 't' }
    expect(resolveBrowserExecutorMode({ ...paidEnv, HIREALPHA_BROWSER_MODE: 'local' })).toBe('local')
    expect(resolveBrowserExecutorMode({ HIREALPHA_BROWSER_MODE: 'disabled' })).toBe('disabled')
    expect(resolveBrowserExecutorMode({ HIREALPHA_BROWSER_MODE: 'E2B' })).toBe('e2b')
    // Nonsense falls through to auto-detection rather than disabling work.
    expect(resolveBrowserExecutorMode({ HIREALPHA_BROWSER_MODE: 'yes' })).toBe('local')
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

describe('kill switch', () => {
  it('names the switch an operator must clear', () => {
    expect(DISABLED_ERROR).toContain('HIREALPHA_BROWSER_MODE=disabled')
  })
})

describe('local browser isolation', () => {
  it('gives every task its own profile directory and removes it afterwards', () => {
    // The isolation claim in local mode is a browser process plus its own
    // profile per task. This asserts the code that makes it true: a fresh
    // mkdtemp profile handed to launchPersistentContext, and an rm of that
    // directory in the finally block. launchPersistentContext is required —
    // passing --user-data-dir as an argument is rejected by Playwright.
    const source = readFileSync(join(import.meta.dir, 'browserSession.ts'), 'utf8')
    expect(source).toContain("mkdtemp(join(tmpdir(), 'hirealpha-chrome-'))")
    expect(source).toContain('launchPersistentContext(profileDir')
    // The profile path must reach Playwright as an argument to
    // launchPersistentContext, never as a chrome flag (Playwright rejects that).
    expect(source).not.toMatch(/args:\s*\[[^\]]*user-data-dir/s)
    expect(source).toContain('rm(profileDir, { recursive: true, force: true })')
    expect(source).toContain('profileDir = launched.profileDir')
  })
})
