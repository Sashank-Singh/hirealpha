import { expect, test } from 'bun:test'
import { apiGetMailMessage } from './api'

test('reading a brief email uses the card token even when a local email is present', async () => {
  const original = globalThis.fetch
  let requested = ''
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    requested = String(input)
    return new Response(JSON.stringify({ ok: true, messageId: 'mail-1' }), { headers: { 'content-type': 'application/json' } })
  }) as typeof fetch
  try {
    const result = await apiGetMailMessage({ token: 'card-token', email: 'saved@example.com', messageId: 'mail-1' })
    expect(result.ok).toBe(true)
    expect(requested).toBe('/api/mail/mail-1?t=card-token')
  } finally {
    globalThis.fetch = original
  }
})
