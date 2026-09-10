import { describe, expect, it } from 'bun:test'
import { appendAuditEvent, sanitizeAuditMetadata } from './auditLedger'

function fakeSql(previous?: Buffer) {
  const queries: Array<{ text: string; values: unknown[] }> = []
  const sql = ((strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.join('?')
    queries.push({ text, values })
    if (text.includes('SELECT event_hash')) return Promise.resolve(previous ? [{ event_hash: previous }] : [])
    return Promise.resolve([])
  }) as any
  sql.begin = async (fn: (tx: typeof sql) => Promise<void>) => fn(sql)
  return { sql, queries }
}

describe('append-only audit ledger', () => {
  it('rejects secret-shaped metadata even when the caller claims it is safe', () => {
    expect(() => sanitizeAuditMetadata({ password: 'never-log-me' })).toThrow('forbidden')
    expect(() => sanitizeAuditMetadata({ authorization_token: 'never-log-me' })).toThrow('forbidden')
  })

  it('allow-lists metadata and drops unknown fields', () => {
    expect(sanitizeAuditMetadata({ merchant: 'Example', random_note: 'drop', amount_cents: 1200 }))
      .toEqual({ amount_cents: 1200, merchant: 'Example' })
  })

  it('serializes each user chain before reading and inserting its prior hash', async () => {
    const { sql, queries } = fakeSql(Buffer.alloc(32, 4))
    const result = await appendAuditEvent(sql, {
      userId: 'user-1', taskId: 'task-1', eventType: 'capability.consumed',
      resourceType: 'credential', outcome: 'completed', safeMetadata: { origin: 'https://example.com' },
      occurredAt: new Date('2026-09-09T12:00:00.000Z'),
    })
    expect(result.hash).toHaveLength(64)
    expect(queries[0]!.text).toContain('pg_advisory_xact_lock')
    expect(queries[1]!.text).toContain('SELECT event_hash')
    const insert = queries.find((query) => query.text.includes('INSERT INTO audit_events'))!
    expect(JSON.stringify(insert.values)).not.toContain('password')
  })
})
