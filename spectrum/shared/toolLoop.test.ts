import { describe, expect, it } from 'bun:test'
import {
  looksLikeEventWrite,
  looksLikeFollowUp,
  looksLikeMailWrite,
  looksLikePrep,
  looksLikeHealthDiagnosis,
  looksLikeHighStakesLegal,
  looksLikeMoneyMovement,
  looksLikeGrief,
  looksLikeNegotiationClose,
  looksLikeUntaughtTaste,
  classifyHardStop,
  classifyHumanLimit,
  matchPerson,
  matchTextPerson,
  parseDraftCall,
  parseExtractedWrite,
  validatePurchase,
  parsePlannerTool,
  parseToolCall,
  pickMapRecommendation,
  pingMail,
  prepTarget,
  stripToolDirectives,
  wantsOperatorWrite,
  runToolConversation,
} from './toolLoop'

describe('multi-step agent execution', () => {
  function scenario(answers: string[], overrides: Partial<Parameters<typeof runToolConversation>[0]> = {}) {
    const lookups: string[] = []
    const drafts: unknown[] = []
    const prompts: string[] = []
    const run = () => runToolConversation({
      messages: [{ role: 'user', content: 'Find the confirmation, check my availability, and draft a reply.' }],
      availableTools: ['gmail', 'calendar', 'drive', 'web', 'maps'],
      canDraft: true,
      chat: async (messages) => { prompts.push(JSON.stringify(messages)); const answer = answers.shift(); if (!answer) throw new Error('model unavailable'); return answer },
      lookup: async (tool, query) => { lookups.push(`${tool}:${query}`); return ['id=flight123; confirmed departure 3 PM'] },
      propose: async (draft) => { drafts.push(draft); return { ok: true, id: 'draft123' } },
      ...overrides,
    })
    return { run, lookups, drafts, prompts }
  }

  it('keeps action and draft receipts when the next model call fails', async () => {
    const s = scenario([
      '{"action":"use","name":"reminder","input":{}}',
      '{"action":"reply","id":"flight123","body":"Confirmed."}',
    ], { capabilities: [{ name: 'reminder', description: 'Schedule', mutates: true, execute: async () => ({ status: 'done', message: 'Reminder saved for tomorrow.' }) }] })
    const result = await s.run()
    expect(result.reply).toContain('Reminder saved for tomorrow.')
    expect(result.reply).toContain('email draft is saved')
  })

  it('does not retry an uncertain capability write', async () => {
    let attempts = 0
    const s = scenario([
      '{"action":"use","name":"reminder","input":{}}',
      '{"action":"use","name":"reminder","input":{}}',
      'I could not confirm the reminder was saved.',
    ], { capabilities: [{ name: 'reminder', description: 'Schedule', mutates: true, execute: async () => { attempts++; throw new Error('timeout') } }] })
    await s.run()
    expect(attempts).toBe(1)
    expect(s.prompts[2]).toContain('already attempted')
  })

  it('does not propose a purchase rejected by validation', async () => {
    const s = scenario(['{"action":"purchase","item":"Laptop","amount":99999,"url":"https://example.com/laptop"}', 'That exceeds the purchase limit.'])
    await s.run()
    expect(s.drafts).toHaveLength(0)
    expect(s.prompts[1]).toContain('blocked')
  })

  it('delivers a supported partial result before the remaining tool completes', async () => {
    const updates: string[] = []
    const s = scenario([
      '{"action":"lookup","tool":"maps","query":"Chinese restaurant"}',
      '{"action":"lookup","tool":"web","query":"menu","progress":"Example Chinese is open at 8. I’m checking its menu."}',
      'The menu is $25. Live Uber pricing is unavailable.',
    ], {
      delivery: { onProgress: async text => { updates.push(text) } },
      chat: async messages => {
        const actions = messages.filter(m => m.role === 'assistant').length
        if (actions === 0) return '{"action":"lookup","tool":"maps","query":"Chinese restaurant"}'
        if (actions === 1) {
          await new Promise(resolve => setTimeout(resolve, 2550))
          return '{"action":"lookup","tool":"web","query":"menu","progress":"Example Chinese is open at 8. I’m checking its menu."}'
        }
        return 'The menu is $25. Live Uber pricing is unavailable.'
      },
      lookup: async tool => {
        if (tool === 'web') expect(updates).toEqual(['Example Chinese is open at 8. I’m checking its menu.'])
        return ['Example Chinese: open until 10 pm, menu $25.']
      },
    })
    const result = await s.run()
    expect(result.reply).toContain('Live Uber pricing is unavailable')
    expect(updates).toHaveLength(1)
  })

  it('uses an optional reaction with the final answer without an extra model call', async () => {
    const reactions: string[] = []
    const s = scenario(['{"action":"answer","text":"Congratulations on the offer!","reaction":"🎉"}'], {
      delivery: { onReaction: async emoji => { reactions.push(emoji) } },
    })
    expect((await s.run()).reply).toBe('Congratulations on the offer!')
    expect(reactions).toEqual(['🎉'])
    expect(s.prompts).toHaveLength(1)
    expect(s.lookups).toHaveLength(0)
  })

  it('does not react by default or publish an ungrounded first-action update', async () => {
    const updates: string[] = []
    const reactions: string[] = []
    const s = scenario(['{"action":"lookup","tool":"maps","query":"restaurant","progress":"I booked it!"}', 'Here are the options.'], {
      delivery: { onProgress: async text => { updates.push(text) }, onReaction: async emoji => { reactions.push(emoji) } },
    })
    await s.run()
    expect(updates).toEqual([])
    expect(reactions).toEqual([])
  })

  it('uses sequential JSON actions and gives the model each preceding result', async () => {
    const s = scenario([
      '{"action":"lookup","tool":"gmail","query":"subject:confirmation"}',
      '{"action":"lookup","tool":"calendar","query":"start=2026-09-08T14:00:00-07:00 end=2026-09-08T17:00:00-07:00"}',
      '{"action":"reply","id":"flight123","body":"Thanks, I confirm."}',
      'The reply is ready for review.',
    ])
    const result = await s.run()
    expect(s.lookups).toHaveLength(2)
    expect(s.drafts).toEqual([{ type: 'reply', id: 'flight123', body: 'Thanks, I confirm.' }])
    expect(s.prompts[1]).toContain('confirmed departure 3 PM')
    expect(s.prompts[3]).toContain('draft_saved')
    expect(result.draft).toEqual({ id: 'draft123', type: 'reply' })
  })

  it('suppresses repeated equivalent searches and still lets the model answer', async () => {
    const s = scenario(['TOOL gmail from:maya', 'TOOL GMAIL FROM:maya', 'I found the thread.'])
    expect((await s.run()).reply).toBe('I found the thread.')
    expect(s.lookups).toEqual(['gmail:from:maya'])
    expect(s.prompts[2]).toContain('duplicate')
  })

  it('can use another source after a lookup fails', async () => {
    const calls: string[] = []
    const s = scenario(['TOOL maps vegan dinner Austin', 'TOOL web vegan dinner Austin', 'Here is the restaurant website.'], {
      lookup: async (tool) => { calls.push(tool); if (tool === 'maps') throw new Error('offline'); return ['https://restaurant.example.com'] },
    })
    expect((await s.run()).reply).toContain('restaurant website')
    // The loop auto-falls-back maps→web inside the same step when maps comes
    // back empty/failed, so the failure never reaches the model as text.
    expect(calls).toEqual(['maps', 'web'])
  })

  it('never invokes a disconnected lookup or saves a blocked draft', async () => {
    const s = scenario(['TOOL gmail from:maya', 'DRAFT_REPLY id=123 | body=hello', 'Please connect Gmail.'], { availableTools: ['web'], canDraft: false })
    expect((await s.run()).reply).toContain('connect Gmail')
    expect(s.lookups).toHaveLength(0)
    expect(s.drafts).toHaveLength(0)
  })

  it('does not lose a saved draft when the next model call fails', async () => {
    const s = scenario(['DRAFT_REPLY id=flight123 | body=Thanks.'])
    const result = await s.run()
    expect(result.reply).toContain('draft is saved')
    expect(result.reply).toContain('Nothing has been sent')
    expect(result.draft?.id).toBe('draft123')
  })

  it('does not retry an uncertain draft write', async () => {
    let writes = 0
    const s = scenario(['DRAFT_REPLY id=flight123 | body=Thanks.', 'DRAFT_REPLY id=flight123 | body=Thanks.'], {
      propose: async () => { writes++; throw new Error('connection lost') },
    })
    const result = await s.run()
    expect(writes).toBe(1)
    expect(result.draft).toBeUndefined()
    expect(result.reply).toContain('could not confirm')
  })

  it('blocks a rephrasing of the same search but allows distinct ones', async () => {
    // Shared ordinary words must not count as a repeat: "query 1" and "query 2"
    // are different searches, and blocking them lost real results. A genuine
    // rephrasing — most meaningful words in common — is still blocked.
    let distinct = 0
    const first = scenario([], { maxSteps: 3, chat: async () => `TOOL web query ${++distinct}` })
    await first.run()
    expect(first.lookups.length).toBeGreaterThanOrEqual(2)

    const repeated = ['TOOL web query jasmine rice 5lb amazon', 'TOOL web query amazon jasmine rice 5lb price']
    let i = 0
    const second = scenario([], { maxSteps: 3, chat: async () => repeated[Math.min(i++, repeated.length - 1)]! })
    await second.run()
    expect(second.lookups).toHaveLength(1)
  })

  it('stops an endless sequence within its action budget without leaking directives', async () => {
    let calls = 0
    const s = scenario([], { maxSteps: 2, chat: async () => `TOOL web query ${++calls}` })
    const result = await s.run()
    expect(s.lookups).toHaveLength(2)
    expect(calls).toBe(3)
    expect(result.reply).not.toContain('TOOL')
    expect(result.reply).toContain('could not finish')
  })

  it('rejects malformed and unsupported actions instead of exposing them to the user', async () => {
    const s = scenario(['{"action":"mail","to":"x@example.com",', '{"action":"execute_shell","command":"whoami"}', 'I cannot perform that action.'])
    expect((await s.run()).reply).toBe('I cannot perform that action.')
    expect(s.drafts).toHaveLength(0)
    expect(s.lookups).toHaveLength(0)
  })

  it('parses escaped quotes, newlines and pipe characters without truncating a draft', () => {
    const body = 'Please confirm "aisle".\nOption A | Option B.'
    expect(parseExtractedWrite(JSON.stringify({ action: 'reply', id: 'abc', body }))).toEqual({ type: 'reply', id: 'abc', body })
    expect(parseExtractedWrite('{"action":"reply","id":"abc","body":"cut off')).toBeNull()
  })

  it('does not start model or tool work after the turn deadline', async () => {
    const s = scenario(['TOOL gmail from:maya'], { maxDurationMs: 0 })
    expect((await s.run()).reply).toContain('could not finish')
    expect(s.prompts).toHaveLength(0)
    expect(s.lookups).toHaveLength(0)
  })
})

describe('tool loop directives', () => {
  it('parses a maps tool line even after a sentence', () => {
    const hit = parseToolCall('On it.\nTOOL maps quiet restaurant in San Francisco')
    expect(hit).toEqual({ tool: 'maps', query: 'quiet restaurant in San Francisco' })
  })

  it('ignores chatter without a tool line', () => {
    expect(parseToolCall('What is on today?')).toBeNull()
  })

  it('parses mail, reply, and event drafts', () => {
    expect(
      parseDraftCall('DRAFT_MAIL to=maya@acme.com | subject=Ping | body=Hey Maya, checking in.'),
    ).toEqual({
      type: 'mail',
      to: 'maya@acme.com',
      subject: 'Ping',
      body: 'Hey Maya, checking in.',
    })
    expect(parseDraftCall('DRAFT_REPLY id=abc123 | body=Thanks, Thursday works.')).toEqual({
      type: 'reply',
      id: 'abc123',
      body: 'Thanks, Thursday works.',
    })
    expect(
      parseDraftCall('DRAFT_EVENT title=Coffee with Maya | start=2026-08-21T15:00 | end=2026-08-21T15:30'),
    ).toEqual({
      type: 'event',
      title: 'Coffee with Maya',
      start: '2026-08-21T15:00',
      end: '2026-08-21T15:30',
    })
  })

  it('strips directives from the user-facing reply', () => {
    const out = stripToolDirectives(
      'TOOL gmail Maya\nDRAFT_REPLY id=x | body=Hi\nTap Send on the card.',
    )
    expect(out).toBe('Tap Send on the card.')
    expect(out).not.toContain('TOOL')
    expect(out).not.toContain('DRAFT')
  })

  it('matches Text Maya to a People phone', () => {
    const hit = matchTextPerson('text Maya', [
      { name: 'Maya Chen', phone: '+12163032166' },
      { name: 'Sam', phone: '+14155551212' },
    ])
    expect(hit).toEqual({ name: 'Maya Chen', phone: '+12163032166' })
  })

  it('does not invent a number when the person has none', () => {
    expect(matchTextPerson('text Maya', [{ name: 'Maya Chen' }])).toBeNull()
  })
})

describe('operator writes', () => {
  it('detects send mail, create event, and follow up', () => {
    expect(looksLikeMailWrite('send Maya an email about Thursday')).toBe(true)
    expect(looksLikeMailWrite('reply to that mail')).toBe(true)
    expect(looksLikeEventWrite('put coffee with Maya on my calendar tomorrow at 3')).toBe(true)
    expect(looksLikeFollowUp('follow up with Maya')).toBe(true)
    expect(looksLikeFollowUp('ping Sam')).toBe(true)
    expect(wantsOperatorWrite('what is today')).toBe(false)
    expect(looksLikePrep('prep me for Amy')).toBe(true)
    expect(looksLikePrep('get me ready for the review')).toBe(true)
    expect(looksLikePrep('brief me on Amy')).toBe(true)
    expect(wantsOperatorWrite('prep me for Amy')).toBe(true)
    expect(prepTarget('prep me for Amy')).toBe('Amy')
    expect(prepTarget('prep me for my 1-1 with Amy Black')).toBe('Amy Black')
    expect(prepTarget('get me ready for the review')).toBe('review')
    expect(
      matchPerson('prep me for Amy', [{ name: 'Amy Black', email: 'amy@x.com' }])?.email,
    ).toBe('amy@x.com')
  })

  it('matches follow up to email and drafts a ping', () => {
    const hit = matchPerson('follow up with Maya', [
      { name: 'Maya Chen', phone: '+12163032166', email: 'maya@acme.com' },
    ])
    expect(hit?.email).toBe('maya@acme.com')
    expect(pingMail(hit!)).toEqual({
      type: 'mail',
      to: 'maya@acme.com',
      subject: 'Checking in',
      body: 'Hey Maya, checking in. How are things on your end?',
    })
  })

  it('parses planner and extract JSON', () => {
    expect(parsePlannerTool('{"tool":"gmail","query":"from:maya"}')).toEqual({
      tool: 'gmail',
      query: 'from:maya',
    })
    expect(parsePlannerTool('{"tool":"none"}')).toBeNull()
    expect(
      parseExtractedWrite(
        '{"action":"event","title":"Coffee with Maya","start":"tomorrow 3pm","end":""}',
      ),
    ).toEqual({
      type: 'event',
      title: 'Coffee with Maya',
      start: 'tomorrow 3pm',
      end: '',
    })
  })
})

describe('hard stops', () => {
  it('blocks money movement but not a spend log', () => {
    expect(looksLikeMoneyMovement('venmo Maya $50')).toBe(true)
    expect(looksLikeMoneyMovement('send $40 to Maya')).toBe(true)
    expect(looksLikeMoneyMovement('pay the invoice')).toBe(true)
    expect(looksLikeMoneyMovement('I spent $40 on lunch')).toBe(false)
    expect(classifyHardStop('wire them $200')).toBe('money')
  })

  it('blocks diagnosis but not a meal log', () => {
    expect(looksLikeHealthDiagnosis('do I have covid')).toBe(true)
    expect(looksLikeHealthDiagnosis('diagnose this rash')).toBe(true)
    expect(looksLikeHealthDiagnosis('I ate a chicken bowl')).toBe(false)
    expect(classifyHardStop('is this cancer')).toBe('health')
  })

  it('blocks legal advice but not meeting prep', () => {
    expect(looksLikeHighStakesLegal('is this NDA legally binding')).toBe(true)
    expect(looksLikeHighStakesLegal('draft a will and send it')).toBe(true)
    expect(looksLikeHighStakesLegal('prep me for Amy')).toBe(false)
    expect(classifyHardStop('sue them tomorrow')).toBe('legal')
  })
})

describe('human limits', () => {
  it('stays a friend in grief and does not treat a deadline as death', () => {
    expect(looksLikeGrief('my dad died this morning')).toBe(true)
    expect(looksLikeGrief('the funeral is Thursday')).toBe(true)
    expect(looksLikeGrief('the deadline is Thursday')).toBe(false)
    expect(classifyHumanLimit('I lost my mom')).toBe('grief')
  })

  it('will not close a negotiation for them, and still lets prep through', () => {
    expect(looksLikeNegotiationClose('close the deal for me')).toBe(true)
    expect(looksLikeNegotiationClose('negotiate this for me')).toBe(true)
    expect(looksLikeNegotiationClose('prep me for the offer')).toBe(false)
    expect(classifyHumanLimit('handle the negotiation for me')).toBe('negotiation')
  })

  it('will not invent taste, and still lets a restaurant lookup through', () => {
    expect(looksLikeUntaughtTaste('pick my aesthetic')).toBe(true)
    expect(looksLikeUntaughtTaste("what's my taste")).toBe(true)
    expect(looksLikeUntaughtTaste('pick a restaurant')).toBe(false)
    expect(classifyHumanLimit('which one looks more me')).toBe('taste')
  })
})

describe('map recommendations', () => {
  const MAP_BLOCK = [
    'Map results for "quiet restaurant in San Francisco":',
    '- Greens Restaurant (restaurant)',
    '  https://www.openstreetmap.org/?mlat=37.80&mlon=-122.43#map=16/37.80/-122.43',
    '- Nopa (restaurant)',
    '  https://www.openstreetmap.org/?mlat=37.77&mlon=-122.44#map=16/37.77/-122.44',
    '- Tartine (bakery)',
  ].join('\n')

  it('picks the first place, alternate second, first link found', () => {
    expect(pickMapRecommendation(MAP_BLOCK)).toEqual({
      pick: 'Greens Restaurant',
      alternate: 'Nopa',
      link: 'https://www.openstreetmap.org/?mlat=37.80&mlon=-122.43#map=16/37.80/-122.43',
    })
  })

  it('survives one result and no link', () => {
    expect(pickMapRecommendation('Map results for "x":\n- Tartine (bakery)')).toEqual({
      pick: 'Tartine',
    })
  })

  it('returns null on a no-results string', () => {
    expect(pickMapRecommendation('No map results found for "quiet restaurant"')).toBeNull()
  })

  it('returns null on garbage and empty text', () => {
    expect(pickMapRecommendation('Maps search unavailable right now.')).toBeNull()
    expect(pickMapRecommendation('just some chatter\nwith no places')).toBeNull()
    expect(pickMapRecommendation('')).toBeNull()
  })
})

describe('purchase draft', () => {
  it('parses a purchase action with amount and https url', () => {
    const d = parseExtractedWrite(JSON.stringify({
      action: 'purchase', item: '5lb jasmine rice', amount: 24.99, url: 'https://www.amazon.com/dp/B0XYZ',
    }))
    expect(d).toMatchObject({ type: 'purchase', item: '5lb jasmine rice', amount: 24.99, url: 'https://www.amazon.com/dp/B0XYZ' })
  })
  it('rejects non-https urls and invented/zero prices', () => {
    expect(parseExtractedWrite(JSON.stringify({ action: 'purchase', item: 'x', amount: 5, url: 'http://evil.com' }))).toBeNull()
    expect(parseExtractedWrite(JSON.stringify({ action: 'purchase', item: 'x', amount: 0, url: 'https://a.com' }))).toBeNull()
    expect(parseExtractedWrite(JSON.stringify({ action: 'purchase', item: 'x', amount: 'lots', url: 'https://a.com' }))).toBeNull()
  })
  it('caps purchases above the self-serve limit', () => {
    const problem = validatePurchase({ type: 'purchase', item: 'macbook', amount: 2400, url: 'https://a.com' })
    expect(problem).toContain('cap')
    expect(validatePurchase({ type: 'purchase', item: 'rice', amount: 25, url: 'https://a.com' })).toBeNull()
  })
})

describe('browser task draft', () => {
  it('parses a browser action with portal and goal', () => {
    const d = parseExtractedWrite(JSON.stringify({
      action: 'browser', portal: 'https://www.opentable.com', goal: 'Book a table for 2 at Foreign Cinema Friday 8pm',
    }))
    expect(d).toMatchObject({ type: 'browser', portal: 'https://www.opentable.com' })
    expect((d as { goal: string }).goal).toContain('Foreign Cinema')
  })
  it('rejects non-https portals and empty goals', () => {
    expect(parseExtractedWrite(JSON.stringify({ action: 'browser', portal: 'opentable.com', goal: 'book a table' }))).toBeNull()
    expect(parseExtractedWrite(JSON.stringify({ action: 'browser', portal: 'https://x.com', goal: 'hi' }))).toBeNull()
  })
})
