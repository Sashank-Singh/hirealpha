/**
 * Runs the real migrations against a real PostgreSQL. Skips (never fakes a
 * pass) when no database is reachable.
 *
 *   MIGRATE_TEST_DATABASE_URL=postgres://user@host:port/db bun test deploy/migrate.live.test.ts
 *
 * This is the test that would have caught the prod incident: the runner's
 * filename pattern matched none of the shipped files, so all nine migrations
 * were skipped while the boot log still printed "schema current".
 */
import { describe, expect, it } from 'bun:test'
import { SQL } from 'bun'
import { runMigrations } from './migrate'

const url = process.env.MIGRATE_TEST_DATABASE_URL?.trim() || ''
const live = Boolean(url)

describe.skipIf(!live)('migrations against a real database', () => {
  it('applies every shipped migration on a blank schema and is idempotent', async () => {
    const sql = new SQL(url, { max: 1 })
    try {
      // True blank schema. The chain owns every table it needs: 0000 creates
      // hire_users, 00065 creates the full runtime shapes. Pre-creating minimal
      // stand-ins here once hid the drift between "test shape" and "prod shape"
      // (no created_at on hire_browser_jobs -> 00065's index failed).
      await sql`DROP SCHEMA public CASCADE`
      await sql`CREATE SCHEMA public`

      const applied = await runMigrations(sql)
      expect(applied.length).toBeGreaterThan(0)
      expect(await runMigrations(sql)).toEqual([])

      const tables = (await sql`SELECT tablename FROM pg_tables WHERE schemaname = 'public'`) as Array<{ tablename: string }>
      const names = tables.map((t) => t.tablename)
      for (const required of ['capability_grants', 'audit_events', 'task_environments', 'user_wrapped_keys', 'vault_items_v2', 'consent_records', 'memory_records', 'hire_tasks', 'hire_task_events']) {
        expect(names).toContain(required)
      }

      const trigger = (await sql`SELECT tgname FROM pg_trigger WHERE tgname = 'audit_events_no_update'`) as Array<{ tgname: string }>
      expect(trigger).toHaveLength(1)

      const columns = (await sql`
        SELECT column_name FROM information_schema.columns
        WHERE table_name = 'hire_browser_jobs' AND column_name LIKE 'credential%'
      `) as Array<{ column_name: string }>
      expect(columns.map((c) => c.column_name).sort()).toEqual([
        'credential_capability_digest', 'credential_capability_id', 'credential_task_id',
      ])
    } finally {
      await sql.close()
    }
  })

  it('refuses to run a migration whose body changed after it was applied', async () => {
    const sql = new SQL(url, { max: 1 })
    try {
      await runMigrations(sql)
      await sql`UPDATE hire_schema_migrations SET checksum = ${'0'.repeat(64)} WHERE name = (SELECT name FROM hire_schema_migrations ORDER BY name LIMIT 1)`
      await expect(runMigrations(sql)).rejects.toThrow('Applied migration was modified')
      // Restore so a rerun of this file is not permanently poisoned.
      await sql`DELETE FROM hire_schema_migrations WHERE checksum = ${'0'.repeat(64)}`
    } finally {
      await sql.close()
    }
  })

  it('works through a pooled handle larger than one connection', async () => {
    // The web server's pool is max: 12; the migration batch needs a reserved
    // connection or it fails with "Only use sql.begin, sql.reserved or max: 1".
    const sql = new SQL(url, { max: 12 })
    try {
      await sql`DELETE FROM hire_schema_migrations`
      const applied = await runMigrations(sql)
      expect(applied.length).toBeGreaterThan(0)
    } finally {
      await sql.close()
    }
  })
})
