import { describe, expect, it } from 'bun:test'
import { handleReminderRoutes } from './routes/reminders'
import type { SQL } from 'bun'

type Row = { id: string; status: string; claimToken?: string; providerId?: string; attempts: number }

function request(path: string, method = 'GET', body?: unknown, headers: Record<string, string> = {}) {
  return new Request(`http://local${path}`, { method, headers: { 'content-type': 'application/json', ...headers }, ...(body ? { body: JSON.stringify(body) } : {}) })
}

describe('scheduled text leases', () => {
  it('reclaims a crash before send, but quarantines a crash after begin', async () => {
    const queries: string[] = []
    const sql = (async (strings: TemplateStringsArray) => {
      const q = strings.join('?'); queries.push(q)
      if (q.includes("status = 'preparing'")) return [{ id: '11111111-1111-4111-8111-111111111111', claimToken: '22222222-2222-4222-8222-222222222222', toPhone: '+15550000002', ownerPhone: '+15550000001', body: 'hello' }]
      return []
    }) as unknown as SQL
    const res = await handleReminderRoutes(request('/api/internal/scheduled_texts/claim?persona=friend'), sql, { internalOk: () => true })
    expect(res?.status).toBe(200)
    expect(queries[0]).toContain("status = 'pending', lease_until = NULL")
    expect(queries[0]).toContain("status = 'outcome_unknown'")
    expect(queries[0]).toContain("status = 'preparing'")
    expect(queries[0]).toContain('FOR UPDATE SKIP LOCKED')
  })

  it('requires the same lease token for begin and acknowledgement and stores provider identity', async () => {
    const queries: string[] = []
    const sql = (async (strings: TemplateStringsArray) => { queries.push(strings.join('?')); return [{ id: 'x' }] }) as unknown as SQL
    const id = '11111111-1111-4111-8111-111111111111'
    const claimToken = '22222222-2222-4222-8222-222222222222'
    expect((await handleReminderRoutes(request('/api/internal/scheduled_texts/begin', 'POST', { id, claimToken }), sql, { internalOk: () => true }))?.status).toBe(200)
    expect((await handleReminderRoutes(request('/api/internal/scheduled_texts/ack', 'POST', { id, claimToken, ok: true, providerId: 'provider-7' }), sql, { internalOk: () => true }))?.status).toBe(200)
    expect(queries[0]).toContain("status = 'preparing'")
    expect(queries[1]).toContain("status = 'sending'")
    expect(queries[1]).toContain('provider_delivery_id')
  })

  it('deduplicates an identical scheduler request in the database', async () => {
    const insertQueries: Array<{ text: string; values: unknown[] }> = []
    const row: Row = { id: '11111111-1111-4111-8111-111111111111', status: 'pending', attempts: 0 }
    const sql = (async (strings: TemplateStringsArray, ...values: unknown[]) => {
      const q = strings.join('?')
      if (q.includes('FROM hire_users')) return [{ id: 'u1', phone_e164: '+15550000001' }]
      if (q.includes('INSERT INTO hire_scheduled_texts')) { insertQueries.push({ text: q, values }); return [{ id: row.id, send_at: new Date('2027-01-01T00:00:00Z') }] }
      return []
    }) as unknown as SQL
    const body = { phone: '+15550000001', to: '+15550000002', text: 'happy birthday', at: '2027-01-01T00:00:00Z' }
    await handleReminderRoutes(request('/api/internal/scheduled_texts', 'POST', body), sql, { internalOk: () => true })
    await handleReminderRoutes(request('/api/internal/scheduled_texts', 'POST', body), sql, { internalOk: () => true })
    expect(insertQueries).toHaveLength(2)
    expect(insertQueries[0]!.text).toContain('ON CONFLICT (idempotency_key)')
    expect(insertQueries[0]!.values.at(-1)).toBe(insertQueries[1]!.values.at(-1))
  })
})
