import { describe, expect, it } from 'bun:test'
import { computeLifeInsights, formatLifeStateBlock, pickProactiveInsight, type LifeState } from './lifeState'

function base(over: Partial<LifeState> = {}): LifeState {
  return {
    localTime: '2026-08-18T15:00',
    weekday: 'Tuesday',
    nutrition: { calories: 820, protein: 40, calorieGoal: 2200, proteinGoal: 150, meals: 1 },
    sleep: { hours: 5.8, quality: 2, date: '2026-08-17' },
    sleepWeek: { nights: 5, avgHours: 6.1, shortNights: 2 },
    workoutsToday: 0,
    spend: { weekTotal: 310, weeklyBudget: 400 },
    calendar: [],
    loops: ['send the recap'],
    peopleDue: [{ name: 'Maya', days: 11 }],
    ...over,
  }
}

describe('life state insights', () => {
  it('computes the protein plus short sleep read from logs', () => {
    const insights = computeLifeInsights(base())
    const food = insights.find((i) => i.topic === 'nutrition_gap')
    const sleep = insights.find((i) => i.topic === 'sleep')
    expect(food?.line).toContain('Protein is sitting at 40 of 150')
    expect(food?.line).toContain('chicken bowl')
    expect(sleep?.line).toContain('5.8h last night')
    expect(sleep?.line).toContain('second short night')
    expect(food?.tap).toContain('eat')
  })

  it('feeds the same numbers into the conversation block', () => {
    const block = formatLifeStateBlock(base())
    expect(block).toContain('5.8h')
    expect(block).toContain('40g protein of 150')
    expect(block).toContain('Maya (11 days)')
    expect(block).toContain('Do not invent')
  })

  it('morning tick synthesizes calendar plus risk', () => {
    const hit = pickProactiveInsight(base({ calendar: ['Standup 10am'] }), 'morning')
    expect(hit?.loop).toBe('morning')
    expect(hit?.card).toBe('digest')
    expect(hit?.line).toContain('Standup 10am')
    expect(hit?.line.toLowerCase()).not.toContain('—')
  })

  it('afternoon only interrupts when a ledger is actually wrong', () => {
    const hit = pickProactiveInsight(base(), 'afternoon')
    expect(hit?.loop).toBe('interrupt')
    expect(['sleep', 'nutrition_gap', 'follow_up']).toContain(hit?.topic)
  })

  it('stays silent in the afternoon when nothing is wrong', () => {
    const hit = pickProactiveInsight(
      base({
        nutrition: { calories: 1800, protein: 140, calorieGoal: 2200, proteinGoal: 150, meals: 3 },
        sleep: { hours: 8, quality: 4, date: '2026-08-17' },
        sleepWeek: { nights: 5, avgHours: 7.8, shortNights: 0 },
        workoutsToday: 1,
        peopleDue: [],
        loops: [],
        spend: { weekTotal: 80, weeklyBudget: 400 },
      }),
      'afternoon',
    )
    expect(hit).toBeNull()
  })

  it('night offers Tonight when the calendar is empty', () => {
    const hit = pickProactiveInsight(base({ localTime: '2026-08-18T21:10' }), 'evening')
    expect(hit?.loop).toBe('night')
    expect(hit?.card).toBe('pick_night')
    expect(hit?.tap.toLowerCase()).toContain('in')
  })
})
