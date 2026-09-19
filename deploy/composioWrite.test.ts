import { describe, expect, it } from 'bun:test'
import { COMPOSIO_WRITE, writeConnector } from './composioPlugins'

/* The write specs are the only place a bot sentence can become a change in
 * someone else's workspace, so the shapes are pinned here rather than trusted
 * to the model's discretion. */
describe('write specs', () => {
  it('covers exactly the two services the Integrations dimension names', () => {
    expect(Object.keys(COMPOSIO_WRITE).sort()).toEqual(['notion', 'slack'])
    expect(writeConnector('notion')).toBe('notion')
    expect(writeConnector('gmail')).toBeNull()
    expect(writeConnector('linear')).toBeNull()
  })

  it('carries the provider-required fields each write cannot run without', () => {
    // Notion's tool schema: parent_id + title are required.
    expect(COMPOSIO_WRITE.notion!.needs.sort()).toEqual(['parent', 'title'])
    // Slack's: channel is required, and a post with no text is noise.
    expect(COMPOSIO_WRITE.slack!.needs.sort()).toEqual(['body', 'channel'])
  })

  it('sends the provider its own field names and clips oversized input', () => {
    const notion = COMPOSIO_WRITE.notion!.args({ title: 'x'.repeat(400), parent: 'db-123', body: 'b'.repeat(9000) })
    expect(notion.parent_id).toBe('db-123')
    expect(String(notion.title).length).toBe(200)
    expect(String(notion.content).length).toBe(4000)
    const slack = COMPOSIO_WRITE.slack!.args({ channel: 'C123', body: 'hi' })
    expect(slack.channel).toBe('C123')
    expect(slack.text).toBe('hi')
    expect(slack.mrkdwn).toBe(true)
  })

  it('omits the optional body instead of sending an empty one', () => {
    const notion = COMPOSIO_WRITE.notion!.args({ title: 'Review Q3', parent: 'db-1' })
    expect('content' in notion).toBe(false)
  })

  it('never words a failure as a success', () => {
    expect(COMPOSIO_WRITE.notion!.empty).toContain('nothing was created')
    expect(COMPOSIO_WRITE.slack!.empty).toContain('nothing was posted')
    expect(COMPOSIO_WRITE.notion!.done({ title: 'Review Q3' })).toContain('Review Q3')
  })
})
