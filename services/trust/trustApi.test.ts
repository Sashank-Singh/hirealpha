import { describe, expect, it } from 'bun:test'
import { handleTrustApi } from './trustApi'

function fakeSql(rowsFor: (text: string) => unknown[] = () => []) {
  const queries: string[] = []
  const sql = ((strings: TemplateStringsArray) => {
    const text = strings.join('?')
    queries.push(text)
    return Promise.resolve(rowsFor(text))
  }) as any
  sql.begin = async (fn: (tx: typeof sql) => Promise<void>) => fn(sql)
  return { sql, queries }
}

describe('unified trust API', () => {
  it('does not own unrelated API routes', async () => {
    const { sql } = fakeSql()
    expect(await handleTrustApi(new Request('https://hirealpha.chat/api/vault'), sql, { resolveUser: async () => ({ id: 'u1' }) })).toBeNull()
  })

  it('requires authentication for every trust surface', async () => {
    const { sql } = fakeSql()
    const response = await handleTrustApi(new Request('https://hirealpha.chat/api/trust/overview'), sql, { resolveUser: async () => null })
    expect(response?.status).toBe(401)
  })

  it('returns capabilities and audit evidence in one overview', async () => {
    const { sql, queries } = fakeSql((text) => text.includes('FROM capability_grants') ? [{ id: 'cap-1' }] : [])
    const response = await handleTrustApi(new Request('https://hirealpha.chat/api/trust/overview'), sql, { resolveUser: async () => ({ id: 'u1' }) })
    expect(response?.status).toBe(200)
    expect(await response?.json()).toEqual({ capabilities: [{ id: 'cap-1' }], audit: [] })
    expect(queries.every((text) => text.includes('user_id') || !text.includes('FROM '))).toBe(true)
  })

  it('rejects approval without the immutable request digest', async () => {
    const { sql } = fakeSql()
    const response = await handleTrustApi(new Request('https://hirealpha.chat/api/trust/capabilities/cap-1/decision', {
      method: 'POST', body: JSON.stringify({ decision: 'approved' }),
    }), sql, { resolveUser: async () => ({ id: 'u1' }) })
    expect(response?.status).toBe(400)
  })
})
