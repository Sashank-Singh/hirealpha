import { describe, expect, it } from 'bun:test'
import { composeWeekReview, spendWouldBreakCap } from '../../deploy/weekRun'
import { looksLikeWeekRun } from './toolLoop'

describe('week run', () => {
  it('detects run my week and not a reopen', () => {
    expect(looksLikeWeekRun('run my week')).toBe(true)
    expect(looksLikeWeekRun('handle the week for me')).toBe(true)
    expect(looksLikeWeekRun('how was my week')).toBe(true)
    expect(looksLikeWeekRun('open my weekly review')).toBe(false)
    expect(looksLikeWeekRun('what is today')).toBe(false)
  })

  it('writes a review from logs and flags the spend cap', () => {
    const wrote = composeWeekReview({
      meals: 12,
      habitChecks: 4,
      sleepNights: 5,
      avgSleepHours: 6.2,
      workouts: 3,
      spend: 480,
      weeklyBudget: 400,
      followUpsDue: 2,
      gratitude: 1,
    })
    expect(wrote.doneText).toContain('4 habit checks')
    expect(wrote.slippedText).toContain('follow ups')
    expect(wrote.slippedText).toContain('over the $400 cap')
    expect(wrote.focusText).toBe('One follow up, then stop.')
    expect(wrote.text).toContain('still need Send or Book')
    expect(/[-–—]/.test(wrote.text)).toBe(false)
  })

  it('blocks spend that would break the cap', () => {
    expect(spendWouldBreakCap(390, 400, 20)).toBe(true)
    expect(spendWouldBreakCap(300, 400, 20)).toBe(false)
    expect(spendWouldBreakCap(400, 0, 20)).toBe(false)
  })
})
