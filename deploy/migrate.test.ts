import { describe, expect, it } from 'bun:test'
import { buildMigrationBatch, migrationChecksum } from './migrate'

describe('versioned migration runner', () => {
  it('uses stable sha256 checksums', () => {
    expect(migrationChecksum('SELECT 1;')).toBe('17db4fd369edb9244b9f91d9aeed145c3d04ad8ba6e95d06247f07a63527d11a')
  })

  it('commits schema and migration ledger atomically', () => {
    const body = 'CREATE TABLE example (id TEXT PRIMARY KEY);'
    const batch = buildMigrationBatch('202609090001-example.sql', migrationChecksum(body), body)
    expect(batch.startsWith('BEGIN;')).toBe(true)
    expect(batch).toContain(body)
    expect(batch).toContain('INSERT INTO hire_schema_migrations')
    expect(batch.endsWith('COMMIT;')).toBe(true)
  })

  it('rejects malformed filenames, checksums, and nested transactions', () => {
    expect(() => buildMigrationBatch('../escape.sql', 'a'.repeat(64), 'SELECT 1;')).toThrow('filename')
    expect(() => buildMigrationBatch('202609090001-example.sql', 'nope', 'SELECT 1;')).toThrow('checksum')
    expect(() => buildMigrationBatch('202609090001-example.sql', 'a'.repeat(64), 'BEGIN; SELECT 1; COMMIT;')).toThrow('transaction')
  })
})
