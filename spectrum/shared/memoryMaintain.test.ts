import { describe, expect, it } from 'bun:test'
import { captureStatedPreferences } from './memoryMaintain'

const keysOf = (text: string) => captureStatedPreferences(text).map((f) => f.key)
const valueOf = (text: string, key: string) => captureStatedPreferences(text).find((f) => f.key === key)?.value

describe('captureStatedPreferences', () => {
  it('captures the benchmark sentence: aisle seats and no pork', () => {
    const facts = captureStatedPreferences("I always want aisle seats and I don't eat pork.")
    expect(facts.find((f) => f.key === 'seat_preference')?.value).toBe('aisle seat')
    expect(facts.find((f) => f.key === 'diet')?.value).toBe('no pork')
    expect(facts.find((f) => f.key === 'hard_nos')?.value).toBe('no pork anywhere')
  })

  it('handles the singular "aisle seat" phrasing', () => {
    expect(valueOf('I always want an aisle seat.', 'seat_preference')).toBe('aisle seat')
  })

  it('captures a window preference and a generic drink order', () => {
    expect(valueOf('I always want a window seat on flights.', 'seat_preference')).toBe('window seat')
    expect(keysOf('I always want oat milk in my coffee')).toContain('drink_order')
  })

  it('captures dietary aversions stated without "always"', () => {
    expect(valueOf("I don't eat shellfish", 'diet')).toBe('no shellfish')
    expect(valueOf('no gluten for me please', 'diet')).toBe('no gluten')
  })

  it('captures vegetarian/halal style preferences', () => {
    expect(valueOf('I always want vegetarian options', 'diet')).toBe('vegetarian options')
  })

  it('does not invent facts from unrelated "always" talk', () => {
    expect(captureStatedPreferences('I always want to sleep in on Sundays')).toEqual([])
    expect(captureStatedPreferences('my aisle seat request is in the booking')).toEqual([])
    expect(captureStatedPreferences('   ')).toEqual([])
  })

  it('never emits duplicate keys for one sentence', () => {
    const keys = keysOf("I always want aisle seats, I don't eat pork, and no pork anywhere.")
    expect(new Set(keys).size).toBe(keys.length)
  })
})
