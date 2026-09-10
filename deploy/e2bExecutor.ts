/**
 * Fresh-sandbox execution for browser tasks.
 *
 * Every hire_browser_jobs task that runs in production mode gets a brand-new
 * E2B sandbox: fresh Chromium, fresh filesystem, no shared state with any
 * other task. The sandbox receives only task-bound metadata — never
 * plaintext passwords, permanent provider tokens, OpenBao tokens, or
 * database credentials. The worker drives Chromium over CDP, so vault
 * credentials stay in worker memory and are typed into the page without ever
 * being written to the sandbox's env, disk, or logs.
 *
 * Modes (resolveBrowserExecutorMode):
 *  - 'e2b'          E2B_API_KEY + E2B_BROWSER_TEMPLATE set → fresh sandbox per task.
 *  - 'local'        HIREALPHA_ALLOW_LOCAL_BROWSER=1 → the worker's own Chromium
 *                   (the noVNC session-view stack). Development/fallback gate;
 *                   must be set explicitly, never a silent default.
 *  - 'unconfigured' No sandbox and no gate → jobs fail closed.
 */
import type { SQL } from 'bun'
import { appendAuditEvent } from '../services/trust/auditLedger'
import {
  destroyTaskEnvironment,
  provisionTaskEnvironment,
  type TaskEnvironmentProvider,
} from '../services/trust/taskEnvironments'

export type BrowserExecutorMode = 'e2b' | 'local' | 'unconfigured'

export function resolveBrowserExecutorMode(env: Record<string, string | undefined> = process.env): BrowserExecutorMode {
  if (env.E2B_API_KEY?.trim() && env.E2B_BROWSER_TEMPLATE?.trim()) return 'e2b'
  if (env.HIREALPHA_ALLOW_LOCAL_BROWSER === '1') return 'local'
  return 'unconfigured'
}

export const UNCONFIGURED_ERROR =
  'Browser sandbox is not configured. Set E2B_API_KEY and E2B_BROWSER_TEMPLATE, or explicitly opt into local execution with HIREALPHA_ALLOW_LOCAL_BROWSER=1.'

/** Run one browser task inside a dedicated sandbox. Provisions before `run`,
 * destroys in a finally (success, error, cancellation and timeout all pass
 * through here), verifies the destruction, and writes both lifecycle events
 * to the tamper-evident audit ledger. */
export async function withTaskSandbox<T>(
  sql: SQL,
  provider: TaskEnvironmentProvider,
  input: { userId: string; taskId: string; timeoutMs?: number },
  run: (cdpUrl: string) => Promise<T>,
): Promise<T> {
  const environment = await provisionTaskEnvironment(sql, provider, input)
  await appendAuditEvent(sql, {
    userId: input.userId,
    taskId: input.taskId,
    eventType: 'environment_created',
    resourceType: 'computer',
    outcome: 'ready',
    safeMetadata: { environment_id: environment.providerEnvironmentId, provider: 'e2b' },
  })
  try {
    return await run(environment.cdpUrl)
  } finally {
    const result = await destroyTaskEnvironment(sql, provider, { userId: input.userId, taskId: input.taskId })
      .catch(() => 'verification_failed' as const)
    const verified = result === 'destroyed'
    await appendAuditEvent(sql, {
      userId: input.userId,
      taskId: input.taskId,
      eventType: verified ? 'environment_destroyed' : 'environment_destroy_failed',
      resourceType: 'computer',
      outcome: verified ? 'verified' : 'unverified',
      safeMetadata: { environment_id: environment.providerEnvironmentId, provider: 'e2b' },
    })
  }
}
