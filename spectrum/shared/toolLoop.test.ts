import { describe, expect, it } from 'bun:test'
import {
  matchTextPerson,
  parseDraftCall,
  parseToolCall,
  stripToolDirectives,
} from './toolLoop'

describe('tool loop directives', () => {
  it('parses a maps tool line', () => {
    const hit = parseToolCall('TOOL maps quiet restaurant in San Francisco\nHere is more')
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
