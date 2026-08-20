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
  parsePlannerTool,
  parseToolCall,
  pingMail,
  prepTarget,
  stripToolDirectives,
  wantsOperatorWrite,
} from './toolLoop'

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
