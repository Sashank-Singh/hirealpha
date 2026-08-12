#!/usr/bin/env bun
/**
 * Apply SQL migrations in order. Tracks applied files in schema_migrations.
 * Usage: bun run src/db/migrate.ts
 */
import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import postgres from 'postgres'

const url = process.env.DATABASE_URL
if (!url) {
  console.error('DATABASE_URL required')
  process.exit(1)
}

const sql = postgres(url, { max: 1 })
const dir = join(import.meta.dir, '../../sql/migrations')

await sql`
  create table if not exists schema_migrations (
    id text primary key,
    applied_at timestamptz not null default now()
  )
`

const files = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort()
const applied = new Set(
  (await sql`select id from schema_migrations`).map((r) => String(r.id)),
)

for (const file of files) {
  if (applied.has(file)) {
    console.log('skip', file)
    continue
  }
  const path = join(dir, file)
  const body = await Bun.file(path).text()
  console.log('apply', file)
  await sql.begin(async (tx) => {
    await tx.unsafe(body)
    await tx`insert into schema_migrations (id) values (${file})`
  })
}

await sql.end()
console.log('migrations done')
