import { afterAll, afterEach, beforeAll, describe, expect, it } from 'bun:test'
import { startReminderScheduler } from './reminders'

/* A failed reminder send reverted the claim without backing off, and the 10s
 * poll re-sent the same reminder every cycle all night (the observed
 * RateLimitError / revert / retry loop). The scheduler must attempt a failing
 * reminder once, then leave it alone for the backoff window. */

const savedFetch = globalThis.fetch
const savedUrl = process.env.HIREALPHA_API_URL
const savedKey = process.env.HIREALPHA_INTERNAL_KEY

let claims = 0
let reverts = 0
let sends = 0
let stop = false

beforeAll(() => {
  process.env.HIREALPHA_API_URL = 'http://reminders-backoff.test'
  process.env.HIREALPHA_INTERNAL_KEY = 'k'
})

afterAll(() => {
  if (savedUrl) process.env.HIREALPHA_API_URL = savedUrl
  else delete process.env.HIREALPHA_API_URL
  if (savedKey) process.env.HIREALPHA_INTERNAL_KEY = savedKey
  else delete process.env.HIREALPHA_INTERNAL_KEY
  globalThis.fetch = savedFetch
})

afterEach(() => {
  globalThis.fetch = savedFetch
})

describe('a failing reminder send does not hammer the send budget', () => {
  it('attempts once, reverts once, then backs off', async () => {
    const now = new Date().toISOString()
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      const _method = init?.method || 'GET'
      if (url.includes('/api/internal/event-nudges')) {
        return new Response(JSON.stringify({ nudges: [] }), { status: 200 })
      }
      if (url.includes('/kill-switch/check')) {
        return new Response(JSON.stringify({ armed: false }), { status: 200 })
      }
      if (url.includes('/api/internal/reminders/due')) {
        if (stop) return new Response(JSON.stringify({ reminders: [] }), { status: 200 })
        return new Response(
          JSON.stringify({
            reminders: [
              { id: 'r1', userId: 'u1', phone: '+15551230000', text: 'stand up', scheduledAt: now, recurrence: 'once', timezone: 'America/Los_Angeles' },
            ],
          }),
          { status: 200 },
        )
      }
      if (url.includes('/api/internal/reminders/r1/done')) {
        const body = String(init?.body || '')
        if (/"revert"\s*:\s*true/.test(body)) reverts++
        else claims++
        return new Response(JSON.stringify({ ok: true, claimed: true }), { status: 200 })
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 })
    }) as typeof fetch

    startReminderScheduler({
      persona: 'friend',
      pollMs: 25,
      send: async () => {
        sends++
        throw new Error('RateLimitError: recipient cooling period limits sends to 3/day')
      },
    })

    await new Promise((r) => setTimeout(r, 300))
    stop = true
    await new Promise((r) => setTimeout(r, 60))

    // Pre-fix: a revert without backoff meant a claim+send every 25ms cycle
    // (~12 attempts in this window). Post-fix: one claim, one attempt, one
    // revert, then a ten-minute backoff — the due row is left alone.
    expect(sends).toBe(1)
    expect(claims).toBe(1)
    expect(reverts).toBe(1)
  })
})
