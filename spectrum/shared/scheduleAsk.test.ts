import { describe, expect, it } from 'bun:test'
import { isLookupOnlyAsk, isSchedulingAsk } from './toolLoop'
import { mentionsDigest, digestControlIntent } from './reminders'

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

describe('a schedule write is not a freshness lookup', () => {
  /* Live: three runs of the bench digest sentence produced three outcomes —
   * a real row, a narrated "scheduler is rejecting it", and the freshness
   * gate's canned "web lookup did not run" — because the classifier read the
   * sentence as needsLookup and no tool could satisfy it. */
  it('recognises the digest phrasings that need a row, not the web', () => {
    expect(isSchedulingAsk('On weekdays at 7:00 AM send me a digest with my calendar, the replies I owe, and the weather.')).toBe(true)
    expect(isSchedulingAsk('set up my morning digest')).toBe(true)
    expect(isSchedulingAsk('send me my digest')).toBe(true)
    expect(isSchedulingAsk('remind me every Monday at 9 to send the invoice')).toBe(true)
    expect(isSchedulingAsk('pause my digest')).toBe(true)
  })

  it('leaves questions and lookups alone', () => {
    expect(isSchedulingAsk('when does my brief come')).toBe(false)
    expect(isSchedulingAsk('what time is my digest')).toBe(false)
    expect(isSchedulingAsk('remind me how much the Aeropress costs')).toBe(false)
    expect(isSchedulingAsk('find a coffee shop near the Loop')).toBe(false)
  })
})

describe('digest phrasing reaches the deterministic path', () => {
  it('matches the verb shapes the old pattern missed', () => {
    expect(mentionsDigest('On weekdays at 7:00 AM send me a digest with my calendar')).toBe(true)
    expect(mentionsDigest('send me a digest with my calendar, the replies I owe, and the weather')).toBe(true)
    expect(mentionsDigest('set me up a weekday brief at 7am')).toBe(true)
  })

  it('still recognises the old shapes', () => {
    expect(mentionsDigest('morning digest')).toBe(true)
    expect(mentionsDigest('my daily brief is late')).toBe(true)
    expect(mentionsDigest('what time does my digest come')).toBe(true)
  })

  it('is not fooled by unrelated text', () => {
    expect(mentionsDigest('find a coffee shop near the Loop')).toBe(false)
    expect(mentionsDigest('the email mentioned a brief delay')).toBe(false)
  })
})
