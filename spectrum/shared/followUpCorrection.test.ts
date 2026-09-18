import { describe, expect, it } from 'bun:test'
import { previousUserAsk, readCorrection, readRefinement, rewriteWithCorrection, rewriteWithRefinement } from './followUpCorrection'

describe('readCorrection', () => {
  it('reads the shapes people actually send', () => {
    expect(readCorrection('Nyc I meant')).toEqual({ value: 'Nyc' })
    expect(readCorrection('nyc, i meant')).toEqual({ value: 'nyc' })
    expect(readCorrection('I meant NYC')).toEqual({ value: 'NYC' })
    expect(readCorrection('meant nyc')).toEqual({ value: 'nyc' })
    expect(readCorrection('i meant to say NYC')).toEqual({ value: 'NYC' })
    expect(readCorrection('not sf, i meant nyc')).toEqual({ wrong: 'sf', value: 'nyc' })
    expect(readCorrection('typo: nyc')).toEqual({ value: 'nyc' })
  })

  it('leaves anything that is its own request alone', () => {
    expect(readCorrection('I meant to call mom, remind me')).toBeNull()
    expect(readCorrection('call mom at 6')).toBeNull()
    expect(readCorrection('find me a hotel in nyc')).toBeNull()
    expect(readCorrection('what do you think I meant by that')).toBeNull()
    expect(readCorrection('')).toBeNull()
    expect(readCorrection('meant to send that email but forgot, draft it')).toBeNull()
  })
})

describe('rewriteWithCorrection', () => {
  /* Live 2026-09-17: "Find hotel in nye near the airport under 150" (a typo for
   * NYC) was searched as New Year's Eve near SFO, and the two follow-ups that
   * fixed it were answered as fresh messages — so the wrong frame survived. */
  it('repairs the mistyped word in the ask it refers to', () => {
    expect(rewriteWithCorrection('Find hotel in nye near the airport under 150', 'Nyc I meant')).toBe(
      'Find hotel in nyc near the airport under 150',
    )
    expect(rewriteWithCorrection('hotel near jf airport', 'i meant jfk')).toBe('hotel near jfk airport')
  })

  it('replaces the word the user explicitly rejected', () => {
    expect(rewriteWithCorrection('find a hotel in sf near the airport', 'not sf, i meant nyc')).toBe(
      'find a hotel in nyc near the airport',
    )
  })

  it('keeps the ask and names the correction when nothing resembles it', () => {
    const out = rewriteWithCorrection('find a hotel under 150', 'i meant in Manhattan')
    expect(out).toContain('find a hotel under 150')
    expect(out).toContain('Correction from the user')
    expect(out).toContain('i meant in Manhattan')
  })

  it('does nothing without a previous ask or a real correction', () => {
    expect(rewriteWithCorrection('', 'Nyc I meant')).toBeNull()
    expect(rewriteWithCorrection(null, 'Nyc I meant')).toBeNull()
    expect(rewriteWithCorrection('find a hotel in sf', 'find me a hotel in nyc')).toBeNull()
  })

  it('does not touch a word that is merely short', () => {
    // "in" must not be rewritten by a three-letter correction with no relation.
    expect(rewriteWithCorrection('hotel in sf', 'i meant pool')).toContain('Correction from the user')
  })
})

describe('previousUserAsk', () => {
  it('skips the current message and earlier corrections', () => {
    const history = [
      { role: 'user', content: 'Find hotel in nye near the airport under 150' },
      { role: 'assistant', content: 'Ran the NYE search near SFO...' },
      { role: 'user', content: 'Nyc I meant' },
    ]
    expect(previousUserAsk(history, 'Nyc I meant')).toBe('Find hotel in nye near the airport under 150')
  })

  it('returns null when there is no earlier ask', () => {
    expect(previousUserAsk([{ role: 'user', content: 'Nyc I meant' }], 'Nyc I meant')).toBeNull()
    expect(previousUserAsk([], 'hi')).toBeNull()
    expect(previousUserAsk(undefined, 'hi')).toBeNull()
  })
})

describe('readRefinement', () => {
  it('reads a change to the previous request', () => {
    expect(readRefinement('Bot new years eye but for next week Monday to Thursday')).not.toBeNull()
    expect(readRefinement('actually make it under 200')).not.toBeNull()
    expect(readRefinement('what about next week')).not.toBeNull()
    expect(readRefinement('same but for 4 people')).not.toBeNull()
    expect(readRefinement('no, cheaper')).not.toBeNull()
    expect(readRefinement('cheaper')).not.toBeNull()
  })

  it('leaves new requests alone', () => {
    expect(readRefinement('find hotels in Boston')).toBeNull()
    expect(readRefinement('book me a flight to Austin tomorrow')).toBeNull()
    expect(readRefinement('can you build a ping pong game')).toBeNull()
    expect(readRefinement('remind me to call mom next week at 6pm for two minutes about the thing')).toBeNull()
    expect(readRefinement('')).toBeNull()
  })

  it('needs something to change, not just a marker', () => {
    expect(readRefinement('but instead')).toBeNull()
  })
})

describe('rewriteWithRefinement', () => {
  /* Live: the ask moved from NYE to next week, and the follow-up was answered
   * as a fresh search — the city and the airport from the original request
   * vanished with it. */
  it('keeps the original request and names the change', () => {
    const out = rewriteWithRefinement(
      'Find hotel in nyc near the airport under 150',
      'Bot new years eye but for next week Monday to Thursday',
    )
    expect(out).toContain('Find hotel in nyc near the airport under 150')
    expect(out).toContain('Bot new years eye but for next week Monday to Thursday')
    expect(out).toContain('still stands')
  })

  it('does nothing without a previous ask or a real refinement', () => {
    expect(rewriteWithRefinement('', 'cheaper')).toBeNull()
    expect(rewriteWithRefinement(null, 'cheaper')).toBeNull()
    expect(rewriteWithRefinement('find a hotel in nyc', 'find hotels in Boston')).toBeNull()
  })
})
