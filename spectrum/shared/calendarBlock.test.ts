import { describe, expect, it } from 'bun:test'
import { stageCalendarBlock } from './conversationalFriend'

/* The engine's own calendar write. The model answered "the calendar block only
 * made it partway through" with nothing staged; this path reads the real free
 * slots and drafts the event on the first verified gap, so the pick-slot card
 * always has something real to book. */

const when = (iso: string) => iso

const ASK = 'Add "Q3 planning" to my Notion tasks, put a 30-minute block on my calendar Thursday afternoon, and Slack Sam that it is on.'

describe('stageCalendarBlock (dim 8)', () => {
  it('drafts the event on the first verified free gap and names the others', async () => {
    const proposed: Array<{ kind: string; title: string; start: string; end: string }> = []
    const staged = await stageCalendarBlock({
      ask: ASK,
      timezone: 'America/Los_Angeles',
      connected: ['gmail', 'calendar'],
      suggest: async () => ({
        slots: [
          { start: when('2026-09-17T19:00:00.000Z'), end: when('2026-09-17T19:30:00.000Z'), label: 'Thu 12:00' },
          { start: when('2026-09-17T19:30:00.000Z'), end: when('2026-09-17T20:00:00.000Z'), label: 'Thu 12:30' },
        ],
        connect: false,
      }),
      propose: async (draft) => {
        proposed.push(draft)
        return { ok: true, id: 'draft-1' }
      },
    })
    expect(staged?.draftId).toBe('draft-1')
    expect(proposed).toHaveLength(1)
    expect(proposed[0]).toEqual({
      kind: 'event',
      title: 'Q3 planning',
      start: '2026-09-17T19:00:00.000Z',
      end: '2026-09-17T19:30:00.000Z',
    })
    expect(staged?.reply).toContain('Q3 planning')
    expect(staged?.reply).toContain('Thu 12:00')
    expect(staged?.reply).toContain('Tap Book')
    expect(staged?.reply).toContain('Thu 12:30')
    expect(staged?.reply).toContain('Notion and Slack are not connected')
  })

  it('says the window is full instead of inventing a time', async () => {
    let proposed = 0
    const staged = await stageCalendarBlock({
      ask: 'put a 30-minute block on my calendar Thursday afternoon',
      timezone: 'America/Los_Angeles',
      connected: ['calendar'],
      suggest: async () => ({ slots: [], connect: false }),
      propose: async () => {
        proposed++
        return { ok: true, id: 'draft-x' }
      },
    })
    expect(proposed).toBe(0)
    expect(staged?.draftId).toBeUndefined()
    expect(staged?.reply).toContain('no free 30-minute gap')
    expect(staged?.reply).toContain('Nothing was booked')
  })

  it('says Calendar is not connected rather than offering a time', async () => {
    const staged = await stageCalendarBlock({
      ask: 'put a 30-minute block on my calendar Thursday afternoon',
      timezone: 'America/Los_Angeles',
      connected: [],
      suggest: async () => ({ slots: [], connect: true }),
      propose: async () => ({ ok: true, id: 'nope' }),
    })
    expect(staged?.draftId).toBeUndefined()
    expect(staged?.reply).toContain('Calendar is not connected')
  })

  it('stays truthful when the draft cannot be saved', async () => {
    const staged = await stageCalendarBlock({
      ask: 'put a 30-minute block on my calendar Thursday afternoon',
      timezone: 'America/Los_Angeles',
      connected: ['calendar'],
      suggest: async () => ({
        slots: [{ start: when('2026-09-17T19:00:00.000Z'), end: when('2026-09-17T19:30:00.000Z'), label: 'Thu 12:00' }],
        connect: false,
      }),
      propose: async () => ({ ok: false, error: 'boom' }),
    })
    expect(staged?.draftId).toBeUndefined()
    expect(staged?.reply).toContain('Thu 12:00')
    expect(staged?.reply).toContain('nothing is booked')
  })

  it('leaves non-calendar asks alone', async () => {
    const staged = await stageCalendarBlock({
      ask: "what's on my calendar today?",
      timezone: 'America/Los_Angeles',
      connected: ['calendar'],
      suggest: async () => ({ slots: [], connect: false }),
      propose: async () => ({ ok: true, id: 'nope' }),
    })
    expect(staged).toBeNull()
  })

  it('does not claim a checked calendar when the slot read never answered', async () => {
    // An older server has no /api/internal/work/slots. The model's "partly went
    // through" line must be replaced with the truth; the model's own honest
    // answer is left alone.
    const staged = await stageCalendarBlock({
      ask: 'put a 30-minute block on my calendar Thursday afternoon',
      timezone: 'America/Los_Angeles',
      connected: ['calendar'],
      modelReply: 'The calendar block only made it partway through on my end, so I will not call it done.',
      suggest: async () => ({ slots: [], connect: false, unavailable: true }),
      propose: async () => ({ ok: true, id: 'nope' }),
    })
    expect(staged?.draftId).toBeUndefined()
    expect(staged?.reply).toContain('could not read your calendar')
    expect(staged?.reply).toContain('nothing is on your calendar from me')
    expect(staged?.reply).not.toContain('partway')

    const untouched = await stageCalendarBlock({
      ask: 'put a 30-minute block on my calendar Thursday afternoon',
      timezone: 'America/Los_Angeles',
      connected: ['calendar'],
      modelReply: 'Which Thursday did you mean?',
      suggest: async () => ({ slots: [], connect: false, unavailable: true }),
      propose: async () => ({ ok: true, id: 'nope' }),
    })
    expect(untouched).toBeNull()
  })
})
