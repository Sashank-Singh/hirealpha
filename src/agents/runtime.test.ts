import { describe, expect, it } from 'bun:test'
import { runAgentLocally } from './runtime'
import { getAgent } from './index'

const friend = getAgent('friend')
const coworker = getAgent('coworker')
const cofounder = getAgent('cofounder')

/* The local reply is what a person sees when the model call does not land, and
 * for a new account the FIRST message is the one most likely to hit it (coldest
 * provider call there is). Live, 2026-09-21: "Hey, Alpha!" timed out, and the
 * fallback answered a hello with "I hit a quick snag thinking through that. Can
 * you say that once more?" — the founder's reply was "what the heck". */
describe('the local fallback answers a hello like a hello', () => {
  it('never answers a greeting with the snag line', () => {
    for (const text of ['Hey, Alpha!', 'hey', 'Hi', 'Hello!', 'yo', 'morning', 'good morning']) {
      const reply = runAgentLocally(friend, text)
      expect(reply).not.toContain('quick snag')
      expect(reply).not.toContain('once more')
      expect(reply.length).toBeGreaterThan(12)
    }
  })

  it('greets by name when the account knows it', () => {
    expect(runAgentLocally(friend, 'Hey, Alpha!', { firstName: 'Sashank Singh' })).toBe(
      "Hey Sashank. I'm Alpha, your friend in texts. What's on your mind?",
    )
    expect(runAgentLocally(friend, 'Hey, Alpha!')).toBe("Hey. I'm Alpha, your friend in texts. What's on your mind?")
  })

  it('keeps the role-specific opening', () => {
    expect(runAgentLocally(coworker, 'hey')).toContain('moving')
    expect(runAgentLocally(cofounder, 'hey')).toContain('deciding')
  })

  it('still refuses to invent an answer for a real request', () => {
    // The snag line stays for the case it was written for: an ask the local path
    // cannot answer.
    expect(runAgentLocally(friend, 'what did the SEC filing say about the merger')).toContain('quick snag')
  })
})
