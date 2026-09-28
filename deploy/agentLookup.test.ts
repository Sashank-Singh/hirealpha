import { afterEach, describe, expect, it } from 'bun:test'
import { runToolsForMessage } from './hire-api'

const originalFetch = globalThis.fetch
afterEach(() => { globalThis.fetch = originalFetch })
const sql = (async () => [{ access_token: 'test-token', scopes: 'https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/calendar.readonly https://www.googleapis.com/auth/drive.readonly', expires_at: new Date(Date.now() + 3600000) }]) as never

describe('agent-directed lookups', () => {
  it('passes exact Gmail search terms to Google and returns replyable message IDs', async () => {
    const requests: URL[] = []
    globalThis.fetch = (async (input) => {
      const url = new URL(String(input))
      requests.push(url)
      if (url.pathname.endsWith('/messages')) return Response.json({ messages: [{ id: 'booking-123' }] })
      return Response.json({ snippet: 'Departure September 8, 3 PM PDT', payload: { headers: [{ name: 'From', value: 'airline@example.com' }, { name: 'Subject', value: 'Confirmation' }] } })
    }) as typeof fetch
    const query = 'from:airline@example.com subject:"flight confirmation" older_than:5d'
    const result = await runToolsForMessage(sql, { userId: 'test', persona: 'friend', connected: ['gmail'], want: 'gmail', message: query })
    expect(requests[0].searchParams.get('q')).toBe(query)
    expect(result.join('\n')).toContain('id=booking-123')
    expect(result.join('\n')).toContain('Departure September 8')
  })

  it('does not invoke other connectors when their names occur in a Gmail search', async () => {
    const urls: string[] = []
    globalThis.fetch = (async (input) => {
      urls.push(String(input))
      return Response.json({ messages: [] })
    }) as typeof fetch
    await runToolsForMessage(sql, { userId: 'test', persona: 'friend', connected: ['gmail', 'calendar', 'drive'], want: 'gmail', message: 'subject:"calendar google drive"' })
    expect(urls.every((url) => url.startsWith('https://gmail.googleapis.com/'))).toBe(true)
  })

  it('reads a selected email body when the answer is missing from its search snippet', async () => {
    const urls: URL[] = []
    globalThis.fetch = (async (input) => {
      urls.push(new URL(String(input)))
      return Response.json({ snippet: 'Booking details', payload: { mimeType: 'text/plain', body: { data: Buffer.from('Flight details. '.repeat(80) + 'The return flight departs at 7 PM.').toString('base64url') } } })
    }) as typeof fetch
    const result = await runToolsForMessage(sql, { userId: 'test', persona: 'friend', connected: ['gmail'], want: 'gmail', message: 'id=booking-123' })
    expect(urls[0].pathname).toEndWith('/messages/booking-123')
    expect(urls[0].searchParams.get('format')).toBe('full')
    expect(result[0]).toContain('return flight departs at 7 PM')
    // The by-id read now names the source and lists attachments when they exist;
    // the old "attachments not included" cop-out is gone.
    expect(result[0]).toContain('Email body id=booking-123')
    expect(result[0]).not.toContain('attachments not included')
  })

  it('checks the requested calendar window, not the default next seven days', async () => {
    const urls: URL[] = []
    globalThis.fetch = (async (input) => { urls.push(new URL(String(input))); return Response.json({ items: [] }) }) as typeof fetch
    const result = await runToolsForMessage(sql, { userId: 'test', persona: 'friend', connected: ['calendar'], want: 'calendar', message: 'start=2026-10-10T14:00:00-07:00 end=2026-10-10T17:00:00-07:00', timezone: 'America/Los_Angeles' })
    expect(urls).toHaveLength(1)
    expect(urls[0].searchParams.get('timeMin')).toBe('2026-10-10T21:00:00.000Z')
    expect(urls[0].searchParams.get('timeMax')).toBe('2026-10-11T00:00:00.000Z')
    expect(result[0]).toContain('2026-10-10T14:00:00-07:00')
    expect(result[0]).not.toContain('next 7 days')
  })

  it('rejects invalid or ambiguous calendar ranges without looking at unrelated dates', async () => {
    let calls = 0
    globalThis.fetch = (async () => { calls++; return Response.json({ items: [] }) }) as typeof fetch
    for (const message of ['next Friday', 'start=2026-09-08T14:00 end=2026-09-08T17:00', 'start=2026-09-08T17:00:00Z end=2026-09-08T14:00:00Z', 'start=2026-09-08T17:00:00Z end=2027-09-08T14:00:00Z']) {
      const result = await runToolsForMessage(sql, { userId: 'test', persona: 'friend', connected: ['calendar'], want: 'calendar', message })
      expect(result[0]).toContain('No calendar lookup ran')
    }
    expect(calls).toBe(0)
  })
})

describe('a zero-match Gmail search is not backfilled with unrelated mail', () => {
  const gmailSql = (async () => [{ access_token: 'test-token', scopes: 'https://www.googleapis.com/auth/gmail.readonly', expires_at: new Date(Date.now() + 3600000) }]) as never

  it('relaxes "from:sam Thursday" to the sender and labels the rows', async () => {
    const queries: string[] = []
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = new URL(String(input))
      const q = url.searchParams.get('q') || ''
      queries.push(q)
      if (url.pathname.endsWith('/messages')) {
        return Response.json(q === 'from:sam' ? { messages: [{ id: 'sam-1' }] } : { messages: [] })
      }
      return Response.json({
        snippet: 'Can we do Thursday at 2?',
        payload: { headers: [{ name: 'From', value: 'Sam Rivera <sam@acme.co>' }, { name: 'Subject', value: 'Thursday sync' }] },
      })
    }) as typeof fetch
    const result = await runToolsForMessage(gmailSql, {
      userId: 'test',
      persona: 'friend',
      connected: ['gmail'],
      want: 'gmail',
      message: 'from:sam Thursday',
    })
    const text = result.join('\n')
    expect(queries).toContain('from:sam Thursday')
    expect(queries).toContain('from:sam')
    expect(text).toContain('No email matched "from:sam Thursday"')
    expect(text).toContain('id=sam-1')
    expect(text).toContain('Sam Rivera')
  })

  it('says plainly when nothing matches and there is no operator to relax to', async () => {
    globalThis.fetch = (async () => Response.json({ messages: [] })) as typeof fetch
    const result = await runToolsForMessage(gmailSql, {
      userId: 'test',
      persona: 'friend',
      connected: ['gmail'],
      want: 'gmail',
      message: 'from:no-such-person@example.com',
    })
    const text = result.join('\n')
    expect(text).toContain('No email matched')
    expect(text).toContain('real zero-match result')
    expect(text).not.toContain('newer_than:7d')
  })

  it('a failed read stays a failed read: it never backfills with unverified mail', async () => {
    // The current contract (hub.ts: "read refused" stays distinct from a real
    // zero-match): a refused read returns the failure line and PRESERVES the
    // question. Filling the gap with recent mail after a refusal presented
    // unverified rows as the answer, so the fill only ever runs after a real
    // zero-match read, never after a failed one.
    let listCalls = 0
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = new URL(String(input))
      if (url.pathname.endsWith('/messages')) {
        listCalls++
        if ((url.searchParams.get('q') || '').includes('from:sam')) return new Response('boom', { status: 500 })
        return Response.json({ messages: [{ id: 'recent-1' }] })
      }
      return Response.json({ snippet: 'recent', payload: { headers: [{ name: 'From', value: 'news@example.com' }, { name: 'Subject', value: 'Weekly' }] } })
    }) as typeof fetch
    const result = await runToolsForMessage(gmailSql, {
      userId: 'test',
      persona: 'friend',
      connected: ['gmail'],
      want: 'gmail',
      message: 'from:sam Thursday',
    })
    const text = result.join('\n')
    expect(listCalls).toBe(1)
    expect(text).toContain('Gmail read failed')
    expect(text).toContain('Preserve the original question')
    expect(text).not.toContain('id=recent-1')
  })
})
