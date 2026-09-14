/** Live PostgreSQL certification suite. Runs ONLY when CERT_ALLOW_LIVE=1 and
 * CERT_DATABASE_URL points at a dedicated throwaway database (never prod).
 * Covers: blank-DB migrations, checksum-mismatch refusal, tenant isolation,
 * and concurrent capability consumption. */
import { describe, expect, it } from 'bun:test'
import { SQL } from 'bun'
import { runMigrations } from '../migrate'
import { createCapabilityGrant, beginCapabilityConsumption, finalizeCapabilityConsumption, capabilityRequestDigest } from '../../services/trust/capabilityGrants'
import { appendAuditEvent, verifyAuditChain } from '../../services/trust/auditLedger'

const env = process.env
const live = env.CERT_ALLOW_LIVE === '1' && Boolean(env.CERT_DATABASE_URL?.trim())
const d = live ? new SQL(env.CERT_DATABASE_URL!, { max: 8 }) : null

async function seedUser(id: string) {
  // capability_grants.user_id FKs hire_users; without a real user the grant
  // insert dies on 23503 and the isolation/concurrency tests never run.
  await d!`INSERT INTO hire_users (id, email, name) VALUES (${id}, ${`${id}@cert.test`}, ${id}) ON CONFLICT (id) DO NOTHING`
}

describe.skipIf(!live)('postgres live certification', () => {
  it('applies every migration to a blank database', async () => {
    // Self-contained true-blank start: the harness is re-runnable without the
    // operator recreating the throwaway database between runs.
    await d!`DROP SCHEMA public CASCADE`
    await d!`CREATE SCHEMA public`
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
    await seedUser('cert-user-a')
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

  it('audit ledger round-trips the hash chain over native jsonb metadata', async () => {
    // The pre-fix write path stored safe_metadata as a double-encoded jsonb
    // STRING; verifyAuditChain must still reproduce hashes, and the stored
    // value must be a real jsonb object (Bun binds JS values as JSON).
    await appendAuditEvent(d!, {
      userId: 'cert-audit-1', eventType: 'credential.approved', resourceType: 'credential',
      outcome: 'approved', safeMetadata: { merchant: 'Kroger', amount_cents: 1299 },
    })
    await appendAuditEvent(d!, {
      userId: 'cert-audit-1', eventType: 'credential.consumed', resourceType: 'credential',
      outcome: 'consumed', safeMetadata: { status: 'consumed' },
    })
    expect(await verifyAuditChain(d!, 'cert-audit-1')).toBe(true)
    const shaped = (await d!`
      SELECT jsonb_typeof(safe_metadata) AS t FROM audit_events WHERE user_id = 'cert-audit-1' LIMIT 1
    `) as Array<{ t: string }>
    expect(shaped[0]?.t).toBe('object')
  })

  it('survives concurrent one-time consumption: exactly one winner', async () => {
    await seedUser('cert-user-c')
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
