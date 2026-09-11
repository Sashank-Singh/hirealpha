/**
 * Move conversational memory off the plaintext `hire_memories` table and onto
 * the encrypted, consent-gated `memory_records` system of record, and project
 * each fact into the retrieval index.
 *
 *   DATABASE_URL=... bun scripts/backfill-memory.ts --dry-run
 *   DATABASE_URL=... bun scripts/backfill-memory.ts
 *
 * Safe to re-run: `storeConsentedMemory` upserts on (user, persona, fact key),
 * so a second pass overwrites the same rows instead of duplicating them, and
 * `ensureMemoryConsent` reuses an active grant.
 *
 * Nothing here deletes `hire_memories`. Reads still fall back to it, and the
 * legacy table is what makes this migration reversible — drop it in a separate,
 * deliberate change once the new path has run clean in production.
 */
import { SQL } from 'bun'
import { openBaoBrokerFromEnv, type UserKeyBroker } from '../services/trust/userKeyBroker'
import {
  CONSENT_PURPOSE,
  categoryForKey,
  ensureMemoryConsent,
  maxRetentionDays,
  storeConsentedMemory,
} from '../services/trust/memoryLifecycle'
import { memoryIndexFromEnv } from '../services/trust/memoryIndex'

type LegacyRow = { user_id: string; persona: string; key: string; value: string; durable: boolean }

export type BackfillReport = {
  users: number
  facts: number
  stored: number
  skipped: number
  failed: number
}

export async function backfillMemories(
  sql: SQL,
  options: {
    dryRun?: boolean
    index?: ReturnType<typeof memoryIndexFromEnv>
    /** Injectable for tests; defaults to the OpenBao broker from the env. */
    broker?: UserKeyBroker | null
    log?: (line: string) => void
  } = {},
): Promise<BackfillReport> {
  const log = options.log ?? ((line: string) => console.info(line))
  const index = options.index ?? memoryIndexFromEnv()
  const broker = options.broker === undefined ? openBaoBrokerFromEnv() : options.broker
  if (!broker && !options.dryRun) {
    throw new Error(
      'OPENBAO_ADDR and OPENBAO_TOKEN are required: memory_records is encrypted with per-user keys.',
    )
  }

  const rows = (await sql`
    SELECT user_id, persona, key, value, durable
    FROM hire_memories
    WHERE value <> '' AND key <> ''
    ORDER BY user_id, persona, key
  `) as LegacyRow[]

  const report: BackfillReport = { users: 0, facts: rows.length, stored: 0, skipped: 0, failed: 0 }
  if (!rows.length) {
    log('[backfill] hire_memories is empty; nothing to migrate')
    return report
  }

  const byUser = new Map<string, LegacyRow[]>()
  for (const row of rows) {
    if (!byUser.has(row.user_id)) byUser.set(row.user_id, [])
    byUser.get(row.user_id)!.push(row)
  }
  report.users = byUser.size
  log(`[backfill] ${report.facts} facts across ${report.users} users${options.dryRun ? ' (dry run)' : ''}`)

  const personasByUser = new Map<string, Set<string>>()
  for (const row of rows) {
    if (!personasByUser.has(row.user_id)) personasByUser.set(row.user_id, new Set())
    personasByUser.get(row.user_id)!.add(row.persona)
  }

  for (const [userId, facts] of byUser) {
    const personas = personasByUser.get(userId)!
    if (options.dryRun) {
      for (const persona of personas) {
        const wanted = facts.filter((f) => f.persona === persona).length
        log(`[backfill]   would grant consent for ${persona} and store ${wanted} facts`)
      }
      report.stored += facts.length
      continue
    }

    // Consent first: without an active grant every store below is refused.
    for (const persona of personas) {
      try {
        await ensureMemoryConsent(sql, { userId, persona, source: 'migration_backfill' })
      } catch (err) {
        report.failed += facts.filter((f) => f.persona === persona).length
        log(`[backfill]   consent failed for ${persona}: ${err instanceof Error ? err.message : err}`)
      }
    }

    for (const fact of facts) {
      const category = categoryForKey(fact.key)
      try {
        await storeConsentedMemory(sql, broker!, {
          userId,
          persona: fact.persona,
          key: fact.key,
          durable: fact.durable,
          category,
          purpose: CONSENT_PURPOSE,
          content: `${fact.key}: ${fact.value}`,
          retentionDays: maxRetentionDays(category),
          source: 'migration_backfill',
          index,
        })
        report.stored += 1
      } catch (err) {
        report.failed += 1
        log(`[backfill]   ${fact.key} failed: ${err instanceof Error ? err.message : err}`)
      }
    }
  }

  log(
    `[backfill] done: stored=${report.stored} skipped=${report.skipped} failed=${report.failed}`,
  )
  return report
}

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL?.trim()
  if (!databaseUrl) {
    console.error('[backfill] DATABASE_URL is required')
    process.exit(1)
  }
  const dryRun = process.argv.includes('--dry-run')
  const sql = new SQL(databaseUrl, {
    max: 1,
    idleTimeout: 10,
    connectionTimeout: 10,
    connection: { options: '-c timezone=UTC' },
  })
  try {
    const report = await backfillMemories(sql, { dryRun })
    if (!dryRun && report.failed > 0) process.exitCode = 1
  } finally {
    await sql.close()
  }
}

if (import.meta.main) await main()
