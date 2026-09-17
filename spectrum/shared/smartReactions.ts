import type { ChatMessage } from '../../src/agents/types'
import { loadMemory } from './memory'

/** 15 minutes of inactivity marks a new conversation start. */
export const CONVERSATION_SESSION_GAP_MS = 15 * 60 * 1000

const CONTINUATION_FRAGMENT_REGEX =
  /^(?:yes|yeah|yep|no|nope|sure|ok|okay|sounds good|thanks|thank you|cool|got it|perfect|that one|confirm|cancel|large|medium|small|\d+)[.!?\s]*$/i

/**
 * Checks whether an incoming message is the first text of a new conversation
 * rather than an ongoing follow-up.
 */
export function isConversationStart(
  history: ChatMessage[],
  userText: string,
  now = Date.now(),
  gapMs = CONVERSATION_SESSION_GAP_MS,
): boolean {
  const trimmed = userText.trim()
  if (!trimmed) return false

  // Clear trailing answer/confirmation tokens are follow-ups
  if (CONTINUATION_FRAGMENT_REGEX.test(trimmed)) {
    return false
  }

  if (!history || history.length === 0) {
    return true
  }

  const lastMsg = history[history.length - 1]
  const lastTs = lastMsg?.ts ?? 0
  if (!lastTs) return true

  const elapsed = now - lastTs
  return elapsed >= gapMs
}

/**
 * Intelligently select an emoji reaction based on what the user talks about.
 * Returns null when no reaction is needed.
 */
export function selectSmartReaction(userText: string): string | null {
  const text = userText.trim().toLowerCase()
  if (!text) return null

  // 1. Food & dining specifics (highest precedence)
  if (/\b(pizza|pizzas|slice|pepperoni|margherita|dominos|domino's|pizza hut)\b/i.test(text)) {
    return '🍕'
  }
  if (/\b(rice|jasmine rice|basmati|fried rice)\b/i.test(text)) {
    return '🍚'
  }
  if (/\b(sushi|sashimi|nigiri|ramen|noodles?)\b/i.test(text)) {
    return '🍣'
  }
  if (/\b(burgers?|cheeseburgers?|fries|shake shack|five guys)\b/i.test(text)) {
    return '🍔'
  }
  if (/\b(tacos?|burritos?|quesadillas?|chipotle)\b/i.test(text)) {
    return '🌮'
  }
  if (/\b(coffee|espresso|latte|cappuccino|cold brew|starbucks)\b/i.test(text)) {
    return '☕'
  }
  if (/\b(beer|beers|brewery|cocktail|cocktails|wine|drinks?|bar)\b/i.test(text)) {
    return '🍺'
  }
  if (/\b(restaurants?|places? to eat|where to eat|dinner|lunch|breakfast|food near me|eat out)\b/i.test(text)) {
    return '🍽️'
  }

  // 2. Email & Inbox checks
  if (/\b(what'?s important in my email|important emails?|check (?:my )?(?:email|mail|inbox)|unread emails?|summarize (?:my )?(?:email|mail)|catch me up on (?:email|mail))\b/i.test(text)) {
    return '👍'
  }
  if (/\b(draft (?:an? )?email|send (?:an? )?email|email to)\b/i.test(text)) {
    return '✉️'
  }

  // 3. News, Research & Lookups
  if (/\b(domain|domains|whois|lookup|dns|ssl|code|repo|github|ip|stacksync|investigate|check availability)\b/i.test(text)) {
    return '🔍'
  }
  if (/\b(what'?s the news|any news|latest news|breaking news|news today|what happened (?:today|this morning|with))\b/i.test(text)) {
    return '❓'
  }

  // 4. Buying / Purchases / Orders
  if (/\b(books?|novel|kindle)\b/i.test(text) && /\b(buy|order|get|read|purchase)\b/i.test(text)) {
    return '📚'
  }
  if (/\b(flowers?|roses?|bouquet)\b/i.test(text)) {
    return '💐'
  }
  if (/\b(shoes?|sneakers?|boots?|clothes|shirt|hoodie|jacket)\b/i.test(text)) {
    return '👟'
  }
  if (/\b(groceries|grocery)\b/i.test(text)) {
    return '🛒'
  }
  if (/\b(buy|buy me|purchase|order me|pay for|how much (?:is|does))\b/i.test(text)) {
    return '💵'
  }

  // 5. Calendar, Schedule & Meetings
  if (/\b(calendar|schedule|agenda|my day today|what do i have today|meetings?|calls? today)\b/i.test(text)) {
    return '🗓️'
  }

  // 6. Reminders & Alarms
  if (/\b(timer|in \d+\s*(?:min|minute|sec|second|hour))\b/i.test(text)) {
    return '⏲️'
  }
  if (/\b(remind me|set a reminder|alarm)\b/i.test(text)) {
    return '⏰'
  }

  // 7. Travel, Flights & Hotels
  if (/\b(flights?|fly|flying|airport|vacation|trip to)\b/i.test(text)) {
    return '✈️'
  }
  if (/\b(hotels?|airbnb|lodging|places? to stay)\b/i.test(text)) {
    return '🏨'
  }

  // 8. Fitness & Health
  if (/\b(workout|gym|lift|lifting|bench|squat|exercise)\b/i.test(text)) {
    return '💪'
  }
  if (/\b(run|running|ran|jog|jogging|5k|10k|marathon)\b/i.test(text)) {
    return '🏃'
  }
  if (/\b(sleep|slept|bedtime|insomnia|nap)\b/i.test(text)) {
    return '😴'
  }

  // 9. Celebrations & Milestones
  if (/\b(i got the job|got promoted|we won|we did it|congrats|congratulations|passed the exam|closed the round|raised money)\b/i.test(text)) {
    return '🎉'
  }

  // 10. Gratitude & Affection
  if (/\b(thank you so much|thanks so much|love you|you'?re the best|you rock)\b/i.test(text)) {
    return '❤️'
  }

  // 11. Humor
  if (/\b(haha|hahaha|lmao|rofl|that'?s hilarious|lol)\b/i.test(text)) {
    return '😂'
  }

  // Default: be smart — don't react if it doesn't warrant one
  return null
}

/**
 * Determine if an inbound message should receive an immediate emoji reaction.
 * Only reacts to the beginning of a conversation, and only when the content calls for it.
 */
export function determineInboundReaction(input: {
  dataDir: string
  senderId: string
  userText: string
  now?: number
}): string | null {
  const mem = loadMemory(input.dataDir, input.senderId)
  if (!isConversationStart(mem.history, input.userText, input.now)) {
    return null
  }
  return selectSmartReaction(input.userText)
}

/**
 * Turns that must pass before the next tapback. The first message of a thread
 * still gets an instant reaction (that is {@link determineInboundReaction});
 * inside a live conversation a reaction every turn stops reading as a person
 * and starts reading as a bot agreeing with itself.
 */
export const REACTION_MIN_TURN_GAP = 4

/**
 * Mid-conversation tapback rhythm. Counting turns (rather than wall-clock) is
 * what keeps the texture human: two texts a minute apart in a live back-and-
 * forth are still two turns, and reacting to the second one is what a friend
 * does not do.
 */
export function createTapbackRhythm(options: { minTurnGap?: number } = {}) {
  const minTurnGap = options.minTurnGap ?? REACTION_MIN_TURN_GAP
  const turnsSince = new Map<string, number>()

  return {
    /**
     * Count this inbound turn and return a reaction only on turns that earned
     * one. Confirmation fragments ("ok", "yes", a bare number) never do — they
     * are answers to us, not things we react to.
     */
    note(senderId: string, userText: string): string | null {
      const trimmed = userText.trim()
      if (!trimmed) return null
      const turns = (turnsSince.get(senderId) ?? 0) + 1
      if (CONTINUATION_FRAGMENT_REGEX.test(trimmed)) {
        turnsSince.set(senderId, turns)
        return null
      }
      const reaction = selectSmartReaction(trimmed)
      if (!reaction || turns < minTurnGap) {
        turnsSince.set(senderId, turns)
        return null
      }
      turnsSince.set(senderId, 0)
      return reaction
    },

    /** A tapback already went out this turn; wait out the gap again. */
    reset(senderId: string) {
      turnsSince.set(senderId, 0)
    },
  }
}
