import { describe, expect, it } from 'bun:test'
import { loadMemory, setPendingSpend } from './memory'
import { isAffirmativeApprovalIntent, isCasualChitChat, isNegativeCancellationIntent } from './conversationalApproval'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

describe('conversational approval & cancellation intent', () => {
  it('recognizes natural affirmations without requiring rigid keyword matches', () => {
    const naturalAffirmations = [
      'approve',
      'yes',
      'yeah go for it',
      'sounds good to me',
      'looks great, buy it',
      'let\'s do it',
      'grab that one',
      'place the order please',
      'charge it',
      'yes please',
      'sure thing',
      'that works for me',
      'perfect, get it',
      'definitely, order that',
      'totally, go ahead',
    ]

    for (const text of naturalAffirmations) {
      expect(isAffirmativeApprovalIntent(text)).toBe(true)
    }
  })

  it('rejects ambiguous questions, negations, or non-approvals', () => {
    const nonAffirmations = [
      'wait, how much is shipping?',
      'is this organic?',
      'can I change the address?',
      'no, don\'t buy that',
      'never mind',
      'hold on a sec',
      'what else do you have?',
      'tell me more about it',
      'cancel that order',
    ]

    for (const text of nonAffirmations) {
      expect(isAffirmativeApprovalIntent(text)).toBe(false)
    }
  })

  it('recognizes natural cancellations', () => {
    const cancellations = [
      'no',
      'cancel',
      'cancel that',
      'don\'t buy it',
      'never mind',
      'stop',
      'hold on',
      'nope',
    ]

    for (const text of cancellations) {
      expect(isNegativeCancellationIntent(text)).toBe(true)
    }
  })

  it('maintains pending spend in thread memory for conversational resolution', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'hire-approval-test-'))
    const senderId = '+15559876543'

    try {
      setPendingSpend(dataDir, senderId, {
        id: 'spend_test_123',
        item: '5lb Jasmine Rice',
        amount: 14.99,
        createdAt: Date.now(),
      })

      const mem = loadMemory(dataDir, senderId)
      expect(mem.pendingSpend?.id).toBe('spend_test_123')
      expect(mem.pendingSpend?.item).toBe('5lb Jasmine Rice')
      expect(mem.pendingSpend?.amount).toBe(14.99)

      // Clearing upon cancellation or completion
      setPendingSpend(dataDir, senderId)
      const clearedMem = loadMemory(dataDir, senderId)
      expect(clearedMem.pendingSpend).toBeUndefined()
    } finally {
      rmSync(dataDir, { recursive: true, force: true })
    }
  })

  it('correctly identifies casual chit-chat and acknowledgments to avoid unsolicited card delivery', () => {
    const casualBanter = [
      'thanks',
      'thank you',
      'thanks so much',
      'thx',
      'ty',
      'cheers',
      'appreciate it',
      'ok',
      'okay',
      'k',
      'kk',
      'got it',
      'sounds good',
      'cool thanks',
      'awesome',
      'perfect',
      'bet',
      'sure thing',
      'all good',
      'haha',
      'lol',
      'bye',
      'good night',
      'see ya',
    ]

    for (const text of casualBanter) {
      expect(isCasualChitChat(text)).toBe(true)
    }

    const substantiveAsks = [
      'Can you plan my workouts for next week?',
      'What should I eat for dinner?',
      'Log 30 pushups',
      'Show me all apps',
      'What does my schedule look like today?',
      'Help me find a gift under $50',
      'I want to track my water intake',
    ]

    for (const text of substantiveAsks) {
      expect(isCasualChitChat(text)).toBe(false)
    }
  })
})


