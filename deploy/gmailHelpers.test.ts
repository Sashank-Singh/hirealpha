import { describe, expect, it } from 'bun:test'
import {
  extractGmailBody,
  formatBriefPreview,
  importantMailQuery,
  mailJudgePrompt,
  parseMailJudgeKeepIds,
  type GmailMimePart,
  type MailJudgeItem,
} from './gmailHelpers'

describe('importantMailQuery', () => {
  it('fetches recent inbox minus promotions spam social forums', () => {
    const q = importantMailQuery('16h')
    expect(q).toContain('is:inbox')
    expect(q).toContain('-is:spam')
    expect(q).toContain('-category:promotions')
    expect(q).toContain('-category:social')
    expect(q).toContain('-category:forums')
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

  it('uses a clear empty mail line', () => {
    const text = formatBriefPreview({ calendar: [], emails: [] })
    expect(text).toContain('Nothing on the calendar.')
    expect(text).toContain('No important mail')
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
