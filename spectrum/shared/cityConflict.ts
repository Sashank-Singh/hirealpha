/**
 * Deterministic trip-city conflict check.
 *
 * The benchmark case this exists for: a Chicago hotel/trip gets planned in the
 * thread, then a later message asks for dinner "in New York" — and the old
 * turn engine searched New York without ever noticing the Chicago plan (public
 * rehearsal, 2026-09-12: `city: searches or books NY without asking`). The
 * model cannot be trusted to re-read the thread for this every turn, so the
 * check is a pure function over the same inputs the turn already has: recent
 * history, durable facts, and the server's memory list.
 *
 * It only detects. The caller decides what to do (here: suppress the automatic
 * place lookup and ask one confirming line before searching or booking).
 */
import type { ChatMessage } from '../../src/agents/types'

export type CityConflict = {
  /** City from the earlier trip/hotel/flight plan. */
  tripCity: string
  /** City the current ask is about. */
  askCity: string
  /** The quoted trip line, for the confirmation question and logs. */
  evidence: string
}

export type CityFactLike = { key: string; value: string; updatedAt?: string; at?: number }

/** Place asks that must not silently jump cities. */
const PLACE_ASK =
  /\b(?:dinner|lunch|brunch|breakfast|restaurant|restaurants|hotel|hotels|hostel|airbnb|stay|table|reservation|book|booking|bar|bars|drinks|coffee|spot|place to eat|eat)\b/i
/** Lines that describe a trip/lodging plan (candidate trip anchors). */
const TRIP_PLAN =
  /\b(?:hotel|hostel|airbnb|stay|trip|travel|travelling|traveling|flight|flights|fly|flying|airfare|itinerary|visit|visiting|check(?:ing)? in)\b/i
/** Explicit replanning language: the user already told us the city changed. */
const REPLAN =
  /\b(?:instead|change of plans|changed plans|no longer|scratch that|rather than|switched to|we(?:'| a)re going to|actually (?:it'?s|we))|not [^.!?\n]{2,30} anymore\b/i

const TIME_WORDS = new Set([
  'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday',
  'january', 'february', 'march', 'april', 'may', 'june', 'july', 'august',
  'september', 'october', 'november', 'december',
  'today', 'tomorrow', 'tonight', 'morning', 'afternoon', 'evening', 'weekend',
  'week', 'month', 'year',
])

const REJECT_WORDS = new Set([
  'the', 'a', 'an', 'my', 'our', 'town', 'general', 'advance', 'front', 'total',
  'person', 'people', 'fact', 'question', 'side', 'area', 'loop', 'downtown',
])

const CITY_ALIASES: Record<string, string> = {
  nyc: 'new york',
  ny: 'new york',
  'new york city': 'new york',
  sf: 'san francisco',
  'san fran': 'san francisco',
  la: 'los angeles',
  dc: 'washington',
  'washington dc': 'washington',
  chi: 'chicago',
  philly: 'philadelphia',
}

/** Normalized city name, or null when the match is not a place. */
export function normalizeCity(raw: string | null | undefined): string | null {
  if (!raw) return null
  const words = raw
    .replace(/[.,;:!?'"]+$/g, '')
    .trim()
    .split(/\s+/)
    // "Chicago Friday" must read as Chicago: stop at the first time word.
    .filter((w) => {
      if (TIME_WORDS.has(w.toLowerCase())) return false
      return true
    })
    .filter((w) => !REJECT_WORDS.has(w.toLowerCase()))
  if (!words.length) return null
  const joined = words.join(' ').toLowerCase()
  const aliased = CITY_ALIASES[joined] || joined
  // Reject the stop words only when they are the whole candidate.
  if (aliased.length < 2) return null
  return aliased
}

/**
 * Last city named in a line. "from New York to Chicago" → Chicago, because the
 * destination is what the trip is about.
 */
export function citiesIn(text: string): string[] {
  const found: string[] = []
  const re = /\b(?:in|to|near|around|from|at|downtown)\s+([A-Z][a-zA-Z.'-]+(?:\s+[A-Z][a-zA-Z.'-]+){0,2})/g
  let match: RegExpExecArray | null
  while ((match = re.exec(text))) {
    const city = normalizeCity(match[1])
    if (city && !found.includes(city)) found.push(city)
  }
  return found
}

function lastCity(text: string): string | null {
  const cities = citiesIn(text)
  return cities.length ? cities[cities.length - 1]! : null
}

function recentEnough(ts: number | undefined, now: number, windowDays: number): boolean {
  // Missing timestamps are treated as current: the raw thread store stamps
  // every message, so a missing ts is a legacy row, not an old one.
  if (typeof ts !== 'number' || !Number.isFinite(ts)) return true
  return now - ts <= windowDays * 86_400_000
}

/**
 * The most recent trip/lodging plan in the raw thread (within the window).
 * Facts are only a fallback and only when they carry a recent timestamp.
 */
export function findActiveTrip(input: {
  history: ChatMessage[]
  facts?: CityFactLike[]
  windowDays?: number
  now?: number
}): { city: string; evidence: string } | null {
  const now = input.now ?? Date.now()
  const windowDays = input.windowDays ?? 14
  for (let i = input.history.length - 1; i >= 0; i--) {
    const message = input.history[i]!
    if (message.role !== 'user') continue
    if (!recentEnough(message.ts, now, windowDays)) continue
    if (!TRIP_PLAN.test(message.content)) continue
    const city = lastCity(message.content)
    if (city) return { city, evidence: message.content }
  }
  for (const fact of input.facts || []) {
    if (!/travel|trip|hotel|flight|itinerary|lodging/i.test(fact.key)) continue
    const ts = fact.at ?? (fact.updatedAt ? Date.parse(fact.updatedAt) : undefined)
    if (!recentEnough(ts, now, windowDays)) continue
    const city = lastCity(fact.value)
    if (city) return { city, evidence: `${fact.key}: ${fact.value}` }
  }
  return null
}

/**
 * Non-null when the current ask names a place city that contradicts the active
 * trip. `REPLAN` language ("actually we're going to New York instead") turns it
 * off: the user has already relabeled the trip, so there is nothing to confirm.
 */
export function detectCityConflict(input: {
  userText: string
  history: ChatMessage[]
  facts?: CityFactLike[]
  windowDays?: number
  now?: number
}): CityConflict | null {
  const text = input.userText.trim()
  if (!text || !PLACE_ASK.test(text) || REPLAN.test(text)) return null
  const askCity = lastCity(text)
  if (!askCity) return null
  const trip = findActiveTrip({
    history: input.history,
    facts: input.facts,
    windowDays: input.windowDays,
    now: input.now,
  })
  if (!trip || trip.city === askCity) return null
  return { tripCity: trip.city, askCity, evidence: trip.evidence }
}

/** One instruction line for the model when a conflict fires. */
export function cityConflictInstruction(conflict: CityConflict): string {
  const trip = conflict.evidence.length > 140 ? `${conflict.evidence.slice(0, 140)}…` : conflict.evidence
  return `CITY CONFLICT (deterministic check, do not ignore): the trip planned in this thread is in ${conflict.tripCity} ("${trip}"), but this message asks about a place in ${conflict.askCity}. Do NOT search or book ${conflict.askCity}. Ask one short line first to confirm which city they mean for this plan — mention the earlier ${conflict.tripCity} plan — then proceed once they answer.`
}

/** Title-case a normalized city for copy ("new york" → "New York"). */
function titleCity(city: string): string {
  return city.replace(/\b[a-z]/g, (c) => c.toUpperCase())
}

/**
 * The confirmation question, answered without the model.
 *
 * Live rehearsal behavior was "searches or books NY without asking"; a prompt
 * instruction alone leaves that to the same model that missed it. When the
 * conflict is confirmed by the deterministic check the turn asks here and
 * nowhere else — no lookup, no booking, nothing to ignore.
 */
export function cityConflictReply(conflict: CityConflict): string {
  return `Quick check before I dig in — the plan in our thread is ${titleCity(conflict.tripCity)}, but you just asked about ${titleCity(conflict.askCity)}. Is this one in ${titleCity(conflict.askCity)}, or did you mean ${titleCity(conflict.tripCity)}? Say the word and I'll take it from there.`
}
