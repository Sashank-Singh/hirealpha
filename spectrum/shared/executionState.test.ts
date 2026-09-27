import { afterEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beginExecution, cancelExecution, finishExecution, markProviderCall, readExecution } from './executionState'

describe('durable execution cancellation', () => {
  const dirs: string[] = []
  afterEach(() => dirs.splice(0).forEach(d => rmSync(d, { recursive: true, force: true })))
  it('confirms cancellation before an external commit and survives restart', () => {
    const dir = mkdtempSync(join(tmpdir(), 'alpha-exec-')); dirs.push(dir)
    const task = beginExecution(dir, 'u')
    expect(cancelExecution(dir, 'u')?.status).toBe('cancelled')
    expect(finishExecution(dir, 'u', task.version)?.status).toBe('cancelled')
    expect(readExecution(dir, 'u')).toMatchObject({ version: task.version, status: 'cancelled' })
  })
  it('records unknown outcome when cancellation races a provider call', () => {
    const dir = mkdtempSync(join(tmpdir(), 'alpha-exec-')); dirs.push(dir)
    const task = beginExecution(dir, 'u')
    markProviderCall(dir, 'u', task.version)
    expect(cancelExecution(dir, 'u')?.status).toBe('cancellation_requested')
    expect(finishExecution(dir, 'u', task.version)?.status).toBe('outcome_unknown')
    expect(beginExecution(dir, 'u').version).toBe(task.version + 1)
  })
})
