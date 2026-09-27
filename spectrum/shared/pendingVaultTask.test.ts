import { afterEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadMemory, setPendingVaultTask } from './memory'
import { enqueuePendingVaultTask } from './pendingVaultTask'

describe('durable pending vault task', () => {
  const dirs: string[] = []
  afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })))

  it('keeps one identity through failure, restart, retry, and success', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'alpha-vault-')); dirs.push(dir)
    const task = { id: 'task-1', portal: 'https://example.com', goal: 'check status', originalText: 'check status', createdAt: 1, state: 'pending' as const }
    setPendingVaultTask(dir, '+15551234567', task)
    await enqueuePendingVaultTask(dir, '+15551234567', task, async () => { throw new Error('timeout') })
    const restarted = loadMemory(dir, '+15551234567').pendingVaultTask!
    expect(restarted).toMatchObject({ id: 'task-1', state: 'retryable_failure', lastError: 'timeout' })
    await enqueuePendingVaultTask(dir, '+15551234567', restarted, async () => ({ ok: true, id: 'run-1' }))
    expect(loadMemory(dir, '+15551234567').pendingVaultTask).toBeUndefined()
  })

  it('returns login-missing tasks to pending without changing identity', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'alpha-vault-')); dirs.push(dir)
    const task = { id: 'task-2', portal: 'https://example.com', goal: 'check status', originalText: 'check status', createdAt: 1, state: 'pending' as const }
    await enqueuePendingVaultTask(dir, 'u', task, async () => ({ ok: false, needsVault: true }))
    expect(loadMemory(dir, 'u').pendingVaultTask).toMatchObject({ id: 'task-2', state: 'pending' })
  })
})
