/* A follow-up that repairs the message before it is not a new request.
 *
 * Live: "Find hotel in nye near the airport under 150" (a typo for NYC) sent a
 * whole hotel search to the wrong coast, and the two follow-ups that fixed it —
 * "Nyc I meant" — were each answered as fresh, contextless messages, so the
 * wrong frame survived three turns. The correction is applied to the ask it
 * refers to and the rewritten ask is what the engine runs.
 */

/** Verbs that mean the message is a new ask, not a correction of the last one. */
const NEW_ASK_WORD =
  /\b(?:remind|call|text|email|send|book|reserve|find|search|show|tell|make|add|set|log|track|schedule|plan|create|build|write|draft|play|order|buy)\b/i

/** Longest a correction may be; anything longer is a sentence of its own. */
const MAX_CORRECTION_WORDS = 6

export type CorrectionShape = {
  /** The text that should replace the wrong part of the previous ask. */
  value: string
  /** A token the user is explicitly rejecting ("not SF, NYC"). */
  wrong?: string
}

/**
 * Read the follow-up as a correction, or null when it is anything else.
 * High precision on purpose: "I meant to call mom, remind me" is a new request,
 * so a verb in the text or a long sentence disqualifies it.
 */
export function readCorrection(followUp: string): CorrectionShape | null {
  const text = String(followUp || '').trim().replace(/[.!]+$/, '')
  if (!text || text.split(/\s+/).length > MAX_CORRECTION_WORDS) return null
  if (NEW_ASK_WORD.test(text)) return null

  // "not sf, i meant nyc"
  const notMeant = /^not\s+(.{1,40}?)[,;]?\s+(?:i\s+)?meant\s+(.{1,40})$/i.exec(text)
  if (notMeant) return { wrong: notMeant[1]!.trim(), value: notMeant[2]!.trim() }

  // "i meant nyc" / "meant nyc" / "i meant to say nyc"
  const meant = /^(?:no[,.]?\s*)?(?:i\s+)?meant\s+(?:to say\s+|to\s+say\s+)?(.{1,40})$/i.exec(text)
  if (meant) return { value: meant[1]!.trim() }

  // "nyc i meant" / "nyc, i meant"
  const trailing = /^(.{1,40}?)[,]?\s+(?:i\s+)?meant$/i.exec(text)
  if (trailing) return { value: trailing[1]!.trim() }

  // "typo: nyc"
  const typo = /^typo:?\s*(.{1,40})$/i.exec(text)
  if (typo) return { value: typo[1]!.trim() }

  return null
}

/** Levenshtein distance, capped: only ever used to ask "is this the same word,
 * mistyped" so a difference beyond the cap is the same answer as the cap. */
function distance(a: string, b: string, cap = 3): number {
  if (a === b) return 0
  if (Math.abs(a.length - b.length) > cap) return cap + 1
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i)
  for (let i = 1; i <= a.length; i++) {
    const row = [i]
    for (let j = 1; j <= b.length; j++) {
      row[j] = Math.min(prev[j]! + 1, row[j - 1]! + 1, prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1))
    }
    prev = row
  }
  return prev[b.length]!
}

function similar(a: string, b: string): boolean {
  const x = a.toLowerCase().replace(/[^a-z0-9]/g, '')
  const y = b.toLowerCase().replace(/[^a-z0-9]/g, '')
  if (!x || !y) return false
  if (x === y) return true
  if (Math.min(x.length, y.length) < 3) {
    // Short tokens are only ever a mistyped version of the correction when one
    // continues the other ("jf" → "jfk"), never when they merely share letters.
    return (x.length < y.length && y.startsWith(x) && y.length - x.length === 1)
      || (y.length < x.length && x.startsWith(y) && x.length - y.length === 1)
  }
  return distance(x, y, 2) <= 2
}

/** Replace a token, keeping the casing the ask was written in. */
function withCasing(token: string, replacement: string): string {
  if (token === token.toLowerCase()) return replacement.toLowerCase()
  if (token === token.toUpperCase() && token.length > 1) return replacement.toUpperCase()
  return replacement
}

/* ---- Refinements: the same request with one thing changed ---- */

/* Phrases that only make sense as a change to what came before. They outrank
 * the new-ask guard below, because "make it cheaper" is a refinement while
 * "make me a ping pong game" is a request. */
const REFINEMENT_MARKER =
  /\b(?:but (?:for|next|on|with)|instead|actually|same (?:but|thing)|make it|what about|how about|change (?:it|that|the)|switch (?:it|to)|for next (?:week|month)|next week|(?:mon|tues|wednes|thurs|fri|satur|sun)day to|shift it|move it|push it|cheaper|more expensive|different dates?)\b|\bno\b[,\s]/i

/** Constraint shapes that read as "same ask, new number": dates, party size,
 * money. Used only together with a marker, never on their own. */
const CONSTRAINT_SHAPE =
  /\b(?:under|over|below|above|around|about|max(?:imum)?|budget of?|for \d+|for (?:one|two|three|four|five|six)|next|this|tomorrow|tonight|weekend|week|month|\d{1,2}(?:st|nd|rd|th)?(?: to \d{1,2}(?:st|nd|rd|th)?)?|jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?|\d{1,4}(?: ?- ?\d{1,4})?|cheap(?:er)?|expensive|nicer|closer|farther|bigger|smaller|walkable|downtown|airport)\b/i

/** Longest a refinement may be. Past this it is its own request. */
const MAX_REFINEMENT_WORDS = 20

export type RefinementShape = { text: string }

/**
 * Read the follow-up as a change to the previous request, or null.
 * "Bot new years eye but for next week Monday to Thursday" is a refinement of a
 * hotel ask. "Find hotels in Boston" is a new request even though it is short:
 * it carries no marker pointing back at what came before.
 */
export function readRefinement(followUp: string): RefinementShape | null {
  const text = String(followUp || '').trim()
  if (!text) return null
  if (text.split(/\s+/).length > MAX_REFINEMENT_WORDS) return null
  const marker = REFINEMENT_MARKER.test(text)
  if (!marker) return null
  // A marked change still has to name something to change.
  if (!CONSTRAINT_SHAPE.test(text)) return null
  // With a marker present a bare verb is fine in the short shapes ("make it
  // cheaper"), but a longer imperative sentence is a new request.
  if (!/^\s*(?:make it|what about|how about|same|no\b|instead|actually)\b/i.test(text) && NEW_ASK_WORD.test(text)) return null
  return { text }
}

/**
 * The ask the engine should run for a refinement: the original request with the
 * change named explicitly, so the model keeps the city, the airport, and the
 * budget it already had while applying the new dates. The user's own words are
 * carried verbatim; the surrounding wording only says how to read them.
 */
export function rewriteWithRefinement(previousAsk: string | null | undefined, followUp: string): string | null {
  const refinement = readRefinement(followUp)
  const ask = String(previousAsk || '').trim()
  if (!refinement || !ask) return null
  return `${ask}\n\nThe user then refined that request: "${followUp.trim()}". Everything not named in the refinement still stands, so keep the place, the kind of search, and the constraints from the original request and apply only this change.`
}

/**
 * The ask the engine should run, given the user's previous request and a
 * follow-up correction. Returns null when the follow-up is not a correction or
 * there is nothing to correct.
 */
export function rewriteWithCorrection(previousAsk: string | null | undefined, followUp: string): string | null {
  const correction = readCorrection(followUp)
  const ask = String(previousAsk || '').trim()
  if (!correction || !ask) return null

  const words = correction.value.split(/\s+/).filter(Boolean)
  const tokens = ask.split(/(\s+)/)

  // "nye" → "nyc": replace the token the user is fixing, so the wrong word is
  // gone rather than sitting next to its own correction.
  let replaced = false
  const next = tokens.map((token) => {
    if (/^\s+$/.test(token)) return token
    const bare = token.replace(/[^A-Za-z0-9]/g, '')
    if (!bare) return token
    const wrong = correction.wrong ? similar(bare, correction.wrong) : false
    const typo = words.length === 1 && similar(bare, correction.value)
    if (wrong || typo) {
      replaced = true
      return token.replace(bare, withCasing(bare, correction.value))
    }
    return token
  })
  if (replaced) return next.join('').replace(/\s+/g, ' ').trim()

  // Nothing resembled the correction (a new detail, not a fixed word): keep the
  // ask and let the correction override, named as such so the model cannot
  // treat it as a passing remark.
  return `${ask}\n\nCorrection from the user, this replaces the part of the request above it contradicts: ${followUp.trim()}`
}

/** The user's own previous request, from the thread history. */
export function previousUserAsk(history: Array<{ role: string; content: string }> | undefined, currentText: string): string | null {
  const turns = (history || []).filter((m) => m.role === 'user' && String(m.content || '').trim())
  for (let i = turns.length - 1; i >= 0; i--) {
    const text = String(turns[i]!.content).trim()
    // The current message may already be the last entry; skip it and anything
    // that is itself a correction (a chain of corrections still points at the
    // real request).
    if (text === currentText.trim()) continue
    if (readCorrection(text)) continue
    return text
  }
  return null
}
