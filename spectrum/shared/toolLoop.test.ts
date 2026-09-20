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
  isMerchantPortal,
  merchantSiteFromAsk,
  pickBrowserPortal,
  mapPlacesFromBlock,
  formatMapPicks,
  mapQueryForAsk,
  ACTION_ASK_RE,
  looksLikeCalendarBlockAsk,
  calendarBlockWhen,
  calendarBlockTitle,
  localWeekdayYmd,
  missingConnectorNote,
  isDeliberationOnly,
} from './toolLoop'
import { stayWindowFromAsk } from './stayWindow'
import { datesFromText } from '../../deploy/serpapi'

describe('calendar block ask (dim 8)', () => {
  it('recognises a real calendar write, not a scheduling question', () => {
    expect(looksLikeCalendarBlockAsk('put a 30-minute block on my calendar Thursday afternoon')).toBe(true)
    expect(looksLikeCalendarBlockAsk('Add "Q3 planning" to my Notion tasks, put a 30-minute block on my calendar Thursday afternoon, and Slack Sam that it is on.')).toBe(true)
    expect(looksLikeCalendarBlockAsk('hold 30 minutes on my calendar tomorrow afternoon')).toBe(true)
  })

  it('leaves scheduling questions and mail asks alone', () => {
    expect(looksLikeCalendarBlockAsk("what's on my calendar today?")).toBe(false)
    expect(looksLikeCalendarBlockAsk("reply to Sam's Thursday email and offer two slots")).toBe(false)
    expect(looksLikeCalendarBlockAsk('send an email to Dana about the meeting')).toBe(false)
  })

  it('resolves the named day and the part of day without guessing a clock time', () => {
    // 2026-09-17 is a Thursday; 18:00 UTC is 11:00 in Los Angeles.
    const thursdayNoonUtc = Date.parse('2026-09-17T18:00:00Z')
    const when = calendarBlockWhen('put a 30-minute block on my calendar Thursday afternoon', 'America/Los_Angeles', thursdayNoonUtc)
    expect(when.day).toBe('2026-09-17')
    expect(when.partOfDay).toBe('afternoon')
    expect(when.durationMin).toBe(30)
    const next = calendarBlockWhen('block 45 minutes on Friday morning', 'America/Los_Angeles', thursdayNoonUtc)
    expect(next.day).toBe('2026-09-18')
    expect(next.partOfDay).toBe('morning')
    expect(next.durationMin).toBe(45)
  })

  it('returns an empty day rather than inventing one when no day is named', () => {
    const when = calendarBlockWhen('put a block on my calendar tomorrow', 'America/Los_Angeles', Date.parse('2026-09-17T18:00:00Z'))
    expect(when.day).toBe('')
    expect(when.durationMin).toBe(30)
  })

  it('labels the next matching local weekday', () => {
    const thursdayNoonUtc = Date.parse('2026-09-17T18:00:00Z')
    expect(localWeekdayYmd(thursdayNoonUtc, 'America/Los_Angeles', 'thursday')).toBe('2026-09-17')
    expect(localWeekdayYmd(thursdayNoonUtc, 'America/Los_Angeles', 'friday')).toBe('2026-09-18')
    expect(localWeekdayYmd(thursdayNoonUtc, 'America/Los_Angeles', 'someday')).toBeNull()
  })

  it('takes the block title from the user words, never from the schedule', () => {
    expect(calendarBlockTitle('Add "Q3 planning" to my Notion tasks, put a 30-minute block on my calendar Thursday afternoon')).toBe('Q3 planning')
    expect(calendarBlockTitle('put a 30-minute block on my calendar Thursday afternoon')).toBe('Focus block')
  })

  it('names the connectors the ask needed and the user has not connected', () => {
    const ask = 'Add "Q3 planning" to my Notion tasks, put a 30-minute block on my calendar Thursday afternoon, and Slack Sam that it is on.'
    const note = missingConnectorNote(ask, ['gmail', 'calendar'])
    expect(note).toContain('Notion')
    expect(note).toContain('Slack')
    expect(note).not.toContain('Calendar')
    expect(missingConnectorNote(ask, ['notion', 'slack', 'calendar'])).toBe('')
  })
})

describe('browser run routing', () => {
  it('never sends a run at a directory or search surface', () => {
    // The engine used to issue a real browser run at whatever URL a search
    // returned — a live run was staged against a Yelp directory page, which
    // can never finish a booking.
    expect(pickBrowserPortal({ ask: 'book a hotel in Chicago', resultUrls: ['https://www.yelp.com/search?cflt=hotels', 'https://www.tripadvisor.com/Hotels-g35805'] })).toBeNull()
    expect(isMerchantPortal('https://www.yelp.com/search?x=1')).toBe(false)
    expect(isMerchantPortal('https://en.wikipedia.org/wiki/Hotel')).toBe(false)
  })

  it('prefers the merchant the user named over anything a search returned', () => {
    expect(pickBrowserPortal({ ask: 'reorder two bags of coffee from amazon', resultUrls: ['https://www.yelp.com/x'] })).toBe('https://www.amazon.com')
    expect(pickBrowserPortal({ ask: 'book a table on opentable', resultUrls: [] })).toBe('https://www.opentable.com')
  })

  it('never stages a run against our own app', () => {
    // Seen live: an app tweak ("add sound effects") was flagged needsBrowser,
    // the delivered build link was in the conversation, and the run picked it
    // as the portal — so Alpha asked the user to save their HireAlpha password
    // in the vault and drive a computer around the page they were texting about.
    expect(isMerchantPortal('https://hirealpha.chat/b/2a3319d4-acdc-48f2-a596-3a635124f0c6')).toBe(false)
    expect(isMerchantPortal('https://www.hirealpha.chat/app/vault-login?portal=https%3A%2F%2Fhirealpha.chat')).toBe(false)
    expect(isMerchantPortal('http://localhost:5173/b/x')).toBe(false)
    expect(pickBrowserPortal({ ask: 'add sound effects to the game', resultUrls: ['https://hirealpha.chat/b/2a3319d4'] })).toBeNull()
  })

  it('treats a rates ask as a booking ask, and a browse ask as maps-only', () => {
    // Map data has no prices, so a rates ask has to reach the real site or the
    // answer is an honest 'I could not verify prices' at best.
    expect(ACTION_ASK_RE.test('check the rates for hotels near the Burj Khalifa')).toBe(true)
    expect(ACTION_ASK_RE.test("what's the price for a hotel in the Loop")).toBe(true)
    expect(ACTION_ASK_RE.test('how much is a hotel near the Loop')).toBe(true)
    // Finding is not booking: the finder-only path stays on maps.
    expect(ACTION_ASK_RE.test('Find hotels near the Burj Khalifa')).toBe(false)
    expect(ACTION_ASK_RE.test('show me hotels near the Burj Khalifa')).toBe(false)
    expect(merchantSiteFromAsk('check rates on booking.com')).toBe('https://www.booking.com')
  })

  it('takes a real merchant page when the user named none', () => {
    expect(pickBrowserPortal({ ask: 'reorder the coffee beans', resultUrls: ['https://www.amazon.com/dp/B08XY'] })).toBe('https://www.amazon.com/dp/B08XY')
  })

  it('reads a check-in ask as an action on a site, not as chat', () => {
    // The scored chained task is worded exactly like this; without the action
    // verb the engine refused the run before any system was tried.
    expect(ACTION_ASK_RE.test("Check in for tomorrow's flight using the confirmation in email")).toBe(true)
    expect(ACTION_ASK_RE.test('check in on my Delta flight for tomorrow')).toBe(true)
    // Social check-ins are not site actions.
    expect(ACTION_ASK_RE.test('check in with me tomorrow morning')).toBe(false)
    expect(ACTION_ASK_RE.test('just checking in')).toBe(false)
  })
})

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

  it('exposes grounded web choices without inventing price or provenance', async () => {
    const observed: any[] = []
    const answers = [
      '{"action":"lookup","tool":"web","query":"coffee beans"}',
      'I found two current options.',
    ]
    await runToolConversation({
      messages: [{ role: 'user', content: 'Find me two coffee bean options.' }],
      availableTools: ['web'],
      canDraft: true,
      chat: async () => answers.shift() ?? 'I found two current options.',
      lookup: async () => [
        'Web search retrieved at 2026-09-15.\n- Alpha Roast — $18.50\n  https://shop.example.com/alpha\n  Washed Ethiopian beans\n- Beta Roast\n  https://beans.example.com/beta\n  Chocolate notes',
      ],
      propose: async () => ({ ok: false }),
      onResearchResults: (choices) => observed.push(...choices),
    })
    expect(observed).toHaveLength(2)
    expect(observed[0]).toMatchObject({
      title: 'Alpha Roast — $18.50', source_url: 'https://shop.example.com/alpha',
      reason: 'Washed Ethiopian beans', price_cents: 1850, currency: 'USD',
    })
    expect(observed[1].price_cents).toBeUndefined()
    expect(Date.parse(observed[0].freshness)).not.toBeNaN()
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
  it('rejects a directory or search page as the product url', () => {
    expect(validatePurchase({ type: 'purchase', item: 'coffee', amount: 15, url: 'https://en.wikipedia.org/wiki/Coffee' })).toContain('product page')
    expect(validatePurchase({ type: 'purchase', item: 'coffee', amount: 15, url: 'https://www.yelp.com/search?cflt=coffee' })).toContain('product page')
    expect(validatePurchase({ type: 'purchase', item: 'coffee', amount: 15, url: 'https://www.amazon.com/dp/B0XYZ' })).toBeNull()
  })
})

describe('browser run targeting', () => {
  it('accepts real merchant pages and rejects directories and search pages', () => {
    expect(isMerchantPortal('https://www.amazon.com/dp/B0XYZ')).toBe(true)
    expect(isMerchantPortal('https://www.amazon.com')).toBe(true)
    expect(isMerchantPortal('https://www.amazon.com/s?k=coffee')).toBe(false)
    expect(isMerchantPortal('https://www.yelp.com/search?cflt=coffee')).toBe(false)
    expect(isMerchantPortal('https://en.m.wikipedia.org/wiki/Coffee')).toBe(false)
    expect(isMerchantPortal('http://www.amazon.com')).toBe(false)
  })

  it('resolves the merchant the user named in their own words', () => {
    expect(merchantSiteFromAsk('Reorder two bags of the same coffee beans from Amazon using the home address.')).toBe('https://www.amazon.com')
    expect(merchantSiteFromAsk('book a table on OpenTable')).toBe('https://www.opentable.com')
    expect(merchantSiteFromAsk('find dinner near the Loop')).toBeNull()
  })

  it('prefers the named merchant and never picks a directory from results', () => {
    expect(pickBrowserPortal({ ask: 'Reorder coffee from Amazon', resultUrls: ['https://www.peets.com/coffee'] })).toBe('https://www.amazon.com')
    expect(pickBrowserPortal({ ask: 'buy me a coffee maker', resultUrls: ['https://www.yelp.com/search?cflt=coffee', 'https://en.wikipedia.org/wiki/Coffee'] })).toBeNull()
    expect(pickBrowserPortal({ ask: 'buy me a coffee maker', resultUrls: ['https://www.yelp.com/search?cflt=coffee', 'https://www.amazon.com/dp/B0XYZ'] })).toBe('https://www.amazon.com/dp/B0XYZ')
  })

  it('stages a run on the named merchant when the model only writes prose', async () => {
    const drafts: unknown[] = []
    const result = await runToolConversation({
      messages: [{ role: 'user', content: 'Reorder two bags of the same coffee beans from Amazon using the home address.' }],
      availableTools: ['web', 'maps'],
      canDraft: true,
      chat: async () => 'I do not have your past Amazon orders here, so I cannot pull the exact coffee from history. Send me the product link and I will set it up.',
      lookup: async () => [],
      propose: async (draft) => { drafts.push(draft); return { ok: true, id: 'job1' } },
    })
    expect(drafts).toHaveLength(1)
    expect(drafts[0]).toMatchObject({ type: 'browser', portal: 'https://www.amazon.com' })
    expect((drafts[0] as { goal?: string }).goal).toContain('home address')
    expect(result.reply).toContain('pause before payment')
    expect(result.reply).toContain('amazon.com')
  })

  it('stages a run on CampusNet when asked how much was paid and model writes refusal', async () => {
    const drafts: unknown[] = []
    const result = await runToolConversation({
      messages: [{ role: 'user', content: 'Can you tell me how much I paid in fall 2024 in campusnet' }],
      availableTools: ['web', 'maps'],
      canDraft: true,
      chat: async () => "I can't see inside your CampusNet account, that's locked behind your login. But I can walk you through it...",
      lookup: async () => [],
      propose: async (draft) => { drafts.push(draft); return { ok: true, id: 'job-campusnet-1' } },
    })
    expect(drafts).toHaveLength(1)
    expect(drafts[0]).toMatchObject({ type: 'browser', portal: 'https://campusnet.csuohio.edu' })
    expect(result.reply).not.toContain('locked behind your login')
    expect(result.reply).not.toContain("can't see inside")
    expect(result.reply).toContain('browser run is starting now')
  })

  it('replaces a model-guessed CampusNet hostname before saving the browser run', async () => {
    const drafts: unknown[] = []
    const answers = [
      '{"action":"browser","portal":"https://campusnet.com","goal":"Check Fall 2024 payment history"}',
      'The browser run is starting now.',
    ]
    await runToolConversation({
      messages: [{ role: 'user', content: 'Can you log in to CampusNet and check how much I paid for Fall 2024?' }],
      availableTools: ['web', 'maps'],
      canDraft: true,
      chat: async () => answers.shift() || 'Done.',
      lookup: async () => [],
      propose: async (draft) => { drafts.push(draft); return { ok: true, id: 'job-campusnet-canonical' } },
    })
    expect(drafts).toHaveLength(1)
    expect(drafts[0]).toMatchObject({ type: 'browser', portal: 'https://campusnet.csuohio.edu' })
  })

  it('stages the named merchant even when the provider returns nothing', async () => {
    const drafts: unknown[] = []
    const result = await runToolConversation({
      messages: [{ role: 'user', content: 'Reorder two bags of the same coffee beans from Amazon using the home address.' }],
      availableTools: ['web', 'maps'],
      canDraft: true,
      chat: async () => { throw new Error('provider down') },
      lookup: async () => [],
      propose: async (draft) => { drafts.push(draft); return { ok: true, id: 'job1' } },
    })
    expect(drafts).toHaveLength(1)
    expect(drafts[0]).toMatchObject({ type: 'browser', portal: 'https://www.amazon.com' })
    expect(result.reply).toContain('pause before payment')
  })

  it('never stages a run from directory-only search results', async () => {
    const drafts: unknown[] = []
    const answers = [
      '{"action":"lookup","tool":"web","query":"best coffee maker"}',
      'I could not find a real product page with a price, so I have not started anything. Give me a specific model and I will try again.',
    ]
    await runToolConversation({
      messages: [{ role: 'user', content: 'Buy me a coffee maker.' }],
      availableTools: ['web', 'maps'],
      canDraft: true,
      chat: async () => answers.shift() ?? 'I could not find a real product page to check out from, so nothing was started.',
      lookup: async () => ['Web search retrieved at 2026-01-01.\n- THE BEST 10 COFFEE MAKERS - Yelp\n  https://www.yelp.com/search?cflt=coffee\n  Directory listing'],
      propose: async (draft) => { drafts.push(draft); return { ok: true, id: 'job1' } },
    })
    expect(drafts).toHaveLength(0)
  })

  it('does not launch a run for a pure find-options ask', async () => {
    const drafts: unknown[] = []
    const result = await runToolConversation({
      messages: [{ role: 'user', content: 'Find me three good coffee bean options.' }],
      availableTools: ['web', 'maps'],
      canDraft: true,
      intent: { kind: 'request', request: { summary: 'Find coffee bean options', needsBrowser: true, needsLookup: false } },
      chat: async () => 'Here are three options worth comparing before you pick one.',
      lookup: async () => [],
      propose: async (draft) => { drafts.push(draft); return { ok: true, id: 'job1' } },
    })
    expect(drafts).toHaveLength(0)
    expect(result.reply).toContain('options')
  })

  it('refuses a model browser action aimed at a directory for a buying ask', async () => {
    const drafts: unknown[] = []
    await runToolConversation({
      messages: [{ role: 'user', content: 'Buy me a coffee maker.' }],
      availableTools: ['web', 'maps'],
      canDraft: true,
      chat: async () => '{"action":"browser","portal":"https://www.yelp.com/search?cflt=coffee","goal":"Add a coffee maker to the cart and go to checkout"}',
      lookup: async () => [],
      propose: async (draft) => { drafts.push(draft); return { ok: true, id: 'job1' } },
    })
    expect(drafts).toHaveLength(0)
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

describe('map-grounded place picks', () => {
  const MAP_BLOCK = [
    'Map results for "vegetarian restaurant near Chicago":',
    '- The Berghoff Restaurant (german) [vegetarian, confirmed] · ~4 min walk',
    '  https://www.openstreetmap.org/?mlat=41.8793&mlon=-87.6285#map=16/41.8793/-87.6285',
    '  17 West Adams Street',
    '- Eleven City Diner (diner) · ~12 min walk',
    '  https://www.openstreetmap.org/?mlat=41.8687&mlon=-87.6261#map=16/41.8687/-87.6261',
    '  1112 South Wabash Avenue',
    '- The Dearborn (american) [vegetarian, confirmed] · ~5 min walk',
    '  https://www.openstreetmap.org/?mlat=41.8845&mlon=-87.6299#map=16/41.8845/-87.6299',
    '  145 North Dearborn Street',
  ].join('\n')
  const ASK =
    'Find dinner for four tomorrow at 7:30 PM, walkable from the Loop in Chicago, vegetarian-friendly, not a chain, under $40 per person. Three options with why each fits.'

  it('parses places with cuisine, diet note, walk time, address, and link', () => {
    const places = mapPlacesFromBlock(MAP_BLOCK)
    expect(places).toHaveLength(3)
    expect(places[0]).toEqual({
      name: 'The Berghoff Restaurant',
      cuisine: 'german',
      note: 'vegetarian, confirmed',
      walk: '~4 min walk',
      link: 'https://www.openstreetmap.org/?mlat=41.8793&mlon=-87.6285#map=16/41.8793/-87.6285',
      address: '17 West Adams Street',
    })
  })

  it('formats picks with the reasons the map verifies and names what it cannot', () => {
    const out = formatMapPicks(MAP_BLOCK, ASK)
    expect(out).toContain('The Berghoff Restaurant')
    expect(out).toContain('17 West Adams Street')
    expect(out).toContain('~4 min walk')
    expect(out).toContain('vegetarian tagged on OSM')
    expect(out).toContain('under $40 per person')
    expect(out).toContain('no-chain constraint is unverified')
  })

  it('routes the engine maps query away from the constraint tail', () => {
    expect(mapQueryForAsk(ASK)).toBe('vegetarian restaurant near Chicago')
    expect(mapQueryForAsk('vegetarian restaurant Chicago Loop')).toBe('vegetarian restaurant near Chicago Loop')
    expect(mapQueryForAsk('good coffee near me')).toBe('coffee near me')
  })

  it('runs maps itself for a place ask and replaces an ungrounded memory answer', async () => {
    const lookups: string[] = []
    const result = await runToolConversation({
      messages: [{ role: 'user', content: ASK }],
      availableTools: ['maps', 'web'],
      canDraft: false,
      chat: async () => 'The Berghoff is great, mains $15-$25. The Dearborn around $20. The Chicago Diner $13-$20.',
      lookup: async (tool, query) => {
        lookups.push(`${tool}:${query}`)
        return tool === 'maps' ? [MAP_BLOCK] : ['Web search unavailable or returned no usable results.']
      },
      propose: async () => ({ ok: false }),
    })
    expect(lookups).toEqual(['maps:vegetarian restaurant near Chicago'])
    expect(result.reply).toContain('The Berghoff Restaurant')
    expect(result.reply).toContain('17 West Adams Street')
    expect(result.reply).not.toContain('$15')
    expect(result.reply).not.toContain('could not verify current information')
  })

  it('fetches maps alongside a web-first lookup so junk search results cannot win', async () => {
    const lookups: string[] = []
    const replies = [
      '{"action":"lookup","tool":"web","query":"best vegetarian restaurants Chicago Loop"}',
      'I could not verify anything live; here are leads: The Berghoff ($15-25), The Dearborn ($20-35), The Chicago Diner.',
    ]
    const result = await runToolConversation({
      messages: [{ role: 'user', content: ASK }],
      availableTools: ['maps', 'web'],
      canDraft: false,
      chat: async () => replies.shift() || 'no answer',
      lookup: async (tool, query) => {
        lookups.push(`${tool}:${query}`)
        return tool === 'maps'
          ? [MAP_BLOCK]
          : ['Web search unavailable or returned no usable results. No current facts were verified.']
      },
      propose: async () => ({ ok: false }),
    })
    expect(lookups).toContain('maps:vegetarian restaurant near Chicago')
    expect(result.reply).toContain('The Berghoff Restaurant')
    expect(result.reply).not.toContain('leads')
  })

  it('keeps the map picks when the answer model fails after the lookup', async () => {
    let calls = 0
    const result = await runToolConversation({
      messages: [{ role: 'user', content: ASK }],
      availableTools: ['maps'],
      canDraft: false,
      chat: async () => {
        if (calls++ === 0) return 'Here are three leads from memory.'
        throw new Error('model timeout')
      },
      lookup: async () => [MAP_BLOCK],
      propose: async () => ({ ok: false }),
    })
    expect(result.reply).toContain('The Berghoff Restaurant')
    expect(result.reply).toContain('~4 min walk')
    expect(result.reply).not.toContain('leads from memory')
  })

  it('keeps a model answer that names the verified places', async () => {
    const grounded =
      'Three from live maps: The Berghoff Restaurant (17 West Adams St, ~4 min), Eleven City Diner, and The Dearborn. Map data carries no menus, so the under $40 per person and 7:30 availability still need a call.'
    const result = await runToolConversation({
      messages: [{ role: 'user', content: ASK }],
      availableTools: ['maps'],
      canDraft: false,
      chat: async () => grounded,
      lookup: async () => [MAP_BLOCK],
      propose: async () => ({ ok: false }),
    })
    expect(result.reply).toBe(grounded)
  })
})

describe('dated travel booking asks (dims 1 and 2)', () => {
  const HOTEL_ASK =
    'Book a hotel in Chicago for Friday September 25 to Saturday September 26, under $250 a night, near the Loop, with free cancellation.'
  const HOTEL_BLOCK =
    'Live hotel rates for 2026-09-25 to 2026-09-26 in chicago (merged from six booking sources):\n' +
    '- The Wade: $199/night, 4-star, 8.2 rating, 2.2 km out, free-cancellation rate $199/night\n' +
    '- Homewood Suites by Hilton Chicago-Downtown: $182/night, 3-star, 1.8 km out, cancellation not stated\n' +
    'These are real rates for those nights. 14 of 132 show a free-cancellation rate below. All shown are at or under the $250/night ceiling.'
  const FLIGHT_ASK = 'Book a round trip from New York to Chicago Friday morning to Sunday evening, under $400.'
  const FARE_BLOCK =
    'Live fares from JFK,EWR,LGA to ORD,MDW: out 2026-09-25, back 2026-09-27 (read from the airline search page):\n' +
    '- $325, Delta Air Lines, nonstop, departs 06:55, on 2026-09-25\n' +
    '- $326, American, nonstop, departs 07:30, on 2026-09-25\n' +
    'Fares are what the page showed when it was read.'

  it('reads the live dated source before staging the booking run and keeps the real rate in the reply', async () => {
    const order: string[] = []
    const drafts: Array<Record<string, unknown>> = []
    const answers = [
      'The Kayak hotel run is launching now for Friday Sep 25 to Saturday Sep 26 near the Loop, under $250/night with free cancellation. I will report back with real options once it finishes.',
      '{"action":"browser","portal":"https://www.kayak.com/hotels","goal":"book a Chicago Loop hotel Sep 25-26 under $250 with free cancellation"}',
      'The run is live for the Loop stay, under $250/night with free cancellation. It pauses before payment.',
    ]
    const result = await runToolConversation({
      messages: [{ role: 'user', content: HOTEL_ASK }],
      availableTools: ['web', 'maps'],
      canDraft: true,
      chat: async () => answers.shift() || 'Done.',
      lookup: async (tool, query) => { order.push(`lookup:${tool}`); return [HOTEL_BLOCK] },
      propose: async (draft) => { order.push('propose'); drafts.push(draft as Record<string, unknown>); return { ok: true, id: 'job-hotel' } },
    })
    // The lookup must run before the run is staged, and it carries the ask
    // itself (dates + area + ceiling) — not a paraphrase.
    expect(order.indexOf('lookup:web')).toBeGreaterThanOrEqual(0)
    expect(order.indexOf('lookup:web')).toBeLessThan(order.indexOf('propose'))
    expect(drafts).toHaveLength(1)
    expect(drafts[0]).toMatchObject({ type: 'browser', portal: 'https://www.kayak.com/hotels' })
    // The reply carries the verified rate and the free-cancellation row.
    expect(result.reply).toContain('$199')
    expect(result.reply).toContain('free-cancellation')
  })

  it('reads the live source before staging a dated run the model issued first', async () => {
    const order: string[] = []
    const drafts: Array<Record<string, unknown>> = []
    const answers = [
      '{"action":"browser","portal":"https://www.kayak.com/flights","goal":"book the round trip under $400"}',
      'The run is live and pauses before payment.',
    ]
    const result = await runToolConversation({
      messages: [{ role: 'user', content: FLIGHT_ASK }],
      availableTools: ['web', 'maps'],
      canDraft: true,
      chat: async () => answers.shift() || 'Done.',
      lookup: async (tool, query) => { order.push(`lookup:${tool}`); return [FARE_BLOCK] },
      propose: async (draft) => { order.push('propose'); drafts.push(draft as Record<string, unknown>); return { ok: true, id: 'job-flight' } },
    })
    expect(drafts).toHaveLength(1)
    expect(order.indexOf('lookup:web')).toBeGreaterThanOrEqual(0)
    expect(order.indexOf('lookup:web')).toBeLessThan(order.indexOf('propose'))
    expect(result.reply).toContain('$325')
  })

  it('carries a standing seat preference into the model-issued booking run', async () => {
    const drafts: Array<Record<string, unknown>> = []
    const answers = [
      'The Kayak flight run is launching for the New York to Chicago round trip.',
      '{"action":"browser","portal":"https://www.kayak.com/flights","goal":"book the round trip under $400"}',
      'Run staged.',
    ]
    await runToolConversation({
      messages: [{ role: 'user', content: FLIGHT_ASK }],
      availableTools: ['web', 'maps'],
      canDraft: true,
      preferences: 'Aisle seats on all flights',
      chat: async () => answers.shift() || 'Done.',
      lookup: async () => [FARE_BLOCK],
      propose: async (draft) => { drafts.push(draft as Record<string, unknown>); return { ok: true, id: 'job-pref' } },
    })
    expect(drafts).toHaveLength(1)
    expect(String(drafts[0]!.goal)).toContain('Aisle seats on all flights')
  })

  it('never rides an unavailable notice or a listicle along as live options', async () => {
    const answers = [
      'The Kayak hotel run is launching now for the Loop stay.',
      '{"action":"browser","portal":"https://www.kayak.com/hotels","goal":"book the Loop hotel under $250"}',
      'The run is live; nothing is charged without approval.',
    ]
    const unavailable =
      'LIVE FARE/RATE SOURCE UNAVAILABLE for this ask (the dated sources returned nothing). The text below is a general web search, not verified availability or prices for these dates: do not present any figure from it as a fare or a rate.\n\n' +
      '- 10 Hotels In Chicago With Best Views\n  https://www.holidify.com/hotel-collections/hotels-in-chicago-with-best-views\n  The Loop 1.2 kms from Chicago $ 570 onwards Michigan Avenue'
    const result = await runToolConversation({
      messages: [{ role: 'user', content: HOTEL_ASK }],
      availableTools: ['web'],
      canDraft: true,
      chat: async () => answers.shift() || 'Done.',
      lookup: async () => [unavailable],
      propose: async () => ({ ok: true, id: 'job-nolive' }),
    })
    expect(result.reply).not.toContain('holidify')
    expect(result.reply).not.toContain('Live options for the dates')
    expect(result.reply).toContain('The run is live')
  })

  it('keeps a seat preference off a non-travel run', async () => {
    const drafts: Array<Record<string, unknown>> = []
    const ask = 'Reorder two bags of the same coffee beans from Amazon using the home address.'
    // The model's own action for a purchase must not gain the seat line...
    await runToolConversation({
      messages: [{ role: 'user', content: ask }],
      availableTools: ['web'],
      canDraft: true,
      preferences: 'Aisle seats on all flights',
      chat: async () => '{"action":"browser","portal":"https://www.amazon.com/gp/css/order-history","goal":"reorder the coffee beans, two bags, home address"}',
      lookup: async () => [],
      propose: async (draft) => { drafts.push(draft as Record<string, unknown>); return { ok: true, id: 'job-buy-2' } },
    })
    // ...and neither must the engine-staged goal.
    await runToolConversation({
      messages: [{ role: 'user', content: ask }],
      availableTools: ['web'],
      canDraft: true,
      preferences: 'Aisle seats on all flights',
      chat: async () => 'I do not have your Amazon order history here, so I cannot pull the exact item. Send me the product link and I will set it up.',
      lookup: async () => [],
      propose: async (draft) => { drafts.push(draft as Record<string, unknown>); return { ok: true, id: 'job-buy-3' } },
    })
    expect(drafts).toHaveLength(2)
    for (const draft of drafts) {
      expect(String(draft.goal)).not.toContain('Aisle')
      expect(String(draft.goal)).toContain('home address')
    }
  })

  it('keeps the buy ask\'s own constraints in the staged run goal', async () => {
    const drafts: Array<Record<string, unknown>> = []
    const ask =
      'Reorder a product on Amazon — the same coffee beans as last time, two bags, to the home address, confirm before charging, return the order confirmation.'
    await runToolConversation({
      messages: [{ role: 'user', content: ask }],
      availableTools: ['web'],
      canDraft: true,
      chat: async () => 'Locked. Everything is ready as soon as you are signed in.',
      lookup: async () => [],
      propose: async (draft) => { drafts.push(draft as Record<string, unknown>); return { ok: true, id: 'job-buy' } },
    })
    expect(drafts).toHaveLength(1)
    const goal = String(drafts[0]!.goal)
    expect(goal).toContain('two bags')
    expect(goal).toContain('home address')
    expect(goal).toContain('confirm before charging')
  })

  it('does not send a check-in ask to the fare search', async () => {
    const lookups: string[] = []
    const drafts: Array<Record<string, unknown>> = []
    await runToolConversation({
      messages: [{ role: 'user', content: "Check in for tomorrow's flight using the confirmation in my email and the passport information in my Drive." }],
      availableTools: ['web', 'gmail', 'drive'],
      canDraft: true,
      chat: async () => '{"action":"browser","portal":"https://www.delta.com/checkin","goal":"check in for tomorrow flight with the confirmation code"}',
      lookup: async (tool, query) => { lookups.push(`${tool}:${query}`); return [] },
      propose: async (draft) => { drafts.push(draft as Record<string, unknown>); return { ok: true, id: 'job-checkin' } },
    })
    expect(lookups.filter((entry) => entry.startsWith('web:'))).toHaveLength(0)
    expect(drafts).toHaveLength(1)
    expect(drafts[0]).toMatchObject({ portal: 'https://www.delta.com/checkin' })
  })
})

describe('a travel lookup waits for the classified trip', () => {
  /* The classifier resolves asynchronously and the lookup used to read the
   * resolved trip the instant it ran. On a casually-worded search ("gotta be in
   * chicago tuesday morning... flying out of sf") the lookup could therefore
   * leave with no airports and no dates, the server fell back to parsing the
   * sentence, and the reply said the dated sources came back empty — while the
   * same ask with the trip attached priced fine. */
  it('carries the trip into a lookup that fires before the classifier settles', async () => {
    const seen: unknown[] = []
    let resolveIntent: (value: unknown) => void = () => {}
    const intent = new Promise((resolve) => { resolveIntent = resolve })
    // The classifier answers only after the turn has already started.
    setTimeout(() => {
      resolveIntent({
        kind: 'request',
        request: {
          summary: 'flight SFO to Chicago Tuesday morning',
          needsBrowser: false,
          needsLookup: true,
          travel: { kind: 'flight', from: 'SFO', to: 'ORD', checkin: '2026-09-22' },
        },
      })
    }, 60)

    await runToolConversation({
      messages: [{ role: 'user', content: 'gotta be in chicago tuesday morning, flying out of sf. can you find me a flight?' }],
      availableTools: ['web'],
      canDraft: false,
      intent: intent as never,
      chat: async () => '{"action":"lookup","tool":"web","query":"flights from sf to chicago tuesday"}',
      lookup: async (_tool, _query, travel) => { seen.push(travel); return ['Live fares from SFO to ORD on 2026-09-22'] },
      propose: async () => ({ ok: false }),
    })

    expect(seen.length).toBeGreaterThan(0)
    for (const travel of seen) {
      expect(travel).toMatchObject({ kind: 'flight', from: 'SFO', to: 'ORD', checkin: '2026-09-22' })
    }
  })
})

describe('a travel lookup prices the window the engine resolved', () => {
  /* Live, 2026-09-19: "flights austin to boston next thursday coming back
   * sunday, aisle seat, keep it under 550 round trip" left the model's own
   * lookup carrying the raw words, and the server's relative-date reader took
   * "next thursday" a week further out than the engine's window helper — the
   * reply priced Oct 1/Oct 4 while the booking goal carried Sep 24/27. The
   * fares on screen were for dates the run would never book. One resolver
   * decides the trip; every lookup this turn prices that trip. */
  it('appends the resolved dates to a travel lookup that names no calendar date', async () => {
    const queries: string[] = []
    const ask = 'flights austin to boston next thursday coming back sunday, aisle seat, keep it under 550 round trip'
    const window = stayWindowFromAsk(ask)!
    expect(window).toBeTruthy()
    await runToolConversation({
      messages: [{ role: 'user', content: ask }],
      availableTools: ['web'],
      canDraft: false,
      chat: async () => '{"action":"lookup","tool":"web","query":"flights austin to boston next thursday coming back sunday aisle seat under 550"}',
      lookup: async (_tool, query) => { queries.push(query); return ['Live fares from AUS to BOS on 2026-09-24'] },
      propose: async () => ({ ok: false }),
    })
    expect(queries.length).toBeGreaterThan(0)
    for (const query of queries) {
      // What the fare source will resolve: the engine's own window, not a
      // second reading of "next thursday".
      expect(datesFromText(query)).toEqual([window.checkIn, window.checkOut])
    }
  })

  it('leaves an ask that names its own calendar date alone', async () => {
    const queries: string[] = []
    const ask = 'flights austin to boston sep 24 back sep 27, aisle seat'
    await runToolConversation({
      messages: [{ role: 'user', content: ask }],
      availableTools: ['web'],
      canDraft: false,
      chat: async () => '{"action":"lookup","tool":"web","query":"flights austin to boston sep 24 back sep 27 aisle seat"}',
      lookup: async (_tool, query) => { queries.push(query); return ['Live fares from AUS to BOS on 2026-09-24'] },
      propose: async () => ({ ok: false }),
    })
    expect(queries.length).toBeGreaterThan(0)
    for (const query of queries) expect(query).not.toContain(' from 2026-')
  })
})

describe('money never moves on a search', () => {
  /* Live, 2026-09-19: "what flights get me to chicago tuesday morning from sf?"
   * was answered with a payment link and no itinerary — real $186 Frontier
   * fare, but the founder never got to see the flight he was being asked to
   * pay for. A search presents the options and asks; a payment request follows
   * an ask to book, and nothing else. */
  const purchaseDraft = '{"action":"purchase","item":"Frontier flight SFO to ORD, 22 Sep","amount":186,"url":"https://www.flyfrontier.com/booking/abc123"}'

  it('blocks a payment request for an ask that only asked what is available', async () => {
    const drafts: Array<Record<string, unknown>> = []
    await runToolConversation({
      messages: [{ role: 'user', content: 'what flights get me to chicago tuesday morning from sf?' }],
      availableTools: ['web'],
      canDraft: true,
      chat: async () => purchaseDraft,
      lookup: async () => ['Live fares from SFO to ORD on 2026-09-22: $186 Frontier, 1 stop, departs 19:11, arrives 05:38.'],
      propose: async (draft) => { drafts.push(draft as Record<string, unknown>); return { ok: true, id: 'job-1' } },
    })
    expect(drafts.filter((d) => d.type === 'purchase')).toHaveLength(0)
  })

  it('lets the payment request through once they ask to book', async () => {
    const drafts: Array<Record<string, unknown>> = []
    await runToolConversation({
      messages: [{ role: 'user', content: 'book the $186 Frontier flight to chicago on tuesday' }],
      availableTools: ['web'],
      canDraft: true,
      chat: async () => purchaseDraft,
      lookup: async () => ['Live fares from SFO to ORD on 2026-09-22: $186 Frontier, 1 stop, departs 19:11, arrives 05:38.'],
      propose: async (draft) => { drafts.push(draft as Record<string, unknown>); return { ok: true, id: 'job-2' } },
    })
    expect(drafts.filter((d) => d.type === 'purchase')).toHaveLength(1)
  })
})

describe('a stated preference is not a booking ask', () => {
  /* Live, 2026-09-19: "for the record: no red-eyes when you book me flights"
   * started a Kayak run on a route read out of the thread and answered with a
   * Cloud Computer link, and "note for later: i prefer morning departures
   * before 9am when you book flights" did the same an hour earlier. Both carry
   * the words the booking path keys on and neither asks for anything. */
  it('never stages a travel run for a preference sentence', async () => {
    const prompts: string[] = []
    const lookups: string[] = []
    for (const ask of [
      'for the record: no red-eyes when you book me flights',
      'note for later: i prefer morning departures before 9am when you book flights',
    ]) {
      const result = await runToolConversation({
        messages: [{ role: 'user', content: ask }],
        availableTools: ['web'],
        canDraft: true,
        chat: async (messages) => { prompts.push(JSON.stringify(messages)); return 'Saved — no red-eyes on anything I book for you.' },
        lookup: async (_tool, query) => { lookups.push(query); return ['Live fares from AUS to BOS on 2026-09-24'] },
        propose: async () => ({ ok: true, id: 'draft-should-not-exist' }),
      })
      expect(result.draft).toBeUndefined()
    }
    expect(lookups).toHaveLength(0)
  })

  it('still stages a real booking ask that carries a preference', async () => {
    const drafts: Array<Record<string, unknown>> = []
    const answers = [
      '{"action":"browser","portal":"https://www.kayak.com/flights","goal":"book a round trip AUS to DEN Friday morning, aisle seat"}',
      'The run is live on Kayak for Friday morning. It pauses before payment.',
    ]
    await runToolConversation({
      messages: [{ role: 'user', content: 'book me a round trip to denver friday, i prefer the morning one' }],
      availableTools: ['web'],
      canDraft: true,
      chat: async () => answers.shift() || 'Done.',
      lookup: async () => ['Live fares from AUS to DEN on 2026-09-24'],
      propose: async (draft) => { drafts.push(draft as Record<string, unknown>); return { ok: true, id: 'draft-1' } },
    })
    expect(drafts).toHaveLength(1)
    expect(drafts[0]).toMatchObject({ type: 'browser', portal: 'https://www.kayak.com/flights' })
  })
})

describe('an access question is answered from context, never a lookup', () => {
  /* Live head-to-head, 2026-09-19: "quick check - what do you actually have
   * access to on my accounts right now, and how do i lock any of it down?" was
   * forced into a fresh lookup and died on "I could not verify current
   * information because the web lookup did not run. Please try again." — a
   * dropped turn on a question whose whole answer is local, while the same ask
   * answered by hand listed every connection and four ways to revoke. */
  it('never forces a web lookup for it, and never the canned failure', async () => {
    const lookups: string[] = []
    const result = await runToolConversation({
      messages: [{ role: 'user', content: 'quick check - what do you actually have access to on my accounts right now, and how do i lock any of it down?' }],
      availableTools: ['web', 'gmail', 'calendar'],
      canDraft: false,
      chat: async () => 'Connected: Gmail and Calendar. Not connected: Drive, Notion, Slack. To lock it down: tell me to disconnect, or revoke at the provider.',
      lookup: async (_tool, query) => { lookups.push(query); return ['should not run'] },
      propose: async () => ({ ok: false }),
    })
    expect(lookups).toHaveLength(0)
    expect(result.reply).not.toContain('web lookup did not run')
    expect(result.reply).toContain('Connected')
  })
})

describe('a question about buying is not a purchase', () => {
  /* Live, 2026-09-19, on the real line: "quick one - what home address and what
   * saved logins do you have on file for me right now? were about to test an
   * amazon reorder and i want to know what you already have" came back as
   * "Everything's ready to go the second you're signed into Amazon, I'll run:
   * 'quick one, what home address…'" with a Vault card attached — a queued run
   * whose goal was the question, and no answer. */
  it('never stages a purchase run for an informational question', async () => {
    const drafts: unknown[] = []
    const result = await runToolConversation({
      messages: [{ role: 'user', content: 'quick one - what home address and what saved logins do you have on file for me right now? were about to test an amazon reorder and i want to know what you already have' }],
      availableTools: ['web'],
      canDraft: true,
      chat: async () => 'No home address is saved, and the Vault has no Amazon entry yet.',
      lookup: async () => ['https://www.amazon.com/dp/B0EXAMPLE two bags'],
      propose: async (draft) => { drafts.push(draft); return { ok: true, id: 'draft-1' } },
    })
    expect(drafts).toHaveLength(0)
    expect(result.reply).toContain('No home address is saved')
  })

  it('still stages a real order when the ask is one', async () => {
    const drafts: Array<Record<string, unknown>> = []
    const answers = [
      '{"action":"browser","portal":"https://www.amazon.com/dp/B0EXAMPLE","goal":"order two bags of the same coffee beans and ship to the saved home address"}',
      'The order run is live on Amazon. It pauses before payment.',
    ]
    await runToolConversation({
      messages: [{ role: 'user', content: 'reorder two bags of the same coffee beans from amazon, ship to my home address' }],
      availableTools: ['web'],
      canDraft: true,
      chat: async () => answers.shift() || 'Done.',
      lookup: async () => ['https://www.amazon.com/dp/B0EXAMPLE two bags'],
      propose: async (draft) => { drafts.push(draft as Record<string, unknown>); return { ok: true, id: 'draft-1' } },
    })
    expect(drafts).toHaveLength(1)
    expect(drafts[0]).toMatchObject({ type: 'browser' })
  })
})

describe('an ask naming a connected service never launches a browser run', () => {
  /* Live, 2026-09-19: "put a note in my notion" answered with the connect link
   * AND "Launching Cloud Computer for this task" — a session against
   * notion.com, which can only hit a sign-in wall. Notion is used through its
   * connector; the connect link is the answer when it is not connected. */
  it('stages nothing and sends no run for a connector ask', async () => {
    for (const ask of [
      'put a note in my notion that the benchmark pass is done',
      'send a slack message to the team that i am running late',
    ]) {
      const drafts: unknown[] = []
      const result = await runToolConversation({
        messages: [{ role: 'user', content: ask }],
        availableTools: ['web'],
        canDraft: true,
        chat: async () => 'Notion is not connected yet: https://hirealpha.chat/app/hires/friend?connect=notion',
        lookup: async () => ['nothing'],
        propose: async (draft) => { drafts.push(draft); return { ok: true, id: 'd1' } },
      })
      expect(drafts).toHaveLength(0)
      expect(result.reply).not.toContain('Cloud Computer')
    }
  })
})

describe('a deliberation about not acting is not a reply', () => {
  /* Live, 2026-09-19, asked to list the vault logins: "nothing to run a browser
   * against, so I'm not sending a browser action for it." — the model's own
   * decision shipped as the answer, with nothing answered. */
  it('recognises it, and leaves real answers alone', () => {
    expect(isDeliberationOnly('nothing to run a browser against, so I am not sending a browser action for it.')).toBe(true)
    expect(isDeliberationOnly('I am not sending a browser action for that, but here are your vault logins: Kayak, X.')).toBe(false)
    expect(isDeliberationOnly('Your vault has CampusNet, Kayak and X saved. Want me to revoke one?')).toBe(false)
    expect(isDeliberationOnly('')).toBe(false)
  })
})
