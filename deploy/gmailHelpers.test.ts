import { describe, expect, it } from 'bun:test'
import { extractGmailBody, importantMailQuery, type GmailMimePart } from './gmailHelpers'

describe('importantMailQuery', () => {
  it('always requires is:important', () => {
    const q = importantMailQuery('2d')
    expect(q).toContain('is:important')
  })

  it('excludes all junk categories', () => {
    const q = importantMailQuery('16h')
    expect(q).toContain('-category:promotions')
    expect(q).toContain('-category:social')
    expect(q).toContain('-category:forums')
    expect(q).toContain('-category:updates')
    expect(q).toContain('-is:spam')
  })

  it('includes the requested timespan', () => {
    expect(importantMailQuery('2d')).toContain('newer_than:2d')
    expect(importantMailQuery('12h')).toContain('newer_than:12h')
    expect(importantMailQuery('16h')).toContain('newer_than:16h')
  })

  it('does not use bare is:unread (would include junk unread)', () => {
    const q = importantMailQuery('2d')
    // Must not have unread without also requiring important — the whole point of the filter
    expect(q).not.toContain('is:unread')
  })

  it('does not include category:primary (too broad)', () => {
    expect(importantMailQuery('2d')).not.toContain('category:primary')
  })

  it('includes is:inbox', () => {
    expect(importantMailQuery('2d')).toContain('is:inbox')
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
    // text is also available
    expect(result.text).toBe('Plain only')
  })
})
