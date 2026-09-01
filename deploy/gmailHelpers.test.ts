import { describe, expect, it } from 'bun:test'
import {
  extractGmailBody,
  fillDraftName,
  formatBriefPreview,
  formatComposioMailBlock,
  importantMailQuery,
  mailJudgePrompt,
  parseComposioMailBody,
  parseComposioMailItems,
  parseMailJudgeKeepIds,
  parseMailJudgeVerdicts,
  classifyBriefMail,
  groupBriefMail,
  groupMailByKind,
  cleanMailSnippet,
  isNoiseMail,
  mailHasDeadline,
  mailKindLabel,
  mailKindPhrase,
  mailTally,
  mailWaitingOnYou,
  normalizeMailKind,
  pickReplyTarget,
  replyAddress,
  replySubject,
  scoreMail,
  senderKey,
  snapMailKind,
  isSubstantiveReply,
  topNeedsYou,
  type GmailMimePart,
  type MailJudgeItem,
} from './gmailHelpers'

describe('fillDraftName', () => {
  it('replaces bracketed name placeholders with the sender', () => {
    expect(fillDraftName('Best regards,\n[Your Name]', 'Sashank')).toBe('Best regards,\nSashank')
    expect(fillDraftName('Thanks,\n[NAME]', 'Sashank Singh')).toBe('Thanks,\nSashank Singh')
    expect(fillDraftName('Cheers,\n[my name]', 'Maya')).toBe('Cheers,\nMaya')
  })

  it('catches a bare Your Name signoff line and leaves real text alone', () => {
    expect(fillDraftName('Best,\nYour Name', 'Sashank')).toBe('Best,\nSashank')
    expect(fillDraftName('No placeholder in this body.', 'Sashank')).toBe('No placeholder in this body.')
  })
})

describe('isSubstantiveReply', () => {
  const original =
    "Darwin and Sashank, you're booked and the calendar invite is on its way. Looking forward to the conversation."

  it('rejects empty and greeting-only output', () => {
    expect(isSubstantiveReply('')).toBe(false)
    expect(isSubstantiveReply('   \n  ')).toBe(false)
    expect(isSubstantiveReply('Hi boardy,')).toBe(false)
    expect(isSubstantiveReply('Hi boardy,\n\nok')).toBe(false)
    expect(isSubstantiveReply('Hello!')).toBe(false)
  })

  it('rejects a verbatim echo of the original email', () => {
    expect(isSubstantiveReply(original, original)).toBe(false)
  })

  it('accepts a real one-line reply even with a greeting', () => {
    expect(
      isSubstantiveReply('Hi boardy, happy to chat Monday at 9. The invite works on our end. Best, Sashank', original),
    ).toBe(true)
    expect(isSubstantiveReply('Thanks for the intro, Monday at 9 works for us. Best, Sashank')).toBe(true)
  })

  it('accepts a short confirm that carries real content', () => {
    expect(isSubstantiveReply('Thanks, will do. Best, Sashank')).toBe(true)
  })
})

describe('senderKey', () => {
  it('prefers the bare address inside angle brackets', () => {
    expect(senderKey('Amy Black <amy@x.com>')).toBe('amy@x.com')
  })

  it('lowercases a bare address and tolerates a name only', () => {
    expect(senderKey('BO@X.COM')).toBe('bo@x.com')
    expect(senderKey('Maya Chen')).toBe('maya chen')
    expect(senderKey('')).toBe('')
  })
})

describe('mailWaitingOnYou', () => {
  it('spots ask language in subject or snippet', () => {
    expect(mailWaitingOnYou({ subject: 'Can we move coffee to 3?', snippet: '' })).toBe(true)
    expect(mailWaitingOnYou({ subject: 'Quick one', snippet: 'Let me know when you are free' })).toBe(true)
    expect(mailWaitingOnYou({ subject: 'New message from Laura', snippet: '' })).toBe(true)
  })

  it('stays quiet on statements and receipts', () => {
    expect(mailWaitingOnYou({ subject: 'Your receipt', snippet: 'Payment received, thanks' })).toBe(false)
    expect(mailWaitingOnYou({ subject: 'Thank you for coffee', snippet: 'Really grateful' })).toBe(false)
  })
})

describe('mailHasDeadline', () => {
  it('finds dates and cutoffs', () => {
    expect(mailHasDeadline({ subject: 'Benefits enrollment closes Friday', snippet: '' })).toBe(true)
    expect(mailHasDeadline({ subject: 'RSVP for the offsite', snippet: '' })).toBe(true)
    expect(mailHasDeadline({ subject: 'Invoice', snippet: 'Payment due by tomorrow' })).toBe(true)
  })

  it('ignores plain conversation', () => {
    expect(mailHasDeadline({ subject: 'Coffee?', snippet: 'Sometime this week?' })).toBe(false)
  })
})

describe('scoreMail', () => {
  const base = { id: 'm1', from: 'Amy <amy@x.com>', subject: '', snippet: '' }

  it('starts cold and ranks an ask over a statement', () => {
    const quiet = scoreMail({ ...base, subject: 'Quarterly numbers attached' }, undefined)
    const ask = scoreMail({ ...base, subject: 'Can you review this today?' }, undefined)
    expect(ask.score).toBeGreaterThan(quiet.score)
    expect(ask.reasons).toContain('waiting_on_you')
  })

  it('boosts senders the user actually answers', () => {
    const cold = scoreMail({ ...base, subject: 'Notes from our call' }, undefined)
    const warm = scoreMail({ ...base, subject: 'Notes from our call' }, { replies: 2 })
    expect(warm.score - cold.score).toBeGreaterThanOrEqual(24)
    expect(warm.reasons).toContain('vip_sender')
  })

  it('caps the vip boost so one chatty sender cannot own the brief', () => {
    const warm = scoreMail({ ...base, kind: 'reply' }, { replies: 9 })
    expect(warm.score).toBeLessThanOrEqual(100)
  })

  it('buries a sender the user keeps skipping', () => {
    const buried = scoreMail({ ...base, kind: 'other' }, { skips: 3 })
    // Below anything cold, even though it cannot go under zero by much.
    expect(buried.score).toBeLessThanOrEqual(5)
  })

  it('adds deadline pressure with a chip', () => {
    const scored = scoreMail(
      { ...base, subject: 'Enrollment closes Friday' },
      undefined,
    )
    expect(scored.reasons).toContain('deadline')
    expect(scored.score).toBeGreaterThan(55)
  })
})

describe('topNeedsYou', () => {
  const batch = [
    { id: 'a', from: 'A <a@x.com>', subject: 'Quarterly report attached', snippet: '', kind: 'other' },
    { id: 'b', from: 'B <b@x.com>', subject: 'Can you sign the lease today?', snippet: '', kind: 'reply' },
    { id: 'c', from: 'C <c@x.com>', subject: 'Newsletter', snippet: 'unsubscribe anytime', kind: 'other' },
    { id: 'd', from: 'D <d@x.com>', subject: 'Invoice due tomorrow', snippet: '', kind: 'money' },
  ]
  const signals = new Map([
    ['a@x.com', { replies: 4 }],
  ])

  it('sorts by score and caps the list', () => {
    // d carries a deadline (78), b is a reply ask (65), so the invoice leads.
    const top = topNeedsYou(batch, () => undefined, 2)
    expect(top.map((m) => m.id)).toEqual(['d', 'b'])
  })

  it('lets sender history promote a plain mail into the leads', () => {
    // a scores 40 cold; four replies from this sender lift it over b's ask.
    const top = topNeedsYou(batch, (k) => signals.get(k), 3)
    expect(top[0]!.id).toBe('d')
    expect(top[1]!.id).toBe('a')
    expect(top.map((m) => m.id)).not.toContain('c')
  })

  it('returns an empty list for an empty inbox', () => {
    expect(topNeedsYou([], () => undefined)).toEqual([])
  })
})

describe('importantMailQuery', () => {
  it('fetches recent inbox minus spam, keeping Gmail tab categories', () => {
    const q = importantMailQuery('16h')
    expect(q).toContain('is:inbox')
    expect(q).toContain('-is:spam')
    expect(q).not.toContain('-category:promotions')
    expect(q).not.toContain('-category:social')
    expect(q).not.toContain('-category:forums')
    expect(q).toContain('newer_than:16h')
  })

  it('does NOT require Gmail important, starred, or Primary', () => {
    const q = importantMailQuery('2d')
    expect(q).not.toContain('is:important')
    expect(q).not.toContain('is:starred')
    expect(q).not.toContain('category:primary')
  })

  it('does NOT exclude category:updates', () => {
    expect(importantMailQuery('2d')).not.toContain('-category:updates')
  })

  it('includes the requested timespan', () => {
    expect(importantMailQuery('2d')).toContain('newer_than:2d')
    expect(importantMailQuery('12h')).toContain('newer_than:12h')
    expect(importantMailQuery('16h')).toContain('newer_than:16h')
  })

  it('does not use bare is:unread', () => {
    expect(importantMailQuery('2d')).not.toContain('is:unread')
  })
})

const sampleMail: MailJudgeItem[] = [
  {
    id: 'job-1',
    from: 'Jobright Job Alert',
    subject: 'JOB ID 12239: Software Engineer jobs you might like',
    snippet: 'New roles matched your profile',
  },
  {
    id: 'human-1',
    from: 'Amy Black <amy@example.com>',
    subject: 'Can we move coffee to 3',
    snippet: 'I am free after standup if that still works',
  },
  {
    id: 'li-jobs',
    from: 'LinkedIn Job Alerts',
    subject: 'AI Engineer at HockeyStack',
    snippet: 'Jobs you might like this week',
  },
]

describe('mail judge', () => {
  it('writes a judge prompt with from subject snippet, not a sender denylist', () => {
    const prompt = mailJudgePrompt(sampleMail)
    const instructions = prompt.slice(0, prompt.indexOf('1. From:'))
    expect(prompt).toContain('Amy Black')
    expect(prompt).toContain('Can we move coffee to 3')
    expect(prompt).toContain('I am free after standup')
    expect(instructions.toLowerCase()).not.toContain('jobright')
    expect(instructions.toLowerCase()).not.toContain('linkedin job')
    expect(instructions.toLowerCase()).not.toContain('regex')
    expect(instructions).not.toContain('is:starred')
    expect(instructions).not.toContain('is:important')
  })

  it('keeps only ids the model numbered as useful', () => {
    const keep = parseMailJudgeKeepIds('{"keep":[2]}', sampleMail)
    expect(keep).toEqual(['human-1'])
  })

  it('drops the whole batch when the model keeps none', () => {
    expect(parseMailJudgeKeepIds('{"keep":[]}', sampleMail)).toEqual([])
  })

  it('accepts raw gmail ids if the model returns them', () => {
    expect(parseMailJudgeKeepIds('{"keep":["human-1"]}', sampleMail)).toEqual(['human-1'])
  })

  it('ignores unknown numbers and junk json', () => {
    expect(parseMailJudgeKeepIds('{"keep":[99]}', sampleMail)).toEqual([])
    expect(parseMailJudgeKeepIds('not json', sampleMail)).toEqual([])
  })
})

describe('brief mail groups', () => {
  it('keeps a strawberry new message as to reply, not noise', () => {
    const m = {
      id: 's1',
      from: 'Strawberry.me Team <team@strawberry.me>',
      subject: 'You have a new message from Laura G. (PCC)',
      snippet: 'Laura sent you a note',
    }
    expect(isNoiseMail(m)).toBe(false)
    expect(classifyBriefMail(m)).toBe('reply')
  })

  it('buckets thanks, assessments, and human questions', () => {
    expect(
      classifyBriefMail({
        from: 'Maya Chen <maya@example.com>',
        subject: 'Thank you for coffee',
        snippet: 'Really grateful for yesterday',
      }),
    ).toBe('thanks')
    expect(
      classifyBriefMail({
        from: 'HackerRank <noreply@hackerrank.com>',
        subject: 'Complete your assessment',
        snippet: 'Your take home is waiting',
      }),
    ).toBe('assessment')
    expect(
      classifyBriefMail({
        from: 'Amy Black <amy@example.com>',
        subject: 'Can we move coffee to 3',
        snippet: 'Are you free after standup?',
      }),
    ).toBe('reply')
  })

  it('drops job alerts and counts the rest', () => {
    const groups = groupBriefMail([
      {
        id: '1',
        from: 'Amy Black <amy@example.com>',
        subject: 'Can we move coffee to 3',
        snippet: 'Are you free?',
      },
      {
        id: '2',
        from: 'Dan <dan@example.com>',
        subject: 'Thank you',
        snippet: 'Appreciate it',
      },
      {
        id: '3',
        from: 'HackerRank',
        subject: 'Complete your assessment',
        snippet: '',
      },
      {
        id: '4',
        from: 'LinkedIn Job Alerts',
        subject: 'AI Engineer at HockeyStack',
        snippet: 'Jobs you might like this week',
      },
    ])
    expect(mailTally(groups)).toBe('1 to reply  1 assessment  1 thanks')
    expect(groups.map((g) => g.kind)).toEqual(['reply', 'assessment', 'thanks'])
  })
})

describe('normalizeMailKind', () => {
  it('slugs a plain phrase', () => {
    expect(normalizeMailKind('Take Home')).toBe('take-home')
    expect(normalizeMailKind('  interview   ')).toBe('interview')
  })

  it('strips punctuation and emoji', () => {
    expect(normalizeMailKind('Invoice!!')).toBe('invoice')
    expect(normalizeMailKind('money 💸 note')).toBe('money-note')
  })

  it('singularises the last word only', () => {
    expect(normalizeMailKind('invoices')).toBe('invoice')
    expect(normalizeMailKind('take home tests')).toBe('take-home-test')
    expect(normalizeMailKind('replies')).toBe('reply')
    expect(normalizeMailKind('taxes')).toBe('tax')
    expect(normalizeMailKind('intros')).toBe('intro')
  })

  it('leaves words that only look plural', () => {
    expect(normalizeMailKind('thanks')).toBe('thanks')
    expect(normalizeMailKind('news')).toBe('news')
    expect(normalizeMailKind('status')).toBe('status')
    expect(normalizeMailKind('class')).toBe('class')
  })

  it('caps a sentence at three words and 24 chars, never mid-word', () => {
    const slug = normalizeMailKind('a recruiter reaching out about a role')
    // "a" names no pile, so it never takes one of the three slots.
    expect(slug).toBe('recruiter-reaching-out')
    expect(slug.length).toBeLessThanOrEqual(24)
    // Truncating by character would leave a fragment like "compensa".
    expect(normalizeMailKind('quarterly compensation review')).toBe('quarterly-compensation')
  })

  it('returns empty for garbage so the regex classifier takes over', () => {
    expect(normalizeMailKind('')).toBe('')
    expect(normalizeMailKind('   ')).toBe('')
    expect(normalizeMailKind('...')).toBe('')
    expect(normalizeMailKind('42')).toBe('')
    expect(normalizeMailKind('a')).toBe('')
  })

  it('rejects non-answers that name the medium, not the pile', () => {
    expect(normalizeMailKind('email')).toBe('')
    expect(normalizeMailKind('Emails')).toBe('')
    expect(normalizeMailKind('unknown')).toBe('')
    expect(normalizeMailKind('n/a')).toBe('')
  })
})

describe('snapMailKind', () => {
  it('reuses the exact label the user already has', () => {
    expect(snapMailKind('Interview', ['interview', 'invoice'])).toBe('interview')
  })

  it('folds a variant into the existing pile instead of seating a new one', () => {
    expect(snapMailKind('interview invite', ['interview'])).toBe('interview')
    expect(snapMailKind('invoice', ['invoice-due'])).toBe('invoice-due')
  })

  it('merges on a shared five-character stem', () => {
    expect(snapMailKind('scheduler', ['scheduling'])).toBe('scheduling')
  })

  it('does not merge on a short accidental overlap', () => {
    // "task" and "ask" share three characters; five is the floor for a reason.
    expect(snapMailKind('task', ['ask'])).toBe('task')
  })

  it('passes an unrelated kind through as new vocabulary', () => {
    expect(snapMailKind('landlord', ['interview', 'invoice'])).toBe('landlord')
  })

  it('is empty for garbage, whatever the vocabulary', () => {
    expect(snapMailKind('...', ['interview'])).toBe('')
  })

  it('tolerates a vocabulary that was stored unnormalised', () => {
    expect(snapMailKind('take home', ['Take Homes'])).toBe('take-home')
  })
})

describe('cleanMailSnippet', () => {
  it('decodes html entities a person would have typed', () => {
    expect(cleanMailSnippet("I&#39;ll get you submitted &#8212; done")).toBe("I'll get you submitted — done")
  })

  it('strips inline image refs and collapses whitespace', () => {
    expect(cleanMailSnippet('line one [cid:image001.png@01DD3184]\n\n  line  two ')).toBe('line one line two')
  })
})

describe('mailKindLabel and mailKindPhrase', () => {
  it('keeps the fixed kinds copy', () => {
    expect(mailKindLabel('reply')).toBe('To reply')
    expect(mailKindLabel('other')).toBe('More')
  })

  it('title-cases a generated slug', () => {
    expect(mailKindLabel('take-home')).toBe('Take home')
    expect(mailKindLabel('landlord')).toBe('Landlord')
  })

  it('phrases the fixed kinds the way they always read', () => {
    expect(mailKindPhrase('reply', 3)).toBe('3 to reply')
    expect(mailKindPhrase('assessment', 1)).toBe('1 assessment')
    expect(mailKindPhrase('assessment', 2)).toBe('2 assessments')
    expect(mailKindPhrase('thanks', 2)).toBe('2 thanks')
    expect(mailKindPhrase('money', 1)).toBe('1 money note')
    expect(mailKindPhrase('other', 4)).toBe('4 more')
  })

  it('pluralises a generated kind', () => {
    expect(mailKindPhrase('take-home', 1)).toBe('1 take home')
    expect(mailKindPhrase('take-home', 2)).toBe('2 take homes')
    expect(mailKindPhrase('tax', 2)).toBe('2 taxes')
  })
})

describe('groupMailByKind', () => {
  const judged = [
    { id: '1', from: 'Amy <amy@x.com>', subject: 'Coffee at 3?', snippet: '', kind: 'scheduling' },
    { id: '2', from: 'Bo <bo@x.com>', subject: 'Room for rent', snippet: '', kind: 'Landlord' },
    { id: '3', from: 'Cy <cy@x.com>', subject: 'Reschedule', snippet: '', kind: 'scheduling' },
  ]

  it('groups by the kinds the judge named', () => {
    const groups = groupMailByKind(judged)
    expect(groups.map((g) => g.kind)).toEqual(['scheduling', 'landlord'])
    expect(groups.map((g) => g.count)).toEqual([2, 1])
    expect(groups[0]!.label).toBe('Scheduling')
  })

  it('sorts by size, since self-naming kinds have no fixed order', () => {
    const groups = groupMailByKind([judged[1]!, judged[0]!, judged[2]!])
    expect(groups.map((g) => g.kind)).toEqual(['scheduling', 'landlord'])
  })

  it('breaks a size tie by which pile appeared first', () => {
    const groups = groupMailByKind([judged[1]!, judged[0]!])
    expect(groups.map((g) => g.kind)).toEqual(['landlord', 'scheduling'])
  })

  it('falls back to the regex kinds when the judge named nothing', () => {
    const groups = groupMailByKind([
      { id: '1', from: 'Amy <amy@x.com>', subject: 'Can we move coffee to 3', snippet: 'Are you free?' },
      { id: '2', from: 'HackerRank', subject: 'Complete your assessment', snippet: '' },
    ])
    expect(groups.map((g) => g.kind)).toEqual(['reply', 'assessment'])
  })

  it('mixes judged and unjudged items in one pass', () => {
    // This is the batch-cap case: the judge reached item 1 and not item 2.
    const groups = groupMailByKind([
      judged[0]!,
      { id: '9', from: 'HackerRank', subject: 'Complete your assessment', snippet: '' },
    ])
    expect(groups.map((g) => g.kind).sort()).toEqual(['assessment', 'scheduling'])
  })

  it('ignores a garbage kind rather than seating a pile for it', () => {
    const groups = groupMailByKind([
      { id: '1', from: 'HackerRank', subject: 'Complete your assessment', snippet: '', kind: 'email' },
    ])
    expect(groups.map((g) => g.kind)).toEqual(['assessment'])
  })

  it('seats a kind in the saved vocabulary so headers stop reshuffling', () => {
    const groups = groupMailByKind(
      [{ id: '1', from: 'Amy <amy@x.com>', subject: 'Invite', snippet: '', kind: 'interview invite' }],
      { vocab: ['interview'] },
    )
    expect(groups.map((g) => g.kind)).toEqual(['interview'])
  })

  it('drops noise before grouping', () => {
    const groups = groupMailByKind([
      { id: '1', from: 'LinkedIn Job Alerts', subject: 'AI Engineer', snippet: 'Jobs you might like', kind: 'job' },
      judged[1]!,
    ])
    expect(groups.map((g) => g.kind)).toEqual(['landlord'])
  })

  it('spills the tail into one More pile at the cap', () => {
    const groups = groupMailByKind(
      [
        { id: '1', from: 'a <a@x.com>', subject: 's', snippet: '', kind: 'alpha' },
        { id: '2', from: 'a <a@x.com>', subject: 's', snippet: '', kind: 'alpha' },
        { id: '3', from: 'b <b@x.com>', subject: 's', snippet: '', kind: 'bravo' },
        { id: '4', from: 'c <c@x.com>', subject: 's', snippet: '', kind: 'charlie' },
        { id: '5', from: 'd <d@x.com>', subject: 's', snippet: '', kind: 'delta' },
      ],
      { maxGroups: 3 },
    )
    expect(groups.map((g) => g.kind)).toEqual(['alpha', 'bravo', 'other'])
    expect(groups[2]!.count).toBe(2)
    expect(groups[2]!.label).toBe('More')
    // Nothing is lost to the cap.
    expect(groups.reduce((a, g) => a + g.count, 0)).toBe(5)
  })

  it('pins More last even when it is the biggest pile', () => {
    const groups = groupMailByKind([
      { id: '1', from: 'noreply@x.com', subject: 'Build passed', snippet: '' },
      { id: '2', from: 'noreply@x.com', subject: 'Build passed', snippet: '' },
      { id: '3', from: 'Amy <amy@x.com>', subject: 'Free at 3?', snippet: '' },
    ])
    expect(groups.map((g) => g.kind)).toEqual(['reply', 'other'])
    expect(groups[1]!.count).toBe(2)
  })

  it('is empty for an empty inbox', () => {
    expect(groupMailByKind([])).toEqual([])
  })

  it('tallies generated kinds', () => {
    expect(mailTally(groupMailByKind(judged))).toBe('2 schedulings  1 landlord')
  })
})

describe('parseMailJudgeVerdicts', () => {
  const items: MailJudgeItem[] = [
    { id: 'a', from: 'Amy', subject: 'One', snippet: '' },
    { id: 'b', from: 'Bo', subject: 'Two', snippet: '' },
    { id: 'c', from: 'Cy', subject: 'Three', snippet: '' },
  ]

  it('reads a keep and a kind per item', () => {
    const raw = '{"items":[{"i":1,"keep":true,"kind":"Take Home"},{"i":2,"keep":false,"kind":"newsletter"}]}'
    expect(parseMailJudgeVerdicts(raw, items)).toEqual([
      { id: 'a', keep: true, kind: 'take-home' },
      { id: 'b', keep: false, kind: 'newsletter' },
    ])
    expect(parseMailJudgeKeepIds(raw, items)).toEqual(['a'])
  })

  it('reads an optional promise and omits it when empty or missing', () => {
    const raw =
      '{"items":[{"i":1,"keep":true,"kind":"intro","promise":"Priya sends the specs by Friday"},{"i":2,"keep":false,"kind":"newsletter","promise":""},{"i":3,"keep":true,"kind":"scheduling"}]}'
    const verdicts = parseMailJudgeVerdicts(raw, items)
    expect(verdicts[0]?.promise).toBe('Priya sends the specs by Friday')
    expect(verdicts[1]?.promise).toBeUndefined()
    expect(verdicts[2]?.promise).toBeUndefined()
  })

  it('still reads the older keep-list shape', () => {
    expect(parseMailJudgeKeepIds('{"keep":[1,3]}', items)).toEqual(['a', 'c'])
    expect(parseMailJudgeVerdicts('{"keep":[2]}', items)).toEqual([{ id: 'b', keep: true, kind: '' }])
  })

  it('accepts raw ids and numeric strings', () => {
    expect(parseMailJudgeKeepIds('{"items":[{"id":"c","keep":true}]}', items)).toEqual(['c'])
    expect(parseMailJudgeKeepIds('{"items":[{"i":"2","keep":true}]}', items)).toEqual(['b'])
  })

  it('treats a listed item with no verdict as a keep', () => {
    expect(parseMailJudgeVerdicts('{"items":[{"i":1,"kind":"intro"}]}', items)).toEqual([
      { id: 'a', keep: true, kind: 'intro' },
    ])
  })

  it('reads keep:false however the model spells it', () => {
    const raw = '{"items":[{"i":1,"keep":"false"},{"i":2,"keep":0}]}'
    expect(parseMailJudgeVerdicts(raw, items).every((v) => !v.keep)).toBe(true)
  })

  it('ignores unknown numbers, junk rows, and unparseable json', () => {
    expect(parseMailJudgeVerdicts('{"items":[{"i":99,"keep":true}]}', items)).toEqual([])
    expect(parseMailJudgeVerdicts('{"items":[null,7]}', items)).toEqual([])
    expect(parseMailJudgeVerdicts('not json', items)).toEqual([])
    expect(parseMailJudgeVerdicts('{oops', items)).toEqual([])
  })

  it('recovers the JSON from narrated or fenced replies', () => {
    const narrated = 'Here is the verdict I would give:\n{"items":[{"i":1,"keep":true,"kind":"intro"}]}'
    expect(parseMailJudgeKeepIds(narrated, items)).toEqual(['a'])
    const fenced =
      '```json\n{"items":[{"i":2,"keep":true,"kind":"invoice","promise":"Bo pays the invoice"}]}\n```'
    expect(parseMailJudgeVerdicts(fenced, items)).toEqual([
      { id: 'b', keep: true, kind: 'invoice', promise: 'Bo pays the invoice' },
    ])
  })

  it('survives a closing brace inside a string and trailing commentary', () => {
    const raw =
      '{"items":[{"i":1,"keep":true,"kind":"intro","promise":"wants the notes } by Friday"}]} then I would also flag {"keep":[2]}'
    expect(parseMailJudgeVerdicts(raw, items)).toEqual([
      { id: 'a', keep: true, kind: 'intro', promise: 'wants the notes } by Friday' },
    ])
  })

  it('takes the first object when the model emits several', () => {
    const raw = '{"items":[{"i":1,"keep":true}]} and again {"items":[{"i":2,"keep":true}]}'
    expect(parseMailJudgeKeepIds(raw, items)).toEqual(['a'])
  })

  it('keeps one verdict per item when the model repeats itself', () => {
    const raw = '{"items":[{"i":1,"keep":true,"kind":"intro"},{"i":1,"keep":false,"kind":"promo"}]}'
    const out = parseMailJudgeVerdicts(raw, items)
    expect(out).toHaveLength(1)
    expect(out[0]!.kind).toBe('promo')
  })
})

describe('mailJudgePrompt with a vocabulary', () => {
  const items: MailJudgeItem[] = [{ id: 'a', from: 'Amy', subject: 'One', snippet: 'hi' }]

  it('asks for a kind per item in the items shape', () => {
    const p = mailJudgePrompt(items)
    expect(p).toContain('"items"')
    expect(p).toContain('"kind"')
    expect(p.toLowerCase()).toContain('what kind of mail')
  })

  it('offers saved labels without demanding them', () => {
    const p = mailJudgePrompt(items, ['take-home', 'landlord'])
    expect(p).toContain('take-home, landlord')
    expect(p).toContain('Only invent a new kind when none of them fit.')
  })

  it('says nothing about reuse on the first run', () => {
    expect(mailJudgePrompt(items, [])).not.toContain('Reuse one of these')
  })

  it('caps the offered vocabulary at twelve', () => {
    const vocab = Array.from({ length: 20 }, (_, i) => `kind${i}`)
    const p = mailJudgePrompt(items, vocab)
    expect(p).toContain('kind11')
    expect(p).not.toContain('kind12')
  })
})

describe('formatBriefPreview', () => {
  it('lists event labels and mail subjects, not a slogan', () => {
    const text = formatBriefPreview({
      calendar: ['12:30 PM · Amy Black · Google Meet'],
      emails: ['Can we move coffee to 3 · Amy Black'],
      tomorrow: ['9:00 AM · Standup · Google Meet'],
    })
    expect(text).toContain('Amy Black')
    expect(text).toContain('Can we move coffee to 3')
    expect(text).toContain('Tomorrow:')
    expect(text.toLowerCase()).not.toContain('your calendar, important mail')
  })

  it('uses the lead when the day is quiet', () => {
    const text = formatBriefPreview({ calendar: [], emails: [], lead: 'A quiet day so far' })
    expect(text).toBe('A quiet day so far')
    expect(text).not.toContain('Nothing on the calendar.')
    expect(text).not.toContain('No important mail')
  })
})

describe('extractGmailBody', () => {
  function b64(s: string): string {
    return Buffer.from(s).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '')
  }

  it('returns empty for undefined input', () => {
    expect(extractGmailBody(undefined)).toEqual({ text: '', html: '' })
  })

  it('extracts text/plain from a direct part', () => {
    const part: GmailMimePart = { mimeType: 'text/plain', body: { data: b64('Hello world') } }
    const result = extractGmailBody(part)
    expect(result.text).toBe('Hello world')
    expect(result.html).toBe('')
  })

  it('extracts text/html from a direct part', () => {
    const part: GmailMimePart = { mimeType: 'text/html', body: { data: b64('<p>Hello</p>') } }
    const result = extractGmailBody(part)
    expect(result.html).toBe('<p>Hello</p>')
    expect(result.text).toBe('')
  })

  it('recurses into multipart/alternative and picks both text and html', () => {
    const part: GmailMimePart = {
      mimeType: 'multipart/alternative',
      parts: [
        { mimeType: 'text/plain', body: { data: b64('Plain text') } },
        { mimeType: 'text/html', body: { data: b64('<p>Rich HTML</p>') } },
      ],
    }
    const result = extractGmailBody(part)
    expect(result.text).toBe('Plain text')
    expect(result.html).toBe('<p>Rich HTML</p>')
  })

  it('recurses into multipart/mixed containing multipart/alternative', () => {
    const part: GmailMimePart = {
      mimeType: 'multipart/mixed',
      parts: [
        {
          mimeType: 'multipart/alternative',
          parts: [
            { mimeType: 'text/plain', body: { data: b64('Nested plain') } },
            { mimeType: 'text/html', body: { data: b64('<b>Nested HTML</b>') } },
          ],
        },
      ],
    }
    const result = extractGmailBody(part)
    expect(result.text).toBe('Nested plain')
    expect(result.html).toBe('<b>Nested HTML</b>')
  })

  it('skips parts with no inline data (attachmentId only)', () => {
    const part: GmailMimePart = {
      mimeType: 'text/html',
      body: { attachmentId: 'some-attachment-id', size: 50000 },
    }
    const result = extractGmailBody(part)
    expect(result.html).toBe('')
    expect(result.text).toBe('')
  })

  it('returns snippet fallback hint: html preferred over plain', () => {
    const part: GmailMimePart = {
      mimeType: 'multipart/alternative',
      parts: [
        { mimeType: 'text/html', body: { data: b64('<p>HTML wins</p>') } },
        { mimeType: 'text/plain', body: { data: b64('Plain only') } },
      ],
    }
    const result = extractGmailBody(part)
    expect(result.html).toBe('<p>HTML wins</p>')
    expect(result.text).toBe('Plain only')
  })
})

describe('parseComposioMailItems', () => {
  it('reads the connector shape, keeping the message id', () => {
    const items = parseComposioMailItems({
      messages: [
        {
          messageId: '18f2ab',
          threadId: 't1',
          subject: 'Take home',
          sender: 'Amy <amy@x.com>',
          messageTimestamp: '2026-08-20T10:00:00Z',
          preview: { body: 'Here is the exercise' },
        },
      ],
    })
    expect(items).toEqual([
      {
        id: '18f2ab',
        from: 'Amy <amy@x.com>',
        subject: 'Take home',
        date: '2026-08-20T10:00:00Z',
        snippet: 'Here is the exercise',
      },
    ])
  })

  it('reads a bare array with the other field names', () => {
    const items = parseComposioMailItems([
      { id: 'a1', from: 'bo@x.com', subject: 'Invoice', internalDate: 1690000000, snippet: 'due friday' },
    ])
    expect(items[0]).toEqual({ id: 'a1', from: 'bo@x.com', subject: 'Invoice', date: '1690000000', snippet: 'due friday' })
  })

  it('digs the rows out of a wrapper', () => {
    const items = parseComposioMailItems({
      successful: true,
      data: { response_data: { messages: [{ message_id: 'z9', subject: 'Hi', from_email: 'cy@x.com' }] } },
    })
    expect(items.map((m) => m.id)).toEqual(['z9'])
  })

  it('keeps a row that has no id, so the text block still shows it', () => {
    // The caller filters these out for the openable list; the model still reads them.
    const items = parseComposioMailItems({ messages: [{ subject: 'No id here', sender: 'dee@x.com' }] })
    expect(items).toHaveLength(1)
    expect(items[0]!.id).toBe('')
  })

  it('collapses newlines in the snippet, since one message is one line', () => {
    const items = parseComposioMailItems([{ id: 'a', subject: 's', sender: 'e@x.com', snippet: 'two\nlines  here' }])
    expect(items[0]!.snippet).toBe('two lines here')
  })

  it('skips wrappers that are not messages', () => {
    expect(parseComposioMailItems({ messages: [] })).toEqual([])
    expect(parseComposioMailItems({ error: 'nope', successful: false })).toEqual([])
    expect(parseComposioMailItems(null)).toEqual([])
    expect(parseComposioMailItems('a string')).toEqual([])
    expect(parseComposioMailItems([{ threadId: 't', labelIds: ['INBOX'] }])).toEqual([])
  })

  it('survives a self-referential payload', () => {
    const loop: Record<string, unknown> = { subject: '' }
    loop.self = loop
    expect(() => parseComposioMailItems(loop)).not.toThrow()
  })

  it('is idempotent, so parsing an already parsed list changes nothing', () => {
    const once = parseComposioMailItems({ messages: [{ messageId: 'q1', subject: 'S', sender: 'a@x.com', snippet: 'p' }] })
    expect(parseComposioMailItems(once)).toEqual(once)
  })
})

describe('formatComposioMailBlock', () => {
  it('writes one line per message with the sender address stripped', () => {
    const block = formatComposioMailBlock([
      { id: '1', from: 'Amy <amy@x.com>', date: 'Aug 20', subject: 'Take home', snippet: 'the exercise' },
    ])
    expect(block).toBe('Important email:\n- Amy | Aug 20 | Take home | the exercise')
  })

  it('fills the gaps rather than writing undefined', () => {
    const block = formatComposioMailBlock([{ id: '', from: '', date: '', subject: '', snippet: '' }])
    expect(block).toBe('Important email:\n- ? | ? | (no subject) | ')
  })

  it('says so when nothing matched', () => {
    expect(formatComposioMailBlock([])).toBe('No emails matched the query.')
  })
})

describe('parseComposioMailBody', () => {
  function b64url(s: string): string {
    return Buffer.from(s).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '')
  }

  it('reads the body the connector returned', () => {
    const body = parseComposioMailBody(
      { messageId: 'm1', subject: 'Hello', sender: 'amy@x.com', messageText: 'The full text.' },
      'm1',
    )
    expect(body?.bodyText).toBe('The full text.')
    expect(body?.bodyHtml).toBe('')
    expect(body?.subject).toBe('Hello')
  })

  it('prefers explicit html when both are present', () => {
    const body = parseComposioMailBody({ id: 'm1', subject: 's', sender: 'a@x.com', messageText: 't', html: '<p>h</p>' }, 'm1')
    expect(body?.bodyText).toBe('t')
    expect(body?.bodyHtml).toBe('<p>h</p>')
  })

  it('walks a raw Gmail payload when there is no flat body', () => {
    const body = parseComposioMailBody(
      {
        messageId: 'm2',
        subject: 'Mime',
        sender: 'bo@x.com',
        payload: {
          mimeType: 'multipart/alternative',
          parts: [
            { mimeType: 'text/plain', body: { data: b64url('plain part') } },
            { mimeType: 'text/html', body: { data: b64url('<p>html part</p>') } },
          ],
        },
      },
      'm2',
    )
    expect(body?.bodyText).toBe('plain part')
    expect(body?.bodyHtml).toBe('<p>html part</p>')
  })

  it('falls back to the preview body', () => {
    const body = parseComposioMailBody({ messageId: 'm3', subject: 's', sender: 'a@x.com', preview: { body: 'just a preview' } }, 'm3')
    expect(body?.bodyText).toBe('just a preview')
  })

  it('picks the asked-for message out of a list', () => {
    const data = {
      messages: [
        { messageId: 'a', subject: 'A', sender: 'a@x.com', messageText: 'body a' },
        { messageId: 'b', subject: 'B', sender: 'b@x.com', messageText: 'body b' },
      ],
    }
    expect(parseComposioMailBody(data, 'b')?.bodyText).toBe('body b')
  })

  it('will not guess when the id is absent from a list of several', () => {
    const data = {
      messages: [
        { messageId: 'a', subject: 'A', sender: 'a@x.com', messageText: 'body a' },
        { messageId: 'b', subject: 'B', sender: 'b@x.com', messageText: 'body b' },
      ],
    }
    expect(parseComposioMailBody(data, 'zz')).toBeNull()
  })

  it('accepts a lone message as the answer to a by-id read', () => {
    // A by-id call returned this message by construction, even if the connector
    // left the id field out of its reply.
    const body = parseComposioMailBody({ subject: 'Only one', sender: 'a@x.com', messageText: 'here' }, 'wanted-id')
    expect(body?.id).toBe('wanted-id')
    expect(body?.bodyText).toBe('here')
  })

  it('is null when there is no message at all', () => {
    expect(parseComposioMailBody({ error: 'nope' }, 'm1')).toBeNull()
    expect(parseComposioMailBody(null)).toBeNull()
  })
})

describe('replyAddress', () => {
  it('pulls the address out of a display-name From line', () => {
    expect(replyAddress('Amy Smith <amy@example.com>')).toBe('amy@example.com')
    expect(replyAddress('  AMY@Example.COM ')).toBe('amy@example.com')
  })

  it('refuses anything a reply could not actually be sent to', () => {
    // senderKey happily returns these as an identity; a To: line cannot use them.
    expect(replyAddress('Amy Smith')).toBe('')
    expect(replyAddress('amy@localhost')).toBe('')
    expect(replyAddress('')).toBe('')
    expect(replyAddress('   ')).toBe('')
  })
})

describe('replySubject', () => {
  it('prefixes once and never twice', () => {
    expect(replySubject('Invoice 12')).toBe('Re: Invoice 12')
    expect(replySubject('Re: Invoice 12')).toBe('Re: Invoice 12')
    expect(replySubject('RE:Invoice 12')).toBe('RE:Invoice 12')
  })

  it('has something to say when the subject is missing', () => {
    expect(replySubject('')).toBe('Re: (no subject)')
    expect(replySubject('   ')).toBe('Re: (no subject)')
  })
})

describe('pickReplyTarget', () => {
  it('composes one target out of two partial reads', () => {
    // The real case this exists for: the by-id read returned headers with no
    // body, and the list row carried the snippet.
    const target = pickReplyTarget([
      { from: 'Amy <amy@example.com>', subject: 'Invoice 12' },
      { snippet: 'can you confirm the total' },
    ])
    expect(target).toEqual({
      toAddr: 'amy@example.com',
      subject: 'Re: Invoice 12',
      original: 'can you confirm the total',
    })
  })

  it('drafts from headers alone, with no body to quote', () => {
    expect(pickReplyTarget([{ from: 'amy@example.com', subject: 'Hi' }])).toEqual({
      toAddr: 'amy@example.com',
      subject: 'Re: Hi',
      original: '',
    })
  })

  it('skips reads with no usable address and keeps looking', () => {
    const target = pickReplyTarget([
      null,
      undefined,
      { from: 'Mailer Daemon', snippet: 'first body' },
      { from: 'amy@example.com', subject: 'Later' },
    ])
    expect(target?.toAddr).toBe('amy@example.com')
    // The body came from the earlier read even though its From was unusable.
    expect(target?.original).toBe('first body')
  })

  it('prefers bodyText over snippet within one read', () => {
    expect(
      pickReplyTarget([{ from: 'a@x.com', bodyText: 'the full text', snippet: 'the preview' }])?.original,
    ).toBe('the full text')
  })

  it('caps the quoted excerpt', () => {
    expect(pickReplyTarget([{ from: 'a@x.com', bodyText: 'x'.repeat(900) }])?.original.length).toBe(600)
  })

  it('is null only when no read carried an address', () => {
    expect(pickReplyTarget([])).toBeNull()
    expect(pickReplyTarget([null, undefined])).toBeNull()
    expect(pickReplyTarget([{ subject: 'Orphan', snippet: 'no sender' }])).toBeNull()
  })
})
