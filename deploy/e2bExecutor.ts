/**
 * Browser task execution.
 *
 * Every hire_browser_jobs task runs in its own browser: a fresh Chromium
 * process with its own user-data dir and profile, closed in a finally. The
 * browser never receives vault credentials, permanent provider tokens, OpenBao
 * tokens, or database credentials — the worker drives it over CDP and types
 * credentials into the page, so they stay in worker memory.
 *
 * Two execution backends, one contract:
 *
 *  - 'local' (default, free)  A fresh Chromium process in the worker container.
 *      Isolation is process-level: separate browser, separate profile, nothing
 *      shared between tasks, destroyed after each one. The container is the
 *      outer boundary. No third-party account, no per-task cost.
 *  - 'e2b'   (paid, opt-in)   A fresh E2B sandbox per task — machine-level
 *      isolation on top of process isolation, at a per-task price. Selected by
 *      setting E2B_API_KEY + E2B_BROWSER_TEMPLATE.
 *  - 'disabled'  Operator kill switch; jobs fail closed with a clear message.
 *
 * HIREALPHA_BROWSER_MODE forces a mode ('local' | 'e2b' | 'disabled') and wins
 * over auto-detection, so a paid key can sit in the environment unused.
 */
import type { SQL } from 'bun'
import { appendAuditEvent } from '../services/trust/auditLedger'
import {
  destroyTaskEnvironment,
  provisionTaskEnvironment,
  type TaskEnvironmentProvider,
} from '../services/trust/taskEnvironments'

export type BrowserExecutorMode = 'e2b' | 'kernel' | 'local' | 'disabled'

export function resolveBrowserExecutorMode(env: Record<string, string | undefined> = process.env): BrowserExecutorMode {
  const forced = env.HIREALPHA_BROWSER_MODE?.trim().toLowerCase()
  // Safety switches win over any key: "local" and "disabled" are deliberate
  // operator decisions about isolation, never performance preferences.
  if (forced === 'local' || forced === 'disabled') return forced
  // A configured Kernel key outranks an older e2b pin: the key is the whole
  // point of the provider, and a stale mode string must not keep sending
  // real-site tasks at the backend that answers bot challenges with a wall.
  if (env.KERNEL_API_KEY?.trim()) return 'kernel'
  if (forced === 'e2b' || forced === 'kernel') return forced
  // Kernel first when it is configured: it is the only backend with managed
  // stealth, so a site that answers our own Chromium with a bot wall still
  // returns real content. E2B stays the fallback it was.
  if (env.KERNEL_API_KEY?.trim()) return 'kernel'
  if (env.E2B_API_KEY?.trim() && env.E2B_BROWSER_TEMPLATE?.trim()) return 'e2b'
  // Fail closed. Local Chromium on a shared host OOM-killed Postgres three
  // times (1.27 GB peak per task measured); it is an explicitly flagged
  // development/incident mode now, never a silent default.
  return 'disabled'
}

export const DISABLED_ERROR =
  'Browser tasks are disabled: no execution backend is configured. Set KERNEL_API_KEY for the managed cloud browser, or E2B_API_KEY + E2B_BROWSER_TEMPLATE for sandboxed execution, or HIREALPHA_BROWSER_MODE=local to explicitly accept reduced isolation on this host.'


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
