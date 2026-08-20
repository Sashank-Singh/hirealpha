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
    expect(block).toContain('Today is Tuesday, August 18, 2026')
    expect(block).toContain('3:00 PM')
    expect(block).toContain('It is Tuesday, a session day')
  })

  it('prints workout name, mail, and people phones for the world model', () => {
    const block = formatLifeStateBlock(
      base({
        workoutToday: { name: 'Tuesday Pull', place: 'home bodyweight' },
        mail: ['id=abc | Recap · Maya'],
        calendar: ['3:00 PM · Amy Black · Google Meet'],
        peopleDue: [{ name: 'Maya', days: 11, phone: '+12163032166' }],
        peoplePhones: [{ name: 'Maya', phone: '+12163032166' }],
      }),
    )
    expect(block).toContain('Today is Tuesday Pull, home bodyweight')
    expect(block).toContain('id=abc | Recap · Maya')
    expect(block).toContain('3:00 PM · Amy Black · Google Meet')
    expect(block).toContain('Maya (11 days, +12163032166)')
    expect(block).toContain('People you can text: Maya +12163032166')
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

  it('does not treat an older sleep row as last night', () => {
    const insights = computeLifeInsights(
      base({
        localTime: '2026-08-19T08:00',
        sleep: { hours: 5, quality: 2, date: '2026-08-17' },
      }),
    )
    const sleep = insights.find((i) => i.topic === 'sleep')
    expect(sleep).toBeUndefined()
    const block = formatLifeStateBlock(
      base({
        localTime: '2026-08-19T08:00',
        sleep: { hours: 5, quality: 2, date: '2026-08-17' },
      }),
    )
    expect(block).toContain('Sleep: no last night log.')
    expect(block).not.toContain('5h')
  })

  it('does quote last night when sleepDate is yesterday local', () => {
    const insights = computeLifeInsights(
      base({
        localTime: '2026-08-19T08:00',
        sleep: { hours: 5, quality: 2, date: '2026-08-18' },
      }),
    )
    const sleep = insights.find((i) => i.topic === 'sleep')
    expect(sleep?.line).toContain('5h last night')
  })

  it('does not fabricate protein numbers in the night debrief without nutrition logs', () => {
    const insights = computeLifeInsights(base({ nutrition: undefined }))
    const night = insights.find((i) => i.loop === 'night')
    expect(night?.line).not.toContain('Protein landed at')
    expect(night?.line).not.toContain('0 of 150')
  })

  it('surfaces an over-budget calorie day', () => {
    const insights = computeLifeInsights(
      base({ nutrition: { calories: 2800, protein: 120, calorieGoal: 2200, proteinGoal: 150, meals: 3 } }),
    )
    const cal = insights.find((i) => i.topic === 'calorie_over')
    expect(cal?.line).toContain('600 calories over')
    expect(cal?.line).toContain('2200')
  })

  it('stays silent about calories when under or at goal', () => {
    const insights = computeLifeInsights(
      base({ nutrition: { calories: 2000, protein: 120, calorieGoal: 2200, proteinGoal: 150, meals: 3 } }),
    )
    expect(insights.find((i) => i.topic === 'calorie_over')).toBeUndefined()
  })
})
