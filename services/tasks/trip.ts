/**
 * Phase 2 itinerary composition (beat-instinct plan, "travel as the flagship
 * proof"): a pure engine that turns booked trip legs into a conflict-checked,
 * chronologically ordered timeline for the trip mini-app. The iMessage surface
 * renders the same lines from the same legs — one truth, no second source.
 *
 * Doctrine carried over from the task contract: fail-closed validation at the
 * boundary, no regex on prose (structured fields and Intl only, never parsing
 * titles), deterministic ordering, and provenance as write-time law — a card
 * never publishes with a fabricated source or freshness timestamp.
 *
 * Conventions (documented, tested):
 *   - A `flight` or `transport` leg's location.city is the ARRIVAL city: the
 *     leg starts being "at" that city when it ends. Movement legs are the
 *     sanctioned way cities change, so a leg starting in a different city
 *     before one lands is never a teleport.
 *   - "Same calendar day" is judged in UTC on the ISO instant.
 *   - Timestamps must be ISO-8601 with an explicit zone (Z or ±HH:MM); naive
 *     local strings are rejected rather than guessed at.
 */
import type { TaskOption } from './taskContract'

export const LEG_KINDS = ['flight', 'stay', 'transport', 'restaurant', 'activity'] as const
export type TripLegKind = (typeof LEG_KINDS)[number]

/** Kinds that pin the traveler to their location city (planes/trains move). */
const STATIONARY_KINDS: readonly TripLegKind[] = ['stay', 'restaurant', 'activity']

export type TripLegLocation = { city: string; place?: string }

export type TripLeg = {
  id: string
  kind: TripLegKind
  title: string
  /** ISO-8601 with explicit zone. */
  start_at: string
  /** null = point event (or open-ended stay); never earlier than start_at. */
  end_at: string | null
  location: TripLegLocation
  /** Opaque provider reference (confirmation code). Never a secret value. */
  confirmation_ref?: string | null
  /** Booking link. Provenance for the publishable card when present. */
  booking_url?: string | null
  /** When the booking was confirmed; the card's freshness timestamp. */
  confirmed_at?: string | null
  price_cents?: number
  currency?: string
}

export type ConflictReason = 'overlap' | 'tight-connection' | 'teleport'

export type Conflict = {
  reason: ConflictReason
  /** [earlier leg id, later leg id] in chronological (stable id) order. */
  leg_ids: [string, string]
  /** Minutes between the earlier leg's end and the later's start; negative when they overlap. */
  gap_minutes: number
  /** Deterministic human-readable explanation (generated copy, never parsed). */
  note: string
}

export const DEFAULT_TRANS_BUFFER_MINUTES = 120
export const TELEPORT_GAP_MINUTES = 45

/** The only source a leg with no public link may publish under: the internal booking surface. */
export const TRIP_SOURCE_PLACEHOLDER = 'https://alpha.local/task'

/* ------------------------------------------------------------- timestamps */

function isDigits(value: string, from: number, count: number): boolean {
  for (let i = from; i < from + count; i += 1) {
    const code = value.charCodeAt(i)
    if (code < 48 || code > 57) return false
  }
  return true
}

function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0
}

function dayOfMonthExists(year: number, month: number, day: number): boolean {
  const lengths = [31, isLeapYear(year) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
  const length = month >= 1 && month <= 12 ? lengths[month - 1] : 0
  return day >= 1 && day <= length
}

/**
 * Structural ISO-8601 check (no regex): `YYYY-MM-DDTHH:MM[:SS](Z|±HH:MM)`.
 * V8 silently rolls over Feb 30, so the calendar is validated explicitly.
 */
function isIsoTimestamp(value: unknown): value is string {
  if (typeof value !== 'string') return false
  const s = value
  if (s.length < 17) return false
  if (!isDigits(s, 0, 4) || s.charCodeAt(4) !== 45 || !isDigits(s, 5, 2) || s.charCodeAt(7) !== 45 || !isDigits(s, 8, 2)) {
    return false
  }
  if (s.charCodeAt(10) !== 84 /* T */) return false
  if (!isDigits(s, 11, 2) || s.charCodeAt(13) !== 58 /* : */ || !isDigits(s, 14, 2)) return false
  const year = Number(s.slice(0, 4))
  const month = Number(s.slice(5, 7))
  const day = Number(s.slice(8, 10))
  const hour = Number(s.slice(11, 13))
  const minute = Number(s.slice(13, 15))
  if (!dayOfMonthExists(year, month, day) || hour > 23 || minute > 59) return false
  let zoneAt = 16
  if (s.charCodeAt(16) === 58 /* : */) {
    if (s.length < 19 || !isDigits(s, 17, 2)) return false
    if (Number(s.slice(17, 19)) > 60) return false
    zoneAt = 19
  }
  const zone = s.charCodeAt(zoneAt)
  if (zone !== 90 /* Z */ && zone !== 43 /* + */ && zone !== 45 /* - */) return false
  if (zone !== 90) {
    if (s.length !== zoneAt + 6 || s.charCodeAt(zoneAt + 3) !== 58 || !isDigits(s, zoneAt + 1, 2) || !isDigits(s, zoneAt + 4, 2)) {
      return false
    }
  }
  return Number.isFinite(Date.parse(s))
}

function toMs(iso: string): number {
  return Date.parse(iso)
}

/** Start instant in ms; throws on anything unparseable (fail closed). */
function startMs(leg: TripLeg): number {
  const ms = toMs(leg.start_at)
  if (!Number.isFinite(ms)) throw new Error(`Trip leg ${leg.id} has an invalid start_at.`)
  return ms
}

function endMs(leg: TripLeg): number {
  if (leg.end_at === null) return startMs(leg)
  const ms = toMs(leg.end_at)
  if (!Number.isFinite(ms)) throw new Error(`Trip leg ${leg.id} has an invalid end_at.`)
  return ms
}

/* --------------------------------------------------------------- validation */

function requireTrimmed(value: unknown, field: string, maxLength: number): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`Trip leg field "${field}" must be a non-empty string.`)
  }
  return value.trim().slice(0, maxLength)
}

function optionalTrimmed(value: unknown, field: string, maxLength: number): string | undefined {
  if (value === undefined || value === null) return undefined
  const s = requireTrimmed(value, field, maxLength)
  return s
}

/**
 * Fail-closed validation of one untrusted leg: unknown kind, bad/naive ISO,
 * end_at <= start_at, missing city, non-https booking link, or junk price all
 * throw. Returns a normalized copy (trimmed strings, uppercased currency).
 */
export function validateTripLeg(raw: unknown): TripLeg {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error('Trip leg must be an object.')
  }
  const o = raw as Record<string, unknown>
  const id = requireTrimmed(o.id, 'id', 200)
  const title = requireTrimmed(o.title, `legs[${id}].title`, 300)
  if (typeof o.kind !== 'string' || !(LEG_KINDS as readonly string[]).includes(o.kind)) {
    throw new Error(`legs[${id}].kind must be one of: ${LEG_KINDS.join(', ')}.`)
  }
  const kind = o.kind as TripLegKind
  if (!isIsoTimestamp(o.start_at)) {
    throw new Error(`legs[${id}].start_at must be ISO-8601 with an explicit zone.`)
  }
  const start_at = (o.start_at as string).trim()
  let end_at: string | null = null
  if (o.end_at !== undefined && o.end_at !== null) {
    if (!isIsoTimestamp(o.end_at)) {
      throw new Error(`legs[${id}].end_at must be ISO-8601 with an explicit zone, or null.`)
    }
    end_at = (o.end_at as string).trim()
    if (toMs(end_at) <= toMs(start_at)) {
      throw new Error(`legs[${id}].end_at must be after start_at.`)
    }
  }
  if (typeof o.location !== 'object' || o.location === null || Array.isArray(o.location)) {
    throw new Error(`legs[${id}].location must be an object with a city.`)
  }
  const locationRaw = o.location as Record<string, unknown>
  const city = requireTrimmed(locationRaw.city, `legs[${id}].location.city`, 200)
  const place = optionalTrimmed(locationRaw.place, `legs[${id}].location.place`, 300)

  const leg: TripLeg = { id, kind, title, start_at, end_at, location: { city } }
  if (place !== undefined) leg.location.place = place

  const ref = optionalTrimmed(o.confirmation_ref, `legs[${id}].confirmation_ref`, 200)
  if (ref !== undefined) leg.confirmation_ref = ref

  if (o.booking_url !== undefined && o.booking_url !== null) {
    const url = requireTrimmed(o.booking_url, `legs[${id}].booking_url`, 2000)
    if (!url.startsWith('https://')) throw new Error(`legs[${id}].booking_url must be https.`)
    leg.booking_url = url
  }
  if (o.confirmed_at !== undefined && o.confirmed_at !== null) {
    if (!isIsoTimestamp(o.confirmed_at)) throw new Error(`legs[${id}].confirmed_at must be ISO-8601 with an explicit zone.`)
    leg.confirmed_at = (o.confirmed_at as string).trim()
  }
  if (o.price_cents !== undefined && o.price_cents !== null) {
    const cents = Number(o.price_cents)
    if (!Number.isInteger(cents) || cents < 0) throw new Error(`legs[${id}].price_cents must be a non-negative integer.`)
    leg.price_cents = cents
  }
  if (o.currency !== undefined && o.currency !== null) {
    const currency = requireTrimmed(o.currency, `legs[${id}].currency`, 8).toUpperCase()
    if (currency.length !== 3) throw new Error(`legs[${id}].currency must be a three-letter code.`)
    leg.currency = currency
  }
  return leg
}

/** Validate a JSON string or an already-parsed array of legs. Throws on anything junk. */
export function parseTripLegs(json: unknown): TripLeg[] {
  let value = json
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value) as unknown
    } catch {
      throw new Error('parseTripLegs: input is not valid JSON.')
    }
  }
  if (!Array.isArray(value)) throw new Error('parseTripLegs: legs must be an array.')
  return value.map((raw) => validateTripLeg(raw))
}

/* ------------------------------------------------------------------ sorting */

/** Chronological; ties broken by id so the order is total and stable. */
export function sortItinerary(legs: readonly TripLeg[]): TripLeg[] {
  return [...legs].sort((a, b) => {
    const diff = startMs(a) - startMs(b)
    if (diff !== 0) return diff
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
  })
}

/* --------------------------------------------------------------- conflicts */

function cityOf(leg: TripLeg): string {
  return leg.location.city.trim().toLowerCase()
}

function utcDateKey(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10)
}

export type FindConflictsOptions = { transbufferMinutes?: number }

/**
 * Every conflict between pairs of legs, ordered deterministically by
 * (earlier start, earlier id, later start, later id). One conflict per pair,
 * chosen by severity: teleport (physics) > overlap (double-booked) >
 * tight-connection (buffer advice).
 */
export function findConflicts(legs: readonly TripLeg[], opts: FindConflictsOptions = {}): Conflict[] {
  const bufferMinutes = opts.transbufferMinutes ?? DEFAULT_TRANS_BUFFER_MINUTES
  if (!Number.isFinite(bufferMinutes) || bufferMinutes <= 0) {
    throw new Error('transbufferMinutes must be a positive number.')
  }
  const timed = sortItinerary(legs).map((leg) => ({ leg, start: startMs(leg), end: endMs(leg) }))
  const conflicts: Conflict[] = []
  const push = (
    a: (typeof timed)[number],
    b: (typeof timed)[number],
    reason: ConflictReason,
    gapMinutes: number,
    note: string,
  ): void => {
    conflicts.push({ reason, leg_ids: [a.leg.id, b.leg.id], gap_minutes: gapMinutes, note })
  }

  for (let i = 0; i < timed.length; i += 1) {
    for (let j = i + 1; j < timed.length; j += 1) {
      const a = timed[i]
      const b = timed[j] // a.start <= b.start by sort
      const sameCity = cityOf(a.leg) === cityOf(b.leg)
      const aStay = a.leg.kind === 'stay'
      const bStay = b.leg.kind === 'stay'
      const gapMinutes = Math.round((b.start - a.end) / 60000)

      // A movement leg's location city is its destination; overlapping a stay
      // from home is normal (the traveler departs mid-booking window).
      const bStationary = STATIONARY_KINDS.includes(b.leg.kind)
      if (b.start < a.end) {
        // Overlapping intervals.
        if (aStay && bStay) {
          if (!sameCity) {
            push(a, b, 'overlap', gapMinutes, `Two stays in different cities (${a.leg.location.city} / ${b.leg.location.city}) overlap and cannot both be kept.`)
          }
        } else if (aStay || bStay) {
          // A service inside a stay is normal in the same city, impossible in another.
          if (!sameCity && bStationary) {
            push(a, b, 'teleport', gapMinutes, `${b.leg.title} in ${b.leg.location.city} overlaps a stay in ${a.leg.location.city}; the traveler cannot be in both.`)
          }
        } else if (!sameCity) {
          push(a, b, 'teleport', gapMinutes, `${b.leg.title} starts in ${b.leg.location.city} before ${a.leg.title} ends in ${a.leg.location.city}; the traveler cannot be in both.`)
        } else {
          push(a, b, 'overlap', gapMinutes, `${a.leg.title} and ${b.leg.title} overlap in ${a.leg.location.city}.`)
        }
        continue
      }

      // Sequential legs: physics rule first, then connection buffers.
      if (!sameCity && bStationary && gapMinutes < TELEPORT_GAP_MINUTES) {
        push(a, b, 'teleport', gapMinutes, `${b.leg.title} starts in ${b.leg.location.city} only ${gapMinutes} min after ${a.leg.title} ends in ${a.leg.location.city}.`)
        continue
      }
      if (
        a.leg.kind === 'flight' &&
        utcDateKey(a.end) === utcDateKey(b.start) &&
        gapMinutes < bufferMinutes &&
        (!sameCity || b.leg.kind === 'flight')
      ) {
        const note = sameCity
          ? `${b.leg.title} departs within ${bufferMinutes} min of landing at ${a.leg.location.city}; allow time between airports.`
          : `${b.leg.title} starts in ${b.leg.location.city} only ${gapMinutes} min after landing at ${a.leg.location.city}; allow ${bufferMinutes} min of transport time.`
        push(a, b, 'tight-connection', gapMinutes, note)
      }
    }
  }
  return conflicts
}

/* ---------------------------------------------------------------- rendering */

const START_FORMAT = new Intl.DateTimeFormat('en-US', {
  weekday: 'short',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
  timeZone: 'UTC',
})
const TIME_FORMAT = new Intl.DateTimeFormat('en-US', {
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
  timeZone: 'UTC',
})
const MONTH_DAY_FORMAT = new Intl.DateTimeFormat('en-US', {
  month: 'short',
  day: 'numeric',
  timeZone: 'UTC',
})

/**
 * One text line per leg, e.g. `Fri 18:00 · AA248 SFO→ORD · Chicago (confirmed ORD887)`.
 * Junk timestamps never crash the renderer: the leg is dropped and replaced by
 * a flagged line so the operator sees the problem. `now` (ISO) annotates legs
 * that have already ended; an invalid `now` is ignored.
 */
export function renderItineraryLines(legs: readonly TripLeg[], now?: string): string[] {
  const nowMs = now !== undefined && isIsoTimestamp(now) ? toMs(now) : Number.NaN
  const ordered = [...legs].sort((a, b) => {
    const at = toMs(a.start_at)
    const bt = toMs(b.start_at)
    const ak = Number.isFinite(at) ? at : Number.MAX_SAFE_INTEGER
    const bk = Number.isFinite(bt) ? bt : Number.MAX_SAFE_INTEGER
    if (ak !== bk) return ak - bk
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
  })

  return ordered.map((leg) => {
    const start = toMs(leg.start_at)
    if (!Number.isFinite(start)) {
      return `[!] ${leg.id} — ${leg.title}: dropped from the itinerary — unreadable start_at ${JSON.stringify(leg.start_at)}`
    }
    let when = START_FORMAT.format(new Date(start))
    const end = leg.end_at === null ? Number.NaN : toMs(leg.end_at)
    if (Number.isFinite(end)) {
      const endAt = new Date(end)
      const sameDay = utcDateKey(start) === utcDateKey(end)
      when += sameDay
        ? `–${TIME_FORMAT.format(endAt)}`
        : `–${MONTH_DAY_FORMAT.format(endAt)} ${TIME_FORMAT.format(endAt)}`
    }
    const location = leg.location.place ? `${leg.location.city}, ${leg.location.place}` : leg.location.city
    let line = `${when} · ${leg.title} · ${location}`
    const ref = typeof leg.confirmation_ref === 'string' && leg.confirmation_ref.trim() !== '' ? leg.confirmation_ref.trim() : null
    if (ref !== null) line += ` (confirmed ${ref})`
    if (Number.isFinite(nowMs) && (Number.isFinite(end) ? end : start) <= nowMs) line += ' · past'
    return line
  })
}

/* ------------------------------------------------------------- card publish */

export type LegsToOptionCardsOptions = {
  /** Fallback freshness ISO instant when a leg carries no confirmed_at. */
  now?: string
}

/**
 * Publishable option cards for the existing `options_published` contract:
 * deduped by leg id, in itinerary order. Provenance is enforced here, at the
 * write boundary — a leg without a booking link may only publish against its
 * own confirmation ref (via the internal placeholder source), and a leg with
 * neither (or with no freshness source) throws instead of fabricating one.
 */
export function legsToOptionCards(
  legs: readonly TripLeg[],
  opts: LegsToOptionCardsOptions = {},
): TaskOption[] {
  if (opts.now !== undefined && !isIsoTimestamp(opts.now)) {
    throw new Error('legsToOptionCards: now must be ISO-8601 with an explicit zone.')
  }
  const cards: TaskOption[] = []
  const seen = new Set<string>()
  for (const leg of sortItinerary(legs)) {
    if (seen.has(leg.id)) continue
    seen.add(leg.id)

    const freshness = leg.confirmed_at ?? opts.now ?? null
    if (freshness === null || !isIsoTimestamp(freshness)) {
      throw new Error(`legsToOptionCards: leg ${leg.id} has no freshness source (confirmed_at or a provided now).`)
    }
    const url = typeof leg.booking_url === 'string' ? leg.booking_url.trim() : ''
    const ref = typeof leg.confirmation_ref === 'string' ? leg.confirmation_ref.trim() : ''
    let sourceUrl: string
    if (url !== '') {
      if (!url.startsWith('https://')) throw new Error(`legsToOptionCards: leg ${leg.id} booking_url must be https.`)
      sourceUrl = url
    } else if (ref !== '') {
      sourceUrl = TRIP_SOURCE_PLACEHOLDER
    } else {
      throw new Error(`legsToOptionCards: leg ${leg.id} carries no booking link and no confirmation ref; refusing to fabricate a source.`)
    }

    const card: TaskOption = {
      id: leg.id,
      title: leg.title,
      reason: `Booked ${leg.kind} in ${leg.location.city}: ${leg.title}`,
      source_url: sourceUrl,
      freshness,
      available: true,
    }
    if (ref !== '') card.source_label = `Confirmation ${ref}`
    if (leg.price_cents !== undefined) card.price_cents = leg.price_cents
    if (leg.currency !== undefined) card.currency = leg.currency
    cards.push(card)
  }
  return cards
}
