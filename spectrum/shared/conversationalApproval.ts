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
  // Approval is a closed grammar, never a substring in advice or a condition.
  // The server separately binds this intent to the immutable pending terms.
  if (/[?？]/.test(text) || NEGATION_PATTERNS.some((pattern) => pattern.test(text))) return false
  const norm = normalize(text).replace(/^(?:please )|(?: please| to me| for me)$/, '').trim()
  if (AFFIRMATIVE_TOKENS.has(norm) || AFFIRMATIVE_PHRASES.includes(norm)) return true
  if (AFFIRMATIVE_PHRASES.some((left) => AFFIRMATIVE_PHRASES.some((right) => norm === `${left} ${right}`))) return true
  const clauses = norm.split(/\s+/)
  const first = clauses.shift() || ''
  return AFFIRMATIVE_TOKENS.has(first) && AFFIRMATIVE_PHRASES.includes(clauses.join(' '))

}

/**
 * Checks if the user's message indicates they want to cancel or dismiss the pending purchase.
 */
export function isNegativeCancellationIntent(text: string): boolean {
  const norm = normalize(text)
  if (!norm) return false

  if (/^(?:no|nope|nah|cancel|cancel it|cancel that|don t|do not|nevermind|never mind|nvm|stop|wait|hold on|pass|forget it|forget that)$/.test(norm)) {
    return true
  }

  return /\b(?:cancel (?:it|that|the order|order|this)|don t (?:buy|order|charge|get|do (?:it|that))|never ?mind|nvm|not that one|forget it|forget that|call (?:it|that) off|leave it|scrap (?:it|that))\b/.test(norm)
}

/* ---- Typed pending-operation reply routing ----
 *
 * The deterministic gate previously collapsed every non-affirmative reply into
 * one "questions or conditions do not approve it" message. A status question
 * ("did it go through?") and a cancellation ("actually nvm") are different
 * intents with different durable effects, and the typed pending-operation
 * state (we KNOW what is pending) is what makes this classification safe
 * without an LLM call: the possible intents are bounded by what is on the
 * table. */

export type PendingReplyKind =
  | 'approve'
  | 'deny'
  | 'cancel'
  | 'question'
  | 'conditional'
  | 'correction'
  | 'status_query'
  | 'other'

const CONDITIONAL_RE =
  /\b(?:but|only if|unless|as long as|provided that|if the |if it |if shipping|after you|first (?:check|confirm))\b/i

const CORRECTION_RE =
  /\b(?:no[,.]?\s+(?:get|use|take|do|go|try)|get the other|use the other|the other one|not that one|wrong one|different one|change (?:it|that) to|swap (?:it|that)(?: for| to))\b/i

const STATUS_QUERY_RE =
  /\b(?:did (?:it|that|the (?:payment|order|purchase|charge)) (?:go through|go thru|work|land)|did (?:my )?(?:payment|card|order) (?:get charged|go through|work)|(?:is|was) (?:it|that) (?:charged|paid|ordered|done)|has (?:it|that) (?:gone through|been charged|landed)|what(?:'s| is) (?:the )?(?:status|update)|went through\??$|charged yet|did you (?:charge|buy|order))\b/i

/** Classify a reply that arrives while a typed pending operation exists.
 * Deterministic on purpose: the pending row defines the whole action space,
 * so a bounded recognizer beats a model call that could hallucinate an
 * approval. Order matters: status → question → conditional → correction →
 * cancel → approve. */
export function classifyPendingReply(text: string): PendingReplyKind {
  const norm = normalize(text)
  if (!norm) return 'other'
  const hasQuestionMark = /[?？]/.test(text)

  if (STATUS_QUERY_RE.test(norm)) return 'status_query'

  if (CORRECTION_RE.test(norm)) return 'correction'
  if (isNegativeCancellationIntent(text)) return 'cancel'

  // A question with no approval grammar in it is a question, never a "no".
  if (hasQuestionMark && !isAffirmativeApprovalIntent(text)) return 'question'

  if (isAffirmativeApprovalIntent(text)) {
    // "yes but only if shipping is free" is a condition, not unconditional
    // approval: the terms on the card are immutable, so a condition can never
    // approve them silently.
    if (CONDITIONAL_RE.test(text)) return 'conditional'
    return 'approve'
  }
  if (hasQuestionMark) return 'question'
  if (CONDITIONAL_RE.test(norm)) return 'conditional'
  return 'other'
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

