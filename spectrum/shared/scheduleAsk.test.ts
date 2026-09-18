import { describe, expect, it } from 'bun:test'

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
