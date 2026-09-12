import { createHash, randomUUID } from 'node:crypto'
import type { SQL } from 'bun'
import { Sandbox, SandboxNotFoundError } from 'e2b'

/** CDP port the browser template exposes inside the sandbox. The worker
 * connects over the sandbox's public host routing to the template's CDP
 * proxy (the proxy rewrites Host so Chromium's DevTools endpoint accepts a
 * domain host); nothing else listens. Overridable for template upgrades. */
export const SANDBOX_CDP_PORT = Number(process.env.SANDBOX_CDP_PORT || 9223)

export const DENIED_EGRESS = [
  '0.0.0.0/8', '10.0.0.0/8', '100.64.0.0/10', '127.0.0.0/8', '169.254.0.0/16',
  '172.16.0.0/12', '192.0.0.0/24', '192.168.0.0/16', '198.18.0.0/15', '224.0.0.0/4',
  '::/128', '::1/128', 'fc00::/7', 'fe80::/10', 'ff00::/8',
]

export type TaskEnvironmentProvider = {
  create(input: { taskId: string; timeoutMs: number }): Promise<{ id: string; cdpUrl?: string }>
  destroy(id: string): Promise<void>
  isDestroyed(id: string): Promise<boolean>
}

export class E2BTaskEnvironmentProvider implements TaskEnvironmentProvider {
  constructor(
    private readonly apiKey: string,
    private readonly template = process.env.E2B_BROWSER_TEMPLATE?.trim() || 'base',
  ) {
    if (!apiKey.trim()) throw new Error('E2B_API_KEY is required.')
  }

  async create(input: { taskId: string; timeoutMs: number }): Promise<{ id: string; cdpUrl: string }> {
    const timeoutMs = Math.max(60_000, Math.min(30 * 60_000, Math.floor(input.timeoutMs)))
    const sandbox = await Sandbox.create(this.template, {
      apiKey: this.apiKey,
      timeoutMs,
      // CDP must be reachable by the worker without a traffic-access token
      // (connectOverCDP cannot send headers). The sandbox holds no plaintext
      // credentials, is destroyed after the task, and denies private egress.
      secure: false,
      lifecycle: { onTimeout: 'kill', autoResume: false },
      network: { denyOut: DENIED_EGRESS },
      metadata: {
        hirealpha_task: createHash('sha256').update(input.taskId).digest('hex').slice(0, 24),
        isolation: 'fresh-per-task',
      },
    })
    const cdpUrl = `https://${sandbox.getHost(SANDBOX_CDP_PORT)}`
    await waitForCdp(cdpUrl)
    return { id: sandbox.sandboxId, cdpUrl }
  }

  async destroy(id: string): Promise<void> {
    await Sandbox.kill(id, { apiKey: this.apiKey })
  }

  async isDestroyed(id: string): Promise<boolean> {
    try {
      await Sandbox.getInfo(id, { apiKey: this.apiKey })
      return false
    } catch (error) {
      if (error instanceof SandboxNotFoundError) return true
      throw error
    }
  }
}

/** Poll the template's Chromium CDP endpoint until it answers. Fails the
 * create step (and therefore the whole sandbox) if the browser never comes
 * up, so the worker never connects to a half-started environment. */
async function waitForCdp(cdpUrl: string, timeoutMs = 45_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  let lastError = 'CDP endpoint never became ready.'
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${cdpUrl}/json/version`, { signal: AbortSignal.timeout(2_000) })
      if (response.ok) return
      lastError = `CDP endpoint returned ${response.status}.`
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error)
    }
    await Bun.sleep(500)
  }
  throw new Error(lastError)
}

export async function provisionTaskEnvironment(
  sql: SQL,
  provider: TaskEnvironmentProvider,
  input: { userId: string; taskId: string; timeoutMs?: number },
): Promise<{ id: string; providerEnvironmentId: string; cdpUrl?: string }> {
  const id = randomUUID()
  const created = await provider.create({ taskId: input.taskId, timeoutMs: input.timeoutMs ?? 15 * 60_000 })
  try {
    await sql`
      INSERT INTO task_environments (
        id, user_id, task_id, provider, provider_environment_id, status, network_policy, ready_at
      ) VALUES (
        ${id}, ${input.userId}, ${input.taskId}, 'e2b', ${created.id}, 'ready',
        ${JSON.stringify({ deny_private_egress: true, fresh_per_task: true })}::jsonb, now()
      )
    `
  } catch (error) {
    await provider.destroy(created.id).catch(() => undefined)
    throw error
  }
  return { id, providerEnvironmentId: created.id, cdpUrl: created.cdpUrl }
}

export async function destroyTaskEnvironment(
  sql: SQL,
  provider: TaskEnvironmentProvider,
  input: { userId: string; taskId: string },
): Promise<'destroyed' | 'not_found' | 'verification_failed'> {
  const rows = (await sql`
    UPDATE task_environments SET status = 'destroying'
    WHERE user_id = ${input.userId} AND task_id = ${input.taskId} AND status IN ('ready', 'running', 'failed')
    RETURNING id, provider_environment_id
  `) as Array<{ id: string; provider_environment_id: string }>
  const row = rows[0]
  if (!row) return 'not_found'
  await provider.destroy(row.provider_environment_id)
  const destroyed = await provider.isDestroyed(row.provider_environment_id)
  await sql`
    UPDATE task_environments
    SET status = ${destroyed ? 'destroyed' : 'destruction_failed'}, destroyed_at = now(),
        destruction_verified_at = CASE WHEN ${destroyed} THEN now() ELSE NULL END
    WHERE id = ${row.id} AND user_id = ${input.userId}
  `
  return destroyed ? 'destroyed' : 'verification_failed'
}
