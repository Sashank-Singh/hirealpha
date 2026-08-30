import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import {
  assembleAutoStandup,
  assembleStandupText,
  buildPrepBrief,
  handleHireApi,
  nextSharedMeeting,
  parseLinearIssues,
  scoreLinearIssues,
  suggestSlotsFromBusy,
  type PrepCandidate,
} from './hire-api'

/* The coworker sells a day that runs itself: prep shows up before the meeting,
 * the standup writes itself from rows, slots come from the real calendar, and
 * Linear triage sorts without being asked. These tests pin the deterministic
 * parts: what text assembles, which gaps survive busy blocks, how issues
 * score, and that internal routes stay keyed. */

type Captured = { text: string; values: unknown[] }

function fakeSql(rowsFor: (text: string) => unknown[] = () => []) {
  const queries: Captured[] = []
  const sql = ((strings: TemplateStringsArray, ...values: unknown[]) => {
    queries.push({ text: strings.join('?'), values })
    return Promise.resolve(rowsFor(strings.join('?')))
  }) as unknown as Parameters<typeof assembleAutoStandup>[0]
  return { sql, queries }
}

const savedKey = process.env.HIREALPHA_INTERNAL_KEY
const savedComposio = process.env.COMPOSIO_API_KEY

beforeEach(() => {
  process.env.HIREALPHA_INTERNAL_KEY = 'test-key'
  // Keep the connector paths offline: empty key makes composioClient null.
  process.env.COMPOSIO_API_KEY = ''
})

afterEach(() => {
  if (savedKey === undefined) delete process.env.HIREALPHA_INTERNAL_KEY
  else process.env.HIREALPHA_INTERNAL_KEY = savedKey
  if (savedComposio === undefined) delete process.env.COMPOSIO_API_KEY
  else process.env.COMPOSIO_API_KEY = savedComposio
})

function candidate(partial: {
  id: string
  title: string
  start: Date
  attendees?: string[] | null
}): PrepCandidate {
  return { attendees: null, ...partial }
}

describe('nextSharedMeeting', () => {
  it('skips events nobody else is on and picks the soonest shared one', () => {
    const now = Date.parse('2026-08-31T15:00:00Z')
    const events = [
      candidate({ id: 'a', title: 'Focus block', start: new Date('2026-08-31T16:00:00Z'), attendees: [] }),
      candidate({ id: 'b', title: 'Roadmap sync', start: new Date('2026-08-31T17:00:00Z'), attendees: ['priya@acme.co'] }),
    ]
    const pick = nextSharedMeeting(events, now)
    expect(pick?.id).toBe('b')
  })

  it('keeps an event whose attendee list is unknown', () => {
    const now = Date.parse('2026-08-31T15:00:00Z')
    const events = [candidate({ id: 'a', title: 'Sync', start: new Date('2026-08-31T16:00:00Z') })]
    expect(nextSharedMeeting(events, now)?.id).toBe('a')
  })

  it('ignores past events and returns null on an empty day', () => {
    const now = Date.parse('2026-08-31T15:00:00Z')
    const events = [candidate({ id: 'a', title: 'Old', start: new Date('2026-08-31T09:00:00Z'), attendees: ['x@y.co'] })]
    expect(nextSharedMeeting(events, now)).toBe(null)
  })
})

describe('buildPrepBrief', () => {
  it('builds the skeleton with attendee name and minutes to start', () => {
    const start = new Date('2026-08-31T16:00:00Z')
    const brief = buildPrepBrief(
      candidate({ id: 'e1', title: 'Roadmap sync', start, attendees: ['priya.shah@acme.co'] }),
      null,
      Date.parse('2026-08-31T15:30:00Z'),
    )
    expect(brief.event).toEqual({ id: 'e1', title: 'Roadmap sync', startsInMin: 30, attendees: ['priya.shah@acme.co'] })
    expect(brief.prep.agenda.join(' ')).toContain('Priya Shah')
    expect(brief.prep.agenda.join(' ')).toContain('Roadmap sync')
    expect(brief.prep.notes.join(' ')).toContain('30 min')
    expect(brief.prep.lastThread).toBeUndefined()
  })

  it('attaches the last thread when one exists', () => {
    const brief = buildPrepBrief(
      candidate({ id: 'e1', title: 'Sync', start: new Date('2026-08-31T16:00:00Z'), attendees: ['a@b.co'] }),
      { subject: 'Pricing', snippet: 'Can we talk today', gmailId: 'm1' },
      Date.parse('2026-08-31T15:30:00Z'),
    )
    expect(brief.prep.lastThread).toEqual({ subject: 'Pricing', snippet: 'Can we talk today', gmailId: 'm1' })
  })
})

describe('assembleStandupText', () => {
  it('fills the three sections from the day facts', () => {
    const text = assembleStandupText({
      day: '2026-08-29',
      meetings: ['Roadmap sync', 'Candidate call'],
      closedPromises: ['Send the deck'],
      draftsSent: ['Intro to Acme'],
      decisions: ['Pause agency spend'],
      blocked: ['Invoice Acme'],
    })
    expect(text).toContain('Standup 2026-08-29')
    expect(text).toContain('Yesterday:')
    expect(text).toContain('- Closed: Send the deck')
    expect(text).toContain('- Sent: Intro to Acme')
    expect(text).toContain('Today:')
    expect(text).toContain('- Meeting: Roadmap sync')
    expect(text).toContain('- Decision: Pause agency spend')
    expect(text).toContain('Blocked:')
    expect(text).toContain('- Invoice Acme')
    expect(text).not.toContain('Quiet day')
  })

  it('says when nothing was logged instead of printing bare headers', () => {
    const text = assembleStandupText({
      day: '2026-08-29',
      meetings: [],
      closedPromises: [],
      draftsSent: [],
      decisions: [],
      blocked: [],
    })
    expect(text).toBe('Standup 2026-08-29\nQuiet day. Nothing logged.')
  })
})

describe('assembleAutoStandup', () => {
  it('assembles from rows and upserts the day', async () => {
    const { sql, queries } = fakeSql((text) => {
      if (/status = 'done'/.test(text)) return [{ title: 'Send the deck' }]
      if (/status = 'sent'/.test(text)) return [{ subject: 'Intro to Acme' }]
      if (/hire_decisions/.test(text)) return [{ decision: 'Pause agency spend' }]
      if (/status = 'open'/.test(text)) return [{ title: 'Invoice Acme' }]
      return []
    })
    const out = await assembleAutoStandup(sql, { id: 'u1', timezone: null })
    expect(out.day).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    expect(out.text).toContain('- Closed: Send the deck')
    expect(out.text).toContain('- Sent: Intro to Acme')
    expect(out.text).toContain('- Decision: Pause agency spend')
    expect(out.text).toContain('Blocked:')
    expect(out.text).toContain('- Invoice Acme')
    const upsert = queries.find((q) => /INSERT INTO hire_standups/.test(q.text))
    expect(upsert?.text).toContain('ON CONFLICT (user_id, day) DO UPDATE')
    expect(upsert?.values).toContain(out.text)
  })
})

describe('suggestSlotsFromBusy', () => {
  const monday = Date.parse('2026-08-31T09:30:00Z')
  const at = (iso: string) => Date.parse(iso)

  it('returns the first free gaps and labels them', () => {
    const slots = suggestSlotsFromBusy(
      [{ start: at('2026-08-31T10:00:00Z'), end: at('2026-08-31T11:00:00Z') }],
      { now: monday, timezone: 'UTC', windowDays: 2 },
    )
    expect(slots).toEqual(['Mon 09:30', 'Mon 11:00', 'Mon 11:30'])
  })

  it('walks into the next day when today is full', () => {
    const slots = suggestSlotsFromBusy(
      [{ start: at('2026-08-31T00:00:00Z'), end: at('2026-08-31T23:59:00Z') }],
      { now: monday, timezone: 'UTC', windowDays: 2 },
    )
    expect(slots).toEqual(['Tue 09:00', 'Tue 09:30', 'Tue 10:00'])
  })

  it('respects a longer duration against a busy block', () => {
    const slots = suggestSlotsFromBusy(
      [{ start: at('2026-08-31T10:00:00Z'), end: at('2026-08-31T10:40:00Z') }],
      { now: monday, timezone: 'UTC', windowDays: 1, durationMin: 60 },
    )
    expect(slots).toEqual(['Mon 11:00', 'Mon 11:30', 'Mon 12:00'])
  })

  it('clamps to work hours', () => {
    const slots = suggestSlotsFromBusy([], {
      now: monday,
      timezone: 'UTC',
      windowDays: 1,
      workStartHour: 17,
      workEndHour: 18,
      durationMin: 60,
    })
    expect(slots).toEqual(['Mon 17:00'])
  })
})

describe('linear triage scoring', () => {
  const now = Date.parse('2026-08-31T12:00:00Z')
  const day = 86_400_000

  it('parses a composio JSON list including numeric priorities', () => {
    const issues = parseLinearIssues(
      JSON.stringify({
        issues: [
          { id: 'i1', title: 'Fix login', identifier: 'ENG-1', updatedAt: '2026-08-30T12:00:00Z', priority: 1 },
          { id: 'i2', title: 'Old bug', updatedAt: '2026-08-01T12:00:00Z', priority: 3 },
        ],
      }),
    )
    expect(issues).toHaveLength(2)
    expect(issues[0]).toMatchObject({ id: 'i1', title: 'Fix login', priority: 'urgent' })
  })

  it('returns nothing for prose output', () => {
    expect(parseLinearIssues('Tool LINEAR_LIST_ISSUES failed: rate limited')).toEqual([])
  })

  it('buckets by age, priority words, and fresh comments', () => {
    const buckets = scoreLinearIssues(
      [
        { id: 'a', title: 'Fresh small thing', updatedAt: now - 1 * day, priority: '', lastCommentAt: null },
        { id: 'b', title: 'Urgent outage', updatedAt: now - 3 * day, priority: 'urgent', lastCommentAt: null },
        { id: 'c', title: 'High churn report', updatedAt: now - 2 * day, priority: 'high', lastCommentAt: null },
        { id: 'd', title: 'Quiet old task', updatedAt: now - 9 * day, priority: 'low', lastCommentAt: null },
        { id: 'e', title: 'Commented today', updatedAt: now - 5 * day, priority: '', lastCommentAt: now - day },
      ],
      now,
    )
    expect(buckets.now.map((i) => i.id)).toEqual(['b', 'd', 'e'])
    expect(buckets.next.map((i) => i.id)).toEqual(['c', 'a'])
    expect(buckets.later).toBe(0)
  })

  it('counts the tail as later', () => {
    const issues = Array.from({ length: 9 }, (_, i) => ({
      id: `i${i}`,
      title: `Task ${i}`,
      updatedAt: new Date(now - (i + 1) * day).toISOString(),
      priority: '',
      lastCommentAt: null,
    }))
    const buckets = scoreLinearIssues(issues, now)
    expect(buckets.now).toHaveLength(3)
    expect(buckets.next).toHaveLength(5)
    expect(buckets.later).toBe(1)
  })
})

describe('coworker routes', () => {
  it('meeting prep rejects a request with no auth', async () => {
    const { sql } = fakeSql()
    const res = await handleHireApi(new Request('https://hirealpha.chat/api/meeting/prep?persona=coworker'), sql)
    expect(res!.status).toBe(400)
  })

  it('meeting prep returns event null when no calendar exists', async () => {
    const { sql } = fakeSql((text) =>
      /hire_users/.test(text) ? [{ id: 'u1', email: 'a@b.co', name: 'A', timezone: null, phone: null }] : [],
    )
    const res = await handleHireApi(
      new Request('https://hirealpha.chat/api/meeting/prep?persona=coworker&email=a%40b.co'),
      sql,
    )
    expect(res!.status).toBe(200)
    const body = (await res!.json()) as { event: unknown; prep: { agenda: string[] } }
    expect(body.event).toBe(null)
    expect(body.prep.agenda).toEqual([])
  })

  it('standup auto rejects a request with no auth', async () => {
    const { sql } = fakeSql()
    const res = await handleHireApi(
      new Request('https://hirealpha.chat/api/standup/auto', { method: 'POST', body: '{}' }),
      sql,
    )
    expect(res!.status).toBe(400)
  })

  it('standup auto writes the day and returns the text', async () => {
    const { sql, queries } = fakeSql((text) => {
      if (/hire_users/.test(text)) return [{ id: 'u1', email: 'a@b.co', name: 'A', timezone: null, phone: null }]
      if (/status = 'done'/.test(text)) return [{ title: 'Send the deck' }]
      if (/status = 'sent'/.test(text)) return [{ subject: 'Intro to Acme' }]
      if (/hire_decisions/.test(text)) return [{ decision: 'Pause agency spend' }]
      if (/status = 'open'/.test(text)) return [{ title: 'Invoice Acme' }]
      return []
    })
    const res = await handleHireApi(
      new Request('https://hirealpha.chat/api/standup/auto', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'a@b.co' }),
      }),
      sql,
    )
    expect(res!.status).toBe(200)
    const body = (await res!.json()) as { text: string; day: string }
    expect(body.text).toContain('Closed: Send the deck')
    expect(body.text).toContain('Blocked:')
    const upsert = queries.find((q) => /INSERT INTO hire_standups/.test(q.text))
    expect(upsert?.values).toContain(body.text)
  })

  it('slot suggest asks for a calendar when none is connected', async () => {
    const { sql } = fakeSql((text) =>
      /hire_users/.test(text) ? [{ id: 'u1', email: 'a@b.co', name: 'A', timezone: null, phone: null }] : [],
    )
    const res = await handleHireApi(
      new Request('https://hirealpha.chat/api/slots/suggest', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'a@b.co', windowDays: 3 }),
      }),
      sql,
    )
    expect(res!.status).toBe(200)
    const body = (await res!.json()) as { slots: string[]; connect: boolean }
    expect(body.slots).toEqual([])
    expect(body.connect).toBe(true)
  })

  it('linear triage returns a connect hint instead of an error when linear is off', async () => {
    const { sql } = fakeSql((text) =>
      /hire_users/.test(text) ? [{ id: 'u1', email: 'a@b.co', name: 'A', timezone: null, phone: null }] : [],
    )
    const res = await handleHireApi(
      new Request('https://hirealpha.chat/api/linear/triage?email=a%40b.co'),
      sql,
    )
    expect(res!.status).toBe(200)
    const body = (await res!.json()) as { connect: boolean }
    expect(body.connect).toBe(true)
  })
})

describe('internal coworker digest', () => {
  it('requires the internal key', async () => {
    const { sql } = fakeSql()
    const res = await handleHireApi(
      new Request('https://hirealpha.chat/api/internal/coworker/digest?persona=coworker&phone=%2B14155551212'),
      sql,
    )
    expect(res!.status).toBe(401)
  })

  it('adds nextMeeting, draftsWaiting, and standupReady for the coworker', async () => {
    const { sql, queries } = fakeSql((text) => {
      if (/hire_users/.test(text)) {
        return [{ id: 'u1', email: 'a@b.co', name: 'A', timezone: null, phone: '+14155551212' }]
      }
      if (/hire_drafts/.test(text) && /kind = 'investor'/.test(text)) return [{ n: 0 }]
      if (/hire_drafts/.test(text)) return [{ n: 2 }]
      return []
    })
    const res = await handleHireApi(
      new Request('https://hirealpha.chat/api/internal/coworker/digest?persona=coworker&phone=%2B14155551212', {
        headers: { Authorization: 'Bearer test-key' },
      }),
      sql,
    )
    expect(res!.status).toBe(200)
    const body = (await res!.json()) as {
      noteReady: boolean
      nextMeeting: unknown
      draftsWaiting: number
      standupReady: boolean
    }
    expect(body.noteReady).toBe(true)
    expect(body.nextMeeting).toBe(null)
    expect(body.draftsWaiting).toBe(2)
    expect(body.standupReady).toBe(true)
    expect(queries.some((q) => /FROM hire_standups/.test(q.text))).toBe(true)
    const pending = queries.find((q) => /hire_drafts/.test(q.text) && /status = 'pending'/.test(q.text))
    expect(pending).toBeDefined()
  })

  it('keeps the plain payload for the cofounder persona', async () => {
    const { sql } = fakeSql((text) => {
      if (/hire_users/.test(text)) {
        return [{ id: 'u1', email: 'a@b.co', name: 'A', timezone: null, phone: '+14155551212' }]
      }
      if (/hire_drafts/.test(text)) return [{ n: 0 }]
      return []
    })
    const res = await handleHireApi(
      new Request('https://hirealpha.chat/api/internal/cofounder/digest?persona=cofounder&phone=%2B14155551212', {
        headers: { Authorization: 'Bearer test-key' },
      }),
      sql,
    )
    expect(res!.status).toBe(200)
    const body = (await res!.json()) as Record<string, unknown>
    expect(body.noteReady).toBe(true)
    expect(body).not.toHaveProperty('draftsWaiting')
    expect(body).not.toHaveProperty('nextMeeting')
  })
})
