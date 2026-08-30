import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import {
  captureCofounderItem,
  cofounderDigest,
  handleHireApi,
  type CofounderCaptureKind,
} from './hire-api'

/* The cofounder tools promise a partner who already did the work: capture
 * files what was said without cloning it, the digest surfaces staleness, and
 * the investor note pulls its own numbers. These tests pin the filing rules. */

type Captured = { text: string; values: unknown[] }

function fakeSql(rowsFor: (text: string) => unknown[] = () => []) {
  const queries: Captured[] = []
  const sql = ((strings: TemplateStringsArray, ...values: unknown[]) => {
    queries.push({ text: strings.join('?'), values })
    return Promise.resolve(rowsFor(strings.join('?')))
  }) as unknown as Parameters<typeof captureCofounderItem>[0]
  return { sql, queries }
}

const savedKey = process.env.HIREALPHA_INTERNAL_KEY

beforeEach(() => {
  process.env.HIREALPHA_INTERNAL_KEY = 'test-key'
})

afterEach(() => {
  if (savedKey === undefined) delete process.env.HIREALPHA_INTERNAL_KEY
  else process.env.HIREALPHA_INTERNAL_KEY = savedKey
})

describe('captureCofounderItem', () => {
  it('inserts a decision with reason and review date', async () => {
    const { sql, queries } = fakeSql()
    const reviewAt = new Date('2026-09-15T00:00:00Z')
    const out = await captureCofounderItem(sql, 'u1', 'cofounder', 'decision', {
      decision: 'Pause hiring',
      reason: 'runway',
      reviewAt: reviewAt.toISOString(),
    })
    expect(out.created).toBe(true)
    const select = queries.find((q) => /FROM hire_decisions/.test(q.text))
    expect(select?.text).toContain("now() - interval '24 hours'")
    const insert = queries.find((q) => /INSERT INTO hire_decisions/.test(q.text))
    expect(insert?.values).toContain('Pause hiring')
    expect(insert?.values).toContain('runway')
    expect(insert?.values.some((v) => v instanceof Date && v.getTime() === reviewAt.getTime())).toBe(true)
  })

  it('updates the same decision inside 24 hours instead of cloning it', async () => {
    const { sql, queries } = fakeSql((text) =>
      /SELECT id FROM hire_decisions/.test(text) ? [{ id: 'd1' }] : [],
    )
    const out = await captureCofounderItem(sql, 'u1', 'cofounder', 'decision', {
      decision: 'pause hiring',
      reason: 'tighter runway',
    })
    expect(out).toEqual({ created: false, id: 'd1' })
    expect(queries.some((q) => /INSERT INTO hire_decisions/.test(q.text))).toBe(false)
    const update = queries.find((q) => /UPDATE hire_decisions/.test(q.text))
    expect(update?.text).toContain('updated_at = now()')
    expect(update?.values).toContain('tighter runway')
  })

  it('inserts a promise with its due date', async () => {
    const { sql, queries } = fakeSql()
    const dueAt = new Date('2026-09-02T12:00:00Z')
    await captureCofounderItem(sql, 'u1', 'cofounder', 'promise', {
      title: 'Send the deck',
      dueAt: dueAt.toISOString(),
    })
    const insert = queries.find((q) => /INSERT INTO hire_loops/.test(q.text))
    expect(insert?.text).toContain("'open'")
    expect(insert?.values).toContain('Send the deck')
    expect(insert?.values.some((v) => v instanceof Date && v.getTime() === dueAt.getTime())).toBe(true)
  })

  it('dedupes a repeated promise inside 24 hours', async () => {
    const { sql, queries } = fakeSql((text) =>
      /SELECT id FROM hire_loops/.test(text) ? [{ id: 'l1' }] : [],
    )
    const out = await captureCofounderItem(sql, 'u1', 'cofounder', 'promise', { title: 'send the deck' })
    expect(out).toEqual({ created: false, id: 'l1' })
    const update = queries.find((q) => /UPDATE hire_loops/.test(q.text))
    expect(update?.text).toContain('due_at = COALESCE')
  })

  it('upserts a person by name and restarts the touch clock', async () => {
    const { sql, queries } = fakeSql((text) =>
      /FROM hire_relationships/.test(text) ? [{ id: 'r1' }] : [],
    )
    const out = await captureCofounderItem(sql, 'u1', 'cofounder', 'person', {
      name: 'Priya',
      kind: 'investor',
      notes: 'met at the demo day',
    })
    expect(out).toEqual({ created: false, id: 'r1' })
    const update = queries.find((q) => /UPDATE hire_relationships/.test(q.text))
    expect(update?.text).toContain('last_touch_at = now()')
    expect(update?.values).toContain('investor')
    expect(update?.values).toContain('met at the demo day')
  })

  it('creates a person the first time they are mentioned', async () => {
    const { sql, queries } = fakeSql()
    const out = await captureCofounderItem(sql, 'u1', 'cofounder', 'person', { name: 'Priya' })
    expect(out.created).toBe(true)
    const insert = queries.find((q) => /INSERT INTO hire_relationships/.test(q.text))
    expect(insert?.values).toContain('Priya')
    expect(insert?.values).toContain('other')
  })

  it('upserts an opportunity by title and company', async () => {
    const { sql, queries } = fakeSql((text) =>
      /FROM hire_pipeline/.test(text) ? [{ id: 'p1' }] : [],
    )
    const out = await captureCofounderItem(sql, 'u1', 'cofounder', 'opportunity', {
      title: 'Acme',
      company: 'Acme Corp',
      stage: 'interview',
      value: 12000,
    })
    expect(out).toEqual({ created: false, id: 'p1' })
    const update = queries.find((q) => /UPDATE hire_pipeline/.test(q.text))
    expect(update?.text).toContain('updated_at = now()')
    expect(update?.values).toContain('interview')
  })

  it('creates an opportunity with a default stage and kind', async () => {
    const { sql, queries } = fakeSql()
    const out = await captureCofounderItem(sql, 'u1', 'cofounder', 'opportunity', { title: 'Acme' })
    expect(out.created).toBe(true)
    const insert = queries.find((q) => /INSERT INTO hire_pipeline/.test(q.text))
    expect(insert?.values).toContain('lead')
    expect(insert?.values).toContain('deal')
  })

  it('rejects an unknown kind', async () => {
    const { sql } = fakeSql()
    await expect(
      captureCofounderItem(sql, 'u1', 'cofounder', 'nonsense' as CofounderCaptureKind, {}),
    ).rejects.toThrow('unknown capture kind')
  })
})

describe('cofounderDigest', () => {
  const day = 86_400_000

  function digestRows(nDrafts = 0) {
    return (text: string): unknown[] => {
      if (/stage NOT IN \('won', 'lost'\)/.test(text)) {
        return [
          { id: 'p1', title: 'Acme deal', stage: 'active', updatedAt: new Date(Date.now() - 15 * day) },
        ]
      }
      if (/interval '30 days'/.test(text) && /GROUP BY stage/.test(text)) return []
      if (/GROUP BY stage/.test(text)) {
        return [
          { stage: 'active', n: 2 },
          { stage: 'lead', n: 1 },
        ]
      }
      if (/due_at <= now\(\) \+ interval '72 hours'/.test(text)) {
        return [{ id: 'l1', title: 'Send the deck', dueAt: new Date(Date.now() + day) }]
      }
      if (/review_at <= now\(\)/.test(text)) {
        return [{ id: 'dc1', decision: 'Pause hiring', reviewAt: new Date(Date.now() - day) }]
      }
      if (/make_interval/.test(text)) {
        return [{ id: 'r1', name: 'Priya', lastTouchAt: new Date(Date.now() - 40 * day) }]
      }
      if (/hire_drafts/.test(text)) return [{ n: nDrafts }]
      return []
    }
  }

  it('assembles every section from the right filters', async () => {
    const { sql, queries } = fakeSql(digestRows(0))
    const d = await cofounderDigest(sql, 'u1', 'cofounder')
    expect(d.stalePipeline).toHaveLength(1)
    expect(d.stalePipeline[0].title).toBe('Acme deal')
    expect(d.stalePipeline[0].daysSinceTouch).toBe(15)
    expect(d.duePromises[0].title).toBe('Send the deck')
    expect(d.decisionsToRevisit[0].decision).toBe('Pause hiring')
    expect(d.newPeople[0].name).toBe('Priya')
    expect(d.pipelineMoves).toEqual({ active: 2, lead: 1 })
    expect(d.noteReady).toBe(true)
    const staleQ = queries.find((q) => q.text.includes("interval '10 days'"))
    expect(staleQ?.text).toContain("stage NOT IN ('won', 'lost')")
    const promiseQ = queries.find((q) => q.text.includes("interval '72 hours'"))
    expect(promiseQ?.text).toContain("status = 'open'")
  })

  it('marks the note not ready when one went out this month', async () => {
    const { sql } = fakeSql(digestRows(1))
    const d = await cofounderDigest(sql, 'u1', 'cofounder')
    expect(d.noteReady).toBe(false)
  })
})

describe('internal cofounder routes', () => {
  it('capture requires the internal key', async () => {
    const { sql } = fakeSql()
    const res = await handleHireApi(
      new Request('https://hirealpha.chat/api/internal/cofounder/capture', {
        method: 'POST',
        body: JSON.stringify({ phone: '+14155551212', persona: 'cofounder', kind: 'promise' }),
      }),
      sql,
    )
    expect(res!.status).toBe(401)
  })

  it('capture files one item for the phone user', async () => {
    const { sql, queries } = fakeSql((text) =>
      /hire_users/.test(text) ? [{ id: 'u1', email: 'a@b.co', name: 'A', timezone: null, phone: '+14155551212' }] : [],
    )
    const res = await handleHireApi(
      new Request('https://hirealpha.chat/api/internal/cofounder/capture', {
        method: 'POST',
        headers: { Authorization: 'Bearer test-key', 'Content-Type': 'application/json' },
        body: JSON.stringify({
          phone: '+14155551212',
          persona: 'cofounder',
          kind: 'promise',
          fields: { title: 'Send the deck' },
        }),
      }),
      sql,
    )
    expect(res!.status).toBe(200)
    const body = (await res!.json()) as { created: boolean }
    expect(body.created).toBe(true)
    expect(queries.some((q) => /INSERT INTO hire_loops/.test(q.text))).toBe(true)
  })

  it('digest requires the internal key', async () => {
    const { sql } = fakeSql()
    const res = await handleHireApi(
      new Request('https://hirealpha.chat/api/internal/cofounder/digest?persona=cofounder&phone=%2B14155551212'),
      sql,
    )
    expect(res!.status).toBe(401)
  })

  it('digest returns the payload for the phone user', async () => {
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
    const body = (await res!.json()) as { noteReady: boolean; stalePipeline: unknown[] }
    expect(body.noteReady).toBe(true)
    expect(body.stalePipeline).toEqual([])
  })
})

describe('pipeline move and investor note routes', () => {
  it('moves a stage and refreshes updated_at', async () => {
    const { sql, queries } = fakeSql((text) => {
      if (/FROM hire_users WHERE email/.test(text)) {
        return [{ id: 'u1', email: 'a@b.co', name: 'A', timezone: null, phone: null }]
      }
      if (/RETURNING id/.test(text)) return [{ id: 'p1' }]
      return []
    })
    const res = await handleHireApi(
      new Request('https://hirealpha.chat/api/pipeline/move', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'a@b.co', id: 'p1', stage: 'interview' }),
      }),
      sql,
    )
    expect(res!.status).toBe(200)
    const body = (await res!.json()) as { ok: boolean; id: string }
    expect(body.id).toBe('p1')
    const update = queries.find((q) => /UPDATE hire_pipeline/.test(q.text))
    expect(update?.text).toContain('updated_at = now()')
    expect(update?.values).toContain('interview')
  })

  it('rejects a stage that does not exist', async () => {
    const { sql } = fakeSql()
    const res = await handleHireApi(
      new Request('https://hirealpha.chat/api/pipeline/move', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'a@b.co', id: 'p1', stage: 'moon' }),
      }),
      sql,
    )
    expect(res!.status).toBe(400)
  })

  it('rejects the move without any auth', async () => {
    const { sql } = fakeSql()
    const res = await handleHireApi(
      new Request('https://hirealpha.chat/api/pipeline/move', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: 'p1', stage: 'lead' }),
      }),
      sql,
    )
    expect(res!.status).toBe(400)
  })

  it('drafts an investor note with month over month deltas and runway', async () => {
    const { sql, queries } = fakeSql((text) => {
      if (/FROM hire_users WHERE email/.test(text)) {
        return [{ id: 'u1', email: 'a@b.co', name: 'A', timezone: null, phone: null }]
      }
      if (/hire_decisions\s+ORDER BY created_at DESC LIMIT 5/.test(text)) {
        return [{ decision: 'Pause hiring', reason: 'runway' }]
      }
      if (/hire_spending/.test(text)) return [{ n: 0 }]
      if (/interval '30 days'/.test(text) && /GROUP BY stage/.test(text)) {
        return [
          { stage: 'active', n: 1 },
          { stage: 'lead', n: 2 },
        ]
      }
      if (/GROUP BY stage/.test(text)) {
        return [
          { stage: 'active', n: 3 },
          { stage: 'lead', n: 1 },
        ]
      }
      if (/hire_runway_snapshots/.test(text)) return [{ cash: 150000, burn: 15000, months: 10 }]
      if (/status = 'open'/.test(text)) return [{ n: 2 }]
      return []
    })
    const res = await handleHireApi(
      new Request('https://hirealpha.chat/api/investor-note/draft', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'a@b.co' }),
      }),
      sql,
    )
    expect(res!.status).toBe(200)
    const body = (await res!.json()) as { draft: { subject: string; body: string; status: string } }
    expect(body.draft.subject).toBe('Investor update')
    expect(body.draft.status).toBe('pending')
    expect(body.draft.body).toContain('Month over month: lead -1, active +2.')
    expect(body.draft.body).toContain('Runway: 10.0 months')
    expect(body.draft.body).toContain('Open decisions: 2.')
    expect(body.draft.body).toContain('Ask:')
    const insert = queries.find((q) => /INSERT INTO hire_drafts/.test(q.text))
    expect(insert?.text).toContain("'investor'")
    expect(insert?.text).toContain("'pending'")
  })
})
