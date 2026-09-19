import { describe, expect, it } from 'bun:test'
import { draftLooksLikeImageWork, isLookupOnlyAsk, isSchedulingAsk, runSitePhrase } from './toolLoop'
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

describe('a search never stages a run, however it is phrased', () => {
  /* Founder's rule, verbatim (09-19): "for searching hotels, flights, prices,
   * no need to launch a browser session, only when they want to book… that's
   * when you launch the browser session." Live failure it closes: this exact
   * text — a bare noun phrase with no verb in it — matched none of the
   * question/find guards, so the classifier's needsBrowser rode through and
   * the reply announced a live Kayak run instead of the fares it had priced. */
  it('reads a bare travel noun phrase as the search it is', () => {
    expect(isLookupOnlyAsk('flights from JFK to London on October 15')).toBe(true)
    expect(isLookupOnlyAsk('hotels in London October 15 to 17')).toBe(true)
    expect(isLookupOnlyAsk('JFK to LHR fares next month')).toBe(true)
    expect(isLookupOnlyAsk('room rates at the Palmer House this weekend')).toBe(true)
    expect(isLookupOnlyAsk('nonstop options to Chicago')).toBe(true)
  })

  it('still hands a booking to the browser', () => {
    expect(isLookupOnlyAsk('book the cheapest JFK to London flight on October 15')).toBe(false)
    expect(isLookupOnlyAsk('reserve a hotel in London for those dates')).toBe(false)
    expect(isLookupOnlyAsk('cancel my flight to Chicago')).toBe(false)
    expect(isLookupOnlyAsk('check in for my flight tomorrow')).toBe(false)
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

describe('a picture is not a browser job', () => {
  /* Live: one "Make the dog blue" produced four answers — a real image, an
   * eager run on an invented site ("The run's live on Bing Image Creator
   * now"), and two refusals. The run is what this blocks. */
  it('rejects a staged run that claims to be making a picture', () => {
    expect(draftLooksLikeImageWork({ goal: 'Generate a blue dog image for the birthday card', portal: 'https://www.bing.com/images/create' })).toBe(true)
    expect(draftLooksLikeImageWork({ goal: 'edit the image: make the dog blue' })).toBe(true)
    expect(draftLooksLikeImageWork({ goal: 'sign in to Canva and design a poster' })).toBe(true)
  })

  it('leaves real browsing alone', () => {
    expect(draftLooksLikeImageWork({ goal: 'Book the Palmer House for Sep 25 to Sep 26', portal: 'https://www.kayak.com' })).toBe(false)
    expect(draftLooksLikeImageWork({ goal: 'Reorder two bags of the same coffee beans', portal: 'https://www.amazon.com' })).toBe(false)
    expect(draftLooksLikeImageWork({ goal: '' })).toBe(false)
  })
})

describe('a staged run names its site or says nothing about one', () => {
  /* Live: the group rehearsal closed with "The browser run is starting now on
   * the named site" when no site had been named — the fabricated-progress shape
   * the founder caught with an invented "Bing Image Creator" run. */
  it('uses the real host when there is one', () => {
    expect(runSitePhrase('https://www.kayak.com/hotels')).toBe(' on kayak.com')
    expect(runSitePhrase('opentable.com')).toBe(' on opentable.com')
    expect(runSitePhrase('https://aa.com')).toBe(' on aa.com')
  })

  it('claims no site when none was named', () => {
    expect(runSitePhrase('')).toBe('')
    expect(runSitePhrase(undefined)).toBe('')
    expect(runSitePhrase(null)).toBe('')
    expect(runSitePhrase('not a url')).toBe('')
  })
})
