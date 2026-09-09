/**
 * Natural conversational approval & cancellation intent recognition.
 *
 * Avoids rigid keyword constraints: understands conversational affirmations
 * ("sounds good", "go for it", "let's do that", "that works", "grab that one",
 * "place the order", "charge it", "yes please", "sure thing", "definitely")
 * as well as clear cancellations ("no", "cancel that", "don't buy it", "never mind"),
 * while rejecting ambiguous questions or negated phrases.
 */

const AFFIRMATIVE_TOKENS = new Set([
  'approve',
  'yes',
  'yep',
  'yeah',
  'yea',
  'confirm',
  'pay',
  'buy',
  'order',
  'proceed',
  'sure',
  'ok',
  'okay',
  'k',
  'kk',
  'perfect',
  'totally',
  'definitely',
  'accepted',
])

const AFFIRMATIVE_PHRASES = [
  'buy it',
  'buy that',
  'buy this',
  'order it',
  'order that',
  'order this',
  'place the order',
  'place order',
  'go ahead',
  'go for it',
  'let s do it',
  'lets do it',
  'let s do that',
  'lets do that',
  'do it',
  'sounds good',
  'sounds great',
  'sounds fine',
  'looks good',
  'looks great',
  'that works',
  'that s fine',
  'thats fine',
  'that s the one',
  'thats the one',
  'grab it',
  'grab that',
  'grab that one',
  'get it',
  'get that',
  'get that one',
  'charge it',
  'charge my card',
  'yes please',
  'sure thing',
  'all good',
]

const NEGATION_PATTERNS = [
  /\b(?:don'?t|do not|wait|stop|no|cancel|nevermind|never mind|hold on|wrong|pass|nope|nah)\b/i,
]

function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/[’']/g, ' ')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * Checks if the user's message expresses affirmative agreement to proceed with a purchase/spend.
 */
export function isAffirmativeApprovalIntent(text: string): boolean {
  const norm = normalize(text)
  if (!norm) return false

  // 1. Direct single-word or short token match
  if (AFFIRMATIVE_TOKENS.has(norm)) return true

  // 2. Exact match against common conversational confirmation phrases
  for (const phrase of AFFIRMATIVE_PHRASES) {
    if (norm === phrase) return true
  }

  // 3. If there is clear negation or hesitation, it is NOT an approval
  for (const neg of NEGATION_PATTERNS) {
    if (neg.test(text)) return false
  }

  // If the user is asking to find, search, or look up something new, it's not an approval of the old item
  if (/\b(?:can you (?:find|search|look)|find (?:me|a|some)|search for|look up|show me)\b/i.test(text)) {
    return false
  }

  // 4. Substring phrase match when not negated
  for (const phrase of AFFIRMATIVE_PHRASES) {
    if (norm.includes(phrase)) return true
  }

  // 5. Short sentences starting or ending with affirmative tokens
  const words = norm.split(' ')
  if (words.length <= 4) {
    if (words.some((w) => AFFIRMATIVE_TOKENS.has(w))) {
      // Must not be a question
      if (text.includes('?')) return false
      return true
    }
  }

  return false
}

/**
 * Checks if the user's message indicates they want to cancel or dismiss the pending purchase.
 */
export function isNegativeCancellationIntent(text: string): boolean {
  const norm = normalize(text)
  if (!norm) return false

  if (/^(?:no|nope|nah|cancel|cancel it|cancel that|don t|do not|nevermind|never mind|stop|wait|hold on|pass)$/.test(norm)) {
    return true
  }

  return /\b(?:cancel (?:it|that|the order|order)|don t (?:buy|order|charge|get)|never ?mind|not that one|forget it)\b/.test(norm)
}

const CASUAL_TOKENS = new Set([
  'thanks',
  'thank',
  'thx',
  'ty',
  'cheers',
  'appreciate',
  'ok',
  'okay',
  'k',
  'kk',
  'got',
  'sounds',
  'cool',
  'nice',
  'awesome',
  'great',
  'perfect',
  'bet',
  'sure',
  'thing',
  'alright',
  'np',
  'problem',
  'haha',
  'hahaha',
  'lol',
  'lmao',
  'rofl',
  'hehe',
  'bye',
  'night',
  'gn',
  'ya',
  'see',
  'cya',
  'later',
  'talk',
  'soon',
  'yes',
  'yeah',
  'yep',
  'no',
  'nah',
  'nope',
  'good',
  'all',
])

const CASUAL_PHRASES = new Set([
  'thanks',
  'thank you',
  'thanks a lot',
  'thank you so much',
  'thx',
  'ty',
  'cheers',
  'appreciate it',
  'ok',
  'okay',
  'k',
  'kk',
  'got it',
  'sounds good',
  'sounds great',
  'cool',
  'cool thanks',
  'nice',
  'awesome',
  'great',
  'perfect',
  'bet',
  'sure',
  'sure thing',
  'alright',
  'all good',
  'no problem',
  'np',
  'haha',
  'hahaha',
  'lol',
  'lmao',
  'bye',
  'good night',
  'gn',
  'see ya',
  'see you',
  'later',
  'talk soon',
])

/**
 * Checks if a user's message is quick conversational banter or an acknowledgment
 * (e.g., "thanks", "got it", "cool", "sounds good", "haha").
 * Such messages should NEVER trigger unsolicited mini-app cards.
 */
export function isCasualChitChat(text: string): boolean {
  const norm = normalize(text)
  if (!norm) return true
  if (CASUAL_PHRASES.has(norm)) return true

  const words = norm.split(' ')
  if (words.length <= 4 && words.every((w) => CASUAL_TOKENS.has(w) || ['you', 'it', 'to', 'for', 'man', 'bro', 'dude', 'so', 'much', 'a', 'lot'].includes(w))) {
    return true
  }

  return false
}

