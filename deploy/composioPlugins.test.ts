import { describe, expect, it } from 'bun:test'
import { COMPOSIO_READ, composioLooksFailed, formatComposioData } from './composioPlugins'

describe('composio plugin helpers', () => {
  it('covers every catalog connector except calendar (handled separately)', () => {
    expect(Object.keys(COMPOSIO_READ).sort()).toEqual(
      ['drive', 'figma', 'github', 'gmail', 'linear', 'maps', 'notion', 'slack', 'spotify', 'stripe'].sort(),
    )
  })

  it('renders nested slack-style items as lines', () => {
    const text = formatComposioData({
      messages: [
        { text: 'staging is down', permalink: 'https://slack.com/archives/1' },
        { text: 'shipped auth', user: 'jordan' },
      ],
    })
    expect(text).toContain('staging is down')
    expect(text).toContain('https://slack.com/archives/1')
  })

  it('treats tool failure copy as failed, not empty JSON', () => {
    expect(composioLooksFailed('Tool GMAIL_FETCH_EMAILS failed: 401')).toBe(true)
    expect(composioLooksFailed('Important email:\n- a@b.com | hi')).toBe(false)
  })
})
