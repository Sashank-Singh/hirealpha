import { describe, it, expect } from 'bun:test'
import { buildHabitHeatmap } from '../../src/platform/habitHeatmap'

describe('buildHabitHeatmap', () => {
  const REF = new Date('2026-08-18T12:00:00Z') // Tuesday

  it('returns 12 columns of 7 cells each', () => {
    const grid = buildHabitHeatmap([], REF)
    expect(grid).toHaveLength(12)
    for (const col of grid) expect(col).toHaveLength(7)
  })

  it('assigns level 0 for days with no completions', () => {
    const grid = buildHabitHeatmap([{ logDates: [] }], REF)
    const pastCells = grid.flat().filter((c) => c.level >= 0)
    for (const c of pastCells) expect(c.level).toBe(0)
  })

  it('assigns level 4 when all habits completed on a day', () => {
    const date = '2026-08-10'
    const grid = buildHabitHeatmap(
      [{ logDates: [date] }, { logDates: [date] }],
      REF,
    )
    const cell = grid.flat().find((c) => c.date === date)
    expect(cell?.level).toBe(4)
  })

  it('assigns level 1 when only one of three habits completed', () => {
    const date = '2026-08-11'
    const grid = buildHabitHeatmap(
      [{ logDates: [date] }, { logDates: [] }, { logDates: [] }],
      REF,
    )
    const cell = grid.flat().find((c) => c.date === date)
    expect(cell?.level).toBe(1)
  })

  it('marks future dates with level -1', () => {
    const grid = buildHabitHeatmap([{ logDates: [] }], REF)
    const futureCells = grid.flat().filter((c) => c.date > '2026-08-18')
    for (const c of futureCells) expect(c.level).toBe(-1)
  })

  it('does not mark today as future', () => {
    const grid = buildHabitHeatmap([{ logDates: ['2026-08-18'] }], REF)
    const today = grid.flat().find((c) => c.date === '2026-08-18')
    expect(today).toBeDefined()
    expect(today!.level).not.toBe(-1)
  })

  it('handles empty habits array without crashing', () => {
    const grid = buildHabitHeatmap([], REF)
    const pastCells = grid.flat().filter((c) => c.level >= 0)
    for (const c of pastCells) expect(c.level).toBe(0)
  })
})
