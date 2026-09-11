/**
 * Intent classification cases.
 *
 * The regex detectors this replaced were tested by asserting the regex, which
 * is why their bugs shipped: "good morning" matched the mood pattern and
 * logged an invented energy score, and "book me a table" missed the booking
 * pattern. These cases assert what a user would expect instead.
 *
 * The live cases need GMI_API_KEY and are skipped without it. Run them when
 * touching the classifier prompt:
 *
 *   bun test spectrum/shared/turnIntent.test.ts
 */
import { describe, expect, it } from 'bun:test'
import { classifyTurnStrict, ClassifierUnavailableError, logsOf, normalizeTurnIntent } from './turnIntent'

describe('intent normalization', () => {
  it('drops a log entry that carries no payload for its domain', () => {
    // A bare domain is a guess, not data. Nothing is written from it.
    expect(normalizeTurnIntent({ kind: 'log', logs: [{ domain: 'mood' }] })).toEqual({ kind: 'chat' })
    expect(normalizeTurnIntent({ kind: 'log', logs: [{ domain: 'unknown' }] })).toEqual({ kind: 'chat' })
    expect(normalizeTurnIntent({ kind: 'log', logs: [] })).toEqual({ kind: 'chat' })
  })

  it('rejects out-of-range values instead of forwarding them', () => {
    const intent = normalizeTurnIntent({
      kind: 'log',
      logs: [
        { domain: 'mood', mood: { emoji: '🙂', energy: 99 } },
        { domain: 'sleep', sleep: { bedtime: '25:99', hours: 400 } },
        { domain: 'spend', spend: { amount: -5, description: 'nope' } },
      ],
    })
    expect(intent).toEqual({ kind: 'chat' })
  })

  it('keeps only the fields the model actually supplied', () => {
    const intent = normalizeTurnIntent({
      kind: 'log',
      logs: [{ domain: 'sleep', sleep: { hours: 7 } }],
    })
    expect(logsOf(intent, 'sleep')[0]?.sleep).toEqual({ hours: 7 })
  })

  it('never invents a mood the model did not supply', () => {
    const intent = normalizeTurnIntent({ kind: 'log', logs: [{ domain: 'mood', mood: { emoji: '🙂' } }] })
    expect(intent).toEqual({ kind: 'chat' })
  })

  it('treats malformed input as ordinary conversation', () => {
    expect(normalizeTurnIntent(null)).toEqual({ kind: 'chat' })
    expect(normalizeTurnIntent({ kind: 'nonsense' })).toEqual({ kind: 'chat' })
    expect(normalizeTurnIntent({ kind: 'request' })).toEqual({ kind: 'chat' })
  })

  it('requires an explicit decision for approvals', () => {
    expect(normalizeTurnIntent({ kind: 'approval', decision: 'affirm' })).toEqual({ kind: 'approval', decision: 'affirm' })
    expect(normalizeTurnIntent({ kind: 'approval', decision: 'maybe' })).toEqual({ kind: 'chat' })
  })
})

const live = Boolean(process.env.GMI_API_KEY)

/** Classify for a test, retrying only when the PROVIDER was unavailable.
 *
 * The distinction is the point: a 429 tells us nothing about the classifier, so
 * the run retries it, while a wrong answer or an unparseable reply fails on the
 * spot. Without this a rate limit and a genuine misreading of the message look
 * identical in the results, which is exactly how three real-looking failures
 * were misattributed to the prompt. */
async function classifyForTest(text: string, attempts = 4) {
  let lastError: unknown
  for (let i = 1; i <= attempts; i++) {
    try {
      return await classifyTurnStrict({ userText: text })
    } catch (error) {
      lastError = error
      if (!(error instanceof ClassifierUnavailableError)) throw error
      if (i < attempts) await new Promise((r) => setTimeout(r, 1_500 * i))
    }
  }
  throw lastError
}

/** Messages that must be treated as conversation — nothing written. These are
 * the exact phrasings that regex got wrong.
 *
 * "Brief me on the second email" is deliberately NOT here. Reading a specific
 * message needs the inbox, so the classifier calls it a request, and that is
 * right: a request writes nothing, which is the property this list is about.
 * Asserting 'chat' for it would have been asserting my own first guess rather
 * than what the turn should do. */
const MUST_BE_CHAT = [
  'good morning',
  'good night',
  'ok thanks',
  'how are you doing?',
  "I didn't spend $80",
  'I wish I could sleep for ten hours',
  "I'm tired of this app",
  'I skipped lunch',
  'I should work out today',
  'my sister slept badly',
  'explain compound interest',
  'hey',
]

/** Completed facts that must be recorded. */
const MUST_LOG: Array<[string, string]> = [
  ['I slept 7 hours', 'sleep'],
  ['slept 11pm to 6:30am', 'sleep'],
  ['half a chipotle bowl with double chicken', 'nutrition'],
  ['did 3x8 bench at 135', 'workout'],
  ['grateful for my sister calling me', 'gratitude'],
  ['spent $42.50 on gas', 'spend'],
  ['im exhausted', 'mood'],
  ['feeling great today', 'mood'],
]

describe.skipIf(!live)('intent classification (live model)', () => {
  it('treats greetings, negations, and hypotheticals as conversation', async () => {
    for (const text of MUST_BE_CHAT) {
      const intent = await classifyForTest(text)
      expect({ text, kind: intent.kind }).toEqual({ text, kind: 'chat' })
    }
  }, 240_000)

  it('records completed facts', async () => {
    for (const [text, domain] of MUST_LOG) {
      const intent = await classifyForTest(text)
      expect({ text, kind: intent.kind }).toEqual({ text, kind: 'log' })
      expect({ text, domains: intent.kind === 'log' ? intent.logs.map((log) => log.domain) : [] })
        .toEqual({ text, domains: expect.arrayContaining([domain]) })
    }
  }, 240_000)

  it('reads a booking as a browser request, not a recommendation', async () => {
    const intent = await classifyForTest('book me a table for 2 on opentable this friday at 8')
    expect(intent.kind).toBe('request')
    if (intent.kind !== 'request') return
    expect(intent.request.needsBrowser).toBe(true)
    expect(intent.request.site).toContain('opentable.com')
  }, 60_000)

  it('reads a current-facts question as a lookup request', async () => {
    const intent = await classifyForTest('what is the latest news on apple')
    expect(intent.kind).toBe('request')
    if (intent.kind !== 'request') return
    expect(intent.request.needsLookup).toBe(true)
  }, 60_000)

  it('does not treat an answerable question as a request', async () => {
    expect((await classifyForTest('how are you doing today?')).kind).toBe('chat')
  }, 60_000)
})
