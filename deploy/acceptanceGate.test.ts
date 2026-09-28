import { describe, expect, it } from 'bun:test'
import type { SQL } from 'bun'
import { handleMailRoutes } from './routes/mail'
import { handleWorkRoutes } from './routes/work'
import { handleSweep } from '../spectrum/shared/smartFeatures'
import { buildFlightCheckinTexts } from '../spectrum/shared/taskLoops'
import { describeMutualAvailability } from './calendarConflicts'

process.env.HIREALPHA_INTERNAL_KEY = 'test-key'

/**
 * Release-gate acceptance scenarios (experience-gap pass, 2026-09-27).
 * Each scenario pins the exact contract the audit demanded: what was checked,
 * what was completed, and the line the user sees when something is NOT done.
 * Network is mocked at the provider boundary; the route handlers, state
 * machines, and copy under test are the real ones.
 */

type Row = Record<string, unknown>

const USER_ROW: Row = { id: 'u1', email: 'me@x.com', timezone: 'America/Los_Angeles', phone: '+15550001234' }
const TOKEN_ROW: Row = { access_token: 'test-token', scopes: 'https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/gmail.modify https://www.googleapis.com/auth/calendar.events https://www.googleapis.com/auth/drive.readonly', expires_at: new Date(Date.now() + 3600_000) }

function fakeSql(routes: Array<{ match: RegExp; rows?: Row[] }>): SQL {
  const fn = ((strings: TemplateStringsArray | string) => {
    const q = typeof strings === 'string' ? strings : strings.join('?')
    const hit = routes.find((r) => r.match.test(q))
    return Promise.resolve(hit?.rows ? [...hit.rows] : [])
  }) as unknown as SQL
  return fn
}

const req = (path: string, body?: unknown, method = 'POST'): Request =>
  new Request(`https://x.test${path}`, {
    method,
    headers: { 'content-type': 'application/json', authorization: 'Bearer test-key' },
    ...(body ? { body: JSON.stringify(body) } : {}),
  })

const workOptions = {
  internalOk: () => true,
  connectedForUser: async () => ['gmail', 'calendar', 'drive'],
}

function mockFetch(routes: Array<{ match: RegExp; reply: (url: URL, init?: RequestInit) => Response }>): void {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input))
    const hit = routes.find((r) => r.match.test(`${url.host}${url.pathname}`))
    if (hit) return hit.reply(url, init)
    return new Response('unmocked', { status: 599 })
  }) as typeof fetch
}

describe('acceptance 1 — "handle my inbox" names what is done vs. waiting', () => {
  it('the sweep says sending needs a tap and offers filing', async () => {
    const text = handleSweep(2, ['1. Greg · contract · draft ready', '2. Maya · invoice · draft ready'])
    expect(text).toContain('Sending happens on your tap')
    expect(text).toContain('archive the rest')
  })

  it('archive applies to real message ids and reports the count', async () => {
    mockFetch([
      { match: /gmail\.googleapis\.com\/gmail\/v1\/users\/me\/messages\/[^/]+\/modify$/, reply: () => Response.json({ id: 'ok' }) },
    ])
    const sql = fakeSql([
      { match: /FROM hire_users/i, rows: [USER_ROW] },
      { match: /hire_google_tokens/i, rows: [TOKEN_ROW] },
      { match: /hire_thread_state/ },
    ])
    const res = await handleMailRoutes(req('/api/internal/mail/actions', { phone: '+15550001234', persona: 'friend', ids: ['a1', 'a2'], action: 'archive' }), sql, { internalOk: () => true })
    const data = await res!.json() as { ok: boolean; results: Array<{ id: string; ok: boolean }> }
    expect(data.ok).toBe(true)
    expect(data.results.map((r) => r.id)).toEqual(['a1', 'a2'])
    expect(data.results.every((r) => r.ok)).toBe(true)
  })
})

describe('acceptance 2 — reply → send → watch the exact thread', () => {
  it('the delegate send carries the thread id so watching binds to it', async () => {
    let sentBody: Record<string, unknown> = {}
    mockFetch([
      { match: /hirealpha\.x\/api\/internal\/mail\/send$/, reply: (_url, init) => { sentBody = JSON.parse(String(init?.body || '{}')); return Response.json({ ok: true, providerId: 'p1' }) } },
    ])
    process.env.HIREALPHA_API_URL = 'https://hirealpha.x'
    const { sendMailDirect } = await import('../spectrum/shared/liveContext')
    const out = await sendMailDirect('+15550001234', 'sam@acme.co', 'Re: deck', 'Tuesday works.', 'THREAD-9')
    expect(out.ok).toBe(true)
    expect(sentBody.threadId).toBe('THREAD-9')
    expect((sentBody as { to?: string }).to).toBe('sam@acme.co')
  })
})

describe('acceptance 3 — "when can Sarah and I meet?" is honest about scope', () => {
  it('an unreadable guest calendar comes back unknown, never as mutual free time', async () => {
    mockFetch([
      {
        match: /www\.googleapis\.com\/calendar\/v3\/freeBusy$/,
        reply: (_url, init) => {
          const body = String(init?.body || '')
          if (body.includes('sarah@x.com')) return Response.json({ calendars: { 'sarah@x.com': { errors: [{ reason: 'notFound' }] } } })
          return Response.json({ calendars: { primary: { busy: [] } } })
        },
      },
      { match: /www\.googleapis\.com\/calendar\/v3\/calendars\/primary\/events/, reply: () => Response.json({ items: [] }) },
    ])
    const sql = fakeSql([
      { match: /FROM hire_users/i, rows: [USER_ROW] },
      { match: /hire_google_tokens/i, rows: [TOKEN_ROW] },
    ])
    const res = await handleWorkRoutes(req('/api/internal/work/slots', { phone: '+15550001234', persona: 'friend', durationMin: 30, guests: ['sarah@x.com'] }), sql, workOptions)
    const data = await res!.json() as { slots: unknown[]; guests: { unknown: string[] }; text?: string }
    expect(data.guests.unknown).toEqual(['sarah@x.com'])
    expect(data.text).toContain("I can see your calendar, not sarah@x.com's")
    expect(data.text).not.toMatch(/both free|mutually free/i)
  })
})

describe('acceptance 4 — "what am I waiting on?" reads durable state', () => {
  it('returns threads where the other side owes the reply', async () => {
    const sql = fakeSql([
      { match: /FROM hire_users/i, rows: [USER_ROW] },
      {
        match: /FROM hire_thread_state/i,
        rows: [{ threadId: 't1', participant: 'Greg <greg@x.com>', subject: 'Contract', direction: 'outbound', awaiting: 'them', lastMessageId: 'm1', lastActivityAt: new Date() }],
      },
    ])
    const res = await handleMailRoutes(req('/api/internal/mail/state?phone=%2B15550001234&persona=friend&kind=waiting_on_them', undefined, 'GET'), sql, { internalOk: () => true })
    const data = await res!.json() as { rows: Array<{ threadId: string; awaiting: string }> }
    expect(data.rows).toHaveLength(1)
    expect(data.rows[0]!.threadId).toBe('t1')
    expect(data.rows[0]!.awaiting).toBe('them')
  })
})

describe('acceptance 5 — "what am I forgetting?" only surfaces actionable items', () => {
  it('conflict text names events, never vague worry', async () => {
    mockFetch([
      { match: /www\.googleapis\.com\/calendar\/v3\/calendars\/primary\/events/, reply: () => Response.json({ items: [] }) },
    ])
    const sql = fakeSql([
      { match: /FROM hire_users/i, rows: [USER_ROW] },
      { match: /hire_google_tokens/i, rows: [TOKEN_ROW] },
    ])
    const res = await handleWorkRoutes(req('/api/internal/calendar/conflicts', { phone: '+15550001234', day: '2026-10-01' }), sql, workOptions)
    const data = await res!.json() as { ok: boolean; text: string }
    expect(data.ok).toBe(true)
    expect(data.text).toContain('No conflicts')
  })
})

describe('acceptance 6 — "send her the deck" attaches, sends, verifies', () => {
  it('file send ends with a provider receipt, not a claim', async () => {
    mockFetch([
      { match: /drive\/v3\/files\/FILE-1\/permissions/, reply: () => Response.json({ id: 'perm' }) },
      { match: /drive\/v3\/files\/FILE-1.*alt=media/, reply: () => new Response(new Uint8Array([1, 2, 3, 4])) },
      { match: /drive\/v3\/files\/FILE-1/, reply: () => Response.json({ id: 'FILE-1', name: 'deck.pdf', mimeType: 'application/pdf', size: '1200', webViewLink: 'https://drive.google.com/x' }) },
      { match: /drive\/v3\/files\/FILE-1\/export/, reply: () => new Response(new Uint8Array([1, 2, 3, 4])) },
      { match: /gmail\.googleapis\.com\/gmail\/v1\/users\/me\/messages\/send$/, reply: () => Response.json({ id: 'MSG-SENT-1' }) },
    ])
    const sql = fakeSql([
      { match: /FROM hire_users/i, rows: [USER_ROW] },
      { match: /hire_google_tokens/i, rows: [TOKEN_ROW] },
      // The idempotency pre-check must come back empty so the send path runs;
      // the post-send receipt read returns the claimed-and-sent row.
      { match: /hire_file_sends.*operation_key/i, rows: [] },
      { match: /hire_file_sends/, rows: [{ id: 'fs1', recipient: 'sarah@x.com', fileId: 'FILE-1', sourceThreadId: null, draftVersion: 1, mode: 'attachment', status: 'sent', providerId: 'MSG-SENT-1', error: null }] },
    ])
    const res = await handleWorkRoutes(req('/api/internal/files/send', { phone: '+15550001234', persona: 'friend', recipient: 'sarah@x.com', fileId: 'FILE-1', mode: 'attachment', subject: 'The deck', text: 'Here you go.' }), sql, workOptions)
    const data = await res!.json() as { ok: boolean; providerId?: string; receipt?: { status: string } }
    expect(data.ok).toBe(true)
    expect(data.providerId).toBe('MSG-SENT-1')
    expect(data.receipt?.status).toBe('sent')
  })
})

describe('acceptance 7 — "did my flight change?" does not bluff', () => {
  it('the check-in text names the limit instead of implying execution', () => {
    const out = buildFlightCheckinTexts({ airline: 'United', date: '2026-08-20T18:00:00Z', confirmation_url: 'https://united.example/checkin' }, new Date('2026-08-20T19:00:00Z'))
    expect(out.checkin).toContain("I can't complete airline check-in")
    expect(out.checkin).toContain('https://united.example/checkin')
  })
})

describe('acceptance 8 — forward carries attachments and the original identity', () => {
  it('forward builds a real Fwd message, attaches the file, confirms the receipt', async () => {
    const msgData = 'aGVsbG8gZnJvbSB0aGUgb3JpZ2luYWw=' // "hello from the original"
    const attData = Buffer.from('attachment-bytes').toString('base64')
    let sentRaw = ''
    mockFetch([
      {
        match: /gmail\.googleapis\.com\/gmail\/v1\/users\/me\/messages\/MSG-9$/,
        reply: () => Response.json({
          id: 'MSG-9', threadId: 'T-9',
          snippet: 'the original',
          payload: {
            headers: [
              { name: 'Subject', value: 'The deck' },
              { name: 'From', value: 'Sam <sam@acme.co>' },
              { name: 'Date', value: 'Sat, 26 Sep 2026 10:00:00 +0000' },
              { name: 'To', value: 'me@x.com' },
            ],
            mimeType: 'text/plain',
            body: { data: msgData },
            parts: [{ mimeType: 'application/pdf', filename: 'deck.pdf', body: { attachmentId: 'ATT-1', size: 16 } }],
          },
        }),
      },
      { match: /messages\/MSG-9\/attachments\/ATT-1$/, reply: () => Response.json({ data: attData, size: attData.length }) },
      { match: /gmail\.googleapis\.com\/gmail\/v1\/users\/me\/messages\/send$/, reply: (_url, init) => { sentRaw = JSON.parse(String(init?.body || '{}')).raw; return Response.json({ id: 'FWD-1' }) } },
    ])
    const sql = fakeSql([
      { match: /FROM hire_users/i, rows: [USER_ROW] },
      { match: /hire_google_tokens/i, rows: [TOKEN_ROW] },
      { match: /hire_thread_state/ },
    ])
    const res = await handleMailRoutes(req('/api/internal/mail/forward', { phone: '+15550001234', persona: 'friend', messageId: 'MSG-9', to: 'acct@x.com', comment: 'For the ledger.' }), sql, { internalOk: () => true })
    const data = await res!.json() as { ok: boolean; providerId?: string; attachedCount?: number; subject?: string; error?: string }
    expect(data.ok).toBe(true)
    expect(data.providerId).toBe('FWD-1')
    expect(data.attachedCount).toBe(1)
    expect(data.subject).toBe('Fwd: The deck')
    // The forwarded MIME names the attachment and the raw decodes.
    const decoded = Buffer.from(sentRaw.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf-8')
    expect(decoded).toContain('Fwd: The deck')
    expect(decoded).toContain('filename="deck.pdf"')
    expect(decoded).toContain('hello from the original')
    expect(decoded).toContain('For the ledger.')
  })
})

describe('acceptance 9 — attachment read extracts text and names its source', () => {
  it('reads a text attachment bound to the thread', async () => {
    const body = 'Offer letter: start date March 1.'
    const attData = Buffer.from(body).toString('base64')
    mockFetch([
      {
        match: /gmail\.googleapis\.com\/gmail\/v1\/users\/me\/messages\/MSG-8$/,
        reply: () => Response.json({
          id: 'MSG-8', threadId: 'T-8',
          snippet: 'the offer',
          payload: {
            headers: [
              { name: 'Subject', value: 'Your offer' },
              { name: 'From', value: 'HR <hr@x.com>' },
              { name: 'Date', value: 'Sat, 26 Sep 2026 10:00:00 +0000' },
              { name: 'To', value: 'me@x.com' },
            ],
            mimeType: 'multipart/mixed',
            parts: [{ mimeType: 'text/plain', filename: 'offer.txt', body: { attachmentId: 'ATT-8', size: body.length } }],
          },
        }),
      },
      { match: /messages\/MSG-8\/attachments\/ATT-8$/, reply: () => Response.json({ data: attData, size: attData.length }) },
    ])
    const sql = fakeSql([
      { match: /FROM hire_users/i, rows: [USER_ROW] },
      { match: /hire_google_tokens/i, rows: [TOKEN_ROW] },
    ])
    const res = await handleMailRoutes(req('/api/internal/mail/attachment', { phone: '+15550001234', messageId: 'MSG-8', attachmentId: 'ATT-8' }), sql, { internalOk: () => true })
    const data = await res!.json() as { ok: boolean; status?: string; text?: string; source?: { subject: string; threadId: string } }
    expect(data.ok).toBe(true)
    expect(data.status).toBe('extracted')
    expect(typeof data.text).toBe('string')
    expect(String(data.text)).toContain('start date March 1')
    expect(data.source?.subject).toBe('Your offer')
    expect(data.source?.threadId).toBe('T-8')
  })
})

describe('bonus gate — mutual-availability phrase is the audit line, verbatim shape', () => {
  it('unknown guest produces the honest fallback with a next step', () => {
    const text = describeMutualAvailability({ slots: [], readableGuests: [], unknownGuests: ['sarah@x.com'], askedGuests: true })
    expect(text).toContain("I can see your calendar, not sarah@x.com's")
  })
})
