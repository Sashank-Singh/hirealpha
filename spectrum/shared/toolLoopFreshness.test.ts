import { describe, expect, test } from 'bun:test'
import { runToolConversation } from './toolLoop'
import { ClaimLedger } from './claimEvidence'

/** Mixed-source freshness regression: the guard used to REPLACE a grounded
 * answer with "I could not verify current information…" when one mandated
 * source had not run. It must now keep the grounded part and name only what
 * stays unverified. */
describe('freshness guard — grounded answers survive', () => {
  const calendarResult = ['BigCo interview — Tue Sep 29, 2:00 PM']

  function chatScript(script: string[]) {
    let call = 0
    return async () => script[Math.min(call++, script.length - 1)]!
  }

  test('calendar fact is preserved and only the un-run mailbox is flagged', async () => {
    const evidence = new ClaimLedger()
    const reply = await runToolConversation({
      messages: [
        { role: 'system', content: 'engine' },
        { role: 'user', content: 'any new email from dana@bigco.com today? what time is my calendar thing again?' },
      ],
      chat: chatScript([
        '{"action":"lookup","tool":"calendar","query":"start=2026-09-27T00:00:00-04:00 end=2026-09-29T23:59:59-04:00"}',
        'Your calendar shows the BigCo interview at 2 PM Tuesday.',
      ]),
      lookup: async (tool) => {
        if (tool === 'calendar') return calendarResult
        if (tool === 'gmail') return []
        return []
      },
      propose: async () => {
        throw new Error('no drafts expected in this test')
      },
      availableTools: ['calendar', 'gmail', 'web'],
      canDraft: false,
      evidence,
    })
    expect(reply.reply).toContain('2 PM')
    expect(reply.reply).not.toMatch(/could not verify current information/i)
    expect(reply.reply).toMatch(/inbox/i)
    // Evidence: the calendar read is real; the mailbox was never attempted.
    expect(evidence.hasKind('calendar_read', ['verified_success'])).toBe(true)
    expect(evidence.hasKind('mail_read', ['not_attempted'])).toBe(true)
    expect(evidence.hasAny('mail_read')).toBe(true)
  })

  test('a mail ask whose mailbox WAS read is answered without the guard', async () => {
    const evidence = new ClaimLedger()
    const reply = await runToolConversation({
      messages: [
        { role: 'system', content: 'engine' },
        { role: 'user', content: 'any new email from dana@bigco.com today?' },
      ],
      chat: chatScript([
        '{"action":"lookup","tool":"gmail","query":"from:dana@bigco.com newer_than:1d"}',
        'No new email from Dana today — the inbox search came back empty.',
      ]),
      lookup: async (tool) => (tool === 'gmail' ? [] : []),
      propose: async () => {
        throw new Error('no drafts expected in this test')
      },
      availableTools: ['calendar', 'gmail', 'web'],
      canDraft: false,
      evidence,
    })
    expect(reply.reply).toMatch(/No new email from Dana/)
    expect(evidence.hasKind('mail_read', ['verified_empty'])).toBe(true)
  })

  test('a real lookup failure is recorded as provider failure, not as not_attempted', async () => {
    const evidence = new ClaimLedger()
    await runToolConversation({
      messages: [
        { role: 'system', content: 'engine' },
        { role: 'user', content: 'any news about the acme deal today?' },
      ],
      chat: chatScript([
        '{"action":"lookup","tool":"web","query":"acme deal news"}',
        'Here is what I could check: nothing usable came back from the sources.',
      ]),
      lookup: async () => {
        throw new Error('provider connection refused')
      },
      propose: async () => {
        throw new Error('no drafts expected in this test')
      },
      availableTools: ['web'],
      canDraft: false,
      evidence,
    })
    expect(evidence.hasKind('web', ['provider_unavailable'])).toBe(true)
    expect(evidence.hasKind('web', ['not_attempted'])).toBe(false)
  })

  test('staged browser work lands in the ledger as active, receipt-less evidence', async () => {
    const evidence = new ClaimLedger()
    await runToolConversation({
      messages: [
        { role: 'system', content: 'engine' },
        { role: 'user', content: 'book the Hotel Zephyr in Denver for Oct 1-3' },
      ],
      chat: chatScript([
        'Booking it now.',
        '{"action":"browser","portal":"https://www.zephyrlodge.com","goal":"Book Hotel Zephyr Denver Oct 1-3"}',
      ]),
      lookup: async () => [],
      propose: async (draft) => ({ ok: true, id: 'job_9' }),
      availableTools: ['web', 'maps'],
      canDraft: true,
      evidence,
    })
    expect(evidence.activeWork().some((e) => e.domain === 'browser' && e.detail?.staged === true)).toBe(true)
  })
})
