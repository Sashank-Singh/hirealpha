import { describe, expect, it } from 'bun:test'
import { isLookupOnlyAsk } from './toolLoop'

/* The guard is inside runToolConversation; this pins the shape it must reject
 * and the shapes it must still allow, using the same patterns. */
const ACTION_ASK_RE = /\b(?:re-?order|order(?:ing| me)?|purchase|pay for|buy (?:me|the|this|that|it|them|two|a|an|another|more|some)\b|book(?:ing)?|reserv(?:e|ing|ation)|fill (?:out )?(?:the )?form|sign me up|check ?out|check (?:my |in )?(?:account|portal|balance|bill)|log ?in|sign ?in|paid in|nightly rate)\b/i
const ASK_BUY_RE = /\b(?:re-?order|buy|buy me|purchase|order(?: me)?|get me|pay for)\b/i
const scheduleAsk = (ask: string) =>
  /\b(?:schedule|calendar|agenda|meetings?|appointments?|what'?s (?:on|next|coming)|today|tomorrow|this (?:week|morning|afternoon))\b/i.test(ask) &&
  !ACTION_ASK_RE.test(ask) &&
  !ASK_BUY_RE.test(ask)

describe('a schedule question is not a browser task', () => {
  it('rejects the question that launched a run', () => {
    expect(scheduleAsk('Whats on schedule today ?')).toBe(true)
    expect(scheduleAsk("what's on my calendar tomorrow")).toBe(true)
    expect(scheduleAsk('what meetings do I have this afternoon')).toBe(true)
  })

  it('still lets a real action through', () => {
    expect(scheduleAsk('book a flight to Chicago today')).toBe(false)
    expect(scheduleAsk('reorder the coffee')).toBe(false)
    expect(scheduleAsk('buy the tickets for tomorrow')).toBe(false)
    expect(scheduleAsk('check my account balance')).toBe(false)
  })
})

describe('a question is not a browser task', () => {
  const ACTION_ASK_RE = /\b(?:re-?order|order(?:ing| me)?|purchase|pay for|buy (?:me|the|this|that|it|them|two|a|an|another|more|some)\b|book(?:ing)?|reserv(?:e|ing|ation)|fill (?:out )?(?:the )?form|sign me up|check ?out|check (?:my |in )?(?:account|portal|balance|bill)|log ?in|sign ?in|paid in|nightly rate)\b/i
  const ASK_BUY_RE = /\b(?:re-?order|buy|buy me|purchase|order(?: me)?|get me|pay for)\b/i
  const questionAsk = (ask: string) =>
    /^\s*(?:what|which|who|when|where|how|is |are |does |do |any |can you tell|tell me)/i.test(ask) &&
    !ACTION_ASK_RE.test(ask) &&
    !ASK_BUY_RE.test(ask)

  /* Live: this exact question staged a Cloud Computer run on Kayak. */
  it('rejects the question that started a run', () => {
    expect(questionAsk('What round trip flights go from New York to Chicago on Sep 25 returning Sep 27, under 400?')).toBe(true)
    expect(questionAsk('How much is a hotel near the Loop this weekend?')).toBe(true)
    expect(questionAsk('Any flights from SFO to JFK tomorrow?')).toBe(true)
  })

  it('still lets a real action through', () => {
    expect(questionAsk('book me a flight to Chicago')).toBe(false)
    expect(questionAsk('order the coffee beans')).toBe(false)
    expect(questionAsk('check my account balance')).toBe(false)
  })
})

describe('a lookup never stages a run', () => {
  /* The roast that produced this: "why is it launching browser session when it
   * can literally search it and find it for free". Six messages per run against
   * a search that already answers (measured: 2 messages, 11.7s). */
  it('recognises the asks a search answers', () => {
    expect(isLookupOnlyAsk('Find a coffee shop near the Loop in Chicago')).toBe(true)
    expect(isLookupOnlyAsk('What round trip flights go from New York to Chicago on Sep 25')).toBe(true)
    expect(isLookupOnlyAsk('See if the Berghoff has a table tonight')).toBe(true)
    expect(isLookupOnlyAsk('How much is the Aeropress on Amazon')).toBe(true)
  })

  it('still lets an action through', () => {
    expect(isLookupOnlyAsk('Book me a table at the Berghoff tonight')).toBe(false)
    expect(isLookupOnlyAsk('Order the coffee beans, two bags')).toBe(false)
    expect(isLookupOnlyAsk('Reserve the hotel and confirm before charging')).toBe(false)
    expect(isLookupOnlyAsk('Check my account balance on the portal')).toBe(false)
  })
})

describe('a price question is a search, not an action', () => {
  it('does not treat "how much is" as a booking verb', () => {
    expect(isLookupOnlyAsk('How much is the Aeropress on Amazon')).toBe(true)
    expect(isLookupOnlyAsk('What are the rates at the Palmer House')).toBe(true)
    // …while a real portal price check still needs the login path.
    expect(isLookupOnlyAsk('Check my account balance on the portal')).toBe(false)
  })
})
