import { afterAll, beforeEach, describe, expect, it } from 'bun:test'
import { miniCardOgDescription } from './authenticatedTestApi'
import { mintMiniToken } from './auth/session'

/* The card that lands in the thread shows the thing behind the link — the
 * draft, the promise, the charge — not the app's name again. These tests pin
 * that wiring: real rows become the preview line, and a user with nothing in
 * the table (or a token for another persona) falls back to the static
 * description instead of leaking someone else's row into an OG tag. */

type Captured = { text: string; values: unknown[] }

function fakeSql(rowsFor: (text: string) => unknown[] = () => []) {
  const queries: Captured[] = []
  const sql = ((strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.join('?')
    queries.push({ text, values })
    return Promise.resolve(rowsFor(text))
  }) as unknown as Parameters<typeof miniCardOgDescription>[0]
  return { sql, queries }
}

const USER = {
  id: 'u1',
  email: 'sam@example.com',
  name: 'Sam',
  timezone: 'America/Los_Angeles',
  phone: '+14155550111',
  assignedPhone: null,
}

/** hire_users answers first; every kind branch reads one table after that. */
function sqlWith(byTable: Record<string, unknown[]>) {
  return fakeSql((text) => {
    if (/hire_users/.test(text)) return [USER]
    const table = Object.keys(byTable).find((name) => text.includes(`hire_${name}`))
    return table ? byTable[table]! : []
  })
}

const savedKey = process.env.HIREALPHA_INTERNAL_KEY

beforeEach(() => {
  process.env.HIREALPHA_INTERNAL_KEY = 'test-internal-key'
})

afterAll(() => {
  if (savedKey === undefined) delete process.env.HIREALPHA_INTERNAL_KEY
  else process.env.HIREALPHA_INTERNAL_KEY = savedKey
})

describe('miniCardOgDescription', () => {
  it('previews the pending draft, not the app name', async () => {
    const { sql } = sqlWith({
      drafts: [{ subject: 'Refund for invoice #8492', toAddr: 'support@figma.com', body: 'Hi Figma,\n\nIt looks like invoice #8492 was charged twice.' }],
    })
    const token = mintMiniToken(USER.phone, 'friend', 'approve_send')!
    const line = await miniCardOgDescription(sql, token, 'friend', 'approve_send')
    expect(line).toBe('“Refund for invoice #8492” to support@figma.com — Hi Figma, It looks like invoice #8492 was charged twice.')
  })

  it('counts open promises and names the first one with its due date', async () => {
    const { sql } = sqlWith({
      loops: [
        { title: 'Send Amy the intro', dueAt: new Date('2026-09-30T18:00:00Z') },
        { title: 'Reply to Luigi', dueAt: new Date('2026-10-02T18:00:00Z') },
      ],
    })
    const token = mintMiniToken(USER.phone, 'friend', 'open_loops')!
    const line = await miniCardOgDescription(sql, token, 'friend', 'open_loops')
    expect(line).toBe('2 promises open: Send Amy the intro · due Sep 30')
  })

  it('sums the week of spend for the spending card', async () => {
    const { sql } = sqlWith({
      spending: [
        { description: 'Figma', amount: 29 },
        { description: 'Gym membership', amount: 180 },
      ],
    })
    const token = mintMiniToken(USER.phone, 'friend', 'spending_snapshot')!
    const line = await miniCardOgDescription(sql, token, 'friend', 'spending_snapshot')
    expect(line).toBe('2 charges this week · $209. Last: Figma.')
  })

  it('falls back to the static description when the user has no rows', async () => {
    const { sql } = sqlWith({})
    const token = mintMiniToken(USER.phone, 'friend', 'open_loops')!
    expect(await miniCardOgDescription(sql, token, 'friend', 'open_loops')).toBe('Nothing owed right now.')
  })

  it('refuses a token minted for another persona', async () => {
    const { sql } = sqlWith({ loops: [{ title: 'Send Amy the intro', dueAt: null }] })
    const token = mintMiniToken(USER.phone, 'coworker', 'open_loops')!
    expect(await miniCardOgDescription(sql, token, 'friend', 'open_loops')).toBeNull()
  })

  it('refuses an unsigned token', async () => {
    const { sql } = sqlWith({ loops: [{ title: 'Send Amy the intro', dueAt: null }] })
    expect(await miniCardOgDescription(sql, 'not-a-token', 'friend', 'open_loops')).toBeNull()
  })
})
