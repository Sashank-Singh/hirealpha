import { describe, expect, test } from 'bun:test'
import { formatReply, nextRunLabel, planFor } from './format'

describe('planFor', () => {
  test('monthly plans pass through', () => {
    expect(planFor('single', false)).toBe('single')
    expect(planFor('ultra', false)).toBe('ultra')
  })

  test('annual folds into the plan name', () => {
    expect(planFor('bundle', true)).toBe('bundle-annual')
  })
})

describe('formatReply', () => {
  test('human times for the status strip', () => {
    expect(formatReply(400)).toBe('400ms')
    expect(formatReply(3400)).toBe('3s')
    expect(formatReply(null)).toBe('')
  })
})

describe('nextRunLabel', () => {
  const now = Date.parse('2026-08-27T12:00:00.000Z')

  test('nothing scheduled says nothing', () => {
    expect(nextRunLabel(null, now)).toBe('')
    expect(nextRunLabel('not a date', now)).toBe('')
  })

  test('minutes, hours, and days until it runs', () => {
    expect(nextRunLabel('2026-08-27T12:03:00.000Z', now)).toBe('runs in 3m')
    expect(nextRunLabel('2026-08-27T15:00:00.000Z', now)).toBe('runs in 3h')
    expect(nextRunLabel('2026-08-29T12:00:00.000Z', now)).toBe('runs in 2d')
  })

  test('past times mean now', () => {
    expect(nextRunLabel('2026-08-27T11:00:00.000Z', now)).toBe('runs now')
  })
})
