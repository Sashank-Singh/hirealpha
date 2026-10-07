import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/* Guarantees that the schema bootstrap can actually run. Both checks here come
 * from real web-container boots that failed and rolled the deploy back. */
const source = readFileSync(join(import.meta.dir, 'schema.ts'), 'utf8')

describe('schema bootstrap statements', () => {
  it('keeps every parameterless sql`` template to one statement', () => {
    // Bun sends a template without bindings as a single prepared statement, so
    // two statements in one template fail at boot ("cannot insert multiple
    // commands into a prepared statement") and the whole deploy rolls back.
    const offenders: string[] = []
    for (const match of source.matchAll(/sql`([^`]*)`/g)) {
      const body = match[1]!
      if (body.includes('${')) continue
      const separators = body.match(/;\s*(?=(?:CREATE|ALTER|INSERT|UPDATE|DELETE|DROP|GRANT|DO|WITH|COMMENT|SELECT|SET)\b)/gi)
      if (separators?.length) offenders.push(`template with ${separators.length + 1} statements: ${body.trim().slice(0, 60)}…`)
    }
    expect(offenders).toEqual([])
  })

  it('keys user_id references on TEXT, matching hire_users.id', () => {
    // Postgres refuses the foreign key outright when the column types differ:
    // 'foreign key constraint ... cannot be implemented'. hire_users.id is TEXT.
    const mismatched = source.match(/user_id\s+UUID[^,]*REFERENCES\s+hire_users\s*\(id\)/gi) ?? []
    expect(mismatched).toEqual([])
  })
})
