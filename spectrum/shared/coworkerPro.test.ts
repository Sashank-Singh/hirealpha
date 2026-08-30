import { describe, expect, it } from 'bun:test'
import {
  buildCoworkerText,
  canFireDaily,
  coworkerCaptureFromChat,
  detectEmailAsk,
  detectMeetingWrap,
  detectSchedulingAsk,
  pickCoworkerItem,
  resetCoworkerLoopState,
  startCoworkerLoop,
  type CoworkerDigest,
  type CoworkerPick,
} from './coworkerPro'

const NOW = new Date('2026-08-20T12:00:00') // a Thursday, 12:00 local

describe('detectEmailAsk', () => {
  it('catches an email verb plus a capitalized name', () => {
    expect(detectEmailAsk('email Priya')?.name).toBe('Priya')
    expect(detectEmailAsk('Email Priya the deck')?.name).toBe('Priya')
    expect(detectEmailAsk('draft a reply to Priya')?.name).toBe('Priya')
    expect(detectEmailAsk('draft reply to Jordan')?.name).toBe('Jordan')
    expect(detectEmailAsk('follow up with Jordan')?.name).toBe('Jordan')
    expect(detectEmailAsk('reply to Jordan about the offer')?.name).toBe('Jordan')
    expect(detectEmailAsk('send an email to Priya')?.name).toBe('Priya')
  })
  it('misses non email verbs, precision first', () => {
    expect(detectEmailAsk('text Jordan')).toBeNull()
    expect(detectEmailAsk('ping Jordan about lunch')).toBeNull()
  })
  it('misses when no name is present', () => {
    expect(detectEmailAsk('reply to the thread')).toBeNull()
    expect(detectEmailAsk('follow up with the team')).toBeNull()
    expect(detectEmailAsk('email priya')).toBeNull()
  })
  it('misses noun phrases that only look like asks', () => {
    expect(detectEmailAsk('the draft to Priya is done')).toBeNull()
    expect(detectEmailAsk('a draft to Priya is waiting')).toBeNull()
    expect(detectEmailAsk('the email Priya sent bounced')).toBeNull()
    expect(detectEmailAsk('my reply to Jordan was late')).toBeNull()
    expect(detectEmailAsk('emailing Priya now')).toBeNull()
  })
  it('every hit carries the draft intent', () => {
    expect(detectEmailAsk('email Priya')).toEqual({ name: 'Priya', intent: 'draft' })
  })
})

describe('detectSchedulingAsk', () => {
  it('catches the ask with an optional name', () => {
    expect(detectSchedulingAsk('find a time with Jordan')).toEqual({ with: 'Jordan' })
    expect(detectSchedulingAsk('set up a meeting with Priya')).toEqual({ with: 'Priya' })
    expect(detectSchedulingAsk('when is Jordan free')).toEqual({ with: 'Jordan' })
  })
  it('catches the ask without a name and still reports it', () => {
    expect(detectSchedulingAsk('schedule a call')).toEqual({})
    expect(detectSchedulingAsk('pick a slot')).toEqual({})
    expect(detectSchedulingAsk('schedule a meeting with the team')).toEqual({})
  })
  it('misses lookalikes', () => {
    expect(detectSchedulingAsk('can we reschedule the meeting')).toBeNull()
    expect(detectSchedulingAsk('I found a meeting room')).toBeNull()
    expect(detectSchedulingAsk('')).toBeNull()
  })
})

describe('detectMeetingWrap', () => {
  it('catches ended meeting phrasing', () => {
    expect(detectMeetingWrap('the review just ended')).toEqual({})
    expect(detectMeetingWrap('meeting wrapped')).toEqual({})
    expect(detectMeetingWrap('wrapped the sync')).toEqual({})
    expect(detectMeetingWrap('standup is done')).toEqual({})
    expect(detectMeetingWrap('the sync went well')).toEqual({})
  })
  it('misses future or unrelated meeting talk', () => {
    expect(detectMeetingWrap('meeting tomorrow at 3')).toBeNull()
    expect(detectMeetingWrap('schedule the review')).toBeNull()
    expect(detectMeetingWrap('')).toBeNull()
  })
})

describe('coworkerCaptureFromChat routing', () => {
  it('posts an email ask as a promise with no dueAt and reports a draft', async () => {
    const posted: Array<{ kind: string; fields: Record<string, unknown> }> = []
    const out = await coworkerCaptureFromChat('+15551234567', 'coworker', 'email Priya', NOW, async (kind, fields) => {
      posted.push({ kind, fields })
      return { created: true, id: 'd1' }
    })
    expect(posted).toEqual([{ kind: 'promise', fields: { title: 'draft reply to Priya' } }])
    expect(out).toEqual([{ kind: 'draft', summary: 'draft reply to Priya', name: 'Priya' }])
  })
  it('does not report a draft when the server refuses the create', async () => {
    const out = await coworkerCaptureFromChat('+15551234567', 'coworker', 'email Priya', NOW, async () => ({ created: false }))
    expect(out).toEqual([])
  })
  it('routes a scheduling ask to slots without posting anything', async () => {
    let posts = 0
    const out = await coworkerCaptureFromChat('+15551234567', 'coworker', 'find a time with Jordan next week', NOW, async () => {
      posts += 1
      return { created: true }
    })
    expect(posts).toBe(0)
    expect(out).toEqual([{ kind: 'slots', name: 'Jordan' }])
  })
  it('routes a meeting wrap without posting anything', async () => {
    let posts = 0
    const out = await coworkerCaptureFromChat('+15551234567', 'coworker', 'the review just ended', NOW, async () => {
      posts += 1
      return { created: true }
    })
    expect(posts).toBe(0)
    expect(out).toEqual([{ kind: 'wrap' }])
  })
  it('still captures cofounder hits for the coworker persona', async () => {
    const posted: Array<{ kind: string; fields: Record<string, unknown> }> = []
    const out = await coworkerCaptureFromChat(
      '+15551234567',
      'coworker',
      "I'll send the deck by friday. Also met Sarah.",
      NOW,
      async (kind, fields) => {
        posted.push({ kind, fields })
        return { created: true }
      },
    )
    expect(posted.map((p) => p.kind)).toEqual(['promise', 'person'])
    expect(out.map((o) => o.kind)).toEqual(['promise', 'person'])
  })
  it('an explicit promise covers an email ask so nothing double logs', async () => {
    const posted: Array<{ kind: string; fields: Record<string, unknown> }> = []
    const out = await coworkerCaptureFromChat(
      '+15551234567',
      'coworker',
      "I'll reply to Priya by tomorrow",
      NOW,
      async (kind, fields) => {
        posted.push({ kind, fields })
        return { created: true }
      },
    )
    expect(posted.map((p) => p.kind)).toEqual(['promise'])
    expect(posted[0]!.fields.title).not.toContain('draft reply to')
    expect(out.map((o) => o.kind)).toEqual(['promise'])
  })
  it('is a no-op without env configured', async () => {
    const savedUrl = process.env.HIREALPHA_API_URL
    const savedKey = process.env.HIREALPHA_INTERNAL_KEY
    delete process.env.HIREALPHA_API_URL
    delete process.env.HIREALPHA_INTERNAL_KEY
    const out = await coworkerCaptureFromChat('+15551234567', 'coworker', 'email Priya', NOW)
    expect(out).toEqual([])
    if (savedUrl) process.env.HIREALPHA_API_URL = savedUrl
    if (savedKey) process.env.HIREALPHA_INTERNAL_KEY = savedKey
  })
})

describe('pickCoworkerItem priority', () => {
  const daysAgo = (n: number) => new Date(NOW.getTime() - n * 86_400_000).toISOString()

  const full: CoworkerDigest = {
    nextMeeting: { title: 'Design review', startsInMin: 40 },
    draftsWaiting: 2,
    standupReady: false,
    duePromises: [{ id: 'p', title: 'send the deck', dueAt: daysAgo(2) }],
  }

  it('meeting within 90 minutes beats everything', () => {
    expect(pickCoworkerItem(full, NOW)?.kind).toBe('meeting')
  })
  it('drafts beat standup, standup beats overdue promise', () => {
    const noMeeting = { ...full, nextMeeting: undefined }
    expect(pickCoworkerItem(noMeeting, NOW)?.kind).toBe('drafts')
    const noDrafts = { ...noMeeting, draftsWaiting: 0 }
    expect(pickCoworkerItem(noDrafts, NOW)?.kind).toBe('standup')
    const standupDone = { ...noDrafts, standupReady: true }
    expect(pickCoworkerItem(standupDone, NOW)?.kind).toBe('promise')
  })
  it('a meeting outside the 90 minute window falls through', () => {
    const later = { ...full, nextMeeting: { title: 'Design review', startsInMin: 200 } }
    expect(pickCoworkerItem(later, NOW)?.kind).toBe('drafts')
    const past = { ...full, nextMeeting: { title: 'Design review', startsInMin: -5 } }
    expect(pickCoworkerItem(past, NOW)?.kind).toBe('drafts')
  })
  it('drafts can name a queued draft from the promise list', () => {
    const digest: CoworkerDigest = {
      draftsWaiting: 1,
      duePromises: [{ id: 'p', title: 'draft reply to Priya', dueAt: daysAgo(1) }],
    }
    expect(pickCoworkerItem(digest, NOW)).toMatchObject({ kind: 'drafts', count: 1, name: 'Priya' })
  })
  it('only overdue promises are picked, soonest first', () => {
    const digest: CoworkerDigest = {
      standupReady: true,
      duePromises: [
        { id: 'p1', title: 'reply to Dana', dueAt: new Date(NOW.getTime() + 3_600_000).toISOString() },
        { id: 'p2', title: 'send the deck', dueAt: daysAgo(4) },
        { id: 'p3', title: 'file expenses', dueAt: daysAgo(1) },
      ],
    }
    expect(pickCoworkerItem(digest, NOW)).toMatchObject({ kind: 'promise', title: 'send the deck' })
  })
  it('returns null for empty, broken, or clear digests', () => {
    expect(pickCoworkerItem(null, NOW)).toBeNull()
    expect(pickCoworkerItem({}, NOW)).toBeNull()
    expect(pickCoworkerItem({ standupReady: true }, NOW)).toBeNull()
    expect(
      pickCoworkerItem({ duePromises: [{ id: 'p', title: '', dueAt: daysAgo(1) }] }, NOW),
    ).toBeNull()
  })
})

describe('buildCoworkerText', () => {
  it('names the item and the next action for each kind', () => {
    expect(buildCoworkerText({ kind: 'meeting', title: 'Design review', startsInMin: 40 }, NOW)).toContain(
      'Design review starts in 40 minutes',
    )
    expect(buildCoworkerText({ kind: 'drafts', count: 2 }, NOW)).toContain('2 drafts are waiting')
    expect(buildCoworkerText({ kind: 'drafts', count: 1, name: 'Priya' }, NOW)).toContain('One is to Priya')
    expect(buildCoworkerText({ kind: 'standup' }, NOW)).toContain('Standup is drafted')
    expect(
      buildCoworkerText({ kind: 'promise', title: 'send the deck', dueAt: new Date(NOW.getTime() - 2 * 86_400_000).toISOString() }, NOW),
    ).toContain('2 days overdue')
  })
  it('never uses dashes and stays short', () => {
    const picks: CoworkerPick[] = [
      { kind: 'meeting', title: 'Design review', startsInMin: 90 },
      { kind: 'drafts', count: 3 },
      { kind: 'drafts', count: 1, name: 'Priya' },
      { kind: 'standup' },
      { kind: 'promise', title: 'send the deck', dueAt: new Date(NOW.getTime() - 86_400_000).toISOString() },
    ]
    for (const p of picks) {
      const t = buildCoworkerText(p, NOW)
      expect(t).not.toMatch(/[-\u2013\u2014]/)
      expect(t.length).toBeLessThan(220)
    }
  })
})

describe('daily fire once logic', () => {
  it('shares the once daily gate with the cofounder loop', () => {
    const day1 = new Date('2026-08-20T10:00:00')
    const early = new Date('2026-08-20T08:00:00')
    expect(canFireDaily(null, early)).toBe(false)
    expect(canFireDaily(null, day1)).toBe(true)
    expect(canFireDaily('2026-08-20', day1)).toBe(false)
  })
  it('loop sends once per day, retries next day, and stays quiet before 9', async () => {
    resetCoworkerLoopState('coworker-test')
    const savedUrl = process.env.HIREALPHA_API_URL
    const savedKey = process.env.HIREALPHA_INTERNAL_KEY
    process.env.HIREALPHA_API_URL = 'http://unused.local'
    process.env.HIREALPHA_INTERNAL_KEY = 'k'
    const clock = { now: new Date('2026-08-20T10:00:00') }
    const digest: CoworkerDigest = {
      phone: '+15551234567',
      draftsWaiting: 2,
      standupReady: true,
    }
    const sent: string[] = []
    const loop = startCoworkerLoop({
      persona: 'coworker-test',
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
    expect(sent[0]).toContain('2 drafts are waiting')
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
    resetCoworkerLoopState('coworker-off')
    const savedUrl = process.env.HIREALPHA_API_URL
    delete process.env.HIREALPHA_API_URL
    const sent: string[] = []
    const loop = startCoworkerLoop({
      persona: 'coworker-off',
      send: async (_phone, text) => {
        sent.push(text)
      },
      fetchDigest: async () => ({ phone: '+15551234567', draftsWaiting: 1 }),
      now: () => new Date('2026-08-20T10:00:00'),
    })
    await Bun.sleep(30)
    expect(sent).toEqual([])
    loop.stop()
    if (savedUrl) process.env.HIREALPHA_API_URL = savedUrl
  })
  it('does not burn the day when the digest is empty or broken', async () => {
    resetCoworkerLoopState('coworker-blip')
    const savedUrl = process.env.HIREALPHA_API_URL
    const savedKey = process.env.HIREALPHA_INTERNAL_KEY
    process.env.HIREALPHA_API_URL = 'http://unused.local'
    process.env.HIREALPHA_INTERNAL_KEY = 'k'
    const clock = { now: new Date('2026-08-20T10:00:00') }
    const sent: string[] = []
    let healthy = false
    const loop = startCoworkerLoop({
      persona: 'coworker-blip',
      send: async (_phone, text) => {
        sent.push(text)
      },
      pollMs: 20,
      fetchDigest: async () => (healthy ? { phone: '+15551234567', standupReady: false } : {}),
      checkKillSwitch: async () => false,
      now: () => clock.now,
    })
    await Bun.sleep(60)
    expect(sent).toEqual([])
    healthy = true
    await Bun.sleep(60)
    expect(sent.length).toBe(1)
    expect(sent[0]).toContain('Standup is drafted')
    loop.stop()
    if (savedUrl) process.env.HIREALPHA_API_URL = savedUrl
    else delete process.env.HIREALPHA_API_URL
    if (savedKey) process.env.HIREALPHA_INTERNAL_KEY = savedKey
    else delete process.env.HIREALPHA_INTERNAL_KEY
  })
  it('stays silent when no phone is known, and the day stays unfired', async () => {
    resetCoworkerLoopState('coworker-nophone')
    const savedUrl = process.env.HIREALPHA_API_URL
    const savedKey = process.env.HIREALPHA_INTERNAL_KEY
    process.env.HIREALPHA_API_URL = 'http://unused.local'
    process.env.HIREALPHA_INTERNAL_KEY = 'k'
    const sent: string[] = []
    const loop = startCoworkerLoop({
      persona: 'coworker-nophone',
      send: async (_phone, text) => {
        sent.push(text)
      },
      pollMs: 20,
      fetchDigest: async () => ({ draftsWaiting: 1 }),
      checkKillSwitch: async () => false,
      now: () => new Date('2026-08-20T10:00:00'),
    })
    await Bun.sleep(60)
    expect(sent).toEqual([])
    loop.stop()
    if (savedUrl) process.env.HIREALPHA_API_URL = savedUrl
    else delete process.env.HIREALPHA_API_URL
    if (savedKey) process.env.HIREALPHA_INTERNAL_KEY = savedKey
    else delete process.env.HIREALPHA_INTERNAL_KEY
  })
})
