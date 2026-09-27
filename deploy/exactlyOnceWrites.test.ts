import { afterEach, beforeEach, expect, it } from 'bun:test'
import { mintSessionToken } from './auth/session'
import { handleProposalRoutes } from './routes/proposals'
import { handleWorkRoutes } from './routes/work'

const savedFetch = globalThis.fetch
const savedSecret = process.env.HIREALPHA_SESSION_SECRET
const sessionSecret = 'exactly-once-fixture-secret'
const user = { id: 'u1', email: 'owner@example.com', name: 'Owner', timezone: 'America/Los_Angeles', phone: '+15555550123' }

beforeEach(() => { process.env.HIREALPHA_SESSION_SECRET = sessionSecret })
afterEach(() => {
  globalThis.fetch = savedFetch
  if (savedSecret === undefined) delete process.env.HIREALPHA_SESSION_SECRET
  else process.env.HIREALPHA_SESSION_SECRET = savedSecret
})

function request(path: string, body: Record<string, unknown>) {
  return new Request(`https://test.invalid${path}`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ session: mintSessionToken(user.email), ...body }),
  })
}

it('UX05 deduplicates only the exact draft identity', async () => {
  const inserted: unknown[][] = []
  const existing = { id: 'old', kind: 'email' }
  const sql = (async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const query = strings.join('?')
    if (query.includes('SELECT id, kind, version FROM hire_drafts')) {
      return values.includes('exact') ? [{ ...existing, version: 1 }] : []
    }
    if (query.includes('INSERT INTO hire_drafts')) inserted.push(values)
    return []
  }) as any
  const options = {
    internalOk: () => true,
    livePayload: async () => ({ found: true, hired: true, userId: user.id, timezone: user.timezone }),
    gmailReplyMeta: async () => null,
  }
  const exact = await handleProposalRoutes(request('/api/internal/propose', {
    phone: user.phone, persona: 'friend', kind: 'email', to: 'sam@example.com', subject: 'Tuesday', body: 'Tuesday works', idempotencyKey: 'exact',
  }), sql, options)
  expect(await exact!.json()).toMatchObject({ id: 'old', deduplicated: true })

  const changedBody = await handleProposalRoutes(request('/api/internal/propose', {
    phone: user.phone, persona: 'friend', kind: 'email', to: 'sam@example.com', subject: 'Tuesday', body: 'Tuesday works for me!', idempotencyKey: 'body',
  }), sql, options)
  const changedRecipient = await handleProposalRoutes(request('/api/internal/propose', {
    phone: user.phone, persona: 'friend', kind: 'email', to: 'maya@example.com', subject: 'Tuesday', body: 'Tuesday works', idempotencyKey: 'recipient',
  }), sql, options)
  expect((await changedBody!.json()).id).not.toBe('old')
  expect((await changedRecipient!.json()).id).not.toBe('old')
  expect(inserted).toHaveLength(2)
})

function workFixture(kind: 'email' | 'event') {
  let state = 'pending'
  let providerId = ''
  let providerCalls = 0
  let release: (() => void) | undefined
  const gate = new Promise<void>((resolve) => { release = resolve })
  const sql = (async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const query = strings.join('?')
    if (query.includes('FROM hire_users WHERE email')) return [user]
    if (query.includes('FROM hire_google_tokens')) return [{ access_token: 'fixture', expires_at: new Date(Date.now() + 3_600_000), scopes: 'gmail.send calendar.events' }]
    if (query.includes("SET status = 'sending'") || query.includes("SET status = 'booking'")) {
      if (state !== 'pending') return []
      state = kind === 'email' ? 'sending' : 'booking'
      return [{ to_addr: 'sam@example.com', subject: 'Tuesday', body: 'Tuesday works', thread_id: '', in_reply_to: '', start_at: '2026-09-28T16:00:00Z', end_at: '2026-09-28T16:30:00Z', version: 1 }]
    }
    if (query.includes('SELECT status, provider_id')) {
      return [{ status: state, provider_id: providerId }]
    }
    if (query.includes('UPDATE hire_drafts SET status')) {
      state = values.find((value) => ['sent', 'booked', 'outcome_unknown', 'pending'].includes(String(value))) as string || state
      providerId = String(values.find((value) => String(value).startsWith(kind === 'email' ? 'msg-' : 'event-')) || providerId)
    }
    return []
  }) as any
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input)
    if (url.includes('gmail.googleapis.com') || url.includes('/calendars/primary/events')) {
      providerCalls++
      await gate
      return Response.json({ id: kind === 'email' ? 'msg-1' : 'event-1' })
    }
    throw new Error(`unexpected ${url}`)
  }) as typeof fetch
  return { sql, release: () => release?.(), calls: () => providerCalls, state: () => state, providerId: () => providerId }
}

it('UX07 two concurrent sends make one provider call and persist its receipt', async () => {
  const fixture = workFixture('email')
  const options = { internalOk: () => true, connectedForUser: async () => ['gmail'] }
  const first = handleWorkRoutes(request('/api/work/send', { id: 'draft-1' }), fixture.sql, options)
  const second = handleWorkRoutes(request('/api/work/send', { id: 'draft-1' }), fixture.sql, options)
  await new Promise((resolve) => setTimeout(resolve, 5))
  fixture.release()
  const responses = await Promise.all([first, second])
  expect(fixture.calls()).toBe(1)
  expect(fixture.state()).toBe('sent')
  expect(fixture.providerId()).toBe('msg-1')
  expect(await responses[0]!.json()).toMatchObject({ ok: true, providerId: 'msg-1' })
  expect(await responses[1]!.json()).toMatchObject({ ok: false, state: 'sending' })
})

it('UX08 stale and concurrent Book requests create one event', async () => {
  const fixture = workFixture('event')
  const options = { internalOk: () => true, connectedForUser: async () => ['calendar'] }
  const first = handleWorkRoutes(request('/api/work/hold', { id: 'draft-1' }), fixture.sql, options)
  const second = handleWorkRoutes(request('/api/work/hold', { id: 'draft-1' }), fixture.sql, options)
  await new Promise((resolve) => setTimeout(resolve, 5))
  fixture.release()
  const responses = await Promise.all([first, second])
  expect(fixture.calls()).toBe(1)
  expect(fixture.state()).toBe('booked')
  expect(fixture.providerId()).toBe('event-1')
  expect(await responses[0]!.json()).toMatchObject({ ok: true, eventId: 'event-1' })
  expect(await responses[1]!.json()).toMatchObject({ ok: false, state: 'booking' })
})
