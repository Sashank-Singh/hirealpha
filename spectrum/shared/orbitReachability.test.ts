import { describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadMemory, recordCardDelivered } from './memory'
import { isCasualChitChat } from './conversationalApproval'

describe('Orbit Reachability & Mini-App Card Delivery System', () => {
  it('identifies casual chit-chat so cards are never spammed on banter', () => {
    expect(isCasualChitChat('thanks')).toBe(true)
    expect(isCasualChitChat('thank you!')).toBe(true)
    expect(isCasualChitChat('cool thanks')).toBe(true)
    expect(isCasualChitChat('ok got it')).toBe(true)
    expect(isCasualChitChat('haha')).toBe(true)
    expect(isCasualChitChat('sounds great')).toBe(true)

    // Substantive queries must NOT be classified as casual
    expect(isCasualChitChat('what are my apps')).toBe(false)
    expect(isCasualChitChat('plan my day')).toBe(false)
    expect(isCasualChitChat('log 50 pushups')).toBe(false)
    expect(isCasualChitChat('what should I eat for dinner')).toBe(false)
  })

  it('tracks last card delivery timestamp in thread memory for cooldown enforcement', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'orbit-reachability-'))
    const senderId = '+15550001111'

    try {
      const initialMem = loadMemory(dataDir, senderId)
      expect(initialMem.lastCardDeliveredAt).toBeUndefined()

      const now = Date.now()
      recordCardDelivered(dataDir, senderId, now)

      const updatedMem = loadMemory(dataDir, senderId)
      expect(updatedMem.lastCardDeliveredAt).toBe(now)

      // Test 15-minute cooldown check
      const cooldownMs = 15 * 60 * 1000
      const withinCooldown = Date.now() - updatedMem.lastCardDeliveredAt! < cooldownMs
      expect(withinCooldown).toBe(true)

      // Simulate after cooldown has elapsed
      const pastTime = now - (16 * 60 * 1000)
      recordCardDelivered(dataDir, senderId, pastTime)
      const pastMem = loadMemory(dataDir, senderId)
      const afterCooldown = Date.now() - pastMem.lastCardDeliveredAt! > cooldownMs
      expect(afterCooldown).toBe(true)
    } finally {
      rmSync(dataDir, { recursive: true, force: true })
    }
  })
})
