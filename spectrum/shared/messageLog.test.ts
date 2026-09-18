import { afterEach, describe, expect, it } from 'bun:test'
import { logConversationTurn } from './runHireTurn'

const realFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = realFetch
  delete process.env.HIREALPHA_API_URL
  delete process.env.HIREALPHA_INTERNAL_KEY
})

describe('conversation corpus', () => {
  /* The material for improving the model: the user's words and Alpha's reply,
   * one row each, in Postgres. Fire and forget, so this pins the request the
   * turn path makes rather than waiting on the turn to finish. */
  it('sends the user text and the reply as separate rows', async () => {
    process.env.HIREALPHA_API_URL = 'https://example.test'
    process.env.HIREALPHA_INTERNAL_KEY = 'k'
    let seen: { url: string; body: Record<string, unknown> } | null = null
    globalThis.fetch = (async (url: string, init: RequestInit) => {
      seen = { url: String(url), body: JSON.parse(String(init.body)) as Record<string, unknown> }
      return new Response('{"ok":true}', { status: 200 })
    }) as unknown as typeof fetch

    await logConversationTurn({
      phone: '+15551234567',
      persona: 'friend',
      userText: 'Find hotel in nye near the airport under 150',
      reply: 'Straight verdict: near JFK on NYE, $150 is not happening.',
      source: 'gmi',
      startedAt: Date.now() - 12_000,
    })

    expect(seen!.url).toBe('https://example.test/api/internal/message-log')
    const rows = seen!.body.rows as Array<{ role: string; text: string; source?: string }>
    expect(rows).toHaveLength(2)
    expect(rows[0]).toMatchObject({ role: 'user', text: 'Find hotel in nye near the airport under 150' })
    expect(rows[1]).toMatchObject({ role: 'alpha', source: 'gmi' })
    expect(seen!.body.phone).toBe('+15551234567')
    expect(Number(seen!.body.replyMs)).toBeGreaterThanOrEqual(12_000)
  })

  it('stays silent when the bot has no API configured, and drops empty sides', async () => {
    delete process.env.HIREALPHA_API_URL
    let called = false
    globalThis.fetch = (async () => { called = true; return new Response('{}') }) as unknown as typeof fetch
    await logConversationTurn({ phone: '+1', persona: 'friend', userText: 'hi', reply: '', source: 'gmi', startedAt: Date.now() })
    expect(called).toBe(false)
  })
})
