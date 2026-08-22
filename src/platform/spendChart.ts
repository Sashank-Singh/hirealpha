/**
 * Geometry and colour for the two spend charts: the segmented budget bar on the
 * home screen and the donut inside the Spending app.
 *
 * Two rules drive everything here, and both are load-bearing:
 *
 * 1. Colour follows the category, never its size. A slot is assigned per
 *    category name, so "housing" is the same blue in a week where it is the
 *    biggest line and in a week where it is the smallest. Sorting by amount
 *    and colouring by position would repaint the chart every week.
 * 2. Segments render in slot order, not amount order. The palette was validated
 *    for *adjacent* pairs in this exact order; sorting by amount makes which
 *    colours touch arbitrary, which is a stricter gate that only clears for
 *    three series. Fixed order also means the bar keeps its shape week to week.
 *
 * Free-text categories reach us from the SMS agent, so anything not in the slot
 * list sums into "other". That holds both charts at six segments permanently.
 */

/** Render order. Also the palette slot order the colours were validated in. */
export const SPEND_SLOTS = ['housing', 'food', 'transport', 'subscriptions', 'fun', 'other'] as const

export type SpendSlot = (typeof SPEND_SLOTS)[number]

/**
 * Categorical slots 1-6 stepped for the dark mini app surface (#141414).
 * Validated together on that surface: worst adjacent pair separates by 8.4
 * under protanopia and 19.3 to a full-colour reader, all six clear 3:1.
 *
 * "other" is a real hue rather than a de-emphasis gray on purpose — gray
 * (#898781) sits 1.1 from the magenta beside it under deuteranopia, so a
 * red-green colourblind reader could not tell Fun from Other apart.
 */
export const SPEND_SLOT_COLORS: Record<SpendSlot, string> = {
  housing: '#3987e5',
  food: '#d95926',
  transport: '#199e70',
  subscriptions: '#c98500',
  fun: '#d55181',
  other: '#008300',
}

export const SPEND_SLOT_LABELS: Record<SpendSlot, string> = {
  housing: 'Housing',
  food: 'Food',
  transport: 'Transport',
  subscriptions: 'Subscriptions',
  fun: 'Fun',
  other: 'Other',
}

export type SpendInput = { category: string; amount: number }

/** Anything we do not have a slot for becomes "other". */
export function spendCategorySlot(category: string): SpendSlot {
  const key = (category || '').trim().toLowerCase()
  return (SPEND_SLOTS as readonly string[]).includes(key) ? (key as SpendSlot) : 'other'
}

export type SpendPart = {
  slot: SpendSlot
  label: string
  color: string
  amount: number
  /** Share of the category total, 0-100. */
  share: number
}

/** Fold free-text rows into slots and return them in slot order, zeroes dropped. */
export function aggregateSpend(rows: SpendInput[]): { parts: SpendPart[]; total: number } {
  const sums = new Map<SpendSlot, number>()
  for (const row of rows || []) {
    const amount = Number(row?.amount)
    if (!Number.isFinite(amount) || amount <= 0) continue
    const slot = spendCategorySlot(row.category)
    sums.set(slot, (sums.get(slot) || 0) + amount)
  }
  const total = [...sums.values()].reduce((a, b) => a + b, 0)
  const parts: SpendPart[] = []
  for (const slot of SPEND_SLOTS) {
    const amount = sums.get(slot)
    if (!amount) continue
    parts.push({
      slot,
      label: SPEND_SLOT_LABELS[slot],
      color: SPEND_SLOT_COLORS[slot],
      amount,
      share: total > 0 ? (amount / total) * 100 : 0,
    })
  }
  return { parts, total }
}

export type SpendSegment = SpendPart & {
  /** Width as a percentage of the bar's full scale (not of the total). */
  pct: number
}

export type SpendBarModel = {
  segments: SpendSegment[]
  total: number
  budget: number
  /** What 100% of the bar's width represents in dollars. */
  scale: number
  /**
   * Where the budget tick sits, 0-100, or null when there is nothing to mark —
   * either no budget is set, or the budget IS the right edge of the track.
   */
  capPct: number | null
  over: boolean
  /** Empty track left after the segments; how much of the cap is unspent. */
  remainingPct: number
}

/**
 * Scale the bar so it answers "how much, on what, against the cap" at once.
 *
 * Under the cap the track represents the budget, so the empty tail reads as
 * money left and needs no tick. Over the cap the track has to grow to fit the
 * spend, so the cap becomes a tick inside the bar. With no budget set there is
 * no cap to draw and the bar is pure part-to-whole.
 */
export function spendSegments(rows: SpendInput[], budgetRaw: number): SpendBarModel {
  const { parts, total } = aggregateSpend(rows)
  const budget = Number.isFinite(budgetRaw) && budgetRaw > 0 ? budgetRaw : 0
  const over = budget > 0 && total > budget
  const scale = budget > 0 ? Math.max(total, budget) : total
  const segments: SpendSegment[] = parts.map((p) => ({
    ...p,
    pct: scale > 0 ? (p.amount / scale) * 100 : 0,
  }))
  const used = segments.reduce((a, s) => a + s.pct, 0)
  return {
    segments,
    total,
    budget,
    scale,
    capPct: over ? (budget / scale) * 100 : null,
    over,
    remainingPct: Math.max(0, 100 - used),
  }
}

export type SpendSlice = SpendPart & {
  /** `stroke-dasharray` for an SVG circle drawn with `transform: rotate(-90)`. */
  dashArray: string
  dashOffset: number
}

export type SpendDonutModel = {
  slices: SpendSlice[]
  total: number
  radius: number
  circumference: number
}

/**
 * Slice geometry as dash offsets on one SVG circle, which avoids arc-path maths
 * entirely. The gap is subtracted from each slice's drawn length rather than
 * added as a stroke, so the separation is surface showing through.
 */
export function spendSlices(
  rows: SpendInput[],
  opts?: { radius?: number; gap?: number },
): SpendDonutModel {
  const radius = opts?.radius ?? 42
  const gap = opts?.gap ?? 2
  const circumference = 2 * Math.PI * radius
  const { parts, total } = aggregateSpend(rows)
  let walked = 0
  const slices: SpendSlice[] = parts.map((p) => {
    const span = (p.share / 100) * circumference
    // A lone slice is a full ring; cutting a gap into it would look like a defect.
    const drawn = parts.length > 1 ? Math.max(0, span - gap) : span
    const slice: SpendSlice = {
      ...p,
      dashArray: `${drawn} ${Math.max(0, circumference - drawn)}`,
      dashOffset: walked > 0 ? -walked : 0,
    }
    walked += span
    return slice
  })
  return { slices, total, radius, circumference }
}
