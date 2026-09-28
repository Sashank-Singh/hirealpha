import { describe, expect, it } from 'bun:test'
import { classifyAwaiting, pickThreadMatch, type ThreadStateRow } from './mailState'

describe('classifyAwaiting — who owes the next move', () => {
  it('the user sending last means the other side owes the reply', () => {
    expect(classifyAwaiting('me@x.com', 'sam@acme.co', 'me@x.com')).toBe('them')
    expect(classifyAwaiting('me@x.com', 'sam@acme.co', 'My Name <me@x.com>')).toBe('them')
  })

  it('the participant sending last means the user owes the reply', () => {
    expect(classifyAwaiting('me@x.com', 'sam@acme.co', 'Sam Rivera <sam@acme.co>')).toBe('me')
    expect(classifyAwaiting('me@x.com', 'Sam', 'Sam Rivera <sam@acme.co>')).toBe('me')
  })

  it('automated senders never flip the state', () => {
    expect(classifyAwaiting('me@x.com', 'sam@acme.co', 'no-reply@calendar.google.com')).toBe('none')
    expect(classifyAwaiting('me@x.com', 'sam@acme.co', 'mailer-daemon@x.com')).toBe('none')
  })

  it('any other non-automated sender counts as the other side', () => {
    expect(classifyAwaiting('me@x.com', 'sam@acme.co', 'maya@other.co')).toBe('me')
  })
})

describe('pickThreadMatch', () => {
  const rows: ThreadStateRow[] = [
    { threadId: 't1', participant: 'sam@acme.co', subject: 'Deck', direction: 'outbound', awaiting: 'them', lastMessageId: 'm1', lastActivityAt: '2026-09-27T00:00:00Z' },
    { threadId: 't2', participant: 'Sarah Chen <sarah@x.com>', subject: 'Contract', direction: 'inbound', awaiting: 'me', lastMessageId: 'm2', lastActivityAt: '2026-09-26T00:00:00Z' },
  ]

  it('matches by address, then by a unique name fragment', () => {
    expect(pickThreadMatch(rows, 'sam@acme.co')?.threadId).toBe('t1')
    expect(pickThreadMatch(rows, 'sarah')?.threadId).toBe('t2')
  })

  it('refuses ambiguous or absent matches', () => {
    expect(pickThreadMatch(rows, '')).toBeNull()
    expect(pickThreadMatch(rows, 'nobody')).toBeNull()
  })
})
