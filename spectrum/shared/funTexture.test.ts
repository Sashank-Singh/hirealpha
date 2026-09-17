import { describe, expect, it } from 'bun:test'
import { createTapbackRhythm, REACTION_MIN_TURN_GAP } from './smartReactions'
import { bubbleGapMs, BUBBLE_GAP_MAX_MS, BUBBLE_GAP_MIN_MS } from './progressiveDelivery'
import { MAX_REPLY_BUBBLES, splitBubbles } from './runHireTurn'
import { flavorIndex, pickFlavor } from './proactiveFlavors'
import { isBitFactKey, isDurableFactKey, isToneFactKey } from './memory'
import { selectMemoryFacts, MEMORY_BLOCK_MAX_BITS } from './memoryBlock'
import { buildQuietCheckText, buildSaveContactText } from './taskLoops'

describe('tapback rhythm', () => {
  const rhythm = () => createTapbackRhythm()

  it('does not react to the first turns of a live conversation', () => {
    const r = rhythm()
    for (let turn = 1; turn < REACTION_MIN_TURN_GAP; turn++) {
      expect(r.note('u1', 'order me a pepperoni pizza')).toBeNull()
    }
  })

  it('spends a reaction once the gap has passed, then waits again', () => {
    const r = rhythm()
    for (let turn = 1; turn < REACTION_MIN_TURN_GAP; turn++) r.note('u1', 'order me a pepperoni pizza')
    expect(r.note('u1', 'order me a pepperoni pizza')).toBe('🍕')
    // Never twice in a row: the very next turn is silent even with strong content.
    expect(r.note('u1', 'more pepperoni pizza please')).toBeNull()
  })

  it('never reacts to confirmation fragments, however long the gap', () => {
    const r = rhythm()
    for (let turn = 0; turn < REACTION_MIN_TURN_GAP * 2; turn++) {
      expect(r.note('u1', 'yes')).toBeNull()
      expect(r.note('u1', 'ok')).toBeNull()
      expect(r.note('u1', '12')).toBeNull()
    }
  })

  it('counts turns per sender, not globally', () => {
    const r = rhythm()
    for (let turn = 1; turn < REACTION_MIN_TURN_GAP; turn++) r.note('u1', 'pepperoni pizza')
    // A different thread starting fresh still has to wait its own turns.
    expect(r.note('u2', 'pepperoni pizza')).toBeNull()
    expect(r.note('u1', 'pepperoni pizza')).toBe('🍕')
  })

  it('restarts the count when an opening reaction already went out', () => {
    const r = rhythm()
    for (let turn = 1; turn < REACTION_MIN_TURN_GAP; turn++) r.note('u1', 'pepperoni pizza')
    r.reset('u1')
    expect(r.note('u1', 'pepperoni pizza')).toBeNull()
  })
})

describe('bubble pacing', () => {
  it('keeps every gap inside the human range', () => {
    for (let index = 1; index <= 4; index++) {
      for (const jitter of [0, 8, 40, 120, -30]) {
        const gap = bubbleGapMs(index, jitter)
        expect(gap).toBeGreaterThanOrEqual(BUBBLE_GAP_MIN_MS)
        expect(gap).toBeLessThanOrEqual(BUBBLE_GAP_MAX_MS)
      }
    }
  })

  it('is deterministic for the same bubble, so a retry reproduces the cadence', () => {
    expect(bubbleGapMs(2, 14)).toBe(bubbleGapMs(2, 14))
  })
})

describe('reply splitting', () => {
  it('splits on blank lines', () => {
    expect(splitBubbles('ok wait\n\nfound it')).toEqual(['ok wait', 'found it'])
  })

  it('keeps a single-paragraph reply as one bubble', () => {
    expect(splitBubbles('Flight is at 8:35. Want me to check you in?')).toHaveLength(1)
  })

  it('folds a long answer past the cap into the last bubble instead of dropping it', () => {
    const parts = splitBubbles(['one', 'two', 'three', 'four', 'five'].join('\n\n'))
    expect(parts).toHaveLength(MAX_REPLY_BUBBLES)
    // Nothing is lost: the tail is still in the final bubble.
    expect(parts[parts.length - 1]).toContain('four')
    expect(parts[parts.length - 1]).toContain('five')
  })
})

describe('proactive voice rotation', () => {
  it('keeps the canonical line when there is no user to key on', () => {
    expect(flavorIndex('', 3)).toBe(0)
    expect(pickFlavor(['a', 'b', 'c'], '')).toBe('a')
    expect(buildSaveContactText()).toContain("If you haven't saved my number yet")
    expect(buildQuietCheckText()).toContain('gone quiet everywhere')
  })

  it('is stable per user and spreads different users across the variants', () => {
    const seen = new Set<string>()
    for (let i = 0; i < 60; i++) {
      const phone = `+1555000${String(i).padStart(4, '0')}`
      const text = buildQuietCheckText(phone)
      expect(buildQuietCheckText(phone)).toBe(text)
      seen.add(text)
    }
    // Not a coin-flip assertion: 60 keys against 3 variants missing one
    // entirely would mean the hash is degenerate.
    expect(seen.size).toBe(3)
  })
})

describe('bit and tone facts', () => {
  it('treats bits and the tone dial as durable', () => {
    expect(isBitFactKey('bit-knicks')).toBe(true)
    expect(isBitFactKey('bit_pasta_tuesday')).toBe(true)
    expect(isDurableFactKey('bit-knicks')).toBe(true)
    expect(isDurableFactKey('tone_playfulness')).toBe(true)
    expect(isToneFactKey('tone_playfulness')).toBe(true)
    expect(isDurableFactKey('random_thing')).toBe(false)
  })

  it('caps how many bits reach the prompt', () => {
    const facts = [
      { key: 'preferred_name', value: 'Sam', at: 1 },
      ...Array.from({ length: 8 }, (_, i) => ({ key: `bit-${i}`, value: `thing ${i}`, at: 100 + i })),
    ]
    const selected = selectMemoryFacts(facts)
    expect(selected.filter((f) => isBitFactKey(f.key))).toHaveLength(MEMORY_BLOCK_MAX_BITS)
    // Newest bits win the slots.
    expect(selected.map((f) => f.key)).toContain('bit-7')
    expect(selected.map((f) => f.key)).toContain('preferred_name')
  })

  it('never drops the tone dial for budget', () => {
    const facts = [
      { key: 'tone_playfulness', value: 'straight', at: 1 },
      ...Array.from({ length: 70 }, (_, i) => ({ key: `filler_${i}`, value: 'x'.repeat(50), at: 10 + i })),
    ]
    expect(selectMemoryFacts(facts).map((f) => f.key)).toContain('tone_playfulness')
  })
})
