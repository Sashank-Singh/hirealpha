/* The stay window an ask describes, resolved without the model.
 *
 * Live: "Book me a hotel in Chicago for Friday and Saturday next week" was read
 * as check-in Friday and check-out Saturday — one night — by the model that
 * wrote both the fare lookup and the booking goal, so every rate the user saw
 * was for the wrong stay. Two named nights are two nights.
 *
 * Pure and deliberately small: weekdays, "N nights", and the weekend shorthand.
 * When the ask names explicit dates, the caller's own date parser is better and
 * this returns null.
 */

const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday']
const ABBREV: Record<string, number> = {
  sun: 0, mon: 1, tue: 2, tues: 2, wed: 3, thu: 4, thur: 4, thurs: 4, fri: 5, sat: 6,
}

const WORD_NUMBERS: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, a: 1, an: 1,
}

export type StayWindow = { checkIn: string; checkOut: string; nights: number }

function ymd(date: Date): string {
  return date.toISOString().slice(0, 10)
}

/** The next date on or after `from` that lands on `weekday` (0 = Sunday). */
function nextWeekday(weekday: number, from: Date): Date {
  const day = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate()))
  const delta = (weekday - day.getUTCDay() + 7) % 7
  // "Friday" said on a Friday evening means today, not a week out.
  day.setUTCDate(day.getUTCDate() + delta)
  return day
}

/** Monday-anchored week comparison, so "next week" can be honoured. */
function sameWeek(a: Date, b: Date): boolean {
  const monday = (d: Date) => {
    const copy = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()))
    copy.setUTCDate(copy.getUTCDate() - ((copy.getUTCDay() + 6) % 7))
    return copy.toISOString().slice(0, 10)
  }
  return monday(a) === monday(b)
}

function weekdayIndex(token: string): number | null {
  const t = token.toLowerCase().replace(/[^a-z]/g, '')
  const full = WEEKDAYS.indexOf(t)
  if (full !== -1) return full
  return ABBREV[t] ?? null
}

/** Every weekday mentioned in the ask, in the order written. */
function mentionedWeekdays(text: string): number[] {
  const found: number[] = []
  const re = /\b(sunday|monday|tuesday|wednesday|thursday|friday|saturday|sun|mon|tues?|wed|thur?s?|fri|sat)\b/gi
  let match: RegExpExecArray | null
  while ((match = re.exec(text))) {
    const idx = weekdayIndex(match[1]!)
    if (idx !== null && !found.includes(idx)) found.push(idx)
  }
  return found
}

/**
 * The window the ask describes, or null when it does not describe one (or
 * describes explicit calendar dates, which the caller parses better).
 */
export function stayWindowFromAsk(text: string, now = new Date()): StayWindow | null {
  const ask = String(text || '')
  if (!ask) return null
  // Explicit dates are the caller's job; two ISO dates or a month name means it
  // already knows the window.
  if (/\b\d{4}-\d{2}-\d{2}\b/.test(ask) || /\b(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)/i.test(ask)) return null

  let nights: number | null = null

  /* "under 250 a night" is a rate, not a stay length.
   *
   * Matching "a night" there made every priced ask a one-night stay, which is
   * the same wrong window this helper exists to fix. Only a real count counts,
   * and never one that follows a price. */
  const counted = /\b(\d{1,2}|one|two|three|four|five|six|seven)\s+(?:nights?|days?)\b/i.exec(ask)
  if (counted && !/[\d$€£]\s*$/.test(ask.slice(0, counted.index))) {
    const raw = counted[1]!.toLowerCase()
    nights = WORD_NUMBERS[raw] ?? Number(raw)
    if (!Number.isFinite(nights) || nights < 1 || nights > 30) nights = null
  }

  const weekdays = mentionedWeekdays(ask)
  if (nights === null) {
    if (/\bweekend\b/i.test(ask)) nights = 2
    else if (weekdays.length >= 2) {
      // The named days ARE the nights: "Friday and Saturday" is two nights, and
      // "Friday to Sunday" is the two between them. Taking only the span read
      // the first case as a single night, which is the bug this exists for.
      const span = (weekdays[weekdays.length - 1]! - weekdays[0]! + 7) % 7
      nights = Math.max(1, span, weekdays.length)
    } else if (weekdays.length === 1) {
      nights = 1
    }
  }
  if (nights === null) return null

  const anchor = weekdays.length ? weekdays[0]! : null
  let checkIn = anchor === null ? new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1)) : nextWeekday(anchor, now)
  /* "next week" means the week after this one. Asking on a Friday, "Friday
   * next week" resolved to today and every rate came back for the wrong
   * weekend — the arithmetic was right and the week was not. */
  if (anchor !== null && /\bnext\s+week\b/i.test(ask) && sameWeek(checkIn, now)) {
    checkIn = new Date(checkIn)
    checkIn.setUTCDate(checkIn.getUTCDate() + 7)
  }
  const checkOut = new Date(checkIn)
  checkOut.setUTCDate(checkOut.getUTCDate() + nights)
  return { checkIn: ymd(checkIn), checkOut: ymd(checkOut), nights }
}
