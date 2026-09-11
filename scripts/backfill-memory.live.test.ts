/**
 * Runs the memory backfill against a real PostgreSQL with real per-user
 * encryption. Skips (never fakes a pass) when no database is configured.
 *
 *   BACKFILL_TEST_DATABASE_URL=postgres:///mem0_test \
 *   bun test scripts/backfill-memory.live.test.ts
 *
 * The property that matters most is idempotency: this runs against live
 * customer data, and a second run must not duplicate a single fact. The second
 * is that a migrated fact is readable again through the authoritative reader,
 * with the fact key intact — a backfill that encrypted correctly but lost the
 * key mapping would look fine in row counts and be useless in a prompt.
 */
import { describe, expect, it } from 'bun:test'
import { SQL } from 'bun'
import { backfillMemories } from './backfill-memory'
import { NullMemoryIndex } from '../services/trust/memoryIndex'
import { listConsentedMemories } from '../services/trust/memoryLifecycle'
import type { UserKeyBroker } from '../services/trust/userKeyBroker'

const url = process.env.BACKFILL_TEST_DATABASE_URL?.trim() || ''
const live = Boolean(url)

// A deterministic 32-byte key stands in for OpenBao: the crypto is exercised
// for real, the network dependency is not.
const testBroker: UserKeyBroker = {
  generate: async () => ({ plaintext: Buffer.alloc(32, 7), wrapped: 'vault:v1:test' }),
  unwrap: async () => Buffer.alloc(32, 7),
}

async function makeSchema(sql: SQL) {
  await sql.unsafe(
    `DROP TABLE IF EXISTS memory_records, consent_records, user_wrapped_keys, hire_memories, hire_users CASCADE`,
  )
  await sql`CREATE TABLE hire_users (id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE)`
  await sql`
    CREATE TABLE hire_memories (
      user_id TEXT NOT NULL, persona TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL,
      durable BOOLEAN NOT NULL DEFAULT false, updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (user_id, persona, key)
    )
  `
  await sql`
    CREATE TABLE user_wrapped_keys (
      user_id TEXT PRIMARY KEY, wrapped_dek TEXT, key_version INTEGER NOT NULL DEFAULT 1,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(), rotated_at TIMESTAMPTZ, destroyed_at TIMESTAMPTZ
    )
  `
  await sql`
    CREATE TABLE consent_records (
      id UUID PRIMARY KEY, user_id TEXT NOT NULL, resource_type TEXT NOT NULL, category TEXT,
      purpose TEXT NOT NULL, status TEXT NOT NULL, granted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      expires_at TIMESTAMPTZ, revoked_at TIMESTAMPTZ, consent_version INTEGER NOT NULL DEFAULT 1, source TEXT
    )
  `
  await sql`
    CREATE TABLE memory_records (
      id UUID PRIMARY KEY, user_id TEXT NOT NULL, category TEXT NOT NULL, purpose TEXT NOT NULL,
      ciphertext TEXT, source TEXT, consent_id UUID NOT NULL REFERENCES consent_records(id),
      retention_days INTEGER NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      expires_at TIMESTAMPTZ NOT NULL, deleted_at TIMESTAMPTZ, deletion_reason TEXT,
      persona TEXT NOT NULL DEFAULT '', memory_key TEXT, durable BOOLEAN NOT NULL DEFAULT false
    )
  `
  await sql`CREATE UNIQUE INDEX memory_records_fact_idx ON memory_records (user_id, persona, memory_key) WHERE memory_key IS NOT NULL AND deleted_at IS NULL`
  await sql`INSERT INTO hire_users (id, email) VALUES ('u1', 'u1@example.com')`
}

const run = (sql: SQL, extra: Record<string, unknown> = {}) =>
  backfillMemories(sql, { index: new NullMemoryIndex(), broker: testBroker, log: () => {}, ...extra })

describe.skipIf(!live)('memory backfill against a real database', () => {
  it('migrates legacy facts, is idempotent, and round-trips through the reader', async () => {
    const sql = new SQL(url, { max: 1 })
    try {
      await makeSchema(sql)
      await sql`
        INSERT INTO hire_memories (user_id, persona, key, value, durable) VALUES
          ('u1', 'friend', 'hard_nos', 'no pork', true),
          ('u1', 'friend', 'drink_order', 'oat milk flat white', false),
          ('u1', 'coworker', 'company', 'Acme', true)
      `

      const first = await run(sql)
      expect(first).toMatchObject({ users: 1, facts: 3, stored: 3, failed: 0 })
      const count = async () =>
        ((await sql`SELECT count(*)::int AS n FROM memory_records WHERE deleted_at IS NULL`) as Array<{ n: number }>)[0]!.n
      expect(await count()).toBe(3)

      // Re-running must not duplicate. Consent is reused, facts upsert.
      const second = await run(sql)
      expect(second.stored).toBe(3)
      expect(await count()).toBe(3)
      expect(
        ((await sql`SELECT count(*)::int AS n FROM consent_records`) as Array<{ n: number }>)[0]!.n,
      ).toBeLessThanOrEqual(5)

      // The plaintext never reaches the database.
      const ciphertexts = (await sql`SELECT ciphertext FROM memory_records`) as Array<{ ciphertext: string }>
      for (const row of ciphertexts) {
        expect(row.ciphertext.startsWith('v2.')).toBe(true)
        expect(row.ciphertext).not.toContain('pork')
      }

      // And the fact is readable again, keyed, through the authoritative reader.
      const friendFacts = await listConsentedMemories(sql, testBroker, { userId: 'u1', persona: 'friend' })
      expect(friendFacts.map((f) => `${f.key}=${f.value}`).sort()).toEqual([
        'drink_order=oat milk flat white',
        'hard_nos=no pork',
      ])
      expect(friendFacts.find((f) => f.key === 'hard_nos')!.durable).toBe(true)
      // Personas stay partitioned: the coworker fact must not leak into friend.
      expect(friendFacts.some((f) => f.key === 'company')).toBe(false)
    } finally {
      await sql.close()
    }
  }, 120_000)

  it('reports what it would do without writing when asked to dry run', async () => {
    const sql = new SQL(url, { max: 1 })
    try {
      await makeSchema(sql)
      await sql`INSERT INTO hire_memories (user_id, persona, key, value) VALUES ('u1', 'friend', 'city', 'Austin')`
      const report = await run(sql, { dryRun: true, broker: null })
      expect(report.stored).toBe(1)
      expect(
        ((await sql`SELECT count(*)::int AS n FROM memory_records`) as Array<{ n: number }>)[0]!.n,
      ).toBe(0)
    } finally {
      await sql.close()
    }
  }, 60_000)
})
