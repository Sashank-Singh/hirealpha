import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { slackMentionText, linearAssignedText } from './hire-api'

const savedFetch = globalThis.fetch
beforeEach(() => {
  globalThis.fetch = (async () => new Response('', { status: 200 })) as typeof fetch
})
afterEach(() => {
  globalThis.fetch = savedFetch
})

describe('trigger nudge texts', () => {
  it('slack mention names the channel and strips the mention tag', () => {
    const text = slackMentionText({ channel: 'launch', text: '<@U123> can you review the deck?' })
    expect(text).toContain('#launch')
    expect(text).toContain('can you review the deck?')
    expect(text).not.toContain('<@U123>')
    expect(text).not.toContain(' - ')
  })
  it('slack mention survives a missing channel', () => {
    const text = slackMentionText({ channel: '', text: 'ping' })
    expect(text).toContain('ping')
    expect(text).not.toContain('in #')
  })
  it('linear text keeps the identifier and title', () => {
    const text = linearAssignedText({ identifier: 'ENG-42', title: 'Fix checkout race' })
    expect(text).toContain('ENG-42')
    expect(text).toContain('Fix checkout race')
  })
  it('linear text drops a redundant identifier', () => {
    const text = linearAssignedText({ identifier: 'Fix ch', title: 'Fix checkout race' })
    expect(text).not.toContain('Fix ch ')
    expect(text).toContain('Fix checkout race')
  })
})
