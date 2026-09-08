import { describe, expect, it } from 'bun:test'
import { isConversationStart, selectSmartReaction } from './smartReactions'

describe('smartReactions', () => {
  describe('isConversationStart', () => {
    it('returns true when history is empty', () => {
      expect(isConversationStart([], 'can you order pizza?')).toBe(true)
    })

    it('returns true when elapsed time exceeds 15 minutes', () => {
      const now = Date.now()
      const history = [
        { role: 'user' as const, content: 'hey', ts: now - 20 * 60 * 1000 },
        { role: 'assistant' as const, content: 'hi there', ts: now - 19 * 60 * 1000 },
      ]
      expect(isConversationStart(history, 'can you order pizza?', now)).toBe(true)
    })

    it('returns false when message is sent during an ongoing conversation (< 15 mins)', () => {
      const now = Date.now()
      const history = [
        { role: 'user' as const, content: 'can you order pizza?', ts: now - 30 * 1000 },
        { role: 'assistant' as const, content: 'Which size and toppings?', ts: now - 20 * 1000 },
      ]
      expect(isConversationStart(history, 'pepperoni please', now)).toBe(false)
    })

    it('returns false for quick continuation/acknowledgment tokens even if time elapsed', () => {
      const now = Date.now()
      const history = [
        { role: 'assistant' as const, content: 'Ready when you are', ts: now - 30 * 60 * 1000 },
      ]
      expect(isConversationStart(history, 'yes', now)).toBe(false)
      expect(isConversationStart(history, 'ok', now)).toBe(false)
      expect(isConversationStart(history, 'large', now)).toBe(false)
      expect(isConversationStart(history, 'thanks!', now)).toBe(false)
    })
  })

  describe('selectSmartReaction', () => {
    it('reacts with pizza for pizza requests', () => {
      expect(selectSmartReaction('order me a pepperoni pizza')).toBe('🍕')
      expect(selectSmartReaction('can we get Domino\'s tonight?')).toBe('🍕')
    })

    it('reacts with thumbs up for email inbox requests', () => {
      expect(selectSmartReaction("what's important in my email")).toBe('👍')
      expect(selectSmartReaction('check my inbox for urgent messages')).toBe('👍')
      expect(selectSmartReaction('summarize my email today')).toBe('👍')
    })

    it('reacts with rice or cash for grocery/buying asks', () => {
      expect(selectSmartReaction('buy me Jasmine Rice')).toBe('🍚')
      expect(selectSmartReaction('order basmati rice on Amazon')).toBe('🍚')
      expect(selectSmartReaction('buy me a new charger on Amazon')).toBe('💵')
      expect(selectSmartReaction('how much does an iPad cost?')).toBe('💵')
    })

    it('reacts with question mark for news requests', () => {
      expect(selectSmartReaction("What's the news?")).toBe('❓')
      expect(selectSmartReaction('any news this morning?')).toBe('❓')
    })

    it('reacts with coffee/beer/dining icons appropriately', () => {
      expect(selectSmartReaction('find a nice coffee shop nearby')).toBe('☕')
      expect(selectSmartReaction('let\'s grab some beers after work')).toBe('🍺')
      expect(selectSmartReaction('recommend a good dinner place in Soho')).toBe('🍽️')
      expect(selectSmartReaction('order tacos for lunch')).toBe('🌮')
      expect(selectSmartReaction('craving sushi right now')).toBe('🍣')
    })

    it('reacts to calendar, flight, and fitness', () => {
      expect(selectSmartReaction("what's on my calendar today?")).toBe('🗓️')
      expect(selectSmartReaction('remind me at 5pm to call mom')).toBe('⏰')
      expect(selectSmartReaction('book flights to NYC')).toBe('✈️')
      expect(selectSmartReaction('log a chest workout')).toBe('💪')
      expect(selectSmartReaction('ran 5 miles this morning')).toBe('🏃')
    })

    it('reacts to celebrations, affection, and humor', () => {
      expect(selectSmartReaction('I got the job offer!!')).toBe('🎉')
      expect(selectSmartReaction('thank you so much, you are the best')).toBe('❤️')
      expect(selectSmartReaction('hahaha that is hilarious')).toBe('😂')
    })

    it('does NOT react to neutral greetings or generic text', () => {
      expect(selectSmartReaction('hey')).toBeNull()
      expect(selectSmartReaction('hello')).toBeNull()
      expect(selectSmartReaction('good morning')).toBeNull()
      expect(selectSmartReaction('what can you do?')).toBeNull()
      expect(selectSmartReaction('who made you?')).toBeNull()
    })
  })
})
