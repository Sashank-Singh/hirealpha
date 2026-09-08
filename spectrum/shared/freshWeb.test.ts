import { expect, it } from 'bun:test'
import { runToolConversation } from './toolLoop'

it('requires web evidence after accepting an offer to check current news', async () => {
  const answers = ['I just checked: no event has been announced.', '{"action":"lookup","tool":"web","query":"Apple next event official"}', 'Here is the official event page: https://www.apple.com/apple-events/']
  const lookups: string[] = []
  await runToolConversation({
    messages: [{ role: 'user', content: 'When is the next Apple event?' }, { role: 'assistant', content: 'Want me to search for the latest Apple event updates?' }, { role: 'user', content: 'Yes' }],
    availableTools: ['web'], canDraft: false,
    chat: async () => answers.shift() || 'No result',
    lookup: async (tool) => { lookups.push(tool); return ['Apple Events https://www.apple.com/apple-events/'] },
    propose: async () => ({ ok: false }),
  })
  expect(lookups).toEqual(['web'])
})

it('does not release an unsupported current answer after the model ignores the search correction', async () => {
  const result = await runToolConversation({
    messages: [{ role: 'user', content: 'What is the latest Apple event news?' }],
    availableTools: ['web'], canDraft: false,
    chat: async () => 'I just checked: there is no event.', lookup: async () => [], propose: async () => ({ ok: false }),
  })
  expect(result.reply).not.toContain('I just checked')
  expect(result.reply).toContain('verify')
})

it('does not let a calendar lookup stand in for web evidence', async () => {
  const answers = ['{"action":"lookup","tool":"calendar","query":"today"}', 'The latest Apple news is nothing.', '{"action":"lookup","tool":"web","query":"Apple news"}', 'Verified source https://www.apple.com/newsroom/']
  const lookups: string[] = []
  await runToolConversation({ messages: [{ role: 'user', content: 'Check my calendar and latest Apple news' }], availableTools: ['web', 'calendar'], canDraft: false,
    chat: async () => answers.shift() || 'No result', lookup: async tool => { lookups.push(tool); return ['a result'] }, propose: async () => ({ ok: false }) })
  expect(lookups).toEqual(['calendar', 'web'])
})
