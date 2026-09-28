import { describe, expect, test } from 'bun:test'

/** send-it object identity: the canonical draft row is what goes out, once,
 * and every terminal state is typed — never collapsed into "sent". */

function stubFetch(routes: Array<{ match: RegExp; status?: number; body: unknown }>) {
  const calls: Array<{ url: string; body: Record<string, unknown> }> = []
  const real = globalThis.fetch
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input)
    let body: Record<string, unknown> = {}
    try { body = JSON.parse(String(init?.body || '{}')) } catch { /* GETs */ }
    calls.push({ url, body })
    for (const r of routes) {
      if (r.match.test(url)) return new Response(JSON.stringify(r.body), { status: r.status ?? 200, headers: { 'content-type': 'application/json' } })
    }
    return new Response('{}', { status: 404 })
  }) as typeof fetch
  return { calls, restore: () => { globalThis.fetch = real } }
}

const ENV = { url: process.env.HIREALPHA_API_URL, key: process.env.HIREALPHA_INTERNAL_KEY }

function withEnv() {
  process.env.HIREALPHA_API_URL = 'http://senddraft-test.internal'
  process.env.HIREALPHA_INTERNAL_KEY = 'test-key'
}
function restoreEnv() {
  if (ENV.url === undefined) delete process.env.HIREALPHA_API_URL
  else process.env.HIREALPHA_API_URL = ENV.url
  if (ENV.key === undefined) delete process.env.HIREALPHA_INTERNAL_KEY
  else process.env.HIREALPHA_INTERNAL_KEY = ENV.key
}

describe('sendDraftById — object-identity send states', () => {
  test('a pending draft sends once and returns the provider receipt', async () => {
    withEnv()
    const { calls, restore } = stubFetch([
      { match: /mail\/send-draft/, body: { ok: true, state: 'sent', providerId: 'smtp_88', toAddr: 'dana@bigco.com', version: 2 } },
    ])
    try {
      const { sendDraftById } = await import('./liveContext')
      const out = await sendDraftById('+15550001234', 'friend', 'd1')
      expect(out).toMatchObject({ ok: true, state: 'sent', providerId: 'smtp_88', toAddr: 'dana@bigco.com' })
      expect(calls[0]?.body.draftId).toBe('d1')
    } finally { restore(); restoreEnv() }
  })

  test('already-sent returns the earlier receipt instead of sending twice', async () => {
    withEnv()
    const { restore } = stubFetch([
      { match: /mail\/send-draft/, body: { ok: true, state: 'already_sent', providerId: 'smtp_11', toAddr: 'dana@bigco.com' } },
    ])
    try {
      const { sendDraftById } = await import('./liveContext')
      const out = await sendDraftById('+15550001234', 'friend', 'd1')
      expect(out.ok).toBe(false) // ok=true only for a NEW send; the receipt still comes back
      expect(out.state).toBe('already_sent')
      expect(out.providerId).toBe('smtp_11')
    } finally { restore(); restoreEnv() }
  })

  test('outcome_unknown refuses to re-send', async () => {
    withEnv()
    const { restore } = stubFetch([
      { match: /mail\/send-draft/, status: 409, body: { ok: false, state: 'outcome_unknown', error: 'will not be repeated' } },
    ])
    try {
      const { sendDraftById } = await import('./liveContext')
      const out = await sendDraftById('+15550001234', 'friend', 'd1')
      expect(out.ok).toBe(false)
      expect(out.state).toBe('outcome_unknown')
    } finally { restore(); restoreEnv() }
  })

  test('a transport throw is outcome_unknown, never send_failed', async () => {
    withEnv()
    const real = globalThis.fetch
    globalThis.fetch = (async () => { throw new Error('aborted after commit') }) as typeof fetch
    try {
      const { sendDraftById } = await import('./liveContext')
      const out = await sendDraftById('+15550001234', 'friend', 'd1')
      expect(out.state).toBe('outcome_unknown')
    } finally { globalThis.fetch = real; restoreEnv() }
  })
})
