import { describe, expect, it } from 'bun:test'
import { destroyTaskEnvironment, provisionTaskEnvironment, type TaskEnvironmentProvider } from './taskEnvironments'

function fakeSql(rowsFor: (text: string) => unknown[] = () => []) {
  const queries: Array<{ text: string; values: unknown[] }> = []
  const sql = ((strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.join('?')
    queries.push({ text, values })
    return Promise.resolve(rowsFor(text))
  }) as never
  return { sql, queries }
}

function fakeProvider(overrides: Partial<TaskEnvironmentProvider> = {}) {
  const calls: string[] = []
  const provider: TaskEnvironmentProvider = {
    create: async () => { calls.push('create'); return { id: 'sandbox-1' } },
    destroy: async () => { calls.push('destroy') },
    isDestroyed: async () => { calls.push('verify'); return true },
    ...overrides,
  }
  return { provider, calls }
}

describe('fresh per-task environments', () => {
  it('creates a new provider environment and records the isolation policy', async () => {
    const { sql, queries } = fakeSql()
    const { provider, calls } = fakeProvider()
    const result = await provisionTaskEnvironment(sql, provider, { userId: 'user-1', taskId: 'task-1' })
    expect(result.providerEnvironmentId).toBe('sandbox-1')
    expect(calls).toEqual(['create'])
    expect(queries[0]!.text).toContain('INSERT INTO task_environments')
    expect(JSON.stringify(queries[0]!.values)).toContain('fresh_per_task')
  })

  it('destroys the sandbox if recording it fails', async () => {
    const sql = (() => Promise.reject(new Error('database down'))) as never
    const { provider, calls } = fakeProvider()
    await expect(provisionTaskEnvironment(sql, provider, { userId: 'user-1', taskId: 'task-1' })).rejects.toThrow('database down')
    expect(calls).toEqual(['create', 'destroy'])
  })

  it('verifies destruction before marking the task environment destroyed', async () => {
    const { sql, queries } = fakeSql((text) => text.includes("status = 'destroying'")
      ? [{ id: 'environment-1', provider_environment_id: 'sandbox-1' }] : [])
    const { provider, calls } = fakeProvider()
    expect(await destroyTaskEnvironment(sql, provider, { userId: 'user-1', taskId: 'task-1' })).toBe('destroyed')
    expect(calls).toEqual(['destroy', 'verify'])
    expect(queries.at(-1)!.text).toContain('destruction_verified_at')
  })
})
