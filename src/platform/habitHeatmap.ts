/** Pure utility for building the 12-week GitHub-style habit heatmap grid. */

function localDateStr(d = new Date()): string {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

function mondayOfLocal(d = new Date()): Date {
  const x = new Date(d.getFullYear(), d.getMonth(), d.getDate())
  const day = x.getDay()
  const diff = day === 0 ? 6 : day - 1
  x.setDate(x.getDate() - diff)
  return x
}

export type HeatmapCell = { date: string; level: number }

/**
 * Builds a 12-week GitHub-style heatmap grid.
 * Returns columns (weeks, oldest first) of 7 cells each (Mon=0 ... Sun=6).
 * level: -1 = future (invisible), 0 = no completions, 1-4 = intensity.
 */
export function buildHabitHeatmap(
  habits: Array<{ logDates?: string[] }>,
  referenceDate = new Date(),
): HeatmapCell[][] {
  const WEEKS = 12
  const today = localDateStr(referenceDate)
  const monday = mondayOfLocal(referenceDate)

  const start = new Date(monday)
  start.setDate(start.getDate() - (WEEKS - 1) * 7)

  const doneSets = habits.map((h) => new Set(h.logDates ?? []))
  const total = habits.length

  const columns: HeatmapCell[][] = []
  for (let w = 0; w < WEEKS; w++) {
    const col: HeatmapCell[] = []
    for (let day = 0; day < 7; day++) {
      const d = new Date(start)
      d.setDate(start.getDate() + w * 7 + day)
      const date = localDateStr(d)
      if (date > today) {
        col.push({ date, level: -1 })
      } else {
        const count = total > 0 ? doneSets.filter((s) => s.has(date)).length : 0
        let level = 0
        if (count > 0 && total > 0) {
          const ratio = count / total
          if (ratio >= 1) level = 4
          else if (ratio >= 0.67) level = 3
          else if (ratio >= 0.34) level = 2
          else level = 1
        }
        col.push({ date, level })
      }
    }
    columns.push(col)
  }
  return columns
}
