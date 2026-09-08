import { expect, it } from 'bun:test'
import { runToolConversation } from './toolLoop'

const sources = ['Web search retrieved at 2026-09-08\n- Sorella\n  https://sorellasf.com/\n  Italian restaurant at 1760 Polk Street, San Francisco 94109.']

it('requires an actual lookup for restaurant recommendations, even if the draft contains a URL', async () => {
  let searched = false
  const replies = ['Try a place from my memory: https://example.com/', '{"action":"lookup","tool":"web","query":"nice restaurant 94109"}', 'Sorella: https://sorellasf.com/']
  const result = await runToolConversation({ messages: [{ role: 'user', content: 'can you find nice restaurant in 94109' }], availableTools: ['web'], canDraft: false,
    chat: async () => replies.shift()!, lookup: async () => { searched = true; return sources }, propose: async () => ({ ok: false }) })
  expect(searched).toBe(true)
  expect(result.reply).toContain('sorellasf.com')
})

it('corrects a search answer without sources before delivering it', async () => {
  const replies = ['{"action":"lookup","tool":"web","query":"restaurant 94109"}', 'Sorella has a tasting menu and waterfront views.', 'Sorella is an Italian restaurant at 1760 Polk Street: https://sorellasf.com/']
  const result = await runToolConversation({ messages: [{ role: 'user', content: 'nice restaurant in 94109' }], availableTools: ['web'], canDraft: false,
    chat: async () => replies.shift()!, lookup: async () => sources, propose: async () => ({ ok: false }) })
  expect(result.reply).toContain('https://sorellasf.com/')
  expect(result.reply).not.toContain('waterfront')
})

it('keeps public search results when the answer model fails', async () => {
  let calls = 0
  const result = await runToolConversation({
    messages: [{ role: 'user', content: 'find nice restaurant in 94109' }], availableTools: ['web'], canDraft: false,
    chat: async () => { if (calls++ === 0) return '{"action":"lookup","tool":"web","query":"nice restaurant 94109"}'; throw new Error('model timeout') },
    lookup: async () => sources, propose: async () => ({ ok: false }),
  })
  expect(result.reply).toContain('Sorella')
  expect(result.reply).toContain('https://sorellasf.com/')
  expect(result.reply).not.toContain('Please try again or narrow')
})

it('falls back to web without another model decision when maps fails', async () => {
  const lookups: string[] = []
  let calls = 0
  const result = await runToolConversation({
    messages: [{ role: 'user', content: 'find nice restaurant in 94109' }], availableTools: ['maps', 'web'], canDraft: false,
    chat: async () => { if (calls++ === 0) return '{"action":"lookup","tool":"maps","query":"nice restaurant 94109"}'; throw new Error('model timeout') },
    lookup: async tool => { lookups.push(tool); return tool === 'maps' ? ['Maps search unavailable right now.'] : sources },
    propose: async () => ({ ok: false }),
  })
  expect(lookups).toEqual(['maps', 'web'])
  expect(result.reply).toContain('Sorella')
})
