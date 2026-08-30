import { describe, expect, it } from 'bun:test'
import {
  buildDailyText,
  canFireDaily,
  captureFromChat,
  detectDecision,
  detectOpportunity,
  detectPerson,
  detectPromise,
  pickDailyItem,
  resolveDueWord,
  startCofounderLoop,
  resetCofounderLoopState,
  type CofounderDigest,
  type DailyPick,
} from './cofounderPro'

const NOW = new Date('2026-08-20T12:00:00') // a Thursday, 12:00 local

describe('detectPromise', () => {
  it('catches a weekday deadline and resolves it to a date', () => {
    const hit = detectPromise("I'll send the deck by friday", NOW)
    expect(hit).not.toBeNull()
    expect(hit!.title).toBe('send the deck')
    expect(hit!.dueAt).toBe(resolveDueWord('friday', NOW)!.toISOString())
  })
  it('catches tomorrow, tonight, and eod', () => {
    expect(detectPromise("I'll reply to Priya by tomorrow", NOW)).not.toBeNull()
    expect(detectPromise("I'll call the landlord by tonight", NOW)).not.toBeNull()
    expect(detectPromise("I'll finish the form by eod", NOW)).not.toBeNull()
  })
  it('resolves relative days the same way regardless of case', () => {
    const fri = resolveDueWord('Friday', NOW)!
    expect(fri.getDay()).toBe(5)
    expect(fri.getTime()).toBeGreaterThan(NOW.getTime())
    const mon = resolveDueWord('monday', NOW)!
    expect(mon.getTime()).toBeGreaterThan(fri.getTime())
  })
  it('misses without a deadline word', () => {
    expect(detectPromise("I'll review it sometime")).toBeNull()
    expect(detectPromise('I sent the deck already')).toBeNull()
  })
  it('misses junk, precision first', () => {
    expect(detectPromise('')).toBeNull()
    expect(detectPromise("they'll send it by monday")).toBeNull()
  })
})

describe('detectDecision', () => {
  it('catches decision verbs and decided to', () => {
    expect(detectDecision("We're passing on the Acme candidate")?.decision).toContain('passing')
    expect(detectDecision('We are going with the first agency')?.decision).toContain('going with')
    expect(detectDecision('We decided to hire the senior eng')?.decision).toContain('decided to')
    expect(detectDecision("we're hiring for the design role")).not.toBeNull()
  })
  it('rejects negated and navigational wording', () => {
    expect(detectDecision('we decided nothing yet')).toBeNull()
    expect(detectDecision('We decided against the rebrand')).toBeNull()
    expect(detectDecision("We're not hiring right now")).toBeNull()
    expect(detectDecision("We're passing by the store later")).toBeNull()
  })
  it('misses plain chatter', () => {
    expect(detectDecision('we should think about pricing')).toBeNull()
    expect(detectDecision('')).toBeNull()
  })
})

describe('detectPerson', () => {
  it('catches met plus a capitalized name, with or without with', () => {
    expect(detectPerson('met Sarah at the mixer')?.name).toBe('Sarah')
    expect(detectPerson('Met with Daniel today')?.name).toBe('Daniel')
  })
  it('rejects narration and common nouns', () => {
    expect(detectPerson('met with resistance on the budget')).toBeNull()
    expect(detectPerson('Our offer was met with silence')).toBeNull()
    expect(detectPerson('met with the team')).toBeNull()
    expect(detectPerson('met at the coffee shop')).toBeNull()
  })
})

describe('detectOpportunity', () => {
  it('catches company talks and keeps the stage hint', () => {
    const hit = detectOpportunity('talking with Acme Corp about the pilot')
    expect(hit?.title).toBe('Acme Corp')
    expect(hit?.stage).toBe('talking')
    expect(detectOpportunity('pitching to Stripe next week')?.stage).toBe('pitching')
    expect(detectOpportunity('interviewing with Netflix on thursday')?.stage).toBe('interviewing')
    expect(detectOpportunity('in talks with OpenAI')?.title).toBe('OpenAI')
  })
  it('stops at lowercase words so it does not swallow the sentence', () => {
    expect(detectOpportunity('talking with Acme about pricing')?.title).toBe('Acme')
  })
  it('misses no company and no lead word', () => {
    expect(detectOpportunity('talking about the weather')).toBeNull()
    expect(detectOpportunity('')).toBeNull()
  })
})

describe('captureFromChat', () => {
  it('posts each hit and reports only confirmed creates', async () => {
    const posted: Array<{ kind: string; fields: Record<string, unknown> }> = []
    const out = await captureFromChat('+15551234567', 'cofounder', "I'll send the deck by friday. Also met Sarah.", NOW, async (kind, fields) => {
      posted.push({ kind, fields })
      return { created: true, id: `id-${posted.length}` }
    })
    expect(posted.map((p) => p.kind)).toEqual(['promise', 'person'])
    expect(out.map((o) => o.kind)).toEqual(['promise', 'person'])
    expect(out[0]!.summary).toContain('send the deck')
    expect(out[1]!.summary).toContain('Sarah')
  })
  it('skips hits the server refuses', async () => {
    const out = await captureFromChat('+15551234567', 'cofounder', 'We decided to kill the beta', NOW, async () => ({ created: false }))
    expect(out).toEqual([])
  })
  it('is a no-op without env configured', async () => {
    const savedUrl = process.env.HIREALPHA_API_URL
    const savedKey = process.env.HIREALPHA_INTERNAL_KEY
    delete process.env.HIREALPHA_API_URL
    delete process.env.HIREALPHA_INTERNAL_KEY
    const out = await captureFromChat('+15551234567', 'cofounder', "I'll call him by monday", NOW)
    expect(out).toEqual([])
    if (savedUrl) process.env.HIREALPHA_API_URL = savedUrl
    if (savedKey) process.env.HIREALPHA_INTERNAL_KEY = savedKey
  })
})

describe('pickDailyItem priority', () => {
  const iso = (d: Date) => d.toISOString()
  const daysAgo = (n: number) => iso(new Date(NOW.getTime() - n * 86_400_000))
  const daysAhead = (n: number) => iso(new Date(NOW.getTime() + n * 86_400_000))

  const full: CofounderDigest = {
    stalePipeline: [{ id: 'a', title: 'Acme', stage: 'talking', daysSinceTouch: 16 }],
    duePromises: [{ id: 'p', title: 'send the deck', dueAt: daysAgo(2) }],
    decisionsToRevisit: [{ id: 'd', decision: 'kill the beta', reviewAt: daysAgo(9) }],
    newPeople: [{ id: 'n', name: 'Sarah', lastTouchAt: daysAgo(3) }],
    noteReady: true,
  }

  it('overdue promise beats everything', () => {
    expect(pickDailyItem(full, NOW)?.kind).toBe('promise')
  })
  it('decision beats stale pipeline, pipeline beats new people, note last', () => {
    const noPromises = { ...full, duePromises: [] }
    expect(pickDailyItem(noPromises, NOW)?.kind).toBe('decision')
    const noDecisions = { ...noPromises, decisionsToRevisit: [] }
    expect(pickDailyItem(noDecisions, NOW)?.kind).toBe('pipeline')
    const noPipeline = { ...noDecisions, stalePipeline: [] }
    expect(pickDailyItem(noPipeline, NOW)?.kind).toBe('person')
    const nothingElse = { ...noPipeline, newPeople: [] }
    expect(pickDailyItem(nothingElse, NOW)?.kind).toBe('note')
  })
  it('picks the most overdue promise and the stalest pipeline row', () => {
    const digest: CofounderDigest = {
      duePromises: [
        { id: 'p1', title: 'reply to Dana', dueAt: daysAgo(1) },
        { id: 'p2', title: 'send the deck', dueAt: daysAgo(4) },
      ],
      stalePipeline: [
        { id: 'a', title: 'Acme', stage: 'talking', daysSinceTouch: 5 },
        { id: 'b', title: 'Globex', stage: 'pitching', daysSinceTouch: 21 },
      ],
    }
    const pick = pickDailyItem(digest, NOW)
    expect(pick).toMatchObject({ kind: 'promise', title: 'send the deck' })
    const pick2 = pickDailyItem({ ...digest, duePromises: [] }, NOW)
    expect(pick2).toMatchObject({ kind: 'pipeline', title: 'Globex', days: 21 })
  })
  it('returns null for empty or broken digests', () => {
    expect(pickDailyItem(null, NOW)).toBeNull()
    expect(pickDailyItem({}, NOW)).toBeNull()
    expect(pickDailyItem({ stalePipeline: [{ id: 'a', title: '', stage: 'x', daysSinceTouch: 3 }] }, NOW)).toBeNull()
  })
})

describe('buildDailyText', () => {
  it('names the item and the next action for each kind', () => {
    const overdue = buildDailyText({ kind: 'promise', title: 'send the deck', dueAt: new Date(NOW.getTime() - 2 * 86_400_000).toISOString() }, NOW)
    expect(overdue).toContain('send the deck')
    expect(overdue).toContain('2 days ago')
    const today = buildDailyText({ kind: 'promise', title: 'call Dana', dueAt: new Date(NOW.getTime() + 3_600_000).toISOString() }, NOW)
    expect(today).toContain('due today')
    expect(buildDailyText({ kind: 'decision', decision: 'kill the beta' }, NOW)).toContain('kill the beta')
    expect(buildDailyText({ kind: 'pipeline', title: 'Acme', days: 16 }, NOW)).toContain('16 days')
    expect(buildDailyText({ kind: 'person', name: 'Sarah' }, NOW)).toContain('Sarah')
    expect(buildDailyText({ kind: 'note' }, NOW)).toContain('notes')
  })
  it('never uses dashes and stays short', () => {
    const texts: string[] = []
    const picks: DailyPick[] = [
      { kind: 'promise', title: 'send the deck', dueAt: new Date(NOW.getTime() - 86_400_000).toISOString() },
      { kind: 'decision', decision: 'hire the senior eng' },
      { kind: 'pipeline', title: 'Acme', days: 16 },
      { kind: 'person', name: 'Sarah' },
      { kind: 'note' },
    ]
    for (const p of picks) texts.push(buildDailyText(p, NOW))
    for (const t of texts) {
      expect(t).not.toMatch(/[-\u2013\u2014]/)
      expect(t.length).toBeLessThan(220)
    }
  })
})

describe('daily fire once logic', () => {
  it('fires only after the start hour and only once per calendar day', () => {
    const day1 = new Date('2026-08-20T10:00:00')
    const early = new Date('2026-08-20T08:00:00')
    expect(canFireDaily(null, early)).toBe(false)
    expect(canFireDaily(null, day1)).toBe(true)
    expect(canFireDaily('2026-08-20', day1)).toBe(false)
    expect(canFireDaily('2026-08-19', day1)).toBe(true)
  })
  it('loop sends once per day, retries next day, and stays quiet before 9', async () => {
    resetCofounderLoopState('cofounder-test')
    const savedUrl = process.env.HIREALPHA_API_URL
    const savedKey = process.env.HIREALPHA_INTERNAL_KEY
    process.env.HIREALPHA_API_URL = 'http://unused.local'
    process.env.HIREALPHA_INTERNAL_KEY = 'k'
    const clock = { now: new Date('2026-08-20T10:00:00') }
    const digest: CofounderDigest = {
      phone: '+15551234567',
      stalePipeline: [{ id: 'a', title: 'Acme', stage: 'talking', daysSinceTouch: 16 }],
    }
    const sent: string[] = []
    const loop = startCofounderLoop({
      persona: 'cofounder-test',
      send: async (_phone, text) => {
        sent.push(text)
      },
      pollMs: 20,
      fetchDigest: async () => ({ ...digest }),
      checkKillSwitch: async () => false,
      now: () => clock.now,
    })
    await Bun.sleep(80)
    expect(sent.length).toBe(1)
    expect(sent[0]).toContain('Acme')
    // Same day: hourly ticks stay silent.
    clock.now = new Date('2026-08-20T15:00:00')
    await Bun.sleep(60)
    expect(sent.length).toBe(1)
    // Next day after 9: fires again.
    clock.now = new Date('2026-08-21T10:00:00')
    await Bun.sleep(60)
    expect(sent.length).toBe(2)
    // Before 9am next day: quiet.
    clock.now = new Date('2026-08-22T08:00:00')
    await Bun.sleep(60)
    expect(sent.length).toBe(2)
    loop.stop()
    if (savedUrl) process.env.HIREALPHA_API_URL = savedUrl
    else delete process.env.HIREALPHA_API_URL
    if (savedKey) process.env.HIREALPHA_INTERNAL_KEY = savedKey
    else delete process.env.HIREALPHA_INTERNAL_KEY
  })
  it('loop stays off without env and never sends', async () => {
    resetCofounderLoopState('cofounder-off')
    const savedUrl = process.env.HIREALPHA_API_URL
    delete process.env.HIREALPHA_API_URL
    const sent: string[] = []
    const loop = startCofounderLoop({
      persona: 'cofounder-off',
      send: async (_phone, text) => {
        sent.push(text)
      },
      fetchDigest: async () => ({ phone: '+15551234567', noteReady: true }),
      now: () => new Date('2026-08-20T10:00:00'),
    })
    await Bun.sleep(30)
    expect(sent).toEqual([])
    loop.stop()
    if (savedUrl) process.env.HIREALPHA_API_URL = savedUrl
  })
  it('does not burn the day when the digest is empty or broken', async () => {
    resetCofounderLoopState('cofounder-blip')
    const savedUrl = process.env.HIREALPHA_API_URL
    const savedKey = process.env.HIREALPHA_INTERNAL_KEY
    process.env.HIREALPHA_API_URL = 'http://unused.local'
    process.env.HIREALPHA_INTERNAL_KEY = 'k'
    const clock = { now: new Date('2026-08-20T10:00:00') }
    const sent: string[] = []
    let healthy = false
    const loop = startCofounderLoop({
      persona: 'cofounder-blip',
      send: async (_phone, text) => {
        sent.push(text)
      },
      pollMs: 20,
      fetchDigest: async () => (healthy ? { phone: '+15551234567', noteReady: true } : {}),
      checkKillSwitch: async () => false,
      now: () => clock.now,
    })
    await Bun.sleep(60)
    expect(sent).toEqual([])
    healthy = true
    await Bun.sleep(60)
    expect(sent.length).toBe(1)
    loop.stop()
    if (savedUrl) process.env.HIREALPHA_API_URL = savedUrl
    else delete process.env.HIREALPHA_API_URL
    if (savedKey) process.env.HIREALPHA_INTERNAL_KEY = savedKey
    else delete process.env.HIREALPHA_INTERNAL_KEY
  })
})
