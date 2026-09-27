import { expect, it } from 'bun:test'
import { handleUserPaymentsApi } from './userPayments'
for (const state of ['pending', 'executing', 'succeeded', 'outcome_unknown']) {
  it(`UX02 cancellation distinguishes ${state}`, async () => {
    let persisted = state
    const sql = (async (s: TemplateStringsArray, ...v: unknown[]) => {
      const q = s.join('?')
      if (q.includes('SELECT') && q.includes('hire_spend_approvals')) return [{ status: persisted === 'pending' ? 'pending' : 'consumed', consumed_at: state === 'pending' ? null : new Date(), finalization_status: state === 'succeeded' ? 'completed' : state, order_confirmation: state === 'succeeded' ? 'receipt' : null }]
      if (q.includes('UPDATE hire_spend_approvals') && v.includes('denied') && persisted === 'pending') { persisted = 'denied'; return [{ id: 'r' }] }
      return []
    }) as any
    const response = await handleUserPaymentsApi(new Request('https://test/api/internal/spend/decide', { method: 'POST', body: JSON.stringify({ phone: '+15555550123', requestId: 'r', decision: 'deny' }) }), sql, { internalOk: () => true, resolveUser: async () => null, livePayload: async () => ({ found: true, userId: 'u' }) })
    const data = await response!.json()
    expect(data.state).toBe(state === 'pending' ? 'cancelled' : state)
    expect(data.ok).toBe(state === 'pending')
    expect(persisted).toBe(state === 'pending' ? 'denied' : state)
  })
}
it('UX01 rejects changed purchase terms before approval/charge', async () => {
  let writes = 0
  const sql = (async (s: TemplateStringsArray) => {
    if (s.join('?').includes('UPDATE')) writes++
    return [{ status: 'pending', amount_cents: 12500, purpose: 'different item', created_at: new Date() }]
  }) as any
  const response = await handleUserPaymentsApi(new Request('https://test/api/internal/spend/decide', { method: 'POST', body: JSON.stringify({ phone: '+15555550123', requestId: 'r', decision: 'approve', terms: { amountCents: 9900, purpose: 'headphones' } }) }), sql, { internalOk: () => true, resolveUser: async () => null, livePayload: async () => ({ found: true, userId: 'u' }) })
  expect(response!.status).toBe(409)
  expect(writes).toBe(0)
})
