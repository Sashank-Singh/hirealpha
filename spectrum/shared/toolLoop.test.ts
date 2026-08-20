import { describe, expect, it } from 'bun:test'
import {
  looksLikeEventWrite,
  looksLikeFollowUp,
  looksLikeMailWrite,
  matchPerson,
  matchTextPerson,
  parseDraftCall,
  parseExtractedWrite,
  parsePlannerTool,
  parseToolCall,
  pingMail,
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
