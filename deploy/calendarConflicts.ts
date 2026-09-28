/**
 * Pure calendar-conflict and availability math for the experience-gap pass.
 * No IO: busy blocks in, verdicts out. Tests pin the honesty rules — a guest
 * calendar that cannot be read is "unknown", never "free".
 */

export type Busy = { start: number; end: number }
export type SlotRange = { start: string; end: string; label: string }

export type GuestAvailability = {
  email: string
  state: 'read' | 'unknown' | 'error'
  busy?: Busy[]
}

/**
 * Intersect the user's free slots with each readable guest's busy blocks.
 * Guests in state 'unknown' or 'error' are returned untouched — the caller
 * must say their availability is unknown, never fold them into "free".
 */
export function intersectGuestAvailability(
  slots: SlotRange[],
  guests: GuestAvailability[],
): { slots: SlotRange[]; readableGuests: string[]; unknownGuests: string[] } {
  const readable = guests.filter((g) => g.state === 'read' && Array.isArray(g.busy))
  const unknown = guests.filter((g) => g.state !== 'read').map((g) => g.email)
  let out = slots
  for (const guest of readable) {
    out = out.filter((slot) => {
      const s = Date.parse(slot.start)
      const e = Date.parse(slot.end)
      return !(guest.busy || []).some((b) => s < b.end && e > b.start)
    })
  }
  return { slots: out, readableGuests: readable.map((g) => g.email), unknownGuests: unknown }
}

/** Honest summary the chat layer can quote verbatim. */
export function describeMutualAvailability(input: {
  slots: SlotRange[]
  readableGuests: string[]
  unknownGuests: string[]
  askedGuests: boolean
}): string {
  if (!input.askedGuests || !input.readableGuests.length && !input.unknownGuests.length) {
    return input.slots.length
      ? `Verified free slots from YOUR calendar: ${input.slots.map((s) => s.label).join('; ')}.`
      : 'Your calendar has no free slot in that window.'
  }
  const parts: string[] = []
  if (input.readableGuests.length) {
    parts.push(input.slots.length
      ? `Free for you AND ${input.readableGuests.join(', ')}: ${input.slots.map((s) => s.label).join('; ')}.`
      : `Nothing overlaps free for both you and ${input.readableGuests.join(', ')} in that window.`)
  }
  if (input.unknownGuests.length) {
    parts.push(`I can see your calendar, not ${input.unknownGuests.join(' or ')}'s — their availability is unknown here.`)
  }
  return parts.join(' ')
}

/** Two events overlap when each starts before the other ends. */
export function findOverlaps<T extends { start: number; end: number; title: string }>(events: T[]): Array<[T, T]> {
  const sorted = [...events].sort((a, b) => a.start - b.start)
  const out: Array<[T, T]> = []
  for (let i = 0; i < sorted.length; i++) {
    for (let j = i + 1; j < sorted.length; j++) {
      if (sorted[j]!.start >= sorted[i]!.end) break
      out.push([sorted[i]!, sorted[j]!])
    }
  }
  return out
}

/** Back-to-back with no buffer between named events. */
export function tightTurnarounds<T extends { start: number; end: number; title: string }>(events: T[], minGapMs = 10 * 60_000): Array<{ from: T; to: T; gapMin: number }> {
  const sorted = [...events].filter((e) => e.end > e.start).sort((a, b) => a.start - b.start)
  const out: Array<{ from: T; to: T; gapMin: number }> = []
  for (let i = 0; i < sorted.length - 1; i++) {
    const gap = sorted[i + 1]!.start - sorted[i]!.end
    if (gap >= 0 && gap < minGapMs) out.push({ from: sorted[i]!, to: sorted[i + 1]!, gapMin: Math.round(gap / 60_000) })
  }
  return out
}

export function formatClock(ms: number, timezone: string): string {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  }).format(new Date(ms))
}

/** The exact conflict text for "can I make this work?" — names both events. */
export function describeDayConflicts(input: {
  timezone: string
  events: Array<{ title: string; start: number; end: number }>
}): string {
  const overlaps = findOverlaps(input.events)
  const tight = tightTurnarounds(input.events)
  const lines: string[] = []
  for (const [a, b] of overlaps.slice(0, 4)) {
    lines.push(`"${a.title}" and "${b.title}" overlap (${formatClock(a.start, input.timezone)} to ${formatClock(Math.max(a.end, b.start), input.timezone)}).`)
  }
  for (const t of tight.slice(0, 3)) {
    lines.push(`Only ${t.gapMin === 0 ? 'no gap' : `${t.gapMin} min`} between "${t.from.title}" and "${t.to.title}".`)
  }
  if (!lines.length) return 'No conflicts on that day — nothing overlaps and nothing is back-to-back.'
  return lines.join(' ')
}
