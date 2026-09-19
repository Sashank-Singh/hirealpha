import { describe, expect, it } from 'bun:test'
import { groupTurnLine, groupTurnNote, isGroupSpace } from './groupChat'

describe('detecting a group thread', () => {
  it('trusts the provider type, never the member count', () => {
    expect(isGroupSpace('group')).toBe(true)
    expect(isGroupSpace('GROUP')).toBe(true)
    expect(isGroupSpace('dm')).toBe(false)
    expect(isGroupSpace(undefined)).toBe(false)
    // A DM that happens to carry an array is still a DM.
    expect(groupTurnNote({ spaceType: 'dm', members: [{ id: '+1' }, { id: '+2' }] })).toBeNull()
  })

  it('leaves the one-to-one path completely alone', () => {
    expect(groupTurnNote({ spaceType: undefined, speakerId: '+12163032166' })).toBeNull()
    expect(groupTurnNote({ spaceType: 'dm', speakerId: '+12163032166' })).toBeNull()
  })
})

describe('what a group turn carries', () => {
  const note = groupTurnNote({
    spaceType: 'group',
    members: [{ id: '+15550001111', name: 'Sam' }, { id: '+15550002222' }, { id: '+12163032166', name: 'Sashank' }],
    speakerId: '+15550001111',
    speakerName: 'Sam',
  })

  it('names the speaker and the size', () => {
    expect(note).toContain('Sam')
    expect(note).toContain('group of about 3')
    expect(note).toContain('Reply to the group')
  })

  /* The load-bearing clause: the account holder's private data must not leak
   * to the other members just because Alpha was added to a thread. */
  it('carries the privacy rule and the private-ask rule', () => {
    expect(note).toContain('never share the account holder')
    expect(note).toContain('direct message, not to the group')
  })

  it('falls back to the member list, then to the id, when no name is given', () => {
    const byMember = groupTurnNote({ spaceType: 'group', members: [{ id: '+15550001111', name: 'Sam' }], speakerId: '+15550001111' })
    expect(byMember).toContain('Sam')
    const bare = groupTurnNote({ spaceType: 'group', speakerId: '+15550001111' })
    expect(bare).toContain('+15550001111')
  })
})

describe('the line a group turn is stored as', () => {
  it('names the speaker so one thread does not read as one person', () => {
    expect(groupTurnLine('Sam', 'I can do Friday')).toBe('Sam: I can do Friday')
    expect(groupTurnLine('', 'any night works')).toBe('someone in the group: any night works')
    expect(groupTurnLine('  Sam  ', '  friday works  ')).toBe('Sam: friday works')
  })
})
