import { describe, expect, test } from 'bun:test'
import { friendBriefModel, mailLabel } from './friendBriefModel'

describe('friend brief logic', () => {
  test('morning uses the scored reply queue, keeps receipts out, and never offers actions for text-only scans', () => {
    const model = friendBriefModel({
      needsYou: [
        { id: 'reply-a', label: 'Dinner · Maya', snippet: 'Book at 7?', score: 91, reasons: ['waiting_on_you'] },
        { id: 'reply-b', label: 'The contract · Priya', score: 70, reasons: ['deadline'] },
      ],
      mailGroups: [
        { kind: 'reply', label: 'Reply', count: 1, items: [{ id: 'text-0', label: 'Maybe reply · Unknown' }] },
        { kind: 'other', label: 'Updates', count: 1, items: [{ id: 'receipt', label: 'Receipt · Shop' }] },
      ],
    }, false)
    expect(model.mail.map(m => m.id)).toEqual(['reply-a', 'reply-b'])
    expect(model.otherMail.map(m => m.id)).toEqual(['text-0', 'receipt'])
  })

  test('attention highlights a real action once and does not promote unrelated mail above scored replies', () => {
    const model = friendBriefModel({
      attention: { id: 'receipt', label: 'Receipt · Shop', why: 'Recent purchase' },
      needsYou: [{ id: 'reply', label: 'Question · Maya', score: 85, reasons: ['waiting_on_you'] }],
      mailGroups: [{ kind: 'other', label: 'Other', count: 1, items: [{ id: 'receipt', label: 'Receipt · Shop' }] }],
    }, false)
    expect(model.mail.map(m => m.id)).toEqual(['reply'])
    expect(model.otherMail.map(m => m.id)).toEqual(['receipt'])
  })

  test('evening treats recent mail as recent; only reply-kind lead mail and reply groups need action', () => {
    const model = friendBriefModel({
      sections: [{
        heading: 'Mail today',
        items: ['Receipt · Shop', 'Dinner · Maya'],
        emailMeta: [
          { id: 'receipt', snippet: 'Paid', kind: 'delivery' },
          { id: 'dinner', snippet: 'Can you book?', kind: 'reply' },
        ],
      }],
      mailGroups: [
        { kind: 'reply', label: 'Reply', count: 1, items: [{ id: 'travel', label: 'Train · Alex' }] },
        { kind: 'other', label: 'Other', count: 1, items: [{ id: 'update', label: 'Update · Team' }] },
      ],
      carryOver: [{ id: 'task', title: 'Book a train' }],
    }, true)
    expect(model.mail.map(m => m.id)).toEqual(['travel', 'dinner'])
    expect(model.otherMail.map(m => m.id)).toEqual(['update', 'receipt'])
    expect(model.loops.map(l => l.id)).toEqual(['task'])
    expect(mailLabel(model.mail[1].label)).toEqual({ subject: 'Dinner', sender: 'Maya' })
  })

  test('older evening payloads without kind stay readable without becoming reply requests', () => {
    const model = friendBriefModel({ sections: [{ heading: 'Mail since this morning', items: ['Dinner · Maya'], emailMeta: [{ id: 'a', snippet: 'Book for seven?' }] }] }, true)
    expect(model.mail).toEqual([])
    expect(model.otherMail.map(m => m.id)).toEqual(['a'])
  })

  test('does not call a failed calendar empty or treat a placeholder as tomorrow plans', () => {
    const model = friendBriefModel({
      calendarStatus: 'auth_expired', mailStatus: 'timeout',
      sections: [{ heading: 'Tomorrow', items: ['Calendar authorization expired. Reconnect in Settings.'] }],
    }, true)
    expect(model.calendarFailed).toBe(true)
    expect(model.calendarKnown).toBe(true)
    expect(model.mailFailed).toBe(true)
    expect(model.tomorrow).toEqual([])
  })

  test('a cached meeting leaves the schedule after its start plus the in-progress hour', () => {
    const payload = { meetings: [{ title: 'Past', time: '8 AM', startsInMin: 10 }, { title: 'Next', time: '10 AM', startsInMin: 150 }] }
    expect(friendBriefModel(payload, false, 80).meetings.map(m => m.title)).toEqual(['Next'])
  })

  test('only actual activity is celebrated and only promises become open tasks', () => {
    const model = friendBriefModel({
      dayFacts: [
        { key: 'spend', label: 'Spent this week', detail: '$50', state: 'done' },
        { key: 'workout', label: 'Lifted', detail: 'One workout', state: 'done' },
        { key: 'mood', label: 'Mood not logged', detail: '', state: 'miss' },
      ],
      carryOver: [{ id: 'promise', title: 'Send photos' }],
      sections: [{ heading: 'Needs you', items: ['Call Maya at 7'] }],
    }, true)
    expect(model.wins.map(w => w.key)).toEqual(['workout'])
    expect(model.loops.map(l => l.id)).toEqual(['promise'])
    expect(model.tonightTasks).toEqual(['Call Maya at 7'])
  })
})
