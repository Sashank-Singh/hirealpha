/** Live PostgreSQL certification suite. Runs ONLY when CERT_ALLOW_LIVE=1 and
 * CERT_DATABASE_URL points at a dedicated throwaway database (never prod).
 * Covers: blank-DB migrations, checksum-mismatch refusal, tenant isolation,
 * and concurrent capability consumption. */
import { describe, expect, it } from 'bun:test'
import { SQL } from 'bun'
import { runMigrations } from '../migrate'
import { createCapabilityGrant, beginCapabilityConsumption, finalizeCapabilityConsumption, capabilityRequestDigest } from '../../services/trust/capabilityGrants'

const env = process.env
const live = env.CERT_ALLOW_LIVE === '1' && Boolean(env.CERT_DATABASE_URL?.trim())
const d = live ? new SQL(env.CERT_DATABASE_URL!, { max: 8 }) : null

describe.skipIf(!live)('postgres live certification', () => {
  it('applies every migration to a blank database', async () => {
    const applied = await runMigrations(d!, import.meta.dir + '/../migrations')
    expect(applied.length).toBeGreaterThan(0)
    // Idempotent second run.
    const again = await runMigrations(d!, import.meta.dir + '/../migrations')
    expect(again).toEqual([])
  })

  it('refuses to run a modified applied migration', async () => {
    await expect(runMigrations(d!, import.meta.dir + '/fixtures/tampered-migrations'))
      .rejects.toThrow('Applied migration was modified')
  })

  it('isolates tenants: user B cannot consume or read user A capability rows', async () => {
    const request = {
      userId: 'cert-user-a', taskId: 'cert-task-a', resourceType: 'credential' as const,
      resourceId: 'cert-item-a', action: 'autofill', exactOrigin: 'https://cert.example.com',
      requestingAgent: 'alpha', purpose: 'cert', expiresAt: new Date(Date.now() + 60_000),
    }
    const grant = await createCapabilityGrant(d!, request)
    await d!`UPDATE capability_grants SET status = 'approved', decided_at = now() WHERE id = ${grant.id}`
    // Cross-tenant digest is computed with the attacker's own user id.
    const attackerDigest = capabilityRequestDigest({ ...request, userId: 'cert-user-b', taskId: 'cert-task-b' })
    const stolen = await beginCapabilityConsumption(d!, {
      id: grant.id, userId: 'cert-user-b', taskId: 'cert-task-b', digest: attackerDigest,
    })
    expect(stolen).toBeNull()
    const consumed = await beginCapabilityConsumption(d!, {
      id: grant.id, userId: 'cert-user-a', taskId: 'cert-task-a', digest: grant.digest,
    })
    expect(consumed).not.toBeNull()
    await finalizeCapabilityConsumption(d!, {
      id: grant.id, userId: 'cert-user-a', taskId: 'cert-task-a', outcome: 'completed',
    })
  })

  it('survives concurrent one-time consumption: exactly one winner', async () => {
    const request = {
      userId: 'cert-user-c', taskId: 'cert-task-c', resourceType: 'credential' as const,
      resourceId: 'cert-item-c', action: 'autofill', exactOrigin: 'https://cert.example.com',
      requestingAgent: 'alpha', purpose: 'cert concurrent', expiresAt: new Date(Date.now() + 60_000),
    }
    const grant = await createCapabilityGrant(d!, request)
    await d!`UPDATE capability_grants SET status = 'approved', decided_at = now() WHERE id = ${grant.id}`
    const digest = grant.digest
    const winners = (await Promise.all([1, 2, 3, 4, 5].map(() =>
      beginCapabilityConsumption(d!, { id: grant.id, userId: 'cert-user-c', taskId: 'cert-task-c', digest }),
    )))
    expect(winners.filter(Boolean)).toHaveLength(1)
  })
})
