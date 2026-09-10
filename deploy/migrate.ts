import { createHash } from 'node:crypto'
import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { SQL } from 'bun'

const MIGRATION_NAME = /^\d{12,}-[a-z0-9][a-z0-9_-]*\.sql$/

export function migrationChecksum(body: string): string {
  return createHash('sha256').update(body, 'utf8').digest('hex')
}

function sqlLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`
}

/** The migration and ledger insert commit together. Migration files are trusted,
 * reviewed repository code; filename and checksum are escaped SQL literals. */
export function buildMigrationBatch(name: string, checksum: string, body: string): string {
  if (!MIGRATION_NAME.test(name)) throw new Error(`Invalid migration filename: ${name}`)
  if (!/^[a-f0-9]{64}$/.test(checksum)) throw new Error(`Invalid migration checksum: ${name}`)
  if (/\b(?:BEGIN|COMMIT|ROLLBACK)\s*;/i.test(body)) throw new Error(`Migration ${name} must not manage its own transaction.`)
  return [
    'BEGIN;',
    body.trim(),
    `INSERT INTO hire_schema_migrations (name, checksum) VALUES (${sqlLiteral(name)}, ${sqlLiteral(checksum)});`,
    'COMMIT;',
  ].join('\n')
}

type UnsafeSql = SQL & { unsafe: (query: string) => Promise<unknown> }

export async function runMigrations(sql: SQL, migrationsDir = join(import.meta.dir, 'migrations')): Promise<string[]> {
  const unsafe = sql as UnsafeSql
  await sql`
    CREATE TABLE IF NOT EXISTS hire_schema_migrations (
      name TEXT PRIMARY KEY,
      checksum TEXT NOT NULL CHECK (checksum ~ '^[a-f0-9]{64}$'),
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `
  await sql`SELECT pg_advisory_lock(hashtextextended('hirealpha-schema-migrations', 0))`
  const applied: string[] = []
  try {
    const entries = (await readdir(migrationsDir)).filter((name) => MIGRATION_NAME.test(name)).sort()
    for (const name of entries) {
      const body = await Bun.file(join(migrationsDir, name)).text()
      const checksum = migrationChecksum(body)
      const existing = (await sql`
        SELECT checksum FROM hire_schema_migrations WHERE name = ${name} LIMIT 1
      `) as Array<{ checksum: string }>
      if (existing[0]) {
        if (existing[0].checksum !== checksum) throw new Error(`Applied migration was modified: ${name}`)
        continue
      }
      await unsafe.unsafe(buildMigrationBatch(name, checksum, body))
      applied.push(name)
    }
  } finally {
    await sql`SELECT pg_advisory_unlock(hashtextextended('hirealpha-schema-migrations', 0))`
  }
  return applied
}

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL?.trim()
  if (!databaseUrl) {
    console.warn('[migrate] DATABASE_URL missing; no migrations applied')
    return
  }
  const sql = new SQL(databaseUrl, {
    max: 1,
    idleTimeout: 10,
    connectionTimeout: 10,
    connection: { options: '-c timezone=UTC' },
  })
  try {
    const applied = await runMigrations(sql)
    console.info(applied.length ? `[migrate] applied ${applied.join(', ')}` : '[migrate] schema current')
  } finally {
    await sql.close()
  }
}

if (import.meta.main) await main()
