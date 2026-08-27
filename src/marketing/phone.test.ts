import { describe, expect, test } from 'bun:test'
import { toE164 } from './phone'

describe('toE164', () => {
  test('normalizes the common US formats', () => {
    expect(toE164('(555) 555-0100')).toBe('+15555550100')
    expect(toE164('555 555 0100')).toBe('+15555550100')
    expect(toE164('5555550100')).toBe('+15555550100')
  })

  test('keeps a country code already typed', () => {
    expect(toE164('+1 415 595 1440')).toBe('+14155951440')
    expect(toE164('14155951440')).toBe('+14155951440')
  })

  test('keeps other countries only when they say +', () => {
    expect(toE164('+44 20 7946 0958')).toBe('+442079460958')
    expect(toE164('44 20 7946 0958')).toBe('')
  })

  test('gives up on junk instead of guessing', () => {
    expect(toE164('')).toBe('')
    expect(toE164('hello')).toBe('')
    expect(toE164('12345')).toBe('')
  })
})
