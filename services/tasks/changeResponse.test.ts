import { describe, expect, it } from 'bun:test'
import { detectChangeResponses } from './changeResponse'

const NOW = '2026-09-21T12:00:00.000Z'

describe('detectChangeResponses', () => {
  it('detects and ranks cancelled meetings, stale replies, and slipping issues', () => {
    const result = detectChangeResponses({
      now: NOW,
      calendars: [{
        id: 'cal-1', title: 'Investor call', startsAt: '2026-09-21T15:00:00Z',
        status: 'cancelled', previousStatus: 'confirmed', importance: 1,
      }],
      emails: [{
        threadId: 'mail-1', subject: 'Contract approval', sentAt: '2026-09-15T12:00:00Z',
        expectsReply: true, importance: 0.8,
      }],
      issues: [{
        id: 'ENG-42', title: 'Launch billing', dueAt: '2026-09-19T12:00:00Z',
        state: 'started', importance: 0.9,
      }],
    })

    expect(result.map((item) => item.kind)).toEqual([
      'calendar_cancelled', 'issue_slipping', 'email_unanswered',
    ])
    expect(result[0]?.proposedAction).toContain('revised day plan')
    expect(result[1]?.evidence).toContain('has passed')
    expect(result[2]?.reason).toContain('6 days')
  })

  it('does not react to old cancellations, answered mail, or healthy issues', () => {
    const result = detectChangeResponses({
      now: NOW,
      calendars: [
        { id: 'past', title: 'Past', startsAt: '2026-09-20T12:00:00Z', status: 'cancelled', previousStatus: 'confirmed' },
        { id: 'already', title: 'Already cancelled', startsAt: '2026-09-22T12:00:00Z', status: 'cancelled', previousStatus: 'cancelled' },
      ],
      emails: [
        { threadId: 'answered', subject: 'Answered', sentAt: '2026-09-15T12:00:00Z', lastInboundAt: '2026-09-16T12:00:00Z', expectsReply: true },
        { threadId: 'fyi', subject: 'FYI', sentAt: '2026-09-15T12:00:00Z', expectsReply: false },
      ],
      issues: [{ id: 'ok', title: 'On track', dueAt: '2026-09-23T12:00:00Z', state: 'started' }],
    })
    expect(result).toEqual([])
  })

  it('detects a due-date slip before the issue becomes overdue', () => {
    const [result] = detectChangeResponses({
      now: NOW,
      issues: [{
        id: 'ENG-9', title: 'Permissions', previousDueAt: '2026-09-22T12:00:00Z',
        dueAt: '2026-09-25T12:00:00Z', state: 'backlog', importance: 1,
      }],
    })
    expect(result?.kind).toBe('issue_slipping')
    expect(result?.reason).toContain('moved back by 3 days')
  })

  it('applies notification cost, preference threshold, stable ordering, and retry dedupe', () => {
    const email = {
      threadId: 'mail-2', subject: 'A reply', sentAt: '2026-09-15T12:00:00Z',
      expectsReply: true, importance: 0.7,
    }
    const key = `email:${email.threadId}:unanswered:${email.sentAt}`
    const result = detectChangeResponses({ now: NOW, emails: [email, email] }, {
      recentlyNotified: new Set([key]), minimumScore: 0,
    })
    expect(result).toHaveLength(1)
    expect(result[0]?.factors.interruptionCost).toBe(0.8)

    const suppressed = detectChangeResponses({ now: NOW, emails: [email] }, {
      affinity: { email_unanswered: 0 }, minimumScore: 50,
    })
    expect(suppressed).toEqual([])
  })

  it('ignores malformed provider timestamps without losing valid candidates', () => {
    const result = detectChangeResponses({
      now: NOW,
      calendars: [
        { id: 'bad', title: 'Bad row', startsAt: 'tomorrowish', status: 'cancelled', previousStatus: 'confirmed' },
        { id: 'good', title: 'Good row', startsAt: '2026-09-21T14:00:00Z', status: 'cancelled', previousStatus: 'confirmed' },
      ],
    })
    expect(result.map((item) => item.entityKey)).toEqual(['calendar:good:cancelled'])
    expect(() => detectChangeResponses({ now: 'eventually' })).toThrow('valid timestamp')
  })
})
