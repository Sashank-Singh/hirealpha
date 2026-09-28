import { describe, expect, test } from 'bun:test'
import { friendBriefModel, mailLabel } from './friendBriefModel'

describe('friend brief priorities', () => {
  test('keeps lower-priority mail out of the action queue and deduplicates real messages', () => {
    const model = friendBriefModel({ attention: { id: 'a', label: 'Dinner · Maya', why: 'A reply today' }, mailGroups: [
      { kind: 'reply', label: 'Reply', count: 1, items: [{ id: 'a', label: 'Dinner · Maya' }] },
      { kind: 'other', label: 'Receipts', count: 1, items: [{ id: 'b', label: 'Receipt · Shop' }] },
    ] }, false)
    expect(model.mail.map(m => m.id)).toEqual(['a'])
    expect(model.otherMail.map(m => m.id)).toEqual(['b'])
  })
  test('preserves evening subjects, senders, and ids instead of turning snippets or tasks into emails', () => {
    const model = friendBriefModel({ sections: [{ heading: 'Mail since this morning', items: ['Dinner · Maya'], emailMeta: [{ id: 'a', snippet: 'Book for seven?' }] }], carryOver: [{ id: 'task', title: 'Book a train' }] }, true)
    expect(model.mail).toEqual([{ id: 'a', label: 'Dinner · Maya', snippet: 'Book for seven?', reason: 'From today’s mail' }])
    expect(model.loops).toHaveLength(1)
    expect(mailLabel(model.mail[0].label)).toEqual({ subject: 'Dinner', sender: 'Maya' })
  })
  test('retains tomorrow, separates accomplishments from unfinished work, and drops past meetings', () => {
    const model = friendBriefModel({ sections: [{ heading: 'Tomorrow', items: ['9 AM · Coffee'] }], meetings: [{ title: 'Past', time: '8 AM', startsInMin: -30 }, { title: 'Next', time: '10 AM', startsInMin: 90 }], dayFacts: [{ key: 'a', label: 'Walk', detail: '', state: 'done' }, { key: 'b', label: 'Read', detail: '', state: 'miss' }] }, true)
    expect(model.tomorrow).toEqual(['9 AM · Coffee'])
    expect(model.meetings.map(m => m.title)).toEqual(['Next'])
    expect(model.wins.map(w => w.key)).toEqual(['a'])
    expect(model.unfinished.map(w => w.key)).toEqual(['b'])
  })
  test('keeps disconnected and empty states distinguishable', () => {
    expect(friendBriefModel({ calendarConnected: false }, false).calendarKnown).toBe(false)
    expect(friendBriefModel({}, false).mail).toEqual([])
  })
})
